package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.TagUtilities;
import com.inductiveautomation.ignition.common.tags.browsing.NodeDescription;
import com.inductiveautomation.ignition.common.tags.config.CollisionPolicy;
import com.inductiveautomation.ignition.common.tags.config.TagConfiguration;
import com.inductiveautomation.ignition.common.tags.config.TagConfigurationModel;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.TagProvider;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.ignition.gateway.tags.model.GatewayTagManager;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * The Tag Browser: browse, read, write, export, create and delete tags from the
 * browser.
 *
 * <h2>Administrator on every route, and the system security context</h2>
 *
 * <p>The completion-side {@code SdkTagBrowser} may answer to any authenticated
 * user because it returns NAMES only. A value, a write and a configuration are
 * not names, so every route here takes the same Administrator gate as the Query
 * Browser. Behind that gate the gateway's own {@link SecurityContext#systemContext()}
 * is used: an Administrator can already do anything the JVM can, so mapping them
 * onto per-tag security levels would restrict nothing a console run could not
 * undo, and would make the browser answer differently from the console.</p>
 *
 * <p>Writes, creates and deletes also re-check {@link ExecPolicy#executionEnabled()}
 * per request and are audited before they run, exactly as the Query Browser does
 * for SQL.</p>
 */
public final class TagRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(TagRouteHandler.class);

    private static final long TIMEOUT_SECONDS = 10;

    /** Bound on how many children one browse returns. */
    static final int MAX_CHILDREN = 2000;

    /** Bound on how many paths one read may ask for. */
    static final int MAX_READ_PATHS = 500;

    private final GatewayContext context;
    private final Supplier<ExecAudit> audits;

    public TagRouteHandler(GatewayContext context, Supplier<ExecAudit> audits) {
        this.context = context;
        this.audits = audits;
    }

    // ==================== GET /api/tags/providers ====================

    public Object providers(RequestContext req, HttpServletResponse resp) {
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        JsonArray out = new JsonArray();
        for (TagProvider provider : manager.getTagProviders()) {
            out.add(provider.getName());
        }
        JsonObject body = new JsonObject();
        body.add("providers", out);
        return body;
    }

    // ==================== GET /api/tags/browse?path=[provider]a/b ====================

    /** One level of the tree, with each child's type, data type and (cheap) value. */
    public Object browse(RequestContext req, HttpServletResponse resp) {
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        TagPath path = parse(req.getParameter("path"));
        if (path == null) {
            return badPath(resp);
        }
        if (manager.getTagProvider(path.getSource()) == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No tag provider '" + path.getSource() + "'");
        }
        try {
            Results<NodeDescription> results = manager
                .browseAsync(path, BrowseFilter.NONE, SecurityContext.systemContext())
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            Collection<NodeDescription> nodes = results == null ? null : results.getResults();
            JsonArray out = new JsonArray();
            boolean truncated = false;
            if (nodes != null) {
                for (NodeDescription node : nodes) {
                    if (out.size() >= MAX_CHILDREN) {
                        truncated = true;
                        break;
                    }
                    JsonObject row = new JsonObject();
                    row.addProperty("name", node.getName());
                    row.addProperty("hasChildren", node.hasChildren());
                    row.addProperty("objectType", String.valueOf(node.getObjectType()));
                    row.addProperty("dataType", node.getDataType() == null ? null : node.getDataType().name());
                    out.add(row);
                }
            }
            JsonObject body = new JsonObject();
            body.add("children", out);
            if (truncated) {
                body.addProperty("truncated", true);
            }
            return body;
        } catch (Exception e) {
            return failure(resp, "Could not browse '" + req.getParameter("path") + "'", e);
        }
    }

    // ==================== POST /api/tags/read  {paths: [...]} ====================

    /**
     * POST, not GET: a path list is long and a tag name may hold characters a
     * query string mangles.
     */
    public Object read(RequestContext req, HttpServletResponse resp) throws IOException {
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        PathsRequest body = readBody(req, PathsRequest.class);
        if (body == null || body.paths == null || body.paths.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'paths'");
        }
        if (body.paths.size() > MAX_READ_PATHS) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "At most " + MAX_READ_PATHS + " paths per read");
        }
        List<TagPath> paths = parseAll(body.paths);
        if (paths == null) {
            return badPath(resp);
        }
        try {
            List<QualifiedValue> values = manager.readAsync(paths, SecurityContext.systemContext())
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            JsonArray out = new JsonArray();
            for (int i = 0; i < paths.size(); i++) {
                QualifiedValue value = values.get(i);
                JsonObject row = new JsonObject();
                row.addProperty("path", body.paths.get(i));
                row.add("value", jsonValue(value.getValue()));
                row.addProperty("quality", value.getQuality().toString());
                row.addProperty("good", value.getQuality().isGood());
                row.addProperty("timestamp", value.getTimestamp().toInstant().toString());
                out.add(row);
            }
            JsonObject result = new JsonObject();
            result.add("values", out);
            return result;
        } catch (Exception e) {
            return failure(resp, "Could not read tags", e);
        }
    }

    // ==================== POST /api/tags/write  {path, value} ====================

    public Object write(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        WriteRequest body = readBody(req, WriteRequest.class);
        if (body == null || body.path == null || body.value == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'path' and 'value'");
        }
        TagPath path = parse(body.path);
        if (path == null) {
            return badPath(resp);
        }
        audit(req, "tag-write:" + body.path, body.value.toString());
        try {
            List<QualityCode> codes = manager
                .writeAsync(List.of(path), List.of(new BasicQualifiedValue(plainValue(body.value))),
                    SecurityContext.systemContext())
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return qualityResult(resp, codes);
        } catch (Exception e) {
            return failure(resp, "Could not write '" + body.path + "'", e);
        }
    }

    // ==================== GET /api/tags/config?path=... ====================

    /** The tag's full configuration (children included) as JSON, as {@code system.tag.getConfiguration}. */
    public Object config(RequestContext req, HttpServletResponse resp) {
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        TagPath path = parse(req.getParameter("path"));
        if (path == null) {
            return badPath(resp);
        }
        try {
            TagProvider provider = manager.getTagProvider(path.getSource());
            if (provider == null) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No tag provider '" + path.getSource() + "'");
            }
            List<TagConfigurationModel> models = provider
                .getTagConfigsAsync(List.of(path), true, false)
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (models == null || models.isEmpty() || models.get(0) == null) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No tag at '" + req.getParameter("path") + "'");
            }
            JsonObject body = new JsonObject();
            body.addProperty("json", TagUtilities.jsonToString(TagUtilities.toJsonObject(models.get(0))));
            return body;
        } catch (Exception e) {
            return failure(resp, "Could not read the configuration of '" + req.getParameter("path") + "'", e);
        }
    }

    // ==================== POST /api/tags/create  {basePath, json, collision} ====================

    /**
     * Create tags from a configuration JSON document under {@code basePath}, the
     * way {@code system.tag.configure} does. One shape covers an atomic tag, a
     * folder, a UDT definition and a UDT instance: the JSON's {@code tagType} says
     * which.
     */
    public Object create(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        CreateRequest body = readBody(req, CreateRequest.class);
        if (body == null || body.basePath == null || body.json == null || body.json.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'basePath' and 'json'");
        }
        TagPath base = parse(body.basePath);
        if (base == null) {
            return badPath(resp);
        }
        CollisionPolicy policy = collisionPolicy(body.collision);
        audit(req, "tag-create:" + body.basePath, body.json);
        try {
            // The raw JSON text: toTagConfiguration parses a String with the tag
            // Gson itself, and rejects both a JsonElement and a plain Map as an
            // "unknown type".
            List<TagConfiguration> configs = TagUtilities.toTagConfiguration(body.json, base);
            TagProvider provider = manager.getTagProvider(base.getSource());
            if (provider == null) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No tag provider '" + base.getSource() + "'");
            }
            // The write timeout, not the read one: a pasted config can hold
            // thousands of tags.
            List<QualityCode> codes = provider.saveTagConfigsAsync(configs, policy)
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return qualityResult(resp, codes);
        } catch (Exception e) {
            return failure(resp, "Could not create tags under '" + body.basePath + "'", e);
        }
    }

    // ==================== POST /api/tags/delete  {paths} ====================

    public Object delete(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        PathsRequest body = readBody(req, PathsRequest.class);
        if (body == null || body.paths == null || body.paths.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'paths'");
        }
        List<TagPath> paths = parseAll(body.paths);
        if (paths == null) {
            return badPath(resp);
        }
        audit(req, "tag-delete", String.join("\n", body.paths));
        try {
            // One call per path (removal is provider-level), with a MUTABLE list:
            // the platform sorts it in place and List.of() throws inside its executor.
            List<QualityCode> codes = new ArrayList<>();
            for (TagPath path : paths) {
                TagProvider provider = manager.getTagProvider(path.getSource());
                if (provider == null) {
                    return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                        "No tag provider '" + path.getSource() + "'");
                }
                codes.addAll(provider.removeTagConfigsAsync(new ArrayList<>(List.of(path)), SecurityContext.systemContext())
                    .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS));
            }
            return qualityResult(resp, codes);
        } catch (Exception e) {
            return failure(resp, "Could not delete tags", e);
        }
    }

    // ==================== helpers ====================

    private GatewayTagManager manager() {
        return context == null ? null : context.getTagManager();
    }

    private static Object unavailable(HttpServletResponse resp) {
        return HandlerSupport.error(resp, HttpServletResponse.SC_SERVICE_UNAVAILABLE,
            "The tag manager is not available.");
    }

    private static Object badPath(HttpServletResponse resp) {
        return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
            "Not a valid tag path; expected [provider]folder/tag");
    }

    /** CSRF plus the live execution switch — null when the request may proceed. */
    private static Object mutationGate(RequestContext req, HttpServletResponse resp) {
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        if (!ExecPolicy.executionEnabled()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_FORBIDDEN,
                "Script execution is disabled on this gateway (" + ExecPolicy.PROP_ENABLED
                    + "=false), and changing tags here is the same kind of thing.");
        }
        return null;
    }

    private void audit(RequestContext req, String target, String detail) {
        ExecAudit audit = audits.get();
        if (audit == null) {
            return;
        }
        String username = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse("unknown");
        audit.record(username, req.getRequest().getRemoteAddr(), "", target, detail);
    }

    /** {@code null} when the text does not parse, never an exception. */
    private static TagPath parse(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return TagPathParser.parseSafe(text);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static List<TagPath> parseAll(List<String> texts) {
        List<TagPath> out = new ArrayList<>(texts.size());
        for (String text : texts) {
            TagPath path = parse(text);
            if (path == null) {
                return null;
            }
            out.add(path);
        }
        return out;
    }

    private static <T> T readBody(RequestContext req, Class<T> type) throws IOException {
        try {
            return HandlerSupport.GSON.fromJson(req.readBody(), type);
        } catch (JsonParseException e) {
            return null;
        }
    }

    static CollisionPolicy collisionPolicy(String name) {
        // Abort is the safe default: a create must not overwrite by accident.
        if (name == null) {
            return CollisionPolicy.Abort;
        }
        for (CollisionPolicy policy : CollisionPolicy.values()) {
            if (policy.name().equalsIgnoreCase(name)) {
                return policy;
            }
        }
        return CollisionPolicy.Abort;
    }

    private static Object qualityResult(HttpServletResponse resp, List<QualityCode> codes) {
        JsonArray out = new JsonArray();
        boolean allGood = true;
        for (QualityCode code : codes) {
            out.add(code.toString());
            allGood &= code.isGood();
        }
        JsonObject body = new JsonObject();
        body.addProperty("ok", allGood);
        body.add("results", out);
        return body;
    }

    private static Object failure(HttpServletResponse resp, String message, Exception e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        logger.debug("{}: {}", message, e.toString());
        return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
            message + ": " + (root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage()));
    }

    /** A tag value as plain JSON; anything without a JSON shape is its string form. */
    private static JsonElement jsonValue(Object value) {
        if (value == null) {
            return com.google.gson.JsonNull.INSTANCE;
        }
        if (value instanceof Boolean b) {
            return new com.google.gson.JsonPrimitive(b);
        }
        if (value instanceof Number n) {
            // Beyond 2^53 a JSON number silently rounds in the browser; see
            // DbQueryRouteHandler.MAX_SAFE_INTEGER.
            if (!(n instanceof Double || n instanceof Float)
                && Math.abs(n.longValue()) > DbQueryRouteHandler.MAX_SAFE_INTEGER) {
                return new com.google.gson.JsonPrimitive(n.toString());
            }
            return new com.google.gson.JsonPrimitive(n);
        }
        return new com.google.gson.JsonPrimitive(value.toString());
    }

    /** The Java object a JSON primitive stands for. */
    private static Object plainValue(JsonElement element) {
        if (element.isJsonNull()) {
            return null;
        }
        com.google.gson.JsonPrimitive primitive = element.getAsJsonPrimitive();
        if (primitive.isBoolean()) {
            return primitive.getAsBoolean();
        }
        if (primitive.isNumber()) {
            java.math.BigDecimal number = primitive.getAsBigDecimal();
            try {
                return number.intValueExact();
            } catch (ArithmeticException notInt) {
                return number.doubleValue();
            }
        }
        return primitive.getAsString();
    }

    private static final class PathsRequest {
        List<String> paths;
    }

    private static final class WriteRequest {
        String path;
        JsonElement value;
    }

    private static final class CreateRequest {
        String basePath;
        String json;
        String collision;
    }
}
