package com.gaskony.scriptide.gateway.routes;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Date;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The test-run coercion table: one JSON value, one declared {@code sqlType}, one
 * Java binding.
 *
 * <p>Every row is asserted in both directions — what a good value becomes, and
 * that a bad one is refused — because a silent coercion is the failure that
 * survives testing. JSON has one number type and no date type, so an uncoerced
 * map binds whatever the client happened to send: {@code "42"} against an
 * {@code Int4} would reach the driver as a string and the database would either
 * cast it, or not, depending on the dialect.</p>
 */
class NamedQueryCoercionTest {

    private static JsonElement json(String raw) {
        return JsonParser.parseString(raw);
    }

    // ==================== the table, value by value ====================

    @ParameterizedTest(name = "{0} from {1}")
    @CsvSource({
        "Int1,      7,        7",
        "Int2,      300,      300",
        "Int4,      42,       42",
        "Int4,      '\"42\"', 42",
        "Int4,      42.0,     42",
    })
    @DisplayName("integral types accept a number, a numeric string and a whole-valued decimal")
    void integralTypes(String type, String raw, int expected) {
        Object bound = NamedQueryCodec.coerce("p", NamedQueryCodec.sqlType(type), json(raw));
        assertThat(bound).isInstanceOf(Integer.class).isEqualTo(expected);
    }

    @Test
    @DisplayName("Int8 binds a Long, not an Integer")
    void int8IsALong() {
        // 3_000_000_000 does not fit in an int. Binding it as one would either
        // throw somewhere unhelpful or wrap round silently.
        Object bound = NamedQueryCodec.coerce("p", DataType.Int8, json("3000000000"));
        assertThat(bound).isInstanceOf(Long.class).isEqualTo(3_000_000_000L);
    }

    @Test
    @DisplayName("Float4 binds a Float and Float8 binds a Double")
    void floatingTypes() {
        assertThat(NamedQueryCodec.coerce("p", DataType.Float4, json("1.5")))
            .isInstanceOf(Float.class).isEqualTo(1.5f);
        assertThat(NamedQueryCodec.coerce("p", DataType.Float8, json("1.5")))
            .isInstanceOf(Double.class).isEqualTo(1.5d);
        assertThat(NamedQueryCodec.coerce("p", DataType.Float8, json("\"1.5\"")))
            .isEqualTo(1.5d);
    }

    @Test
    @DisplayName("Boolean accepts a JSON boolean and the two strings, nothing else")
    void booleanType() {
        assertThat(NamedQueryCodec.coerce("p", DataType.Boolean, json("true")))
            .isEqualTo(Boolean.TRUE);
        assertThat(NamedQueryCodec.coerce("p", DataType.Boolean, json("\"false\"")))
            .isEqualTo(Boolean.FALSE);
        assertThat(NamedQueryCodec.coerce("p", DataType.Boolean, json("\"TRUE\"")))
            .isEqualTo(Boolean.TRUE);
    }

    @Test
    @DisplayName("String binds the text of any primitive, so a number is not refused")
    void stringType() {
        assertThat(NamedQueryCodec.coerce("p", DataType.String, json("\"hello\"")))
            .isEqualTo("hello");
        assertThat(NamedQueryCodec.coerce("p", DataType.String, json("42")))
            .isEqualTo("42");
    }

    @Test
    @DisplayName("ByteArray binds its text — there is no JSON form for bytes")
    void byteArrayType() {
        assertThat(NamedQueryCodec.coerce("p", DataType.ByteArray, json("\"abc\"")))
            .isEqualTo("abc");
    }

    @Test
    @DisplayName("DateTime accepts ISO-8601 with Z, with an offset, without one, and epoch millis")
    void dateTimeType() {
        Date utc = (Date) NamedQueryCodec.coerce("p", DataType.DateTime,
            json("\"2026-09-02T14:30:00Z\""));
        assertThat(utc.toInstant())
            .isEqualTo(OffsetDateTime.parse("2026-09-02T14:30:00Z").toInstant());

        Date adelaide = (Date) NamedQueryCodec.coerce("p", DataType.DateTime,
            json("\"2026-09-02T14:30:00+09:30\""));
        assertThat(adelaide.toInstant())
            .isEqualTo(OffsetDateTime.parse("2026-09-02T14:30:00+09:30").toInstant());

        // No offset means the GATEWAY's zone — the one the database session is in,
        // and the one a user typing a local timestamp means.
        Date local = (Date) NamedQueryCodec.coerce("p", DataType.DateTime,
            json("\"2026-09-02T14:30:00\""));
        assertThat(local.toInstant()).isEqualTo(
            java.time.LocalDateTime.parse("2026-09-02T14:30:00")
                .atZone(ZoneId.systemDefault()).toInstant());

        Date millis = (Date) NamedQueryCodec.coerce("p", DataType.DateTime,
            json("1788446400000"));
        assertThat(millis.getTime()).isEqualTo(1788446400000L);
    }

    @Test
    @DisplayName("DateTime accepts a bare instant with fractional seconds")
    void dateTimeWithMillis() {
        Date d = (Date) NamedQueryCodec.coerce("p", DataType.DateTime,
            json("\"2026-09-02T14:30:00.250Z\""));
        assertThat(d.toInstant().atOffset(ZoneOffset.UTC).getNano()).isEqualTo(250_000_000);
    }

    @Test
    @DisplayName("a JSON null binds null on every type, so a nullable column can be tested")
    void nullBindsNull() {
        for (DataType type : NamedQuery.PARAMETER_TYPES) {
            assertThat(NamedQueryCodec.coerce("p", type, JsonNull.INSTANCE))
                .as("%s should accept a null", type.name())
                .isNull();
        }
    }

    // ==================== the failures, one per type ====================

    @Test
    @DisplayName("every numeric type refuses a non-numeric string, naming the parameter")
    void numericTypesRefuseText() {
        for (DataType type : List.of(DataType.Int1, DataType.Int2, DataType.Int4,
            DataType.Int8, DataType.Float4, DataType.Float8)) {
            assertThatThrownBy(() -> NamedQueryCodec.coerce("qty", type, json("\"lots\"")))
                .as("%s should refuse 'lots'", type.name())
                .isInstanceOf(NamedQueryCodec.BadValueException.class)
                .hasMessageContaining("qty")
                .hasMessageContaining(type.name());
        }
    }

    @Test
    @DisplayName("an integral type refuses a FRACTIONAL number rather than rounding it")
    void integralRefusesAFraction() {
        // Silently truncating 42.7 to 42 is the kind of coercion that survives
        // every test and is discovered in a report six months later.
        assertThatThrownBy(() -> NamedQueryCodec.coerce("qty", DataType.Int4, json("42.7")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("qty");
    }

    @Test
    @DisplayName("Boolean refuses anything but true/false")
    void booleanRefusesOther() {
        assertThatThrownBy(() -> NamedQueryCodec.coerce("flag", DataType.Boolean, json("1")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("flag");
        assertThatThrownBy(() -> NamedQueryCodec.coerce("flag", DataType.Boolean, json("\"yes\"")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("true or false");
    }

    @Test
    @DisplayName("DateTime refuses a date that is not ISO-8601, and says which shapes work")
    void dateTimeRefusesOther() {
        assertThatThrownBy(() ->
            NamedQueryCodec.coerce("when", DataType.DateTime, json("\"02/09/2026\"")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("when")
            .hasMessageContaining("ISO-8601");
    }

    @Test
    @DisplayName("a non-primitive JSON value is refused on every type")
    void objectsAndArraysAreRefused() {
        assertThatThrownBy(() ->
            NamedQueryCodec.coerce("p", DataType.String, json("{\"a\":1}")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class);
        assertThatThrownBy(() ->
            NamedQueryCodec.coerce("p", DataType.Int4, json("[1,2]")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class);
    }

    // ==================== the whole map ====================

    @Test
    @DisplayName("the map is coerced by each parameter's OWN declared type")
    void wholeMapUsesEachDeclaredType() {
        List<NamedQuery.Parameter> declared = List.of(
            new NamedQuery.Parameter(NamedQuery.ParameterType.Parameter, "id", DataType.Int4),
            new NamedQuery.Parameter(NamedQuery.ParameterType.Parameter, "name", DataType.String),
            new NamedQuery.Parameter(NamedQuery.ParameterType.Parameter, "at", DataType.DateTime));
        JsonObject supplied = (JsonObject) json(
            "{\"id\":\"7\",\"name\":42,\"at\":\"2026-09-02T00:00:00Z\"}");

        Map<String, Object> bound = NamedQueryCodec.coerceParameters(declared, supplied);

        assertThat(bound.get("id")).isInstanceOf(Integer.class).isEqualTo(7);
        assertThat(bound.get("name")).isInstanceOf(String.class).isEqualTo("42");
        assertThat(bound.get("at")).isInstanceOf(Date.class);
    }

    @Test
    @DisplayName("a parameter the query does not declare is refused, and the message lists what is")
    void undeclaredParameterIsRefused() {
        List<NamedQuery.Parameter> declared = List.of(
            new NamedQuery.Parameter(NamedQuery.ParameterType.Parameter, "id", DataType.Int4));

        assertThatThrownBy(() -> NamedQueryCodec.coerceParameters(declared,
            (JsonObject) json("{\"nope\":1}")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("nope")
            .hasMessageContaining("id");
    }

    @Test
    @DisplayName("no parameters supplied is an empty map, not a failure")
    void noParametersIsFine() {
        assertThat(NamedQueryCodec.coerceParameters(List.of(), null)).isEmpty();
    }
}
