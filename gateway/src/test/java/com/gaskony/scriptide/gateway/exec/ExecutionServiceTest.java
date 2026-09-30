package com.gaskony.scriptide.gateway.exec;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.PyObject;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The defect this class exists to prevent: a run that deafens the connection.
 *
 * <p>Measured on 1.4.3 — a Stop sent 1.5 s into a 20 s busy loop did nothing,
 * because {@code execute()} blocked the socket thread and the Stop frame was not
 * READ until the loop had already finished. Everything asserted here is about
 * that: {@link ExecutionService#submit} returns while the script is still
 * running, and a stop requested from the calling thread lands on it.</p>
 *
 * <p>No Jython. The scheduling behaviour has nothing to do with an interpreter,
 * and booting one to race a busy loop would make these tests slow and flaky for
 * no extra coverage — hence the {@link ScriptRunner} seam.</p>
 */
class ExecutionServiceTest {

    /**
     * Named so {@code PrivateStateRunner.isCancellation} recognises it.
     *
     * <p>That match is on the class NAME ("ScriptCanceled"), because the real
     * {@code ScriptManager.ScriptCanceledError} is not public SDK surface. Using a
     * name that matches means the production cancellation path runs here rather
     * than being simulated by handing back a pre-made cancelled outcome.</p>
     */
    static final class ScriptCanceledErrorStub extends Error {
        private static final long serialVersionUID = 1L;
    }

    /** A script that spins until the stop ladder reaches it. */
    static final class SpinRunner implements ScriptRunner {
        final CountDownLatch entered = new CountDownLatch(1);
        volatile boolean interrupted;

        @Override
        public PrivateStateRunner.Outcome run(String source, String fileName, PyObject locals,
                                              OutputListener listener) {
            entered.countDown();
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
            while (!interrupted) {
                if (System.nanoTime() > deadline) {
                    // A test must not spin for ever if the stop never lands; the
                    // assertion below then fails on the outcome rather than hanging.
                    return new PrivateStateRunner.Outcome("", "", false, null, false);
                }
                Thread.onSpinWait();
            }
            throw new ScriptCanceledErrorStub();
        }
    }

    private static ExecutionService serviceFor(SpinRunner runner) {
        // The interrupter stands in for ScriptManager.interrupt, which does nothing
        // useful outside a Gateway. Everything after it — the 5 s thread interrupt,
        // the 30 s abandon — is the shipped ladder, untouched.
        return new ExecutionService(project -> runner, tid -> runner.interrupted = true);
    }

    @Test
    @DisplayName("submit returns while the script is still running, and Stop then lands")
    void submitDoesNotBlockAndStopWorks() throws Exception {
        SpinRunner runner = new SpinRunner();
        ExecutionService service = serviceFor(runner);
        try {
            CompletableFuture<PrivateStateRunner.Outcome> done = new CompletableFuture<>();
            CountDownLatch started = new CountDownLatch(1);

            long before = System.nanoTime();
            service.submit("e1", "P", "while True: pass", "<f>", null, "u", "s1",
                started::countDown, (stream, text) -> { }, done::complete);
            long submitMillis = (System.nanoTime() - before) / 1_000_000;

            // THE assertion. A blocking execute() would not come back for 20 s.
            assertThat(submitMillis).as("submit blocked the caller").isLessThan(1_000);
            assertThat(runner.entered.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(done).as("finished before the script did").isNotDone();

            // Stop from the CALLING thread — which on a gateway is the socket
            // thread, the very thread 1.4.3 had parked inside execute().
            assertThat(service.requestStop("e1")).contains("Stopping");

            PrivateStateRunner.Outcome outcome = done.get(5, TimeUnit.SECONDS);
            assertThat(outcome.cancelled()).isTrue();
            assertThat(outcome.succeeded()).isFalse();
            // Well under the 60 s default timeout and the 5 s escalation: the
            // Jython interrupt did it, not the ladder's later rungs.
            assertThat(service.runningCount()).isZero();
        } finally {
            service.shutdown();
        }
    }

    @Test
    @DisplayName("a session may only have one script in flight")
    void refusesASecondRunOnTheSameSession() throws Exception {
        SpinRunner runner = new SpinRunner();
        ExecutionService service = serviceFor(runner);
        try {
            CompletableFuture<PrivateStateRunner.Outcome> done = new CompletableFuture<>();
            service.submit("e1", "P", "spin", "<f>", null, "u", "s1",
                () -> { }, (stream, text) -> { }, done::complete);
            assertThat(runner.entered.await(5, TimeUnit.SECONDS)).isTrue();

            assertThatThrownBy(() -> service.submit("e2", "P", "spin", "<f>", null, "u", "s1",
                () -> { }, (stream, text) -> { }, o -> { }))
                .isInstanceOf(ExecutionService.RejectedException.class)
                .hasMessageContaining("already have a script running");

            // The refusal must not have consumed the slot of the run that WAS
            // accepted — that would leave the session unable to start anything.
            service.requestStop("e1");
            assertThat(done.get(5, TimeUnit.SECONDS).cancelled()).isTrue();
        } finally {
            service.shutdown();
        }
    }

    @Test
    @DisplayName("closing a socket stops what that session was running")
    void stopAllForStopsTheSessionsRun() throws Exception {
        SpinRunner runner = new SpinRunner();
        ExecutionService service = serviceFor(runner);
        try {
            CompletableFuture<PrivateStateRunner.Outcome> done = new CompletableFuture<>();
            service.submit("e1", "P", "spin", "<f>", null, "u", "s1",
                () -> { }, (stream, text) -> { }, done::complete);
            assertThat(runner.entered.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(service.isRunning("e1")).isTrue();

            service.stopAllFor("s1");

            assertThat(done.get(5, TimeUnit.SECONDS).cancelled()).isTrue();
        } finally {
            service.shutdown();
        }
    }

    @Test
    @DisplayName("output reaches the listener as the script produces it")
    void streamsOutputThroughTheListener() throws Exception {
        StringBuilder seen = new StringBuilder();
        CompletableFuture<PrivateStateRunner.Outcome> done = new CompletableFuture<>();
        ScriptRunner chatty = (source, fileName, locals, listener) -> {
            listener.onOutput("stdout", "0\n");
            listener.onOutput("stdout", "1\n");
            return new PrivateStateRunner.Outcome("", "", false, null, false);
        };
        ExecutionService service = new ExecutionService(project -> chatty, tid -> { });
        try {
            service.submit("e1", "P", "print", "<f>", null, "u", "s1", () -> { },
                (stream, text) -> seen.append(stream).append(':').append(text),
                done::complete);
            assertThat(done.get(5, TimeUnit.SECONDS).succeeded()).isTrue();
            assertThat(seen.toString()).isEqualTo("stdout:0\nstdout:1\n");
        } finally {
            service.shutdown();
        }
    }
}
