package com.gaskony.scriptide.gateway.ws;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecutionService;
import com.gaskony.scriptide.gateway.lang.DbSchema;
import com.gaskony.scriptide.gateway.lang.SdkDbSchema;
import com.gaskony.scriptide.gateway.lang.SdkTagBrowser;
import com.gaskony.scriptide.gateway.lang.TagBrowser;
import com.gaskony.scriptide.gateway.term.TerminalService;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Static holder for the Gateway context and the set of live sockets.
 *
 * <p>It exists because the Jetty container instantiates the servlet through its
 * <b>no-arg constructor</b> — there is nowhere to inject a {@link GatewayContext}.
 * The hook publishes the context here in {@code startup()} BEFORE registering the
 * servlet, and clears it in {@code shutdown()}.</p>
 *
 * <p>Tracking open sockets is not bookkeeping for its own sake: on shutdown every
 * one must be closed, or a socket outliving the module keeps a reference to a
 * dead context. From P2 this is also what lets a redeploy cancel in-flight script
 * executions rather than orphaning them.</p>
 */
public final class ScriptIdeSocketRegistry {

    private static final Logger logger = LoggerFactory.getLogger(ScriptIdeSocketRegistry.class);

    private static volatile GatewayContext context;
    private static volatile ExecutionService executionService;
    private static volatile ExecAudit execAudit;
    private static volatile TerminalService terminalService;
    private static volatile com.gaskony.scriptide.gateway.history.RunHistory runHistory;
    private static volatile com.gaskony.scriptide.gateway.history.QueryHistory queryHistory;
    private static volatile TagBrowser tagBrowser;
    private static volatile DbSchema dbSchema;
    private static volatile com.gaskony.scriptide.gateway.presence.PresenceRegistry presence;
    private static volatile com.gaskony.scriptide.gateway.presence.DesignerPresenceListener
        designerPresence;
    private static volatile java.util.concurrent.ScheduledExecutorService presenceSweeper;
    private static volatile com.gaskony.scriptide.gateway.git.GitStatusRegistry gitStatus;
    private static volatile java.util.concurrent.ScheduledExecutorService gitSweeper;

    /**
     * Background pool for {@link SdkTagBrowser} and {@link SdkDbSchema}'s
     * cache refreshes — a dedicated,
     * bounded, own pool, same reasoning as {@link ExecutionService}'s: never
     * {@code ctx.getExecutorService()}, because a tag browse or a JDBC schema
     * read wedged against a dead provider must not cost the Gateway's own
     * pool a thread.
     */
    private static volatile ExecutorService completionRefreshPool;

    private static final Set<ScriptIdeSocket> OPEN_SOCKETS = ConcurrentHashMap.newKeySet();

    private ScriptIdeSocketRegistry() { /* static holder */ }

    /** Publish the context and services. Must run before the servlet registers. */
    public static void init(GatewayContext ctx) {
        context = ctx;
        executionService = new ExecutionService(ctx);
        execAudit = new ExecAudit(ctx);
        terminalService = new TerminalService(ctx);
        runHistory = new com.gaskony.scriptide.gateway.history.RunHistory(
            ctx.getSystemManager().getDataDir().toPath());
        queryHistory = new com.gaskony.scriptide.gateway.history.QueryHistory(
            ctx.getSystemManager().getDataDir().toPath());
        ExecutorService pool = Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "scriptide-completion-refresh");
            t.setDaemon(true);
            return t;
        });
        completionRefreshPool = pool;
        tagBrowser = new SdkTagBrowser(ctx.getTagManager(), pool);
        dbSchema = new SdkDbSchema(ctx.getDatasourceManager(), pool);
        startPresence(ctx);
        startGitStatus(ctx);
        logger.debug("Web IDE socket registry initialised");
    }

    /**
     * Start both presence feeds.
     *
     * <p>Registering on the gateway's own event bus is the ONE thing here that
     * touches a platform internal, so it is wrapped: a gateway that answered
     * differently must cost this module its presence indicator, never its
     * startup. The sweep is registered either way, because it is what keeps the
     * list from going stale and it uses only supported API.</p>
     */
    private static void startPresence(GatewayContext ctx) {
        var registry = new com.gaskony.scriptide.gateway.presence.PresenceRegistry();
        presence = registry;
        try {
            var listener =
                new com.gaskony.scriptide.gateway.presence.DesignerPresenceListener(registry);
            ctx.getEventBus().register(listener);
            designerPresence = listener;
        } catch (RuntimeException | LinkageError e) {
            logger.info(
                "Designer per-file presence is unavailable on this gateway ({}). The IDE still "
                    + "shows its own clients, and Designer sessions at project level.",
                e.toString());
        }
        var sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "scriptide-presence-sweep");
            t.setDaemon(true);
            return t;
        });
        sweeper.scheduleWithFixedDelay(
            new com.gaskony.scriptide.gateway.presence.PresenceSweep(ctx, registry),
            2,
            com.gaskony.scriptide.gateway.presence.PresenceSweep.PERIOD_SECONDS,
            TimeUnit.SECONDS);
        presenceSweeper = sweeper;
    }

    /**
     * Start the git status poll.
     *
     * <p>The set of projects to watch comes from the PRESENCE registry rather
     * than from a list of its own: an IDE peer already carries the project its
     * client is looking at, so the two features agree by construction and a
     * project nobody has open is never walked.</p>
     *
     * <p>Read-only, and deliberately so. Nigel's decision on 01/09/2026 is that
     * this module is not becoming a git module — {@code module-git} exists. What
     * is here is the VS Code-shaped half: which resources differ from the last
     * commit, and nothing that changes a repository.</p>
     */
    private static void startGitStatus(GatewayContext ctx) {
        var projects = ctx.getSystemManager().getDataDir().toPath().resolve("projects");
        var registry = new com.gaskony.scriptide.gateway.git.GitStatusRegistry(
            projects::resolve);
        gitStatus = registry;
        var sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "scriptide-git-status");
            t.setDaemon(true);
            return t;
        });
        sweeper.scheduleWithFixedDelay(
            new com.gaskony.scriptide.gateway.git.GitStatusSweep(registry,
                ScriptIdeSocketRegistry::watchedProjects),
            3,
            com.gaskony.scriptide.gateway.git.GitStatusSweep.PERIOD_SECONDS,
            TimeUnit.SECONDS);
        gitSweeper = sweeper;
    }

    /** Projects that an IDE client currently has open, from the presence feed. */
    private static Set<String> watchedProjects() {
        var registry = presence;
        if (registry == null) {
            return Set.of();
        }
        Set<String> open = new java.util.HashSet<>();
        for (var peer : registry.peers()) {
            String project = peer.project();
            if (project != null && !project.isBlank()) {
                open.add(project);
            }
        }
        return open;
    }

    /** Stop the git poll. Nothing is registered on a platform bus here. */
    private static void stopGitStatus() {
        var sweeper = gitSweeper;
        if (sweeper != null) {
            sweeper.shutdownNow();
        }
        gitSweeper = null;
        gitStatus = null;
    }

    public static com.gaskony.scriptide.gateway.git.GitStatusRegistry getGitStatus() {
        return gitStatus;
    }

    /**
     * Stop both presence feeds.
     *
     * <p>Unregistering from the gateway's bus matters more than most shutdown
     * steps: the bus outlives this module, so a listener left on it holds a
     * reference to a registry belonging to a module that has gone, and every
     * later gateway event runs code from an unloaded classloader.</p>
     */
    private static void stopPresence() {
        var sweeper = presenceSweeper;
        if (sweeper != null) {
            sweeper.shutdownNow();
        }
        presenceSweeper = null;
        var listener = designerPresence;
        GatewayContext ctx = context;
        if (listener != null && ctx != null) {
            try {
                ctx.getEventBus().unregister(listener);
            } catch (RuntimeException | LinkageError e) {
                logger.debug("Could not unregister the presence listener: {}", e.toString());
            }
        }
        designerPresence = null;
        var registry = presence;
        if (registry != null) {
            registry.clear();
        }
        presence = null;
    }

    /** Who has what open, across this IDE and the Designer. Never null once started. */
    public static com.gaskony.scriptide.gateway.presence.PresenceRegistry getPresence() {
        return presence;
    }

    /** The Designer feed, or null where it could not be registered. */
    public static com.gaskony.scriptide.gateway.presence.DesignerPresenceListener
        getDesignerPresence() {
        return designerPresence;
    }

    /** The execution pool, or null when the module is not started. */
    public static ExecutionService getExecutionService() {
        return executionService;
    }

    /** The terminal pool, or null when the module is not started. */
    public static TerminalService getTerminalService() {
        return terminalService;
    }

    /**
     * Where finished executions are kept for the user who ran them.
     *
     * <p>Distinct from {@link #getExecAudit()} and not a replacement for it: the
     * audit is the estate's record that a run HAPPENED and stores a hash rather
     * than the code, and this is the user's own scratch history and stores the
     * source and the output. Different readers, different retention.</p>
     */
    public static com.gaskony.scriptide.gateway.history.RunHistory getRunHistory() {
        return runHistory;
    }

    /** Where finished Query Browser runs are kept for the user who ran them. */
    public static com.gaskony.scriptide.gateway.history.QueryHistory getQueryHistory() {
        return queryHistory;
    }

    /** The audit recorder, or null when the module is not started. */
    public static ExecAudit getExecAudit() {
        return execAudit;
    }

    /** Live tag-path completion, or null when the module is not started. */
    public static TagBrowser getTagBrowser() {
        return tagBrowser;
    }

    /** Live database-schema completion, or null when the module is not started. */
    public static DbSchema getDbSchema() {
        return dbSchema;
    }

    /**
     * The Gateway context, or {@code null} if the module is not started.
     *
     * <p>Callers MUST null-check. A socket can in principle survive a shutdown
     * race, and a NullPointerException inside a WebSocket callback is invisible —
     * it kills the connection with no useful log line.</p>
     */
    public static GatewayContext getContext() {
        return context;
    }

    static void register(ScriptIdeSocket socket) {
        OPEN_SOCKETS.add(socket);
    }

    static void unregister(ScriptIdeSocket socket) {
        OPEN_SOCKETS.remove(socket);
    }

    /** Number of currently open sockets — surfaced for diagnostics and tests. */
    public static int openSocketCount() {
        return OPEN_SOCKETS.size();
    }

    /** Close every open socket and drop the context. Safe to call twice. */
    public static void shutdown() {
        int count = OPEN_SOCKETS.size();
        for (ScriptIdeSocket socket : Set.copyOf(OPEN_SOCKETS)) {
            try {
                socket.closeForShutdown();
            } catch (Exception e) {
                logger.debug("Error closing socket during shutdown: {}", e.getMessage());
            }
        }
        OPEN_SOCKETS.clear();
        // Shut the pool down AFTER closing sockets, so nothing new is submitted
        // into a dying executor.
        ExecutionService service = executionService;
        if (service != null) {
            service.shutdown();
        }
        // Terminals are OS processes, not threads: leaving one behind leaves a
        // shell running as the Gateway user with nothing reading its output.
        TerminalService terminals = terminalService;
        if (terminals != null) {
            terminals.shutdown();
        }
        terminalService = null;
        executionService = null;
        execAudit = null;
        tagBrowser = null;
        dbSchema = null;
        ExecutorService pool = completionRefreshPool;
        if (pool != null) {
            pool.shutdownNow();
            try {
                pool.awaitTermination(5, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        completionRefreshPool = null;
        stopPresence();
        stopGitStatus();
        context = null;
        if (count > 0) {
            logger.info("Closed {} Web IDE socket(s) during shutdown", count);
        }
    }
}
