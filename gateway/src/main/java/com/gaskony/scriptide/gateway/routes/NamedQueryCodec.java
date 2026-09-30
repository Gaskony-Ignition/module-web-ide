package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.user.ZoneRoleRequirement;
import com.inductiveautomation.ignition.common.util.TimeUnits;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * The named-query wire vocabulary, and the only place a value crosses between
 * JSON and the platform's own types.
 *
 * <h2>Names on the wire, the platform's representation on disk</h2>
 *
 * <p>Every enum travels as its Java NAME and is converted through the enum here.
 * That matters most for {@code sqlType}, which the platform's own
 * {@code Parameter$GsonAdapter} writes as {@code DataType.getIntValue()} — an
 * INTEGER ({@code String}=7, {@code Int4}=2, …). A client that sent the int would
 * be encoding a platform detail; a server that stored the name would write a
 * resource the platform cannot read. Measured 02/09/2026 by building a query
 * through {@code toResource} and reading the file — see {@code
 * docs/NAMED-QUERIES.md} §1.2.</p>
 *
 * <h2>{@code Parameter}, not {@code Value}</h2>
 *
 * <p>{@code ParameterType.values()} is {@code Database}, {@code QueryString},
 * {@code Parameter}. {@code Value} is what {@code Parameter.toString()} returns —
 * the Designer's label, the same way {@code ScalarQuery.toString()} is "Scalar
 * Query". The design note asserted the name was {@code Value}; the gateway says
 * otherwise, so the canonical wire value is {@code Parameter} and {@code Value} is
 * accepted as an alias on the way in and never emitted.</p>
 *
 * <h2>Nothing here hand-assembles a resource</h2>
 *
 * <p>This class produces and consumes {@link NamedQuery} objects only.
 * {@code NamedQuery.toResource} does the writing and {@code NamedQuery.fromResource}
 * does the reading, for the same reason {@code ModuleLibrary.serializeScript} does
 * for scripts: a hand-built resource can be byte-perfect and still be ignored.</p>
 */
// Public for `read` alone — the index searches named-query SQL, and reading a
// NamedQuery off a resource is this class's measured knowledge, not something to
// re-derive elsewhere.
public final class NamedQueryCodec {

    /** How many rows a test-run returns before it reports a truncation. */
    static final int TEST_ROW_CAP = 500;

    /**
     * The alias the design note and the Designer both use for
     * {@code ParameterType.Parameter}. Accepted on input, never emitted.
     */
    static final String PARAMETER_TYPE_ALIAS = "Value";

    /** Every settings key a write accepts, in the order the Designer shows them. */
    static final List<String> EDITABLE_KEYS = List.of(
        "type", "enabled", "database", "description",
        "cacheEnabled", "cacheAmount", "cacheUnit",
        "fallbackEnabled", "fallbackValue",
        "useMaxReturnSize", "maxReturnSize",
        "autoBatchEnabled", "syntaxProvider",
        "permissions", "parameters");

    private NamedQueryCodec() { /* utility class */ }

    /** Raised for any value outside a vocabulary; the message names the value and the set. */
    static final class BadValueException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        BadValueException(String message) {
            super(message);
        }
    }

    // ==================== vocabularies ====================

    /** The three query types, as names. */
    static Set<String> queryTypeNames() {
        Set<String> out = new LinkedHashSet<>();
        for (NamedQuery.Type t : NamedQuery.Type.values()) {
            out.add(t.name());
        }
        return out;
    }

    /** The three parameter kinds, as names — {@code Parameter}, not {@code Value}. */
    static Set<String> parameterTypeNames() {
        Set<String> out = new LinkedHashSet<>();
        for (NamedQuery.ParameterType t : NamedQuery.ParameterType.values()) {
            out.add(t.name());
        }
        return out;
    }

    /**
     * The ten SQL types a parameter may declare, as names.
     *
     * <p>Read from {@code NamedQuery.PARAMETER_TYPES} rather than listed here:
     * {@link DataType} itself has 22 constants and only these ten are legal on a
     * parameter. {@code Date} is not one of them, and neither is {@code Text} or
     * any of the array types.</p>
     */
    static Set<String> sqlTypeNames() {
        Set<String> out = new LinkedHashSet<>();
        for (DataType t : NamedQuery.PARAMETER_TYPES) {
            out.add(t.name());
        }
        return out;
    }

    /** The eight cache units. Note {@code MS} — the design note listed only seven. */
    static Set<String> cacheUnitNames() {
        Set<String> out = new LinkedHashSet<>();
        for (TimeUnits t : TimeUnits.values()) {
            out.add(t.name());
        }
        return out;
    }

    // ==================== name -> platform ====================

    static NamedQuery.Type queryType(String name) {
        for (NamedQuery.Type t : NamedQuery.Type.values()) {
            if (t.name().equals(name)) {
                return t;
            }
        }
        throw new BadValueException("type must be one of " + queryTypeNames()
            + " (case-sensitive), got '" + name + "'");
    }

    static NamedQuery.ParameterType parameterType(String name) {
        for (NamedQuery.ParameterType t : NamedQuery.ParameterType.values()) {
            if (t.name().equals(name)) {
                return t;
            }
        }
        // The label the Designer shows for ParameterType.Parameter. Accepted so a
        // client built against the design note's vocabulary still works; the
        // server's own output always uses the enum name.
        if (PARAMETER_TYPE_ALIAS.equals(name)) {
            return NamedQuery.ParameterType.Parameter;
        }
        throw new BadValueException("parameter type must be one of " + parameterTypeNames()
            + " (case-sensitive; '" + PARAMETER_TYPE_ALIAS + "' is accepted as an alias for "
            + NamedQuery.ParameterType.Parameter.name() + "), got '" + name + "'");
    }

    static DataType sqlType(String name) {
        for (DataType t : NamedQuery.PARAMETER_TYPES) {
            if (t.name().equals(name)) {
                return t;
            }
        }
        throw new BadValueException("sqlType must be one of " + sqlTypeNames()
            + " (case-sensitive), got '" + name + "'");
    }

    static TimeUnits cacheUnit(String name) {
        for (TimeUnits t : TimeUnits.values()) {
            if (t.name().equals(name)) {
                return t;
            }
        }
        throw new BadValueException("cacheUnit must be one of " + cacheUnitNames()
            + " (case-sensitive), got '" + name + "'");
    }

    // ==================== NamedQuery -> JSON ====================

    /**
     * The full settings object for one query.
     *
     * @param documentation the resource's documentation field, which is where
     *     {@code toResource} puts the description — see the class Javadoc of
     *     {@link NamedQueryRouteHandler} and {@code docs/NAMED-QUERIES.md} §1.6
     */
    static JsonObject toJson(NamedQuery q, String documentation) {
        JsonObject out = new JsonObject();
        out.addProperty("type", q.getType() == null ? null : q.getType().name());
        out.addProperty("enabled", q.isEnabled());
        out.addProperty("database", q.getDatabase() == null ? "" : q.getDatabase());
        // Prefer the documentation: that is where the platform's own writer put
        // it. getDescription() only ever answers for a resource that carries a
        // hand-added `description` attribute.
        String description = (documentation != null && !documentation.isEmpty())
            ? documentation
            : (q.getDescription() == null ? "" : q.getDescription());
        out.addProperty("description", description);
        out.addProperty("cacheEnabled", q.isCachingEnabled());
        out.addProperty("cacheAmount", q.getCacheAmount());
        out.addProperty("cacheUnit", q.getCacheUnit() == null ? null : q.getCacheUnit().name());
        out.addProperty("fallbackEnabled", q.isFallbackEnabled());
        out.addProperty("fallbackValue", q.getFallbackValue() == null ? "" : q.getFallbackValue());
        out.addProperty("useMaxReturnSize", q.isUseMaxReturnSize());
        out.addProperty("maxReturnSize", q.getMaxReturnSize());
        out.addProperty("autoBatchEnabled", q.isAutoBatchEnabled());
        out.addProperty("syntaxProvider",
            q.getSyntaxProvider() == null ? "" : q.getSyntaxProvider());

        JsonArray permissions = new JsonArray();
        if (q.getPermissions() != null) {
            for (ZoneRoleRequirement r : q.getPermissions()) {
                JsonObject p = new JsonObject();
                // A fresh NamedQuery holds one requirement whose zone and role are
                // both null; the Designer writes them as empty strings. Normalise
                // to the Designer's shape so the two round-trip identically.
                p.addProperty("zone", r.getZone() == null ? "" : r.getZone());
                p.addProperty("role", r.getRole() == null ? "" : r.getRole());
                permissions.add(p);
            }
        }
        out.add("permissions", permissions);

        JsonArray parameters = new JsonArray();
        if (q.getParameters() != null) {
            for (NamedQuery.Parameter p : q.getParameters()) {
                JsonObject j = new JsonObject();
                j.addProperty("type", p.getType() == null ? null : p.getType().name());
                j.addProperty("identifier", p.getIdentifier());
                j.addProperty("sqlType", p.getSqlType() == null ? null : p.getSqlType().name());
                parameters.add(j);
            }
        }
        out.add("parameters", parameters);
        return out;
    }

    // ==================== JSON -> NamedQuery ====================

    /**
     * Apply a settings object onto an existing query, in place.
     *
     * <p>A PARTIAL update by design: only the keys present are applied. Two
     * reasons, both practical. It lets the response object be echoed back
     * unchanged without a client having to strip anything, and it preserves the
     * fields this release does not edit — the syntax provider and the named theme
     * survive because nothing here touches them, rather than because someone
     * remembered to copy them across.</p>
     *
     * @throws BadValueException on an unknown key or a value outside a vocabulary
     */
    static void apply(NamedQuery q, JsonObject settings) {
        for (Map.Entry<String, JsonElement> e : settings.entrySet()) {
            String key = e.getKey();
            JsonElement value = e.getValue();
            if (!EDITABLE_KEYS.contains(key)) {
                // Never dropped. A key the platform does not read is exactly how a
                // resource comes to look right on screen and behave wrongly.
                throw new BadValueException("Unknown settings key '" + key
                    + "' (allowed: " + EDITABLE_KEYS + ")");
            }
            switch (key) {
                case "type" -> q.setType(queryType(asString(key, value)));
                case "enabled" -> q.setEnabled(asBoolean(key, value));
                case "database" -> q.setDatabase(asString(key, value));
                case "description" -> q.setDescription(asString(key, value));
                case "cacheEnabled" -> q.setCachingEnabled(asBoolean(key, value));
                case "cacheAmount" -> q.setCacheAmount(asNonNegativeInt(key, value));
                case "cacheUnit" -> q.setCacheUnit(cacheUnit(asString(key, value)));
                case "fallbackEnabled" -> q.setFallbackEnabled(asBoolean(key, value));
                case "fallbackValue" -> q.setFallbackValue(asString(key, value));
                case "useMaxReturnSize" -> q.setUseMaxReturnSize(asBoolean(key, value));
                case "maxReturnSize" -> q.setMaxReturnSize(asNonNegativeLong(key, value));
                case "autoBatchEnabled" -> q.setAutoBatchEnabled(asBoolean(key, value));
                case "syntaxProvider" -> q.setSyntaxProvider(asString(key, value));
                case "permissions" -> q.setPermissions(permissions(value));
                case "parameters" -> q.setParameters(parameters(value));
                default -> throw new BadValueException("No handler for settings key '" + key
                    + "' — EDITABLE_KEYS and this switch have drifted apart");
            }
        }
    }

    private static List<ZoneRoleRequirement> permissions(JsonElement value) {
        if (!value.isJsonArray()) {
            throw new BadValueException("permissions must be an array of {zone, role}");
        }
        List<ZoneRoleRequirement> out = new ArrayList<>();
        for (JsonElement e : value.getAsJsonArray()) {
            if (!e.isJsonObject()) {
                throw new BadValueException("each permission must be an object {zone, role}");
            }
            JsonObject o = e.getAsJsonObject();
            for (String k : o.keySet()) {
                if (!"zone".equals(k) && !"role".equals(k)) {
                    throw new BadValueException("Unknown permission key '" + k
                        + "' (allowed: [zone, role])");
                }
            }
            out.add(new ZoneRoleRequirement(
                o.has("zone") ? asString("zone", o.get("zone")) : "",
                o.has("role") ? asString("role", o.get("role")) : ""));
        }
        return out;
    }

    private static List<NamedQuery.Parameter> parameters(JsonElement value) {
        if (!value.isJsonArray()) {
            throw new BadValueException(
                "parameters must be an array of {type, identifier, sqlType}");
        }
        List<NamedQuery.Parameter> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonElement e : value.getAsJsonArray()) {
            if (!e.isJsonObject()) {
                throw new BadValueException(
                    "each parameter must be an object {type, identifier, sqlType}");
            }
            JsonObject o = e.getAsJsonObject();
            for (String k : o.keySet()) {
                if (!"type".equals(k) && !"identifier".equals(k) && !"sqlType".equals(k)) {
                    // `dataType` lands here, and the message says why: several
                    // projects on the test rig carry it, the platform has never
                    // read it, and accepting it would write another dead resource.
                    throw new BadValueException("Unknown parameter key '" + k
                        + "' (allowed: [type, identifier, sqlType]). The platform's own"
                        + " serialiser writes 'sqlType'; a parameter written with"
                        + " 'dataType' is silently ignored by Ignition.");
                }
            }
            if (!o.has("identifier")) {
                throw new BadValueException("each parameter needs an 'identifier'");
            }
            String identifier = asString("identifier", o.get("identifier"));
            // Both enums default the way the Designer's "add parameter" button
            // does, so a client may send an identifier alone.
            NamedQuery.ParameterType type = o.has("type")
                ? parameterType(asString("type", o.get("type")))
                : NamedQuery.ParameterType.Parameter;
            if (type == NamedQuery.ParameterType.Database) {
                // `database` is RESERVED — NamedQuery.isValidParamName rejects it
                // for a normal parameter — and it is exactly what the Designer
                // names the Database parameter. So the reserved name is required
                // here rather than refused, and any other name would leave the
                // connection selector unfindable by the runtime.
                if (!NamedQuery.DATABASE_PARAM_IDENTIFIER.equals(identifier)) {
                    throw new BadValueException("a Database parameter must be named '"
                        + NamedQuery.DATABASE_PARAM_IDENTIFIER + "', not '" + identifier + "'");
                }
            } else if (!NamedQuery.isValidParamName(identifier)) {
                throw new BadValueException("'" + identifier
                    + "' is not a valid parameter name (letters, digits and underscores, "
                    + "not starting with a digit, and not a name the platform reserves)");
            }
            if (!seen.add(identifier)) {
                throw new BadValueException(
                    "duplicate parameter identifier '" + identifier + "'");
            }
            DataType sqlType = o.has("sqlType")
                ? sqlType(asString("sqlType", o.get("sqlType")))
                : DataType.String;
            out.add(new NamedQuery.Parameter(type, identifier, sqlType));
        }
        return out;
    }

    // ==================== test-run parameter coercion ====================

    /**
     * One test-run parameter map, coerced by each parameter's DECLARED type.
     *
     * <p>Coerced in Java, before anything reaches Jython, so the value that binds
     * is the type the query declared rather than whatever JSON happened to carry.
     * A JSON string {@code "42"} against an {@code Int4} parameter binds as an
     * integer; a JSON number against a {@code DateTime} binds as epoch millis; and
     * anything that does not parse is a 400 rather than a database error the user
     * has to decode.</p>
     *
     * <p>The map is later seeded into the execution's locals — it is never
     * formatted into the generated Python or into the SQL.</p>
     *
     * @throws BadValueException naming the identifier, its declared type and the value
     */
    static Map<String, Object> coerceParameters(List<NamedQuery.Parameter> declared,
                                                JsonObject supplied) {
        Map<String, DataType> types = new LinkedHashMap<>();
        for (NamedQuery.Parameter p : declared) {
            types.put(p.getIdentifier(), p.getSqlType() == null ? DataType.String : p.getSqlType());
        }
        Map<String, Object> out = new LinkedHashMap<>();
        if (supplied == null) {
            return out;
        }
        for (Map.Entry<String, JsonElement> e : supplied.entrySet()) {
            String id = e.getKey();
            DataType type = types.get(id);
            if (type == null) {
                throw new BadValueException("'" + id + "' is not a parameter of this query"
                    + " (declared: " + types.keySet() + ")");
            }
            out.put(id, coerce(id, type, e.getValue()));
        }
        return out;
    }

    /**
     * One JSON value as the Java type its declared {@link DataType} binds.
     *
     * <p>{@code null} passes through, so a nullable column can be tested with a
     * null. Everything else is checked, never coerced silently: a string that is
     * not a number against an {@code Int4} is an error, not a zero.</p>
     */
    static Object coerce(String identifier, DataType type, JsonElement value) {
        if (value == null || value.isJsonNull()) {
            return null;
        }
        if (!value.isJsonPrimitive()) {
            throw badValue(identifier, type, value.toString(),
                "expected a JSON string, number or boolean");
        }
        JsonPrimitive primitive = value.getAsJsonPrimitive();
        String text = primitive.getAsString();
        try {
            return switch (type) {
                case Int1, Int2, Int4 -> Integer.valueOf(numericText(primitive, text));
                case Int8 -> Long.valueOf(numericText(primitive, text));
                case Float4 -> Float.valueOf(text);
                case Float8 -> Double.valueOf(text);
                case Boolean -> booleanOf(identifier, type, primitive, text);
                case DateTime -> dateOf(identifier, type, primitive, text);
                // ByteArray has no sensible JSON form beyond text; binding the
                // string is what the Designer's own test tab does with typed input.
                default -> text;
            };
        } catch (NumberFormatException e) {
            throw badValue(identifier, type, text, "not a number");
        }
    }

    /**
     * The text to parse an integral type from.
     *
     * <p>JSON has one number type, so {@code 3.0} and {@code 3} arrive
     * indistinguishably from some clients. A whole-valued decimal is accepted and
     * truncated; a fractional one is refused rather than silently rounded.</p>
     */
    private static String numericText(JsonPrimitive primitive, String text) {
        if (!primitive.isNumber() || text.indexOf('.') < 0) {
            return text;
        }
        double d = Double.parseDouble(text);
        if (d != Math.rint(d)) {
            throw new NumberFormatException(text);
        }
        return Long.toString((long) d);
    }

    private static Boolean booleanOf(String identifier, DataType type,
                                     JsonPrimitive primitive, String text) {
        if (primitive.isBoolean()) {
            return primitive.getAsBoolean();
        }
        String lower = text.toLowerCase(Locale.ROOT);
        if ("true".equals(lower)) {
            return Boolean.TRUE;
        }
        if ("false".equals(lower)) {
            return Boolean.FALSE;
        }
        throw badValue(identifier, type, text, "expected true or false");
    }

    /**
     * A {@code DateTime} binding from ISO-8601 or from epoch millis.
     *
     * <p>Three accepted shapes, in this order: a JSON number is epoch
     * milliseconds; a string with an offset or a {@code Z} is an
     * {@link OffsetDateTime}; a string without one is a {@link LocalDateTime} in
     * the GATEWAY's zone, which is the zone the database session is in and
     * therefore the one a user typing a local timestamp means.</p>
     */
    private static Date dateOf(String identifier, DataType type,
                               JsonPrimitive primitive, String text) {
        if (primitive.isNumber()) {
            return new Date(Long.parseLong(text));
        }
        try {
            return Date.from(OffsetDateTime.parse(text).toInstant());
        } catch (DateTimeParseException ignored) {
            // Fall through: no offset in the text.
        }
        try {
            return Date.from(LocalDateTime.parse(text).atZone(ZoneId.systemDefault()).toInstant());
        } catch (DateTimeParseException ignored) {
            // Fall through: not a date-time either.
        }
        try {
            return Date.from(Instant.parse(text));
        } catch (DateTimeParseException e) {
            throw badValue(identifier, type, text,
                "expected ISO-8601 (2026-09-02T14:30:00Z, 2026-09-02T14:30:00+09:30 or "
                    + "2026-09-02T14:30:00) or epoch milliseconds");
        }
    }

    private static BadValueException badValue(String identifier, DataType type,
                                              String text, String why) {
        return new BadValueException("Parameter '" + identifier + "' is declared "
            + type.name() + " and '" + text + "' cannot be used as one: " + why);
    }

    // ==================== primitive readers ====================

    static String asString(String key, JsonElement v) {
        if (v == null || v.isJsonNull()) {
            return "";
        }
        if (!v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()) {
            throw new BadValueException(key + " must be a string, got " + v);
        }
        return v.getAsString();
    }

    static boolean asBoolean(String key, JsonElement v) {
        if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isBoolean()) {
            throw new BadValueException(key + " must be a boolean, got " + v);
        }
        return v.getAsBoolean();
    }

    private static int asNonNegativeInt(String key, JsonElement v) {
        long value = asNonNegativeLong(key, v);
        if (value > Integer.MAX_VALUE) {
            throw new BadValueException(key + " must fit in a 32-bit integer, got " + value);
        }
        return (int) value;
    }

    private static long asNonNegativeLong(String key, JsonElement v) {
        if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isNumber()) {
            throw new BadValueException(key + " must be a number, got " + v);
        }
        long value = v.getAsLong();
        if (value < 0) {
            throw new BadValueException(key + " must not be negative, got " + value);
        }
        return value;
    }

    // ==================== resource helpers ====================

    /**
     * Parse a resource, or {@link Optional#empty()} when the platform cannot.
     *
     * <p>Empty is not an error to be logged and forgotten: a {@code version: 1}
     * resource parses to a BLANK {@code NamedQuery} rather than throwing, and the
     * gateway's own {@code system.db.runNamedQuery} fails on it with an NPE. The
     * caller reports that state to the client as {@code legacy} instead of showing
     * an empty settings form that looks like a normal, empty query. Measured
     * 02/09/2026 against all 37 named queries in the rig's {@code Whiteboard}
     * project — see {@code docs/NAMED-QUERIES.md} §1.5.</p>
     */
    static boolean isLegacy(Resource resource) {
        return resource.getVersion() < NamedQuery.CURRENT_RESOURCE_VERSION;
    }

    /**
     * The query in a resource, or a blank one stamped with the platform's own
     * defaults when it cannot be read.
     *
     * <p>{@code fromResource} needs no {@code XMLDeserializer} for a version-2
     * resource — measured, and confirmed against a real one from
     * {@code GatewayContext.createDeserializer()}, which changed nothing. So null
     * is passed deliberately rather than for want of a context.</p>
     */
    public static NamedQuery read(Resource resource) throws Exception {
        // fromResource never returns null — a resource it cannot read comes back
        // as a BLANK NamedQuery, which is the case handled below.
        NamedQuery q = NamedQuery.fromResource(resource, null);
        if (q.getType() == null) {
            // A legacy resource comes back blank, and toResource NPEs on a null
            // type. Defaulting here means a settings save on one is an upgrade
            // rather than a 500.
            q.setType(NamedQuery.Type.Query);
        }
        return q;
    }
}
