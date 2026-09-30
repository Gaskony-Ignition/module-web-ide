package com.gaskony.scriptide.common;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The script resource types this IDE edits, and what the real Designer writes for
 * each.
 *
 * <p>Every value here is MEASURED from resources the real Ignition Designer
 * wrote — see web-designer's {@code docs/design-handoff/real-designer/SCRIPTING.md}
 * §5 and this module's {@code docs/spikes/S1.md}. Nothing here is inferred by
 * analogy, because the types genuinely differ from one another in ways that look
 * like they should not:</p>
 *
 * <ul>
 *   <li>A timer's threading flag is {@code sharedThread}, a <b>boolean</b>. A
 *       message handler's is {@code threadType}, a <b>case-sensitive string</b>
 *       ({@code "Shared"} / {@code "Dedicated"}). Do not generalise one onto the
 *       other.</li>
 *   <li>Startup, shutdown and update are <b>singletons</b>: their resource path
 *       has no name segment at all, so the encoded path is just
 *       {@code <moduleId>/<typeId>}.</li>
 *   <li>A project-library package directory gets <b>no resource of its own</b>,
 *       unlike a Perspective view folder.</li>
 * </ul>
 *
 * <h2>Why some types are read-only for attributes</h2>
 *
 * <p>{@link #attributeAllowlist} is empty for scheduled, tag-change, shutdown and
 * update. That is deliberate, not an oversight: their Designer workspaces were
 * never opened and measured, so nothing establishes what the Designer actually
 * writes. Guessing would put an invented value onto a live gateway on the strength
 * of somebody else's file. Measure with the {@code designer-drive} skill first,
 * then add the entry — it is one line.</p>
 */
public final class ScriptResourceTypes {

    private ScriptResourceTypes() { /* constants only */ }

    /** Module id every built-in script resource type lives under. */
    public static final String IGNITION_MODULE = "ignition";

    public static final String TYPE_SCRIPT_PYTHON = "script-python";
    public static final String TYPE_TIMER = "timer";

    /**
     * Web Dev endpoints, which live under a DIFFERENT module id.
     *
     * <p>Measured 01/09/2026 on a real gateway: the resource path is
     * {@code com.inductiveautomation.webdev/resources/<name>} and the directory
     * holds a {@code config.json} plus one {@code do<Method>.py} per HTTP verb
     * that exists. There are no editable {@code resource.json} attributes at all
     * — everything a Designer shows (enabled, require-auth, require-https,
     * required roles, user source, retry count) lives INSIDE {@code config.json},
     * which is a data file, not an attribute. That is why Web Dev has its own
     * config route rather than going through the attributes one.</p>
     */
    public static final String WEBDEV_MODULE = "com.inductiveautomation.webdev";
    public static final String TYPE_WEBDEV = "resources";
    /** The data file holding a Web Dev endpoint's per-method settings. */
    public static final String WEBDEV_CONFIG_KEY = "config.json";

    /**
     * The eight HTTP methods a Web Dev endpoint can implement, in the order the
     * Designer lists them. Each maps to a {@code do<Method>.py} data key.
     */
    public static final List<String> WEBDEV_METHODS = List.of(
        "doGet", "doPost", "doPut", "doDelete", "doHead", "doOptions", "doTrace", "doPatch");

    /** Per-method settings the config file carries, measured off a real resource. */
    public static final Set<String> WEBDEV_METHOD_SETTINGS = Set.of(
        "enabled", "max-retry-attempts", "require-auth", "require-https",
        "required-roles", "user-source");
    public static final String TYPE_MESSAGE = "message";
    public static final String TYPE_SCHEDULED = "scheduled";
    public static final String TYPE_TAG_CHANGE = "tag-change";
    public static final String TYPE_STARTUP = "startup";
    public static final String TYPE_SHUTDOWN = "shutdown";
    public static final String TYPE_UPDATE = "update";

    /** One editable script resource type. */
    public static final class ScriptType {
        private final String typeId;
        private final String label;
        private final String createKey;
        private final boolean singleton;
        private final Set<String> attributeAllowlist;

        ScriptType(String typeId, String label, String createKey, boolean singleton,
                   Set<String> attributeAllowlist) {
            this.typeId = typeId;
            this.label = label;
            this.createKey = createKey;
            this.singleton = singleton;
            this.attributeAllowlist = Collections.unmodifiableSet(attributeAllowlist);
        }

        public String typeId() {
            return typeId;
        }

        /** Human-readable name for the file tree. */
        public String label() {
            return label;
        }

        /**
         * The data key to use when CREATING a resource of this type.
         *
         * <p>For an EXISTING resource, always use the key the resource actually
         * carries (the listing publishes {@code dataKeys}) — never look it up
         * here. A resource written by an older Designer can legitimately differ,
         * and silently writing to the wrong key creates a second key rather than
         * updating the script.</p>
         */
        public String createKey() {
            return createKey;
        }

        /** True when the type has exactly one resource, with an empty name segment. */
        public boolean singleton() {
            return singleton;
        }

        /** Attribute names writable for this type. Empty means "body only". */
        public Set<String> attributeAllowlist() {
            return attributeAllowlist;
        }
    }

    private static final Map<String, ScriptType> TYPES;

    static {
        Map<String, ScriptType> m = new LinkedHashMap<>();
        // Project Library. scope "A". hintScope is an ApplicationScope bitmask:
        // 0=None, 1=Gateway, 2=Designer, 7=All — each value set, saved and read
        // back against a real gateway.
        m.put(TYPE_SCRIPT_PYTHON, new ScriptType(
            TYPE_SCRIPT_PYTHON, "Project Library", "code.py", false,
            new LinkedHashSet<>(Set.of("hintScope"))));
        // Gateway timer. NOTE sharedThread is a BOOLEAN.
        m.put(TYPE_TIMER, new ScriptType(
            TYPE_TIMER, "Timer", "handleTimerEvent.py", false,
            new LinkedHashSet<>(Set.of("enabled", "delay", "fixedDelay", "sharedThread"))));
        // Gateway message handler. NOTE threadType is a case-sensitive STRING.
        m.put(TYPE_MESSAGE, new ScriptType(
            TYPE_MESSAGE, "Message Handler", "handleMessage.py", false,
            new LinkedHashSet<>(Set.of("enabled", "threadType"))));
        m.put(TYPE_STARTUP, new ScriptType(
            TYPE_STARTUP, "Startup", "onStartup.py", true,
            new LinkedHashSet<>(Set.of("enabled"))));
        // Shutdown and Update: same singleton family as Startup. `enabled` is
        // written by the platform for all three — verified by round-tripping it
        // against a real gateway (v1.1.0), not inferred from Startup.
        m.put(TYPE_SHUTDOWN, new ScriptType(
            TYPE_SHUTDOWN, "Shutdown", "onShutdown.py", true,
            new LinkedHashSet<>(Set.of("enabled"))));
        m.put(TYPE_UPDATE, new ScriptType(
            TYPE_UPDATE, "Update", "onUpdate.py", true,
            new LinkedHashSet<>(Set.of("enabled"))));
        // Scheduled. cronExpression is a STRING holding a cron expression, and
        // `scope` on this type is "A", not the "G" the other event types use —
        // measured off a real resource (web-designer SCRIPTING.md §5.4).
        m.put(TYPE_SCHEDULED, new ScriptType(
            TYPE_SCHEDULED, "Scheduled", "handleScheduleEvent.py", false,
            new LinkedHashSet<>(Set.of("enabled", "cronExpression"))));
        // Tag Change stays body-only. The Designer's Tag Change workspace has a
        // tag-path list that NOTHING measured describes, so the attribute name
        // Tag Change — MEASURED at last (06/09/2026), off a real resource on the
        // module rig rather than by driving the Designer:
        //
        //   "attributes": {
        //     "paths": ["[default]A201"],
        //     "changeTypes": ["ValueChange", "QualityChange", "TimestampChange"],
        //     "enabled": true
        //   }
        //
        // From 1.1.0 to 1.15.x this type was body-only, because the tag-path
        // list's attribute name was unknown and writing a guessed key onto a
        // live gateway is exactly the failure this module refuses. `paths` and
        // `changeTypes` are both JSON ARRAYS of strings, which is why they need
        // the array-aware handling in ScriptAttributesRouteHandler rather than
        // the scalar path every other attribute here takes.
        m.put(TYPE_TAG_CHANGE, new ScriptType(
            TYPE_TAG_CHANGE, "Tag Change", "onTagChange.py", false,
            new LinkedHashSet<>(Set.of("enabled", "paths", "changeTypes"))));
        // Web Dev. Its allowlist is EMPTY and that is not a "not yet measured"
        // case like tag-change: this resource genuinely has no editable
        // resource.json attributes. Its settings are in config.json.
        m.put(TYPE_WEBDEV, new ScriptType(
            TYPE_WEBDEV, "Web Dev", "doGet.py", false, new LinkedHashSet<>()));
        TYPES = Collections.unmodifiableMap(m);
    }

    /** Every editable type, in the order the file tree should show them. */
    public static Map<String, ScriptType> all() {
        return TYPES;
    }

    /** Look up a type by its {@code typeId}, if this module edits it. */
    public static Optional<ScriptType> byTypeId(String typeId) {
        return Optional.ofNullable(TYPES.get(typeId));
    }

    /** True when {@code moduleId/typeId} is a script resource this IDE edits. */
    public static boolean isEditable(String moduleId, String typeId) {
        if (WEBDEV_MODULE.equals(moduleId)) {
            // Scoped deliberately: the webdev module could gain other resource
            // types, and this IDE only understands `resources`.
            return TYPE_WEBDEV.equals(typeId);
        }
        // The webdev type id is the generic word "resources", so it must NOT be
        // reachable under the ignition module id — that would let a caller
        // address `ignition/resources` and get a Web Dev handler.
        return IGNITION_MODULE.equals(moduleId) && !TYPE_WEBDEV.equals(typeId)
            && TYPES.containsKey(typeId);
    }

    /** True for a Web Dev endpoint resource. */
    public static boolean isWebDev(String moduleId, String typeId) {
        return WEBDEV_MODULE.equals(moduleId) && TYPE_WEBDEV.equals(typeId);
    }

    /** The data key holding one HTTP method's script, e.g. {@code doGet.py}. */
    public static String webDevKeyFor(String method) {
        return method + ".py";
    }

    /**
     * Valid {@code hintScope} values (ApplicationScope bitmask). Anything else is
     * rejected rather than written — an invalid scope is accepted silently by the
     * resource layer and then behaves unpredictably in the Designer.
     */
    public static final Set<Integer> HINT_SCOPE_VALUES = Set.of(0, 1, 2, 7);

    /** Valid {@code threadType} values, case-sensitive as the Designer writes them. */
    public static final Set<String> THREAD_TYPE_VALUES = Set.of("Shared", "Dedicated");

    /**
     * Upper bound on a cron expression's length. Generous — the point is to stop
     * an unbounded string reaching the resource, not to second-guess the
     * scheduler's grammar.
     */
    public static final int MAX_CRON_LENGTH = 256;

    /** Upper bound on a timer's delay, in milliseconds (24 hours). */
    public static final long MAX_TIMER_DELAY_MS = 86_400_000L;
}
