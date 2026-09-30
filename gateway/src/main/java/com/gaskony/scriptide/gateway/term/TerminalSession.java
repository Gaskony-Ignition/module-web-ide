package com.gaskony.scriptide.gateway.term;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

/**
 * One shell, attached to a real pseudo-terminal, streaming to one browser tab.
 *
 * <h2>How a Java 17 module gets a PTY with no native code</h2>
 *
 * <p>Java has no pty API and JNI is not an option here: a native library would
 * have to be signed, shipped per architecture, and would turn a module that runs
 * anywhere into one that refuses to load somewhere. So the pty comes from
 * <b>{@code script(1)}</b>, util-linux's session recorder, which allocates one
 * for its child and copies our pipes through it:</p>
 *
 * <pre>script -q -c "tty &gt; F; stty cols C rows R; exec /bin/bash -i" /dev/null</pre>
 *
 * <p>Measured in the target gateway container 01/09/2026: the child reports
 * {@code /dev/pts/0} from {@code tty}, echoes input, prints a prompt, and
 * {@code stty size} returns what we set. Without a pty the shell has no
 * controlling terminal - no prompt, no echo, no line editing, and anything that
 * checks {@code isatty} behaves differently from how it does over ssh.</p>
 *
 * <p>Two details are load-bearing. The transcript goes to {@code /dev/null}
 * because we want the pty, not the recording. And the command given to
 * {@code -c} is <b>not echoed</b> by the pty - only what the child writes is -
 * which is why the {@code tty} and {@code stty} calls can be smuggled in front
 * of the shell without appearing on the user's screen.</p>
 *
 * <p>{@code tty > F} exists so resizing does not have to inject a command into
 * the user's shell: with the slave path on hand, a later
 * {@code stty -F /dev/pts/N cols ... rows ...} sets the window size from outside
 * and the kernel raises {@code SIGWINCH} in the foreground process group,
 * exactly as a terminal emulator does.</p>
 *
 * <h2>Bytes, not text</h2>
 *
 * <p>Output is forwarded base64-encoded rather than as a String. A pty carries
 * ANSI control sequences and arbitrary program output, and a UTF-8 sequence can
 * straddle two reads; decoding here would corrupt both. xterm.js takes the raw
 * bytes and does the decoding it was written to do.</p>
 */
public class TerminalSession {

    private static final Logger logger = LoggerFactory.getLogger(TerminalSession.class);

    /** Bytes handed to the client per frame. */
    private static final int READ_BUFFER = 8192;

    /**
     * Ceiling on output forwarded per second.
     *
     * <p>A pty makes it one keystroke to run something that prints forever, and
     * the browser tab is what falls over. Excess is dropped with a visible marker
     * rather than buffered, because a terminal that silently lags is worse than
     * one that says it skipped output.</p>
     */
    private static final long MAX_BYTES_PER_SECOND = 2L * 1024 * 1024;

    /** ASCII escape, built rather than written, so this file stays plain text. */
    private static final String ESC = String.valueOf((char) 27);
    private static final String THROTTLE_NOTE =
        "\r\n" + ESC + "[33m[output throttled]" + ESC + "[0m\r\n";

    /**
     * How long {@code script(1)} gets to go on SIGTERM before it is killed.
     *
     * <p>Short, because measured it never goes at all — it handles the signal —
     * so this is the price of being polite to a well-behaved future version
     * rather than a wait anybody depends on.</p>
     */
    private static final long TERM_GRACE_MILLIS = 300;

    public static final int MIN_COLS = 20;
    public static final int MAX_COLS = 500;
    public static final int MIN_ROWS = 5;
    public static final int MAX_ROWS = 200;

    private final String id;
    private final String username;
    /** Null on a Docker-backed terminal: the shell is the daemon's child, not ours. */
    private final Process process;
    /** Null on a process-backed terminal. Exactly one of these two is set. */
    private final DockerExec.Session docker;
    /** Null on a Docker-backed terminal, which writes through its own session. */
    private final OutputStream toShell;
    private final Path ttyFile;
    private final boolean pty;
    /** How this shell actually got its privilege — see {@link #elevation()}. */
    private final String elevation;
    private volatile String slavePath;
    private volatile long lastActivity = System.currentTimeMillis();
    private volatile boolean closed;

    private TerminalSession(String id, String username, Process process,
                            DockerExec.Session docker, Path ttyFile, boolean pty,
                            String elevation) {
        this.id = id;
        this.username = username;
        this.process = process;
        this.docker = docker;
        this.toShell = process != null ? process.getOutputStream() : null;
        this.ttyFile = ttyFile;
        this.pty = pty;
        this.elevation = elevation;
    }

    /** How this shell is being run — for the audit line and the UI. */
    public String route() {
        return docker != null ? "docker-exec" : "process";
    }

    /**
     * What actually elevated this shell: {@code docker-exec}, {@code sudo} or
     * {@code none}.
     *
     * <p>The SAME three words {@code TerminalService} writes as
     * {@code elevation=} on the open line, and that is the point of having this
     * at all. The audit line is written before the shell starts, so it records
     * what was <b>expected</b>; if the Docker route then fails and we fall back,
     * only the session knows what really happened. Reading the audit and
     * believing it without this would be reading a prediction as a fact.</p>
     */
    public String elevation() {
        return elevation;
    }

    public String id() {
        return id;
    }

    /** Whether the shell got a real terminal, or is running on bare pipes. */
    public boolean hasPty() {
        return pty;
    }

    public long lastActivity() {
        return lastActivity;
    }

    public boolean isAlive() {
        if (closed) {
            return false;
        }
        return docker != null ? docker.isAlive() : process.isAlive();
    }

    /**
     * Where {@code script(1)} and {@code stty(1)} live, best first.
     *
     * <p>Probed as a list rather than named inline for two reasons. The Gateway
     * JVM's {@code PATH} is whatever the service manager gave it and is often
     * close to empty, so a bare {@code "script"} argv is not reliable; and a
     * resolved absolute path is one fewer thing an environment can change under
     * a running gateway.</p>
     */
    private static final List<String> SCRIPT_CANDIDATES = List.of("/usr/bin/script", "/bin/script");
    private static final List<String> STTY_CANDIDATES = List.of("/usr/bin/stty", "/bin/stty");

    /** The first candidate that exists and is executable, or null. */
    private static String resolve(List<String> candidates) {
        for (String candidate : candidates) {
            if (Files.isExecutable(Path.of(candidate))) {
                return candidate;
            }
        }
        return null;
    }

    /** True when a pty is obtainable on this host at all. */
    public static boolean ptyAvailable() {
        return resolve(SCRIPT_CANDIDATES) != null;
    }

    /**
     * Start a shell.
     *
     * @param onData raw output bytes, already rate-bounded
     * @param onExit called once with (id, exitCode) when the shell ends
     */
    static TerminalSession start(String id, String username, String shell, Path workingDir,
                                 int cols, int rows,
                                 Consumer<byte[]> onData, BiConsumer<String, Integer> onExit)
            throws IOException {
        int safeCols = clamp(cols, MIN_COLS, MAX_COLS);
        int safeRows = clamp(rows, MIN_ROWS, MAX_ROWS);

        // ---- route 1: ask the Docker daemon ------------------------------
        //
        // Preferred where it is available, and the reason is not only that it
        // is the one-click route every Docker UI uses. It needs NOTHING in the
        // image — no sudo, no setuid binary, not even `script(1)` — it gets a
        // real pty from the daemon rather than borrowing one from script(1),
        // resize is an API call instead of an `stty` typed at the shell, and
        // the shell is the daemon's child, so closing it works whether it is
        // root or not. The sudo route cannot signal a root child at all.
        String container = TerminalPolicy.dockerContainerForElevation();
        if (container != null) {
            try {
                // The terminal id doubles as the session tag: it is a UUID this
                // module minted, it is already unique per shell, and it means a
                // process found in the sweep can be traced back to the audit
                // line that opened it.
                DockerExec.Session session = DockerExec.start(
                    container, shell,
                    workingDir != null ? workingDir.toString() : null,
                    safeCols, safeRows, id);
                TerminalSession terminal =
                    new TerminalSession(id, username, null, session, null, true, "docker-exec");
                terminal.pump(session.output(), onData, onExit);
                return terminal;
            } catch (IOException e) {
                // Fall through rather than fail. The socket answered `available`
                // a moment ago, so this is a race or a daemon hiccup, and a
                // working unprivileged shell beats an error dialog.
                logger.warn("Docker exec failed for terminal {}; falling back to a local "
                    + "shell: {}", id, e.toString());
            }
        }

        // ---- route 2 and 3: a local process ------------------------------
        String scriptBinary = resolve(SCRIPT_CANDIDATES);
        boolean pty = scriptBinary != null;

        // null unless this host already grants the Gateway's own user
        // passwordless sudo — TerminalPolicy proves that by running it, and
        // returns null the instant it does not work. See sudoForElevation.
        String sudo = TerminalPolicy.sudoForElevation();

        Path ttyFile = null;
        List<String> argv = new ArrayList<>();
        if (pty) {
            ttyFile = Files.createTempFile("scriptide-tty-", ".path");
            // Every interpolated value is validated: the shell path by
            // TerminalPolicy.isSafeShellPath, the sudo path by the same absolute
            // candidate list the shell uses, the size by clamp above, and the
            // temp path is one we created. Nothing client-supplied reaches here.
            //
            // ELEVATION GOES INSIDE the pty, not around it: `script` itself stays
            // the Gateway user, so it is the Gateway user that owns the pty and
            // the process the JVM has to be able to signal. Running `sudo script`
            // instead would give us a root process this JVM cannot kill, and the
            // idle sweeper would then be a promise the module cannot keep.
            String exec = sudo == null
                ? shell + " -i"
                // -H so HOME is root's and not the gateway user's: a root shell
                // writing into the service account's dotfiles leaves root-owned
                // files behind that the gateway then cannot rewrite.
                : sudo + " -n -H " + shell + " -i";
            String launch = "tty > '" + ttyFile + "'; "
                + "stty cols " + safeCols + " rows " + safeRows + " 2>/dev/null; "
                // Debian's own opt-out for the login chatter — see DockerExec.HUSH
                // for the whole story. Ahead of the exec, and harmless on an
                // image whose bashrc does not read it.
                + ": > \"$HOME/.hushlogin\" 2>/dev/null; "
                + "exec " + exec;
            argv.add(scriptBinary);
            argv.add("-q");
            argv.add("-c");
            argv.add(launch);
            argv.add("/dev/null");
        } else if (sudo != null) {
            argv.add(sudo);
            argv.add("-n");
            argv.add("-H");
            argv.add(shell);
            argv.add("-i");
        } else {
            argv.add(shell);
            argv.add("-i");
        }

        ProcessBuilder builder = new ProcessBuilder(argv);
        builder.redirectErrorStream(true);
        if (workingDir != null && Files.isDirectory(workingDir)) {
            builder.directory(workingDir.toFile());
        }
        Map<String, String> env = builder.environment();
        env.put("TERM", "xterm-256color");
        env.put("COLUMNS", String.valueOf(safeCols));
        env.put("LINES", String.valueOf(safeRows));
        // Nothing in a browser terminal can drive `less`, and a pager waiting for
        // a key it will never receive looks exactly like a hung command.
        env.put("PAGER", "cat");
        env.put("GIT_PAGER", "cat");

        Process process = builder.start();
        TerminalSession session = new TerminalSession(
            id, username, process, null, ttyFile, pty, sudo != null ? "sudo" : "none");
        session.pump(process.getInputStream(), onData, onExit);
        return session;
    }

    /** Forward the shell's output until it ends. */
    private void pump(InputStream in, Consumer<byte[]> onData, BiConsumer<String, Integer> onExit) {
        Thread reader = new Thread(() -> {
            byte[] buffer = new byte[READ_BUFFER];
            long windowStart = System.currentTimeMillis();
            long windowBytes = 0;
            boolean throttling = false;
            try {
                int read;
                while ((read = in.read(buffer)) != -1) {
                    lastActivity = System.currentTimeMillis();
                    long now = lastActivity;
                    if (now - windowStart >= 1000) {
                        windowStart = now;
                        windowBytes = 0;
                        if (throttling) {
                            throttling = false;
                            onData.accept(THROTTLE_NOTE.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    windowBytes += read;
                    if (windowBytes > MAX_BYTES_PER_SECOND) {
                        throttling = true;
                        continue;
                    }
                    byte[] chunk = new byte[read];
                    System.arraycopy(buffer, 0, chunk, 0, read);
                    onData.accept(chunk);
                }
            } catch (IOException e) {
                logger.debug("Terminal {} read ended: {}", id, e.toString());
            } finally {
                int code;
                if (docker != null) {
                    // The shell is not this JVM's child, so there is nothing to
                    // wait for — the daemon holds the exit status and hands it
                    // over on request. Null means it somehow outlived its own
                    // stream, which is not a code we can honestly report.
                    Integer status = docker.exitCode();
                    code = status != null ? status : 0;
                } else {
                    try {
                        code = process.waitFor();
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        code = -1;
                    }
                }
                cleanUp();
                onExit.accept(id, code);
            }
        }, "script-ide-term-" + id);
        reader.setDaemon(true);
        reader.start();

        // The slave path appears a moment after the child starts. Read it on a
        // background thread rather than blocking the socket callback.
        // Never on the Docker route: there is no tty file to read, because the
        // pty came from the daemon rather than from script(1), and resizing goes
        // through the API instead of an stty against a slave path.
        if (pty && ttyFile != null) {
            final Path probeFile = ttyFile;
            Thread probe = new Thread(() -> {
                for (int attempt = 0; attempt < 40 && slavePath == null && isAlive(); attempt++) {
                    try {
                        String value = Files.readString(probeFile).trim();
                        if (value.startsWith("/dev/")) {
                            slavePath = value;
                            return;
                        }
                        Thread.sleep(50);
                    } catch (IOException e) {
                        return;
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            }, "script-ide-term-tty-" + id);
            probe.setDaemon(true);
            probe.start();
        }
    }

    /** Write keystrokes to the shell. */
    public void write(byte[] data) {
        if (closed) {
            return;
        }
        lastActivity = System.currentTimeMillis();
        try {
            if (docker != null) {
                docker.write(data);
            } else {
                toShell.write(data);
                toShell.flush();
            }
        } catch (IOException e) {
            logger.debug("Terminal {} write failed: {}", id, e.toString());
            close();
        }
    }

    /**
     * Tell the kernel the window changed size.
     *
     * <p>Done from OUTSIDE the shell, against the slave device, so the user does
     * not see an {@code stty} command appear at their prompt every time they drag
     * the panel. Best effort by design - a failed resize costs a redraw, and
     * failing loudly here would be noise.</p>
     */
    public void resize(int cols, int rows) {
        if (closed) {
            return;
        }
        int safeCols = clamp(cols, MIN_COLS, MAX_COLS);
        int safeRows = clamp(rows, MIN_ROWS, MAX_ROWS);
        if (docker != null) {
            docker.resize(safeCols, safeRows);
            return;
        }
        String path = slavePath;
        if (!pty || path == null) {
            return;
        }
        String stty = resolve(STTY_CANDIDATES);
        if (stty == null) {
            return;
        }
        try {
            new ProcessBuilder(stty, "-F", path,
                "cols", String.valueOf(safeCols), "rows", String.valueOf(safeRows))
                .redirectErrorStream(true)
                .start();
        } catch (IOException e) {
            logger.debug("Terminal {} resize failed: {}", id, e.toString());
        }
    }

    /** End the shell and everything it started. */
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        if (docker != null) {
            // Sends the exit sequence, closes the stream and sweeps the
            // container for anything still carrying this terminal's tag. Until
            // 1.5.0 this was a bare stream close on the belief that it hung the
            // pty up; it does not, and it left one root shell behind per
            // terminal ever opened. DockerExec.Session.close() has the numbers.
            docker.close();
            cleanUp();
            logger.debug("Terminal {} closed for '{}' (docker-exec)", id, username);
            return;
        }

        // ---- the script(1) routes ----------------------------------------
        //
        // SIGTERM is not enough here, and 1.4.x's belief that it was is the same
        // class of mistake as the Docker one. Measured 02/09/2026 on this host:
        // `script` INSTALLS a SIGTERM handler and an interactive bash IGNORES
        // SIGTERM outright, so `destroy()` on both left all four processes —
        // script, the shell and two `sleep`s — running. SIGKILL on `script`
        // alone cleared every one of them, because killing it closes the pty
        // master, the slave raises SIGHUP, and bash hangs up its own jobs on the
        // way out.
        //
        // So: ask politely, then insist. Descendants get the polite pass too
        // (they are ordinary children and a `sleep` does go on SIGTERM), but on
        // an ELEVATED terminal they are ROOT and this JVM is not, so the OS
        // refuses those signals silently. That is exactly why `script` itself is
        // killed rather than only its children: it is our own process, and the
        // pty hang-up it causes is what actually reaches a root shell.
        process.descendants().forEach(ProcessHandle::destroy);
        process.destroy();
        boolean gone = false;
        try {
            gone = process.waitFor(TERM_GRACE_MILLIS, java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (!gone) {
            process.descendants().forEach(ProcessHandle::destroyForcibly);
            process.destroyForcibly();
        }
        cleanUp();
        logger.debug("Terminal {} closed for '{}' (elevation={}, needed SIGKILL={})",
            id, username, elevation, !gone);
    }

    private void cleanUp() {
        if (ttyFile != null) {
            try {
                Files.deleteIfExists(ttyFile);
            } catch (IOException e) {
                logger.debug("Could not remove {}: {}", ttyFile, e.toString());
            }
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
