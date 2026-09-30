package com.gaskony.scriptide.gateway.term;

import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.BiConsumer;

/**
 * Owns every live terminal on this gateway.
 *
 * <p>Terminals are keyed by an id the server generates, and every id is scoped to
 * the socket that opened it: {@link #get} takes the owning connection's id and
 * refuses to return a terminal belonging to a different one. Without that, a
 * terminal id leaked or guessed by another authenticated Administrator would be a
 * live shell they could type into, and the audit trail would name the wrong
 * person.</p>
 */
public class TerminalService {

    private static final Logger logger = LoggerFactory.getLogger(TerminalService.class);

    /** How long shutdown waits for the Docker sweeps it just started. */
    private static final long SHUTDOWN_REAP_BUDGET_MILLIS = 10_000;

    /** One entry per live shell. */
    private record Entry(TerminalSession session, String owner, String username) { }

    private final Map<String, Entry> terminals = new ConcurrentHashMap<>();
    private final GatewayContext context;
    private final ScheduledExecutorService sweeper;

    public TerminalService(GatewayContext context) {
        this.context = context;
        this.sweeper = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "script-ide-term-sweeper");
            thread.setDaemon(true);
            return thread;
        });
        this.sweeper.scheduleWithFixedDelay(this::closeIdle, 5, 5, TimeUnit.MINUTES);
    }

    /** Terminals currently open, for diagnostics. */
    public int openCount() {
        return terminals.size();
    }

    /** How many this connection already holds. */
    public int countFor(String owner) {
        return (int) terminals.values().stream().filter(e -> e.owner().equals(owner)).count();
    }

    /**
     * Start a shell for one connection.
     *
     * @throws RejectedException when policy, capacity or the host refuses
     */
    public TerminalSession open(String owner, String username, String remoteHost,
                                int cols, int rows,
                                BiConsumer<String, byte[]> onData,
                                BiConsumer<String, Integer> onExit)
            throws RejectedException {
        if (!TerminalPolicy.terminalEnabled()) {
            throw new RejectedException("The Gateway terminal is disabled on this gateway ("
                + TerminalPolicy.PROP_ENABLED + "=false).");
        }
        if (countFor(owner) >= TerminalPolicy.maxPerSession()) {
            throw new RejectedException("This tab already has "
                + TerminalPolicy.maxPerSession() + " terminals open. Close one first.");
        }
        String shell = TerminalPolicy.shell();
        if (shell == null) {
            throw new RejectedException("No usable shell was found on this gateway. The "
                + "terminal needs a Unix-like host; set " + TerminalPolicy.PROP_SHELL
                + " if yours keeps its shell somewhere unusual.");
        }

        String id = UUID.randomUUID().toString();
        // The audit line is written BEFORE the shell starts, so a terminal that
        // wedges is still recorded. Individual commands are NOT audited and cannot
        // be: a pty carries keystrokes, not commands, and reconstructing them from
        // the byte stream would be a transcript of everything the user typed
        // including anything they pasted. SECURITY.md says so plainly.
        // Whether it elevated is part of the record, not a detail: "opened a
        // shell" and "opened a root shell" are different events to whoever reads
        // this log afterwards, and the answer is decided by the host rather than
        // by anything the user sent, so it cannot be inferred from the request.
        // The ROUTE, not just a boolean: "root via the Docker daemon" and "root
        // via a sudoers rule" are different facts about the host, and someone
        // reading this log after an incident needs to know which door was open.
        String elevation = TerminalPolicy.dockerContainerForElevation() != null ? "docker-exec"
            : TerminalPolicy.sudoForElevation() != null ? "sudo" : "none";
        logger.info("Gateway terminal opened by '{}' from {} (shell={}, elevation={}, id={})",
            username, remoteHost, shell, elevation, id);

        try {
            // The id is minted here, so the callback is bound to it here too —
            // the caller has no id to key on until open() returns, and the first
            // bytes can arrive before it does.
            TerminalSession session = TerminalSession.start(
                id, username, shell, defaultDirectory(), cols, rows,
                bytes -> onData.accept(id, bytes),
                (terminalId, code) -> {
                    terminals.remove(terminalId);
                    onExit.accept(terminalId, code);
                });
            terminals.put(id, new Entry(session, owner, username));
            // The line above records what was EXPECTED. If the Docker route then
            // failed and TerminalSession fell back to a local shell, the audit
            // would otherwise say root when the user got no such thing — a log
            // that quietly overstates privilege is worse than no log.
            if (!elevation.equals(session.elevation())) {
                logger.warn("Gateway terminal {} did NOT elevate as expected: the audit line "
                    + "above says elevation={}, the shell actually got elevation={}",
                    id, elevation, session.elevation());
            }
            return session;
        } catch (IOException e) {
            throw new RejectedException("Could not start a shell: " + e.getMessage());
        }
    }

    /**
     * A terminal, but only for the connection that opened it.
     *
     * <p>Returns null rather than throwing for a mismatch: the caller's job is to
     * treat "not yours" and "gone" the same way, and distinguishing them out loud
     * would confirm to a prober that an id exists.</p>
     */
    public TerminalSession get(String owner, String id) {
        Entry entry = terminals.get(id);
        if (entry == null || !entry.owner().equals(owner)) {
            return null;
        }
        return entry.session();
    }

    /** Close one terminal. */
    public void close(String owner, String id) {
        TerminalSession session = get(owner, id);
        if (session != null) {
            terminals.remove(id);
            session.close();
        }
    }

    /** Close everything one connection owns — called when its socket closes. */
    public void closeAllFor(String owner) {
        terminals.entrySet().removeIf(entry -> {
            if (!entry.getValue().owner().equals(owner)) {
                return false;
            }
            entry.getValue().session().close();
            return true;
        });
    }

    /**
     * Where a new terminal starts.
     *
     * <p>The Gateway data directory, because that is where the projects are and
     * the reason to want a shell here is almost always to look at them. Falls back
     * to the process working directory if the platform will not say.</p>
     */
    private Path defaultDirectory() {
        try {
            Path data = context.getSystemManager().getDataDir().toPath();
            return data.toAbsolutePath();
        } catch (RuntimeException e) {
            logger.debug("Could not resolve the data directory: {}", e.toString());
            return null;
        }
    }

    private void closeIdle() {
        long cutoff = System.currentTimeMillis()
            - TimeUnit.MINUTES.toMillis(TerminalPolicy.idleMinutes());
        terminals.entrySet().removeIf(entry -> {
            TerminalSession session = entry.getValue().session();
            if (session.isAlive() && session.lastActivity() >= cutoff) {
                return false;
            }
            if (session.isAlive()) {
                // This promise was empty until 1.5.0: close() on a Docker-backed
                // terminal closed a stream and left the shell running, so the
                // sweeper "closed" idle terminals that went on existing.
                logger.info("Closing idle Gateway terminal {} for '{}'",
                    entry.getKey(), entry.getValue().username());
            }
            session.close();
            return true;
        });
    }

    /**
     * Close every terminal and stop the sweeper.
     *
     * <p>The wait at the end is the point of this method rather than a nicety.
     * A Docker-backed terminal is ended by a sweep that runs on a background
     * DAEMON thread, and a daemon thread is simply dropped when the JVM goes —
     * so without waiting, uninstalling the module would leave behind exactly the
     * root shells it was closing. Bounded, because a shutdown that hangs on a
     * wedged Docker daemon is its own incident.</p>
     */
    public void shutdown() {
        sweeper.shutdownNow();
        int count = terminals.size();
        terminals.values().forEach(entry -> entry.session().close());
        terminals.clear();
        if (count > 0) {
            logger.info("Closed {} Gateway terminal(s) during shutdown", count);
            if (!DockerExec.awaitReapers(SHUTDOWN_REAP_BUDGET_MILLIS)) {
                logger.warn("Gave up waiting for the Docker terminal sweep after {} ms; a root "
                    + "shell may still be running in the container",
                    SHUTDOWN_REAP_BUDGET_MILLIS);
            }
        }
    }

    /** Thrown when a terminal cannot be opened. Carries a message for the user. */
    public static class RejectedException extends Exception {
        private static final long serialVersionUID = 1L;

        public RejectedException(String message) {
            super(message);
        }
    }
}
