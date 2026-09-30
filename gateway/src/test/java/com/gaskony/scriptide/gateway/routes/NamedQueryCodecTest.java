package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.resourcecollection.Resource;
import com.inductiveautomation.ignition.common.resourcecollection.ResourceBuilder;
import com.inductiveautomation.ignition.common.resourcecollection.ResourcePath;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.user.ZoneRoleRequirement;
import com.inductiveautomation.ignition.common.util.TimeUnits;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The wire vocabulary, in both directions, against the REAL platform enums.
 *
 * <p>Nothing here is mocked. {@code ignition-common} is on the test classpath, so
 * every conversion runs through the same {@code NamedQuery}, {@code DataType} and
 * {@code TimeUnits} the gateway uses — which means this suite fails if a platform
 * upgrade renames a constant, instead of the module writing a resource nothing
 * reads. That failure mode is the whole reason for the vocabulary check: a wrong
 * value is not rejected anywhere downstream, it is simply ignored.</p>
 */
class NamedQueryCodecTest {

    // ==================== every value, both directions ====================

    static List<String> queryTypes() {
        return List.copyOf(NamedQueryCodec.queryTypeNames());
    }

    static List<String> parameterTypes() {
        return List.copyOf(NamedQueryCodec.parameterTypeNames());
    }

    static List<String> sqlTypes() {
        return List.copyOf(NamedQueryCodec.sqlTypeNames());
    }

    static List<String> cacheUnits() {
        return List.copyOf(NamedQueryCodec.cacheUnitNames());
    }

    @ParameterizedTest(name = "type {0}")
    @MethodSource("queryTypes")
    @DisplayName("every query type converts name -> enum -> name unchanged")
    void queryTypeRoundTrips(String name) {
        assertThat(NamedQueryCodec.queryType(name).name()).isEqualTo(name);
    }

    @ParameterizedTest(name = "parameter type {0}")
    @MethodSource("parameterTypes")
    @DisplayName("every parameter type converts name -> enum -> name unchanged")
    void parameterTypeRoundTrips(String name) {
        assertThat(NamedQueryCodec.parameterType(name).name()).isEqualTo(name);
    }

    @ParameterizedTest(name = "sqlType {0}")
    @MethodSource("sqlTypes")
    @DisplayName("every sqlType converts name -> DataType -> name unchanged")
    void sqlTypeRoundTrips(String name) {
        assertThat(NamedQueryCodec.sqlType(name).name()).isEqualTo(name);
    }

    @ParameterizedTest(name = "cacheUnit {0}")
    @MethodSource("cacheUnits")
    @DisplayName("every cache unit converts name -> TimeUnits -> name unchanged")
    void cacheUnitRoundTrips(String name) {
        assertThat(NamedQueryCodec.cacheUnit(name).name()).isEqualTo(name);
    }

    @Test
    @DisplayName("the vocabularies are exactly what the platform declares")
    void vocabulariesMatchThePlatform() {
        // Measured on 8.3.8 and asserted against the jar, so a platform change is
        // a failing test rather than a resource nothing reads.
        assertThat(NamedQueryCodec.queryTypeNames())
            .containsExactly("Query", "ScalarQuery", "UpdateQuery");
        assertThat(NamedQueryCodec.parameterTypeNames())
            .containsExactly("Database", "QueryString", "Parameter");
        assertThat(NamedQueryCodec.sqlTypeNames())
            .containsExactlyInAnyOrder("Int1", "Int2", "Int4", "Int8", "Float4", "Float8",
                "Boolean", "String", "DateTime", "ByteArray");
        assertThat(NamedQueryCodec.cacheUnitNames())
            .containsExactly("MS", "SEC", "MIN", "HOUR", "DAY", "WEEK", "MONTH", "YEAR");
    }

    @Test
    @DisplayName("'Value' is the Designer's LABEL for ParameterType.Parameter, and is accepted")
    void valueIsAnAliasForParameter() {
        // The design note said the enum was named Value. The gateway says the name
        // is Parameter and Value is its toString(). Both are accepted on input;
        // only the name is ever emitted.
        assertThat(NamedQuery.ParameterType.Parameter.toString()).isEqualTo("Value");
        assertThat(NamedQueryCodec.parameterType("Value"))
            .isEqualTo(NamedQuery.ParameterType.Parameter);
        assertThat(NamedQueryCodec.parameterTypeNames()).doesNotContain("Value");
    }

    // ==================== the 400s ====================

    @Test
    @DisplayName("'Date' is refused, and the message says what IS allowed")
    void dateIsNotASqlType() {
        // Several projects on the test rig declare "Date". DataType has no such
        // constant, so the platform reads nothing at all from those parameters.
        assertThat(DataType.values()).noneMatch(t -> "Date".equals(t.name()));
        assertThatThrownBy(() -> NamedQueryCodec.sqlType("Date"))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("Date")
            .hasMessageContaining("DateTime");
    }

    @Test
    @DisplayName("the key 'dataType' is refused, never silently dropped")
    void dataTypeKeyIsRefused() {
        NamedQuery q = new NamedQuery();
        JsonObject settings = parse(
            "{\"parameters\":[{\"identifier\":\"x\",\"dataType\":\"String\"}]}");

        assertThatThrownBy(() -> NamedQueryCodec.apply(q, settings))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("dataType")
            .hasMessageContaining("sqlType");
    }

    @Test
    @DisplayName("an unknown settings key is a refusal, not a quiet drop")
    void unknownSettingsKeyIsRefused() {
        NamedQuery q = new NamedQuery();
        JsonObject settings = parse("{\"enabled\":true,\"namedTheme\":\"dark\"}");

        assertThatThrownBy(() -> NamedQueryCodec.apply(q, settings))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("namedTheme");
    }

    @Test
    @DisplayName("an unknown permission key is refused too")
    void unknownPermissionKeyIsRefused() {
        NamedQuery q = new NamedQuery();
        JsonObject settings = parse("{\"permissions\":[{\"zone\":\"Z\",\"user\":\"nigel\"}]}");

        assertThatThrownBy(() -> NamedQueryCodec.apply(q, settings))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("user");
    }

    @Test
    @DisplayName("a lower-case enum value is refused — the vocabulary is case-sensitive")
    void vocabularyIsCaseSensitive() {
        assertThatThrownBy(() -> NamedQueryCodec.queryType("query"))
            .isInstanceOf(NamedQueryCodec.BadValueException.class);
        assertThatThrownBy(() -> NamedQueryCodec.cacheUnit("min"))
            .isInstanceOf(NamedQueryCodec.BadValueException.class);
    }

    @Test
    @DisplayName("a duplicate parameter identifier is refused")
    void duplicateParameterIsRefused() {
        NamedQuery q = new NamedQuery();
        JsonObject settings = parse("{\"parameters\":["
            + "{\"identifier\":\"x\",\"sqlType\":\"String\"},"
            + "{\"identifier\":\"x\",\"sqlType\":\"Int4\"}]}");

        assertThatThrownBy(() -> NamedQueryCodec.apply(q, settings))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("duplicate");
    }

    @Test
    @DisplayName("a negative cache amount or max return size is refused")
    void negativeNumbersAreRefused() {
        assertThatThrownBy(() ->
            NamedQueryCodec.apply(new NamedQuery(), parse("{\"cacheAmount\":-1}")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class);
        assertThatThrownBy(() ->
            NamedQueryCodec.apply(new NamedQuery(), parse("{\"maxReturnSize\":-5}")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class);
    }

    @Test
    @DisplayName("a Database parameter must use the RESERVED name the platform looks for")
    void databaseParameterMustUseTheReservedName() {
        // NamedQuery.isValidParamName("database") is FALSE — it is reserved — and
        // yet that is exactly what the Designer names the Database parameter. So
        // the rule is inverted for that one kind, and getting it the wrong way
        // round makes every Designer-written query with a connection parameter
        // unsavable.
        assertThat(NamedQuery.isValidParamName(NamedQuery.DATABASE_PARAM_IDENTIFIER)).isFalse();

        NamedQuery ok = new NamedQuery();
        NamedQueryCodec.apply(ok, parse("{\"parameters\":[{\"type\":\"Database\","
            + "\"identifier\":\"database\",\"sqlType\":\"String\"}]}"));
        assertThat(ok.getParameters().get(0).getIdentifier()).isEqualTo("database");

        assertThatThrownBy(() -> NamedQueryCodec.apply(new NamedQuery(),
            parse("{\"parameters\":[{\"type\":\"Database\",\"identifier\":\"conn\"}]}")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("database");

        assertThatThrownBy(() -> NamedQueryCodec.apply(new NamedQuery(),
            parse("{\"parameters\":[{\"identifier\":\"database\"}]}")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("not a valid parameter name");
    }

    // ==================== partial application ====================

    @Test
    @DisplayName("a settings write is PARTIAL — absent keys keep their value")
    void applyIsPartial() {
        // This is what preserves the syntax provider through a save. It is not a
        // convenience: a full-replace write would blank every field this release
        // has no UI for, on every save.
        NamedQuery q = new NamedQuery();
        q.setType(NamedQuery.Type.UpdateQuery);
        q.setSyntaxProvider("class com.adbs.syntax.SQLiteSyntaxProvider");
        q.setDatabase("Postgres_Test");

        NamedQueryCodec.apply(q, parse("{\"enabled\":false}"));

        assertThat(q.isEnabled()).isFalse();
        assertThat(q.getType()).isEqualTo(NamedQuery.Type.UpdateQuery);
        assertThat(q.getSyntaxProvider()).isEqualTo("class com.adbs.syntax.SQLiteSyntaxProvider");
        assertThat(q.getDatabase()).isEqualTo("Postgres_Test");
    }

    @Test
    @DisplayName("a parameter may be sent as an identifier alone, and defaults as the Designer does")
    void parameterDefaults() {
        NamedQuery q = new NamedQuery();
        NamedQueryCodec.apply(q, parse("{\"parameters\":[{\"identifier\":\"x\"}]}"));

        NamedQuery.Parameter p = q.getParameters().get(0);
        assertThat(p.getType()).isEqualTo(NamedQuery.ParameterType.Parameter);
        assertThat(p.getSqlType()).isEqualTo(DataType.String);
    }

    // ==================== JSON <-> platform, through the real serialiser ====================

    @Test
    @DisplayName("a full settings object survives JSON -> NamedQuery -> resource -> NamedQuery -> JSON")
    void fullRoundTripThroughTheRealSerialiser() {
        JsonObject sent = parse("{"
            + "\"type\":\"ScalarQuery\",\"enabled\":false,\"database\":\"Postgres_Test\","
            + "\"cacheEnabled\":true,\"cacheAmount\":30,\"cacheUnit\":\"MIN\","
            + "\"fallbackEnabled\":true,\"fallbackValue\":\"-1\","
            + "\"useMaxReturnSize\":true,\"maxReturnSize\":25,"
            + "\"autoBatchEnabled\":true,"
            + "\"syntaxProvider\":\"class com.adbs.syntax.SQLiteSyntaxProvider\","
            + "\"permissions\":[{\"zone\":\"Default\",\"role\":\"Administrator\"}],"
            + "\"parameters\":["
            + "{\"type\":\"Parameter\",\"identifier\":\"pText\",\"sqlType\":\"String\"},"
            + "{\"type\":\"QueryString\",\"identifier\":\"pWhen\",\"sqlType\":\"String\"},"
            + "{\"type\":\"Database\",\"identifier\":\"database\",\"sqlType\":\"String\"},"
            + "{\"type\":\"Parameter\",\"identifier\":\"pStamp\",\"sqlType\":\"DateTime\"}]}");

        NamedQuery q = new NamedQuery();
        NamedQueryCodec.apply(q, sent);
        q.setQuery("SELECT :pText");

        JsonObject back = NamedQueryCodec.toJson(readBack(q), null);

        for (String key : sent.keySet()) {
            assertThat(back.get(key))
                .as("settings key '%s' did not survive the round trip", key)
                .isEqualTo(sent.get(key));
        }
    }

    @Test
    @DisplayName("sqlType is a NAME on the wire and an INT on disk")
    void sqlTypeIsAnIntOnDisk() {
        // The one conversion nobody would guess, and the reason this class exists:
        // Parameter$GsonAdapter writes DataType.getIntValue(). String is 7.
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setParameters(new ArrayList<>(List.of(
            new NamedQuery.Parameter(NamedQuery.ParameterType.Parameter, "v", DataType.String))));

        JsonArray onDisk = JsonParser
            .parseString(attribute(build(q), "parameters"))
            .getAsJsonArray();

        assertThat(onDisk.get(0).getAsJsonObject().get("sqlType").getAsInt()).isEqualTo(7);
        assertThat(onDisk.get(0).getAsJsonObject().get("type").getAsString())
            .isEqualTo("Parameter");
        assertThat(NamedQueryCodec.toJson(q, null)
            .getAsJsonArray("parameters").get(0).getAsJsonObject()
            .get("sqlType").getAsString()).isEqualTo("String");
    }

    @Test
    @DisplayName("a null zone/role reads back as empty strings, matching the Designer's shape")
    void nullPermissionsNormalise() {
        // A fresh NamedQuery carries one ZoneRoleRequirement with both fields null,
        // which serialises as {}. The Designer writes {"zone":"","role":""}. The
        // wire uses the Designer's shape so the two are indistinguishable.
        NamedQuery q = new NamedQuery();
        q.setPermissions(new ArrayList<>(List.of(new ZoneRoleRequirement())));

        JsonObject permission = NamedQueryCodec.toJson(q, null)
            .getAsJsonArray("permissions").get(0).getAsJsonObject();

        assertThat(permission.get("zone").getAsString()).isEmpty();
        assertThat(permission.get("role").getAsString()).isEmpty();
    }

    @Test
    @DisplayName("the description comes from the resource DOCUMENTATION, not from an attribute")
    void descriptionComesFromDocumentation() {
        // toResource writes description to the resource's documentation, and
        // fromResource reads it from the attributes — so it does not round-trip
        // through the platform's own pair. Measured 02/09/2026; see §1.6.
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setDescription("measured shape");
        Resource resource = build(q);

        assertThat(resource.getDocumentation()).isEqualTo("measured shape");
        assertThat(resource.getAttribute("description")).isEmpty();
        assertThat(NamedQueryCodec.toJson(readBack(q), resource.getDocumentation())
            .get("description").getAsString()).isEqualTo("measured shape");
    }

    @Test
    @DisplayName("the platform's defaults are pinned, so a change to one fails here")
    void createDefaultsArePinned() {
        JsonObject defaults = NamedQueryCodec.toJson(NamedQueryRouteHandler.newQuery(), null);

        assertThat(defaults.get("type").getAsString()).isEqualTo("Query");
        assertThat(defaults.get("enabled").getAsBoolean()).isTrue();
        assertThat(defaults.get("database").getAsString()).isEmpty();
        assertThat(defaults.get("cacheEnabled").getAsBoolean()).isFalse();
        assertThat(defaults.get("cacheAmount").getAsInt()).isEqualTo(1);
        assertThat(defaults.get("cacheUnit").getAsString()).isEqualTo(TimeUnits.SEC.name());
        assertThat(defaults.get("fallbackEnabled").getAsBoolean()).isFalse();
        assertThat(defaults.get("useMaxReturnSize").getAsBoolean()).isFalse();
        assertThat(defaults.get("maxReturnSize").getAsLong()).isEqualTo(100L);
        assertThat(defaults.get("autoBatchEnabled").getAsBoolean()).isFalse();
        assertThat(defaults.getAsJsonArray("parameters")).isEmpty();
        assertThat(defaults.getAsJsonArray("permissions")).hasSize(1);
    }

    // ==================== helpers ====================

    static JsonObject parse(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    /** Build the resource the platform's own serialiser produces. */
    static Resource build(NamedQuery q) {
        ResourceBuilder builder = Resource.newBuilder()
            .setResourceCollectionName("TestProject")
            .setResourcePath(new ResourcePath(NamedQuery.RESOURCE_TYPE, "Folder/Name"));
        NamedQuery.toResource(q).accept(builder);
        return builder.build();
    }

    /** Serialise and re-read, through the platform, with no deserializer. */
    static NamedQuery readBack(NamedQuery q) {
        try {
            return NamedQueryCodec.read(build(q));
        } catch (Exception e) {
            throw new AssertionError("fromResource failed on a resource toResource wrote", e);
        }
    }

    private static String attribute(Resource resource, String key) {
        return resource.getAttribute(key)
            .orElseThrow(() -> new AssertionError("no '" + key + "' attribute"))
            .toString();
    }
}
