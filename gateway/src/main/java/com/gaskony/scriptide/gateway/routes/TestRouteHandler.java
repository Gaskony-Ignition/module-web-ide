package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.exec.ExecutionService;
import com.gaskony.scriptide.gateway.exec.PrivateStateRunner;
import com.gaskony.scriptide.gateway.exec.TracebackFormatter;
import com.gaskony.scriptide.gateway.lang.ModuleSymbols;
import com.gaskony.scriptide.gateway.lang.ProjectIndex;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.gaskony.scriptide.gateway.testing.TestDiscovery;
import com.gaskony.scriptide.gateway.testing.TestHarness;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import jakarta.servlet.http.HttpServletResponse;
import org.python.core.Py;
import org.python.core.PyObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * Find a project's tests, and run them on the gateway.
 *
 * <h2>Why this exists at all</h2>
 *
 * <p>Nothing in Ignition offers a test runner, and the reason people do not
 * write Jython tests is not that they do not want to — it is that running one
 * means pasting it into a console and reading the output. The isolated
 * execution primitive this module already has is the only correct place in the
 * estate to run one from: a private interpreter state per execution, a bounded
 * pool, a timeout, a Stop, and an audit line.</p>
 *
 * <h2>Running a test is running arbitrary code, and is gated as such</h2>
 *
 * <p>Discovery is a read and takes the authenticated gate. The RUN takes the
 * gateway-write gate, re-checks {@code ExecPolicy} per request exactly as the
 * exec socket does, goes through {@code ExecutionService}, and writes an audit
 * line before it starts. A test that calls {@code system.tag.writeBlocking} is
 * a tag write; the runner does not get to pretend otherwise because the
 * function's name begins with {@code test_}.</p>
 *
 * <h2>One execution for the whole run</h2>
 *
 * <p>Not one per test, and that is a decision with a cost. All the selected
 * tests share one interpreter state, so a module imported by the first is the
 * same object the fifth sees — which is what every other test runner does, and
 * what makes module-level state behave the way people expect. It also means one
 * pool slot, one audit line and one Stop for a run of two hundred.</p>
 *
 * <p>The cost is that within one run the tests are isolated from other USERS,
 * not from each other: a test that leaves a module global set has affected the
 * next one in the same run. That is stated in the panel rather than fixed,
 * because fixing it means a fresh interpreter per test — and paying a full Jython
 * module-registry copy per test would turn a two-second run into a two-minute
 * one. Between runs is a different matter; see below.</p>
 *
 * <h2>The test module is executed, not imported</h2>
 *
 * <p>Since 1.21.0 the runner is handed each selected module's SOURCE and executes
 * it into a fresh namespace per run. Measured on 8.3.8, 07/09/2026:
 * {@code __import__} of a project-library module hands back the manager's own
 * module object — the same {@code id()} from two separate runs, and a global set
 * in one read back by the next, for every user. Two things follow. Module-level
 * state no longer carries from one run to the next, which the panel used to have
 * to warn about. And a mock can replace {@code system} in that namespace without
 * changing what any other script on the gateway sees, which is the only reason
 * mocking is offered at all.</p>
 */
public class TestRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(TestRouteHandler.class);

    /** HTTP 504 Gateway Timeout — the run outlived the policy's limit. */
    private static final int SC_GATEWAY_TIMEOUT = 504;

    /**
     * Most tests one request may run.
     *
     * <p>A bound rather than a paging scheme: a project with more than this many
     * tests wants them run in groups anyway, and an unbounded run is one request
     * holding a pool slot for as long as the whole suite takes.</p>
     */
    public static final int MAX_TESTS_PER_RUN = 500;

    /** How much of one test's output reaches the response. */
    public static final int MAX_OUTPUT_CHARS = 8 * 1024;

    private final ProjectIndex projectIndex;
    private final Supplier<ExecutionService> executions;
    private final Supplier<ExecAudit> audits;

    public TestRouteHandler(ProjectIndex projectIndex, Supplier<ExecutionService> executions,
                            Supplier<ExecAudit> audits) {
        this.projectIndex = projectIndex;
        this.executions = executions;
        this.audits = audits;
    }

    // ==================== Discovery ====================

    /** GET /api/tests?project=X */
    public Object list(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        List<TestDiscovery.TestModule> modules =
            TestDiscovery.discover(projectIndex, project);

        JsonArray items = new JsonArray();
        int total = 0;
        for (TestDiscovery.TestModule module : modules) {
            JsonArray tests = new JsonArray();
            for (TestDiscovery.TestCase test : module.tests()) {
                JsonObject item = new JsonObject();
                item.addProperty("id", test.id());
                item.addProperty("function", test.function());
                if (test.className() != null) {
                    item.addProperty("class", test.className());
                }
                item.addProperty("line", test.line());
                item.addProperty("decorated", test.decorated());
                item.addProperty("skipped", test.skipped());
                tests.add(item);
                total++;
            }
            JsonObject entry = new JsonObject();
            entry.addProperty("module", module.module());
            entry.addProperty("hasSetUp", module.hasSetUp());
            entry.addProperty("hasTearDown", module.hasTearDown());
            entry.addProperty("hasBeforeAll", module.hasBeforeAll());
            entry.addProperty("hasAfterAll", module.hasAfterAll());
            entry.addProperty("hasBeforeEach", module.hasBeforeEach());
            entry.addProperty("hasAfterEach", module.hasAfterEach());
            entry.add("tests", tests);
            items.add(entry);
        }

        JsonObject out = new JsonObject();
        out.addProperty("project", project);
        out.addProperty("total", total);
        out.add("modules", items);
        // Stated in the response so an empty panel can show the RULE rather than
        // the word "none" — a discovery convention nobody can see reads as a
        // broken feature.
        out.addProperty("convention", TestDiscovery.CONVENTION);
        // The helpers are only importable while a run is executing, so nothing
        // in the editor can lead somebody to them. One line in the panel is the
        // whole of their discoverability.
        out.addProperty("helperImport", TestHarness.HELPER_IMPORT);
        return out;
    }

    // ==================== The run ====================

    /** Request body for {@link #run}. */
    private static final class RunRequest {
        /** Test ids to run. Absent or empty means every discovered test. */
        List<String> ids;
    }

    /** POST /api/tests/run?project=X with {@code {ids: [...]}} */
    public Object run(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        // Re-checked HERE, per request, as the exec socket does: the policy file
        // is read live, so a gateway on which execution has just been switched
        // off must refuse the next call rather than the next restart.
        if (!ExecPolicy.executionEnabled()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_FORBIDDEN,
                "Script execution is disabled on this gateway (" + ExecPolicy.PROP_ENABLED
                    + "=false), and running a test is a script execution.");
        }

        RunRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), RunRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }

        // Discovered, never taken from the request. The body supplies a SELECTION
        // of ids; what those ids mean — which module, which function — comes from
        // this gateway's own parse. Otherwise "run this test" is a way to call any
        // function in the project by name, through the write gate but past every
        // rule about which functions are tests.
        Map<String, TestDiscovery.TestCase> known = new LinkedHashMap<>();
        for (TestDiscovery.TestModule module : TestDiscovery.discover(projectIndex, project)) {
            for (TestDiscovery.TestCase test : module.tests()) {
                known.put(test.id(), test);
            }
        }
        if (known.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "This project declares no tests. " + TestDiscovery.CONVENTION);
        }

        List<TestDiscovery.TestCase> selected = new ArrayList<>();
        List<String> unknown = new ArrayList<>();
        if (body == null || body.ids == null || body.ids.isEmpty()) {
            selected.addAll(known.values());
        } else {
            // A LinkedHashSet, so a client that sends the same id twice does not
            // run it twice — which would double any side effect it has.
            Set<String> wanted = new LinkedHashSet<>(body.ids);
            for (String id : wanted) {
                TestDiscovery.TestCase test = known.get(id);
                if (test == null) {
                    unknown.add(id);
                } else {
                    selected.add(test);
                }
            }
        }
        if (!unknown.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "No such test in this project: " + String.join(", ", unknown));
        }
        if (selected.size() > MAX_TESTS_PER_RUN) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "That is " + selected.size() + " tests; at most " + MAX_TESTS_PER_RUN
                    + " can be run in one request.");
        }

        ExecutionService service = executions.get();
        if (service == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_SERVICE_UNAVAILABLE,
                "The module is shutting down.");
        }

        String username = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse("unknown");

        ExecAudit audit = audits.get();
        if (audit != null) {
            // Before the run, so a suite that hangs is still recorded, and with
            // the same action as a console run because it is one. What is hashed
            // is the SELECTION: the harness itself is identical every time, so
            // hashing it would make every run look like the same execution.
            audit.record(username, req.getRequest().getRemoteAddr(), project,
                "tests:" + selected.size(),
                String.join("\n", selected.stream().map(TestDiscovery.TestCase::id).toList()));
        }

        // A nonce per run, so a test that prints something marker-shaped cannot
        // forge a boundary and split its output across its neighbours.
        String marker = "\u0001scriptide-tests-" + UUID.randomUUID() + "\u0001";

        PyObject locals;
        try {
            locals = service.newLocals(project);
            // A list of 4-element lists, seeded as DATA. See TestHarness: nothing
            // the user named is ever concatenated into the source.
            List<List<String>> specs = new ArrayList<>();
            for (TestDiscovery.TestCase test : selected) {
                specs.add(List.of(test.module(),
                    test.className() == null ? "" : test.className(),
                    test.function(), test.id()));
            }
            locals.__setitem__(TestHarness.VAR_TESTS, Py.java2py(specs));
            locals.__setitem__(TestHarness.VAR_MARKER, Py.newStringOrUnicode(marker));
            // Each test module's SOURCE, so the runner can execute it into a
            // namespace private to this run rather than import the gateway's
            // shared module object. A module whose source cannot be read is
            // simply absent, and the runner imports it instead — with mocks
            // refusing, because that namespace is not ours to write to.
            Map<String, String> sources = new LinkedHashMap<>();
            for (TestDiscovery.TestCase test : selected) {
                sources.computeIfAbsent(test.module(),
                    // Neutralised, or a module with a `# -*- coding: utf-8 -*-`
                    // header is discovered and then fails to RUN. The source
                    // reaches Jython's compile() as a unicode string, and Python 2
                    // refuses a coding declaration in one — measured 07/09/2026,
                    // and the two halves of that bug are separate: fixing the
                    // parse made the module visible, and it still would not run.
                    // Only the word `coding` changes, to one of the same length,
                    // so every line and column in a traceback still points at the
                    // right place.
                    name -> projectIndex.source(project, name)
                        .map(ModuleSymbols::neutraliseCodingDeclaration)
                        .orElse(null));
            }
            sources.values().removeIf(java.util.Objects::isNull);
            locals.__setitem__(TestHarness.VAR_SOURCES, Py.java2py(sources));
            locals.__setitem__(TestHarness.VAR_HELPER_SOURCE,
                Py.newStringOrUnicode(TestHarness.HELPER_SOURCE));
            locals.__setitem__(TestHarness.VAR_RUNNER_SOURCE,
                Py.newStringOrUnicode(TestHarness.RUNNER_SOURCE));
        } catch (RuntimeException e) {
            logger.warn("Could not prepare a namespace for a test run in {}: {}",
                project, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Could not prepare the execution namespace: " + e.getMessage());
        }

        String executionId = UUID.randomUUID().toString();
        // Keyed on the USER, not the request: one test run at a time per person,
        // the same bound the console gives them, so a stuck run cannot be
        // multiplied by a reload.
        String sessionKey = "tests:" + username;
        String fileName = "<script-ide:" + project + ":tests>";

        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<PrivateStateRunner.Outcome> outcome = new AtomicReference<>();
        long startedAt = System.nanoTime();
        try {
            service.submit(executionId, project, TestHarness.SOURCE, fileName, locals, username,
                sessionKey,
                () -> { /* nothing to announce: there is no socket listening */ },
                // NULL, deliberately: with a listener the runner STREAMS, and a
                // stream needs a socket to arrive on. Measured 06/09/2026 — a
                // listener passed from an HTTP request thread was never called
                // once, and the run reported success with the output silently
                // gone. Passing null makes the runner ACCUMULATE instead, which
                // is what a batch wants anyway: there is nobody watching a test
                // run line by line, and the whole of it is needed at the end to
                // split on the markers.
                null,
                result -> {
                    outcome.set(result);
                    done.countDown();
                });
        } catch (ExecutionService.RejectedException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT, e.getMessage());
        }

        long waitSeconds = ExecPolicy.timeoutSeconds() + 15;
        try {
            if (!done.await(waitSeconds, TimeUnit.SECONDS)) {
                return HandlerSupport.error(resp, SC_GATEWAY_TIMEOUT,
                    "The tests did not finish within " + waitSeconds + "s.");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Interrupted while waiting for the tests to finish");
        }

        return describe(outcome.get(), locals, selected.size(),
            (System.nanoTime() - startedAt) / 1_000_000L, fileName,
            marker, resp);
    }

    /**
     * The run's outcome as JSON.
     *
     * <p>A run that ended in a traceback is NOT an empty result list: the harness
     * lets a Stop and a Java {@code Error} through on purpose, so the honest
     * answer is "the run stopped here", rendered with the same
     * {@link TracebackFormatter} object the console gets. The results collected
     * before that point are lost with it, which is the price of one execution for
     * the whole run and is said so in the message.</p>
     */
    private static Object describe(PrivateStateRunner.Outcome result, PyObject locals,
                                   int requested, long elapsedMs, String fileName,
                                   String marker, HttpServletResponse resp) {
        if (result == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The test run finished without reporting a result");
        }
        if (result.cancelled()) {
            return HandlerSupport.error(resp, SC_GATEWAY_TIMEOUT,
                "The test run was stopped before it finished. No results were collected — "
                    + "a run is one execution, so stopping it loses the tests that had "
                    + "already passed.");
        }
        if (result.failure() != null) {
            JsonObject out = new JsonObject();
            out.addProperty("error",
                "The test run itself failed before it could report results.");
            out.add("traceback", TracebackFormatter.describe(result.failure(), fileName, 0));
            resp.setStatus(HttpServletResponse.SC_BAD_GATEWAY);
            return out;
        }

        PyObject raw = locals.__finditem__(TestHarness.VAR_RESULT);
        if (raw == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The test run produced no result document");
        }
        JsonElement parsed;
        try {
            parsed = JsonParser.parseString(raw.asString());
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The test run's result document could not be read");
        }
        JsonArray results = parsed.isJsonObject() && parsed.getAsJsonObject().has("results")
            ? parsed.getAsJsonObject().getAsJsonArray("results")
            : new JsonArray();

        // What each test printed, attributed from the stream rather than
        // redirected inside Jython — see TestHarness for the measurement that
        // ruled a sys.stdout swap out.
        // stdout and stderr are separate captures, so they are attributed
        // separately and merged per test. Interleaving between the two is not
        // preserved and cannot be: they are two streams.
        Map<String, String> output = TestHarness.attribute(result.stdout(), marker);
        for (Map.Entry<String, String> entry
                : TestHarness.attribute(result.stderr(), marker).entrySet()) {
            output.merge(entry.getKey(), entry.getValue(), String::concat);
        }

        int passed = 0;
        int failed = 0;
        int errored = 0;
        int skipped = 0;
        for (JsonElement element : results) {
            JsonObject item = element.getAsJsonObject();
            String text = output.getOrDefault(item.get("id").getAsString(), "");
            boolean truncated = text.length() > MAX_OUTPUT_CHARS;
            item.addProperty("output", truncated ? text.substring(0, MAX_OUTPUT_CHARS) : text);
            item.addProperty("outputTruncated", truncated);
            String status = item.get("status").getAsString();
            if ("pass".equals(status)) {
                passed++;
            } else if ("fail".equals(status)) {
                failed++;
            } else if ("skip".equals(status)) {
                skipped++;
            } else {
                errored++;
            }
        }

        JsonObject out = new JsonObject();
        out.add("results", results);
        out.addProperty("requested", requested);
        out.addProperty("passed", passed);
        out.addProperty("failed", failed);
        out.addProperty("errored", errored);
        out.addProperty("skipped", skipped);
        out.addProperty("elapsedMs", elapsedMs);
        return out;
    }
}
