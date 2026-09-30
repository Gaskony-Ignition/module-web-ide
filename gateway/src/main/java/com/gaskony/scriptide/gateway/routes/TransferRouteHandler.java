package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonElement;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.common.ImmutableBytes;
import com.inductiveautomation.ignition.common.model.ApplicationScope;
import com.inductiveautomation.ignition.common.resourcecollection.ChangeOperation;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceCollectionManifest;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import com.inductiveautomation.ignition.common.resourcecollection.PushException;
import com.inductiveautomation.ignition.gateway.resourcecollection.PushOperation;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

/**
 * Export and import project resources, in the Designer's own zip format.
 *
 * <p>Nigel, 07/09/2026: <em>"there is no export/import code options like in the
 * designer"</em>, and asked for the Designer-compatible resource zip rather than
 * plain {@code .py} files. That choice is only worth anything if the two tools
 * can read each other's files, so the format was MEASURED off the real Designer
 * — see {@code docs/EXPORT-FORMAT.md} — rather than approximated. In short:</p>
 *
 * <pre>
 *   project.json                                        &lt;- title, description, parent…
 *   ignition/script-python/MiningDemo/config/resource.json
 *   ignition/script-python/MiningDemo/config/code.py
 * </pre>
 *
 * <p>The project's own on-disk layout, subsetted to what was selected, with no
 * wrapper directory and no index — the paths ARE the index.</p>
 *
 * <h2>Why import is two calls, and why the zip is uploaded twice</h2>
 *
 * <p>{@link #inspect} reads a zip and answers what is in it, WITHOUT writing
 * anything; {@link #apply} writes the subset the user then ticked. The
 * alternative — parse once, keep the zip server-side against a token — would put
 * user-supplied archives in gateway memory or on gateway disk between two
 * requests, keyed by something an attacker can guess, for a feature whose whole
 * job is to write code into a running gateway. Uploading a few hundred kilobytes
 * twice is the cheaper mistake.</p>
 *
 * <h2>What is refused, and why each check is here</h2>
 *
 * <p>A zip is attacker-controlled input that this route turns into files. Each
 * limit below is checked against the DECOMPRESSED stream, because every one of
 * them is trivial to satisfy in a compressed archive:</p>
 *
 * <ul>
 *   <li><b>Traversal.</b> An entry naming {@code ..}, an absolute path or a
 *       backslash is refused outright rather than sanitised. Sanitising invents
 *       a destination the user did not choose, and a resource path is not a
 *       filesystem path — {@link ResourcePath} would take it anywhere.</li>
 *   <li><b>Size.</b> {@link #MAX_UPLOAD_BYTES} on the archive,
 *       {@link #MAX_ENTRY_BYTES} on any single decompressed entry, and
 *       {@link #MAX_TOTAL_BYTES} across all of them — the last is what a zip
 *       bomb defeats the first two with.</li>
 *   <li><b>Count.</b> {@link #MAX_ENTRIES}, so a million empty files cannot make
 *       the parse itself the attack.</li>
 *   <li><b>Type.</b> Only resource types this IDE can already open are written.
 *       A Designer export carrying Perspective views is READ and LISTED — saying
 *       "this file contains things I will not import" is more use than refusing
 *       the file — but those entries cannot be selected.</li>
 * </ul>
 *
 * <h2>Overwrite is surfaced EARLIER than the Designer does it</h2>
 *
 * <p>Measured, and corrected once: the Designer's selection tree looks identical
 * whether or not the resources exist, but pressing Import raises a modal
 * <em>Resolve Conflicts</em> per clash, with Overwrite / Overwrite All / Skip /
 * Skip All / Rename / Cancel. This route reports {@code exists} per entry so the
 * client can show that in the selection list instead — visible before
 * committing, rather than as a dialog afterwards. The difference is one of
 * timing, not of whether the question gets asked; it fits the rest of this
 * module, whose save path is built on never replacing something the user has not
 * already seen.</p>
 */
public final class TransferRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(TransferRouteHandler.class);

    /** The whole archive, compressed, as it arrives. */
    static final int MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
    /** Any ONE entry, decompressed. A script is text; this is already generous. */
    static final int MAX_ENTRY_BYTES = 8 * 1024 * 1024;
    /** Everything decompressed, together. The check a zip bomb has to pass. */
    static final int MAX_TOTAL_BYTES = 64 * 1024 * 1024;
    static final int MAX_ENTRIES = 2000;

    /** The manifest the Designer writes at the root of every export. */
    static final String PROJECT_JSON = "project.json";
    /** The per-resource descriptor beside its data files. */
    static final String RESOURCE_JSON = "resource.json";

    /**
     * Resource paths this module will WRITE on import.
     *
     * <p>The same corpus the tree offers, and deliberately not "whatever the zip
     * contains": importing a Perspective view through a script IDE would write a
     * resource type nothing here can open, check or undo.</p>
     */
    private static final List<String> IMPORTABLE_PREFIXES = List.of(
        "ignition/script-python/",
        "com.inductiveautomation.perspective/session-scripts/",
        "ignition/event-scripts/",
        "ignition/script-timer/",
        "ignition/script-message/",
        "ignition/script-tagchange/"
    );

    private final ProjectManager projectManager;

    public TransferRouteHandler(ProjectManager projectManager) {
        this.projectManager = projectManager;
    }

    // ==================== GET /api/scripts/export ====================

    /**
     * Write the selected resources as a Designer-compatible zip.
     *
     * <p>{@code ?project=X&path=A&path=B}. Repeated {@code path} parameters
     * rather than one delimited value: a resource path contains slashes and dots
     * already, and every delimiter that has been tried in this module has been a
     * path that legitimately contained it.</p>
     *
     * <p>Resolved through {@code getResource} — the project's OWN copy — so an
     * inherited script exports nothing rather than silently exporting the
     * parent's under this project's name. That matches the rule the write and
     * delete paths already follow.</p>
     */
    public Object export(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }
        String[] raw = req.getRequest().getParameterValues("path");
        if (raw == null || raw.length == 0) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Select at least one script to export");
        }

        // Resolve everything BEFORE a byte is written: a zip that turns out to be
        // half an export is worse than a 404, because it looks like a backup.
        Map<String, Resource> found = new LinkedHashMap<>();
        List<String> missing = new ArrayList<>();
        for (String candidate : raw) {
            ResourcePath path;
            try {
                path = HandlerSupport.decodePath(candidate);
            } catch (IllegalArgumentException e) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    e.getMessage());
            }
            Optional<Resource> resource = projectManager.getResource(project, path);
            if (resource.isEmpty() || resource.get().isFolder()) {
                // A folder is not an error: selecting a package means its
                // scripts, and those arrive as their own paths.
                if (resource.isEmpty()) {
                    missing.add(HandlerSupport.encodePath(path));
                }
                continue;
            }
            // encodePath, NOT ResourcePath.getPath(): the latter drops the
            // module and type, so an entry came out as
            // `MyPackage/helpers/code.py` instead of
            // `ignition/script-python/MyPackage/helpers/code.py`. In this format
            // the paths ARE the index — there is nothing else saying what a
            // resource is — so a zip missing the prefix imports as nothing,
            // here and in the Designer alike. Caught by validate_v27 comparing
            // the entry list against a real Designer export.
            found.put(HandlerSupport.encodePath(path), resource.get());
        }
        if (!missing.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "Not in " + project + ": " + String.join(", ", missing));
        }
        if (found.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Nothing to export — the selection holds no scripts");
        }

        byte[] zip = buildZip(project, found);

        resp.setContentType("application/zip");
        resp.setHeader("Content-Disposition",
            "attachment; filename=\"" + exportFileName(project) + "\"");
        resp.setContentLength(zip.length);
        resp.getOutputStream().write(zip);
        return null;
    }

    /**
     * {@code Mining_Demo_2026-09-07_0330.zip} — the Designer's own convention,
     * measured off its Save dialog, so two exports of one project sort together
     * and a downloaded file says what it is without being opened.
     */
    static String exportFileName(String project) {
        String stamp = ZonedDateTime.now(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofPattern("yyyy-MM-dd_HHmm"));
        return safeFileName(project) + "_" + stamp + ".zip";
    }

    /** Whatever the project is called, made safe for a Content-Disposition. */
    static String safeFileName(String project) {
        String cleaned = project.replaceAll("[^A-Za-z0-9._-]", "_");
        return cleaned.isBlank() ? "project" : cleaned;
    }

    byte[] buildZip(String project, Map<String, Resource> resources) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
            write(zip, PROJECT_JSON, projectManifest(project).getBytes(StandardCharsets.UTF_8));
            for (Map.Entry<String, Resource> entry : resources.entrySet()) {
                String base = entry.getKey();
                Resource resource = entry.getValue();
                write(zip, base + "/" + RESOURCE_JSON,
                    resourceManifest(resource).getBytes(StandardCharsets.UTF_8));
                for (String key : resource.getDataKeys()) {
                    Optional<ImmutableBytes> data = resource.getData(key);
                    if (data.isPresent()) {
                        write(zip, base + "/" + key, data.get().getBytes());
                    }
                }
            }
        }
        return out.toByteArray();
    }

    private static void write(ZipOutputStream zip, String name, byte[] body) throws IOException {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(body);
        zip.closeEntry();
    }

    /**
     * The root {@code project.json}.
     *
     * <p>Five fields, in the Designer's order. {@code parent} is written as the
     * empty string for a project with none, which is what the Designer writes —
     * not omitted and not null.</p>
     */
    String projectManifest(String project) {
        // ResourceCollectionManifest carries exactly the five fields the
        // Designer writes, which is not a coincidence: it IS project.json.
        ResourceCollectionManifest manifest = null;
        try {
            manifest = projectManager.getManifests().get(project);
        } catch (Exception e) {
            logger.debug("getManifests() failed for {}: {}", project, e.getMessage());
        }
        JsonObject out = new JsonObject();
        out.addProperty("title", manifest == null ? project : manifest.title());
        out.addProperty("description", manifest == null ? "" : manifest.description());
        out.addProperty("enabled", manifest == null || manifest.enabled());
        out.addProperty("inheritable", manifest != null && manifest.inheritable());
        // The empty string for no parent, not null and not omitted — measured.
        String parent = manifest == null ? null : manifest.parent();
        out.addProperty("parent", parent == null ? "" : parent);
        return HandlerSupport.GSON.toJson(out);
    }

    /**
     * One resource's {@code resource.json}, in the shape the Designer exports.
     *
     * <p>{@code scope} is a LETTER, not the integer the API returns —
     * {@code ApplicationScope.toCode} does that conversion, taken from the
     * platform rather than a hand-written map that would drift the first time a
     * scope is added.</p>
     */
    String resourceManifest(Resource resource) {
        JsonObject out = new JsonObject();
        out.addProperty("scope", ApplicationScope.toCode(resource.getApplicationScope()));
        out.addProperty("version", resource.getVersion());
        out.addProperty("restricted", resource.isRestricted());
        out.addProperty("overridable", resource.isOverridable());
        JsonArray files = new JsonArray();
        resource.getDataKeys().forEach(files::add);
        out.add("files", files);
        JsonObject attributes = new JsonObject();
        // The platform's attributes are the SHADED gson's JsonElement
        // (com.inductiveautomation.ignition.common.gson), a different type from
        // ours despite the identical shape. Bridged through their JSON text
        // rather than by reflection or a typed switch: an attribute can be an
        // object — `lastModification` is one — and a switch over primitives
        // would silently flatten it.
        resource.getAttributes().forEach((name, value) ->
            attributes.add(name, JsonParser.parseString(String.valueOf(value))));
        out.add("attributes", attributes);
        return HandlerSupport.GSON.toJson(out);
    }

    // ==================== POST /api/scripts/import/inspect ====================

    /**
     * Read an uploaded zip and say what is in it. Writes nothing.
     *
     * <p>Every entry comes back with what the client needs to render the choice
     * the Designer does not offer: whether this project already has it
     * ({@code exists}), and whether this module will write it at all
     * ({@code importable}).</p>
     */
    public Object inspect(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
        }
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        if (projectManager.find(project).isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such project: " + project);
        }

        Archive archive;
        try {
            archive = read(req.getRequest().getInputStream());
        } catch (ArchiveRejected e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        JsonObject out = new JsonObject();
        out.addProperty("project", project);
        if (archive.projectJson != null) {
            try {
                out.add("source", HandlerSupport.GSON.fromJson(
                    new String(archive.projectJson, StandardCharsets.UTF_8), JsonObject.class));
            } catch (JsonParseException e) {
                // A malformed manifest is not fatal — the resources are what
                // matter, and refusing the file over its cover page would be a
                // worse answer than importing without it.
                logger.debug("Unreadable project.json in upload: {}", e.getMessage());
            }
        }
        JsonArray entries = new JsonArray();
        for (Map.Entry<String, Map<String, byte[]>> item : archive.resources.entrySet()) {
            String path = item.getKey();
            JsonObject row = new JsonObject();
            row.addProperty("path", path);
            row.addProperty("importable", isImportable(path));
            row.addProperty("exists", projectManager
                .getResource(project, HandlerSupport.decodePath(path)).isPresent());
            JsonArray files = new JsonArray();
            int bytes = 0;
            for (Map.Entry<String, byte[]> file : item.getValue().entrySet()) {
                if (RESOURCE_JSON.equals(file.getKey())) {
                    continue;
                }
                files.add(file.getKey());
                bytes += file.getValue().length;
            }
            row.add("files", files);
            row.addProperty("bytes", bytes);
            entries.add(row);
        }
        out.add("entries", entries);
        return out;
    }

    // ==================== POST /api/scripts/import ====================

    /**
     * Write the selected resources from an uploaded zip.
     *
     * <p>One push per resource rather than one push for all of them. A single
     * PushOperation would be atomic, which sounds better and is not: a
     * twenty-script import that fails on the last one would roll back nineteen
     * good writes, and the user has no way to tell which one was bad. Each
     * resource is reported individually and the response says what happened to
     * every one.</p>
     */
    public Object apply(RequestContext req, HttpServletResponse resp) throws IOException {
        String project = req.getParameter("project");
        if (project == null || project.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'project' parameter");
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
        String[] selected = req.getRequest().getParameterValues("path");
        if (selected == null || selected.length == 0) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Select at least one resource to import");
        }
        Set<String> wanted = new LinkedHashSet<>(List.of(selected));

        Archive archive;
        try {
            archive = read(req.getRequest().getInputStream());
        } catch (ArchiveRejected e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST, e.getMessage());
        }

        JsonArray results = new JsonArray();
        int written = 0;
        for (String path : wanted) {
            JsonObject row = new JsonObject();
            row.addProperty("path", path);
            Map<String, byte[]> files = archive.resources.get(path);
            if (files == null) {
                row.addProperty("status", "missing");
                row.addProperty("detail", "not in the uploaded file");
                results.add(row);
                continue;
            }
            if (!isImportable(path)) {
                row.addProperty("status", "skipped");
                row.addProperty("detail", "this module does not write that resource type");
                results.add(row);
                continue;
            }
            try {
                boolean replaced = writeResource(project, path, files, req);
                row.addProperty("status", replaced ? "replaced" : "created");
                written++;
            } catch (TransferFailed e) {
                row.addProperty("status", "failed");
                row.addProperty("detail", e.getMessage());
            }
            results.add(row);
        }

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        out.addProperty("written", written);
        out.add("results", results);
        return out;
    }

    /** @return true when an existing resource was replaced rather than created. */
    private boolean writeResource(String project, String path, Map<String, byte[]> files,
                                  RequestContext req) throws TransferFailed {
        ResourcePath resourcePath = HandlerSupport.decodePath(path);
        JsonObject manifest = manifestOf(files);

        Optional<Resource> existingOpt = projectManager.getResource(project, resourcePath);
        ResourceBuilder builder = existingOpt.isPresent()
            ? existingOpt.get().toBuilder().clearData()
            : Resource.newBuilder()
                .setResourceCollectionName(project)
                .setResourcePath(resourcePath);

        applyManifest(builder, manifest);
        for (Map.Entry<String, byte[]> file : files.entrySet()) {
            if (!RESOURCE_JSON.equals(file.getKey())) {
                builder.putData(file.getKey(), file.getValue());
            }
        }

        ChangeOperation op = existingOpt.isPresent()
            ? ChangeOperation.newModifyOp(builder.build(),
                existingOpt.get().getResourceSignature())
            : ChangeOperation.newCreateOp(builder.build());
        try {
            projectManager.push(new PushOperation(List.of(op), HandlerSupport.actorFor(req)))
                .get(HandlerSupport.PUSH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new TransferFailed("interrupted");
        } catch (TimeoutException e) {
            throw new TransferFailed("timed out");
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            throw new TransferFailed(cause.getMessage());
        } catch (RuntimeException e) {
            throw new TransferFailed(e.getMessage());
        } catch (PushException e) {
            // Declared by push() and thrown for a rejected change — a signature
            // that moved under us, or a resource the collection refuses. One
            // resource's problem, not the import's: the loop reports it and
            // carries on with the rest.
            throw new TransferFailed(e.getMessage());
        }
        return existingOpt.isPresent();
    }

    private static JsonObject manifestOf(Map<String, byte[]> files) {
        byte[] raw = files.get(RESOURCE_JSON);
        if (raw == null) {
            return new JsonObject();
        }
        try {
            JsonObject parsed = HandlerSupport.GSON.fromJson(
                new String(raw, StandardCharsets.UTF_8), JsonObject.class);
            return parsed == null ? new JsonObject() : parsed;
        } catch (JsonParseException e) {
            return new JsonObject();
        }
    }

    /**
     * Carry the exported descriptor onto the resource being written.
     *
     * <p>{@code files} is deliberately ignored: the data keys come from what the
     * archive actually CONTAINS, so a manifest listing a file the zip does not
     * hold cannot create a resource with an empty data key that reads as an
     * empty script.</p>
     *
     * <p>{@code lastModification} is not carried either. The gateway stamps it
     * for the actor performing the push, and importing somebody else's timestamp
     * would make the project history say a change happened before it did — see
     * {@code reference-ignition-config-resource-stamp}: the stamp is what makes a
     * resource visible at all, so it must be the platform's own.</p>
     */
    static void applyManifest(ResourceBuilder builder, JsonObject manifest) {
        if (manifest.has("scope") && manifest.get("scope").isJsonPrimitive()) {
            builder.setApplicationScope(
                ApplicationScope.parseScope(manifest.get("scope").getAsString()));
        }
        if (manifest.has("version") && manifest.get("version").isJsonPrimitive()) {
            builder.setVersion(manifest.get("version").getAsInt());
        }
        if (manifest.has("restricted") && manifest.get("restricted").isJsonPrimitive()) {
            builder.setRestricted(manifest.get("restricted").getAsBoolean());
        }
        if (manifest.has("overridable") && manifest.get("overridable").isJsonPrimitive()) {
            builder.setOverridable(manifest.get("overridable").getAsBoolean());
        }
        if (manifest.has("attributes") && manifest.get("attributes").isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry
                    : manifest.getAsJsonObject("attributes").entrySet()) {
                if (SKIPPED_ATTRIBUTES.contains(entry.getKey())) {
                    continue;
                }
                putAttribute(builder, entry.getKey(), entry.getValue());
            }
        }
    }

    /**
     * The attributes an import must NOT carry across.
     *
     * <p>Both describe the exporting gateway's opinion of when the resource last
     * changed. The platform stamps them itself for the actor performing the
     * push, and importing somebody else's would make this project's history say
     * a change happened before it did.</p>
     */
    private static final Set<String> SKIPPED_ATTRIBUTES =
        Set.of("lastModification", "lastModificationSignature");

    /**
     * One attribute, onto the builder's typed overloads.
     *
     * <p>Dispatched on the primitive kind rather than passed as an Object: the
     * builder's {@code putAttribute(String, JsonElement)} takes the SHADED gson's
     * element, so an Object argument binds to it and does not compile — the same
     * trap {@code ScriptAttributesRouteHandler} documents. A non-primitive is
     * dropped rather than stringified, because an attribute rendered as its own
     * JSON text is a different value that happens to print the same.</p>
     */
    static void putAttribute(ResourceBuilder builder, String name, JsonElement value) {
        if (!value.isJsonPrimitive()) {
            logger.debug("Dropping non-primitive attribute '{}' on import", name);
            return;
        }
        var primitive = value.getAsJsonPrimitive();
        if (primitive.isBoolean()) {
            builder.putAttribute(name, primitive.getAsBoolean());
        } else if (primitive.isNumber()) {
            long asLong = primitive.getAsLong();
            if (asLong == (int) asLong) {
                builder.putAttribute(name, (int) asLong);
            } else {
                builder.putAttribute(name, asLong);
            }
        } else {
            builder.putAttribute(name, primitive.getAsString());
        }
    }

    static boolean isImportable(String path) {
        return IMPORTABLE_PREFIXES.stream().anyMatch(path::startsWith);
    }

    // ==================== reading an uploaded archive ====================

    /** What one upload turned out to hold. */
    record Archive(byte[] projectJson, Map<String, Map<String, byte[]>> resources) { }

    /** An upload this route will not process, with the reason a user can act on. */
    static final class ArchiveRejected extends Exception {
        private static final long serialVersionUID = 1L;

        ArchiveRejected(String message) {
            super(message);
        }
    }

    /** One resource failed to write. The others still go. */
    static final class TransferFailed extends Exception {
        private static final long serialVersionUID = 1L;

        TransferFailed(String message) {
            super(message == null ? "unknown error" : message);
        }
    }

    /**
     * Read an uploaded zip into memory, refusing anything outside the limits.
     *
     * <p>Grouped by the directory holding a {@code resource.json}, which is what
     * makes a resource a resource in this format. A file that sits under no such
     * directory is dropped rather than guessed at.</p>
     */
    static Archive read(InputStream body) throws ArchiveRejected, IOException {
        byte[] raw = readLimited(body, MAX_UPLOAD_BYTES,
            "The file is larger than " + (MAX_UPLOAD_BYTES / (1024 * 1024)) + " MB");
        if (raw.length == 0) {
            throw new ArchiveRejected("The upload was empty");
        }
        // ZipInputStream does NOT throw on data that is not a zip — it simply
        // yields no entries, so a `.py` file uploaded by mistake came back as
        // "it holds no resource.json", which is true and sends the reader
        // looking for the wrong problem. Caught by the unit test that asserted
        // the message rather than the exception type.
        if (!looksLikeZip(raw)) {
            throw new ArchiveRejected("That is not a readable zip file");
        }

        Map<String, Map<String, byte[]>> grouped = new LinkedHashMap<>();
        byte[] projectJson = null;
        long total = 0;
        int count = 0;
        try (ZipInputStream zip = new ZipInputStream(
                new java.io.ByteArrayInputStream(raw), StandardCharsets.UTF_8)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (++count > MAX_ENTRIES) {
                    throw new ArchiveRejected(
                        "The file holds more than " + MAX_ENTRIES + " entries");
                }
                String name = entry.getName();
                if (entry.isDirectory()) {
                    continue;
                }
                rejectUnsafe(name);
                byte[] content = readLimited(zip, MAX_ENTRY_BYTES,
                    "Entry is larger than " + (MAX_ENTRY_BYTES / (1024 * 1024)) + " MB: " + name);
                total += content.length;
                if (total > MAX_TOTAL_BYTES) {
                    throw new ArchiveRejected("The file expands to more than "
                        + (MAX_TOTAL_BYTES / (1024 * 1024)) + " MB");
                }
                if (PROJECT_JSON.equals(name)) {
                    projectJson = content;
                    continue;
                }
                int slash = name.lastIndexOf('/');
                if (slash <= 0) {
                    continue;
                }
                grouped.computeIfAbsent(name.substring(0, slash), k -> new LinkedHashMap<>())
                    .put(name.substring(slash + 1), content);
            }
        } catch (java.util.zip.ZipException e) {
            throw new ArchiveRejected("That is not a readable zip file");
        }

        // A directory without a resource.json is not a resource — it is the
        // parent of one, or a stray. Dropping it here is what keeps `entries`
        // a list of things that can actually be imported.
        Map<String, Map<String, byte[]>> resources = new LinkedHashMap<>();
        grouped.forEach((path, files) -> {
            if (files.containsKey(RESOURCE_JSON)) {
                resources.put(path, files);
            }
        });
        if (resources.isEmpty()) {
            throw new ArchiveRejected(
                "No project resources in that file — it holds no resource.json");
        }
        return new Archive(projectJson, resources);
    }

    /**
     * The local-file-header magic every non-empty zip starts with.
     *
     * <p>{@code PK\x03\x04}. An empty archive starts {@code PK\x05\x06} (the
     * end-of-central-directory record) and is accepted here, so that an empty
     * export is refused for being empty rather than for being malformed.</p>
     */
    static boolean looksLikeZip(byte[] raw) {
        return raw.length >= 4 && raw[0] == 'P' && raw[1] == 'K'
            && (raw[2] == 3 || raw[2] == 5 || raw[2] == 7);
    }

    /**
     * Refuse rather than sanitise.
     *
     * <p>A sanitised path is a destination the user did not choose and cannot
     * see, and these names become {@link ResourcePath}s, not filenames — the
     * usual "strip the {@code ..}" reflex leaves something that still resolves
     * somewhere. Anything not plainly relative is an error with the entry named,
     * so whoever built the archive can fix it.</p>
     */
    static void rejectUnsafe(String name) throws ArchiveRejected {
        if (name.startsWith("/") || name.startsWith("\\") || name.contains("\\")
            || name.contains(":")) {
            throw new ArchiveRejected("Unsafe path in the file: " + name);
        }
        for (String segment : name.split("/")) {
            if ("..".equals(segment) || ".".equals(segment)) {
                throw new ArchiveRejected("Unsafe path in the file: " + name);
            }
        }
    }

    private static byte[] readLimited(InputStream in, int limit, String message)
            throws ArchiveRejected, IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int read;
        while ((read = in.read(buffer)) != -1) {
            if (out.size() + read > limit) {
                throw new ArchiveRejected(message);
            }
            out.write(buffer, 0, read);
        }
        return out.toByteArray();
    }
}
