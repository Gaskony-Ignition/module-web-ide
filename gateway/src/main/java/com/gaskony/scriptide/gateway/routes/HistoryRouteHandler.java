package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.history.SaveHistory;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

/**
 * Read back the versions this IDE has saved.
 *
 * <p>There is no write route. History is recorded as a side effect of a
 * successful save in {@link ScriptResourceRouteHandler}, which is the only place
 * that knows a version was actually accepted by the platform; an endpoint that
 * let a client post its own "version" would let the history disagree with what
 * the gateway holds, and a history you cannot trust is worse than none.</p>
 *
 * <p>There is no delete route either, deliberately. The store prunes itself on
 * every write, and the one thing a user would reach for a delete button for —
 * "get this off the gateway" — is better served by the bounded retention than by
 * a control that makes a person responsible for cleaning up after the tool.</p>
 *
 * <h2>Own history only</h2>
 *
 * <p>Both routes resolve the user from the SESSION and never from a parameter.
 * A {@code user=} parameter is what turns "your own history" into "anyone's
 * history" the first time someone edits a URL.</p>
 */
public class HistoryRouteHandler {

    private final SaveHistory history;

    public HistoryRouteHandler(SaveHistory history) {
        this.history = history;
    }

    /** GET /api/history — the versions kept for one document. */
    public Object list(RequestContext req, HttpServletResponse resp) throws IOException {
        Params params = Params.of(req, resp);
        if (params.error != null) {
            return params.error;
        }
        if (history == null) {
            return empty();
        }
        List<SaveHistory.Version> versions =
            history.list(params.user, params.project, params.path, params.key);
        JsonArray items = new JsonArray();
        for (SaveHistory.Version version : versions) {
            JsonObject item = new JsonObject();
            item.addProperty("id", version.id());
            item.addProperty("savedAt", version.savedAt());
            item.addProperty("size", version.size());
            items.add(item);
        }
        JsonObject out = new JsonObject();
        out.add("versions", items);
        out.addProperty("maxVersions", SaveHistory.MAX_VERSIONS);
        return out;
    }

    /** GET /api/history/content — one version's source, as text. */
    public Object content(RequestContext req, HttpServletResponse resp) throws IOException {
        Params params = Params.of(req, resp);
        if (params.error != null) {
            return params.error;
        }
        String id = req.getParameter("id");
        if (id == null || id.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'id' parameter");
        }
        Optional<String> source = history == null
            ? Optional.empty()
            : history.read(params.user, params.project, params.path, params.key, id);
        if (source.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such version, or it has been pruned");
        }
        // text/plain for the same reason the script read is: this is source, and
        // a JSON content type invites a browser or a proxy to parse it.
        resp.setContentType("text/plain; charset=UTF-8");
        byte[] bytes = source.get().getBytes(StandardCharsets.UTF_8);
        resp.setContentLength(bytes.length);
        resp.getOutputStream().write(bytes);
        return null;
    }

    /**
     * GET /api/runs — this user's finished executions, newest first.
     *
     * <p>Read from the store rather than from the audit profile: the audit keeps
     * a HASH of the source by design, so it can say a run happened and never
     * what was run. See {@code RunHistory}.</p>
     */
    public Object runs(RequestContext req, HttpServletResponse resp) throws IOException {
        String user = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse(null);
        JsonObject out = new JsonObject();
        JsonArray items = new JsonArray();
        var store = com.gaskony.scriptide.gateway.ws.ScriptIdeSocketRegistry.getRunHistory();
        if (user != null && !user.isBlank() && store != null) {
            for (var run : store.list(user)) {
                JsonObject item = new JsonObject();
                item.addProperty("id", run.id());
                item.addProperty("at", run.at());
                item.addProperty("project", run.project());
                item.addProperty("source", run.source());
                item.addProperty("output", run.output());
                item.addProperty("ok", run.ok());
                item.addProperty("outputTruncated", run.outputTruncated());
                // Zero means a record kept before durations were, and the
                // client shows nothing rather than "0 ms".
                item.addProperty("durationMs", run.durationMs());
                if (run.error() != null) {
                    item.addProperty("error", run.error());
                }
                items.add(item);
            }
        }
        out.add("runs", items);
        out.addProperty("maxRuns",
            com.gaskony.scriptide.gateway.history.RunHistory.MAX_RUNS);
        return out;
    }

    private static JsonObject empty() {
        JsonObject out = new JsonObject();
        out.add("versions", new JsonArray());
        out.addProperty("maxVersions", SaveHistory.MAX_VERSIONS);
        return out;
    }

    /** The three identifiers every history call needs, plus the caller. */
    private static final class Params {
        private String user;
        private String project;
        private String path;
        private String key;
        private Object error;

        static Params of(RequestContext req, HttpServletResponse resp) {
            Params params = new Params();
            params.project = req.getParameter("project");
            params.path = req.getParameter("path");
            params.key = req.getParameter("key");
            if (params.project == null || params.project.isBlank()) {
                params.error = HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "Missing required 'project' parameter");
                return params;
            }
            if (params.path == null || params.path.isBlank()) {
                params.error = HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "Missing required 'path' parameter");
                return params;
            }
            params.user = SessionSecurity.authenticatedUser(req)
                .map(u -> u.getUserName())
                .orElse(null);
            if (params.user == null || params.user.isBlank()) {
                // The route is authenticated, so this is a session that exists
                // without a resolvable username rather than an anonymous caller.
                params.error = HandlerSupport.error(resp, HttpServletResponse.SC_FORBIDDEN,
                    "History is per user, and this session has no user name");
            }
            return params;
        }
    }
}
