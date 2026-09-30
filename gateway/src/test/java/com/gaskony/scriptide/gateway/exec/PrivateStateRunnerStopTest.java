package com.gaskony.scriptide.gateway.exec;

import com.inductiveautomation.ignition.common.script.ScriptManager;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompileMode;
import org.python.core.CompilerFlags;
import org.python.core.Py;
import org.python.core.PyCode;
import org.python.core.PyFrame;
import org.python.core.PyObject;
import org.python.core.PyStringMap;
import org.python.core.PySystemState;
import org.python.core.ThreadState;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The defect this class exists to prevent: a Stop that poisons its pool thread.
 *
 * <p>Measured on 1.5.0 — after one run was stopped, every later run on the same
 * pool thread came back {@code cancelled} with no output and no error, because
 * the stopped frame was still the thread's current frame with the
 * {@code BreakTraceFunction} attached. Two Stops took half the pool.</p>
 *
 * <p>The stop is the real {@code ScriptManager.interrupt}, not a stub — the
 * poisoning lives in how Jython unwinds from that trace function, and a Java
 * throw would not reproduce it. The run is {@code Py.runCode} as
 * {@link PrivateStateRunner#run} calls it; the runner itself cannot boot here
 * because {@code createUtf8PySystemState} needs the Python stdlib and the
 * {@code jython-ia} jar carries none. What this level can see is the state the
 * stop leaves behind; the cancelled next run was measured on the gateway and is
 * covered by the live exec suite (a Stop followed by a REPL run on the same
 * thread).</p>
 */
class PrivateStateRunnerStopTest {

    private static ExecutorService oneThread;

    @BeforeAll
    static void boot() {
        PySystemState.initialize();
        oneThread = Executors.newSingleThreadExecutor(r -> new Thread(r, "stop-test-exec"));
    }

    @AfterAll
    static void halt() {
        oneThread.shutdownNow();
    }

    @Test
    @DisplayName("with the snapshot restored, a run after a stopped run on the same thread completes")
    void restoreClearsThePoison() throws Throwable {
        stopOneRun(true);
        PyObject locals = runOnWorker("result = 1 + 1", true);
        assertThat(locals.__finditem__("result")).as("the next run executed").isNotNull();
        assertThat(locals.__finditem__("result").asInt()).isEqualTo(2);

        Object[] state = oneThread.submit(() -> {
            ThreadState ts = Py.getThreadState();
            return new Object[] {ts.frame, ts.tracefunc};
        }).get(5, TimeUnit.SECONDS);
        assertThat(state[0]).as("stale frame left on the thread").isNull();
        assertThat(state[1]).as("stale trace function left on the thread").isNull();
    }

    @Test
    @DisplayName("without it, the stopped frame stays current with the trace function attached — the defect")
    void withoutRestoreTheThreadIsPoisoned() throws Throwable {
        stopOneRun(false);
        try {
            Object[] state = oneThread.submit(() -> {
                ThreadState ts = Py.getThreadState();
                return new Object[] {ts.frame, ts.frame == null ? null : ts.frame.tracefunc};
            }).get(5, TimeUnit.SECONDS);
            // Should either of these ever fail, Jython has started popping the
            // frame itself and the snapshot has become belt and braces — worth
            // knowing, so say so rather than staying silent.
            assertThat(state[0]).as("Jython no longer leaves the stopped frame current").isNotNull();
            assertThat(state[1]).as("the stop's trace function is still attached").isNotNull();
            assertThat(state[1].getClass().getName()).contains("BreakTraceFunction");
        } finally {
            // Leave the shared worker clean for whichever test runs next.
            oneThread.submit(() -> PrivateStateRunner.FrameSnapshot
                .of(new ThreadState(Py.getSystemState())).restore(Py.getThreadState()))
                .get(5, TimeUnit.SECONDS);
        }
    }

    /** Runs a busy loop on the worker, stops it with the real interrupt, returns when it has ended. */
    private static void stopOneRun(boolean restore) throws Exception {
        AtomicLong tid = new AtomicLong();
        Future<Throwable> spinning = oneThread.submit(() -> {
            tid.set(Thread.currentThread().getId());
            try {
                runOnThisThread("while True: pass", new PyStringMap(), restore);
                return null;
            } catch (Throwable t) {
                return t;
            }
        });
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (tid.get() == 0 || !hasFrame(tid.get())) {
            assertThat(System.nanoTime()).as("loop never started").isLessThan(deadline);
            Thread.sleep(20);
        }
        ScriptManager.interrupt(tid.get());
        Throwable ended = spinning.get(15, TimeUnit.SECONDS);
        assertThat(ended).as("the Stop landed").isNotNull();
        assertThat(PrivateStateRunner.isCancellation(ended)).isTrue();
    }

    private static PyObject runOnWorker(String source, boolean restore) throws Throwable {
        PyStringMap locals = new PyStringMap();
        Future<Throwable> done = oneThread.submit(() -> {
            try {
                runOnThisThread(source, locals, restore);
                return null;
            } catch (Throwable t) {
                return t;
            }
        });
        Throwable t = done.get(15, TimeUnit.SECONDS);
        if (t != null) {
            throw t;
        }
        return locals;
    }

    /** {@link PrivateStateRunner#run}'s execution step, with the snapshot optional. */
    private static void runOnThisThread(String source, PyObject locals, boolean restore) {
        ThreadState ts = Py.getThreadState();
        PrivateStateRunner.FrameSnapshot before = PrivateStateRunner.FrameSnapshot.of(ts);
        try {
            PyCode code = Py.compile_flags(source, "<console>", CompileMode.exec, new CompilerFlags());
            Py.runCode(code, locals, new PyStringMap());
        } finally {
            if (restore) {
                before.restore(ts);
            }
        }
    }

    private static boolean hasFrame(long tid) {
        PyObject frame = PySystemState._current_frames().__finditem__(Py.newLong(tid));
        return frame instanceof PyFrame;
    }
}
