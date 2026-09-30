package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ScriptResourceTypes;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.inductiveautomation.ignition.common.resourcecollection.ChangeOperation;
import com.inductiveautomation.ignition.common.ImmutableBytes;
import com.inductiveautomation.ignition.common.resourcecollection.PushException;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceCollectionManifest;
import com.inductiveautomation.ignition.common.resourcecollection.RuntimeResourceCollection;
import com.inductiveautomation.ignition.common.script.ModuleLibrary;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import com.inductiveautomation.ignition.gateway.resourcecollection.PushOperation;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Lists, reads and writes the script resources this IDE edits.
 *
 * <p>Writes go through {@link ProjectManager#push} — the platform's own resource
 * API — NOT the filesystem. That is what makes the whole file-based deploy dance
 * unnecessary here: no {@code resource.json} stamping, no
 * {@code lastModificationSignature} to strip, and no project scan. The gateway
 * writes the resource itself, correctly, and notifies its own listeners.</p>
 *
 * <h2>Two lookups that must never be "aligned"</h2>
 *
 * <p>{@link #read} resolves through the inheritance-MERGED collection
 * ({@code find}), so a script inherited from a parent project opens instead of
 * 404ing. {@link #write} uses the OWN-project lookup
 * ({@code getResource(project, path)}), so editing an inherited script CREATES a
 * local override rather than pushing a modify against the parent's copy. They
 * look like a duplication bug and are not.</p>
 *
 * <h2>Byte fidelity</h2>
 *
 * <p>Script bodies are written as raw UTF-8, verbatim. The real Designer writes
 * tabs (never spaces) and NO trailing newline, and a diff-noisy save makes every
 * subsequent git diff useless. The client sends exactly what is in the editor and
 * this handler adds nothing — see {@link #decodeBody}.</p>
 */
public final class ScriptResourceRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(ScriptResourceRouteHandler.class);

    /** {@code origin} of a resource this project defines and no ancestor does. */
    static final String ORIGIN_LOCAL = "local";
    /** {@code origin} of a resource an ancestor project supplies. */
    static final String ORIGIN_INHERITED = "inherited";
    /** {@code origin} of a resource this project defines that an ancestor also defines. */
    static final String ORIGIN_OVERRIDE = "override";

    private final ProjectManager projectManager;

    /**
     * Where every accepted save is also recorded. Null on a gateway context this
     * handler was built without — the save still happens, unrecorded.
     */
    private final com.gaskony.scriptide.gateway.history.SaveHistory history;

    /**
     * Backs {@link #organiseImports}'s project-module lookup. Null on a gateway
     * context this handler was built without — organise then falls back to the
     * built-in suggestion table only, same as it does for a name no project
     * module defines.
     */
    private final com.gaskony.scriptide.gateway.lang.ProjectIndex projectIndex;

    public ScriptResourceRouteHandler(ProjectManager projectManager) {
        this(projectManager, null, null);
    }

    public ScriptResourceRouteHandler(ProjectManager projectManager,
            com.gaskony.scriptide.gateway.history.SaveHistory history) {
        this(projectManager, history, null);
    }

    public ScriptResourceRouteHandler(ProjectManager projectManager,
            com.gaskony.scriptide.gateway.history.SaveHistory history,
            com.gaskony.scriptide.gateway.lang.ProjectIndex projectIndex) {
        this.projectManager = projectManager;
        this.history = history;
        this.projectIndex = projectIndex;
    }

    // ==================== GET /api/projects ====================

    /**
     * Every project on this gateway, with whether it can be written to, and where
     * its inherited resources come from.
     *
     * <p>{@code parent} and {@code inheritable} are what the tree needs to explain
     * an inherited row, and what the live harness needs to tell "the fixture has no
     * inheritable parent on this rig" from "inherited scripts are not listed" —
     * the same empty tree, with opposite meanings. The Ignition web UI exposes
     * neither over a GET.</p>
     */
    public Object projects(RequestContext req, HttpServletResponse resp) {
        JsonArray out = new JsonArray();
        Map<String, ResourceCollectionManifest> manifests;
        try {
            manifests = projectManager.getManifests();
        } catch (Exception e) {
            logger.debug("getManifests() failed, omitting parents: {}", e.getMessage());
            manifests = Map.of();
        }
        for (String name : projectManager.getNames()) {
            JsonObject p = new JsonObject();
            p.addProperty("name", name);
            ResourceCollectionManifest manifest = manifests.get(name);
            if (manifest != null) {
                String parent = manifest.parent();
                p.addProperty("parent", parent == null || parent.isEmpty() ? null : parent);
                p.addProperty("inheritable", manifest.inheritable());
            }
            // A project can exist and still refuse writes (inherited/immutable).
            // Surfacing it here lets the UI disable saving up front rather than
            // letting the user type for ten minutes and then fail the push.
            boolean mutable;
            try {
                mutable = projectManager.isMutable(name);
            } catch (Exception e) {
                logger.debug("isMutable({}) failed, assuming read-only: {}", name, e.getMessage());
                mutable = false;
            }
            p.addProperty("mutable", mutable);
            out.add(p);
        }
        JsonObject body = new JsonObject();
        body.add("projects", out);
        return body;
    }

    // ==================== GET /api/scripts ====================

    /**
     * The editable script tree for one project.
     *
     * <p>Enumerates {@code getResources()} — the inheritance-EFFECTIVE merged map
     * — never {@code getAllResources()}, which is the raw union and double-lists
     * every overridden resource.</p>
     */
    public Object tree(RequestContext req, HttpServletResponse resp) {
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
        RuntimeResourceCollection collection = collectionOpt.get();

        // getResources() is the inheritance-EFFECTIVE list. Never getAllResources(),
        // which is the raw union and double-lists every overridden resource.
        JsonArray scripts = new JsonArray();
        for (Resource resource : collection.getResources()) {
            ResourcePath path = resource.getResourcePath();
            var type = path.getResourceType();
            if (!ScriptResourceTypes.isEditable(type.moduleId(), type.typeId())) {
                continue;
            }
            if (isNamelessNonSingleton(path)) {
                continue;
            }
            // A package with nothing in it yet still needs a row — an empty
            // package must show as an empty folder, not vanish — but it must
            // never be openable. See isPackageContainer and describe()'s
            // `isFolder`.
            scripts.add(describe(resource, path, project, isPackageContainer(resource)));
        }

        JsonObject body = new JsonObject();
        body.addProperty("project", project);
        boolean mutable;
        try {
            mutable = projectManager.isMutable(project);
        } catch (Exception e) {
            mutable = false;
        }
        body.addProperty("mutable", mutable);
        body.add("scripts", scripts);
        return body;
    }

    /**
     * True for a project-library PACKAGE resource — a directory the platform
     * reports as a resource in its own right, but with no script of its own.
     *
     * <p>Measured 02/09/2026: a project holding {@code
     * ignition/script-python/MiningDemo/tags} also reports a resource at {@code
     * ignition/script-python/MiningDemo} — the containing package — with a real
     * signature, a real name and NO data keys ({@code dataKeys: []}). Unlike
     * {@link #isNamelessNonSingleton}'s phantom type-folder, this one carries a
     * name and passes every existing filter, so it was listed as an ordinary
     * openable script; clicking it 404s with "No such data key 'code.py'"
     * because there is nothing to read.</p>
     *
     * <p>Scoped to {@code script-python} deliberately: it is the only type whose
     * resources nest in slash-separated packages, so it is the only type where
     * an intermediate directory can itself be a resource with nothing in it.</p>
     */
    static boolean isPackageContainer(Resource resource) {
        return ScriptResourceTypes.TYPE_SCRIPT_PYTHON.equals(
            resource.getResourcePath().getResourceType().typeId())
            && resource.getDataKeys().isEmpty();
    }

    /**
     * One tree entry.
     *
     * <p>The {@code signature} is published on the LISTING as well as on a read.
     * That is not redundancy: a client needs it to delete or rename, and a
     * resource with no readable data key cannot supply one from a read at all.</p>
     *
     * @param isFolder true for an empty package directory — see {@link
     *     #isPackageContainer}. Still contributes its path to the tree (an empty
     *     package must render as an empty folder, not vanish), but carries no
     *     {@code scriptKey}: the client must never treat it as an openable file.
     */
    private JsonObject describe(Resource resource, ResourcePath path, String project, boolean isFolder) {
        JsonObject out = new JsonObject();
        var type = path.getResourceType();
        out.addProperty("path", HandlerSupport.encodePath(path));
        out.addProperty("typeId", type.typeId());
        out.addProperty("name", path.getPath().toString());
        out.addProperty("signature", resource.getResourceSignature().toString());
        out.addProperty("isFolder", isFolder);

        JsonArray keys = new JsonArray();
        resource.getDataKeys().forEach(keys::add);
        out.add("dataKeys", keys);

        // Which .py this resource actually carries. The client must use THIS, not
        // the type's create-time default: a resource written by an older Designer
        // can legitimately differ, and writing to the wrong key silently creates a
        // second key instead of updating the script.
        boolean webdev = ScriptResourceTypes.isWebDev(type.moduleId(), type.typeId());
        ScriptResourceTypes.byTypeId(type.typeId()).ifPresent(st -> {
            out.addProperty("typeLabel", st.label());
            out.addProperty("singleton", st.singleton());
            if (isFolder) {
                // No .py exists yet. Falling through to the createKey() default
                // below would hand the client a `scriptKey` that reads back
                // "No such data key" — the exact bug this guards against.
                return;
            }
            String actual;
            if (webdev) {
                actual = describeWebDev(resource, out, st.createKey());
            } else {
                actual = resource.getDataKeys().stream()
                    .filter(k -> k.endsWith(".py"))
                    .findFirst()
                    .orElse(st.createKey());
            }
            out.addProperty("scriptKey", actual);
        });

        // The Designer badges a disabled event script in its tree, so the flag
        // travels on the LISTING. Reading it per row from a second request would
        // be one request per gateway event script, every time the tree loads.
        resource.getAttribute("enabled").ifPresent(value -> {
            try {
                out.addProperty("enabled", value.getAsBoolean());
            } catch (RuntimeException e) {
                // A non-boolean `enabled` is somebody else's malformed resource,
                // not our failure: omit it and let the row render undecorated.
                logger.debug("Non-boolean enabled on {}: {}", path, e.getMessage());
            }
        });

        // A singleton with no .py data key exists in the collection but has never
        // been written. The Designer shows it as a normal-weight row you can open
        // and start typing in; the client needs to know which of the two it is.
        ScriptResourceTypes.byTypeId(type.typeId())
            .filter(ScriptResourceTypes.ScriptType::singleton)
            .ifPresent(st -> out.addProperty("defined",
                resource.getDataKeys().stream().anyMatch(k -> k.endsWith(".py"))));

        String owner = null;
        try {
            owner = resource.getDefiningCollectionName();
        } catch (Exception e) {
            logger.debug("getDefiningCollectionName failed for {}: {}", path, e.getMessage());
        }
        boolean ownedHere = project.equals(owner);
        java.util.List<String> definedIn;
        try {
            definedIn = resource.getDefiningCollectionNames();
        } catch (Exception e) {
            definedIn = java.util.List.of();
        }
        boolean alsoAbove = definedIn.size() > 1;
        out.addProperty("origin", ownedHere
            ? (alsoAbove ? ORIGIN_OVERRIDE : ORIGIN_LOCAL)
            : ORIGIN_INHERITED);
        out.addProperty("owner", owner == null ? project : owner);
        return out;
    }

    /**
     * The Web Dev half of {@link #describe}: which SHAPE this endpoint is, and
     * what it holds.
     *
     * <p>Until 1.9.0 this was five lines that intersected the data keys against
     * the eight verb handlers and published the result as {@code methods}. That
     * describes exactly one of the two shapes the platform writes; see {@link
     * WebDevResources} for the measurements. Concretely it meant a static
     * resource — 65 KB of HTML inside {@code config.json} — was reported as an
     * endpoint implementing no verbs, which the tree drew as eight "add
     * {@code doGet}" buttons and no way to reach the file.</p>
     *
     * @return the data key the client should open by default
     */
    private static String describeWebDev(Resource resource, JsonObject out, String createKey) {
        java.util.Set<String> present = new java.util.LinkedHashSet<>(resource.getDataKeys());
        JsonObject config = WebDevResources.parseConfig(resource);

        // Files that are neither the config nor a verb handler: `lib` ships
        // three.min.js this way. They were readable through the content route
        // the whole time and appeared nowhere in the UI.
        JsonArray files = new JsonArray();
        for (String key : present) {
            if (!WebDevResources.isAsset(key)) {
                continue;
            }
            int length = resource.getData(key).map(ImmutableBytes::length).orElse(0);
            JsonObject file = new JsonObject();
            file.addProperty("key", key);
            file.addProperty("size", length);
            file.addProperty("editable", WebDevResources.isEditableAsset(key, length));
            files.add(file);
        }
        out.add("files", files);

        if (WebDevResources.isTextResource(config)) {
            out.addProperty("webdevKind", "text");
            out.addProperty("contentType", WebDevResources.contentType(config));
            // No verbs at all — an EMPTY array rather than an absent one, so the
            // client renders "this endpoint has no handlers" instead of falling
            // back to a default list of eight.
            out.add("methods", new JsonArray());
            return WebDevResources.TEXT_DATA_KEY;
        }

        out.addProperty("webdevKind", "python");
        // Which verbs this endpoint actually implements, so the tree can list
        // them without a round trip per endpoint.
        JsonArray methods = new JsonArray();
        ScriptResourceTypes.WEBDEV_METHODS.stream()
            .filter(m -> present.contains(ScriptResourceTypes.webDevKeyFor(m)))
            .forEach(methods::add);
        out.add("methods", methods);

        // A Web Dev endpoint has up to EIGHT .py files, so "the first one" is
        // whatever order the platform happened to return — alphabetically that
        // is doDelete.py, which is nobody's idea of the main handler. Prefer
        // doGet, then the declared order.
        return ScriptResourceTypes.WEBDEV_METHODS.stream()
            .map(ScriptResourceTypes::webDevKeyFor)
            .filter(present::contains)
            .findFirst()
            .orElse(createKey);
    }

    // ==================== GET /api/scripts/content/:path ====================

    /**
     * Read one script body as raw UTF-8, with the resource signature as the
     * {@code ETag} — the optimistic-concurrency token the later write compares.
     */
    public Object read(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath resourcePath;
        try {
            resourcePath = HandlerSupport.decodePath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Object rejected = rejectNonScript(resourcePath, resp);
        if (rejected != null) {
            return rejected;
        }

        // Inheritance-MERGED: an inherited script must open, not 404. See the
        // class Javadoc — do not align this with write()'s lookup.
        Optional<RuntimeResourceCollection> collectionOpt = projectManager.find(project);
        if (collectionOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        Optional<Resource> resourceOpt = collectionOpt.get().getResource(resourcePath);
        if (resourceOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such script: " + resourcePath + " in project " + project);
        }
        Resource resource = resourceOpt.get();

        String key = req.getParameter("key");
        if (key == null || key.isBlank()) {
            key = defaultKeyFor(resource, resourcePath);
        }

        byte[] body;
        if (WebDevResources.TEXT_DATA_KEY.equals(key)) {
            // A Web Dev text resource keeps its whole body as a STRING inside
            // config.json rather than as a data key, so there is nothing here
            // for getData to return. See WebDevResources for why the synthetic
            // key exists at all.
            Optional<String> text = isWebDevPath(resourcePath)
                ? WebDevResources.body(WebDevResources.parseConfig(resource))
                : Optional.empty();
            if (text.isEmpty()) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No text content on " + resourcePath);
            }
            body = text.get().getBytes(StandardCharsets.UTF_8);
        } else {
            Optional<ImmutableBytes> dataOpt = resource.getData(key);
            if (dataOpt.isEmpty()) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                    "No such data key '" + key + "' on " + resourcePath);
            }
            body = dataOpt.get().getBytes();
        }

        resp.setHeader("ETag",
            HandlerSupport.quoteEtag(resource.getResourceSignature().toString()));
        // text/plain, not application/json: this is source, and a JSON content
        // type makes browsers and proxies try to parse it. It stays text/plain
        // for an HTML or JavaScript file too — the client is a code editor, and
        // serving text/html here would let a static resource be rendered as a
        // page from this module's own origin.
        resp.setContentType("text/plain; charset=UTF-8");
        byte[] bytes = body;
        resp.setContentLength(bytes.length);
        resp.getOutputStream().write(bytes);
        return null;
    }

    // ==================== GET /api/scripts/inherited/:path ====================

    /**
     * The PARENT project's copy of a resource, for comparing an override against
     * what it overrides.
     *
     * <p>Overriding a resource does not lose inheritance — {@code Discard
     * Overrides} returns it to the parent's copy — and until 1.16.0 there was no
     * way to see what your override had actually changed, nor to look before
     * discarding. The Designer does not offer this either.</p>
     *
     * <p>Walks the parent CHAIN, not just the immediate parent: a resource can be
     * inherited from a grandparent, and stopping at the first parent would report
     * "no parent copy" for a resource that plainly has one. Bounded, because a
     * manifest could name a cycle and this must not become an infinite loop on a
     * misconfigured gateway.</p>
     */
    public Object inherited(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath resourcePath;
        try {
            resourcePath = HandlerSupport.decodePath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        Map<String, ResourceCollectionManifest> manifests;
        try {
            manifests = projectManager.getManifests();
        } catch (Exception e) {
            logger.debug("getManifests() failed: {}", e.getMessage());
            manifests = Map.of();
        }

        String current = project;
        java.util.Set<String> visited = new java.util.HashSet<>();
        for (int hop = 0; hop < MAX_PARENT_HOPS; hop++) {
            ResourceCollectionManifest manifest = manifests.get(current);
            String parent = manifest == null ? null : manifest.parent();
            if (parent == null || parent.isBlank() || !visited.add(parent)) {
                break;
            }
            Optional<Resource> found = projectManager.getResource(parent, resourcePath);
            if (found.isPresent()) {
                Resource resource = found.get();
                String key = req.getParameter("key");
                if (key == null || key.isBlank()) {
                    key = defaultKeyFor(resource, resourcePath);
                }
                String body = bodyTextOf(resource, resourcePath, key);
                if (body != null) {
                    // Named so the dialog can say WHICH project it is comparing
                    // against — with a chain, "the parent" is not specific enough
                    // to act on.
                    resp.setHeader("X-Parent-Project", parent);
                    resp.setContentType("text/plain; charset=UTF-8");
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    resp.setContentLength(bytes.length);
                    resp.getOutputStream().write(bytes);
                    return null;
                }
            }
            current = parent;
        }
        return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
            "No parent project has a copy of this resource");
    }

    /** How far up a parent chain to look before giving up. */
    private static final int MAX_PARENT_HOPS = 10;

    // ==================== POST /api/scripts/content/:path ====================

    /**
     * Write one script body.
     *
     * <p>Administrator-gated by the route strategy, plus a CSRF check and an
     * optimistic-concurrency guard here. Status map: 400 bad input, 403 CSRF, 404
     * missing project, 409 signature mismatch or push conflict, 428 modify without
     * a base signature, 502 push failure.</p>
     */
    public Object write(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath resourcePath;
        try {
            resourcePath = HandlerSupport.decodePath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Object rejected = rejectNonScript(resourcePath, resp);
        if (rejected != null) {
            return rejected;
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        WriteRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), WriteRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.source == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'source' field");
        }

        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        if (!projectManager.isMutable(project)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Project is not mutable: " + project);
        }

        // OWN-project lookup: editing an inherited script must create a local
        // override, so "absent" here is correct and takes the create branch.
        Optional<Resource> existingOpt = projectManager.getResource(project, resourcePath);
        String expected = HandlerSupport.expectedSignature(req, body.baseSignature);
        byte[] newBytes = decodeBody(body.source);

        ChangeOperation op;
        if (existingOpt.isEmpty()) {
            ResourceBuilder builder = Resource.newBuilder()
                .setResourceCollectionName(project)
                .setResourcePath(resourcePath);
            try {
                applyScriptBody(builder, resourcePath, body.key, body.source, newBytes);
            } catch (IllegalArgumentException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
            op = ChangeOperation.newCreateOp(builder.build());
        } else {
            Resource existing = existingOpt.get();
            String current = existing.getResourceSignature().toString();
            if (expected == null || expected.isBlank()) {
                return HandlerSupport.error(resp, HandlerSupport.SC_PRECONDITION_REQUIRED,
                    "Missing If-Match/baseSignature — read the script before updating it");
            }
            if (!expected.equals(current)) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                    "This script changed on the gateway since you opened it (concurrent edit)");
            }
            ResourceBuilder builder = existing.toBuilder();
            String key = (body.key == null || body.key.isBlank())
                ? defaultKeyFor(existing, resourcePath)
                : body.key;
            try {
                if (WebDevResources.TEXT_DATA_KEY.equals(key) && isWebDevPath(resourcePath)) {
                    applyWebDevText(builder, existing, body.source);
                } else {
                    applyScriptBody(builder, resourcePath, key, body.source, newBytes);
                }
            } catch (IllegalArgumentException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
            op = ChangeOperation.newModifyOp(builder.build(), existing.getResourceSignature());
        }

        // Read the CURRENT body before the push, while the old resource is still
        // the one on the gateway. See SaveHistory: the state someone started
        // from is otherwise the one state their history cannot return them to,
        // and the first save is usually the one that broke it.
        // The RESOLVED key, not the raw one from the body. A save that omits the
        // key is written under the resource's default, so recording the history
        // under "" would file it where no read can find it — the dialog asks
        // with the document's real key and would show an empty history for a
        // file that has one.
        String historyKey = existingOpt
            .map(existing -> body.key == null || body.key.isBlank()
                ? defaultKeyFor(existing, resourcePath)
                : body.key)
            .orElse(body.key == null || body.key.isBlank() ? "code.py" : body.key);
        String previousBody = existingOpt
            .map(existing -> bodyTextOf(existing, resourcePath, historyKey))
            .orElse(null);

        Object pushError = push(op, project, resourcePath, req, resp);
        if (pushError != null) {
            return pushError;
        }

        recordHistory(req, project, resourcePath, historyKey, body.source, previousBody);

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        // Return the new signature so the client can save again without re-reading.
        projectManager.getResource(project, resourcePath)
            .ifPresent(now -> out.addProperty("signature", now.getResourceSignature().toString()));
        return out;
    }

    // ==================== POST /api/scripts/organise-imports ====================

    /** Same cap as a Web Dev text body — see {@link WebDevResources#EDITABLE_MAX_BYTES}. */
    private static final int MAX_ORGANISE_SOURCE_BYTES = WebDevResources.EDITABLE_MAX_BYTES;

    /** Project modules a single lookup call may inspect before giving up on a name. */
    private static final int MAX_LOOKUP_CANDIDATES = 50;

    /**
     * Sort and de-duplicate the leading import block of the buffer in the body,
     * and suggest an import for each name it reads but never binds.
     *
     * <p>Authenticated, not Administrator, by the route strategy — this writes
     * NOTHING to the gateway. It is a pure transform of text the caller already
     * has open, handed back for the editor to apply as an ordinary local edit;
     * see {@link com.gaskony.scriptide.gateway.lang.ImportOrganiser}. CSRF is
     * still enforced because it is a POST from a browser session, but there is
     * no {@code If-Match}: there is no resource version to assert against
     * something that never reaches the gateway's own copy.</p>
     */
    public Object organiseImports(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        OrganiseImportsRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), OrganiseImportsRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.source == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'source' field");
        }
        if (body.source.getBytes(StandardCharsets.UTF_8).length > MAX_ORGANISE_SOURCE_BYTES) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Source is larger than " + (MAX_ORGANISE_SOURCE_BYTES / 1024) + " KB");
        }

        com.gaskony.scriptide.gateway.lang.ImportOrganiser.Lookup lookup = lookupFor(project);
        com.gaskony.scriptide.gateway.lang.ImportOrganiser.Result result =
            com.gaskony.scriptide.gateway.lang.ImportOrganiser.organise(body.source, lookup);

        JsonObject out = new JsonObject();
        out.addProperty("source", result.source());
        JsonArray removed = new JsonArray();
        result.removed().forEach(removed::add);
        out.add("removed", removed);
        JsonArray notes = new JsonArray();
        result.notes().forEach(notes::add);
        out.add("notes", notes);
        JsonArray suggestions = new JsonArray();
        for (var suggestion : result.suggestions()) {
            JsonObject item = new JsonObject();
            item.addProperty("name", suggestion.name());
            item.addProperty("statement", suggestion.statement());
            item.addProperty("origin", suggestion.origin());
            suggestions.add(item);
        }
        out.add("suggestions", suggestions);
        return out;
    }

    /**
     * Which project module defines a name — the FIRST top-level symbol whose
     * name matches exactly. {@link ProjectIndex#search} is a substring match
     * meant for quick-open, so results are filtered down to an exact,
     * module-level ({@code container() == null}) hit: a method of that name on
     * some class is not something {@code from module import name} can reach.
     */
    private com.gaskony.scriptide.gateway.lang.ImportOrganiser.Lookup lookupFor(String project) {
        if (projectIndex == null) {
            return name -> Optional.empty();
        }
        return name -> {
            for (var hit : projectIndex.search(project, name, MAX_LOOKUP_CANDIDATES)) {
                if (hit.symbol().name().equals(name) && hit.symbol().container() == null) {
                    return Optional.of(hit.moduleName());
                }
            }
            return Optional.empty();
        };
    }

    /** Body of an organise-imports request: {@code {source}}. */
    static final class OrganiseImportsRequest {
        String source;
    }

    // ==================== DELETE /api/scripts/content/:path ====================

    /**
     * Delete one script resource.
     *
     * <p>Administrator-gated by the route strategy, with the same CSRF check and
     * optimistic-concurrency guard as {@link #write}. Status map: 400 bad input,
     * 403 CSRF, 404 missing project or script, 409 signature mismatch or push
     * conflict, 428 delete without a base signature, 502 push failure.</p>
     *
     * <h3>Why the OWN-project lookup, and why an inherited script is a 404</h3>
     *
     * <p>Like {@link #write}, this resolves through {@code getResource(project,
     * path)} rather than the inheritance-merged {@code find}. The consequence is
     * deliberate and is the whole reason this method cannot share {@code write}'s
     * shape: if the script is only inherited, there is nothing in THIS project to
     * delete, and a merged lookup would find the parent's copy and delete it —
     * silently editing a different project than the one in the URL. So an
     * inherited-only path 404s here, which is honest: the user is looking at a
     * script this project does not own.</p>
     *
     * <h3>Why If-Match is required rather than optional</h3>
     *
     * <p>A delete is the one operation that cannot be undone from inside this
     * module, and {@code newDeleteOp} takes only a {@link
     * com.inductiveautomation.ignition.common.resourcecollection.ResourceSignature}
     * — which carries both the resource id AND the version. Requiring the caller
     * to have read the resource first means we can refuse to delete a script that
     * changed underneath them, rather than discarding an edit they never saw.</p>
     */
    public Object delete(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        ResourcePath resourcePath;
        try {
            resourcePath = HandlerSupport.decodePath(req.getParameter("path"));
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Object rejected = rejectNonScript(resourcePath, resp);
        if (rejected != null) {
            return rejected;
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        if (!projectManager.isMutable(project)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Project is not mutable: " + project);
        }

        // OWN-project lookup — see the Javadoc. Absent means "this project does
        // not define it", which for a delete is a 404 and never a create.
        Optional<Resource> existingOpt = projectManager.getResource(project, resourcePath);
        if (existingOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such script in " + project + " (an inherited script cannot be "
                    + "deleted from the project that inherits it)");
        }
        Resource existing = existingOpt.get();

        String expected = HandlerSupport.expectedSignature(req, null);
        String current = existing.getResourceSignature().toString();
        if (expected == null || expected.isBlank()) {
            return HandlerSupport.error(resp, HandlerSupport.SC_PRECONDITION_REQUIRED,
                "Missing If-Match — read the script before deleting it");
        }
        if (!expected.equals(current)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "This script changed on the gateway since you opened it (concurrent edit)");
        }

        ChangeOperation op = ChangeOperation.newDeleteOp(existing.getResourceSignature());
        Object pushError = push(op, project, resourcePath, req, resp);
        if (pushError != null) {
            return pushError;
        }

        logger.info("Script deleted: {} in {} by {}", resourcePath, project,
            HandlerSupport.actorFor(req));

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("deleted", resourcePath.toString());
        return out;
    }

    // ==================== POST /api/scripts/rename ====================

    /**
     * Move one script resource to a new path.
     *
     * <p>Named queries have had this since 1.7.0; scripts have not, so renaming a
     * library module meant create-at-the-new-path, delete-the-old, and then find
     * every import by hand. The last step is the one that gets missed.</p>
     *
     * <h3>Deliberately narrower than the named-query rename</h3>
     *
     * <p>ONE resource, never a folder and never its children. A folder move is a
     * multi-resource push with collision checking across the whole subtree — the
     * named-query handler does it and is long because of it — and shipping a
     * half-version that moved a folder's direct children only would be worse than
     * not offering it. Renaming a package is still a manual job, and the UI says
     * so rather than the button silently doing less than it looks like.</p>
     *
     * <h3>Call sites are the CLIENT's job, and separately</h3>
     *
     * <p>This moves the resource and returns the old and new dotted module names.
     * It does not touch anybody else's source: rewriting imports is a
     * project-wide replace, which already exists, already shows a preview, and
     * already refuses inherited and dirty documents. Doing it silently inside a
     * rename would be a bulk write with none of those guards, hidden behind a
     * button that says "rename".</p>
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
            from = HandlerSupport.decodePath(body.path);
            to = HandlerSupport.decodePath(body.newPath);
        } catch (IllegalArgumentException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }
        Object rejected = rejectNonScript(from, resp);
        if (rejected != null) {
            return rejected;
        }
        rejected = rejectNonScript(to, resp);
        if (rejected != null) {
            return rejected;
        }
        if (from.equals(to)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "'path' and 'newPath' are the same");
        }
        // The two ends must be the same KIND of thing. Moving a timer script into
        // the library would produce a resource whose type says timer and whose
        // path says library, which nothing downstream expects.
        if (!from.getResourceType().equals(to.getResourceType())) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "A script can only be renamed within its own resource type");
        }
        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        if (!projectManager.isMutable(project)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Project is not mutable: " + project);
        }

        // OWN-project lookup, like write and delete: an inherited script is not
        // this project's to move, and a merged lookup would rename the PARENT's.
        Resource source = projectManager.getResource(project, from).orElse(null);
        if (source == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such script in " + project + " (an inherited script cannot be renamed "
                    + "from the project that inherits it): " + from);
        }
        if (source.isFolder() || source.getDataKeys().isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Renaming a folder is not supported — move its scripts individually");
        }
        Object stale = null;
        String expected = HandlerSupport.expectedSignature(req, body.baseSignature);
        if (expected == null || expected.isBlank()) {
            stale = HandlerSupport.error(resp, HandlerSupport.SC_PRECONDITION_REQUIRED,
                "Missing If-Match/baseSignature — read the script before renaming it");
        } else if (!expected.equals(source.getResourceSignature().toString())) {
            stale = HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "This script changed on the gateway since you opened it (concurrent edit)");
        }
        if (stale != null) {
            return stale;
        }
        if (projectManager.getResource(project, to).isPresent()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "'" + to + "' already exists in " + project);
        }

        // Create-then-delete in ONE push. Two pushes would leave the project with
        // both copies, or neither, if the second failed.
        ResourceBuilder builder = source.toBuilder().setResourcePath(to);
        ChangeOperation create = ChangeOperation.newCreateOp(builder.build());
        ChangeOperation remove = ChangeOperation.newDeleteOp(source.getResourceSignature());
        try {
            projectManager.push(new PushOperation(List.of(create, remove),
                HandlerSupport.actorFor(req)))
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Interrupted while renaming");
        } catch (Exception e) {
            logger.debug("Rename push failed for {} -> {}: {}", from, to, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "The gateway refused the rename: " + e.getMessage());
        }

        logger.info("Script renamed: {} -> {} in {} by {}", from, to, project,
            HandlerSupport.actorFor(req));

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("path", HandlerSupport.encodePath(to));
        // The dotted names, so the client can offer to update call sites without
        // having to know how a resource path maps onto an import.
        out.addProperty("oldModule", dottedModuleOf(from));
        out.addProperty("newModule", dottedModuleOf(to));
        projectManager.getResource(project, to)
            .ifPresent(now -> out.addProperty("signature",
                now.getResourceSignature().toString()));
        return out;
    }

    /**
     * {@code ignition/script-python/util/helpers} → {@code util.helpers}, or null
     * for a resource type that is not importable.
     */
    private static String dottedModuleOf(ResourcePath path) {
        if (!ScriptResourceTypes.TYPE_SCRIPT_PYTHON.equals(path.getResourceType().typeId())) {
            return null;
        }
        String tail = path.getPath().toString();
        return tail.isEmpty() ? null : tail.replace('/', '.');
    }

    /** Body of POST /api/scripts/rename. */
    static final class RenameRequest {
        String path;
        String newPath;
        String baseSignature;
    }

    /** Run a push, mapping every failure onto a status. Returns null on success. */
    Object push(ChangeOperation op, String project, ResourcePath path,
                RequestContext req, HttpServletResponse resp) {
        try {
            projectManager.push(new PushOperation(List.of(op), HandlerSupport.actorFor(req)))
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            logger.warn("Script push interrupted for {}/{}", project, path);
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Script write interrupted");
        } catch (TimeoutException e) {
            logger.warn("Script push timed out for {}/{}", project, path);
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Script write timed out");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            logger.warn("Script push failed for {}/{}: {}", project, path, cause.toString());
            int status = (cause instanceof PushException)
                ? HttpServletResponse.SC_CONFLICT
                : HttpServletResponse.SC_BAD_GATEWAY;
            return HandlerSupport.error(resp, status, "Script write failed: " + cause.getMessage());
        } catch (PushException e) {
            logger.warn("Script push rejected for {}/{}: {}", project, path, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Script write rejected: " + e.getMessage());
        }
    }

    // ==================== helpers ====================

    /**
     * Refuse any resource type this IDE does not edit.
     *
     * <p>The routes are generic over {@code <moduleId>/<typeId>}, so without this
     * an Administrator could rewrite a Perspective view or a tag config through
     * the script editor's endpoint. Deny-by-default on the type, not just the
     * caller.</p>
     */
    private Object rejectNonScript(ResourcePath path, HttpServletResponse resp) {
        var type = path.getResourceType();
        if (!ScriptResourceTypes.isEditable(type.moduleId(), type.typeId())) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Not an editable script resource type: "
                    + type.moduleId() + "/" + type.typeId());
        }
        // Refuse the folder as well as the wrong type. Filtering containers out
        // of the LISTING is not enough on its own — the routes are addressable
        // directly, and before this guard a POST to `ignition/scheduled` returned
        // 200 and hung an attribute off a directory. See isContainerNode.
        if (isNamelessNonSingleton(path)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "'" + type.typeId() + "' is a folder, not a script — address a "
                    + "script inside it. Only startup, shutdown and update are "
                    + "addressed without a name.");
        }
        return null;
    }

    /**
     * A path with no name segment, on a type for which that is meaningless.
     *
     * <p>Measured 01/09/2026: a project holding {@code ignition/scheduled/Probe
     * Scheduled} ALSO reports a resource at bare {@code ignition/scheduled} —
     * the folder — with a real signature, no data keys and an empty name. There
     * is no {@code resource.json} for it on disk; it exists only in the runtime
     * collection, and every event-script folder with children produces one.</p>
     *
     * <p>Left in the listing it appears in the rail as a row labelled with its
     * type ("Scheduled"), indistinguishable from a singleton. Left reachable by
     * the routes it is WRITABLE: a save returned 200 and hung a
     * {@code cronExpression} off a directory.</p>
     *
     * <p>The discriminator is the TYPE, not the shape. An empty name is exactly
     * how startup/shutdown/update address their singleton, so "empty name" alone
     * would hide three real scripts.</p>
     */
    private static boolean isNamelessNonSingleton(ResourcePath path) {
        // isResourceTypeFolder() is the platform's own predicate for "this path
        // addresses the type's folder, with no name under it". getName() is NOT
        // that: on `ignition/scheduled` it returns "scheduled", so a getName()
        // check silently never fires — which is exactly how the first attempt at
        // this guard did nothing at all.
        if (!path.isResourceTypeFolder()) {
            return false;
        }
        return ScriptResourceTypes.byTypeId(path.getResourceType().typeId())
            .map(type -> !type.singleton())
            .orElse(true);
    }

    /** The .py key a resource actually carries, falling back to its type's default. */
    /**
     * Record this save in the caller's own local history.
     *
     * <p>Never throws and never affects the response. By the time this runs the
     * push has already succeeded, so the user's work is on the gateway; turning
     * a successful save into an error because a side store could not be written
     * would be the worst trade available.</p>
     */
    private void recordHistory(RequestContext req, String project, ResourcePath resourcePath,
                               String key, String source, String previousBody) {
        if (history == null) {
            return;
        }
        try {
            String user = com.gaskony.scriptide.gateway.security.SessionSecurity
                .authenticatedUser(req)
                .map(u -> u.getUserName())
                .orElse(null);
            if (user == null || user.isBlank()) {
                return;
            }
            String path = HandlerSupport.encodePath(resourcePath);
            history.recordBaselineIfEmpty(user, project, path, key, previousBody);
            history.record(user, project, path, key, source);
        } catch (RuntimeException e) {
            logger.debug("Could not record save history for {}: {}", resourcePath, e.toString());
        }
    }

    /**
     * One resource's body as text, or null when it has none for that key.
     *
     * <p>Mirrors the branch in {@link #read}, including the Web Dev text
     * resource whose body lives inside {@code config.json} rather than as a data
     * key — a history that silently skipped those would be missing exactly the
     * files that are hardest to retype.</p>
     */
    private static String bodyTextOf(Resource resource, ResourcePath resourcePath, String key) {
        try {
            if (WebDevResources.TEXT_DATA_KEY.equals(key)) {
                return isWebDevPath(resourcePath)
                    ? WebDevResources.body(WebDevResources.parseConfig(resource)).orElse(null)
                    : null;
            }
            return resource.getData(key)
                .map(data -> new String(data.getBytes(), StandardCharsets.UTF_8))
                .orElse(null);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String defaultKeyFor(Resource resource, ResourcePath path) {
        // A Web Dev text resource has no .py at all, and its type's create key is
        // doGet.py — so without this the default read on one 404s with "No such
        // data key 'doGet.py'" rather than opening the file that is plainly there.
        if (isWebDevPath(path)
            && WebDevResources.isTextResource(WebDevResources.parseConfig(resource))) {
            return WebDevResources.TEXT_DATA_KEY;
        }
        return resource.getDataKeys().stream()
            .filter(k -> k.endsWith(".py"))
            .findFirst()
            .orElseGet(() -> createKeyFor(path));
    }

    private static String createKeyFor(ResourcePath path) {
        return ScriptResourceTypes.byTypeId(path.getResourceType().typeId())
            .map(ScriptResourceTypes.ScriptType::createKey)
            .orElse("code.py");
    }

    /**
     * Put the script body onto a resource builder the way the PLATFORM does.
     *
     * <p>For a project-library script this delegates to
     * {@link ModuleLibrary#serializeScript}, which is Ignition's own writer for
     * that resource type. Using it is not tidiness — it is correctness. Building
     * the resource by hand with just {@code putData("code.py", bytes)} produces a
     * resource that reads back perfectly, writes byte-identical content to disk,
     * and is then <b>silently ignored by the script library</b>: the module is
     * unimportable and fails with a bare {@code ImportError: No module named X}
     * while the file plainly exists. Measured 01/09/2026 across two projects, and
     * it survived both a project scan and a gateway restart.
     *
     * <p>What the hand-built version was missing is
     * {@code setApplicationScope(7)} — {@code ModuleLibrary.install} skips a
     * resource without it. {@code serializeScript} sets exactly three things
     * (application scope, the {@code code.py} data, and the {@code hintScope}
     * attribute), so delegating also means a future platform change to that shape
     * is inherited rather than re-derived.
     *
     * <p>Gateway event scripts (timer, message, startup, …) are written through
     * the generic path, but still get an explicit application scope for the same
     * reason.</p>
     */
    private static void applyScriptBody(ResourceBuilder builder, ResourcePath path,
                                        String requestedKey, String source, byte[] bytes) {
        String typeId = path.getResourceType().typeId();
        if (ScriptResourceTypes.TYPE_SCRIPT_PYTHON.equals(typeId)) {
            // Preserve the resource's existing hint scope on a modify; a new script
            // gets the platform's own default rather than a guess of ours.
            ModuleLibrary.ScriptHintScope hintScope = ModuleLibrary.DEFAULT_HINT_SCOPE;
            ModuleLibrary.serializeScript(source, hintScope).accept(builder);
            return;
        }
        String key = (requestedKey == null || requestedKey.isBlank())
            ? createKeyFor(path)
            : requestedKey;
        // The caller is already an Administrator, so this is defence in depth rather
        // than a privilege boundary — but a client-supplied data key has no business
        // containing a path separator, and whether the platform sanitises one is not
        // something this module should be relying on.
        boolean webdev = ScriptResourceTypes.isWebDev(
            path.getResourceType().moduleId(), path.getResourceType().typeId());
        if (!(webdev ? isSafeWebDevDataKey(key) : isSafeDataKey(key))) {
            throw new IllegalArgumentException("Invalid data key '" + key + "': expected "
                + (webdev ? "a plain filename this IDE can edit" : "a plain .py filename"));
        }
        builder.setApplicationScope(ALL_SCOPE).putData(key, bytes);
    }

    /**
     * A data key must be a plain {@code .py} filename — no separators, no traversal.
     *
     * <p>Every script resource type stores its body under a simple filename
     * ({@code code.py}, {@code handleTimerEvent.py}, …), so anything else is either
     * a mistake or an attempt at something.</p>
     */
    static boolean isSafeDataKey(String key) {
        return isPlainFilename(key) && key.endsWith(".py");
    }

    /**
     * The same rules, widened to the file types a Web Dev endpoint may carry.
     *
     * <p>A Web Dev resource is the one place a data key is legitimately not a
     * {@code .py} file: {@code lib} ships {@code three.min.js} beside its
     * handler. The allowlist is {@link WebDevResources}', so what may be WRITTEN
     * and what the tree offers to OPEN cannot drift apart — a key this module
     * would refuse to show is a key it must refuse to save.</p>
     *
     * <p>Kept as a separate predicate rather than a parameter on the one above,
     * so that no ordinary script write can reach the wider set by accident.</p>
     */
    static boolean isSafeWebDevDataKey(String key) {
        return isPlainFilename(key)
            && (key.endsWith(".py") || WebDevResources.hasEditableExtension(key));
    }

    /**
     * No separators, no traversal, no NUL, no {@code #}.
     *
     * <p>The {@code #} matters as much as the separators do: {@code
     * config.json#text} is the synthetic key a Web Dev text resource's body is
     * addressed by, and it must never be creatable as a REAL data key — a
     * resource carrying both would have two different bodies answering to one
     * name, and which one won would depend on the order of two branches.</p>
     */
    private static boolean isPlainFilename(String key) {
        return key != null
            && !key.isBlank()
            && key.indexOf('/') < 0
            && key.indexOf('\\') < 0
            && key.indexOf('\0') < 0
            && key.indexOf('#') < 0
            && !key.contains("..");
    }

    /** True when this path addresses a Web Dev resource. */
    private static boolean isWebDevPath(ResourcePath path) {
        var type = path.getResourceType();
        return ScriptResourceTypes.isWebDev(type.moduleId(), type.typeId());
    }

    /**
     * Write a Web Dev text resource's body back into its {@code config.json}.
     *
     * <p>Read-modify-write, never a wholesale replacement: the client sends a
     * body, and the {@code content-type} beside it — plus anything a newer
     * Ignition has added — is carried across untouched. Overwriting the document
     * with {@code {"text": …}} would strip the MIME type and leave the platform
     * serving 65 KB of HTML as {@code text/plain}.</p>
     */
    private static void applyWebDevText(ResourceBuilder builder, Resource existing, String source) {
        JsonObject config = WebDevResources.parseConfig(existing);
        if (!WebDevResources.isTextResource(config)) {
            // Refuse rather than convert. Turning a Python endpoint into a static
            // resource silently unpublishes every verb it implements, and the
            // handlers stay on disk looking like they still serve traffic.
            throw new IllegalArgumentException(
                "That endpoint serves Python handlers, not static text");
        }
        builder.putData(ScriptResourceTypes.WEBDEV_CONFIG_KEY,
            WebDevResources.serialise(WebDevResources.withBody(config, source)));
    }

    /**
     * ApplicationScope.ALL. Hardcoded rather than referenced because the constant
     * lives in a class the platform does not export cleanly; the value is fixed and
     * is what {@code ModuleLibrary.serializeScript} itself passes.
     */
    private static final int ALL_SCOPE = 7;

    /**
     * Source text to bytes, verbatim.
     *
     * <p>Deliberately does nothing else. It does not trim, it does not normalise
     * line endings, and it does not append a terminating newline — the real
     * Designer writes none, and adding one turns every save into a diff. Tabs
     * arrive as tabs and stay tabs.</p>
     */
    private static byte[] decodeBody(String source) {
        return source.getBytes(StandardCharsets.UTF_8);
    }

    /** Body of a content write: {@code {source, key?, baseSignature?}}. */
    static final class WriteRequest {
        String source;
        String key;
        String baseSignature;
    }
}
