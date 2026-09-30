package com.gaskony.scriptide.gateway.testing;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * What the gateway executes to run a project's tests.
 *
 * <p>Three pieces: a flat driver held here as a constant, and two Jython source
 * files carried as resources — {@code scriptide.py}, the helpers a test module
 * imports, and {@code runner.py}, the loop. The driver seeds the first into
 * {@code sys.modules} and executes the second.</p>
 *
 * <h2>Nothing the user typed is concatenated into any of it</h2>
 *
 * <p>The selected tests arrive as a LIST seeded into the execution's namespace,
 * and each test module's source arrives as a DICT beside it. A module called
 * {@code x'); import os; os.system('} is a name Ignition will accept, and the
 * only defence that keeps working when somebody adds a feature later is that
 * there is no string formatting in this path at all.</p>
 *
 * <h2>Why the driver is written flat</h2>
 *
 * <p>No {@code def}, anywhere in {@link #SOURCE}. This module executes a script
 * with ONE namespace serving as both locals and globals — see the two-dict trap
 * recorded in {@code PrivateStateRunner} — and a function body defined here would
 * not see the module-level names it needs. The loop that needs functions lives in
 * {@code runner.py}, which is executed into a namespace of its own where
 * {@code def} behaves normally.</p>
 *
 * <h2>The private builtins table is handed on, and that is load-bearing</h2>
 *
 * <p>Both files are executed with the driver's own {@code __builtins__}, which is
 * the per-run copy whose {@code __import__} restores the thread's system state
 * (see {@code PrivateStateRunner.installImportHook}). A test module executed with
 * anything else would move the thread onto the platform's state on its first
 * project-library import and lose every subsequent line of output — the 1.19.0
 * defect, reached by a different door.</p>
 *
 * <h2>Four outcomes, and the difference between two of them matters</h2>
 *
 * <ul>
 *   <li>{@code pass} — the function returned.</li>
 *   <li>{@code fail} — it raised {@code AssertionError}. The test ran and the
 *       thing it asserts is not true.</li>
 *   <li>{@code error} — it raised anything else. The test did not get far enough
 *       to have an opinion, and the first one of these usually explains the rest.
 *       A runner that reported both as "failed" would send you to read an
 *       assertion that never executed.</li>
 *   <li>{@code skip} — it carries {@code @skip} and was not called.</li>
 * </ul>
 *
 * <h2>A Stop is not caught</h2>
 *
 * <p>The handlers are {@code except AssertionError} and {@code except Exception},
 * never a bare {@code except:}. A Stop, and the execution timeout that uses the
 * same mechanism, arrive as a Java {@code Error} — which is a {@code Throwable}
 * and not an {@code Exception}, so it passes straight through the loop and ends
 * the run, exactly as it does in the console. A bare {@code except:} would swallow
 * it and calmly carry on to the next test, which is how a Stop button comes to do
 * nothing while appearing to work. {@code assertRaises} obeys the same rule: its
 * {@code __exit__} suppresses only the class it was asked about.</p>
 *
 * <h2>Each test's output is its own — and NOT by swapping {@code sys.stdout}</h2>
 *
 * <p>The obvious implementation is to point {@code sys.stdout} at a
 * {@code StringIO} around each call. <b>It does not work, it fails silently, and
 * that was measured on 8.3.8 rather than reasoned about.</b> A {@code print}
 * inside a PROJECT LIBRARY function does not consult the {@code sys.stdout} the
 * calling script can see: with the swap in place the text reached neither the
 * buffer nor the execution's stream — it vanished — and with no swap at all the
 * same print streamed perfectly.</p>
 *
 * <p>So nothing is redirected. The runner writes a MARKER around each test on the
 * ordinary stream, and the Java side splits the streamed output on those markers
 * to attribute it. The marker carries a per-run nonce generated in Java, so a test
 * that prints something marker-shaped cannot forge a boundary.</p>
 *
 * <h2>Two passes, a re-assert and a flush — all three measured, all three needed</h2>
 *
 * <p>Getting a test's own output back took three separate findings on 8.3.8, and
 * each of them fails SILENTLY: the run reports success and the output is simply
 * gone. They live in {@code runner.py} and in the tail of {@link #SOURCE}, and the
 * obvious edit to any one of them puts the bug straight back.</p>
 *
 * <ol>
 *   <li><b>Every module is prepared in pass one, before any output.</b> Writing to
 *       {@code sys.stdout} and then importing a project library module loses the
 *       whole execution's output — not just the buffered write, everything after
 *       it too.</li>
 *   <li><b>The private state is re-asserted after that pass.</b> Loading a
 *       project library module leaves the THREAD's {@code PySystemState} pointing
 *       at the platform's, so the run's {@code sys} would be the platform's from
 *       then on.</li>
 *   <li><b>The driver flushes its own streams at the end.</b> Jython buffers
 *       {@code sys.stdout}; on this path the runner's tail-flush does not reach
 *       that buffer, and without an explicit flush the capture came back
 *       completely empty. The script console never showed any of this, because a
 *       socket run has a periodic pump and a batch run does not.</li>
 * </ol>
 *
 * <p>The cost, stated because it is real: attribution is positional, so anything a
 * BACKGROUND thread a test started prints after that test ends is attributed to
 * whichever test is running then. A test that leaves threads behind has a bigger
 * problem than its output labelling.</p>
 */
public final class TestHarness {

    private TestHarness() { /* constant holder */ }

    /** The list of {@code [module, class, function, id]} entries to run. */
    public static final String VAR_TESTS = "_scriptide_test_specs";

    /**
     * {@code {module name: source}} for every module holding a selected test.
     *
     * <p>The runner executes these rather than importing them, which is what makes
     * the namespace private to the run — see {@code runner.py}. A module missing
     * from this dict is imported instead, and a mock inside it then refuses rather
     * than writing into the gateway's shared copy.</p>
     */
    public static final String VAR_SOURCES = "_scriptide_test_sources";

    /** Where the JSON result is left for the handler to read. */
    public static final String VAR_RESULT = "_scriptide_test_result";

    /**
     * The per-run boundary marker, generated in Java and seeded as data.
     *
     * <p>A nonce rather than a constant: a test that printed a fixed marker
     * could otherwise split its own output across two other tests' records, and
     * the result would look like a bug in whichever test it landed in.</p>
     */
    public static final String VAR_MARKER = "_scriptide_test_marker";

    /** The module name a test file imports the helpers from. */
    public static final String HELPER_MODULE = "scriptide";

    /** The import line the panel shows, so the helpers are discoverable at all. */
    public static final String HELPER_IMPORT =
        "from scriptide import test, assertEquals, mockTags";

    /** {@code scriptide.py} — the helpers a test module imports. */
    public static final String HELPER_SOURCE = load("scriptide.py");

    /** {@code runner.py} — the loop, executed into a namespace of its own. */
    public static final String RUNNER_SOURCE = load("runner.py");

    /**
     * Read one of the Jython resources, or fail at class initialisation.
     *
     * <p>Loudly, because the alternative is a module that builds, signs, installs
     * and then cannot run a test — the failure class already recorded for this
     * estate, where a green build shipped a {@code .modl} missing a file nobody
     * had asserted was in it. {@code ModuleJarPackagingTest} asserts both are
     * present in the built artefact for the same reason.</p>
     */
    private static String load(String name) {
        try (InputStream in = TestHarness.class.getResourceAsStream(name)) {
            if (in == null) {
                throw new IllegalStateException(
                    "The Web IDE test resource " + name + " is not on the classpath. "
                        + "The module was packaged without it.");
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Could not read the test resource " + name, e);
        }
    }

    /**
     * The driver, as one flat script.
     *
     * <p>It seeds the helper module, executes the runner, and leaves the result as
     * JSON. Everything with a {@code def} in it is in the two resources.</p>
     */
    public static final String SOURCE = String.join("\n",
        "import sys as _si_sys",
        "import json as _si_json",
        "import imp as _si_imp",
        "",
        // The helpers, as a real module in sys.modules, so a test module's
        // `from scriptide import ...` resolves without touching disk. sys.modules
        // here is the run's own COPY of the manager's map (see
        // PrivateStateRunner.applyModuleRegistry), so this does not add a module
        // to the gateway: it is gone when the run ends.
        "_si_api = _si_imp.new_module('" + HELPER_MODULE + "')",
        "_si_api.__dict__['__builtins__'] = __builtins__",
        "exec compile(_si_helper_source, '<scriptide:scriptide.py>', 'exec') "
            + "in _si_api.__dict__",
        "_si_sys.modules['" + HELPER_MODULE + "'] = _si_api",
        "",
        // The runner, in a namespace of its own so its `def`s behave normally.
        // __builtins__ is handed on deliberately: it is the per-run copy whose
        // __import__ restores the thread's system state.
        "_si_runner = {}",
        "_si_runner['__name__'] = '_scriptide_runner'",
        "_si_runner['__builtins__'] = __builtins__",
        "exec compile(_si_runner_source, '<scriptide:runner.py>', 'exec') in _si_runner",
        "",
        // globals(), not a bare name: a gateway that hands out no `system` should
        // run the tests and let them fail on their own terms, not fail to start.
        "_si_system = globals().get('system')",
        "_si_results = _si_runner['run'](" + VAR_TESTS + ", " + VAR_SOURCES + ", "
            + VAR_MARKER + ", _si_system)",
        VAR_RESULT + " = _si_json.dumps({'results': _si_results})",
        // FLUSH FROM INSIDE. Jython buffers sys.stdout, and the runner's own
        // tail-flush does not reach this buffer on this path: without these two
        // lines the capture came back completely empty while the run reported
        // success. The console never showed the problem, because a socket run
        // has a periodic pump and this one does not.
        "_si_sys.stdout.flush()",
        "_si_sys.stderr.flush()",
        "");

    /** Where {@link #HELPER_SOURCE} is seeded for {@link #SOURCE} to compile. */
    public static final String VAR_HELPER_SOURCE = "_si_helper_source";

    /** Where {@link #RUNNER_SOURCE} is seeded for {@link #SOURCE} to compile. */
    public static final String VAR_RUNNER_SOURCE = "_si_runner_source";

    /**
     * Split streamed output into what each test produced.
     *
     * <p>Text before the first marker, or between an end marker and the next
     * begin, belongs to no test and is dropped: it is the harness's own
     * bookkeeping or a module's import-time output, and attributing either to a
     * test would put a line in a record the test did not write.</p>
     *
     * @param streamed everything the execution wrote, in arrival order
     * @param marker   the nonce handed to the harness for this run
     */
    public static java.util.Map<String, String> attribute(String streamed, String marker) {
        java.util.Map<String, String> out = new java.util.LinkedHashMap<>();
        if (streamed == null || streamed.isEmpty() || marker == null || marker.isEmpty()) {
            return out;
        }
        String[] parts = streamed.split(java.util.regex.Pattern.quote(marker), -1);
        // parts[0] is whatever preceded the first marker.
        for (int i = 1; i < parts.length; i++) {
            String chunk = parts[i];
            if (chunk.isEmpty() || chunk.charAt(0) != '>') {
                continue;       // an end marker, or a fragment we cannot place
            }
            int newline = chunk.indexOf('\n');
            String id = newline < 0 ? chunk.substring(1) : chunk.substring(1, newline);
            String body = newline < 0 ? "" : chunk.substring(newline + 1);
            // merge, not put: an id can legitimately appear twice, and losing
            // the first occurrence's output would be a silent hole.
            out.merge(id, body, String::concat);
        }
        return out;
    }
}
