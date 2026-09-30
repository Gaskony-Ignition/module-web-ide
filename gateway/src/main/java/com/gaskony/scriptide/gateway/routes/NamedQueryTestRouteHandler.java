package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.exec.ExecutionService;
import com.gaskony.scriptide.gateway.exec.PrivateStateRunner;
import com.gaskony.scriptide.gateway.exec.TracebackFormatter;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import jakarta.servlet.http.HttpServletResponse;
import org.python.core.Py;
import org.python.core.PyObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * Runs one named query with supplied parameters and returns its result — the
 * SAVED resource, or the unsaved draft in the editor.
 *
 * <h2>Why this goes through {@link ExecutionService}</h2>
 *
 * <p>A test-run is arbitrary SQL against a live database, submitted by the same
 * person who could paste {@code system.db.runNamedQuery(...)} into the console
 * next to it. Running it on the request thread would give that a second, softer
 * gate than the console: no policy switch, no audit line, no bound on how many
 * are in flight, and no Stop. So the generated Python is submitted exactly as a
 * console run is, and this handler simply waits for the completion callback.</p>
 *
 * <p>Waiting is safe here in a way it is NOT on the socket thread — see
 * {@code ExecutionService}'s class Javadoc. This is an HTTP request thread with
 * nothing else queued behind it, and the wait is bounded by the execution
 * timeout the policy already enforces.</p>
 *
 * <h2>Two routes to a result, and why the draft one exists</h2>
 *
 * <p>With no {@code sql} in the body this runs the SAVED resource through
 * {@code system.db.runNamedQuery}, which is the platform's own path and the one
 * whose behaviour a user is ultimately testing. With {@code sql} present it runs
 * the DRAFT through {@code runPrepQuery}/{@code runScalarPrepQuery}/
 * {@code runPrepUpdate}, because the editor's buffer has no resource to name and
 * a test that forced a save first would make "try it" destructive.
 * {@link NamedQuerySql} does the {@code :identifier} → {@code ?} conversion the
 * platform would otherwise do inside {@code runNamedQuery}.</p>
 *
 * <h2>Nothing the user typed is ever concatenated into Python</h2>
 *
 * <p>{@link #SOURCE_SAVED} and {@link #SOURCE_DRAFT} are CONSTANTS. The path, the
 * SQL, the argument list, the connection name, the query type and the row cap are
 * seeded into the execution's locals — which is also its globals, so the script
 * reads them as module-level names — and the result comes back through that same
 * namespace as a JSON string. There is no string formatting in this path, so
 * there is nothing for a value to escape from.</p>
 *
 * <p>The one deliberate exception is a {@code QueryString} parameter, which the
 * platform substitutes into the SQL as text by definition. That happens in
 * {@link NamedQuerySql}, is documented there, and is the reason this route is
 * Administrator-only.</p>
 *
 * <h2>Values are coerced by the DECLARED type, in Java</h2>
 *
 * <p>JSON has one number type and no date type, so an unconverted map binds
 * whatever the client happened to send. {@link NamedQueryCodec#coerceParameters}
 * converts each value by the parameter's own {@code sqlType} before it reaches
 * Jython, and refuses one that does not parse with a 400 that names the parameter
 * — which is a better answer than the database's own message about a type the
 * user never chose.</p>
 */
public final class NamedQueryTestRouteHandler {

    private static final Logger logger =
        LoggerFactory.getLogger(NamedQueryTestRouteHandler.class);

    /** HTTP 504 Gateway Timeout — the execution outlived the policy's limit. */
    private static final int SC_GATEWAY_TIMEOUT = 504;

    /** Names seeded into (and read back out of) the execution's namespace. */
    static final String VAR_PATH = "_scriptide_nq_path";
    static final String VAR_PARAMS = "_scriptide_nq_params";
    static final String VAR_SQL = "_scriptide_nq_sql";
    static final String VAR_ARGS = "_scriptide_nq_args";
    static final String VAR_DATABASE = "_scriptide_nq_database";
    static final String VAR_KIND = "_scriptide_nq_kind";
    static final String VAR_CAP = "_scriptide_nq_cap";
    static final String VAR_RESULT = "_scriptide_nq_result";

    /**
     * Imports and the ISO formatter, shared by both sources.
     *
     * <p>Written flat, with no {@code def} and no comprehension over a Java
     * object, for two reasons. It has to run identically under the one-namespace
     * execution model this module uses (a function body would not see these
     * module-level names on a gateway running an older build), and a single
     * conversion loop over a flat cell list is the only way to convert a grid and
     * a scalar with one piece of code.</p>
     */
    private static final String PREAMBLE = String.join("\n",
        "import json as _scriptide_nq_json",
        "import system as _scriptide_nq_system",
        "from java.util import Date as _scriptide_nq_JavaDate",
        "from java.text import SimpleDateFormat as _scriptide_nq_Format",
        "",
        "_scriptide_nq_iso = _scriptide_nq_Format(\"yyyy-MM-dd'T'HH:mm:ss.SSSXXX\")",
        "_scriptide_nq_out = {}");

    /** The saved-resource run: the platform's own named-query path. */
    private static final String RUN_SAVED = String.join("\n",
        "_scriptide_nq_raw = _scriptide_nq_system.db.runNamedQuery(",
        "    " + VAR_PATH + ", dict(" + VAR_PARAMS + "))");

    /**
     * The draft run: a prepared statement, chosen by the draft's own type.
     *
     * <p>Three calls rather than one because the platform returns three different
     * things — a dataset, a scalar and a row count — and the type is the only
     * thing that says which.</p>
     */
    private static final String RUN_DRAFT = String.join("\n",
        "if " + VAR_KIND + " == 'UpdateQuery':",
        "    _scriptide_nq_raw = _scriptide_nq_system.db.runPrepUpdate(",
        "        " + VAR_SQL + ", list(" + VAR_ARGS + "), " + VAR_DATABASE + ")",
        "elif " + VAR_KIND + " == 'ScalarQuery':",
        "    _scriptide_nq_raw = _scriptide_nq_system.db.runScalarPrepQuery(",
        "        " + VAR_SQL + ", list(" + VAR_ARGS + "), " + VAR_DATABASE + ")",
        "else:",
        "    _scriptide_nq_raw = _scriptide_nq_system.db.runPrepQuery(",
        "        " + VAR_SQL + ", list(" + VAR_ARGS + "), " + VAR_DATABASE + ")");

    /** Shape whatever came back into the JSON the contract promises. */
    private static final String SHAPING = String.join("\n",
        "_scriptide_nq_cells = []",
        "_scriptide_nq_width = 0",
        "_scriptide_nq_taken = 0",
        "if " + VAR_KIND + " == 'UpdateQuery':",
        "    _scriptide_nq_out['affected'] = int(_scriptide_nq_raw)",
        "elif " + VAR_KIND + " == 'ScalarQuery':",
        "    _scriptide_nq_cells = [_scriptide_nq_raw]",
        "else:",
        "    _scriptide_nq_columns = []",
        "    _scriptide_nq_width = _scriptide_nq_raw.getColumnCount()",
        "    for _scriptide_nq_c in range(_scriptide_nq_width):",
        "        _scriptide_nq_columns.append({",
        "            'name': _scriptide_nq_raw.getColumnName(_scriptide_nq_c),",
        "            'type': _scriptide_nq_raw.getColumnType(_scriptide_nq_c).getSimpleName()})",
        "    _scriptide_nq_total = _scriptide_nq_raw.getRowCount()",
        "    _scriptide_nq_taken = min(_scriptide_nq_total, " + VAR_CAP + ")",
        "    for _scriptide_nq_r in range(_scriptide_nq_taken):",
        "        for _scriptide_nq_c in range(_scriptide_nq_width):",
        "            _scriptide_nq_cells.append(",
        "                _scriptide_nq_raw.getValueAt(_scriptide_nq_r, _scriptide_nq_c))",
        "    _scriptide_nq_out['columns'] = _scriptide_nq_columns",
        "    _scriptide_nq_out['rowCount'] = _scriptide_nq_total",
        "    if _scriptide_nq_total > " + VAR_CAP + ":",
        "        _scriptide_nq_out['truncatedAt'] = " + VAR_CAP,
        "",
        "_scriptide_nq_flat = []",
        "for _scriptide_nq_v in _scriptide_nq_cells:",
        "    if _scriptide_nq_v is None:",
        "        _scriptide_nq_flat.append(None)",
        "    elif isinstance(_scriptide_nq_v, bool):",
        "        _scriptide_nq_flat.append(_scriptide_nq_v)",
        "    elif isinstance(_scriptide_nq_v, (int, long, float)):",
        "        _scriptide_nq_flat.append(_scriptide_nq_v)",
        "    elif isinstance(_scriptide_nq_v, (str, unicode)):",
        "        _scriptide_nq_flat.append(_scriptide_nq_v)",
        "    elif isinstance(_scriptide_nq_v, _scriptide_nq_JavaDate):",
        "        _scriptide_nq_flat.append(_scriptide_nq_iso.format(_scriptide_nq_v))",
        "    else:",
        "        _scriptide_nq_flat.append(unicode(_scriptide_nq_v))",
        "",
        "if " + VAR_KIND + " == 'ScalarQuery':",
        "    _scriptide_nq_out['value'] = _scriptide_nq_flat[0]",
        "elif " + VAR_KIND + " != 'UpdateQuery':",
        "    _scriptide_nq_rows = []",
        "    for _scriptide_nq_r in range(_scriptide_nq_taken):",
        "        _scriptide_nq_rows.append(",
        "            _scriptide_nq_flat[_scriptide_nq_r * _scriptide_nq_width:",
        "                               (_scriptide_nq_r + 1) * _scriptide_nq_width])",
        "    _scriptide_nq_out['rows'] = _scriptide_nq_rows",
        "",
        VAR_RESULT + " = _scriptide_nq_json.dumps(_scriptide_nq_out)",
        "");

    /** Run the saved resource. A constant. */
    static final String SOURCE_SAVED = PREAMBLE + "\n" + RUN_SAVED + "\n\n" + SHAPING;

    /** Run the editor's draft. A constant. */
    static final String SOURCE_DRAFT = PREAMBLE + "\n" + RUN_DRAFT + "\n\n" + SHAPING;

    private final ProjectManager projectManager;
    private final Supplier<ExecutionService> executions;
    private final Supplier<ExecAudit> audits;

    public NamedQueryTestRouteHandler(ProjectManager projectManager,
                                      Supplier<ExecutionService> executions,
                                      Supplier<ExecAudit> audits) {
        this.projectManager = projectManager;
        this.executions = executions;
        this.audits = audits;
    }

    /**
     * {@code POST /api/named-queries/test?project=X} with
     * {@code {path, parameters, sql?, settings?}}.
     */
    public Object test(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        // Re-checked HERE, per request, exactly as the exec socket does it: the
        // policy file is read live, so a gateway on which execution has just been
        // switched off must refuse the next call rather than the next restart.
        if (!ExecPolicy.executionEnabled()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_FORBIDDEN,
                "Script execution is disabled on this gateway (" + ExecPolicy.PROP_ENABLED
                    + "=false), and a named-query test-run is a script execution.");
        }

        TestRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), TestRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.path == null || body.path.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'path'");
        }

        ResourcePath path;
        try {
            path = NamedQueryRouteHandler.decodeQueryPath(body.path);
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        boolean draft = body.sql != null;

        // Inheritance-MERGED: an inherited query is runnable, and its test tab must
        // work without first overriding it.
        Optional<Resource> resourceOpt = projectManager.find(project)
            .flatMap(c -> c.getResource(path));

        NamedQuery query;
        if (draft && body.settings != null) {
            // A draft with its own settings needs no resource at all — this is the
            // path a brand-new, never-saved query takes.
            query = new NamedQuery();
            query.setType(NamedQuery.Type.Query);
            try {
                NamedQueryCodec.apply(query, body.settings);
            } catch (NamedQueryCodec.BadValueException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
        } else {
            if (resourceOpt.isEmpty()) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No such named query: " + path.getPath() + " in project " + project);
            }
            Resource resource = resourceOpt.get();
            if (!draft && NamedQueryCodec.isLegacy(resource)) {
                // Refused with the reason, not attempted. The gateway cannot read a
                // version-1 resource either, so runNamedQuery would fail with an NPE
                // from inside the platform that says nothing about why. A DRAFT run
                // is still allowed on one, because it does not go through the
                // resource at all — which is how a user repairs it.
                return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                    "This query is stored in the legacy version-1 format, which this gateway "
                        + "cannot execute. Save it once to rewrite it in the current format, "
                        + "then run it.");
            }
            try {
                query = NamedQueryCodec.read(resource);
            } catch (Exception e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                    "This query's settings could not be read: " + e.getMessage());
            }
        }

        if (!draft && !query.isEnabled()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "This query is disabled. Enable it in Settings before running it.");
        }

        Map<String, Object> parameters;
        try {
            parameters = NamedQueryCodec.coerceParameters(
                query.getParameters() == null ? List.of() : query.getParameters(),
                body.parameters);
        } catch (NamedQueryCodec.BadValueException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        NamedQuerySql.Prepared prepared = null;
        if (draft) {
            try {
                prepared = NamedQuerySql.prepare(body.sql,
                    query.getParameters() == null ? List.of() : query.getParameters(),
                    parameters);
            } catch (NamedQueryCodec.BadValueException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
        }

        ExecutionService service = executions.get();
        if (service == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_SERVICE_UNAVAILABLE,
                "The module is shutting down.");
        }

        String username = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse("unknown");
        String queryPath = path.getPath().toString();
        String target = "named-query:" + queryPath + (draft ? " (draft)" : "");
        String source = draft ? SOURCE_DRAFT : SOURCE_SAVED;
        String kind = query.getType().name();

        ExecAudit audit = audits.get();
        if (audit != null) {
            // Before the run, so a query that hangs is still recorded — and with the
            // SAME action as a console run, because it is one. The SQL is what gets
            // hashed for a draft: the generated wrapper is identical every time, so
            // hashing it would make every test-run look like the same execution.
            audit.record(username, req.getRequest().getRemoteAddr(), project, target,
                draft ? body.sql : source);
        }

        PyObject locals;
        try {
            locals = service.newLocals(project);
            locals.__setitem__(VAR_KIND, Py.newStringOrUnicode(kind));
            locals.__setitem__(VAR_CAP, Py.newInteger(NamedQueryCodec.TEST_ROW_CAP));
            if (draft) {
                locals.__setitem__(VAR_SQL, Py.newStringOrUnicode(prepared.sql()));
                locals.__setitem__(VAR_ARGS, Py.java2py(prepared.arguments()));
                locals.__setitem__(VAR_DATABASE,
                    Py.newStringOrUnicode(NamedQuerySql.connectionFor(query, parameters)));
            } else {
                locals.__setitem__(VAR_PATH, Py.newStringOrUnicode(queryPath));
                locals.__setitem__(VAR_PARAMS, Py.java2py(parameters));
            }
        } catch (RuntimeException e) {
            logger.warn("Could not prepare a namespace for a named-query test in {}: {}",
                project, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Could not prepare the execution namespace: " + e.getMessage());
        }

        String executionId = UUID.randomUUID().toString();
        // The session key is the USER, not the request: one test-run at a time per
        // person, the same bound the console gives them, so a stuck run cannot be
        // multiplied by a reload.
        String sessionKey = "named-query-test:" + username;
        String fileName = "<script-ide:" + project + ":" + target + ">";

        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<PrivateStateRunner.Outcome> outcome = new AtomicReference<>();
        long startedAt = System.nanoTime();
        try {
            service.submit(executionId, project, source, fileName, locals, username, sessionKey,
                () -> { /* nothing to announce: there is no socket listening */ },
                (stream, text) -> {
                    // The generated source prints nothing. Anything here came from a
                    // project-library import with a print in it, which is worth a log
                    // line and is not part of the response.
                    logger.debug("Named-query test {} wrote to {}: {}", executionId, stream, text);
                },
                result -> {
                    outcome.set(result);
                    done.countDown();
                });
        } catch (ExecutionService.RejectedException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT, e.getMessage());
        }

        // Bounded by the policy's own timeout plus a margin: the service reports a
        // timed-out run as cancelled, so this only fires if the callback itself is
        // lost, and then a 504 is the honest answer.
        long waitSeconds = ExecPolicy.timeoutSeconds() + 15;
        try {
            if (!done.await(waitSeconds, TimeUnit.SECONDS)) {
                return HandlerSupport.error(resp, SC_GATEWAY_TIMEOUT,
                    "The query did not finish within " + waitSeconds + "s.");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Interrupted while waiting for the query to finish");
        }

        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L;
        return describe(outcome.get(), locals, kind, fileName, elapsedMs, resp);
    }

    /**
     * The execution's outcome as the contract's JSON.
     *
     * <p>{@code type} and {@code elapsedMs} are on EVERY shape, success or
     * failure. Without the type a {@code null} scalar and an empty grid are the
     * same response, and the client cannot tell which renderer to use.</p>
     *
     * <p>A failure is rendered with {@link TracebackFormatter}, the same structured
     * object the console gets, so the UI renders a failed test-run with the
     * traceback component it already has rather than a second error style.</p>
     */
    private static Object describe(PrivateStateRunner.Outcome result, PyObject locals,
                                   String kind, String fileName, long elapsedMs,
                                   HttpServletResponse resp) {
        if (result == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The query finished without reporting a result");
        }
        if (result.cancelled()) {
            return HandlerSupport.error(resp, SC_GATEWAY_TIMEOUT,
                "The query was stopped before it finished"
                    + (result.failure() == null ? "" : ": " + result.failure().getMessage()));
        }
        if (result.failure() != null) {
            JsonObject out = new JsonObject();
            out.addProperty("ok", false);
            out.addProperty("type", kind);
            out.addProperty("elapsedMs", elapsedMs);
            out.add("error", TracebackFormatter.describe(result.failure(), fileName, 0));
            return out;
        }

        PyObject raw = locals.__finditem__(VAR_RESULT);
        if (raw == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The query ran but produced no result payload");
        }
        JsonObject payload;
        try {
            payload = JsonParser.parseString(raw.asString()).getAsJsonObject();
        } catch (RuntimeException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The query's result could not be read back: " + e.getMessage());
        }

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("type", kind);
        out.addProperty("elapsedMs", elapsedMs);
        payload.entrySet().forEach(e -> out.add(e.getKey(), e.getValue()));
        return out;
    }

    /**
     * Body of a test-run.
     *
     * <p>{@code sql} present means "run this draft rather than what is saved";
     * {@code settings} alongside it means the draft's own settings too, which is
     * what lets a never-saved query be tested at all.</p>
     */
    static final class TestRequest {
        String path;
        JsonObject parameters;
        String sql;
        JsonObject settings;
    }
}
