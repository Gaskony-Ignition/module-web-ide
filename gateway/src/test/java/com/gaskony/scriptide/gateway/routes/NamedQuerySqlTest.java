package com.gaskony.scriptide.gateway.routes;

import com.inductiveautomation.ignition.common.db.namedquery.NamedQuery;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The {@code :identifier} → {@code ?} conversion that makes an UNSAVED draft
 * testable.
 *
 * <p>{@code runNamedQuery} does this inside the platform for a saved resource. A
 * draft has no resource, so the conversion happens here — and every case below is
 * one where getting it wrong produces a statement that still RUNS and returns the
 * wrong thing, which is why they are asserted individually rather than through one
 * happy path.</p>
 */
class NamedQuerySqlTest {

    private static NamedQuery.Parameter value(String identifier) {
        return new NamedQuery.Parameter(
            NamedQuery.ParameterType.Parameter, identifier, DataType.String);
    }

    private static NamedQuery.Parameter queryString(String identifier) {
        return new NamedQuery.Parameter(
            NamedQuery.ParameterType.QueryString, identifier, DataType.String);
    }

    private static Map<String, Object> values(Object... pairs) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            out.put((String) pairs[i], pairs[i + 1]);
        }
        return out;
    }

    @Test
    @DisplayName("a Value parameter becomes ? and its value is bound")
    void valueBecomesAPlaceholder() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT * FROM t WHERE id = :id",
            List.of(value("id")), values("id", 42));

        assertThat(p.sql()).isEqualTo("SELECT * FROM t WHERE id = ?");
        assertThat(p.arguments()).containsExactly(42);
    }

    @Test
    @DisplayName("a repeated identifier is bound once per OCCURRENCE, in order")
    void repeatedIdentifierBindsTwice() {
        // A positional statement has no concept of a named repeat: three ?s need
        // three arguments. Binding once would shift every later argument by one and
        // still execute.
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT :a, :b, :a FROM t",
            List.of(value("a"), value("b")), values("a", "x", "b", "y"));

        assertThat(p.sql()).isEqualTo("SELECT ?, ?, ? FROM t");
        assertThat(p.arguments()).containsExactly("x", "y", "x");
    }

    @Test
    @DisplayName("':identifier' is not a prefix match of ':id'")
    void longestIdentifierWins() {
        // Reading the shortest match would turn ':identifier' into '?entifier' —
        // valid SQL in some dialects, and wrong everywhere.
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT :identifier, :id FROM t",
            List.of(value("identifier"), value("id")),
            values("identifier", "long", "id", "short"));

        assertThat(p.sql()).isEqualTo("SELECT ?, ? FROM t");
        assertThat(p.arguments()).containsExactly("long", "short");
    }

    @Test
    @DisplayName("a colon inside a single-quoted literal is data, not a placeholder")
    void colonInsideALiteralIsLeftAlone() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT 'ratio 3:1' AS r, :v FROM t",
            List.of(value("v")), values("v", 1));

        assertThat(p.sql()).isEqualTo("SELECT 'ratio 3:1' AS r, ? FROM t");
        assertThat(p.arguments()).containsExactly(1);
    }

    @Test
    @DisplayName("a doubled quote inside a literal does not end it")
    void doubledQuoteInsideALiteral() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT 'it''s 3:1' AS r, :v FROM t",
            List.of(value("v")), values("v", 1));

        assertThat(p.sql()).isEqualTo("SELECT 'it''s 3:1' AS r, ? FROM t");
        assertThat(p.arguments()).containsExactly(1);
    }

    @Test
    @DisplayName("an unterminated literal is left to the database to complain about")
    void unterminatedLiteralIsCopied() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT 'oops :v", List.of(value("v")), values("v", 1));

        assertThat(p.sql()).isEqualTo("SELECT 'oops :v");
        assertThat(p.arguments()).isEmpty();
    }

    @Test
    @DisplayName("PostgreSQL's :: cast is not a placeholder named 'text'")
    void doubleColonIsACast() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT :v::text FROM t", List.of(value("v")), values("v", "1"));

        assertThat(p.sql()).isEqualTo("SELECT ?::text FROM t");
        assertThat(p.arguments()).containsExactly("1");
    }

    @Test
    @DisplayName("a QueryString parameter is substituted as TEXT, not bound")
    void queryStringIsSubstituted() {
        // The platform's own semantic: a QueryString holds a SQL fragment. It is an
        // injection point by design, which is why the test route is admin-only.
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT * FROM t ORDER BY :sort",
            List.of(queryString("sort")), values("sort", "name DESC"));

        assertThat(p.sql()).isEqualTo("SELECT * FROM t ORDER BY name DESC");
        assertThat(p.arguments()).isEmpty();
    }

    @Test
    @DisplayName("a QueryString with no value is refused rather than substituted as empty")
    void queryStringWithoutAValueIsRefused() {
        assertThatThrownBy(() -> NamedQuerySql.prepare(
            "SELECT * FROM t ORDER BY :sort", List.of(queryString("sort")), values()))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("sort");
    }

    @Test
    @DisplayName("an undeclared :reference is a refusal that names it")
    void undeclaredReferenceIsRefused() {
        assertThatThrownBy(() -> NamedQuerySql.prepare(
            "SELECT * FROM t WHERE id = :nope", List.of(value("id")), values("id", 1)))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("nope");
    }

    @Test
    @DisplayName("a Database parameter cannot be used inside the SQL")
    void databaseParameterInTheSqlIsRefused() {
        assertThatThrownBy(() -> NamedQuerySql.prepare(
            "SELECT * FROM :database.t",
            List.of(new NamedQuery.Parameter(NamedQuery.ParameterType.Database,
                "database", DataType.String)),
            values("database", "Postgres_Test")))
            .isInstanceOf(NamedQueryCodec.BadValueException.class)
            .hasMessageContaining("selects the connection");
    }

    @Test
    @DisplayName("an unsupplied Value parameter binds null")
    void unsuppliedValueBindsNull() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT :v", List.of(value("v")), values());

        assertThat(p.arguments()).containsExactly((Object) null);
    }

    @Test
    @DisplayName("a colon that starts nothing is left where it is")
    void loneColonIsCopied() {
        NamedQuerySql.Prepared p = NamedQuerySql.prepare(
            "SELECT 1 : 2", List.of(), values());

        assertThat(p.sql()).isEqualTo("SELECT 1 : 2");
    }

    // ==================== which connection ====================

    @Test
    @DisplayName("a Database parameter's value beats the query's own setting")
    void databaseParameterWins() {
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setDatabase("Configured");
        q.setParameters(List.of(new NamedQuery.Parameter(
            NamedQuery.ParameterType.Database, "database", DataType.String)));

        assertThat(NamedQuerySql.connectionFor(q, values("database", "Chosen")))
            .isEqualTo("Chosen");
        assertThat(NamedQuerySql.connectionFor(q, values()))
            .isEqualTo("Configured");
    }

    @Test
    @DisplayName("the '{}' sentinel is not a connection name — it means the project default")
    void databaseParamOptionMeansDefault() {
        // NamedQuery.DATABASE_PARAM_OPTION is what the Designer stores in
        // `database` to mean "take it from the Database parameter". Passing it
        // through as a name would look for a connection literally called "{}".
        NamedQuery q = NamedQueryRouteHandler.newQuery();
        q.setDatabase(NamedQuery.DATABASE_PARAM_OPTION);

        assertThat(NamedQuerySql.connectionFor(q, values())).isEmpty();
    }
}
