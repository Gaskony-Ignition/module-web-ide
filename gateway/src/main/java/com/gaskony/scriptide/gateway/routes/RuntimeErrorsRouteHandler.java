package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.runtime.ScriptErrors;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import jakarta.servlet.http.HttpServletResponse;

import java.io.IOException;
import java.util.List;

/**
 * What this project's scripts are actually throwing, right now.
 *
 * <p>Authenticated rather than administrator-gated, matching every other READ in
 * this module: a non-administrator already sees the source of every script
 * through the tree, and gateway log lines about it are less than that. The
 * window is capped in {@link ScriptErrors} rather than trusted from the query,
 * so a caller cannot turn this into "scan the whole log".</p>
 */
public class RuntimeErrorsRouteHandler {

    private final GatewayContext context;

    public RuntimeErrorsRouteHandler(GatewayContext context) {
        this.context = context;
    }

    /**
     * The bare names of a project's gateway event scripts.
     *
     * <p>Read from the resource collection rather than accepted from the caller:
     * matching arbitrary strings against the log would turn a health endpoint
     * into a log-search one.</p>
     */
    private java.util.List<String> gatewayEventNames(String project) {
        java.util.List<String> names = new java.util.ArrayList<>();
        if (context == null) {
            return names;
        }
        try {
            var found = context.getProjectManager().find(project);
            if (found.isEmpty()) {
                return names;
            }
            for (var resource : found.get().getResources()) {
                var type = resource.getResourcePath().getResourceType();
                if (!"ignition".equals(type.moduleId())
                    || !GATEWAY_EVENT_TYPES.contains(type.typeId())) {
                    continue;
                }
                String tail = resource.getResourcePath().getPath().toString();
                if (tail.isEmpty()) {
                    continue;       // a singleton has no name to match on
                }
                int slash = tail.lastIndexOf('/');
                names.add(slash < 0 ? tail : tail.substring(slash + 1));
            }
        } catch (Exception e) {
            return names;
        }
        return names;
    }

    private static final java.util.Set<String> GATEWAY_EVENT_TYPES = java.util.Set.of(
        "timer", "message", "tag-change", "scheduled");

    /** GET /api/runtime/errors?project=&minutes= */
    public Object errors(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        long window = ScriptErrors.DEFAULT_WINDOW_MILLIS;
        String minutes = req.getParameter("minutes");
        if (minutes != null && !minutes.isBlank()) {
            try {
                window = Long.parseLong(minutes.trim()) * 60_000L;
            } catch (NumberFormatException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "'minutes' must be a whole number");
            }
        }

        List<ScriptErrors.ScriptError> found =
            ScriptErrors.forProject(context, project, window);
        JsonArray items = new JsonArray();
        for (ScriptErrors.ScriptError error : found) {
            JsonObject item = new JsonObject();
            item.addProperty("logger", error.loggerName());
            item.addProperty("level", error.level());
            item.addProperty("message", error.message());
            item.addProperty("lastSeen", error.lastSeen());
            item.addProperty("count", error.count());
            if (error.exception() != null) {
                item.addProperty("exception", error.exception());
            }
            items.add(item);
        }
        // Per-script attribution, so a tree row can badge a script that has been
        // failing. Names come from the project's own gateway event resources —
        // the caller does not get to pass a list, or this becomes a way to ask
        // "does the log mention <anything I like>".
        JsonArray health = new JsonArray();
        for (ScriptErrors.ScriptHealth each
                : ScriptErrors.byScript(found, gatewayEventNames(project))) {
            JsonObject item = new JsonObject();
            item.addProperty("script", each.script());
            item.addProperty("count", each.count());
            item.addProperty("lastSeen", each.lastSeen());
            health.add(item);
        }

        JsonObject out = new JsonObject();
        out.add("errors", items);
        out.add("byScript", health);
        out.addProperty("windowMinutes", window / 60_000L);
        // Stated so the panel can say what it is showing. "What the gateway
        // logged ABOUT this project" is not the same claim as "errors this
        // project's scripts caused", and the UI must not imply the stronger one
        // — see the class comment on ScriptErrors for why the weaker rule is
        // the honest one available.
        out.addProperty("matchedBy", "project name in the log message or logger");
        return out;
    }
}
