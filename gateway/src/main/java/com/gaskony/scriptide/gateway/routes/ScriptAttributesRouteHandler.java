package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.common.ScriptResourceTypes;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.inductiveautomation.ignition.common.resourcecollection.ChangeOperation;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.project.ProjectManager;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Reads and writes a script resource's {@code resource.json} attributes — a
 * timer's delay and threading, a message handler's thread type, a library
 * script's hint scope.
 *
 * <p>This exists as a separate route because the content write only ever calls
 * {@code putData}; attributes survive untouched through {@code toBuilder()} and
 * need {@code putAttribute}, which the SDK keeps as a genuinely separate call.</p>
 *
 * <h2>The allowlist is per-type, not a union</h2>
 *
 * <p>{@link ScriptResourceTypes} holds the measured spellings, and they really do
 * differ between types that look alike: a timer's {@code sharedThread} is a
 * boolean, a message handler's {@code threadType} is a case-sensitive string. A
 * key outside its own type's set is a 400, never a silent drop — writing an
 * attribute the Designer does not recognise leaves a resource that looks fine and
 * behaves wrongly.</p>
 *
 * <p>Types whose Designer workspace was never measured have an EMPTY allowlist and
 * therefore reject every attribute write. That is deliberate: see
 * {@link ScriptResourceTypes}.</p>
 */
public final class ScriptAttributesRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(ScriptAttributesRouteHandler.class);

    private final ProjectManager projectManager;
    private final ScriptResourceRouteHandler resources;

    public ScriptAttributesRouteHandler(ProjectManager projectManager,
                                        ScriptResourceRouteHandler resources) {
        this.projectManager = projectManager;
        this.resources = resources;
    }

    /** {@code GET /api/scripts/attributes/:path?project=X} */
    public Object read(RequestContext req, HttpServletResponse resp) {
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
        // Check the moduleId as well as the typeId, matching the content routes.
        // typeId alone would admit another module's resource type that happened to
        // be named "timer" or "script-python". Not known to be exploitable, but the
        // two write surfaces should not disagree about what they accept.
        var typeOpt = editableTypeOf(path);
        if (typeOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Not an editable script resource type");
        }

        Optional<Resource> resourceOpt = projectManager.find(project)
            .flatMap(c -> c.getResource(path));
        if (resourceOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such script: " + path);
        }
        Resource resource = resourceOpt.get();

        JsonObject attrs = new JsonObject();
        for (String name : typeOpt.get().attributeAllowlist()) {
            resource.getAttribute(name).ifPresent(v -> attrs.add(name, toJson(v)));
        }

        JsonObject out = new JsonObject();
        out.addProperty("path", HandlerSupport.encodePath(path));
        out.addProperty("signature", resource.getResourceSignature().toString());
        // Tell the client what it may set, so the UI can render only the fields
        // this type actually supports rather than guessing.
        var editable = new com.google.gson.JsonArray();
        typeOpt.get().attributeAllowlist().forEach(editable::add);
        out.add("editable", editable);
        out.add("attributes", attrs);
        return out;
    }

    /** {@code POST /api/scripts/attributes/:path?project=X} with {@code {attributes:{…}}}. */
    public Object write(RequestContext req, HttpServletResponse resp) throws java.io.IOException {
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
        // Check the moduleId as well as the typeId, matching the content routes.
        // typeId alone would admit another module's resource type that happened to
        // be named "timer" or "script-python". Not known to be exploitable, but the
        // two write surfaces should not disagree about what they accept.
        var typeOpt = editableTypeOf(path);
        if (typeOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Not an editable script resource type");
        }
        Set<String> allowed = typeOpt.get().attributeAllowlist();
        if (allowed.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Attributes for '" + path.getResourceType().typeId() + "' are not editable: "
                    + "this type's Designer workspace has not been measured, so writing one "
                    + "would be a guess. See ScriptResourceTypes.");
        }

        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }

        AttributeRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), AttributeRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.attributes == null || body.attributes.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a non-empty 'attributes' object");
        }
        if (!projectManager.isMutable(project)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Project is not mutable: " + project);
        }

        Optional<Resource> existingOpt = projectManager.getResource(project, path);
        if (existingOpt.isEmpty()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such script in this project (attributes cannot be set on an "
                    + "inherited resource without first overriding it): " + path);
        }
        Resource existing = existingOpt.get();

        String expected = HandlerSupport.expectedSignature(req, body.baseSignature);
        String current = existing.getResourceSignature().toString();
        if (expected == null || expected.isBlank()) {
            return HandlerSupport.error(resp, HandlerSupport.SC_PRECONDITION_REQUIRED,
                "Missing If-Match/baseSignature — read the script before updating it");
        }
        if (!expected.equals(current)) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "This script changed on the gateway since you opened it (concurrent edit)");
        }

        com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder builder =
            existing.toBuilder();
        for (Map.Entry<String, JsonElement> e : body.attributes.entrySet()) {
            String name = e.getKey();
            if (!allowed.contains(name)) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    "Attribute '" + name + "' is not settable on a "
                        + path.getResourceType().typeId() + " (allowed: " + allowed + ")");
            }
            Object value;
            try {
                value = validate(name, e.getValue(), path.getResourceType().typeId());
            } catch (IllegalArgumentException ex) {
                return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                    ex.getMessage());
            }
            // ResourceBuilder has typed putAttribute overloads. Dispatch on the
            // validated Java type — passing an Object would bind to the shaded
            // JsonElement overload and fail to compile.
            if (value instanceof Boolean b) {
                builder.putAttribute(name, b.booleanValue());
            } else if (value instanceof Integer i) {
                builder.putAttribute(name, i.intValue());
            } else if (value instanceof Long l) {
                builder.putAttribute(name, l.longValue());
            } else {
                builder.putAttribute(name, String.valueOf(value));
            }
        }

        Resource updated = builder.build();
        ChangeOperation op = ChangeOperation.newModifyOp(updated, existing.getResourceSignature());
        Object pushError = resources.push(op, project, path, req, resp);
        if (pushError != null) {
            return pushError;
        }

        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        projectManager.getResource(project, path)
            .ifPresent(now -> out.addProperty("signature", now.getResourceSignature().toString()));
        return out;
    }

    /**
     * The editable script type for a path, requiring the {@code ignition} module id
     * as well as the type id.
     *
     * <p>Checking the type id alone would admit another module's resource type that
     * happened to be named {@code timer} or {@code script-python}. The content
     * routes already check both; the two write surfaces should not disagree about
     * what they accept.</p>
     */
    private static Optional<ScriptResourceTypes.ScriptType> editableTypeOf(ResourcePath path) {
        var type = path.getResourceType();
        if (!ScriptResourceTypes.IGNITION_MODULE.equals(type.moduleId())) {
            return Optional.empty();
        }
        Optional<ScriptResourceTypes.ScriptType> found =
            ScriptResourceTypes.byTypeId(type.typeId());
        // Refuse the folder. The platform reports every event-script directory
        // that has children as a resource with a real signature and an empty
        // name, and before this guard an attribute write to `ignition/scheduled`
        // returned 200 and stored a cronExpression on a directory. Only the three
        // singletons legitimately have no name segment. Measured 01/09/2026 —
        // see ScriptResourceRouteHandler#isNamelessNonSingleton.
        // isResourceTypeFolder(), not getName(): on `ignition/scheduled`
        // getName() returns "scheduled", so a name check never fires.
        if (path.isResourceTypeFolder() && found.map(t -> !t.singleton()).orElse(true)) {
            return Optional.empty();
        }
        return found;
    }

    /**
     * Validate and unwrap one attribute value, enforcing the type the Designer
     * actually writes.
     *
     * <p>The types are checked rather than coerced. A {@code threadType} of
     * {@code "shared"} (lower case) or a {@code sharedThread} of {@code "true"}
     * (a string) is accepted by the resource layer and then behaves wrongly, with
     * nothing in any log to say so.</p>
     */
    private static Object validate(String name, JsonElement value, String typeId) {
        switch (name) {
            case "hintScope": {
                int v = asInt(name, value);
                if (!ScriptResourceTypes.HINT_SCOPE_VALUES.contains(v)) {
                    throw new IllegalArgumentException(
                        "hintScope must be one of " + ScriptResourceTypes.HINT_SCOPE_VALUES
                            + " (ApplicationScope bitmask), got " + v);
                }
                return v;
            }
            case "threadType": {
                String v = asString(name, value);
                if (!ScriptResourceTypes.THREAD_TYPE_VALUES.contains(v)) {
                    throw new IllegalArgumentException(
                        "threadType must be exactly one of "
                            + ScriptResourceTypes.THREAD_TYPE_VALUES + " (case-sensitive), got '"
                            + v + "'");
                }
                return v;
            }
            case "delay": {
                long v = asLong(name, value);
                if (v < 0 || v > ScriptResourceTypes.MAX_TIMER_DELAY_MS) {
                    throw new IllegalArgumentException(
                        "delay must be between 0 and " + ScriptResourceTypes.MAX_TIMER_DELAY_MS
                            + " ms, got " + v);
                }
                return v;
            }
            case "cronExpression": {
                String v = asString(name, value);
                // Shape only. The gateway's own scheduler is the arbiter of
                // whether an expression is valid, and a stricter check here
                // would reject expressions the platform accepts — which is a
                // worse failure than passing one through and being told.
                String trimmed = v.trim();
                if (trimmed.isEmpty()) {
                    throw new IllegalArgumentException(
                        "cronExpression cannot be empty — a scheduled script with no "
                            + "expression never runs");
                }
                if (trimmed.length() > ScriptResourceTypes.MAX_CRON_LENGTH) {
                    throw new IllegalArgumentException(
                        "cronExpression must be at most "
                            + ScriptResourceTypes.MAX_CRON_LENGTH + " characters");
                }
                int fields = trimmed.split("\\s+").length;
                if (fields < 5 || fields > 7) {
                    throw new IllegalArgumentException(
                        "cronExpression must have between 5 and 7 space-separated fields, got "
                            + fields);
                }
                // Stored trimmed: a trailing space round-trips into the resource
                // and then differs from the same expression typed in the Designer,
                // which shows up as a spurious change on every diff.
                return trimmed;
            }
            // sharedThread is a BOOLEAN here; the message-handler equivalent is a
            // STRING named threadType. They are not interchangeable.
            case "enabled":
            case "fixedDelay":
            case "sharedThread":
                return asBoolean(name, value);
            // Tag Change, measured 06/09/2026 off a real resource: both are JSON
            // ARRAYS of strings, not scalars.
            case "paths":
                return asStringArray(name, value, MAX_TAG_PATHS, path -> {
                    if (path.isBlank()) {
                        throw new IllegalArgumentException("A tag path cannot be blank");
                    }
                    if (path.length() > MAX_TAG_PATH_LENGTH) {
                        throw new IllegalArgumentException(
                            "A tag path must be at most " + MAX_TAG_PATH_LENGTH
                                + " characters");
                    }
                });
            case "changeTypes":
                return asStringArray(name, value, CHANGE_TYPES.size(), type -> {
                    if (!CHANGE_TYPES.contains(type)) {
                        // An allowlist, not a free string: an unrecognised change
                        // type is silently ignored by the platform, so the script
                        // would sit there configured and never fire.
                        throw new IllegalArgumentException(
                            "changeTypes must be one of " + CHANGE_TYPES + ", got '"
                                + type + "'");
                    }
                });
            default:
                // Unreachable: the allowlist is checked before this is called.
                // Fail loudly rather than write an unvalidated value.
                throw new IllegalArgumentException(
                    "No validator for attribute '" + name + "' on " + typeId);
        }
    }

    /** The change types a tag-change script may subscribe to. Measured. */
    private static final java.util.List<String> CHANGE_TYPES =
        java.util.List.of("ValueChange", "QualityChange", "TimestampChange");

    /** Tag paths per script, and the length of one. Bounds, not opinions. */
    private static final int MAX_TAG_PATHS = 500;
    private static final int MAX_TAG_PATH_LENGTH = 1000;

    /** What each element of a string array must satisfy. */
    private interface ElementCheck {
        void check(String value);
    }

    /**
     * A JSON array of strings, validated element by element.
     *
     * <p>Returned as a {@code List<String>} so the resource writer stores a real
     * JSON array. Storing it as a comma-joined string would round-trip through
     * this module and be unreadable to the Designer, which is the worse half of
     * getting a resource shape wrong: it looks like it worked.</p>
     */
    private static java.util.List<String> asStringArray(String name, JsonElement v,
                                                        int max, ElementCheck check) {
        if (!v.isJsonArray()) {
            throw new IllegalArgumentException(name + " must be an array of strings, got " + v);
        }
        var array = v.getAsJsonArray();
        if (array.size() > max) {
            throw new IllegalArgumentException(
                name + " must have at most " + max + " entries, got " + array.size());
        }
        java.util.List<String> out = new java.util.ArrayList<>();
        java.util.Set<String> seen = new java.util.LinkedHashSet<>();
        for (JsonElement element : array) {
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw new IllegalArgumentException(
                    name + " must contain only strings, got " + element);
            }
            String value = element.getAsString().trim();
            check.check(value);
            // Duplicates dropped: subscribing twice to one tag is not an error
            // the platform reports, and it doubles every event the script sees.
            if (seen.add(value)) {
                out.add(value);
            }
        }
        return out;
    }

    private static boolean asBoolean(String name, JsonElement v) {
        if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isBoolean()) {
            throw new IllegalArgumentException(name + " must be a boolean, got " + v);
        }
        return v.getAsBoolean();
    }

    private static String asString(String name, JsonElement v) {
        if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()) {
            throw new IllegalArgumentException(name + " must be a string, got " + v);
        }
        return v.getAsString();
    }

    private static int asInt(String name, JsonElement v) {
        if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException(name + " must be a number, got " + v);
        }
        return v.getAsInt();
    }

    private static long asLong(String name, JsonElement v) {
        if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isNumber()) {
            throw new IllegalArgumentException(name + " must be a number, got " + v);
        }
        return v.getAsLong();
    }

    /**
     * Bridge one attribute value from IA's SHADED Gson into plain Gson.
     *
     * <p>{@code Resource.getAttribute} returns
     * {@code com.inductiveautomation.ignition.common.gson.JsonElement} — a
     * different class from the {@code com.google.gson.JsonElement} this module
     * ships, not a classloader variant of it. They cannot be assigned across, so
     * the conversion is a {@code toString()} and a re-parse. That is the standard
     * bridge for this boundary in the estate, and it is why shipping our own Gson
     * is safe: no shaded type is ever handed to it directly.</p>
     */
    private static JsonElement toJson(com.inductiveautomation.ignition.common.gson.JsonElement shaded) {
        try {
            return com.google.gson.JsonParser.parseString(shaded.toString());
        } catch (RuntimeException e) {
            logger.debug("Could not bridge shaded attribute value, using its text: {}",
                e.getMessage());
            return new com.google.gson.JsonPrimitive(shaded.toString());
        }
    }

    /** Body of an attribute write: {@code {attributes:{…}, baseSignature?}}. */
    static final class AttributeRequest {
        Map<String, JsonElement> attributes;
        String baseSignature;
    }
}
