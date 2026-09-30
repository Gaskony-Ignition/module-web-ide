package com.gaskony.scriptide.gateway.exec;

import com.inductiveautomation.ignition.common.script.ScriptManager;
import org.python.core.CompileMode;
import org.python.core.CompilerFlags;
import org.python.core.Py;
import org.python.core.PyCode;
import org.python.core.PyException;
import org.python.core.PyFrame;
import org.python.core.PyObject;
import org.python.core.PyStringMap;
import org.python.core.PySystemState;
import org.python.core.ThreadState;
import org.python.core.TraceFunction;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Runs one script with its own private {@code stdout} and {@code stderr}.
 *
 * <h2>Why this does not use {@code ScriptManager.runCode}</h2>
 *
 * <p>Because that leaks one user's output into another's. Measured on Ignition
 * 8.3.8 / Jython 2.7.4 (spike S1): two concurrent {@code runCode} executions, each
 * printing 500 tagged lines through one {@code addStdOutStream} substream that
 * routed by thread id, produced <b>22–25 lines of cross-talk each way</b> and lost
 * ~45 more. Routing by thread is not enough because Jython's {@code sys.stdout} is
 * a single shared buffer: the thread that performs the write is not necessarily
 * the thread that produced the bytes.</p>
 *
 * <p>The approach below measured 0 cross-talk and 0 loss on the same test, and it
 * is the whole reason this class exists. Do not "simplify" it back.</p>
 *
 * <h2>The two refinements, both load-bearing</h2>
 * <ol>
 *   <li>A <b>fresh</b> {@link PySystemState} has an empty module registry, so
 *       {@code import system} and every project-library import raise
 *       {@code ImportError}. The manager's modules must be brought across.</li>
 *   <li><b>Sharing</b> the manager's module map is still not enough. In Jython
 *       {@code sys.modules['sys']} <i>is</i> the {@code PySystemState}, so a shared
 *       map leaves a script's {@code sys.stdout}/{@code sys.stderr} pointing at the
 *       MANAGER's streams. {@code print} would be isolated (it reads the
 *       thread-local state) while an explicit {@code sys.stderr.write(...)} would
 *       not. So the map is COPIED and the copy's {@code sys} is repointed at our
 *       own state.</li>
 *   <li><b>Loading a project library module moves the thread off our state.</b>
 *       Ignition runs the module's code via {@code ScriptManager.runCode}, which
 *       calls {@code Py.setSystemState(manager.sys)} on the CALLING thread and
 *       never restores it. The load happens on first attribute access, anywhere —
 *       including inside project code the run called — so it cannot be
 *       intercepted. Two things cover it: {@link RunOutputRouter} sends whatever
 *       this thread writes to the manager's streams into our capture, so output
 *       is never lost; and {@link #installImportHook} puts our state back after
 *       an import that loads a module itself, so {@code sys} stays private in
 *       that case too.</li>
 * </ol>
 *
 * <p>All three were measured rather than reasoned about. Removing any of them
 * breaks isolation silently — and one of the failure modes is cross-user data
 * leakage, not merely lost output.</p>
 *
 * <h2>Output is streamed, and the outcome then carries none of it</h2>
 *
 * <p>When a {@link ScriptRunner.OutputListener} is supplied, captured bytes are
 * pushed to it in chunks and are <b>not</b> retained: {@code Outcome.stdout()} and
 * {@code Outcome.stderr()} come back EMPTY. That split is deliberate and is the
 * whole reason the client can render output as it arrives without double-printing
 * — see the {@code finished} frame's contract in {@code execClient.ts}. With no
 * listener the old behaviour stands and the outcome carries everything, which is
 * what the tests use.</p>
 *
 * <p>A chunk is flushed on a newline, at 4 KB, or every 100 ms, whichever comes
 * first. The newline rule is what makes {@code print} in a loop feel live; the
 * timer is what saves a script that writes a long line without ever ending it.</p>
 */
public final class PrivateStateRunner implements ScriptRunner {

    private static final Logger logger = LoggerFactory.getLogger(PrivateStateRunner.class);

    /** Per-execution output cap. Beyond this, output is dropped, not the script. */
    static final int MAX_CAPTURED_BYTES = 2 * 1024 * 1024;

    /** Flush a partial chunk this often, so an unterminated line still appears. */
    static final long FLUSH_INTERVAL_MS = 100;

    /** Flush early once a chunk reaches this size, whatever it contains. */
    static final int FLUSH_AT_BYTES = 4096;

    /**
     * Resolves the project's CURRENT ScriptManager.
     *
     * <p>A supplier, not a stored manager, and that distinction is load-bearing.
     * The platform builds a project's script library into its ScriptManager, and
     * rebuilds it — into a NEW manager — when project resources change. Holding one
     * meant every execution ran against the library as it was when this runner was
     * first constructed: a script the user had just saved was invisible, failing
     * with a bare {@code ImportError: No module named X} while the resource plainly
     * existed on disk. That reads exactly like a broken save and is not.
     *
     * <p>Measured 01/09/2026: a freshly written library module was unimportable in
     * two different projects until the manager was resolved per execution. A
     * pre-existing module imported fine throughout, which is what made the cache
     * the obvious suspect.</p>
     */
    private final Supplier<ScriptManager> scriptManagerSupplier;

    /**
     * Cached manager state, valid only for {@link #managerStateOwner}.
     *
     * <p>Obtained without reflection: {@code ScriptManager.runCode} calls
     * {@code setState()} → {@code Py.setSystemState(manager.sys)} on the CALLING
     * thread and does not restore it, so running a trivial snippet and then reading
     * {@code Py.getSystemState()} yields the manager's state. Verified in S1.</p>
     */
    private volatile PySystemState managerState;

    /** The manager {@link #managerState} was probed from; a new one invalidates it. */
    private volatile ScriptManager managerStateOwner;

    /**
     * Drives the 100 ms flush, or {@code null} for newline/size flushing only.
     *
     * <p>Borrowed rather than owned: {@link ExecutionService} already runs a
     * single-threaded scheduler for the stop ladder, and one more periodic task
     * per in-flight run costs nothing there. A thread of our own would have to be
     * shut down by whoever constructed us, which is exactly the sort of lifecycle
     * nobody remembers to wire up.</p>
     */
    private final ScheduledExecutorService flushScheduler;

    public PrivateStateRunner(Supplier<ScriptManager> scriptManagerSupplier) {
        this(scriptManagerSupplier, null);
    }

    public PrivateStateRunner(Supplier<ScriptManager> scriptManagerSupplier,
                              ScheduledExecutorService flushScheduler) {
        this.scriptManagerSupplier = scriptManagerSupplier;
        this.flushScheduler = flushScheduler;
    }

    /** What one execution produced. */
    public record Outcome(String stdout, String stderr, boolean truncated,
                          Throwable failure, boolean cancelled) {

        public boolean succeeded() {
            return failure == null && !cancelled;
        }
    }

    /** Execute {@code source}, accumulating its output rather than streaming it. */
    public Outcome run(String source, String fileName, PyObject locals) {
        return run(source, fileName, locals, null);
    }

    /**
     * Execute {@code source}, capturing its output privately.
     *
     * @param source   the code to run
     * @param fileName appears in every traceback frame — use a reversible token so
     *                 frames can be mapped back to an editor tab
     * @param locals   the locals map; pass the SAME one across calls for a console
     *                 session to behave like a REPL
     * @param listener streams output as it is produced; when present the returned
     *                 outcome carries NO stdout or stderr, because everything has
     *                 already been sent (see the class Javadoc)
     *
     * <h3 id="runInOneNamespace">The locals map is ALSO the globals map</h3>
     *
     * <p><strong>Not a simplification — the alternative silently breaks every
     * script that defines a function.</strong> Executing module-level code with
     * two different dicts is exactly the {@code exec(code, globals, locals)}
     * trap: a top-level {@code x = 41} is an assignment, so it lands in
     * <em>locals</em>, while a {@code def} compiled in that same module captures
     * <em>globals</em> as its {@code __globals__}. The function then cannot see
     * anything the script above it defined.</p>
     *
     * <p>Measured on the rig, 02/09/2026, against
     * {@code scriptManager.getGlobals()} as the globals map — which is empty:
     * {@code x = 41; def f(): return x + 1} raised
     * {@code NameError: global name 'x' is not defined}, and so did every
     * {@code import} and every class body. Worst of all,
     * {@code def f(): return system.date.now()} raised
     * {@code global name 'system' is not defined}: {@code system} lives in the
     * locals map {@code ScriptManager.createLocalsMap()} seeds, so it resolved at
     * module level and vanished one indent in. Practically every real Ignition
     * script has a function in it, so the console worked for one-liners and
     * failed for the actual job.</p>
     *
     * <p>Passing the same dict for both is what a real module does, and what the
     * Designer's console does. It costs nothing: the locals map is already
     * per-execution (or per-console-session for the REPL), so nothing leaks
     * between users, and {@code system} plus the project library are in it
     * because the platform put them there.</p>
     */
    @Override
    public Outcome run(String source, String fileName, PyObject locals,
                       OutputListener listener) {
        Capture out = capture("stdout", listener);
        Capture err = capture("stderr", listener);
        // One task for both streams: two would double the scheduler load for no
        // benefit, and the flush is a no-op when there is nothing pending.
        ScheduledFuture<?> pump = (listener == null || flushScheduler == null) ? null
            : schedulePump(out, err);

        ScriptManager scriptManager = scriptManagerSupplier.get();
        PySystemState mgr = managerState(scriptManager);
        RunOutputRouter.install(mgr);
        PySystemState state = ScriptManager.createUtf8PySystemState(out, err);
        applyModuleRegistry(state, mgr);
        installImportHook(state, locals);

        PySystemState previous = Py.getSystemState();
        ThreadState ts = Py.getThreadState();
        FrameSnapshot before = FrameSnapshot.of(ts);
        Throwable failure = null;
        boolean cancelled = false;
        try {
            // Thread-local: this is what makes the streams private.
            Py.setSystemState(state);
            // And this keeps them private after a library load moves the thread
            // onto the manager's state — see RunOutputRouter.
            RunOutputRouter.enter(state);
            PyCode code = Py.compile_flags(source, fileName, CompileMode.exec, new CompilerFlags());
            // ONE dict for locals AND globals — see runInOneNamespace below.
            Py.runCode(code, locals, locals);
        } catch (PyException e) {
            failure = e;
        } catch (Throwable t) {
            // MUST be Throwable, not Exception. A Stop raises a Java Error from a
            // Jython trace function that escapes Python's exception machinery
            // entirely — S1 confirmed neither a bare `except:` nor
            // `except java.lang.Throwable` in Jython catches it, and the worker
            // thread simply died. Catching it here is the only place it can be
            // turned into a clean "cancelled" result.
            failure = t;
            cancelled = isCancellation(t);
        } finally {
            before.restore(ts);
            // Still routed: if a load moved the thread, this flush reaches the
            // manager's sys, and must land in this run's capture.
            flushQuietly(scriptManager, locals);
            RunOutputRouter.exit();
            try {
                Py.setSystemState(previous);
            } catch (RuntimeException e) {
                logger.debug("Could not restore the previous PySystemState: {}", e.getMessage());
            }
            // Cancel BEFORE the final flush, or the pump can interleave with it and
            // the last two chunks arrive out of order on the same stream.
            if (pump != null) {
                pump.cancel(false);
            }
            out.finish();
            err.finish();
        }

        boolean truncated = out.truncated() || err.truncated();
        return new Outcome(out.captured(), err.captured(), truncated, failure, cancelled);
    }

    /** A stream that streams to {@code listener}, or one that accumulates. */
    private static Capture capture(String name, OutputListener listener) {
        return listener == null
            ? new BoundedOutputStream(MAX_CAPTURED_BYTES)
            : new StreamingOutputStream(MAX_CAPTURED_BYTES, name, listener);
    }

    private ScheduledFuture<?> schedulePump(Capture out, Capture err) {
        return flushScheduler.scheduleWithFixedDelay(() -> {
            // Never let a flush failure kill the periodic task — a cancelled
            // ScheduledFuture is silent, and the run would simply stop streaming.
            try {
                out.flushPending();
                err.flushPending();
            } catch (RuntimeException e) {
                logger.debug("Output flush failed: {}", e.toString());
            }
        }, FLUSH_INTERVAL_MS, FLUSH_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * Jython buffers {@code sys.stdout}, so the last chunk of a script's output can
     * still be unwritten when {@code runCode} returns. Flush on the SAME thread,
     * while our state is still installed, or that tail is lost.
     */
    private void flushQuietly(ScriptManager scriptManager, PyObject locals) {
        try {
            PyCode flush = Py.compile_flags(
                "import sys\nsys.stdout.flush()\nsys.stderr.flush()\n",
                "<script-ide-flush>", CompileMode.exec, new CompilerFlags());
            Py.runCode(flush, locals, locals);
        } catch (Throwable t) {
            // A failed flush costs at most a truncated tail; it must never mask the
            // script's own result.
            logger.debug("Flush after execution failed: {}", t.toString());
        }
    }

    /**
     * Put our system state back after every import this run performs.
     *
     * <p>An import that loads a project library module there and then —
     * {@code from M import f}, {@code import P.sub}, {@code from P import sub} —
     * leaves the thread on the manager's state, like any other load (see the
     * class Javadoc). Measured on 8.3.9 with a fresh module per case: through the
     * platform's own {@code __import__} each of those left
     * {@code Py.getSystemState()} on the manager's state; through this hook it was
     * ours again. A plain {@code import M} loads nothing yet — the load comes at
     * {@code M.f}, which no hook here sees; {@link RunOutputRouter} keeps the
     * output right in that case, and the thread's {@code sys} is then the
     * manager's until the run ends.</p>
     *
     * <h3>Why a private builtins table, and not a hook in the namespace</h3>
     *
     * <p>Because there is no such thing as a namespace-local builtins table by
     * default. Every {@code PySystemState} is handed the SAME
     * {@code getDefaultBuiltins()} map, so assigning
     * {@code __builtins__['__import__']} from a console run replaces
     * {@code __import__} for the whole JVM — every project script and every
     * gateway event script — with whatever that one session installed.</p>
     *
     * <p>So the table is COPIED first and only the copy is touched. The copy is
     * built fresh per run from the state's own builtins, which means the delegate
     * is always the genuine {@code __import__} and hooks can never chain — the
     * console's namespace survives between runs and would otherwise accumulate one
     * wrapper per run, each restoring a system state that had already been
     * discarded.</p>
     */
    // Package-private and static so PrivateStateRunnerImportTest can drive it:
    // createUtf8PySystemState needs a stdlib the jython-ia jar does not carry, so
    // the runner itself cannot boot in a unit test, but this method can.
    static void installImportHook(PySystemState state, PyObject locals) {
        try {
            PyObject builtins = state.getBuiltins();
            if (!(builtins instanceof PyStringMap map)) {
                logger.warn("Builtins is a {}, not a PyStringMap — output written after an "
                    + "import may be lost.",
                    builtins == null ? "null" : builtins.getClass().getName());
                return;
            }
            PyStringMap privateBuiltins = map.copy();
            PyObject real = privateBuiltins.__finditem__("__import__");
            if (real == null) {
                logger.warn("No __import__ in the builtins table; output written after an "
                    + "import may be lost.");
                return;
            }
            privateBuiltins.__setitem__("__import__", new RestoringImport(real, state));
            state.setBuiltins(privateBuiltins);
            // The frame takes its builtins from the globals when they name one, so
            // this has to be set as well: the console's namespace persists between
            // runs and would otherwise still be pointing at the PREVIOUS run's
            // table, whose hook restores a state that has already been finished.
            locals.__setitem__("__builtins__", privateBuiltins);
        } catch (RuntimeException e) {
            // Losing the hook costs output; failing here would cost the run.
            logger.warn("Could not install the import hook ({}); output written after an "
                + "import may be lost.", e.toString());
        }
    }

    /**
     * {@code __import__}, delegating to the real one and then restoring our state.
     *
     * <p>{@code finally}, not a plain sequence: a failed import is exactly when a
     * user most wants the traceback that follows it, and an import that raises has
     * still moved the thread's state by then.</p>
     */
    private static final class RestoringImport extends PyObject {
        // PyObject is Serializable. This one never is — it lives for one run and
        // is reachable only from that run's builtins copy — but the id has to be
        // declared rather than left to the compiler, which would change it on
        // every edit.
        private static final long serialVersionUID = 1L;

        private final PyObject delegate;
        private final PySystemState state;

        RestoringImport(PyObject delegate, PySystemState state) {
            this.delegate = delegate;
            this.state = state;
        }

        @Override
        public PyObject __call__(PyObject[] args, String[] keywords) {
            try {
                return delegate.__call__(args, keywords);
            } finally {
                Py.setSystemState(state);
            }
        }
    }

    /**
     * Give the private state the manager's modules and import path — see the class
     * Javadoc for why the map is copied rather than shared.
     */
    private void applyModuleRegistry(PySystemState state, PySystemState mgr) {
        try {
            if (mgr.modules instanceof PyStringMap map) {
                PyStringMap copy = map.copy();
                // sys.modules['sys'] IS the PySystemState. Repoint it at ours, or an
                // explicit sys.stdout/sys.stderr write goes to the manager's streams.
                copy.__setitem__("sys", state);
                state.modules = copy;
            } else {
                // Unexpected implementation: share rather than fail. Output stays
                // isolated for `print`; only explicit sys.* writes would leak, and
                // that beats refusing to run at all.
                logger.warn("sys.modules is a {}, not a PyStringMap — sharing it instead of "
                    + "copying. Explicit sys.stdout/sys.stderr writes may not be isolated.",
                    mgr.modules == null ? "null" : mgr.modules.getClass().getName());
                state.modules = mgr.modules;
            }
        } catch (RuntimeException e) {
            logger.warn("Could not copy the module registry ({}); sharing it instead.",
                e.getMessage());
            state.modules = mgr.modules;
        }

        // The import MACHINERY, not just the already-imported modules.
        //
        // Copying sys.modules alone only carries modules the manager has ALREADY
        // imported. Resolving one it has not — a project library script the user
        // just saved and is importing for the first time — needs Ignition's own
        // importer, which lives on meta_path/path_hooks. Without these, that
        // import fails with a bare "No module named X" while the resource plainly
        // exists on disk, which reads exactly like a failed save.
        //
        // Measured 01/09/2026: a freshly saved library script was unimportable
        // until these three were carried across.
        state.path = mgr.path;
        state.meta_path = mgr.meta_path;
        state.path_hooks = mgr.path_hooks;
        // Shared deliberately: it is a cache, and sharing it means a module the
        // manager resolves later is visible to us without another round trip.
        state.path_importer_cache = mgr.path_importer_cache;
    }

    /**
     * The manager's system state, re-probed whenever the manager itself changes.
     *
     * <p>The identity check is the point: a rebuilt library arrives as a new
     * ScriptManager, and a state cached from the previous one would keep serving
     * the previous library.</p>
     */
    private PySystemState managerState(ScriptManager scriptManager) {
        PySystemState cached = managerState;
        if (cached != null && managerStateOwner == scriptManager) {
            return cached;
        }
        synchronized (this) {
            if (managerState == null || managerStateOwner != scriptManager) {
                try {
                    // runCode leaves the manager's state on THIS thread.
                    scriptManager.runCode("pass\n", scriptManager.createLocalsMap(),
                        "<script-ide-probe>");
                } catch (Exception e) {
                    // "pass" cannot fail on its own merits, so this means the
                    // manager itself is unhealthy. Read the state anyway — runCode
                    // installs it before executing, so the probe has still done its
                    // job — and let the real execution surface the problem.
                    logger.warn("Probe snippet failed while resolving the manager's "
                        + "PySystemState: {}", e.toString());
                }
                managerState = Py.getSystemState();
                managerStateOwner = scriptManager;
            }
            return managerState;
        }
    }

    /**
     * The interpreter frame state a pool thread carried BEFORE a run, restored
     * after it whether or not the run ended cleanly.
     *
     * <p>A Stop poisons the thread it lands on. {@code ScriptManager.interrupt}
     * installs a {@code BreakTraceFunction} on the running frame, and when that
     * function throws from inside {@code PyTableCode.call}'s exception handler
     * the error escapes BEFORE the handler pops the frame, so
     * {@code ThreadState.frame} stays pointed at the dead {@code <console>} frame
     * with the trace function still attached. Measured on 1.5.0 (02/09/2026):
     * every later run on that pool thread came back "cancelled" with no output
     * and no error, two Stops took half the pool, and four would have taken the
     * console until the gateway restarted. Restoring the thread's frame state
     * after every run — measured the same way — is what fixed it.</p>
     */
    record FrameSnapshot(PyFrame frame, TraceFunction tracefunc, PyException exception) {

        static FrameSnapshot of(ThreadState ts) {
            return new FrameSnapshot(ts.frame, ts.tracefunc, ts.exception);
        }

        void restore(ThreadState ts) {
            if (ts.frame != frame) {
                // Strip the trace function from every frame the run left behind:
                // interrupt() may have reached frames nothing points at any more,
                // and a chain that still carries one is a trap for whatever
                // borrows it next.
                for (PyFrame f = ts.frame; f != null && f != frame; f = f.f_back) {
                    f.tracefunc = null;
                }
                ts.frame = frame;
            }
            ts.tracefunc = tracefunc;
            ts.exception = exception;
        }
    }

    /**
     * Whether a Throwable is the platform cancelling a script rather than the
     * script failing.
     *
     * <p>Matched on class name because {@code ScriptManager.ScriptCanceledError} is
     * not part of the public SDK surface and referencing it directly would bind us
     * to an internal type.</p>
     */
    static boolean isCancellation(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            String name = c.getClass().getName();
            if (name.contains("ScriptCanceled") || name.contains("ThreadDeath")) {
                return true;
            }
            if (c.getCause() == c) {
                break;
            }
        }
        return false;
    }

    /**
     * A capped output sink, whether it accumulates or streams.
     *
     * <p>An abstract class rather than an interface because Jython is handed a
     * plain {@link OutputStream} and both variants have to BE one; the two are
     * otherwise interchangeable, which is what lets the streaming decision be a
     * single ternary in {@link #capture}.</p>
     */
    abstract static class Capture extends OutputStream {

        /** Whether the cap was reached and output was dropped. */
        abstract boolean truncated();

        /** Everything retained — empty for a streaming capture, by design. */
        abstract String captured();

        /** Push whatever is buffered to the listener. A no-op when accumulating. */
        void flushPending() {
        }

        /** Last flush of the run, after which nothing more will be written. */
        void finish() {
        }
    }

    /**
     * Captures output up to a cap, then silently drops the rest.
     *
     * <p>Deliberately does NOT stop the script: a chatty loop should lose its
     * output, not be killed halfway through whatever it was doing to the gateway.</p>
     */
    static final class BoundedOutputStream extends Capture {
        private final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        private final int limit;
        private boolean truncated;

        BoundedOutputStream(int limit) {
            this.limit = limit;
        }

        @Override
        boolean truncated() {
            return truncated;
        }

        @Override
        String captured() {
            return buffer.toString(StandardCharsets.UTF_8);
        }

        @Override
        public synchronized void write(int b) {
            if (buffer.size() >= limit) {
                truncated = true;
                return;
            }
            buffer.write(b);
        }

        @Override
        public synchronized void write(byte[] b, int off, int len) {
            int remaining = limit - buffer.size();
            if (remaining <= 0) {
                truncated = true;
                return;
            }
            if (len > remaining) {
                truncated = true;
                buffer.write(b, off, remaining);
                return;
            }
            buffer.write(b, off, len);
        }
    }

    /**
     * Captures output up to the same cap, but hands it onward instead of keeping it.
     *
     * <h2>Why the decoder is stateful</h2>
     *
     * <p>A chunk boundary can fall in the middle of a multi-byte UTF-8 sequence —
     * printing a non-ASCII character exactly on the 4 KB mark is enough. Decoding
     * each chunk independently turns that character into two replacement glyphs,
     * permanently, because the bytes have already been sent. So the decoder is kept
     * across flushes and the trailing incomplete bytes are carried into the next
     * one.</p>
     *
     * <h2>Ordering</h2>
     *
     * <p>Everything is guarded by this object's monitor, so the execution thread's
     * writes and the scheduler's timed flushes cannot interleave within a stream.
     * Across the two streams there is no ordering guarantee and there never was —
     * Jython buffers them separately.</p>
     */
    static final class StreamingOutputStream extends Capture {
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();
        private final CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE);
        private final int limit;
        private final String streamName;
        private final OutputListener listener;
        private int written;
        private boolean truncated;

        StreamingOutputStream(int limit, String streamName, OutputListener listener) {
            this.limit = limit;
            this.streamName = streamName;
            this.listener = listener;
        }

        @Override
        boolean truncated() {
            return truncated;
        }

        /** Always empty: everything has already gone to the listener. */
        @Override
        String captured() {
            return "";
        }

        @Override
        public synchronized void write(int b) {
            if (written >= limit) {
                truncated = true;
                return;
            }
            written++;
            pending.write(b);
            if (b == '\n' || pending.size() >= FLUSH_AT_BYTES) {
                flushPending();
            }
        }

        @Override
        public synchronized void write(byte[] b, int off, int len) {
            int remaining = limit - written;
            if (remaining <= 0) {
                truncated = true;
                return;
            }
            int take = len;
            if (take > remaining) {
                truncated = true;
                take = remaining;
            }
            written += take;
            pending.write(b, off, take);
            // Scan for a newline rather than only checking the last byte: one
            // write() can carry several lines, and a caller that writes a whole
            // block at a time would otherwise wait for the timer every time.
            boolean newline = false;
            for (int i = off; i < off + take; i++) {
                if (b[i] == '\n') {
                    newline = true;
                    break;
                }
            }
            if (newline || pending.size() >= FLUSH_AT_BYTES) {
                flushPending();
            }
        }

        @Override
        synchronized void flushPending() {
            emit(false);
        }

        @Override
        synchronized void finish() {
            emit(true);
        }

        /**
         * Decode and hand over whatever is buffered.
         *
         * @param end true on the final flush, when trailing incomplete bytes must
         *            be turned into replacement characters rather than held back
         *            for a continuation that will never arrive
         */
        private void emit(boolean end) {
            if (pending.size() == 0 && !end) {
                return;
            }
            byte[] bytes = pending.toByteArray();
            pending.reset();
            ByteBuffer in = ByteBuffer.wrap(bytes);
            // Worst case one char per byte, plus room for the decoder's own flush.
            CharBuffer out = CharBuffer.allocate(bytes.length + 2);
            decoder.decode(in, out, end);
            if (end) {
                decoder.flush(out);
            }
            out.flip();
            // Bytes the decoder could not finish belong to the NEXT chunk.
            if (in.hasRemaining()) {
                pending.write(bytes, in.position(), in.remaining());
            }
            if (out.length() == 0) {
                return;
            }
            String text = out.toString();
            try {
                listener.onOutput(streamName, text);
            } catch (RuntimeException e) {
                // The listener is the transport. A dead socket must cost the user
                // their output, never their script.
                logger.debug("Output listener rejected a chunk: {}", e.toString());
            }
        }
    }
}
