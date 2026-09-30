package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.inductiveautomation.ignition.common.ImmutableBytes;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.ChangeOperation;
import com.inductiveautomation.ignition.common.resourcecollection.PushException;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.RuntimeResourceCollection;
import com.inductiveautomation.ignition.common.user.ZoneRoleRequirement;
import com.inductiveautomation.ignition.common.util.TimeUnits;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.datasource.Datasource;
import com.inductiveautomation.ignition.gateway.datasource.DatasourceManager;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import com.inductiveautomation.ignition.gateway.resourcecollection.PushOperation;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Lists, reads, writes, renames and deletes named queries.
 *
 * <p>The same shape as {@link ScriptResourceRouteHandler}, and deliberately so —
 * the two surfaces edit resources in the same project collection, through the same
 * {@code ProjectManager#push}, with the same optimistic concurrency. Everything
 * below that is different is different because the platform is.</p>
 *
 * <h2>Read through the serialiser, write through the serialiser</h2>
 *
 * <p>Settings are read with {@code NamedQuery.fromResource} and written with
 * {@code NamedQuery.toResource}. Never by hand: the parameter list alone has a
 * shape nobody would guess ({@code sqlType} is the DataType's INT on disk and its
 * NAME on the wire), and a hand-built resource can be byte-perfect and still be
 * ignored — the same lesson as {@code ModuleLibrary.serializeScript} for scripts.
 * {@link NamedQueryCodec} is the only place the conversion lives.</p>
 *
 * <h2>The SQL comes from the data key, not from the parsed query</h2>
 *
 * <p>{@link #readContent} reads the {@code query.sql} data key directly rather
 * than {@code NamedQuery.getQuery()}. That is what makes a legacy
 * ({@code version: 1}) resource open at all: such a resource parses to a BLANK
 * NamedQuery — measured, and the gateway's own {@code system.db.runNamedQuery}
 * fails on one with an NPE — but its SQL file is real, readable and the only copy
 * of the user's work. Reading it through the parse would show an empty editor for
 * a file that plainly has content. See {@code docs/NAMED-QUERIES.md} §1.5.</p>
 *
 * <h2>Two lookups that must never be "aligned"</h2>
 *
 * <p>As in the script handler: reads resolve through the inheritance-MERGED
 * collection so an inherited query opens, and writes use the OWN-project lookup so
 * editing an inherited query creates a local override rather than pushing a modify
 * against the parent's copy.</p>
 *
 * <h2>Byte fidelity</h2>
 *
 * <p>{@code toResource} writes {@code getQuery()} as UTF-8 and does nothing else
 * — measured: no trailing newline is added, and one that was there is preserved.
 * So the SQL this handler stores is exactly the string the client sent.
 * {@code NamedQueryByteFidelityTest} asserts it against the real serialiser.</p>
 */
public final class NamedQueryRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(NamedQueryRouteHandler.class);

    /** The one data key a named-query resource carries. */
    static final String QUERY_FILE = "query.sql";

    private final ProjectManager projectManager;
    private final GatewayContext context;

    public NamedQueryRouteHandler(ProjectManager projectManager, GatewayContext context) {
        this.projectManager = projectManager;
        this.context = context;
    }

    // ==================== GET /api/named-queries ====================

    /**
     * Every named query in one project.
     *
     * <p>Enumerates {@code getResources()} — the inheritance-EFFECTIVE merged map
     * — never {@code getAllResources()}, which double-lists every overridden
     * resource.</p>
     */
    public Object list(RequestContext req, HttpServletResponse resp) {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        Optional<RuntimeResourceCollection> collectionOpt = projectManager.find(project);
        if (collectionOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }

        JsonArray queries = new JsonArray();
        for (Resource resource : collectionOpt.get().getResources()) {
            ResourcePath path = resource.getResourcePath();
            if (!NamedQuery.RESOURCE_TYPE.equals(path.getResourceType())) {
                continue;
            }
            // The type's own folder. The platform reports `ignition/named-query`
            // as a resource in its own right once the project holds any query at
            // all — a real signature, an empty name, no data keys. Listed, it
            // renders as a row labelled after the type; addressable, it is
            // writable. Same trap as the event-script folders in
            // ScriptResourceRouteHandler#isNamelessNonSingleton.
            if (path.isResourceTypeFolder()) {
                continue;
            }
            queries.add(describe(resource, path, project));
        }

        JsonObject body = new JsonObject();
        body.addProperty("project", project);
        body.addProperty("mutable", isMutable(project));
        body.add("queries", queries);
        return body;
    }

    /**
     * One listing row.
     *
     * <p>{@code type}, {@code database} and {@code enabled} are on the LISTING so
     * the tree can badge a disabled query and show its connection without a
     * request per row. They are omitted entirely on a {@code legacy} row: the
     * platform cannot read that resource's attributes either, and printing values
     * the gateway ignores is how a broken resource comes to look healthy.</p>
     */
    private JsonObject describe(Resource resource, ResourcePath path, String project) {
        JsonObject out = new JsonObject();
        String name = path.getPath().toString();
        out.addProperty("path", name);
        out.addProperty("name", path.getName());
        // Derived from the path text, not from ResourcePath#getFolderPath — that
        // returns the resource's own path here, not its parent, so using it put
        // every query in a folder named after itself.
        int lastSlash = name.lastIndexOf('/');
        out.addProperty("folder", lastSlash < 0 ? "" : name.substring(0, lastSlash));
        out.addProperty("signature", resource.getResourceSignature().toString());
        out.addProperty("version", resource.getVersion());

        // A folder is a resource with a name and no data. Same discriminator as
        // ScriptResourceRouteHandler#isPackageContainer, and the same reason: an
        // empty folder must render as an empty folder rather than vanish, and must
        // never be openable — reading it 404s with "No such data key".
        boolean isFolder = resource.isFolder() || resource.getDataKeys().isEmpty();
        out.addProperty("isFolder", isFolder);

        if (!isFolder) {
            // `legacy` is a FLAG, never a repair. A version-1 resource reads back
            // as the platform's defaults because the platform reads it that way
            // too — see docs/NAMED-QUERIES.md §1.5 — and nothing here rewrites it.
            // Upgrading it silently on a listing would turn a read into a write.
            out.addProperty("legacy", NamedQueryCodec.isLegacy(resource));
            try {
                NamedQuery q = NamedQueryCodec.read(resource);
                // Always published, legacy or not. Omitting them on a legacy row
                // makes the client special-case a row shape, and the defaults are
                // the honest answer: they are exactly what the gateway sees.
                out.addProperty("type", q.getType().name());
                out.addProperty("database", q.getDatabase() == null ? "" : q.getDatabase());
                out.addProperty("enabled", q.isEnabled());
            } catch (Exception e) {
                // Somebody else's malformed resource, not our failure. The row
                // still lists — a query that cannot be summarised must still be
                // openable, or it becomes uneditable with nothing on screen
                // saying why.
                logger.debug("Could not parse named query {} in {}: {}",
                    path, project, e.toString());
                out.addProperty("unreadable", true);
            }
        }

        String owner = null;
        try {
            owner = resource.getDefiningCollectionName();
        } catch (Exception e) {
            logger.debug("getDefiningCollectionName failed for {}: {}", path, e.getMessage());
        }
        boolean ownedHere = project.equals(owner);
        List<String> definedIn;
        try {
            definedIn = resource.getDefiningCollectionNames();
        } catch (Exception e) {
            definedIn = List.of();
        }
        out.addProperty("origin", ownedHere
            ? (definedIn.size() > 1
                ? ScriptResourceRouteHandler.ORIGIN_OVERRIDE
                : ScriptResourceRouteHandler.ORIGIN_LOCAL)
            : ScriptResourceRouteHandler.ORIGIN_INHERITED);
        out.addProperty("owner", owner == null ? project : owner);
        return out;
    }

    // ==================== GET /api/named-queries/content/:path ====================

    /** The SQL of one query, as raw UTF-8, with its resource signature as the ETag. */
    public Object readContent(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = decodeQueryPath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        Optional<Resource> resourceOpt = findMerged(project, path);
        if (resourceOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such named query: " + path.getPath() + " in project " + project);
        }
        Resource resource = resourceOpt.get();
        Optional<ImmutableBytes> dataOpt = resource.getData(QUERY_FILE);

        resp.setHeader("ETag",
            HandlerSupport.quoteEtag(resource.getResourceSignature().toString()));
        // text/plain, not application/json: this is SQL, and a JSON content type
        // makes browsers and proxies try to parse it.
        resp.setContentType("text/plain; charset=UTF-8");
        // A folder resource has no query.sql. Answer empty rather than 404: the
        // client asked for a path the listing gave it, and an empty body is what
        // an empty query legitimately looks like.
        byte[] bytes = dataOpt.map(ImmutableBytes::getBytes).orElse(new byte[0]);
        resp.setContentLength(bytes.length);
        resp.getOutputStream().write(bytes);
        return null;
    }

    // ==================== POST /api/named-queries/content/:path ====================

    /**
     * Write the SQL of one query, creating it if this project does not define it.
     *
     * <p>Status map, matching the script routes exactly: 400 bad input, 403 CSRF,
     * 404 missing project, 409 signature mismatch or push conflict, 428 modify
     * without a base signature, 502 push failure.</p>
     */
    public Object writeContent(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = decodeQueryPath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        SqlRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), SqlRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.sql == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'sql' field");
        }

        Object refusal = requireMutableProject(project, resp);
        if (refusal != null) {
            return refusal;
        }

        // OWN-project lookup: editing an inherited query must create a local
        // override, so "absent" here is correct and takes the create branch.
        Optional<Resource> existingOpt = projectManager.getResource(project, path);
        String expected = HandlerSupport.expectedSignature(req, body.baseSignature);

        ChangeOperation op;
        NamedQuery q;
        Resource existing = existingOpt.orElse(null);
        if (existing == null) {
            Optional<Resource> inherited = findMerged(project, path);
            if (inherited.isPresent()) {
                // Overriding an inherited query: start from what the parent holds,
                // so the override keeps its parameters and settings and changes
                // only the SQL. Building a default here would silently drop them.
                try {
                    q = NamedQueryCodec.read(inherited.get());
                } catch (Exception e) {
                    return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                        "Could not read the inherited query to override it: " + e.getMessage());
                }
            } else {
                q = newQuery();
            }
        } else {
            Object stale = checkSignature(existing, expected, resp,
                "read the query before updating it");
            if (stale != null) {
                return stale;
            }
            try {
                q = NamedQueryCodec.read(existing);
            } catch (Exception e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                    "Could not read the existing query: " + e.getMessage());
            }
        }

        // Settings may ride along with the SQL. Ctrl+S in the editor saves both,
        // and doing it in one push against one signature is the only way the two
        // cannot disagree: two requests means the second one races the signature
        // the first one just changed, and the user sees a spurious conflict on
        // their own save.
        if (body.settings != null) {
            try {
                NamedQueryCodec.apply(q, body.settings);
            } catch (NamedQueryCodec.BadValueException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
        }
        q.setQuery(body.sql);

        op = (existing == null)
            ? ChangeOperation.newCreateOp(build(project, path, q, null))
            : ChangeOperation.newModifyOp(build(project, path, q, existing),
                existing.getResourceSignature());

        Object pushError = push(List.of(op), project, path, req, resp);
        if (pushError != null) {
            return pushError;
        }
        return okWithSignature(project, path);
    }

    // ==================== GET /api/named-queries/settings/:path ====================

    /** Everything the Designer's Settings and Authoring tabs hold except the SQL. */
    public Object readSettings(RequestContext req, HttpServletResponse resp) {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = decodeQueryPath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Optional<Resource> resourceOpt = findMerged(project, path);
        if (resourceOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such named query: " + path.getPath() + " in project " + project);
        }
        Resource resource = resourceOpt.get();

        NamedQuery q;
        try {
            q = NamedQueryCodec.read(resource);
        } catch (Exception e) {
            logger.debug("Could not parse named query {} in {}: {}", path, project, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "This query's settings could not be read: " + e.getMessage());
        }

        JsonObject out = new JsonObject();
        out.addProperty("path", path.getPath().toString());
        out.addProperty("signature", resource.getResourceSignature().toString());
        out.addProperty("version", resource.getVersion());
        // Surfaced, not hidden. A version-1 resource reads back blank because the
        // platform cannot read it either, and the UI has to be able to say that
        // rather than present an empty form that looks like a new query.
        out.addProperty("legacy", NamedQueryCodec.isLegacy(resource));
        String owner = resource.getDefiningCollectionName();
        out.addProperty("owner", owner == null ? project : owner);
        out.addProperty("origin", project.equals(owner)
            ? (resource.getDefiningCollectionNames().size() > 1
                ? ScriptResourceRouteHandler.ORIGIN_OVERRIDE
                : ScriptResourceRouteHandler.ORIGIN_LOCAL)
            : ScriptResourceRouteHandler.ORIGIN_INHERITED);
        out.addProperty("mutable", isMutable(project));
        out.add("settings", NamedQueryCodec.toJson(q, resource.getDocumentation()));

        JsonArray editable = new JsonArray();
        NamedQueryCodec.EDITABLE_KEYS.forEach(editable::add);
        out.add("editable", editable);
        out.add("databases", databaseNames());
        out.add("vocabulary", vocabulary());
        return out;
    }

    /**
     * The name of every database connection on this gateway, for the dropdown.
     *
     * <p>From the datasource manager rather than from a query of the internal DB:
     * it is the same list the Designer shows, it is live, and it needs no
     * connection of its own.</p>
     */
    private JsonArray databaseNames() {
        JsonArray out = new JsonArray();
        if (context == null) {
            return out;
        }
        try {
            DatasourceManager manager = context.getDatasourceManager();
            for (Datasource datasource : manager.getDatasources()) {
                out.add(datasource.getName());
            }
        } catch (Exception e) {
            // A gateway with no datasource manager is not a reason to fail the
            // whole settings read — the dropdown just has nothing in it.
            logger.debug("Could not list datasources: {}", e.toString());
        }
        return out;
    }

    /** The allowed values for every enum the settings carry, so the UI need not hardcode them. */
    private static JsonObject vocabulary() {
        JsonObject out = new JsonObject();
        out.add("type", names(NamedQueryCodec.queryTypeNames()));
        out.add("parameterType", names(NamedQueryCodec.parameterTypeNames()));
        out.add("sqlType", names(NamedQueryCodec.sqlTypeNames()));
        out.add("cacheUnit", names(NamedQueryCodec.cacheUnitNames()));
        return out;
    }

    private static JsonArray names(java.util.Collection<String> values) {
        JsonArray out = new JsonArray();
        values.forEach(out::add);
        return out;
    }

    // ==================== POST /api/named-queries/settings/:path ====================

    /**
     * Apply a settings object to one query.
     *
     * <p>A partial update onto the query parsed from the current resource, then
     * written back through {@code toResource}. That is what preserves the fields
     * this release does not edit — a syntax provider set by the Designer survives
     * because nothing here touches it. An unknown key is a 400: a key the platform
     * never reads is how a resource comes to look right and behave wrongly.</p>
     */
    public Object writeSettings(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = decodeQueryPath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        SettingsRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), SettingsRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.settings == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'settings' object");
        }

        Object refusal = requireMutableProject(project, resp);
        if (refusal != null) {
            return refusal;
        }

        Optional<Resource> existingOpt = projectManager.getResource(project, path);
        String expected = HandlerSupport.expectedSignature(req, body.baseSignature);

        NamedQuery q;
        Resource existing = null;
        if (existingOpt.isEmpty()) {
            Optional<Resource> inherited = findMerged(project, path);
            if (inherited.isEmpty()) {
                // Settings alone never create a query. A create goes through the
                // content route, which is the one that knows what SQL to store,
                // and this way a typo'd path cannot conjure an empty resource.
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No such named query: " + path.getPath() + " in project " + project);
            }
            try {
                q = NamedQueryCodec.read(inherited.get());
            } catch (Exception e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                    "Could not read the inherited query to override it: " + e.getMessage());
            }
        } else {
            existing = existingOpt.get();
            Object stale = checkSignature(existing, expected, resp,
                "read the query before updating it");
            if (stale != null) {
                return stale;
            }
            try {
                q = NamedQueryCodec.read(existing);
            } catch (Exception e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                    "Could not read the existing query: " + e.getMessage());
            }
        }

        try {
            NamedQueryCodec.apply(q, body.settings);
        } catch (NamedQueryCodec.BadValueException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        if (q.getQuery() == null) {
            // toResource NPEs on a null query text. That happens for a legacy
            // resource, whose SQL lives in the data key the parse never read: keep
            // the bytes that are on disk rather than blanking them.
            q.setQuery(existingSql(existingOpt.orElse(null), project, path));
        }

        ChangeOperation op = (existing == null)
            ? ChangeOperation.newCreateOp(build(project, path, q, null))
            : ChangeOperation.newModifyOp(build(project, path, q, existing),
                existing.getResourceSignature());

        Object pushError = push(List.of(op), project, path, req, resp);
        if (pushError != null) {
            return pushError;
        }
        return okWithSignature(project, path);
    }

    // ==================== DELETE /api/named-queries/content/:path ====================

    /**
     * Delete one named query.
     *
     * <p>{@code If-Match} is required rather than optional, for the reason the
     * script delete gives: {@code newDeleteOp} takes a signature carrying both the
     * resource id AND its version, so requiring the caller to have read the
     * resource means we can refuse to delete one that changed underneath them.</p>
     *
     * <p>The OWN-project lookup makes an inherited-only query a 404. That is
     * honest: there is nothing in THIS project to delete, and a merged lookup
     * would find the parent's copy and delete that — silently editing a different
     * project than the one in the URL.</p>
     */
    public Object delete(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath path;
        try {
            path = decodeQueryPath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        Object refusal = requireMutableProject(project, resp);
        if (refusal != null) {
            return refusal;
        }

        Optional<Resource> existingOpt = projectManager.getResource(project, path);
        if (existingOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such named query in " + project + " (an inherited query cannot be "
                    + "deleted from the project that inherits it)");
        }
        Resource existing = existingOpt.get();
        Object stale = checkSignature(existing,
            HandlerSupport.expectedSignature(req, null), resp,
            "read the query before deleting it");
        if (stale != null) {
            return stale;
        }

        List<ChangeOperation> ops = new ArrayList<>();
        ops.add(ChangeOperation.newDeleteOp(existing.getResourceSignature()));
        // A folder delete takes its children with it. Left behind they are
        // orphaned rows the tree still shows under a folder that no longer exists.
        for (Resource child : ownChildrenOf(project, path)) {
            ops.add(ChangeOperation.newDeleteOp(child.getResourceSignature()));
        }

        Object pushError = push(ops, project, path, req, resp);
        if (pushError != null) {
            return pushError;
        }

        logger.info("Named query deleted: {} in {} by {} ({} resource(s))",
            path, project, HandlerSupport.actorFor(req), ops.size());

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("deleted", path.getPath().toString());
        out.addProperty("count", ops.size());
        return out;
    }

    // ==================== POST /api/named-queries/rename ====================

    /**
     * Move one query, or a folder and everything under it.
     *
     * <p>A rename is not a resource operation the platform offers, so it is a
     * create at the destination and a delete at the source in ONE
     * {@link PushOperation}: either the whole move lands or none of it does. A
     * folder rename is 2n of those, and the children must move with the folder —
     * a rename that moved only the folder resource would leave every query under
     * it addressed by a path with no parent.</p>
     *
     * <h3>A folder is usually IMPLIED, so it cannot carry an If-Match</h3>
     *
     * <p>Named-query folders exist in the tree because query paths contain
     * slashes, not because the platform stores a resource for each one. Measured
     * on the rig: {@code NQProbeFolder/NQProbeNested} exists as a resource while
     * {@code NQProbeFolder} sometimes does and sometimes does not. So a folder has
     * no single signature to match against, and demanding one would make renaming
     * a folder impossible rather than safe.</p>
     *
     * <p>The rule is therefore split by what the path names:</p>
     * <ul>
     *   <li>a QUERY — {@code If-Match} required, as for a delete. The move
     *       destroys the old path, and a caller who has not read the resource
     *       cannot be refused when it changed underneath them. Answers
     *       {@code {ok, signature}}.</li>
     *   <li>a FOLDER, whether or not a resource happens to exist at that path —
     *       no {@code If-Match}. Answers {@code {ok, moved:[{from, to, signature}]}}
     *       so the client can retarget every open tab in one pass instead of
     *       recomputing paths it would have to guess at.</li>
     * </ul>
     *
     * <p>The whole move is still atomic, and every destination is checked for a
     * collision BEFORE anything is pushed — a folder rename that half-landed
     * would leave queries in two places with no way to tell which was which.</p>
     */
    public Object rename(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        RenameRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), RenameRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.path == null || body.newPath == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'path' and 'newPath'");
        }

        ResourcePath from;
        ResourcePath to;
        try {
            from = decodeQueryPath(body.path);
            to = decodeQueryPath(body.newPath);
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        if (from.equals(to)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "'path' and 'newPath' are the same");
        }
        if (from.isAncestorOf(to)) {
            // Moving a folder into itself would have the loop create resources it
            // is still enumerating, and there is no sensible result to produce.
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Cannot move '" + from.getPath() + "' into itself");
        }

        Object refusal = requireMutableProject(project, resp);
        if (refusal != null) {
            return refusal;
        }

        Resource source = projectManager.getResource(project, from).orElse(null);
        List<Resource> children = ownChildrenOf(project, from);
        // A folder is what has children, or what the platform stored as a folder
        // resource. Both shapes occur — see the Javadoc — and both rename the same
        // way.
        boolean isFolder = !children.isEmpty()
            || (source != null && (source.isFolder() || source.getDataKeys().isEmpty()));

        if (source == null && children.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such named query or folder in " + project + " (an inherited query cannot "
                    + "be renamed from the project that inherits it): " + from.getPath());
        }
        if (!isFolder) {
            Object stale = checkSignature(source,
                HandlerSupport.expectedSignature(req, body.baseSignature), resp,
                "read the query before renaming it");
            if (stale != null) {
                return stale;
            }
        }

        // Every destination first, so a collision refuses the whole move rather
        // than being discovered halfway through building it.
        List<Move> moves = new ArrayList<>();
        if (source != null) {
            moves.add(new Move(source, to));
        }
        String fromPrefix = from.getPath().toString() + "/";
        String toPrefix = to.getPath().toString() + "/";
        for (Resource child : children) {
            String childPath = child.getResourcePath().getPath().toString();
            moves.add(new Move(child, new ResourcePath(NamedQuery.RESOURCE_TYPE,
                toPrefix + childPath.substring(fromPrefix.length()))));
        }
        for (Move move : moves) {
            if (projectManager.getResource(project, move.destination()).isPresent()) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                    "'" + move.destination().getPath() + "' already exists in " + project);
            }
        }

        List<ChangeOperation> ops = new ArrayList<>();
        for (Move move : moves) {
            ops.add(ChangeOperation.newCreateOp(
                movedTo(move.source(), project, move.destination())));
            ops.add(ChangeOperation.newDeleteOp(move.source().getResourceSignature()));
        }

        Object pushError = push(ops, project, from, req, resp);
        if (pushError != null) {
            return pushError;
        }

        logger.info("Named query {} renamed: {} -> {} in {} by {} ({} resource(s) moved)",
            isFolder ? "folder" : "", from, to, project, HandlerSupport.actorFor(req),
            moves.size());

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        if (isFolder) {
            JsonArray moved = new JsonArray();
            for (Move move : moves) {
                JsonObject row = new JsonObject();
                row.addProperty("from", move.source().getResourcePath().getPath().toString());
                row.addProperty("to", move.destination().getPath().toString());
                projectManager.getResource(project, move.destination()).ifPresent(now ->
                    row.addProperty("signature", now.getResourceSignature().toString()));
                moved.add(row);
            }
            out.add("moved", moved);
        } else {
            projectManager.getResource(project, to).ifPresent(now ->
                out.addProperty("signature", now.getResourceSignature().toString()));
        }
        return out;
    }

    /** One resource and where it is going. */
    private record Move(Resource source, ResourcePath destination) {
    }

    /**
     * The same resource at a different path.
     *
     * <p>{@code copyFrom} carries the data, the attributes, the documentation and
     * the version across verbatim — a rename must not reformat the SQL or
     * regenerate the settings, or every rename shows up as a full rewrite in the
     * next diff. The resource id is left to the builder's new path.</p>
     */
    private static Resource movedTo(Resource source, String project, ResourcePath destination) {
        return Resource.newBuilder()
            .copyFrom(source)
            .setResourceCollectionName(project)
            .setResourcePath(destination)
            .build();
    }

    /** Every resource this project OWNS beneath a folder path. */
    private List<Resource> ownChildrenOf(String project, ResourcePath folder) {
        List<Resource> out = new ArrayList<>();
        Optional<RuntimeResourceCollection> collectionOpt = projectManager.find(project);
        if (collectionOpt.isEmpty()) {
            return out;
        }
        for (Resource resource : collectionOpt.get().getResources()) {
            ResourcePath path = resource.getResourcePath();
            if (!NamedQuery.RESOURCE_TYPE.equals(path.getResourceType())
                || !folder.isAncestorOf(path)) {
                continue;
            }
            // Own-project only. A child that is merely inherited belongs to the
            // parent project and is not ours to move or delete.
            projectManager.getResource(project, path).ifPresent(out::add);
        }
        return out;
    }

    // ==================== helpers ====================

    /**
     * Decode the wire path into a {@link ResourcePath} under
     * {@code ignition/named-query}.
     *
     * <p>Unlike the script routes there is no {@code <moduleId>/<typeId>} prefix
     * to parse — the type is fixed — so this is validation rather than parsing.
     * The traversal check is not theoretical: the value arrives from a URL
     * segment and is used to address a resource.</p>
     */
    static ResourcePath decodeQueryPath(String raw) {
        if (raw == null || raw.isBlank()) {
            throw new IllegalArgumentException("Missing named query path");
        }
        if (raw.indexOf('\\') >= 0 || raw.indexOf('\0') >= 0) {
            throw new IllegalArgumentException(
                "Illegal character in named query path: " + raw);
        }
        String[] segments = raw.split("/", -1);
        for (String segment : segments) {
            if (segment.isEmpty()) {
                throw new IllegalArgumentException(
                    "Named query path has an empty segment: " + raw);
            }
            if (segment.equals(".") || segment.equals("..")) {
                throw new IllegalArgumentException(
                    "Illegal path-traversal segment in named query path: " + raw);
            }
        }
        return new ResourcePath(NamedQuery.RESOURCE_TYPE, raw);
    }

    /**
     * A fresh query, with every default PINNED rather than inherited.
     *
     * <p>The values are the ones {@code new NamedQuery()} produces on 8.3.8,
     * measured 02/09/2026 by serialising an untouched instance: {@code enabled}
     * true, {@code database} empty (the project default), caching off at 1 SEC,
     * fallback off, max-return-size off at 100, auto-batch off, one empty
     * permission row and no parameters. Setting them here rather than relying on
     * the constructor means a platform change to a default shows up as a failing
     * test rather than as every new query on the estate quietly changing
     * behaviour.</p>
     *
     * <p>{@code type} and {@code query} are not defaults but requirements: the
     * constructor leaves both null and {@code toResource} throws a
     * {@code NullPointerException} on either.</p>
     */
    static NamedQuery newQuery() {
        NamedQuery q = new NamedQuery();
        q.setType(NamedQuery.Type.Query);
        q.setQuery("");
        q.setEnabled(true);
        q.setDatabase("");
        q.setCachingEnabled(false);
        q.setCacheAmount(1);
        q.setCacheUnit(TimeUnits.SEC);
        q.setFallbackEnabled(false);
        q.setFallbackValue("");
        q.setUseMaxReturnSize(false);
        q.setMaxReturnSize(100);
        q.setAutoBatchEnabled(false);
        q.setPermissions(new ArrayList<>(List.of(new ZoneRoleRequirement("", ""))));
        q.setParameters(new ArrayList<>());
        return q;
    }

    /**
     * Turn a {@link NamedQuery} into a resource, through the platform's serialiser.
     *
     * <p>On a modify the builder starts from the EXISTING resource, so anything
     * the serialiser does not write — the platform's own {@code lastModification}
     * bookkeeping among it — survives the save.</p>
     */
    private static Resource build(String project, ResourcePath path, NamedQuery q,
                                  Resource existing) {
        ResourceBuilder builder = (existing == null)
            ? Resource.newBuilder()
            : existing.toBuilder();
        builder.setResourceCollectionName(project).setResourcePath(path);
        NamedQuery.toResource(q).accept(builder);
        return builder.build();
    }

    /** Whatever SQL is already stored, so a settings-only save never blanks it. */
    private String existingSql(Resource existing, String project, ResourcePath path) {
        Resource resource = existing != null ? existing : findMerged(project, path).orElse(null);
        if (resource == null) {
            return "";
        }
        return resource.getData(QUERY_FILE)
            .map(bytes -> new String(bytes.getBytes(), StandardCharsets.UTF_8))
            .orElse("");
    }

    /** Inheritance-MERGED lookup — an inherited query must open, not 404. */
    private Optional<Resource> findMerged(String project, ResourcePath path) {
        return projectManager.find(project).flatMap(c -> c.getResource(path));
    }

    private boolean isMutable(String project) {
        try {
            return projectManager.isMutable(project);
        } catch (Exception e) {
            logger.debug("isMutable({}) failed, assuming read-only: {}", project, e.getMessage());
            return false;
        }
    }

    /** 404 for a missing project, 409 for one that refuses writes. Null to proceed. */
    private Object requireMutableProject(String project, HttpServletResponse resp) {
        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        if (!projectManager.isMutable(project)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Project is not mutable: " + project);
        }
        return null;
    }

    /** 428 with no base signature, 409 with a stale one. Null when it matches. */
    private static Object checkSignature(Resource existing, String expected,
                                         HttpServletResponse resp, String advice) {
        if (expected == null || expected.isBlank()) {
            return HandlerSupport.error(resp, HandlerSupport.SC_PRECONDITION_REQUIRED,
                "Missing If-Match/baseSignature — " + advice);
        }
        if (!expected.equals(existing.getResourceSignature().toString())) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "This query changed on the gateway since you opened it (concurrent edit)");
        }
        return null;
    }

    private JsonObject okWithSignature(String project, ResourcePath path) {
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        // The new signature, so the client can save again without re-reading.
        projectManager.getResource(project, path)
            .ifPresent(now -> out.addProperty("signature", now.getResourceSignature().toString()));
        return out;
    }

    /** Run a push, mapping every failure onto a status. Returns null on success. */
    Object push(List<ChangeOperation> ops, String project, ResourcePath path,
                RequestContext req, HttpServletResponse resp) {
        try {
            projectManager.push(new PushOperation(ops, HandlerSupport.actorFor(req)))
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            logger.warn("Named query push interrupted for {}/{}", project, path);
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Named query write interrupted");
        } catch (TimeoutException e) {
            logger.warn("Named query push timed out for {}/{}", project, path);
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Named query write timed out");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            logger.warn("Named query push failed for {}/{}: {}", project, path, cause.toString());
            int status = (cause instanceof PushException)
                ? HttpServletResponse.SC_CONFLICT
                : HttpServletResponse.SC_BAD_GATEWAY;
            return HandlerSupport.error(resp, status,
                "Named query write failed: " + cause.getMessage());
        } catch (PushException e) {
            logger.warn("Named query push rejected for {}/{}: {}", project, path, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Named query write rejected: " + e.getMessage());
        }
    }

    /**
     * Body of a content write: {@code {sql, settings?, baseSignature?}}.
     *
     * <p>{@code settings} is optional and applied in the SAME push as the SQL, so
     * the editor's Ctrl+S — which saves both — costs one request and one
     * signature rather than two that can race each other.</p>
     */
    static final class SqlRequest {
        String sql;
        JsonObject settings;
        String baseSignature;
    }

    /** Body of a settings write: {@code {settings:{…}, baseSignature?}}. */
    static final class SettingsRequest {
        JsonObject settings;
        String baseSignature;
    }

    /** Body of a rename: {@code {path, newPath, baseSignature?}}. */
    static final class RenameRequest {
        String path;
        String newPath;
        String baseSignature;
    }
}
