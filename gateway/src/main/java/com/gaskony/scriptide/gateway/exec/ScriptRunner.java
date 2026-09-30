package com.gaskony.scriptide.gateway.exec;

import org.python.core.PyObject;

/**
 * The one thing {@link ExecutionService} needs from a script runner.
 *
 * <p>This interface exists as a TEST SEAM, and only for that. The real
 * implementation is {@link PrivateStateRunner}, whose private-{@code PySystemState}
 * design is load-bearing and must never be "simplified" — see its class Javadoc.
 * But the service's own behaviour (one execution per session, the stop ladder,
 * the timeout escalation) is about scheduling, not about Jython, and asserting it
 * against a real interpreter would mean a unit test that boots Jython, imports
 * the platform's module registry, and then races a busy loop. Behind an interface
 * the same behaviour is provable in milliseconds with a fake that spins on a
 * flag.</p>
 */
public interface ScriptRunner {

    /**
     * Called as output is produced, so a long run shows something before it ends.
     *
     * <p>Invoked on the execution thread (or, for the time-based flush, on the
     * scheduler that drives it), so an implementation must be quick and must not
     * throw — the listener is the transport, and a failing transport must not take
     * the user's script down with it.</p>
     */
    @FunctionalInterface
    interface OutputListener {
        /**
         * @param stream {@code "stdout"} or {@code "stderr"}
         * @param text   the chunk, already decoded; never empty
         */
        void onOutput(String stream, String text);
    }

    /**
     * Execute {@code source}, capturing its output.
     *
     * @param source   the code to run
     * @param fileName appears in every traceback frame — use a reversible token so
     *                 frames can be mapped back to an editor tab
     * @param locals   the locals map; pass the SAME one across calls for a console
     *                 session to behave like a REPL
     * @param listener where output goes as it is produced, or {@code null} to
     *                 accumulate it into the {@link PrivateStateRunner.Outcome}
     *                 instead. The two are exclusive by design: whatever has been
     *                 streamed is NOT repeated in the outcome, so a client that
     *                 renders both never double-prints.
     */
    PrivateStateRunner.Outcome run(String source, String fileName, PyObject locals,
                                   OutputListener listener);
}
