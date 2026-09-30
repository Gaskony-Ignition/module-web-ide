package com.gaskony.scriptide.gateway.exec;

import com.inductiveautomation.ignition.common.script.ScriptManager;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import org.python.core.PyObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.LongConsumer;

/**
 * Runs user scripts on a pool this module owns, and stops them as best it can.
 *
 * <h2>Why a dedicated pool</h2>
 *
 * <p>Never {@code context.getExecutorService()}. One user's {@code while True:}
 * on the gateway's own pool takes the gateway down — not this module, the gateway.
 * A bounded private pool means the worst case is that script execution stops
 * working while everything else keeps running.</p>
 *
 * <h2>Stop is best-effort, and the UI must say so</h2>
 *
 * <p>{@code ScriptManager.interrupt(tid)} installs a trace function that fires at
 * the next Python trace point. Measured in spike S1: a 15 s busy loop interrupted
 * at 3 s stopped at <b>3.0 s</b>; a {@code time.sleep(10)} interrupted at 2 s ran
 * the full <b>10.06 s</b>. Anything blocked inside a Java call — a JDBC query, a
 * socket read, {@code system.tag.readBlocking} with a long timeout — cannot be
 * stopped that way.</p>
 *
 * <p>Hence the ladder in {@link #requestStop}: interrupt, then
 * {@code Thread.interrupt()} (which does unblock sleeps and interruptible I/O),
 * then give up and mark the execution ABANDONED. You cannot kill a Java thread.
 * An abandoned thread permanently costs a pool slot, so it is counted and
 * surfaced rather than quietly tolerated.</p>
 *
 * <h2>{@link #submit} never blocks its caller, and that is the point</h2>
 *
 * <p>Until 1.5.0 this class had an {@code execute()} that waited on the worker's
 * future. Its caller is a WebSocket frame handler, and {@code ScriptIdeSocket} is
 * an {@code AutoDemanding} listener — one frame at a time, on the socket thread.
 * So a running script held the whole connection: measured on 1.4.3, a Stop sent
 * 1.5 s into a 20 s busy loop was not READ until the loop had finished, the loop
 * ran its full 20.0 s, and every ping, LSP request and terminal keystroke queued
 * behind it. The Stop button could not have worked, because nothing was listening.</p>
 *
 * <p>So the result now arrives through {@code onComplete} instead of a return
 * value, the timeout ladder runs on the watchdog rather than a {@code future.get}
 * with a deadline, and the socket thread is free the moment the work is accepted.</p>
 */
public final class ExecutionService {

    private static final Logger logger = LoggerFactory.getLogger(ExecutionService.class);

    /** How long to wait after a Jython interrupt before escalating. */
    private static final long ESCALATE_TO_THREAD_INTERRUPT_MS = 5_000;

    /** How long after that before the execution is declared abandoned. */
    private static final long ESCALATE_TO_ABANDON_MS = 30_000;

    private final GatewayContext context;
    private final ThreadPoolExecutor pool;
    private final ScheduledExecutorService watchdog;

    /**
     * How a project name becomes a runner. Overridable for tests only.
     *
     * <p>See {@link ScriptRunner} for why the seam exists — the scheduling
     * behaviour asserted around it has nothing to do with Jython, and proving it
     * through a real interpreter would mean a unit test that boots one.</p>
     */
    private final Function<String, ScriptRunner> runnerFactory;

    /**
     * Step 1 of the stop ladder, as a seam.
     *
     * <p>{@code ScriptManager.interrupt} is a static on a platform class that does
     * nothing useful outside a Gateway, so a test substitutes its own and the
     * ladder itself stays exactly as measured.</p>
     */
    private final LongConsumer jythonInterrupt;

    /** In-flight executions by id. */
    private final Map<String, RunningExecution> running = new ConcurrentHashMap<>();

    /** One execution at a time per session, so nobody can fill the pool alone. */
    private final Map<String, String> executionBySession = new ConcurrentHashMap<>();

    private final Map<String, PrivateStateRunner> runnersByProject = new ConcurrentHashMap<>();

    private final AtomicLong abandonedCount = new AtomicLong();
    private final AtomicLong completedCount = new AtomicLong();

    public ExecutionService(GatewayContext context) {
        this(context, null, ScriptManager::interrupt);
    }

    /** Test seam — see {@link #runnerFactory} and {@link #jythonInterrupt}. */
    ExecutionService(Function<String, ScriptRunner> runnerFactory, LongConsumer jythonInterrupt) {
        this(null, runnerFactory, jythonInterrupt);
    }

    private ExecutionService(GatewayContext context, Function<String, ScriptRunner> runnerFactory,
                             LongConsumer jythonInterrupt) {
        this.context = context;
        this.runnerFactory = runnerFactory == null ? this::runnerFor : runnerFactory;
        this.jythonInterrupt = jythonInterrupt;
        int size = ExecPolicy.maxConcurrent();
        ThreadFactory factory = new ThreadFactory() {
            private final AtomicInteger n = new AtomicInteger(1);

            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "script-ide-exec-" + n.getAndIncrement());
                t.setDaemon(true);
                // Slightly below normal: a runaway user script should lose to the
                // gateway's own work when the CPU is contended.
                t.setPriority(Thread.NORM_PRIORITY - 1);
                return t;
            }
        };
        this.pool = new ThreadPoolExecutor(size, size, 0L, TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<>(Math.max(2, size * 2)), factory,
            new ThreadPoolExecutor.AbortPolicy());
        this.watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "script-ide-exec-watchdog");
            t.setDaemon(true);
            return t;
        });
        logger.info("Web IDE execution pool started with {} thread(s)", size);
    }

    /** One in-flight execution. */
    static final class RunningExecution {
        final String id;
        final String username;
        final String sessionId;
        final long startedAtMillis;
        volatile Thread thread;
        volatile boolean stopRequested;
        volatile boolean abandoned;

        RunningExecution(String id, String username, String sessionId) {
            this.id = id;
            this.username = username;
            this.sessionId = sessionId;
            this.startedAtMillis = System.currentTimeMillis();
        }
    }

    /** Thrown when the pool or the per-session limit refuses a request. */
    public static final class RejectedException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        RejectedException(String message) {
            super(message);
        }
    }

    /**
     * Submit a script for execution and RETURN. The result arrives on a callback.
     *
     * <p>Non-blocking by design — see the class Javadoc. The caller is the socket
     * thread and must be free to read the next frame, which is the only way a Stop
     * can be heard at all.</p>
     *
     * <p>Callback order is guaranteed: {@code onStarted} once, on the worker thread
     * immediately before the script runs; then any number of {@code output} chunks
     * through {@code listener}; then {@code onComplete} exactly once. A client can
     * therefore render output as it arrives and treat the completion as final.</p>
     *
     * @param onStarted run on the worker just before the script does — send the
     *                  {@code started} frame here, not before the submit, so a
     *                  rejection produces an error frame instead
     * @param listener  where output goes as it is produced; whatever it receives is
     *                  NOT repeated in the outcome
     * @param onComplete the single completion, fired even when the script could not
     *                  be stopped (the outcome then reports cancelled)
     * @throws RejectedException when this session already has a script running, or
     *                  the pool is full
     */
    public void submit(String executionId, String project, String source, String fileName,
                       PyObject locals, String username, String sessionId,
                       Runnable onStarted, ScriptRunner.OutputListener listener,
                       Consumer<PrivateStateRunner.Outcome> onComplete) {

        String previous = executionBySession.putIfAbsent(sessionId, executionId);
        if (previous != null) {
            throw new RejectedException(
                "You already have a script running. Stop it before starting another.");
        }

        RunningExecution execution = new RunningExecution(executionId, username, sessionId);
        running.put(executionId, execution);

        // Exactly one of the worker and the timeout escalation gets to report.
        AtomicBoolean reported = new AtomicBoolean();
        Consumer<PrivateStateRunner.Outcome> report = outcome -> {
            if (!reported.compareAndSet(false, true)) {
                return;
            }
            // The session slot is released on the REPORT, not on the thread
            // actually ending: a script that cannot be stopped must not lock its
            // owner out of the console for ever. The pool bound is what protects
            // the gateway from the leaked thread, and abandonedCount() surfaces it.
            executionBySession.remove(sessionId, executionId);
            completedCount.incrementAndGet();
            try {
                onComplete.accept(outcome);
            } catch (RuntimeException e) {
                logger.debug("Completion callback for {} failed: {}", executionId, e.toString());
            }
        };

        long timeout = ExecPolicy.timeoutSeconds();
        try {
            pool.execute(() -> {
                execution.thread = Thread.currentThread();
                try {
                    onStarted.run();
                } catch (RuntimeException e) {
                    logger.debug("started callback for {} failed: {}", executionId, e.toString());
                }
                try {
                    report.accept(runnerFactory.apply(project).run(source, fileName, locals,
                        listener));
                } catch (Throwable t) {
                    // Throwable, not Exception: a Stop arrives as a Java Error.
                    report.accept(new PrivateStateRunner.Outcome("", "", false, t,
                        PrivateStateRunner.isCancellation(t)));
                } finally {
                    // Only here — while the entry is present, requestStop can still
                    // climb its ladder and currentExecutions() tells the truth about
                    // a thread that is genuinely still spinning.
                    running.remove(executionId);
                }
            });
        } catch (RejectedExecutionException e) {
            running.remove(executionId);
            executionBySession.remove(sessionId, executionId);
            throw new RejectedException(
                "Too many scripts are running on this gateway right now. Try again shortly.");
        }

        // The timeout, on the watchdog rather than a future.get deadline. Same
        // ladder as before: ask it to stop, give the interrupt a moment to land,
        // then report it as cancelled whether or not the thread actually died.
        watchdog.schedule(() -> {
            if (reported.get()) {
                return;
            }
            logger.warn("Execution {} by '{}' exceeded {}s; stopping it",
                executionId, username, timeout);
            requestStop(executionId);
            watchdog.schedule(() -> report.accept(new PrivateStateRunner.Outcome("", "", false,
                    new IllegalStateException("Script exceeded the " + timeout
                        + "s time limit and was stopped."), true)),
                ESCALATE_TO_THREAD_INTERRUPT_MS, TimeUnit.MILLISECONDS);
        }, timeout, TimeUnit.SECONDS);
    }

    /** Whether this execution is still in flight. */
    public boolean isRunning(String executionId) {
        return executionId != null && running.containsKey(executionId);
    }

    /**
     * Stop whatever this session is running, if anything. Used when a socket closes.
     *
     * <p>Scans the in-flight set rather than reading the per-session slot, because
     * the slot is released when a run is REPORTED and a run that timed out is
     * reported while its thread is still spinning. Those are precisely the runs
     * worth chasing when the browser has gone.</p>
     */
    public void stopAllFor(String sessionId) {
        for (RunningExecution execution : running.values()) {
            if (execution.sessionId.equals(sessionId)) {
                requestStop(execution.id);
            }
        }
    }

    /**
     * Ask an execution to stop. Best-effort — see the class Javadoc.
     *
     * @return a human-readable description of what was attempted, for the UI
     */
    public String requestStop(String executionId) {
        RunningExecution execution = running.get(executionId);
        if (execution == null) {
            return "That script is no longer running.";
        }
        execution.stopRequested = true;
        Thread thread = execution.thread;
        if (thread == null) {
            return "The script has not started yet; it will be stopped when it does.";
        }

        // Step 1 — the Jython interrupt. Fires at the next Python trace point.
        try {
            jythonInterrupt.accept(thread.getId());
        } catch (RuntimeException e) {
            logger.debug("ScriptManager.interrupt failed for {}: {}", executionId, e.getMessage());
        }

        // Steps 2 and 3 run on the watchdog so the caller's frame handler returns
        // immediately — the UI needs to say "Stopping…" now, not in 35 seconds.
        watchdog.schedule(() -> {
            if (!running.containsKey(executionId)) {
                return;
            }
            // Step 2 — unblocks Thread.sleep and interruptible I/O, which the
            // Jython interrupt cannot touch.
            logger.info("Execution {} did not stop at a trace point; interrupting its thread",
                executionId);
            thread.interrupt();

            watchdog.schedule(() -> {
                RunningExecution still = running.get(executionId);
                if (still == null) {
                    return;
                }
                // Step 3 — there is no step 4. A Java thread cannot be killed.
                still.abandoned = true;
                abandonedCount.incrementAndGet();
                logger.warn("Execution {} started by '{}' could not be stopped and has been "
                        + "ABANDONED. It still holds a pool thread. Abandoned total: {}.",
                    executionId, still.username, abandonedCount.get());
            }, ESCALATE_TO_ABANDON_MS - ESCALATE_TO_THREAD_INTERRUPT_MS, TimeUnit.MILLISECONDS);
        }, ESCALATE_TO_THREAD_INTERRUPT_MS, TimeUnit.MILLISECONDS);

        return "Stopping… waiting for the script to reach a stopping point. "
            + "A script blocked in a database or network call cannot be interrupted.";
    }

    /** Number of executions that could not be stopped. Non-zero is worth alerting on. */
    public long abandonedCount() {
        return abandonedCount.get();
    }

    /** A snapshot of one in-flight execution, for the Running Scripts panel. */
    public record ExecutionStatus(String id, String username, long runningForMillis,
                                  boolean stopRequested, boolean abandoned) {
    }

    /**
     * What is running right now.
     *
     * <p>This is what makes a best-effort Stop honest: a user who pressed Stop can
     * see that their script is still going and that we know it, rather than being
     * shown a button that appeared to work and did nothing.</p>
     */
    public List<ExecutionStatus> currentExecutions() {
        long now = System.currentTimeMillis();
        List<ExecutionStatus> out = new ArrayList<>(running.size());
        for (RunningExecution e : running.values()) {
            out.add(new ExecutionStatus(e.id, e.username, now - e.startedAtMillis,
                e.stopRequested, e.abandoned));
        }
        return out;
    }

    /** Number of executions currently in flight. */
    public int runningCount() {
        return running.size();
    }

    /** Total executions that have finished. */
    public long completedCount() {
        return completedCount.get();
    }

    /**
     * A runner per project, so each uses that project's own ScriptManager and
     * therefore sees that project's script library.
     */
    private PrivateStateRunner runnerFor(String project) {
        // The runner is cached; the MANAGER it uses is not — it holds a supplier and
        // resolves the project's current ScriptManager on every run, so a script the
        // user just saved is visible immediately. See PrivateStateRunner.
        return runnersByProject.computeIfAbsent(project, p ->
            new PrivateStateRunner(
                () -> context.getProjectManager().getProjectScriptManager(p), watchdog));
    }

    /**
     * A fresh locals map for the given project — the REPL state of one console.
     *
     * <p>{@code cprint} and {@code jsonPrint} are defined in it before it is
     * handed out. They live only in a namespace this module made, which is what
     * keeps them out of ordinary gateway code — see {@link ConsoleHelpers}.</p>
     */
    public PyObject newLocals(String project) {
        PyObject locals =
            context.getProjectManager().getProjectScriptManager(project).createLocalsMap();
        ConsoleHelpers.install(locals);
        return locals;
    }

    /** Shut the pool down, without waiting forever on a script that will not stop. */
    public void shutdown() {
        watchdog.shutdownNow();
        pool.shutdownNow();
        try {
            if (!pool.awaitTermination(5, TimeUnit.SECONDS)) {
                logger.warn("Execution pool did not terminate within 5s — {} execution(s) "
                    + "were still running.", running.size());
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        running.clear();
        executionBySession.clear();
        runnersByProject.clear();
        logger.info("Web IDE execution pool shut down");
    }
}
