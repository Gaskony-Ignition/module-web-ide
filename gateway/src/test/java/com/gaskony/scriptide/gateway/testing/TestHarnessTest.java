package com.gaskony.scriptide.gateway.testing;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.python.core.CompilerFlags;
import org.python.core.ParserFacade;

import java.io.StringReader;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The harness is three constants, so what can be asserted about them is their
 * SHAPE — and every property here has cost this estate a release when it was
 * absent.
 *
 * <p>Since 1.21.0 the loop lives in {@code runner.py} and the helpers in
 * {@code scriptide.py}, so most of these assertions moved with it. The properties
 * did not change; where they are written did.</p>
 */
class TestHarnessTest {

    private static final String DRIVER = TestHarness.SOURCE;
    private static final String RUNNER = TestHarness.RUNNER_SOURCE;
    private static final String HELPERS = TestHarness.HELPER_SOURCE;

    /** Find something inside {@code runner.py}'s {@code run} function. */
    private static int inRun(String needle) {
        int start = RUNNER.indexOf("def run(");
        assertThat(start).as("runner.py defines run()").isGreaterThan(-1);
        int at = RUNNER.indexOf(needle, start);
        assertThat(at).as("run() contains " + needle).isGreaterThan(-1);
        return at;
    }

    @Test
    @DisplayName("all three sources parse as Jython 2.7")
    void parses() {
        // The one thing a constant can get catastrophically wrong. A syntax
        // error here fails every test run on the gateway with a traceback about
        // our own source, which reads as the user's script being at fault. The
        // two resources are Python 2 on purpose — `exec x in ns`, `except E as e`
        // — so a Python 3 parser is not the test either.
        ParserFacade.parseExpressionOrModule(
            new StringReader(DRIVER), "<driver>", new CompilerFlags());
        ParserFacade.parseExpressionOrModule(
            new StringReader(RUNNER), "<runner.py>", new CompilerFlags());
        ParserFacade.parseExpressionOrModule(
            new StringReader(HELPERS), "<scriptide.py>", new CompilerFlags());
    }

    @Test
    @DisplayName("the two resources are packaged, not empty")
    void resourcesArePresent() {
        // getResourceAsStream returning null is the packaging failure this estate
        // has already shipped once, in another module. It throws at class
        // initialisation now; this proves the file has content as well.
        assertThat(RUNNER).contains("def run(");
        assertThat(HELPERS).contains("def assertEquals(");
    }

    @Test
    @DisplayName("the driver defines no functions, because there is one namespace")
    void driverIsFlat() {
        // A `def` in the DRIVER would not see the module-level names it needs:
        // it executes with the locals map serving as globals too. See
        // PrivateStateRunner's two-dict note. The two resources are executed into
        // namespaces of their own, where `def` behaves normally.
        assertThat(DRIVER).doesNotContain("\ndef ");
        assertThat(DRIVER).doesNotContain("\nclass ");
    }

    @Test
    @DisplayName("nothing catches bare, so a Stop is not swallowed")
    void doesNotCatchBare() {
        // A Stop and the execution timeout arrive as a Java Error, which is a
        // Throwable and not an Exception. A bare `except:` would catch it and
        // calmly continue to the next test — a Stop button that appears to work
        // and does nothing.
        assertThat(DRIVER).doesNotContain("except:");
        assertThat(RUNNER).doesNotContain("except:");
        assertThat(HELPERS).doesNotContain("except:");
        assertThat(RUNNER).contains("except AssertionError");
        assertThat(RUNNER).contains("except Exception");
    }

    @Test
    @DisplayName("assertRaises suppresses only the class it was asked about")
    void assertRaisesLetsEverythingElseOut() {
        // Its __exit__ returns False for anything that is not a subclass of the
        // expected exception, which is what keeps a Stop reaching the runner
        // through a `with assertRaises(...)` block.
        int check = HELPERS.indexOf("if not issubclass(kind, self.expected):");
        assertThat(check).isGreaterThan(-1);
        assertThat(HELPERS.indexOf("return False", check)).isGreaterThan(check);
    }

    @Test
    @DisplayName("a mock never swallows what happened inside it")
    void mockExitReturnsFalse() {
        int swap = HELPERS.indexOf("class _Swap");
        assertThat(swap).isGreaterThan(-1);
        int exit = HELPERS.indexOf("def __exit__(self, kind, value, traceback):", swap);
        assertThat(exit).isGreaterThan(-1);
        assertThat(HELPERS.indexOf("return False", exit)).isGreaterThan(exit);
    }

    @Test
    @DisplayName("a mock refuses a namespace that is shared with the gateway")
    void mockRefusesASharedNamespace() {
        // The interlock. When the runner cannot read a module's source it imports
        // it instead, and what comes back is the gateway's own module object —
        // measured 07/09/2026, the same id() from two runs. Writing `system` into
        // that would change what every other script on the gateway sees.
        assertThat(HELPERS).contains("if not _active['private']:");
        assertThat(RUNNER).contains("_api._active['private'] = private");
    }

    @Test
    @DisplayName("afterEach runs in a finally, not only on success")
    void afterEachAlwaysRuns() {
        // A teardown that runs only when the test passed leaks exactly when it
        // matters, and the next test then fails for the previous one's reason.
        int call = inRun("target(*args)");
        int finallyAfter = RUNNER.indexOf("finally:", call);
        int afterEach = RUNNER.indexOf("hooks['afterEach']()", call);
        assertThat(finallyAfter).isGreaterThan(call);
        assertThat(afterEach).isGreaterThan(finallyAfter);
    }

    @Test
    @DisplayName("setUp and tearDown still bracket every test")
    void oldNamesStillWork() {
        // A project written against the previous runner must not stop working
        // because a decorator now exists.
        assertThat(RUNNER).contains("namespace.get('setUp')");
        assertThat(RUNNER).contains("namespace.get('tearDown')");
    }

    @Test
    @DisplayName("nothing redirects sys.stdout")
    void neverRedirectsStdout() {
        // Measured on 8.3.8, twice: with sys.stdout pointed at a StringIO, a
        // print inside a project library function reached neither the buffer nor
        // the execution's stream — it vanished. With no redirect at all the same
        // print streamed perfectly. The obvious implementation is the wrong one
        // and it fails silently, so the absence is asserted.
        assertThat(DRIVER).doesNotContain("_si_sys.stdout =");
        assertThat(RUNNER).doesNotContain("_sys.stdout =");
        assertThat(DRIVER).doesNotContain("StringIO");
        assertThat(RUNNER).doesNotContain("StringIO");
        assertThat(HELPERS).doesNotContain("StringIO");
    }

    @Test
    @DisplayName("every module is prepared before the first write to stdout")
    void preparesBeforeAnyOutput() {
        // Measured on 8.3.8: a write to sys.stdout followed by an import of a
        // project library module loses the WHOLE execution's output — the write,
        // everything after it, and the run still reports success. Two passes is
        // the fix, and it is invisible in the source unless something asserts it.
        int prepare = inRun("prepared[module] = _prepare(");
        int firstMark = inRun("_mark(marker");
        assertThat(firstMark).isGreaterThan(prepare);
    }

    @Test
    @DisplayName("the private system state is re-asserted after that pass")
    void reassertsSystemState() {
        // Without this, `print` writes to the gateway's own console from the
        // first project import onward and the test's output comes back empty —
        // silently, with the run reporting success. Explicit sys.stdout.write
        // keeps working throughout, which is exactly why the bug is invisible.
        int prepare = inRun("prepared[module] = _prepare(");
        int reassert = inRun("_reassert()");
        int firstMark = inRun("_mark(marker");
        assertThat(reassert).isGreaterThan(prepare);
        assertThat(firstMark).isGreaterThan(reassert);
        assertThat(RUNNER).contains("Py.setSystemState(_sys)");
    }

    @Test
    @DisplayName("a module that will not prepare is an error on every test in it")
    void prepareFailureIsPerTest() {
        // Reported per test rather than as one failure of the whole run: the
        // panel's row is where a reader looks for why a test did not pass.
        assertThat(RUNNER).contains("if resolveFailure is not None:");
        assertThat(RUNNER).contains("status = 'error'");
    }

    @Test
    @DisplayName("the test module is executed, and imported only as a fallback")
    void executesRatherThanImports() {
        // The whole reason mocking is safe here. See _prepare's docstring and the
        // 07/09/2026 measurement it records.
        int execAt = RUNNER.indexOf("exec code in namespace");
        assertThat(execAt).isGreaterThan(-1);
        int importAt = RUNNER.indexOf("__import__(module", execAt);
        assertThat(importAt).as("the import is the fallback, after the exec")
            .isGreaterThan(execAt);
    }

    @Test
    @DisplayName("the driver flushes its own streams before it ends")
    void flushesItself() {
        // Jython buffers sys.stdout and the runner's tail-flush does not reach
        // that buffer on a batch run. Without these the capture is empty.
        assertThat(DRIVER).contains("_si_sys.stdout.flush()");
        assertThat(DRIVER).contains("_si_sys.stderr.flush()");
        assertThat(DRIVER.indexOf("_si_sys.stdout.flush()"))
            .isGreaterThan(DRIVER.indexOf(TestHarness.VAR_RESULT + " = "));
    }

    @Test
    @DisplayName("a begin and an end marker are written around every test")
    void writesMarkers() {
        assertThat(RUNNER).contains("_mark(marker, '>' + identifier)");
        assertThat(RUNNER).contains("_mark(marker, '<')");
    }

    @Test
    @DisplayName("the end marker is written after the except clauses, so a failure still closes")
    void endMarkerFollowsTheHandlers() {
        int handler = inRun("except Exception as error:");
        int end = RUNNER.indexOf("_mark(marker, '<')", handler);
        assertThat(end).isGreaterThan(handler);
    }

    @Test
    @DisplayName("the tests and their sources are seeded, never formatted into source")
    void nothingIsConcatenated() {
        // A module called `x'); import os; os.system('` is a name Ignition
        // accepts. The only defence that survives a later edit is that the specs
        // and the sources arrive as data.
        assertThat(DRIVER).contains(TestHarness.VAR_TESTS);
        assertThat(DRIVER).contains(TestHarness.VAR_SOURCES);
        assertThat(DRIVER).doesNotContain("%s");
        assertThat(DRIVER).doesNotContain(".format(");
        // The one thing compiled from a variable is the module's own source, and
        // it is compiled into a namespace rather than spliced into a program.
        assertThat(RUNNER).contains("code = compile(source,");
        assertThat(RUNNER).doesNotContain("eval(");
    }

    @Test
    @DisplayName("the helper module is seeded before anything imports it")
    void seedsTheHelperModule() {
        int seed = DRIVER.indexOf("_si_sys.modules['" + TestHarness.HELPER_MODULE + "']");
        int runner = DRIVER.indexOf(TestHarness.VAR_RUNNER_SOURCE);
        assertThat(seed).isGreaterThan(-1);
        assertThat(runner).isGreaterThan(seed);
        // runner.py imports it, so the order above is what makes that resolve.
        assertThat(RUNNER).contains("import scriptide as _api");
    }

    @Test
    @DisplayName("both resources are executed with the run's own builtins")
    void handsOnThePrivateBuiltins() {
        // The per-run copy whose __import__ restores the thread's system state.
        // A test module executed with anything else loses every line of output
        // after its first project-library import — the 1.19.0 defect by another
        // door.
        assertThat(DRIVER).contains("_si_api.__dict__['__builtins__'] = __builtins__");
        assertThat(DRIVER).contains("_si_runner['__builtins__'] = __builtins__");
        assertThat(RUNNER).contains("'__builtins__': __builtins__");
    }

    @Test
    @DisplayName("it leaves its result under the name the handler reads")
    void publishesTheResult() {
        assertThat(DRIVER).contains(TestHarness.VAR_RESULT + " = ");
        assertThat(DRIVER).contains("'results'");
    }

    @Test
    @DisplayName("attribute() gives each test the text between its own markers")
    void attributesOutput() {
        String m = "nonce";
        String streamed = "preamble\n"
            + m + ">a.test_one\n" + "first line\nsecond line\n" + m + "<\n"
            + m + ">a.test_two\n" + "only mine\n" + m + "<\n";

        var byId = TestHarness.attribute(streamed, m);
        assertThat(byId).containsEntry("a.test_one", "first line\nsecond line\n");
        assertThat(byId).containsEntry("a.test_two", "only mine\n");
    }

    @Test
    @DisplayName("text outside any test's markers belongs to nobody")
    void dropsUnattributedText() {
        // The harness's own bookkeeping, and a module's import-time output.
        // Attributing either would put a line in a record the test did not write.
        String m = "nonce";
        var byId = TestHarness.attribute(
            "loose text\n" + m + ">a.test_one\n" + "mine\n" + m + "<\nafterwards\n", m);
        assertThat(byId).hasSize(1);
        assertThat(byId.get("a.test_one")).isEqualTo("mine\n");
    }

    @Test
    @DisplayName("attribute() is safe on nothing at all")
    void attributeHandlesEmpty() {
        assertThat(TestHarness.attribute(null, "m")).isEmpty();
        assertThat(TestHarness.attribute("", "m")).isEmpty();
        assertThat(TestHarness.attribute("text", null)).isEmpty();
        assertThat(TestHarness.attribute("text with no markers", "m")).isEmpty();
    }

    @Test
    @DisplayName("a test that runs twice keeps both lots of output")
    void mergesRepeatedIds() {
        String m = "nonce";
        var byId = TestHarness.attribute(
            m + ">a.t\n" + "one\n" + m + "<\n" + m + ">a.t\n" + "two\n" + m + "<\n", m);
        assertThat(byId.get("a.t")).isEqualTo("one\ntwo\n");
    }

    @Test
    @DisplayName("every status the panel renders is one the runner can emit")
    void emitsTheFourStatuses() {
        assertThat(RUNNER).contains("'pass'");
        assertThat(RUNNER).contains("'fail'");
        assertThat(RUNNER).contains("'error'");
        assertThat(RUNNER).contains("'skip'");
    }

    @Test
    @DisplayName("a timeout is a budget applied after the fact, and says so")
    void timeoutIsABudget() {
        // It cannot be an interrupt: stopping a running Jython call needs the
        // mechanism that stops the whole execution. An existing failure is left
        // alone, because it is the more useful of the two facts.
        assertThat(RUNNER).contains("budget is not None and status == 'pass'");
        assertThat(HELPERS).contains("A time BUDGET for one test, not an interrupt.");
    }

    @Test
    @DisplayName("the helpers a test module imports are all exported")
    void everyHelperIsExported() {
        // __all__ is what `from scriptide import *` gives, and what the panel's
        // one-line example implies is there.
        for (String name : new String[] {
            "test", "skip", "timeout", "cases",
            "beforeAll", "afterAll", "beforeEach", "afterEach",
            "assertEquals", "assertNotEquals", "assertTrue", "assertFalse",
            "assertNone", "assertNotNone", "assertIn", "assertNotIn",
            "assertAlmostEquals", "assertRaises", "assertTagValue", "assertDbRowCount",
            "mockTags", "mockQuery"}) {
            assertThat(HELPERS).as("__all__ lists " + name).contains("'" + name + "'");
        }
    }

    @Test
    @DisplayName("the import line the panel shows names things that exist")
    void theAdvertisedImportResolves() {
        String prefix = "from scriptide import ";
        assertThat(TestHarness.HELPER_IMPORT).startsWith(prefix);
        for (String name : TestHarness.HELPER_IMPORT.substring(prefix.length()).split(",")) {
            assertThat(HELPERS).contains("'" + name.trim() + "'");
        }
    }

    @Test
    @DisplayName("an unmocked tag read raises rather than answering None")
    void anUnmockedReadIsLoud() {
        // A mock that quietly answers None for a path nobody set turns a missing
        // fixture into a puzzling assertion failure three lines further down.
        assertThat(HELPERS).contains("mockTags has no value for %s");
        assertThat(HELPERS).contains("mockQuery has no answer for this query");
    }
}
