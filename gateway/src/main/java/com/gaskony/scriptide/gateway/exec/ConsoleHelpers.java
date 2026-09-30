package com.gaskony.scriptide.gateway.exec;

import org.python.core.CompileMode;
import org.python.core.CompilerFlags;
import org.python.core.Py;
import org.python.core.PyCode;
import org.python.core.PyObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * {@code cprint} and {@code jsonPrint}, seeded into every execution namespace.
 *
 * <h2>Where they exist, and where they must not</h2>
 *
 * <p>In the namespace this module builds for an execution — the script console
 * and a test run — and nowhere else. They are not a script library: a helper
 * ordinary gateway code could reach would be a second library nobody
 * administers, and the same rule keeps the test helpers out of everything but a
 * run.</p>
 *
 * <h2>Why the compile happens here and not per run</h2>
 *
 * <p>The console's namespace is created once per project per session and then
 * reused, so this runs once. A test run gets a fresh one, which is two function
 * definitions — cheaper than the module-registry copy that surrounds it.</p>
 *
 * <h2>Failure is never fatal</h2>
 *
 * <p>If the resource is missing or will not compile, the namespace comes back
 * WITHOUT the helpers and the run proceeds. A console that will not open because
 * a printing convenience did not load would be a poor trade, and the log line
 * says which.</p>
 */
public final class ConsoleHelpers {

    private static final Logger logger = LoggerFactory.getLogger(ConsoleHelpers.class);

    private ConsoleHelpers() { /* constant holder */ }

    /** The names this installs, for anything that wants to say so. */
    public static final String[] NAMES = {"cprint", "jsonPrint"};

    /** {@code console.py}, read once at class initialisation. */
    public static final String SOURCE = load();

    private static String load() {
        try (InputStream in = ConsoleHelpers.class.getResourceAsStream("console.py")) {
            if (in == null) {
                throw new IllegalStateException(
                    "The Web IDE resource console.py is not on the classpath. "
                        + "The module was packaged without it.");
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not read console.py", e);
        }
    }

    /**
     * Define the helpers in one namespace.
     *
     * <p>One dict for globals and locals, as everything else in this module does
     * — see the two-dict trap in {@link PrivateStateRunner}. A function defined
     * with a separate locals map would not see the module-level names it needs,
     * and {@code jsonPrint} needs {@code _scriptide_sgr}'s neighbours.</p>
     *
     * <p>The functions resolve {@code print} when they are CALLED, not now, so
     * they write to whichever system state the run is on rather than to the one
     * this compile happened under. That is the whole reason they are Python.</p>
     */
    public static void install(PyObject namespace) {
        if (namespace == null) {
            return;
        }
        try {
            PyCode code = Py.compile_flags(SOURCE, "<scriptide:console.py>",
                CompileMode.exec, new CompilerFlags());
            Py.runCode(code, namespace, namespace);
        } catch (RuntimeException e) {
            logger.warn("Could not install the console helpers ({}); cprint and jsonPrint "
                + "will not be available in this namespace.", e.toString());
        }
    }
}
