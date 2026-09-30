package com.gaskony.scriptide.gateway.lang;

import com.inductiveautomation.ignition.gateway.datasource.DatasourceManager;
import com.inductiveautomation.ignition.gateway.datasource.SRConnection;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link SdkDbSchema} — specifically the two things {@code getOrLoadNow}
 * exists for that a fake in {@code LanguageServerTest} cannot prove: a real
 * metadata failure is thrown rather than swallowed into an empty list, and a
 * literal table name is escaped before it becomes a LIKE pattern.
 */
class SdkDbSchemaTest {

    private DatasourceManager manager;
    private SRConnection connection;
    private DatabaseMetaData meta;

    private SdkDbSchema newSchema() {
        manager = mock(DatasourceManager.class);
        connection = mock(SRConnection.class);
        meta = mock(DatabaseMetaData.class);
        return new SdkDbSchema(manager, Runnable::run);
    }

    private void givenConnection(String datasource) throws SQLException {
        when(manager.getConnection(datasource)).thenReturn(connection);
        when(connection.getMetaData()).thenReturn(meta);
    }

    @Test
    @DisplayName("tablesNow() throws rather than answering an empty list when the metadata read fails")
    void tablesNowThrowsOnFailure() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getTables(any(), any(), any(), any())).thenThrow(new SQLException("connection reset"));

        assertThatThrownBy(() -> schema.tablesNow("MyDb"))
            .isInstanceOf(RuntimeException.class)
            .hasMessageContaining("connection reset");
    }

    @Test
    @DisplayName("columnDetailsNow() throws rather than answering an empty list when the metadata read fails")
    void columnDetailsNowThrowsOnFailure() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("\\");
        when(meta.getColumns(any(), any(), any(), any())).thenThrow(new SQLException("no such table"));

        assertThatThrownBy(() -> schema.columnDetailsNow("MyDb", "t"))
            .isInstanceOf(RuntimeException.class)
            .hasMessageContaining("no such table");
    }

    @Test
    @DisplayName("tables and columns are read from the connection's own catalog, not every catalog")
    void metadataIsScopedToTheConnectedCatalog() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(connection.getCatalog()).thenReturn("plant");
        when(meta.getSearchStringEscape()).thenReturn("\\");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);
        when(meta.getColumns(any(), any(), any(), any())).thenReturn(rs);

        schema.tablesNow("MyDb");
        schema.columnDetailsNow("MyDb", "t");

        verify(meta).getTables(eq("plant"), eq(null), eq("%"), any());
        verify(meta).getColumns(eq("plant"), eq(null), eq("t"), eq("%"));
    }

    @Test
    @DisplayName("the 30 s metadata network timeout is taken off the pooled connection afterwards, even on failure")
    void networkTimeoutIsRestored() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(connection.getNetworkTimeout()).thenReturn(0);
        when(meta.getSearchStringEscape()).thenReturn("\\");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);
        when(meta.getColumns(any(), any(), any(), any())).thenThrow(new SQLException("no such table"));

        schema.tablesNow("MyDb");
        assertThatThrownBy(() -> schema.columnDetailsNow("MyDb", "t")).isInstanceOf(RuntimeException.class);

        org.mockito.InOrder order = org.mockito.Mockito.inOrder(connection);
        for (int call = 0; call < 2; call++) {
            order.verify(connection).setNetworkTimeout(any(), eq(30_000));
            order.verify(connection).setNetworkTimeout(any(), eq(0));
        }
    }

    @Test
    @DisplayName("invalidate makes the next table read go back to the database")
    void invalidateForcesAFreshTableRead() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);

        schema.tablesNow("MyDb");
        schema.tablesNow("MyDb");
        verify(meta, org.mockito.Mockito.times(1)).getTables(any(), any(), any(), any());

        schema.invalidate("MyDb");
        schema.tablesNow("MyDb");
        verify(meta, org.mockito.Mockito.times(2)).getTables(any(), any(), any(), any());
    }

    @Test
    @DisplayName("SQL Server's sys and INFORMATION_SCHEMA views are left out of the table list")
    void systemSchemasAreLeftOut() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(true, true, true, false);
        when(rs.getString("TABLE_NAME")).thenReturn("orders", "objects", "TABLES");
        when(rs.getString("TABLE_SCHEM")).thenReturn("dbo", "sys", "INFORMATION_SCHEMA");
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);

        assertThat(schema.tablesNow("MyDb")).containsExactly("orders");
    }

    @Test
    @DisplayName("a table literal containing _ or % is escaped before it reaches getColumns as a pattern")
    void columnLookupEscapesLikeWildcards() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("\\");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getColumns(eq(null), eq(null), eq("my\\_table"), eq("%"))).thenReturn(rs);

        List<DbSchema.Column> columns = schema.columnDetailsNow("MyDb", "my_table");

        assertThat(columns).isEmpty();
        // The real point of the test: getColumns was called with the ESCAPED
        // pattern, not the literal "my_table" — without escaping, "_" is a
        // LIKE wildcard and would also match "myXtable".
        verify(meta).getColumns(eq(null), eq(null), eq("my\\_table"), eq("%"));
    }

    @Test
    @DisplayName("a table literal containing the escape character itself is doubled up first")
    void columnLookupEscapesTheEscapeCharacterItself() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("\\");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getColumns(any(), any(), any(), any())).thenReturn(rs);

        schema.columnDetailsNow("MyDb", "back\\slash");

        // A literal backslash in the name must be escaped BEFORE _ and % are
        // escaped, or a name containing one could be misread as introducing
        // an escape sequence rather than being a literal character.
        verify(meta).getColumns(eq(null), eq(null), eq("back\\\\slash"), eq("%"));
    }

    @Test
    @DisplayName("no search-string escape from the driver: the literal is passed through unchanged")
    void noEscapeCharacterMeansNoRewriting() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getColumns(any(), any(), any(), any())).thenReturn(rs);

        schema.columnDetailsNow("MyDb", "my_table");

        verify(meta).getColumns(eq(null), eq(null), eq("my_table"), eq("%"));
    }

    @Test
    @DisplayName("a background completion load that fails is not left half-registered: get() answers empty, not throw")
    void backgroundLoadFailureNeverEscapesToTheCompletionCaller() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getTables(any(), any(), any(), any())).thenThrow(new SQLException("boom"));

        // tables() is the completion (non-blocking) path: TtlCache.get()'s own
        // background wrapper catches the RuntimeException this throws now, so
        // a failed load must not propagate to a keystroke's caller.
        List<String> result = schema.tables("MyDb");
        assertThat(result).isEmpty();
    }

    // ==================== tablesDetailedNow ====================

    @Test
    @DisplayName("tablesDetailedNow reports each table's schema and JDBC type, and the connection facts")
    void tablesDetailedNowReportsSchemaTypeAndFacts() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(true, true, false);
        when(rs.getString("TABLE_NAME")).thenReturn("orders", "widgets");
        when(rs.getString("TABLE_SCHEM")).thenReturn("public", "other");
        when(rs.getString("TABLE_TYPE")).thenReturn("TABLE", "VIEW");
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);
        when(connection.getSchema()).thenReturn("public");
        when(meta.getIdentifierQuoteString()).thenReturn("\"");
        when(meta.storesLowerCaseIdentifiers()).thenReturn(true);
        when(meta.storesUpperCaseIdentifiers()).thenReturn(false);
        when(meta.getDatabaseProductName()).thenReturn("PostgreSQL");

        DbSchema.TablesDetail detail = schema.tablesDetailedNow("MyDb");

        assertThat(detail.tables()).containsExactly(
            new DbSchema.TableInfo("public", "orders", "TABLE"),
            new DbSchema.TableInfo("other", "widgets", "VIEW"));
        assertThat(detail.facts().defaultSchema()).isEqualTo("public");
        assertThat(detail.facts().identifierQuote()).isEqualTo("\"");
        assertThat(detail.facts().storesLowerCaseIdentifiers()).isTrue();
        assertThat(detail.facts().storesUpperCaseIdentifiers()).isFalse();
        assertThat(detail.facts().databaseProductName()).isEqualTo("PostgreSQL");
    }

    @Test
    @DisplayName("tablesDetailedNow still drops sys/INFORMATION_SCHEMA/pg_catalog rows, exactly like tablesNow")
    void tablesDetailedNowDropsSystemSchemas() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(true, true, false);
        when(rs.getString("TABLE_NAME")).thenReturn("orders", "objects");
        when(rs.getString("TABLE_SCHEM")).thenReturn("dbo", "sys");
        when(rs.getString("TABLE_TYPE")).thenReturn("TABLE", "TABLE");
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);

        assertThat(schema.tablesDetailedNow("MyDb").tables())
            .extracting(DbSchema.TableInfo::name).containsExactly("orders");
    }

    @Test
    @DisplayName("a null Connection.getSchema() (no schema concept, or a driver that refuses it) is reported as null, not thrown")
    void tablesDetailedNowToleratesNoCurrentSchema() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getTables(any(), any(), any(), any())).thenReturn(rs);
        when(connection.getSchema()).thenThrow(new SQLException("not supported"));

        assertThat(schema.tablesDetailedNow("MyDb").facts().defaultSchema()).isNull();
    }

    // ==================== schema-qualified columns ====================

    @Test
    @DisplayName("an explicit schema is passed through to getColumns, escaped the same way as the table name")
    void columnDetailsNowPassesAnEscapedSchema() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("\\");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getColumns(any(), any(), any(), any())).thenReturn(rs);

        schema.columnDetailsNow("MyDb", "my_schema", "my_table");

        verify(meta).getColumns(eq(null), eq("my\\_schema"), eq("my\\_table"), eq("%"));
    }

    @Test
    @DisplayName("a null schema behaves exactly as the two-argument overload always did")
    void columnDetailsNowWithNullSchemaMatchesTheTwoArgumentOverload() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("\\");
        ResultSet rs = mock(ResultSet.class);
        when(rs.next()).thenReturn(false);
        when(meta.getColumns(any(), any(), any(), any())).thenReturn(rs);

        schema.columnDetailsNow("MyDb", null, "my_table");

        verify(meta).getColumns(eq(null), eq(null), eq("my\\_table"), eq("%"));
    }

    @Test
    @DisplayName("two schemas' same-named table get independently cached columns, not one clobbering the other")
    void columnDetailsNowCachesPerSchema() throws SQLException {
        SdkDbSchema schema = newSchema();
        givenConnection("MyDb");
        when(meta.getSearchStringEscape()).thenReturn("");
        ResultSet rsA = mock(ResultSet.class);
        when(rsA.next()).thenReturn(true, false);
        when(rsA.getString("COLUMN_NAME")).thenReturn("a_col");
        when(rsA.getString("TYPE_NAME")).thenReturn("int4");
        ResultSet rsB = mock(ResultSet.class);
        when(rsB.next()).thenReturn(true, false);
        when(rsB.getString("COLUMN_NAME")).thenReturn("b_col");
        when(rsB.getString("TYPE_NAME")).thenReturn("int4");
        when(meta.getColumns(eq(null), eq("schema_a"), eq("t"), eq("%"))).thenReturn(rsA);
        when(meta.getColumns(eq(null), eq("schema_b"), eq("t"), eq("%"))).thenReturn(rsB);

        List<DbSchema.Column> colsA = schema.columnDetailsNow("MyDb", "schema_a", "t");
        List<DbSchema.Column> colsB = schema.columnDetailsNow("MyDb", "schema_b", "t");

        assertThat(colsA).extracting(DbSchema.Column::name).containsExactly("a_col");
        assertThat(colsB).extracting(DbSchema.Column::name).containsExactly("b_col");
    }
}
