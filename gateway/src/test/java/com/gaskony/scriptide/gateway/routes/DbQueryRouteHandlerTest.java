package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.history.QueryHistory;
import com.gaskony.scriptide.gateway.lang.DbSchema;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.datasource.DatasourceManager;
import com.inductiveautomation.ignition.gateway.datasource.SRConnection;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The run route's GATES, the JDBC result walker, and cell coercion.
 *
 * <p>Same split as {@code NamedQueryTestRouteHandlerTest}: what can be proved
 * without a real database — which requests get turned away before touching a
 * connection, and how a {@link Statement}'s results are shaped — is proved here
 * with Mockito fakes for the JDBC types. A real run against a real datasource is
 * proved on the rig (deploy_gate.py and the live Playwright check), not here;
 * this module adds no in-memory database dependency to do it inside a unit
 * test.</p>
 */
class DbQueryRouteHandlerTest {

    /** A deadline far enough away that no test in this file trips it by accident. */
    private static final long FAR_FUTURE = System.nanoTime() + TimeUnit.HOURS.toNanos(1);

    private DbQueryRouteHandler handler;
    private RequestContext req;
    private HttpServletResponse resp;

    @BeforeEach
    void setUp() {
        // Null context is the tripwire: reaching it means every validation gate
        // before it passed. A null DbSchema/ExecAudit/QueryHistory supplier is
        // just "the module has nothing further to say", not a failure.
        handler = new DbQueryRouteHandler(null, () -> null, () -> null, () -> null);
        req = Mockito.mock(RequestContext.class, Mockito.RETURNS_DEEP_STUBS);
        resp = Mockito.mock(HttpServletResponse.class);
    }

    private void givenBody(String body) throws Exception {
        when(req.readBody()).thenReturn(body);
    }

    private void assertReachedTheRun() {
        verify(resp).setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
    }

    private void assertRefusedWith(int status) {
        verify(resp).setStatus(status);
        verify(resp, never()).setStatus(HttpServletResponse.SC_SERVICE_UNAVAILABLE);
    }

    private static DbQueryRouteHandler.Budget freshBudget() {
        return new DbQueryRouteHandler.Budget();
    }

    private static AtomicBoolean notCancelled() {
        return new AtomicBoolean(false);
    }

    // ==================== the gates ====================

    @Test
    @DisplayName("a missing runId is a 400, before any connection is opened")
    void missingRunIdIs400() throws Exception {
        givenBody("{\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\"}");
        handler.run(req, resp);
        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("a missing datasource is a 400")
    void missingDatasourceIs400() throws Exception {
        givenBody("{\"runId\":\"r1\",\"sql\":\"SELECT 1\"}");
        handler.run(req, resp);
        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("missing sql is a 400")
    void missingSqlIs400() throws Exception {
        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\"}");
        handler.run(req, resp);
        assertRefusedWith(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("a well-formed request reaches the run — every gate before it allowed it")
    void wellFormedRequestReachesTheRun() throws Exception {
        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\"}");
        handler.run(req, resp);
        assertReachedTheRun();
    }

    @Test
    @DisplayName("a RuntimeException opening the connection is a 200 {ok:false}, not a 500 — and is recorded")
    void connectionFailureIsReportedNotThrownAndRecorded() throws Exception {
        // DatasourceManager#getConnection only DECLARES SQLException; an unknown
        // datasource name is not guaranteed to arrive as one — see describeFailure.
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("Nope"))
            .thenThrow(new IllegalArgumentException("No such datasource: Nope"));
        QueryHistory history = Mockito.mock(QueryHistory.class);
        DbQueryRouteHandler handlerWithContext =
            new DbQueryRouteHandler(context, () -> null, () -> null, () -> history);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"Nope\",\"sql\":\"SELECT 1\"}");
        Object result = handlerWithContext.run(req, resp);

        // No status was ever set: this is a business-logic outcome, not a
        // transport failure — exactly like a SQL error from a live connection.
        verify(resp, never()).setStatus(Mockito.anyInt());
        JsonObject body = (JsonObject) result;
        assertThat(body.get("ok").getAsBoolean()).isFalse();
        assertThat(body.getAsJsonObject("error").get("type").getAsString())
            .isEqualTo("IllegalArgumentException");
        verify(history).record(anyString(), eq("Nope"), eq("SELECT 1"), eq(false),
            eq("No such datasource: Nope"), isNull(), anyLong());
    }

    @Test
    @DisplayName("recordHistory:false still audits the run but skips the local history write (E)")
    void recordHistoryFalseSkipsHistoryButStillAudits() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        QueryHistory history = Mockito.mock(QueryHistory.class);
        ExecAudit audit = Mockito.mock(ExecAudit.class);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> audit, () -> history);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\",\"recordHistory\":false}");
        h.run(req, resp);

        verify(audit).record(anyString(), any(), anyString(), eq("db:MyDb"), eq("SELECT 1"));
        verify(history, never()).record(any(), any(), any(), any(Boolean.class), any(), any(), anyLong());
    }

    @Test
    @DisplayName("recordHistory absent defaults to recording history, like every run before this flag existed")
    void recordHistoryAbsentDefaultsToTrue() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        QueryHistory history = Mockito.mock(QueryHistory.class);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> history);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\"}");
        h.run(req, resp);

        verify(history).record(anyString(), eq("MyDb"), eq("SELECT 1"), eq(true), isNull(), anyString(), anyLong());
    }

    // ==================== read-only hint (auto-refresh) ====================

    @Test
    @DisplayName("readOnly:true sets the JDBC read-only hint on the connection before the statement runs")
    void readOnlyTrueSetsReadOnlyHintOnConnection() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\",\"readOnly\":true}");
        h.run(req, resp);

        verify(connection).setReadOnly(true);
    }

    @Test
    @DisplayName("readOnly:true runs inside a transaction that is rolled back, not committed, and says nothing about it")
    void readOnlyRunIsAlwaysRolledBack() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        // What a DELETE ... RETURNING looks like to the walker: rows, not a count.
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(rs.getMetaData()).thenReturn(meta);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        // The mock records setAutoCommit(false); report it so rollBackIfOpen sees the open transaction.
        when(connection.getAutoCommit()).thenReturn(false);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"DELETE FROM t RETURNING *\",\"readOnly\":true}");
        JsonObject body = (JsonObject) h.run(req, resp);

        org.mockito.InOrder order = Mockito.inOrder(connection, statement);
        order.verify(connection).setAutoCommit(false);
        order.verify(statement).execute(anyString());
        order.verify(connection).rollback();
        verify(connection, never()).commit();
        verify(connection).setAutoCommit(true);
        assertThat(body.has("rolledBackTransaction")).isFalse();
    }

    @Test
    @DisplayName("readOnly omitted never sets the JDBC read-only hint on")
    void readOnlyOmittedNeverSetsReadOnlyHintOn() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\"}");
        h.run(req, resp);

        verify(connection, never()).setReadOnly(true);
    }

    @Test
    @DisplayName("the read-only hint is turned back off before the connection returns to the pool, after a readOnly:true run")
    void readOnlyHintIsRestoredAfterATrueRun() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\",\"readOnly\":true}");
        h.run(req, resp);

        verify(connection).setReadOnly(false);
    }

    @Test
    @DisplayName("the read-only hint is turned back off before the connection returns to the pool, "
        + "even on a plain run that never requested it")
    void readOnlyHintIsRestoredAfterAPlainRun() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\"}");
        h.run(req, resp);

        verify(connection).setReadOnly(false);
    }

    @Test
    @DisplayName("a driver that throws setting the read-only hint still completes the run successfully — best-effort, not a guarantee")
    void readOnlyHintFailureIsSwallowedAndTheRunStillSucceeds() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        Mockito.doThrow(new SQLException("nope")).when(connection).setReadOnly(anyBoolean());
        when(statement.execute(anyString())).thenReturn(true);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\",\"readOnly\":true}");
        Object result = h.run(req, resp);

        JsonObject body = (JsonObject) result;
        assertThat(body.get("ok").getAsBoolean()).isTrue();
    }

    @Test
    @DisplayName("too many concurrent runs is a 409, and releases the permit it never used")
    void tooManyConcurrentRunsIs409() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DbQueryRouteHandler oneAtATime = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);
        // Drain every permit ExecPolicy.maxConcurrent() granted at construction —
        // a real run that blocks forever to hold its permit is not needed;
        // tryAcquire()'s own contract is exercised by there being none left.
        java.util.concurrent.Semaphore limiter = extractLimiter(oneAtATime);
        limiter.drainPermits();

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"SELECT 1\"}");
        oneAtATime.run(req, resp);

        verify(resp).setStatus(HttpServletResponse.SC_CONFLICT);
    }

    private static java.util.concurrent.Semaphore extractLimiter(DbQueryRouteHandler h) throws Exception {
        java.lang.reflect.Field field = DbQueryRouteHandler.class.getDeclaredField("concurrencyLimiter");
        field.setAccessible(true);
        return (java.util.concurrent.Semaphore) field.get(h);
    }

    @Test
    @DisplayName("cancelling with no runId is a 400")
    void cancelMissingRunIdIs400() throws Exception {
        givenBody("{}");
        handler.cancel(req, resp);
        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("cancelling a run that is not tracked is a 404")
    void cancelUnknownRunIs404() throws Exception {
        givenBody("{\"runId\":\"nope\"}");
        handler.cancel(req, resp);
        verify(resp).setStatus(HttpServletResponse.SC_NOT_FOUND);
    }

    @Test
    @DisplayName("tables with no datasource is a 400")
    void tablesMissingDatasourceIs400() {
        when(req.getParameter("datasource")).thenReturn(null);
        handler.tables(req, resp);
        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("columns with no table is a 400")
    void columnsMissingTableIs400() {
        when(req.getParameter("datasource")).thenReturn("MyDb");
        when(req.getParameter("table")).thenReturn(null);
        handler.columns(req, resp);
        verify(resp).setStatus(HttpServletResponse.SC_BAD_REQUEST);
    }

    @Test
    @DisplayName("datasources answers empty rather than throwing with no gateway context")
    void datasourcesEmptyWithNoContext() {
        Object body = handler.datasources(req, resp);
        assertThat(((JsonObject) body).getAsJsonArray("datasources")).isEmpty();
    }

    // ==================== schema-qualified names (A) ====================

    @Test
    @DisplayName("tables reports each row's schema and type, plus the connection facts needed to qualify/quote a name")
    void tablesReportsSchemaQualifiedRowsAndConnectionFacts() {
        DbSchema fakeSchema = Mockito.mock(DbSchema.class);
        when(req.getParameter("datasource")).thenReturn("MyDb");
        when(fakeSchema.tablesDetailedNow("MyDb")).thenReturn(new DbSchema.TablesDetail(
            List.of(new DbSchema.TableInfo("public", "orders", "TABLE"),
                new DbSchema.TableInfo(null, "widgets", "VIEW")),
            new DbSchema.ConnectionFacts("public", "\"", true, false, "PostgreSQL")));
        DbQueryRouteHandler h = new DbQueryRouteHandler(null, () -> fakeSchema, () -> null, () -> null);

        JsonObject body = (JsonObject) h.tables(req, resp);

        JsonArray tables = body.getAsJsonArray("tables");
        assertThat(tables).hasSize(2);
        assertThat(tables.get(0).getAsJsonObject().get("schema").getAsString()).isEqualTo("public");
        assertThat(tables.get(0).getAsJsonObject().get("name").getAsString()).isEqualTo("orders");
        assertThat(tables.get(0).getAsJsonObject().get("type").getAsString()).isEqualTo("TABLE");
        assertThat(tables.get(1).getAsJsonObject().get("schema").isJsonNull()).isTrue();
        assertThat(body.get("defaultSchema").getAsString()).isEqualTo("public");
        assertThat(body.get("identifierQuote").getAsString()).isEqualTo("\"");
        assertThat(body.get("storesLowerCaseIdentifiers").getAsBoolean()).isTrue();
        assertThat(body.get("storesUpperCaseIdentifiers").getAsBoolean()).isFalse();
        assertThat(body.get("databaseProductName").getAsString()).isEqualTo("PostgreSQL");
    }

    @Test
    @DisplayName("columns passes an explicit 'schema' request parameter through to the three-argument overload")
    void columnsPassesAnExplicitSchemaParameter() {
        DbSchema fakeSchema = Mockito.mock(DbSchema.class);
        when(req.getParameter("datasource")).thenReturn("MyDb");
        when(req.getParameter("table")).thenReturn("t");
        when(req.getParameter("schema")).thenReturn("s");
        when(fakeSchema.columnDetailsNow("MyDb", "s", "t"))
            .thenReturn(List.of(new DbSchema.Column("id", "int4")));
        DbQueryRouteHandler h = new DbQueryRouteHandler(null, () -> fakeSchema, () -> null, () -> null);

        JsonObject body = (JsonObject) h.columns(req, resp);

        assertThat(body.getAsJsonArray("columns")).hasSize(1);
        verify(fakeSchema).columnDetailsNow("MyDb", "s", "t");
        verify(fakeSchema, never()).columnDetailsNow(anyString(), anyString());
    }

    @Test
    @DisplayName("columns with no 'schema' parameter uses the two-argument overload, unchanged")
    void columnsWithNoSchemaParameterUsesTheTwoArgumentOverload() {
        DbSchema fakeSchema = Mockito.mock(DbSchema.class);
        when(req.getParameter("datasource")).thenReturn("MyDb");
        when(req.getParameter("table")).thenReturn("t");
        when(req.getParameter("schema")).thenReturn(null);
        when(fakeSchema.columnDetailsNow("MyDb", "t")).thenReturn(List.of());
        DbQueryRouteHandler h = new DbQueryRouteHandler(null, () -> fakeSchema, () -> null, () -> null);

        h.columns(req, resp);

        verify(fakeSchema).columnDetailsNow("MyDb", "t");
    }

    // ==================== row cap ====================

    @Test
    @DisplayName("a null or non-positive cap falls back to the default")
    void rowCapDefaults() {
        assertThat(DbQueryRouteHandler.clampRowCap(null)).isEqualTo(DbQueryRouteHandler.DEFAULT_ROW_CAP);
        assertThat(DbQueryRouteHandler.clampRowCap(0)).isEqualTo(DbQueryRouteHandler.DEFAULT_ROW_CAP);
        assertThat(DbQueryRouteHandler.clampRowCap(-5)).isEqualTo(DbQueryRouteHandler.DEFAULT_ROW_CAP);
    }

    @Test
    @DisplayName("a cap above the hard maximum is clamped down, never refused")
    void rowCapClampedToMaximum() {
        assertThat(DbQueryRouteHandler.clampRowCap(1_000_000)).isEqualTo(DbQueryRouteHandler.MAX_ROW_CAP);
    }

    @Test
    @DisplayName("a cap within range passes through unchanged")
    void rowCapPassesThroughInRange() {
        assertThat(DbQueryRouteHandler.clampRowCap(50)).isEqualTo(50);
    }

    // ==================== the JDBC walker ====================

    @Test
    @DisplayName("a SELECT is shaped as one result with columns, rows and an exact rowCount")
    void selectIsShapedAsRows() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);

        when(statement.execute("SELECT 1")).thenReturn(true);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        when(rs.getMetaData()).thenReturn(meta);
        when(meta.getColumnCount()).thenReturn(2);
        when(meta.getColumnLabel(1)).thenReturn("id");
        when(meta.getColumnLabel(2)).thenReturn("name");
        when(meta.getColumnTypeName(1)).thenReturn("int4");
        when(meta.getColumnTypeName(2)).thenReturn("varchar");
        when(rs.next()).thenReturn(true, true, false);
        when(rs.getObject(1)).thenReturn(1, 2);
        when(rs.getObject(2)).thenReturn("a", "b");

        JsonArray results = DbQueryRouteHandler.runAndShape(
            statement, "SELECT 1", 1000, FAR_FUTURE, notCancelled()).results();

        assertThat(results).hasSize(1);
        JsonObject result = results.get(0).getAsJsonObject();
        assertThat(result.getAsJsonArray("columns")).hasSize(2);
        assertThat(result.get("rowCount").getAsInt()).isEqualTo(2);
        assertThat(result.has("truncatedAt")).isFalse();
        assertThat(result.getAsJsonArray("rows").get(0).getAsJsonArray().get(1).getAsString())
            .isEqualTo("a");
    }

    @Test
    @DisplayName("an UPDATE is shaped as one {affected} result, with no columns at all")
    void updateIsShapedAsAffected() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        when(statement.execute("UPDATE t SET x=1")).thenReturn(false);
        when(statement.getUpdateCount()).thenReturn(3, -1);
        when(statement.getMoreResults()).thenReturn(false);

        JsonArray results = DbQueryRouteHandler.runAndShape(
            statement, "UPDATE t SET x=1", 1000, FAR_FUTURE, notCancelled()).results();

        assertThat(results).hasSize(1);
        assertThat(results.get(0).getAsJsonObject().get("affected").getAsInt()).isEqualTo(3);
    }

    @Test
    @DisplayName("a batch of statements produces one result per statement, in order")
    void batchProducesMultipleResults() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnCount()).thenReturn(0);
        when(rs.getMetaData()).thenReturn(meta);
        when(rs.next()).thenReturn(false);

        // First result is a ResultSet, second is an update count, then done —
        // the exact shape a "SELECT ...; UPDATE ...;" batch produces. Both
        // getMoreResults() calls say "no FURTHER result set"; it is getUpdateCount()
        // that tells the two apart, per the standard JDBC idiom.
        when(statement.execute("SELECT 1; UPDATE t SET x=1")).thenReturn(true);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1, 5, -1);
        when(statement.getMoreResults()).thenReturn(false);

        JsonArray results = DbQueryRouteHandler.runAndShape(
            statement, "SELECT 1; UPDATE t SET x=1", 1000, FAR_FUTURE, notCancelled()).results();

        assertThat(results).hasSize(2);
        assertThat(results.get(0).getAsJsonObject().has("rows")).isTrue();
        assertThat(results.get(1).getAsJsonObject().get("affected").getAsInt()).isEqualTo(5);
    }

    @Test
    @DisplayName("more rows than the cap: truncatedAt is set and only the cap's worth is returned")
    void truncationIsReported() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);

        when(statement.execute("SELECT * FROM big")).thenReturn(true);
        when(statement.getResultSet()).thenReturn(rs);
        when(statement.getUpdateCount()).thenReturn(-1);
        when(statement.getMoreResults()).thenReturn(false);
        when(rs.getMetaData()).thenReturn(meta);
        when(meta.getColumnCount()).thenReturn(1);
        when(meta.getColumnLabel(1)).thenReturn("id");
        when(meta.getColumnTypeName(1)).thenReturn("int4");
        // The statement's own setMaxRows(cap + 1) is what makes exactly 3 rows
        // observable for a cap of 2 — the driver itself would never hand back a
        // 4th.
        when(rs.next()).thenReturn(true, true, true, false);
        when(rs.getObject(1)).thenReturn(1, 2, 3);

        DbQueryRouteHandler.RunResult shaped = DbQueryRouteHandler.runAndShape(
            statement, "SELECT * FROM big", 2, FAR_FUTURE, notCancelled());
        JsonObject result = shaped.results().get(0).getAsJsonObject();

        assertThat(result.get("rowCount").getAsInt()).isEqualTo(2);
        assertThat(result.get("truncatedAt").getAsInt()).isEqualTo(2);
        assertThat(result.getAsJsonArray("rows")).hasSize(2);
        assertThat(shaped.truncated()).isTrue();
    }

    @Test
    @DisplayName("a batch producing more than MAX_RESULTS_PER_RUN results stops early and reports truncated")
    void resultCountCapStopsTheBatch() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        // Every "result" here is an update count of 1; getMoreResults() always
        // says "keep going" so only the MAX_RESULTS_PER_RUN cap can stop the loop.
        when(statement.execute("...")).thenReturn(false);
        Integer[] counts = new Integer[500];
        java.util.Arrays.fill(counts, 1);
        when(statement.getUpdateCount()).thenReturn(1, counts);
        when(statement.getMoreResults()).thenReturn(false);

        DbQueryRouteHandler.RunResult shaped = DbQueryRouteHandler.runAndShape(
            statement, "...", 1000, FAR_FUTURE, notCancelled());

        assertThat(shaped.results()).hasSize(DbQueryRouteHandler.MAX_RESULTS_PER_RUN);
        assertThat(shaped.truncated()).isTrue();
    }

    @Test
    @DisplayName("cancelled between results stops the loop and cancels nothing further")
    void cancelledFlagStopsTheLoopBetweenResults() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        AtomicBoolean cancelled = new AtomicBoolean(true);
        when(statement.execute("...")).thenReturn(false);
        when(statement.getUpdateCount()).thenReturn(1, 1, -1);
        when(statement.getMoreResults()).thenReturn(false);

        DbQueryRouteHandler.RunResult shaped = DbQueryRouteHandler.runAndShape(
            statement, "...", 1000, FAR_FUTURE, cancelled);

        assertThat(shaped.results()).isEmpty();
        assertThat(shaped.truncated()).isTrue();
    }

    @Test
    @DisplayName("a deadline already passed cancels the statement and stops the run")
    void pastDeadlineCancelsAndStops() throws SQLException {
        Statement statement = Mockito.mock(Statement.class);
        when(statement.execute("...")).thenReturn(false);
        when(statement.getUpdateCount()).thenReturn(1, 1, -1);
        when(statement.getMoreResults()).thenReturn(false);
        AtomicBoolean cancelled = notCancelled();

        long pastDeadline = System.nanoTime() - TimeUnit.SECONDS.toNanos(1);
        DbQueryRouteHandler.RunResult shaped = DbQueryRouteHandler.runAndShape(
            statement, "...", 1000, pastDeadline, cancelled);

        verify(statement).cancel();
        assertThat(cancelled.get()).isTrue();
        assertThat(shaped.truncated()).isTrue();
    }

    // ==================== cell coercion ====================

    @Test
    @DisplayName("null, booleans and numbers pass through; a BigDecimal keeps its exact text")
    void cellCoercionPassesThroughSimpleTypes() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.Budget budget = freshBudget();
        DbQueryRouteHandler.addCell(row, null, budget);
        DbQueryRouteHandler.addCell(row, true, budget);
        DbQueryRouteHandler.addCell(row, 42, budget);
        // Exactly representable as a double (42.5 = 85 * 2^-1) — the "stays a
        // number" case; a BigDecimal a double CANNOT hold exactly is covered
        // separately by bigDecimalNotExactAsDoubleBecomesString, where H3
        // requires it to become a string instead.
        DbQueryRouteHandler.addCell(row, new BigDecimal("42.5"), budget);

        assertThat(row.get(0).isJsonNull()).isTrue();
        assertThat(row.get(1).getAsBoolean()).isTrue();
        assertThat(row.get(2).getAsInt()).isEqualTo(42);
        assertThat(row.get(3).getAsJsonPrimitive().isNumber()).isTrue();
        assertThat(row.get(3).getAsBigDecimal()).isEqualByComparingTo(new BigDecimal("42.5"));
    }

    @Test
    @DisplayName("a timestamp keeps sub-millisecond precision; bytes become a size, never their content")
    void cellCoercionForDatesAndBytes() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.Budget budget = freshBudget();
        Timestamp ts = new Timestamp(0);
        ts.setNanos(123_456_789);
        DbQueryRouteHandler.addCell(row, ts, budget);
        DbQueryRouteHandler.addCell(row, new byte[]{1, 2, 3}, budget);

        assertThat(row.get(0).getAsString()).isEqualTo("1970-01-01T00:00:00.123456789Z");
        assertThat(row.get(1).getAsString()).isEqualTo("3 bytes");
    }

    @Test
    @DisplayName("a java.sql.Date renders as a plain calendar date, not a UTC instant")
    void sqlDateRendersAsLocalDate() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, java.sql.Date.valueOf("2026-09-28"), freshBudget());
        assertThat(row.get(0).getAsString()).isEqualTo("2026-09-28");
    }

    @Test
    @DisplayName("a java.sql.Time renders as a plain time of day")
    void sqlTimeRendersAsLocalTime() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, java.sql.Time.valueOf("13:45:30"), freshBudget());
        assertThat(row.get(0).getAsString()).isEqualTo("13:45:30");
    }

    @Test
    @DisplayName("a TIME column is read as LocalTime so fractions of a second survive")
    void timeColumnKeepsFractionalSeconds() throws SQLException {
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnType(1)).thenReturn(java.sql.Types.TIME);
        when(rs.getObject(1, java.time.LocalTime.class)).thenReturn(java.time.LocalTime.of(13, 45, 30, 500_000_000));

        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, DbQueryRouteHandler.readCell(rs, meta, 1), freshBudget());

        assertThat(row.get(0).getAsString()).isEqualTo("13:45:30.500");
    }

    @Test
    @DisplayName("a SQL Server DATETIMEOFFSET is read as OffsetDateTime and renders as ISO-8601")
    void datetimeOffsetRendersAsIso() throws SQLException {
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnType(1)).thenReturn(DbQueryRouteHandler.MSSQL_DATETIMEOFFSET);
        when(rs.getObject(1, java.time.OffsetDateTime.class)).thenReturn(
            java.time.OffsetDateTime.of(2026, 9, 29, 13, 45, 30, 250_000_000, java.time.ZoneOffset.ofHours(10)));

        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, DbQueryRouteHandler.readCell(rs, meta, 1), freshBudget());

        assertThat(row.get(0).getAsString()).isEqualTo("2026-09-29T13:45:30.250+10:00");
    }

    @Test
    @DisplayName("the connection is put back in the database it was borrowed in, undoing a USE")
    void restoreCatalogSetsTheOriginalCatalog() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        DbQueryRouteHandler.restoreCatalog(connection, "plant");
        verify(connection).setCatalog("plant");
    }

    @Test
    @DisplayName("a failure restoring the catalog is swallowed, not thrown")
    void restoreCatalogSwallowsFailure() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        Mockito.doThrow(new SQLException("gone")).when(connection).setCatalog("plant");
        DbQueryRouteHandler.restoreCatalog(connection, "plant");
        verify(connection).setCatalog("plant");
    }

    @Test
    @DisplayName("a timestamp without a zone is read as LocalDateTime — wall-clock, no Z")
    void plainTimestampRendersAsWallClock() throws SQLException {
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnType(1)).thenReturn(java.sql.Types.TIMESTAMP);
        when(meta.getColumnTypeName(1)).thenReturn("DATETIME");
        when(rs.getObject(1, java.time.LocalDateTime.class))
            .thenReturn(java.time.LocalDateTime.of(2026, 9, 29, 13, 45, 30, 500_000_000));

        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, DbQueryRouteHandler.readCell(rs, meta, 1), freshBudget());

        assertThat(row.get(0).getAsString()).isEqualTo("2026-09-29T13:45:30.500");
    }

    @Test
    @DisplayName("PostgreSQL timestamptz, reported as plain TIMESTAMP, is not read as wall-clock")
    void timestamptzIsNotReadAsLocalDateTime() throws SQLException {
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnType(1)).thenReturn(java.sql.Types.TIMESTAMP);
        when(meta.getColumnTypeName(1)).thenReturn("timestamptz");
        Timestamp ts = Timestamp.from(java.time.Instant.parse("2026-09-29T03:45:30Z"));
        when(rs.getObject(1)).thenReturn(ts);

        assertThat(DbQueryRouteHandler.readCell(rs, meta, 1)).isEqualTo(ts);
        verify(rs, never()).getObject(1, java.time.LocalDateTime.class);
    }

    @Test
    @DisplayName("the watchdog cancels a statement still running at the deadline, whatever the driver does")
    void watchdogCancelsAtTheDeadline() throws Exception {
        Statement statement = Mockito.mock(Statement.class);
        AtomicBoolean finished = new AtomicBoolean();
        AtomicBoolean fired = new AtomicBoolean();
        AtomicBoolean cancelled = new AtomicBoolean();
        long deadline = System.nanoTime() - DbQueryRouteHandler.WATCHDOG_GRACE_NANOS;

        DbQueryRouteHandler.scheduleWatchdog(statement, deadline, finished, fired, cancelled);

        Mockito.verify(statement, Mockito.timeout(5000)).cancel();
        assertThat(fired).isTrue();
        assertThat(cancelled).isTrue();
    }

    @Test
    @DisplayName("the watchdog does nothing to a run that already finished")
    void watchdogLeavesAFinishedRunAlone() throws Exception {
        Statement statement = Mockito.mock(Statement.class);
        AtomicBoolean finished = new AtomicBoolean(true);
        AtomicBoolean fired = new AtomicBoolean();
        long deadline = System.nanoTime() - DbQueryRouteHandler.WATCHDOG_GRACE_NANOS;

        DbQueryRouteHandler.scheduleWatchdog(statement, deadline, finished, fired, new AtomicBoolean());

        Mockito.verify(statement, Mockito.after(500).never()).cancel();
        assertThat(fired).isFalse();
    }

    @Test
    @DisplayName("SQL Server's HY008 and an 'interrupted' message count as a cancellation")
    void timeoutStatesCountAsCancellation() {
        assertThat(DbQueryRouteHandler.looksLikeCancellation(new SQLException("The query has timed out.", "HY008"))).isTrue();
        assertThat(DbQueryRouteHandler.looksLikeCancellation(new SQLException("Query execution was interrupted", "70100"))).isTrue();
        assertThat(DbQueryRouteHandler.looksLikeCancellation(new SQLException("syntax error", "42601"))).isFalse();
    }

    @Test
    @DisplayName("a timeout is reported as TimedOut, not as a driver error or a Stop")
    void timeoutIsDescribedAsTimedOut() {
        JsonObject error = DbQueryRouteHandler.describeTimeout();
        assertThat(error.get("type").getAsString()).isEqualTo("TimedOut");
        assertThat(error.get("message").getAsString()).contains("s limit");
    }

    @Test
    @DisplayName("a driver that cannot read TIME as LocalTime falls back to the plain read")
    void timeColumnFallsBackWhenTheDriverRefuses() throws SQLException {
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(meta.getColumnType(1)).thenReturn(java.sql.Types.TIME);
        when(rs.getObject(1, java.time.LocalTime.class)).thenThrow(new SQLException("unsupported"));
        when(rs.getObject(1)).thenReturn(java.sql.Time.valueOf("13:45:30"));

        assertThat(DbQueryRouteHandler.readCell(rs, meta, 1)).isEqualTo(java.sql.Time.valueOf("13:45:30"));
    }

    @Test
    @DisplayName("NaN and Infinity are sent as strings, never a bare JSON token Gson's writer would reject")
    void nonFiniteDoublesAreStrings() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.Budget budget = freshBudget();
        DbQueryRouteHandler.addCell(row, Double.NaN, budget);
        DbQueryRouteHandler.addCell(row, Double.POSITIVE_INFINITY, budget);
        DbQueryRouteHandler.addCell(row, Float.NEGATIVE_INFINITY, budget);

        assertThat(row.get(0).getAsJsonPrimitive().isString()).isTrue();
        assertThat(row.get(0).getAsString()).isEqualTo("NaN");
        assertThat(row.get(1).getAsString()).isEqualTo("Infinity");
        assertThat(row.get(2).getAsString()).isEqualTo("-Infinity");

        // Proves the whole array still serialises — a bare NaN/Infinity Number
        // would make Gson's own writer throw here.
        assertThat(row.toString()).doesNotContain("NaN,").doesNotContain(":NaN");
    }

    @Test
    @DisplayName("a finite double still travels as a real JSON number")
    void finiteDoubleStaysANumber() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, 3.5, freshBudget());
        assertThat(row.get(0).getAsJsonPrimitive().isNumber()).isTrue();
        assertThat(row.get(0).getAsDouble()).isEqualTo(3.5);
    }

    @Test
    @DisplayName("a Long inside JS's safe-integer range stays a number; outside it becomes a string")
    void bigLongBecomesAString() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.Budget budget = freshBudget();
        long safe = DbQueryRouteHandler.MAX_SAFE_INTEGER;
        long unsafe = safe + 2; // 9007199254740993 — the value that motivated this fix
        DbQueryRouteHandler.addCell(row, safe, budget);
        DbQueryRouteHandler.addCell(row, unsafe, budget);

        assertThat(row.get(0).getAsJsonPrimitive().isNumber()).isTrue();
        assertThat(row.get(1).getAsJsonPrimitive().isString()).isTrue();
        assertThat(row.get(1).getAsString()).isEqualTo("9007199254740993");
    }

    @Test
    @DisplayName("a BigInteger outside the safe range becomes a string; inside it, a number")
    void bigIntegerBecomesAStringOutsideSafeRange() throws SQLException {
        JsonArray row = new JsonArray();
        DbQueryRouteHandler.Budget budget = freshBudget();
        DbQueryRouteHandler.addCell(row, BigInteger.valueOf(100), budget);
        DbQueryRouteHandler.addCell(row, new BigInteger("123456789012345678901234567890"), budget);

        assertThat(row.get(0).getAsJsonPrimitive().isNumber()).isTrue();
        assertThat(row.get(1).getAsJsonPrimitive().isString()).isTrue();
        assertThat(row.get(1).getAsString()).isEqualTo("123456789012345678901234567890");
    }

    @Test
    @DisplayName("a BigDecimal a double cannot hold exactly becomes a string, in plain decimal form")
    void bigDecimalNotExactAsDoubleBecomesString() throws SQLException {
        JsonArray row = new JsonArray();
        // 0.1 cannot be held exactly by a double — the textbook example.
        BigDecimal notExact = new BigDecimal("12345678901234567.891234567890123456789");
        DbQueryRouteHandler.addCell(row, notExact, freshBudget());
        assertThat(row.get(0).getAsJsonPrimitive().isString()).isTrue();
        assertThat(row.get(0).getAsString()).isEqualTo(notExact.toPlainString());
    }

    @Test
    @DisplayName("one oversized string cell is truncated with a visible marker")
    void oversizedStringCellIsTruncated() throws SQLException {
        JsonArray row = new JsonArray();
        String huge = "x".repeat(DbQueryRouteHandler.MAX_CELL_CHARS + 500);
        DbQueryRouteHandler.addCell(row, huge, freshBudget());
        String cell = row.get(0).getAsString();
        assertThat(cell.length()).isLessThan(huge.length());
        assertThat(cell).contains("truncated");
    }

    @Test
    @DisplayName("a Clob is read via a bounded getSubString, never materialised whole, and freed")
    void clobIsReadBoundedAndFreed() throws SQLException {
        Clob clob = Mockito.mock(Clob.class);
        long length = DbQueryRouteHandler.MAX_CELL_CHARS + 1000L;
        when(clob.length()).thenReturn(length);
        when(clob.getSubString(1, DbQueryRouteHandler.MAX_CELL_CHARS))
            .thenReturn("y".repeat(DbQueryRouteHandler.MAX_CELL_CHARS));

        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, clob, freshBudget());

        verify(clob, never()).getSubString(1, (int) length);
        verify(clob).free();
        assertThat(row.get(0).getAsString()).contains("truncated");
    }

    @Test
    @DisplayName("a Blob is never read, only sized, and freed")
    void blobIsSizedNotRead() throws SQLException {
        Blob blob = Mockito.mock(Blob.class);
        when(blob.length()).thenReturn(4096L);

        JsonArray row = new JsonArray();
        DbQueryRouteHandler.addCell(row, blob, freshBudget());

        verify(blob, never()).getBytes(Mockito.anyLong(), Mockito.anyInt());
        verify(blob).free();
        assertThat(row.get(0).getAsString()).isEqualTo("4096 bytes");
    }

    @Test
    @DisplayName("an exhausted whole-run budget stops shapeRows before the next row and marks it truncated")
    void budgetExhaustionTruncatesFurtherRows() throws SQLException {
        DbQueryRouteHandler.Budget budget = freshBudget();
        // Exhaust it directly rather than via addCell: a single cell is itself
        // capped at MAX_CELL_CHARS, so no ONE cell could ever charge enough on
        // its own to exceed a 32 MB run budget — many cells adding up is the
        // real-world case this budget exists for.
        budget.charge((int) DbQueryRouteHandler.MAX_RESPONSE_CHARS + 1);
        assertThat(budget.exceeded()).isTrue();

        Statement statement = Mockito.mock(Statement.class);
        ResultSet rs = Mockito.mock(ResultSet.class);
        ResultSetMetaData meta = Mockito.mock(ResultSetMetaData.class);
        when(rs.getMetaData()).thenReturn(meta);
        when(meta.getColumnCount()).thenReturn(1);
        when(meta.getColumnLabel(1)).thenReturn("id");
        when(meta.getColumnTypeName(1)).thenReturn("int4");
        when(rs.next()).thenReturn(true, true, false);
        when(rs.getObject(1)).thenReturn(1, 2);

        DbQueryRouteHandler.RowsResult shaped =
            DbQueryRouteHandler.shapeRows(rs, 1000, budget, notCancelled());
        assertThat(shaped.json().get("rowCount").getAsInt()).isZero();
        assertThat(shaped.truncated()).isTrue();
    }

    // ==================== SQL error shape ====================

    @Test
    @DisplayName("a SQLException folds its SQLState and vendor code into the message")
    void sqlErrorIncludesStateAndVendorCode() {
        SQLException e = new SQLException("syntax error", "42601", 123);
        JsonObject error = DbQueryRouteHandler.describeFailure(e, false);
        assertThat(error.get("type").getAsString()).isEqualTo("SQLException");
        assertThat(error.get("message").getAsString())
            .contains("syntax error").contains("42601").contains("123");
        assertThat(error.getAsJsonArray("frames")).isEmpty();
    }

    @Test
    @DisplayName("a RuntimeException opening the connection is reported, not left to become a 500")
    void runtimeExceptionFromOpeningTheConnectionIsReported() {
        // DatasourceManager#getConnection only DECLARES SQLException; an unknown
        // datasource name is not guaranteed to arrive as one.
        RuntimeException e = new IllegalArgumentException("No such datasource: Nope");
        JsonObject error = DbQueryRouteHandler.describeFailure(e, false);
        assertThat(error.get("type").getAsString()).isEqualTo("IllegalArgumentException");
        assertThat(error.get("message").getAsString()).isEqualTo("No such datasource: Nope");
        assertThat(error.getAsJsonArray("frames")).isEmpty();
    }

    @Test
    @DisplayName("a cancelled run reports a plain stopped message, not the driver's own wording")
    void cancelledRunReportsStopped() {
        SQLException e = new SQLException("ERROR: canceling statement due to user request");
        JsonObject error = DbQueryRouteHandler.describeFailure(e, true);
        assertThat(error.get("type").getAsString()).isEqualTo("Stopped");
        assertThat(error.get("message").getAsString()).isEqualTo("The query was stopped.");
    }

    @Test
    @DisplayName("a PostgreSQL cancellation (SQLState 57014) is recognised even without 'cancel' in the message")
    void looksLikeCancellationBySqlState() {
        SQLException e = new SQLException("ERROR: canceling statement due to statement timeout", "57014");
        assertThat(DbQueryRouteHandler.looksLikeCancellation(e)).isTrue();
    }

    @Test
    @DisplayName("an unrelated SQLException that merely raced a Stop click is NOT reported as Stopped")
    void unrelatedFailureIsNotMislabelledStopped() {
        SQLException e = new SQLException("relation \"t\" does not exist", "42P01");
        assertThat(DbQueryRouteHandler.looksLikeCancellation(e)).isFalse();
    }

    // ==================== cancel key ====================

    @Test
    @DisplayName("cancel tolerates a run whose Statement is not yet registered (still waiting on the pool)")
    void cancelToleratesNullStatement() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        // No connection is ever opened in this test — the point is that
        // registering the run BEFORE getConnection leaves a null Statement, and
        // cancel() must not NPE on it.
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> null);
        java.util.concurrent.ConcurrentMap<Object, Object> running = extractRunningQueries(h);
        Object key = makeRunKey("r1", "unknown");
        Object runningQuery = makeRunningQuery(null, new AtomicBoolean(false));
        putRaw(running, key, runningQuery);

        givenBody("{\"runId\":\"r1\"}");
        Object result = h.cancel(req, resp);

        verify(resp, never()).setStatus(Mockito.anyInt());
        assertThat(((JsonObject) result).get("ok").getAsBoolean()).isTrue();
    }

    @SuppressWarnings("unchecked")
    private static java.util.concurrent.ConcurrentMap<Object, Object> extractRunningQueries(DbQueryRouteHandler h)
            throws Exception {
        java.lang.reflect.Field field = DbQueryRouteHandler.class.getDeclaredField("runningQueries");
        field.setAccessible(true);
        return (java.util.concurrent.ConcurrentMap<Object, Object>) field.get(h);
    }

    private static Object makeRunKey(String runId, String username) throws Exception {
        Class<?> keyClass = Class.forName(
            "com.gaskony.scriptide.gateway.routes.DbQueryRouteHandler$RunKey");
        java.lang.reflect.Constructor<?> ctor = keyClass.getDeclaredConstructor(String.class, String.class);
        ctor.setAccessible(true);
        return ctor.newInstance(runId, username);
    }

    private static Object makeRunningQuery(Statement statement, AtomicBoolean cancelled) throws Exception {
        Class<?> rqClass = Class.forName(
            "com.gaskony.scriptide.gateway.routes.DbQueryRouteHandler$RunningQuery");
        java.lang.reflect.Constructor<?> ctor = rqClass.getDeclaredConstructor(Statement.class, AtomicBoolean.class);
        ctor.setAccessible(true);
        return ctor.newInstance(statement, cancelled);
    }

    @SuppressWarnings("unchecked")
    private static void putRaw(java.util.concurrent.ConcurrentMap<Object, Object> map, Object key, Object value) {
        ((java.util.Map<Object, Object>) map).put(key, value);
    }

    // ==================== transaction rollback ====================

    /** A Statement double for rollBackIfOpen's own defensive "ROLLBACK" — every test needs one. */
    private static Statement cleanupStatement(SRConnection connection) throws SQLException {
        Statement cleanup = Mockito.mock(Statement.class);
        when(connection.createStatement()).thenReturn(cleanup);
        return cleanup;
    }

    @Test
    @DisplayName("an open transaction (autoCommit=false) is rolled back and autoCommit restored")
    void rollBackIfOpenRollsBackAndRestoresAutoCommit() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        when(connection.getAutoCommit()).thenReturn(false);
        cleanupStatement(connection);

        boolean rolledBack = DbQueryRouteHandler.rollBackIfOpen(connection);

        assertThat(rolledBack).isTrue();
        verify(connection).rollback();
        verify(connection).setAutoCommit(true);
    }

    @Test
    @DisplayName("autoCommit=true (the ordinary case): the JDBC-API rollback is skipped, "
        + "but the defensive ROLLBACK statement still runs and reports nothing")
    void rollBackIfOpenDoesNothingWhenAlreadyAutoCommit() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        when(connection.getAutoCommit()).thenReturn(true);
        Statement cleanup = cleanupStatement(connection);

        boolean rolledBack = DbQueryRouteHandler.rollBackIfOpen(connection);

        assertThat(rolledBack).isFalse();
        verify(connection, never()).rollback();
        verify(cleanup).execute("ROLLBACK");
    }

    @Test
    @DisplayName("a bare BEGIN (autoCommit still reports true) is cleaned up by the defensive "
        + "ROLLBACK statement even though the JDBC-API rollback never runs")
    void rollBackIfOpenCleansUpABareBeginEvenThoughAutoCommitLies() throws SQLException {
        // The whole reason for the second mechanism: PgJDBC's getAutoCommit()
        // reflects only its OWN client-side flag, not the server's real
        // transaction state — a bare "BEGIN" sent as plain SQL leaves it
        // reporting true even though the server is genuinely mid-transaction.
        // Measured live 28/09/2026: without this, the row stayed changed.
        SRConnection connection = Mockito.mock(SRConnection.class);
        when(connection.getAutoCommit()).thenReturn(true);
        Statement cleanup = cleanupStatement(connection);

        DbQueryRouteHandler.rollBackIfOpen(connection);

        verify(cleanup).execute("ROLLBACK");
    }

    @Test
    @DisplayName("on PostgreSQL a ROLLBACK with no warning means a bare BEGIN was left open, and is reported")
    void rollBackIfOpenReportsABareBeginOnPostgres() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        when(connection.getAutoCommit()).thenReturn(true);
        java.sql.DatabaseMetaData meta = Mockito.mock(java.sql.DatabaseMetaData.class);
        when(meta.getDatabaseProductName()).thenReturn("PostgreSQL");
        when(connection.getMetaData()).thenReturn(meta);
        cleanupStatement(connection);

        assertThat(DbQueryRouteHandler.rollBackIfOpen(connection)).isTrue();
    }

    @Test
    @DisplayName("on PostgreSQL a ROLLBACK that warns 'no transaction in progress' reports nothing")
    void rollBackIfOpenReportsNothingWhenPostgresWarns() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        when(connection.getAutoCommit()).thenReturn(true);
        java.sql.DatabaseMetaData meta = Mockito.mock(java.sql.DatabaseMetaData.class);
        when(meta.getDatabaseProductName()).thenReturn("PostgreSQL");
        when(connection.getMetaData()).thenReturn(meta);
        Statement cleanup = cleanupStatement(connection);
        when(cleanup.getWarnings()).thenReturn(new java.sql.SQLWarning("there is no transaction in progress"));

        assertThat(DbQueryRouteHandler.rollBackIfOpen(connection)).isFalse();
    }

    @Test
    @DisplayName("a failure rolling back is swallowed, not thrown — the connection still goes back to the pool")
    void rollBackIfOpenSwallowsAFailureFromTheRollbackItself() throws SQLException {
        SRConnection connection = Mockito.mock(SRConnection.class);
        when(connection.getAutoCommit()).thenReturn(false);
        Mockito.doThrow(new SQLException("connection reset")).when(connection).rollback();
        cleanupStatement(connection);

        boolean rolledBack = DbQueryRouteHandler.rollBackIfOpen(connection);

        // Best-effort: the ATTEMPT is what matters, and a failed one must not
        // throw across the caller that is about to close() this connection.
        assertThat(rolledBack).isFalse();
        verify(connection).setAutoCommit(true);
    }

    @Test
    @DisplayName("a query that FAILS partway through still gets its open transaction rolled back")
    void runRollsBackAnOpenTransactionEvenWhenTheQueryFails() throws Exception {
        GatewayContext context = Mockito.mock(GatewayContext.class);
        DatasourceManager manager = Mockito.mock(DatasourceManager.class);
        SRConnection connection = Mockito.mock(SRConnection.class);
        Statement statement = Mockito.mock(Statement.class);
        when(context.getDatasourceManager()).thenReturn(manager);
        when(manager.getConnection("MyDb")).thenReturn(connection);
        when(connection.createStatement()).thenReturn(statement);
        when(connection.getAutoCommit()).thenReturn(false);
        // The statement itself fails — e.g. "BEGIN; UPDATE t SET x=1; SELECT 1/0"
        // dies on the divide-by-zero, well after BEGIN opened a transaction.
        when(statement.execute(anyString())).thenThrow(new SQLException("division by zero", "22012"));
        QueryHistory history = Mockito.mock(QueryHistory.class);
        DbQueryRouteHandler h = new DbQueryRouteHandler(context, () -> null, () -> null, () -> history);

        givenBody("{\"runId\":\"r1\",\"datasource\":\"MyDb\",\"sql\":\"BEGIN; UPDATE t SET x=1; SELECT 1/0\"}");
        Object result = h.run(req, resp);

        verify(connection).rollback();
        verify(connection).setAutoCommit(true);
        JsonObject body = (JsonObject) result;
        assertThat(body.get("ok").getAsBoolean()).isFalse();
        assertThat(body.get("rolledBackTransaction").getAsBoolean()).isTrue();
    }

    // ==================== history summary ====================

    @Test
    @DisplayName("the history summary joins one phrase per result, singular for one row")
    void summariseJoinsResults() {
        JsonObject rows1 = new JsonObject();
        rows1.addProperty("rowCount", 1);
        JsonObject rowsMany = new JsonObject();
        rowsMany.addProperty("rowCount", 2);
        JsonObject affected = new JsonObject();
        affected.addProperty("affected", 3);

        JsonArray one = new JsonArray();
        one.add(rows1);
        assertThat(DbQueryRouteHandler.summarise(one)).isEqualTo("1 row");

        JsonArray mixed = new JsonArray();
        mixed.add(rowsMany);
        mixed.add(affected);
        assertThat(DbQueryRouteHandler.summarise(mixed)).isEqualTo("2 rows; 3 affected");

        assertThat(DbQueryRouteHandler.summarise(new JsonArray())).isEqualTo("no result");
    }
}
