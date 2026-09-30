package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ScriptResourceTypes;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.common.resourcecollection.ChangeOperation;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Optional;

/**
 * Reads and writes a Web Dev endpoint's {@code config.json}.
 *
 * <h2>Why this is not the attributes route</h2>
 *
 * <p>Every other resource this IDE edits keeps its settings in
 * {@code resource.json} attributes, which the platform models and the attributes
 * route writes with {@code putAttribute}. Web Dev does not: measured on a real
 * gateway (01/09/2026), a Web Dev resource has NO editable attributes at all,
 * and everything the Designer shows — per-method enabled, require-auth,
 * require-https, required roles, user source, retry count — lives inside a
 * {@code config.json} DATA FILE beside the handler scripts.</p>
 *
 * <p>So this route does a read-modify-write of one data key. Two consequences
 * follow and both are deliberate:</p>
 *
 * <ul>
 *   <li><b>Unknown keys are preserved.</b> The file is parsed, the known
 *       per-method settings are replaced, and everything else is written back
 *       untouched. A future Ignition version adding a field must not have it
 *       silently deleted by an older build of this module.</li>
 *   <li><b>The existing file is never replaced wholesale by client input.</b>
 *       The client sends settings, not a document — otherwise a malformed body
 *       would happily overwrite a working endpoint's configuration.</li>
 * </ul>
 */
public final class WebDevConfigRouteHandler {

    private static final Logger logger =
        LoggerFactory.getLogger(WebDevConfigRouteHandler.class);

    /** What the Designer writes for a method nobody has configured. */
    private static final String DEFAULT_METHOD_CONFIG = """
        {"enabled":false,"max-retry-attempts":3,"require-auth":false,\
        "require-https":false,"required-roles":"","user-source":""}""";

    private final ProjectManager projectManager;

    public WebDevConfigRouteHandler(ProjectManager projectManager) {
        this.projectManager = projectManager;
    }

    /** {@code GET /api/webdev/config/:path?project=X}. */
    public Object read(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = HandlerSupport.decodePath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Object rejected = rejectNonWebDev(path, resp);
        if (rejected != null) {
            return rejected;
        }

        // Inheritance-MERGED, matching the content read: an inherited endpoint
        // opens rather than 404ing.
        Optional<Resource> found = projectManager.find(project).flatMap(c -> c.getResource(path));
        if (found.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such Web Dev endpoint: " + path);
        }
        Resource resource = found.get();

        JsonObject config = parseConfig(resource);
        JsonObject out = new JsonObject();
        out.addProperty("path", HandlerSupport.encodePath(path));
        // Which of the two shapes this is. The per-method settings below are
        // meaningless on a text resource, and a client that cannot tell would
        // offer eight verb forms for a static HTML file.
        out.addProperty("kind",
            WebDevResources.isTextResource(config) ? "text" : "python");
        out.addProperty("contentType", WebDevResources.contentType(config));
        out.addProperty("signature", resource.getResourceSignature().toString());
        out.add("config", config);
        var methods = new com.google.gson.JsonArray();
        ScriptResourceTypes.WEBDEV_METHODS.forEach(methods::add);
        out.add("methods", methods);
        var settings = new com.google.gson.JsonArray();
        ScriptResourceTypes.WEBDEV_METHOD_SETTINGS.forEach(settings::add);
        out.add("settings", settings);
        return out;
    }

    /** Body of a config write: {@code {method, settings:{…}, baseSignature}}. */
    private static final class ConfigWriteRequest {
        String method;
        JsonObject settings;
        String baseSignature;
    }

    /** {@code POST /api/webdev/config/:path?project=X}. */
    public Object write(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = HandlerSupport.decodePath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Object rejected = rejectNonWebDev(path, resp);
        if (rejected != null) {
            return rejected;
        }
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        ConfigWriteRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), ConfigWriteRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.method == null || body.settings == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'method' and 'settings'");
        }
        if (!ScriptResourceTypes.WEBDEV_METHODS.contains(body.method)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Unknown HTTP method '" + body.method + "'. Expected one of "
                    + ScriptResourceTypes.WEBDEV_METHODS);
        }

        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        if (!projectManager.isMutable(project)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Project is not mutable: " + project);
        }

        // OWN-project, like every other write here: editing an inherited endpoint
        // creates a local override rather than changing the parent's copy.
        Optional<Resource> existingOpt = projectManager.getResource(project, path);
        if (existingOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such Web Dev endpoint in " + project);
        }
        Resource existing = existingOpt.get();

        // A text resource has no handlers, so it has no per-method settings.
        // Writing them would leave a doGet block on a resource the platform
        // serves as a static file: inert, misleading, and impossible to tell
        // apart later from an endpoint someone half-converted by hand.
        if (WebDevResources.isTextResource(WebDevResources.parseConfig(existing))) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "That endpoint is a static resource, not Python handlers — it has "
                    + "no per-method settings");
        }

        String expected = HandlerSupport.expectedSignature(req, body.baseSignature);
        String current = existing.getResourceSignature().toString();
        if (expected == null || expected.isBlank()) {
            return HandlerSupport.error(resp, HandlerSupport.SC_PRECONDITION_REQUIRED,
                "Missing If-Match/baseSignature — read the endpoint before updating it");
        }
        if (!expected.equals(current)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "This endpoint changed on the gateway since you opened it");
        }

        JsonObject config = parseConfig(existing);
        JsonObject method = config.has(body.method) && config.get(body.method).isJsonObject()
            ? config.getAsJsonObject(body.method)
            : JsonParser.parseString(DEFAULT_METHOD_CONFIG).getAsJsonObject();

        // Only the settings we know. Anything else in the object stays as it was,
        // so a field a newer Ignition adds is preserved rather than dropped.
        for (String name : ScriptResourceTypes.WEBDEV_METHOD_SETTINGS) {
            if (!body.settings.has(name)) {
                continue;
            }
            JsonElement value = body.settings.get(name);
            try {
                method.add(name, validate(name, value));
            } catch (IllegalArgumentException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
        }
        config.add(body.method, method);

        // Pretty-printed with a trailing newline, matching what the platform
        // writes — a compact rewrite would show every endpoint as fully changed
        // in the next diff.
        byte[] bytes = WebDevResources.serialise(config);
        ResourceBuilder builder = existing.toBuilder()
            .putData(ScriptResourceTypes.WEBDEV_CONFIG_KEY, bytes);
        ChangeOperation op =
            ChangeOperation.newModifyOp(builder.build(), existing.getResourceSignature());

        try {
            projectManager.push(new com.inductiveautomation.ignition.gateway.resourcecollection
                .PushOperation(java.util.List.of(op), HandlerSupport.actorFor(req)))
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Web Dev config write interrupted");
        } catch (Exception e) {
            logger.warn("Web Dev config push failed for {}/{}: {}", project, path, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Web Dev config write failed: " + e.getMessage());
        }

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        projectManager.getResource(project, path)
            .ifPresent(now -> out.addProperty("signature", now.getResourceSignature().toString()));
        return out;
    }

    /** Enforce the type each setting actually holds, rather than coercing. */
    private static JsonElement validate(String name, JsonElement value) {
        boolean primitive = value.isJsonPrimitive();
        switch (name) {
            case "enabled":
            case "require-auth":
            case "require-https":
                if (!primitive || !value.getAsJsonPrimitive().isBoolean()) {
                    throw new IllegalArgumentException(name + " must be a boolean");
                }
                return value;
            case "max-retry-attempts": {
                if (!primitive || !value.getAsJsonPrimitive().isNumber()) {
                    throw new IllegalArgumentException(name + " must be a number");
                }
                int v = value.getAsInt();
                if (v < 0 || v > 100) {
                    throw new IllegalArgumentException(
                        "max-retry-attempts must be between 0 and 100, got " + v);
                }
                return value;
            }
            case "required-roles":
            case "user-source":
                if (!primitive || !value.getAsJsonPrimitive().isString()) {
                    throw new IllegalArgumentException(name + " must be a string");
                }
                return value;
            default:
                // Unreachable: the caller iterates the known set.
                throw new IllegalArgumentException("No validator for '" + name + "'");
        }
    }

    /** The endpoint's config, or an empty object. See WebDevResources#parseConfig. */
    private static JsonObject parseConfig(Resource resource) {
        return WebDevResources.parseConfig(resource);
    }

    private Object rejectNonWebDev(ResourcePath path, HttpServletResponse resp) {
        var type = path.getResourceType();
        if (!ScriptResourceTypes.isWebDev(type.moduleId(), type.typeId())) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Not a Web Dev resource: " + type.moduleId() + "/" + type.typeId());
        }
        if (path.isResourceTypeFolder()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "That is the Web Dev folder, not an endpoint");
        }
        return null;
    }
}
