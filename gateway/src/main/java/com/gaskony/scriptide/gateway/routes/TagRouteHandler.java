package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.config.ConfigurationPropertyModel;
import com.inductiveautomation.ignition.common.config.DescriptiveProperty;
import com.inductiveautomation.ignition.common.config.Property;
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
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
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
                    if (node.getSubTypeId() != null && !node.getSubTypeId().isEmpty()) {
                        row.addProperty("typeId", node.getSubTypeId());
                    }
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


    // ==================== GET /api/tags/edit?path=... ====================

    /**
     * One tag's own configuration for the editor, children excluded (they are
     * edited individually).
     *
     * <p>Measured on 8.3.8: with {@code localPropsOnly} an atomic tag returns every
     * property it sets itself (inherited UDT-member values are absent), a UDT
     * instance returns only its typeId, parameters and own overrides, and a UDT
     * definition returns its parameters; {@code resolved} (localPropsOnly=false)
     * is identical to it, so the effective configuration is built here: the
     * model's inherited configuration (only filled when localPropsOnly is false;
     * a UDT instance or member carries its type's values, anything else has none)
     * serialised like a config, with the local overrides merged over it. The
     * signature hashes {@code local}, which is what {@link #save} compares.</p>
     */
    public Object edit(RequestContext req, HttpServletResponse resp) {
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        TagPath path = parse(req.getParameter("path"));
        if (path == null) {
            return badPath(resp);
        }
        TagProvider provider = manager.getTagProvider(path.getSource());
        if (provider == null) {
            return noProvider(resp, path);
        }
        try {
            TagConfigurationModel local = fetch(provider, path, false, true);
            String localJson = local == null ? null : toJson(local);
            if (localJson == null || isUnknown(localJson)) {
                return noTag(resp, req.getParameter("path"));
            }
            JsonObject inherited = inheritedJson(path, fetch(provider, path, false, false));
            JsonObject resolved = merge(inherited, parseObject(localJson));
            JsonObject body = new JsonObject();
            body.addProperty("local", localJson);
            body.addProperty("resolved", HandlerSupport.PRETTY_GSON.toJson(resolved));
            body.add("inherited", inherited);
            body.addProperty("signature", signature(localJson));
            body.addProperty("tagType", tagTypeOf(localJson));
            body.addProperty("isInherited", local.isInherited());
            body.addProperty("udtMember", local.isUdtMember());
            return body;
        } catch (Exception e) {
            return failure(resp, "Could not read '" + req.getParameter("path") + "' for editing", e);
        }
    }

    // ==================== POST /api/tags/save  {path, json, signature} ====================

    /**
     * Replace one tag's own configuration. Overwrite is what makes a property
     * absent from the JSON revert to its default or inherited value (MergeOverwrite
     * keeps the old one). But Overwrite also drops the children of a UDT definition
     * or instance (a folder merges), so the existing children are re-attached to
     * the document before saving.
     */
    public Object save(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        SaveRequest body = readBody(req, SaveRequest.class);
        if (body == null || body.path == null || body.json == null || body.signature == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'path', 'json' and 'signature'");
        }
        TagPath path = parse(body.path);
        if (path == null) {
            return badPath(resp);
        }
        TagProvider provider = manager.getTagProvider(path.getSource());
        if (provider == null) {
            return noProvider(resp, path);
        }
        JsonObject edited = parseObject(body.json);
        if (edited == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "'json' must be one JSON object, the tag's configuration");
        }
        try {
            TagConfigurationModel local = fetch(provider, path, false, true);
            String currentJson = local == null ? null : toJson(local);
            if (currentJson == null || isUnknown(currentJson)) {
                return noTag(resp, body.path);
            }
            String currentSignature = signature(currentJson);
            if (!currentSignature.equals(body.signature)) {
                JsonObject conflict = HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                    "'" + body.path + "' changed on the gateway since it was opened");
                conflict.addProperty("signature", currentSignature);
                return conflict;
            }
            String problem = identityProblem(edited, path.getItemName(), tagTypeOf(currentJson));
            if (problem != null) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, problem);
            }
            edited.addProperty("name", path.getItemName());
            JsonObject existing = parseObject(toJson(fetch(provider, path, true, true)));
            if (existing != null && existing.has("tags")) {
                edited.add("tags", existing.get("tags"));
            } else {
                edited.remove("tags");
            }
            audit(req, "tag-save:" + body.path, body.json);
            List<TagConfiguration> configs;
            try {
                configs = TagUtilities.toTagConfiguration(HandlerSupport.GSON.toJson(edited), path.getParentPath());
            } catch (Exception e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "Not a valid tag configuration: " + rootMessage(e));
            }
            List<QualityCode> codes = provider
                .saveTagConfigsAsync(configs, CollisionPolicy.Overwrite, SecurityContext.systemContext())
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            JsonObject result = (JsonObject) qualityResult(resp, codes);
            TagConfigurationModel after = fetch(provider, path, false, true);
            if (after != null) {
                result.addProperty("signature", signature(toJson(after)));
            }
            return result;
        } catch (Exception e) {
            return failure(resp, "Could not save '" + body.path + "'", e);
        }
    }

    // ==================== POST /api/tags/model  {path, json} ====================

    /**
     * The properties that apply to a configuration, so the form shows only what
     * the platform would. Measured: the history sub-properties appear only with
     * historyEnabled=true (sampleMode swaps the minimum-time pair for
     * historySampleRate* or historyTagGroup), a valueSource swaps its own set,
     * scaleMode other than Off adds rawLow..clampMode, deadbandMode Off drops
     * deadband, and alarms are a single {@code alarms} property whose members
     * are not described here. The generic model serves every tag type.
     */
    public Object model(RequestContext req, HttpServletResponse resp) throws IOException {
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        ModelRequest body = readBody(req, ModelRequest.class);
        if (body == null || body.path == null || body.json == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'path' and 'json'");
        }
        TagPath path = parse(body.path);
        if (path == null) {
            return badPath(resp);
        }
        TagProvider provider = manager.getTagProvider(path.getSource());
        if (provider == null) {
            return noProvider(resp, path);
        }
        List<TagConfiguration> configs;
        try {
            configs = TagUtilities.toTagConfiguration(body.json, parse("[" + path.getSource() + "]"));
        } catch (Exception e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Not a valid tag configuration: " + rootMessage(e));
        }
        if (configs == null || configs.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "'json' holds no tag configuration");
        }
        try {
            ConfigurationPropertyModel model = provider.getTagConfigModelAsync()
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            JsonArray out = new JsonArray();
            for (Property<?> property : model.getApplicableProperties(configs.get(0), false)) {
                out.add(describe(model, property));
            }
            JsonObject result = new JsonObject();
            result.add("properties", out);
            return result;
        } catch (Exception e) {
            return failure(resp, "Could not read the property model", e);
        }
    }

    // ==================== POST /api/tags/rename  {path, newName} ====================

    public Object rename(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        RenameRequest body = readBody(req, RenameRequest.class);
        if (body == null || body.path == null || body.newName == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'path' and 'newName'");
        }
        TagPath path = parse(body.path);
        if (path == null) {
            return badPath(resp);
        }
        if (!validName(body.newName)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "A tag name cannot be blank or contain / [ ] or leading/trailing spaces");
        }
        if (manager.getTagProvider(path.getSource()) == null) {
            return noProvider(resp, path);
        }
        // Checked here because the platform's own refusal reads "The path ...
        // cannot accept tags", which says nothing about the name being taken.
        if (siblingExists(manager, path, body.newName)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "A tag named '" + body.newName + "' already exists there");
        }
        audit(req, "tag-rename:" + body.path, body.newName);
        try {
            List<QualityCode> codes = manager
                .renameTag(path, body.newName, CollisionPolicy.Abort, SecurityContext.systemContext())
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return qualityResult(resp, codes);
        } catch (Exception e) {
            return failure(resp, "Could not rename '" + body.path + "'", e);
        }
    }

    /** Tag names are case-insensitive in Ignition, so "Pump" collides with "pump". */
    private static boolean siblingExists(GatewayTagManager manager, TagPath path, String newName) {
        TagPath parent = path.getParentPath();
        if (parent == null || newName.equalsIgnoreCase(path.getItemName())) {
            return false;
        }
        try {
            Results<NodeDescription> results = manager
                .browseAsync(parent, BrowseFilter.NONE, SecurityContext.systemContext())
                .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (results == null || results.getResults() == null) {
                return false;
            }
            for (NodeDescription node : results.getResults()) {
                if (newName.equalsIgnoreCase(node.getName())) {
                    return true;
                }
            }
        } catch (Exception e) {
            // Unknown is not "taken": let the platform's own check decide.
            logger.debug("Sibling check failed for '{}': {}", path, e.toString());
        }
        return false;
    }

    // ==================== POST /api/tags/move  {paths, destination, copy, collision} ====================

    /**
     * Move or copy tags. A copy into the folder the tag already sits in defaults
     * to Rename (so duplicate works); the platform picks the next free name by
     * counting up the trailing number, T1 -> T2 -> T3.
     */
    public Object move(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        MoveRequest body = readBody(req, MoveRequest.class);
        if (body == null || body.paths == null || body.paths.isEmpty() || body.destination == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'paths' and 'destination'");
        }
        if (body.paths.size() > MAX_READ_PATHS) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "At most " + MAX_READ_PATHS + " paths per move");
        }
        List<TagPath> paths = parseAll(body.paths);
        TagPath destination = parse(body.destination);
        if (paths == null || destination == null) {
            return badPath(resp);
        }
        for (TagPath path : paths) {
            if (!path.getSource().equals(destination.getSource())) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "Every path and the destination must be in the same tag provider");
            }
        }
        if (manager.getTagProvider(destination.getSource()) == null) {
            return noProvider(resp, destination);
        }
        boolean copy = Boolean.TRUE.equals(body.copy);
        boolean sameParent = true;
        for (TagPath path : paths) {
            sameParent &= path.getParentPath().toStringFull().equals(destination.toStringFull());
        }
        CollisionPolicy policy = moveCollisionPolicy(body.collision, copy && sameParent);
        audit(req, (copy ? "tag-copy:" : "tag-move:") + body.destination,
            String.join("\n", body.paths) + "\n" + policy);
        try {
            List<QualityCode> codes = manager
                .moveTagsAsync(new ArrayList<>(paths), destination, copy, policy, SecurityContext.systemContext())
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return qualityResult(resp, codes);
        } catch (Exception e) {
            return failure(resp, "Could not " + (copy ? "copy" : "move") + " tags to '" + body.destination + "'", e);
        }
    }

    // ==================== POST /api/tags/import  {basePath, content, format, collision} ====================

    /**
     * Import an export. The platform's format strings are {@code json} (the
     * {@code system.tag.exportTags} shape, either one tag or {"tags":[..]}) and
     * {@code xml}. The 8.x Designer export (it carries {@code MinVersion}) imports
     * faithfully as it stands, nested under the base path. A pre-8 document is the
     * flat format whose {@code path} attributes count from the provider root and
     * which the platform imports there regardless of the base path, so those
     * attributes are rebased under it first ({@link TagXml}).
     */
    public Object importTags(RequestContext req, HttpServletResponse resp) throws IOException {
        Object gate = mutationGate(req, resp);
        if (gate != null) {
            return gate;
        }
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        ImportRequest body = readBody(req, ImportRequest.class);
        if (body == null || body.basePath == null || body.content == null || body.content.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'basePath' and 'content'");
        }
        String format = body.format == null ? "json" : body.format.toLowerCase(Locale.ROOT);
        if (!IMPORT_FORMATS.contains(format)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "'format' must be json or xml");
        }
        TagPath base = parse(body.basePath);
        if (base == null) {
            return badPath(resp);
        }
        TagProvider provider = manager.getTagProvider(base.getSource());
        if (provider == null) {
            return noProvider(resp, base);
        }
        audit(req, "tag-import:" + body.basePath, format + " " + body.content.length() + " chars");
        try {
            String content = body.content;
            if ("xml".equals(format) && !TagXml.isCurrentFormat(content)) {
                content = TagXml.rebaseLegacy(content, base.toStringPartial());
            }
            List<QualityCode> codes = provider
                .importTagsAsync(base, content, format, collisionPolicy(body.collision),
                    SecurityContext.systemContext())
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return qualityResult(resp, codes);
        } catch (Exception e) {
            return failure(resp, "Could not import tags under '" + body.basePath + "'", e);
        }
    }

    // ==================== GET /api/tags/export?path=a&path=b ====================

    /**
     * The recursive configuration of one tag, or {"tags":[..]} for several, as
     * {@code system.tag.exportTags} writes ({@code json}); with {@code format=xml}
     * the Designer's XML export, produced by the platform's own exporter.
     */
    public Object export(RequestContext req, HttpServletResponse resp) {
        GatewayTagManager manager = manager();
        if (manager == null) {
            return unavailable(resp);
        }
        String format = req.getRequest().getParameter("format");
        format = format == null || format.isBlank() ? "json" : format.toLowerCase(Locale.ROOT);
        if (!IMPORT_FORMATS.contains(format)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, "'format' must be json or xml");
        }
        String[] raw = req.getRequest().getParameterValues("path");
        if (raw == null || raw.length == 0 || raw.length > MAX_READ_PATHS) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Give between 1 and " + MAX_READ_PATHS + " 'path' parameters");
        }
        List<TagPath> paths = parseAll(List.of(raw));
        if (paths == null) {
            return badPath(resp);
        }
        if ("xml".equals(format)) {
            return exportXml(manager, paths, raw, resp);
        }
        try {
            JsonArray tags = new JsonArray();
            for (int i = 0; i < paths.size(); i++) {
                TagProvider provider = manager.getTagProvider(paths.get(i).getSource());
                if (provider == null) {
                    return noProvider(resp, paths.get(i));
                }
                TagConfigurationModel model = fetch(provider, paths.get(i), true, false);
                String json = model == null ? null : toJson(model);
                if (json == null || isUnknown(json)) {
                    return noTag(resp, raw[i]);
                }
                tags.add(JsonParser.parseString(json));
            }
            JsonObject body = new JsonObject();
            if (tags.size() == 1) {
                body.addProperty("json", HandlerSupport.PRETTY_GSON.toJson(tags.get(0)));
            } else {
                JsonObject wrapper = new JsonObject();
                wrapper.add("tags", tags);
                body.addProperty("json", HandlerSupport.PRETTY_GSON.toJson(wrapper));
            }
            return body;
        } catch (Exception e) {
            return failure(resp, "Could not export tags", e);
        }
    }

    private Object exportXml(GatewayTagManager manager, List<TagPath> paths, String[] raw,
                             HttpServletResponse resp) {
        try {
            for (int i = 0; i < paths.size(); i++) {
                TagProvider provider = manager.getTagProvider(paths.get(i).getSource());
                if (provider == null) {
                    return noProvider(resp, paths.get(i));
                }
                TagConfigurationModel model = fetch(provider, paths.get(i), false, true);
                String json = model == null ? null : toJson(model);
                if (json == null || isUnknown(json)) {
                    return noTag(resp, raw[i]);
                }
            }
            String xml = TagXmlExport.export(paths, manager::getTagProvider);
            JsonObject body = new JsonObject();
            body.addProperty("xml", xml);
            return body;
        } catch (TagXmlExport.Unavailable e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_IMPLEMENTED,
                "This gateway cannot write the XML export; use JSON.");
        } catch (Exception e) {
            return failure(resp, "Could not export tags", e);
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

    /** The tag's configuration, or {@code null} when the platform returns none. */
    private static TagConfigurationModel fetch(TagProvider provider, TagPath path, boolean recursive,
                                               boolean localOnly) throws Exception {
        // Mutable: the platform sorts the list in place.
        List<TagPath> one = new ArrayList<>();
        one.add(path);
        List<TagConfigurationModel> models = provider.getTagConfigsAsync(one, recursive, localOnly)
            .get(TIMEOUT_SECONDS, TimeUnit.SECONDS);
        return models == null || models.isEmpty() ? null : models.get(0);
    }

    /** What the tag inherits from its UDT definition as config JSON, without the identity keys; empty if nothing. */
    private static JsonObject inheritedJson(TagPath path, TagConfigurationModel effective) {
        if (effective == null || effective.getInheritedConfiguration() == null) {
            return new JsonObject();
        }
        List<TagConfiguration> configs = TagUtilities.toTagConfiguration(path, effective.getInheritedConfiguration());
        JsonObject out = configs == null || configs.isEmpty() ? null
            : parseObject(TagUtilities.jsonToString(TagUtilities.toJsonObject(configs.get(0))));
        if (out == null) {
            return new JsonObject();
        }
        // The definition's own name and type are not the instance's.
        out.remove("name");
        out.remove("tagType");
        return out;
    }

    /** {@code over} laid on {@code base}, objects merged key by key and everything else replaced; neither is changed. */
    static JsonObject merge(JsonObject base, JsonObject over) {
        JsonObject out = base.deepCopy();
        for (var entry : over.entrySet()) {
            JsonElement existing = out.get(entry.getKey());
            if (existing != null && existing.isJsonObject() && entry.getValue().isJsonObject()) {
                out.add(entry.getKey(), merge(existing.getAsJsonObject(), entry.getValue().getAsJsonObject()));
            } else {
                out.add(entry.getKey(), entry.getValue().deepCopy());
            }
        }
        return out;
    }

    private static String toJson(TagConfigurationModel model) throws Exception {
        return TagUtilities.jsonToString(TagUtilities.toJsonObject(model));
    }

    /** A path with no tag behind it comes back as a model of type Unknown, not as null. */
    private static boolean isUnknown(String json) {
        return "Unknown".equals(tagTypeOf(json));
    }

    private static String tagTypeOf(String json) {
        JsonObject object = parseObject(json);
        return object != null && object.has("tagType") ? object.get("tagType").getAsString() : "Unknown";
    }

    /** {@code null} when the text is not exactly one JSON object. */
    static JsonObject parseObject(String text) {
        try {
            JsonElement element = JsonParser.parseString(text);
            return element.isJsonObject() ? element.getAsJsonObject() : null;
        } catch (JsonParseException e) {
            return null;
        }
    }

    /** SHA-256 hex of the text: the same configuration always yields the same signature. */
    static String signature(String text) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is required of every JRE", e);
        }
    }

    /** A new tag name must be non-blank and free of the path delimiters. */
    static boolean validName(String name) {
        return name != null && !name.isBlank() && name.equals(name.strip())
            && name.indexOf('/') < 0 && name.indexOf('[') < 0 && name.indexOf(']') < 0;
    }

    /** Why an edited document may not be saved over this tag, or {@code null}. Rename and retype are separate acts. */
    static String identityProblem(JsonObject edited, String currentName, String currentType) {
        if (edited.has("name") && !currentName.equals(edited.get("name").getAsString())) {
            return "The name cannot change here; use rename";
        }
        if (edited.has("tagType") && !currentType.equals(edited.get("tagType").getAsString())) {
            return "The tag type cannot change";
        }
        return null;
    }

    /**
     * The policy for a move or copy: the named one, else Rename for a copy into
     * the tag's own folder (a duplicate), else Abort.
     */
    static CollisionPolicy moveCollisionPolicy(String name, boolean duplicate) {
        if (name == null || name.isBlank()) {
            return duplicate ? CollisionPolicy.Rename : CollisionPolicy.Abort;
        }
        return collisionPolicy(name);
    }

    private static final Set<String> IMPORT_FORMATS = Set.of("json", "xml");

    private static final Set<String> CATEGORIES =
        Set.of("core", "value", "numeric", "meta", "security", "scripting", "alarms", "history", "parameters");

    private static final String CATEGORY_PREFIX = "tags.editing.category.";

    private static JsonObject describe(ConfigurationPropertyModel model, Property<?> property) {
        JsonObject row = new JsonObject();
        row.addProperty("name", property.getName());
        row.addProperty("type", property.getType().getSimpleName());
        row.add("default", plain(property.getDefaultValue()));
        Optional<? extends Collection<?>> allowed = allowedValues(model, property);
        if (allowed.isPresent()) {
            JsonArray values = new JsonArray();
            for (Object value : allowed.get()) {
                values.add(plain(value));
            }
            row.add("allowedValues", values);
        } else {
            row.add("allowedValues", com.google.gson.JsonNull.INSTANCE);
        }
        String category = "other";
        String label = null;
        if (property instanceof DescriptiveProperty<?> descriptive) {
            category = categoryOf(descriptive.getCategory() == null ? null : descriptive.getCategory().getKey());
            String shown = descriptive.getDisplayName() == null ? null : descriptive.getDisplayName().toString();
            // An unresolved key renders as ¿key?; the frontend supplies those labels.
            label = shown == null || shown.startsWith("¿") ? null : shown;
        }
        row.addProperty("category", category);
        row.addProperty("label", label);
        return row;
    }

    private static <T> Optional<Collection<T>> allowedValues(ConfigurationPropertyModel model, Property<T> property) {
        return model.getAllowedValues(property);
    }

    static String categoryOf(String key) {
        if (key != null && key.startsWith(CATEGORY_PREFIX)) {
            String name = key.substring(CATEGORY_PREFIX.length());
            if (CATEGORIES.contains(name)) {
                return name;
            }
        }
        return "other";
    }

    /** A property value as plain JSON: enums by name, a qualified value as its value, the rest as text. */
    static JsonElement plain(Object value) {
        if (value == null) {
            return com.google.gson.JsonNull.INSTANCE;
        }
        if (value instanceof QualifiedValue qualified) {
            return plain(qualified.getValue());
        }
        if (value instanceof Boolean b) {
            return new JsonPrimitive(b);
        }
        if (value instanceof Number n) {
            double d = n.doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? new JsonPrimitive(n.toString()) : new JsonPrimitive(n);
        }
        if (value instanceof Enum<?> e) {
            return new JsonPrimitive(e.name());
        }
        return new JsonPrimitive(value.toString());
    }

    private static Object noProvider(HttpServletResponse resp, TagPath path) {
        return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
            "No tag provider '" + path.getSource() + "'");
    }

    private static Object noTag(HttpServletResponse resp, String path) {
        return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND, "No tag at '" + path + "'");
    }

    private static String rootMessage(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage();
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
        logger.debug("{}: {}", message, e.toString());
        return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY, message + ": " + rootMessage(e));
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

    private static final class SaveRequest {
        String path;
        String json;
        String signature;
    }

    private static final class ModelRequest {
        String path;
        String json;
    }

    private static final class RenameRequest {
        String path;
        String newName;
    }

    private static final class MoveRequest {
        List<String> paths;
        String destination;
        Boolean copy;
        String collision;
    }

    private static final class ImportRequest {
        String basePath;
        String content;
        String format;
        String collision;
    }

    private static final class CreateRequest {
        String basePath;
        String json;
        String collision;
    }
}
