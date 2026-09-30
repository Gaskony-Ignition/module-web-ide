package com.gaskony.scriptide.gateway.routes;

import com.gaskony.scriptide.gateway.exec.ExecAudit;
import com.gaskony.scriptide.gateway.exec.ExecPolicy;
import com.gaskony.scriptide.gateway.history.QueryHistory;
import com.gaskony.scriptide.gateway.lang.DbSchema;
import com.gaskony.scriptide.gateway.security.SessionSecurity;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.inductiveautomation.ignition.common.datasource.DatasourceStatus;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.datasource.Datasource;
import com.inductiveautomation.ignition.gateway.datasource.DatasourceManager;
import com.inductiveautomation.ignition.gateway.datasource.SRConnection;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Instant;
import java.time.temporal.Temporal;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * The Database Query Browser: ad hoc SQL against a configured datasource, from
 * the browser rather than the console.
 *
 * <h2>Plain JDBC, not the execution service</h2>
 *
 * <p>A console run and a named-query test both go through {@code ExecutionService}
 * because the thing running is Jython, and Jython needs a private
 * {@code PySystemState} per run to keep one user's output out of another's. There
 * is no interpreter here — this handler opens a JDBC connection and drives
 * {@link Statement} directly — so that isolation problem does not exist, and the
 * only thing worth sharing with the console's path is the SAME gate: Administrator,
 * CSRF, and a live {@link ExecPolicy#executionEnabled()} check, because running SQL
 * by hand is exactly as much "arbitrary code execution" as running Jython by hand.
 * The concurrency limit is shared too — a {@link Semaphore} sized the same way
 * {@code ExecutionService} sizes its own pool, from {@code ExecPolicy.maxConcurrent()}
 * read once at construction.</p>
 *
 * <h2>No keyword sniffing</h2>
 *
 * <p>{@code statement.execute(sql)} then walking {@code getMoreResults()}/
 * {@code getUpdateCount()} is the JDBC-specified way to consume whatever a
 * statement produces — a {@code SELECT}, an {@code UPDATE}, a DDL statement, or a
 * batch of several separated by {@code ;} — without this handler ever having to
 * guess what kind of statement the user typed. Guessing from the first keyword is
 * both unreliable (a CTE starts with {@code WITH}) and unnecessary: the driver
 * already knows. Whether a {@code ;}-separated batch is accepted AT ALL is the
 * DRIVER's choice, not this handler's: PostgreSQL's simple query protocol allows
 * it, MySQL needs {@code allowMultiQueries} on the connection URL, and Oracle
 * rejects a trailing {@code ;} outright. This handler does not special-case any
 * of that — whatever the driver accepts, it forwards; whatever the driver refuses
 * comes back as an ordinary SQL error.</p>
 *
 * <h2>The run id is the CLIENT's, not the server's</h2>
 *
 * <p>This handler is synchronous — the HTTP response does not arrive until the
 * query finishes — so a server-minted run id would reach the browser too late to
 * be of any use to a Stop button clicked while the request is still in flight. The
 * client generates a UUID and sends it in the run request; this handler files the
 * running {@link Statement} under a {@link RunKey} for exactly as long as it is
 * running, and {@link #cancel} looks the same key up from the same session. A
 * different user presenting the same run id builds a different key and simply
 * finds nothing, which is the whole access check — there is no separate ownership
 * branch to get wrong.</p>
 *
 * <h2>Registered before the connection, not after</h2>
 *
 * <p>The {@link RunKey} is filed with a {@code null} {@link Statement} BEFORE
 * {@code getConnection} is even called, and {@link #cancel} tolerates a
 * {@code null} statement — it just sets the flag. A pool under load can make
 * {@code getConnection} itself the slow part, and a Stop clicked during that wait
 * has to do something: it cannot cancel a {@link Statement} that does not exist
 * yet, but it CAN make sure the run checks the flag the moment one does, and
 * aborts before ever calling {@code execute}.</p>
 *
 * <h2>Bounded, four ways</h2>
 *
 * <p>A row cap ({@link #clampRowCap}) bounds how many rows come back. A per-cell
 * character cap ({@link #MAX_CELL_CHARS}) bounds one oversized value (a CLOB, a
 * wide JSON column). A whole-run character budget ({@link #MAX_RESPONSE_CHARS})
 * bounds many merely-large cells adding up. A result-count cap
 * ({@link #MAX_RESULTS_PER_RUN}) bounds a batch that produces an unreasonable
 * number of separate results. Any of the last three stops the run early rather
 * than exhausting the Gateway's heap, and says so in the response
 * ({@code resultsTruncated}) rather than silently handing back less than it
 * looks like.</p>
 */
public final class DbQueryRouteHandler {

    private static final Logger logger = LoggerFactory.getLogger(DbQueryRouteHandler.class);

    /** Rows returned when the client does not ask for a specific cap. */
    static final int DEFAULT_ROW_CAP = 1000;

    /** No client request may raise the row cap above this, however it asks. */
    static final int MAX_ROW_CAP = 10_000;

    /** One cell's text is truncated (with a visible marker) above this length. */
    static final int MAX_CELL_CHARS = 16 * 1024;

    /** Total cell-text budget across every result in one run, before it stops early. */
    static final long MAX_RESPONSE_CHARS = 32L * 1024 * 1024;

    /** No run returns more than this many separate results (also the iteration cap). */
    static final int MAX_RESULTS_PER_RUN = 50;

    /** How many elements of a SQL {@code ARRAY} are previewed before "…". */
    private static final int MAX_ARRAY_PREVIEW_ELEMENTS = 50;

    /**
     * JavaScript's {@code Number.MAX_SAFE_INTEGER} (2^53 - 1). A {@code long} or
     * {@link BigInteger} outside this range is sent as a STRING, not a JSON
     * number — {@code JSON.parse} in the browser reads every number as a
     * float64, and a value this module can carry exactly in Java would silently
     * round in the one place a person actually reads it.
     */
    static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    private static final BigInteger MAX_SAFE_INTEGER_BIG = BigInteger.valueOf(MAX_SAFE_INTEGER);
    private static final BigInteger MIN_SAFE_INTEGER_BIG = MAX_SAFE_INTEGER_BIG.negate();

    private final GatewayContext context;
    private final Supplier<DbSchema> schemas;
    private final Supplier<ExecAudit> audits;
    private final Supplier<QueryHistory> histories;

    /**
     * Sized ONCE from {@code ExecPolicy.maxConcurrent()} at construction — the same
     * moment {@code ExecutionService} sizes its own pool from the same call. A
     * policy value read live elsewhere in this module cannot resize a
     * {@link Semaphore} after the fact; this bound only ever tightens or loosens on
     * the next module start, which is an acceptable trade for the alternative (no
     * bound moving live, no bound at all).
     */
    private final Semaphore concurrencyLimiter;

    /** Statements currently executing, keyed on the run id AND the user who started it. */
    private final ConcurrentMap<RunKey, RunningQuery> runningQueries = new ConcurrentHashMap<>();

    public DbQueryRouteHandler(GatewayContext context, Supplier<DbSchema> schemas,
                               Supplier<ExecAudit> audits, Supplier<QueryHistory> histories) {
        this.context = context;
        this.schemas = schemas;
        this.audits = audits;
        this.histories = histories;
        this.concurrencyLimiter = new Semaphore(ExecPolicy.maxConcurrent());
    }

    /**
     * A run's identity: WHO is running it, not just what they called it. A record
     * rather than {@code runId + ':' + username} — string concatenation with no
     * separator guarantee is how {@code ("ab", "c")} and {@code ("a", "bc")} become
     * the same key by accident; a record compares its fields, not a string built
     * from them.
     */
    private record RunKey(String runId, String username) {
    }

    /**
     * One statement in flight, and whether {@link #cancel} has already touched it.
     *
     * <p>{@code statement} is {@code null} from the moment a run is registered
     * until {@code getConnection} returns — see the class Javadoc on why the
     * registration happens first.</p>
     */
    private record RunningQuery(Statement statement, AtomicBoolean cancelled) {
    }

    /** A run's remaining cell-text budget, shared across every result it produces. */
    static final class Budget {
        private long remaining = MAX_RESPONSE_CHARS;

        boolean exceeded() {
            return remaining <= 0;
        }

        void charge(int chars) {
            remaining -= chars;
        }
    }

    // ==================== GET /api/db-queries/datasources ====================

    /** Every configured datasource, with its live status — an in-memory field read. */
    public Object datasources(RequestContext req, HttpServletResponse resp) {
        JsonArray out = new JsonArray();
        if (context != null) {
            try {
                DatasourceManager manager = context.getDatasourceManager();
                for (Datasource datasource : manager.getDatasources()) {
                    JsonObject row = new JsonObject();
                    row.addProperty("name", datasource.getName());
                    row.addProperty("status", statusOf(datasource));
                    out.add(row);
                }
            } catch (Exception e) {
                // A gateway with no datasource manager is not a reason to fail the
                // whole route — the picker just has nothing in it.
                logger.debug("Could not list datasources: {}", e.toString());
            }
        }
        JsonObject body = new JsonObject();
        body.add("datasources", out);
        return body;
    }

    private static String statusOf(Datasource datasource) {
        try {
            DatasourceStatus status = datasource.getStatus();
            return status == null ? "UNKNOWN" : status.name();
        } catch (Exception e) {
            return "UNKNOWN";
        }
    }

    // ==================== GET /api/db-queries/tables ====================

    /**
     * Table and view names in one datasource, for the schema tree.
     *
     * <p>{@code tablesDetailedNow}, not {@code tables} — this is a button
     * click, not a keystroke, so blocking on a cache miss is the right trade
     * here. See {@link DbSchema#tablesNow} for why the two behave differently:
     * the non-blocking path reported an empty tree for a datasource with 99
     * real tables, on the very first browse, and would keep doing so until
     * whatever ELSE happened to warm the shared completion cache first.</p>
     *
     * <p>A load failure is a 502 with the real message, not a 200 with an empty
     * list — an empty tree and a broken one must not look identical, and the
     * cache deliberately does not cache the failure either, so the very next
     * click can succeed once the transient problem clears.</p>
     *
     * <p>Each row carries its own {@code schema} (null when the driver does not
     * report one) and JDBC {@code type}, plus the connection facts a client
     * needs to decide whether a name must be qualified and whether it needs
     * quoting: the default schema, the identifier quote string, and which case
     * this database folds an unquoted identifier to.</p>
     */
    public Object tables(RequestContext req, HttpServletResponse resp) {
        String datasource = req.getParameter("datasource");
        if (datasource == null || datasource.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'datasource' parameter");
        }
        DbSchema schema = schemas.get();
        if (schema == null) {
            JsonObject body = new JsonObject();
            body.add("tables", new JsonArray());
            return body;
        }
        if ("1".equals(req.getParameter("fresh"))) {
            schema.invalidate(datasource);
        }
        try {
            DbSchema.TablesDetail detail = schema.tablesDetailedNow(datasource);
            JsonArray out = new JsonArray();
            for (DbSchema.TableInfo table : detail.tables()) {
                JsonObject row = new JsonObject();
                row.addProperty("schema", table.schema());
                row.addProperty("name", table.name());
                row.addProperty("type", table.type());
                out.add(row);
            }
            JsonObject body = new JsonObject();
            body.add("tables", out);
            if (detail.tables().size() >= DbSchema.MAX_SCHEMA_RESULTS) {
                body.addProperty("truncated", true);
            }
            DbSchema.ConnectionFacts facts = detail.facts();
            if (facts != null) {
                body.addProperty("defaultSchema", facts.defaultSchema());
                body.addProperty("identifierQuote", facts.identifierQuote());
                body.addProperty("storesLowerCaseIdentifiers", facts.storesLowerCaseIdentifiers());
                body.addProperty("storesUpperCaseIdentifiers", facts.storesUpperCaseIdentifiers());
                body.addProperty("databaseProductName", facts.databaseProductName());
            }
            return body;
        } catch (RuntimeException e) {
            logger.debug("Table list failed for datasource='{}': {}", datasource, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Could not read tables for '" + datasource + "': " + rootMessage(e));
        }
    }

    // ==================== GET /api/db-queries/columns ====================

    /**
     * Column name and type for one table, lazily loaded when the tree expands it.
     *
     * <p>{@code columnDetailsNow} — same reasoning as {@link #tables}: expanding
     * a table is a click, not a keystroke, and a load failure is surfaced rather
     * than cached as "no columns".</p>
     *
     * <p>{@code schema} is OPTIONAL — a caller browsing a datasource with a
     * single (or no) schema need not send it — and is escaped as a LIKE
     * pattern exactly like {@code table}, so a schema literally named e.g.
     * {@code a_b} does not also match {@code aXb}.</p>
     */
    public Object columns(RequestContext req, HttpServletResponse resp) {
        String datasource = req.getParameter("datasource");
        String table = req.getParameter("table");
        String tableSchema = req.getParameter("schema");
        if (datasource == null || datasource.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'datasource' parameter");
        }
        if (table == null || table.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Missing required 'table' parameter");
        }
        DbSchema schema = schemas.get();
        if (schema == null) {
            JsonObject body = new JsonObject();
            body.add("columns", new JsonArray());
            return body;
        }
        try {
            List<DbSchema.Column> columns = (tableSchema == null || tableSchema.isBlank())
                ? schema.columnDetailsNow(datasource, table)
                : schema.columnDetailsNow(datasource, tableSchema, table);
            JsonArray out = new JsonArray();
            for (DbSchema.Column column : columns) {
                JsonObject row = new JsonObject();
                row.addProperty("name", column.name());
                row.addProperty("type", column.type());
                out.add(row);
            }
            JsonObject body = new JsonObject();
            body.add("columns", out);
            if (columns.size() >= DbSchema.MAX_SCHEMA_RESULTS) {
                body.addProperty("truncated", true);
            }
            return body;
        } catch (RuntimeException e) {
            logger.debug("Column list failed for datasource='{}' table='{}': {}",
                datasource, table, e.toString());
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_GATEWAY,
                "Could not read columns for '" + table + "': " + rootMessage(e));
        }
    }

    private static String rootMessage(Throwable e) {
        Throwable root = e;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getMessage() == null ? root.getClass().getSimpleName() : root.getMessage();
    }

    // ==================== POST /api/db-queries/run ====================

    /**
     * Run one statement (or several, {@code ;}-separated, if the driver accepts a
     * batch that way) against a datasource and return every result it produces.
     *
     * <p>A SQL error is a 200 with {@code {ok:false, error}}, exactly like a failed
     * named-query test run — it is a result to render, not a transport failure. A
     * malformed request or a disabled execution policy is the ordinary
     * {@link HandlerSupport#error} shape instead, because those never reached a
     * database at all. Too many runs already in flight is a 409, for the same
     * reason {@code ExecutionService.RejectedException} is: a queue with no bound
     * is not a queue.</p>
     */
    public Object run(RequestContext req, HttpServletResponse resp) throws IOException {
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        // Re-checked HERE, per request, exactly as the named-query test route does:
        // the policy file is read live, so a gateway on which execution has just
        // been switched off must refuse the next call rather than the next restart.
        if (!ExecPolicy.executionEnabled()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_FORBIDDEN,
                "Script execution is disabled on this gateway (" + ExecPolicy.PROP_ENABLED
                    + "=false), and running a query here is the same kind of thing.");
        }

        RunRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), RunRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.runId == null || body.runId.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'runId'");
        }
        if (body.datasource == null || body.datasource.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'datasource'");
        }
        if (body.sql == null || body.sql.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain 'sql'");
        }
        if (context == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_SERVICE_UNAVAILABLE,
                "The module is shutting down.");
        }
        if (!concurrencyLimiter.tryAcquire()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_CONFLICT,
                "Too many queries are already running on this gateway; try again shortly.");
        }

        try {
            return runWithPermit(req, body);
        } finally {
            concurrencyLimiter.release();
        }
    }

    private Object runWithPermit(RequestContext req, RunRequest body) {
        int cap = clampRowCap(body.maxRows);
        String username = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse("unknown");

        ExecAudit audit = audits.get();
        if (audit != null) {
            // Before the run, so a query that hangs is still recorded — same
            // reasoning as the named-query test route.
            audit.record(username, req.getRequest().getRemoteAddr(),
                body.project == null ? "" : body.project, "db:" + body.datasource, body.sql);
        }

        RunKey key = new RunKey(body.runId, username);
        AtomicBoolean cancelled = new AtomicBoolean();
        // Registered BEFORE getConnection — see the class Javadoc. A Stop that
        // arrives while this is still waiting on the pool has nothing to call
        // .cancel() on yet, but it CAN set the flag, which is checked the moment
        // a Statement exists and again between every row/result after that.
        runningQueries.put(key, new RunningQuery(null, cancelled));

        long startedAt = System.nanoTime();
        long deadlineNanos = startedAt + TimeUnit.SECONDS.toNanos(ExecPolicy.timeoutSeconds());
        JsonObject out = new JsonObject();
        out.addProperty("runId", body.runId);
        AtomicBoolean finished = new AtomicBoolean();
        AtomicBoolean watchdogFired = new AtomicBoolean();
        boolean ok;
        boolean rolledBack = false;
        String errorForHistory = null;
        String summaryForHistory = null;
        try (SRConnection connection = context.getDatasourceManager().getConnection(body.datasource);
             Statement statement = connection.createStatement()) {
            runningQueries.put(key, new RunningQuery(statement, cancelled));
            if (cancelled.get()) {
                throw new SQLException("The query was stopped before it started.");
            }
            boolean readOnly = Boolean.TRUE.equals(body.readOnly);
            if (readOnly) {
                // An explicit transaction, always rolled back below. The read-only
                // flag alone did nothing on an autocommit PgJDBC connection
                // (measured 30/09/2026: a DELETE under it deleted); inside a
                // transaction Postgres and MySQL refuse writes, and the rollback
                // undoes DML on drivers that ignore the flag, such as SQL Server's.
                connection.setAutoCommit(false);
                setReadOnlyBestEffort(connection, true);
            }
            statement.setMaxRows(cap + 1);
            statement.setQueryTimeout((int) ExecPolicy.timeoutSeconds());
            scheduleWatchdog(statement, deadlineNanos, finished, watchdogFired, cancelled);
            String catalog = catalogOf(connection);

            try {
                RunResult shaped = runAndShape(statement, body.sql, cap, deadlineNanos, cancelled);
                if (cancelled.get()) {
                    // MySQL's SLEEP() and similar return normally when killed, so a
                    // Stop or the watchdog can end a run with no exception at all.
                    throw new SQLException("The query was stopped.", "57014");
                }
                out.addProperty("ok", true);
                out.addProperty("elapsedMs", elapsedMs(startedAt));
                out.add("results", shaped.results());
                if (shaped.truncated()) {
                    out.addProperty("resultsTruncated", true);
                }
                ok = true;
                summaryForHistory = summarise(shaped.results());
            } finally {
                finished.set(true);
                // Runs whether the query above succeeded or threw — a
                // statement that fails PART WAY through a transaction (a
                // "BEGIN; UPDATE ...; SELECT 1/0" batch, say) must not leave
                // it open for the next run to inherit either. This must be
                // an INNER try/finally, not the outer catch/finally below:
                // try-with-resources closes `connection` before THAT finally
                // runs, and by then there is nothing left to roll back.
                rolledBack = rollBackIfOpen(connection);
                // A read-only run is rolled back by design; that is not news.
                if (rolledBack && !readOnly) {
                    out.addProperty("rolledBackTransaction", true);
                }
                restoreCatalog(connection, catalog);
                setReadOnlyBestEffort(connection, false);
            }
        } catch (SQLException | RuntimeException e) {
            // RuntimeException as well as SQLException: DatasourceManager#getConnection
            // only DECLARES the checked one, but an unknown or misconfigured datasource
            // name is not guaranteed to arrive as SQLException — a lookup that fails
            // before any JDBC call is reached can throw unchecked instead. Either way
            // this is still the caller's own typo to see, not an unhandled 500.
            finished.set(true);
            boolean timedOut = watchdogFired.get()
                || (System.nanoTime() >= deadlineNanos - WATCHDOG_GRACE_NANOS && looksLikeCancellation(e));
            boolean wasCancelled = !timedOut && cancelled.get() && looksLikeCancellation(e);
            out.addProperty("ok", false);
            out.addProperty("elapsedMs", elapsedMs(startedAt));
            out.add("error", timedOut ? describeTimeout() : describeFailure(e, wasCancelled));
            ok = false;
            errorForHistory = e.getMessage();
        } finally {
            runningQueries.remove(key);
        }

        // recordHistory defaults true — only an EXPLICIT false (an auto-refresh
        // run) skips this write. The audit line above already ran regardless:
        // this flag only ever spares the per-user history list a flood of
        // near-duplicate entries, never the audit trail.
        boolean recordHistory = body.recordHistory == null || body.recordHistory;
        QueryHistory history = histories.get();
        if (history != null && recordHistory) {
            history.record(username, body.datasource, body.sql, ok, errorForHistory,
                summaryForHistory, elapsedMs(startedAt));
        }
        return out;
    }

    /**
     * A statement left an explicit transaction open (a bare {@code BEGIN}, or a
     * driver that defaults {@code autoCommit} off) rolls back here, before the
     * connection goes back to Ignition's shared pool — otherwise the NEXT run to
     * borrow this same pooled connection inherits somebody else's half-finished
     * transaction, and a row changed by an uncommitted {@code UPDATE} sits
     * invisible to every other session until whoever gets this connection next
     * happens to commit or roll it back themselves.
     *
     * <p>Returns whether a rollback was reported to have happened, so the caller
     * can tell the user — silently discarding a transaction they thought they
     * were building is the kind of thing that reads as data loss if it happens
     * without a word. This is best-effort, not exhaustive: see the note on the
     * bare-{@code BEGIN} case below.</p>
     *
     * <p><b>Two mechanisms, because one alone misses a real case.</b>
     * {@code connection.rollback()} only works — and only THROWS instead of
     * silently doing nothing — when the driver's own {@code autoCommit} flag
     * says {@code false}, which is true for {@code setAutoCommit(false)} but
     * proven FALSE for a bare {@code BEGIN} sent as plain SQL: PgJDBC tracks
     * {@code autoCommit} as its own client-side field, not the server's real
     * transaction state, so a batch that runs {@code BEGIN; UPDATE ...} with no
     * {@code COMMIT} leaves {@code getAutoCommit()} still reporting {@code true}
     * even though the SERVER is genuinely mid-transaction — measured live
     * 28/09/2026: the JDBC-API rollback alone left the row changed and would
     * have left the connection to just sit there until the pool eventually
     * recycled it. A plain {@code ROLLBACK} SQL statement does not have this
     * blind spot — it talks to the server directly, and is a harmless no-op
     * (a NOTICE on Postgres, not an error) when there was nothing open — so it
     * runs unconditionally, every time, for the SAFETY property (no session
     * survives with an open transaction). There is no portable way to ask a
     * JDBC connection whether the SERVER is mid-transaction, so a bare
     * {@code BEGIN} is reported only on PostgreSQL, which warns on a ROLLBACK
     * with nothing open; on other drivers it rolls back safely but silently.
     * Safety does not depend on the report being complete; only the UI notice
     * does.</p>
     *
     * <p>{@code autoCommit} is restored to {@code true} either way: that is the
     * state a freshly-borrowed connection is expected to be in, and leaving it
     * off would make the SAME surprise happen to whoever borrows this connection
     * next, just one step later.</p>
     */
    static boolean rollBackIfOpen(SRConnection connection) {
        boolean reportRollback = false;
        try {
            if (!connection.getAutoCommit()) {
                connection.rollback();
                reportRollback = true;
            }
        } catch (SQLException e) {
            logger.debug("Could not roll back an open transaction before returning the "
                + "connection to the pool: {}", e.toString());
            reportRollback = false;
        }
        try (Statement cleanup = connection.createStatement()) {
            // Unconditional, for the bare-BEGIN case the check above cannot see.
            cleanup.execute("ROLLBACK");
            // PostgreSQL answers a ROLLBACK with no transaction open with a "no
            // transaction in progress" warning, so no warning means the SQL left
            // one open. Other drivers are silent either way and are not reported.
            java.sql.DatabaseMetaData meta = connection.getMetaData();
            if (cleanup.getWarnings() == null && meta != null
                && "PostgreSQL".equals(meta.getDatabaseProductName())) {
                reportRollback = true;
            }
        } catch (SQLException e) {
            logger.debug("Defensive ROLLBACK before returning a connection to the pool "
                + "did not run (some drivers reject it outside a transaction): {}", e.toString());
        }
        try {
            connection.setAutoCommit(true);
        } catch (SQLException e) {
            logger.debug("Could not restore autoCommit=true on a pooled connection: {}",
                e.toString());
        }
        return reportRollback;
    }

    private static String catalogOf(SRConnection connection) {
        try {
            return connection.getCatalog();
        } catch (SQLException e) {
            logger.debug("Could not read the connection's catalog: {}", e.toString());
            return null;
        }
    }

    /**
     * Put the pooled connection back in the database it was borrowed in. A
     * {@code USE master} (SQL Server, MySQL) otherwise sticks to the pooled
     * connection, and the historian or a named query that borrows it next runs
     * against the wrong database — measured on SQL Server 2025, 8 of 8 later
     * borrows landed in master. Other session settings ({@code SET ...}) are
     * not undone; the CHANGELOG says so.
     */
    static void restoreCatalog(SRConnection connection, String catalog) {
        if (catalog == null) {
            return;
        }
        try {
            connection.setCatalog(catalog);
        } catch (SQLException | RuntimeException e) {
            logger.debug("Could not restore catalog '{}' on a pooled connection: {}", catalog, e.toString());
        }
    }

    /**
     * A best-effort hint, not a guarantee — see {@link RunRequest#readOnly}'s
     * Javadoc for what "best-effort" is measured to mean on THIS gateway's
     * Postgres driver right now (not much). Some drivers throw when asked to
     * change this mid-transaction or ignore it outright; either way this must
     * never fail the run, so any exception is logged at debug and swallowed,
     * exactly like {@link #restoreCatalog}.
     */
    private static void setReadOnlyBestEffort(SRConnection connection, boolean readOnly) {
        try {
            connection.setReadOnly(readOnly);
        } catch (SQLException | RuntimeException e) {
            logger.debug("Could not set readOnly={} on a pooled connection: {}", readOnly, e.toString());
        }
    }

    private static long elapsedMs(long startedAtNanos) {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    static int clampRowCap(Integer requested) {
        if (requested == null || requested <= 0) {
            return DEFAULT_ROW_CAP;
        }
        return Math.min(requested, MAX_ROW_CAP);
    }

    /** {@code runAndShape}'s answer: the results, and whether it stopped before producing all of them. */
    record RunResult(JsonArray results, boolean truncated) {
    }

    /**
     * Execute one statement and shape every result it produces.
     *
     * <p>The canonical JDBC idiom for consuming a statement's results without
     * knowing in advance what kind it is: {@code execute()} returns whether the
     * FIRST result is a {@link ResultSet}, and {@code getMoreResults()} plus
     * {@code getUpdateCount()} step through the rest. {@code getUpdateCount()}
     * returning {@code -1} is the only way JDBC says "no more results" — it is not
     * a sentinel this method invented.</p>
     *
     * <p>Three independent reasons this loop can stop before that: the
     * {@link #MAX_RESULTS_PER_RUN} count (also the hard iteration cap — a driver
     * that never returns {@code -1} cannot spin this forever), the whole-run
     * {@link Budget}, and {@code cancelled} — checked between every result and
     * every row, not only relied on to surface as an exception, so a Stop clicked
     * mid-batch stops the NEXT read rather than waiting for the driver to notice
     * on its own.</p>
     */
    static RunResult runAndShape(Statement statement, String sql, int cap, long deadlineNanos,
                                 AtomicBoolean cancelled) throws SQLException {
        JsonArray results = new JsonArray();
        Budget budget = new Budget();
        boolean truncated = false;
        boolean isResultSet = statement.execute(sql);
        int updateCount = statement.getUpdateCount();
        while (isResultSet || updateCount != -1) {
            if (cancelled.get()) {
                truncated = true;
                break;
            }
            if (results.size() >= MAX_RESULTS_PER_RUN) {
                truncated = true;
                break;
            }
            if (System.nanoTime() > deadlineNanos) {
                // Defence in depth over Statement#setQueryTimeout: that timer is
                // per JDBC call, and a multi-statement batch can walk through
                // several without any one of them individually running long
                // enough to trip it, while the RUN as a whole has. Cancel and
                // stop rather than let a thousand quick statements add up to an
                // unbounded wall-clock run.
                try {
                    statement.cancel();
                } catch (SQLException e) {
                    logger.debug("Could not cancel a statement past its overall deadline: {}",
                        e.toString());
                }
                cancelled.set(true);
                truncated = true;
                break;
            }
            if (isResultSet) {
                try (ResultSet rs = statement.getResultSet()) {
                    RowsResult shaped = shapeRows(rs, cap, budget, cancelled);
                    results.add(shaped.json());
                    if (shaped.truncated()) {
                        truncated = true;
                    }
                }
            } else {
                JsonObject affected = new JsonObject();
                affected.addProperty("affected", updateCount);
                results.add(affected);
            }
            if (budget.exceeded()) {
                truncated = true;
                break;
            }
            isResultSet = statement.getMoreResults();
            updateCount = statement.getUpdateCount();
        }
        return new RunResult(results, truncated);
    }

    /** {@link #shapeRows}'s answer: the shaped result, and whether IT (not the run) truncated something. */
    record RowsResult(JsonObject json, boolean truncated) {
    }

    /**
     * One result set as {@code {columns, rows, rowCount, truncatedAt?}}.
     *
     * <p>The statement's own {@code setMaxRows(cap + 1)} means the driver itself
     * never hands back more than {@code cap + 1} rows, so reading one row past the
     * cap is enough to know the true result was bigger — without ever loading all
     * of it into memory to count it.</p>
     */
    static RowsResult shapeRows(ResultSet rs, int cap, Budget budget, AtomicBoolean cancelled)
            throws SQLException {
        ResultSetMetaData meta = rs.getMetaData();
        int width = meta.getColumnCount();
        JsonArray columns = new JsonArray();
        for (int i = 1; i <= width; i++) {
            JsonObject column = new JsonObject();
            // Label, not name: an aliased column (`SELECT x AS y`) is what the
            // user asked to see it called, and getColumnName ignores the alias.
            column.addProperty("name", meta.getColumnLabel(i));
            column.addProperty("type", meta.getColumnTypeName(i));
            columns.add(column);
        }

        JsonArray rows = new JsonArray();
        int read = 0;
        boolean stoppedEarly = false;
        while (rs.next()) {
            read++;
            if (read > cap) {
                // The one extra row setMaxRows(cap + 1) allowed through, read only
                // to prove there was more — never added to the payload.
                break;
            }
            if (cancelled.get() || budget.exceeded()) {
                stoppedEarly = true;
                break;
            }
            JsonArray row = new JsonArray();
            for (int i = 1; i <= width; i++) {
                addCell(row, readCell(rs, meta, i), budget);
            }
            rows.add(row);
        }

        JsonObject out = new JsonObject();
        out.add("columns", columns);
        out.add("rows", rows);
        out.addProperty("rowCount", rows.size());
        boolean truncated = read > cap || stoppedEarly;
        if (truncated) {
            out.addProperty("truncatedAt", rows.size());
        }
        return new RowsResult(out, truncated);
    }

    /**
     * One cell, shaped for the wire.
     *
     * <p>{@code null}, booleans and small numbers pass through untouched. A
     * {@link Long} or {@link BigInteger} outside JavaScript's safe-integer range,
     * and a {@link BigDecimal} a {@code double} cannot hold exactly, are sent as
     * STRINGS rather than JSON numbers — see {@link #MAX_SAFE_INTEGER}'s Javadoc.
     * A non-finite {@code double}/{@code float} ({@code NaN}, {@code Infinity})
     * is also sent as a string: Gson's own writer refuses to serialise those as
     * JSON numbers at all (JSON has no token for either), so leaving them as a
     * {@link Number} would fail the WHOLE response, not just this cell.</p>
     *
     * <p>Text, a {@link Clob}, and a SQL {@code ARRAY} preview are all bounded to
     * {@link #MAX_CELL_CHARS} with a visible "truncated" marker — one oversized
     * value must not be able to blow the response past the whole-run
     * {@link Budget} on its own. A {@link Blob} is never materialised at all;
     * only its length is read, the same treatment {@code byte[]} already got.</p>
     */
    /**
     * {@code getObject} for every column except {@code TIME}: that comes back as
     * {@link java.sql.Time}, which cannot hold fractions of a second, so a MySQL
     * {@code TIME(3)} of {@code 13:45:30.500} would render as {@code 13:45:30}.
     * Asking for a {@code LocalTime} keeps them. A zoned timestamp (SQL Server's
     * {@code DATETIMEOFFSET}) is read as an {@code OffsetDateTime} so it renders
     * as ISO-8601 rather than the driver's own toString. A driver that cannot answer
     * falls back to the plain read.
     */
    /** PostgreSQL's pgjdbc reports timestamptz as plain TIMESTAMP; its type name says otherwise. */
    static boolean isZonedTypeName(String typeName) {
        if (typeName == null) {
            return false;
        }
        String lower = typeName.toLowerCase();
        return lower.contains("tz") || lower.contains("time zone") || lower.contains("offset");
    }

    /** mssql-jdbc's vendor type code for DATETIMEOFFSET (microsoft.sql.Types.DATETIMEOFFSET). */
    static final int MSSQL_DATETIMEOFFSET = -155;

    static Object readCell(ResultSet rs, ResultSetMetaData meta, int column) throws SQLException {
        int type = meta.getColumnType(column);
        if (type == java.sql.Types.TIME) {
            try {
                return rs.getObject(column, java.time.LocalTime.class);
            } catch (SQLException | RuntimeException | AbstractMethodError e) {
                logger.debug("Driver cannot read TIME as LocalTime: {}", e.toString());
            }
        } else if (type == java.sql.Types.TIMESTAMP && !isZonedTypeName(meta.getColumnTypeName(column))) {
            // A timestamp without a zone is a wall-clock value. Read as a
            // Timestamp it would be pinned to the gateway's zone and shown as
            // UTC with a Z; MariaDB's driver does that for MySQL DATETIME.
            try {
                return rs.getObject(column, java.time.LocalDateTime.class);
            } catch (SQLException | RuntimeException | AbstractMethodError e) {
                logger.debug("Driver cannot read TIMESTAMP as LocalDateTime: {}", e.toString());
            }
        } else if (type == java.sql.Types.TIMESTAMP_WITH_TIMEZONE || type == MSSQL_DATETIMEOFFSET) {
            try {
                return rs.getObject(column, java.time.OffsetDateTime.class);
            } catch (SQLException | RuntimeException | AbstractMethodError e) {
                logger.debug("Driver cannot read a zoned timestamp as OffsetDateTime: {}", e.toString());
            }
        }
        return rs.getObject(column);
    }

    static void addCell(JsonArray row, Object value, Budget budget) throws SQLException {
        if (value == null) {
            row.add(JsonNull.INSTANCE);
        } else if (value instanceof Boolean b) {
            row.add(b);
            budget.charge(5);
        } else if (value instanceof Double d) {
            if (d.isNaN() || d.isInfinite()) {
                addText(row, d.toString(), budget);
            } else {
                row.add(d);
                budget.charge(24);
            }
        } else if (value instanceof Float f) {
            if (f.isNaN() || f.isInfinite()) {
                addText(row, f.toString(), budget);
            } else {
                row.add(f);
                budget.charge(16);
            }
        } else if (value instanceof Long l) {
            if (l > MAX_SAFE_INTEGER || l < -MAX_SAFE_INTEGER) {
                addText(row, l.toString(), budget);
            } else {
                row.add(l);
                budget.charge(20);
            }
        } else if (value instanceof BigInteger big) {
            if (big.compareTo(MAX_SAFE_INTEGER_BIG) > 0 || big.compareTo(MIN_SAFE_INTEGER_BIG) < 0) {
                addText(row, big.toString(), budget);
            } else {
                row.add(big);
                budget.charge(24);
            }
        } else if (value instanceof BigDecimal bd) {
            // Exact round trip through a double is the test: a value THAT survives
            // it can be sent as a JSON number with nothing lost; one that does not
            // must be sent as text, or the browser's JSON.parse silently rounds it
            // the same way toDouble() just proved would lose precision.
            boolean exactAsDouble = new BigDecimal(bd.doubleValue()).compareTo(bd) == 0;
            if (exactAsDouble) {
                row.add(bd);
                budget.charge(bd.precision() + 4);
            } else {
                addText(row, bd.toPlainString(), budget);
            }
        } else if (value instanceof Number n) {
            // Integer, Short, Byte and any vendor Number this module has not seen
            // before — all comfortably inside a double's exact-integer range.
            row.add(n);
            budget.charge(n.toString().length());
        } else if (value instanceof byte[] bytes) {
            addText(row, bytes.length + " bytes", budget);
        } else if (value instanceof Blob blob) {
            long length;
            try {
                length = blob.length();
            } finally {
                try {
                    blob.free();
                } catch (SQLException | AbstractMethodError ignored) {
                    // free() is optional per the JDBC spec; some drivers omit it.
                }
            }
            addText(row, length + " bytes", budget);
        } else if (value instanceof Clob clob) {
            // NOT addText()/boundText() — readBounded() already applied the SAME
            // MAX_CELL_CHARS cap and its own marker while reading the Clob; running
            // that result through boundText() again would re-truncate an
            // already-at-the-cap string and splice a second, wrong-count marker
            // into the middle of the first one.
            String text = readBounded(clob);
            row.add(text);
            budget.charge(text.length());
        } else if (value instanceof java.sql.Array array) {
            addText(row, previewArray(array), budget);
        } else if (value instanceof java.sql.Timestamp ts) {
            // toInstant() keeps sub-millisecond precision a Timestamp can carry
            // (getNanos()); converting through epoch millis the way a plain
            // java.util.Date does below would silently drop it.
            addText(row, ts.toInstant().toString(), budget);
        } else if (value instanceof java.sql.Date date) {
            // A DATE column has no time component; toLocalDate() reads the
            // driver's own local fields rather than converting an epoch-millis
            // "local midnight" through UTC, which shifts the date near midnight
            // in any timezone other than UTC.
            addText(row, date.toLocalDate().toString(), budget);
        } else if (value instanceof java.sql.Time time) {
            addText(row, time.toLocalTime().toString(), budget);
        } else if (value instanceof java.util.Date date) {
            addText(row, Instant.ofEpochMilli(date.getTime()).toString(), budget);
        } else if (value instanceof Temporal t) {
            // OffsetDateTime, LocalDateTime, etc., for a driver that hands one
            // back from getObject() directly — every java.time type's toString()
            // is already ISO-8601.
            addText(row, t.toString(), budget);
        } else {
            addText(row, value.toString(), budget);
        }
    }

    /** Add a string cell, bounded to {@link #MAX_CELL_CHARS} with a visible marker, and charge the budget. */
    private static void addText(JsonArray row, String text, Budget budget) {
        String bounded = boundText(text);
        row.add(bounded);
        budget.charge(bounded.length());
    }

    private static String boundText(String text) {
        if (text.length() <= MAX_CELL_CHARS) {
            return text;
        }
        return text.substring(0, MAX_CELL_CHARS) + "… (truncated, " + text.length() + " chars total)";
    }

    /** A CLOB's text, read via a BOUNDED getSubString — never the whole thing for an oversized one. */
    private static String readBounded(Clob clob) throws SQLException {
        try {
            long length = clob.length();
            int take = (int) Math.min(length, MAX_CELL_CHARS);
            String text = take <= 0 ? "" : clob.getSubString(1, take);
            return length > MAX_CELL_CHARS ? text + "… (truncated, " + length + " chars total)" : text;
        } finally {
            try {
                clob.free();
            } catch (SQLException | AbstractMethodError ignored) {
                // free() is optional per the JDBC spec; some drivers omit it.
            }
        }
    }

    /**
     * A SQL {@code ARRAY}, previewed rather than materialised — {@code getArray()}
     * would pull every element into a Java array before this method ever saw it,
     * which is exactly the unbounded read this route exists to avoid.
     * {@code getResultSet()} streams instead, so this reads at most
     * {@link #MAX_ARRAY_PREVIEW_ELEMENTS} rows off the wire before it stops
     * asking for more, however large the array actually is.
     */
    private static String previewArray(java.sql.Array array) throws SQLException {
        try (ResultSet elements = array.getResultSet()) {
            List<String> preview = new ArrayList<>();
            boolean more = false;
            while (elements.next()) {
                if (preview.size() < MAX_ARRAY_PREVIEW_ELEMENTS) {
                    // Column 2 is the element value; column 1 is its index — the
                    // shape java.sql.Array#getResultSet() is specified to return.
                    preview.add(String.valueOf(elements.getObject(2)));
                } else {
                    more = true;
                    break;
                }
            }
            return "[" + String.join(", ", preview) + (more ? ", …" : "") + "]";
        } finally {
            try {
                array.free();
            } catch (SQLException | AbstractMethodError ignored) {
                // free() is optional per the JDBC spec; some drivers omit it.
            }
        }
    }

    /** {@code "2 rows"}, {@code "3 affected"}, joined when a batch produced several. */
    static String summarise(JsonArray results) {
        List<String> parts = new ArrayList<>();
        for (JsonElement element : results) {
            JsonObject result = element.getAsJsonObject();
            if (result.has("affected")) {
                parts.add(result.get("affected").getAsInt() + " affected");
            } else if (result.has("rowCount")) {
                int rowCount = result.get("rowCount").getAsInt();
                parts.add(rowCount + (rowCount == 1 ? " row" : " rows"));
            }
        }
        return parts.isEmpty() ? "no result" : String.join("; ", parts);
    }

    /**
     * Whether a failure actually looks like the cancellation {@code cancelled}
     * records, rather than an unrelated error that happened to arrive after a
     * Stop was clicked. {@code null} (this handler's own "stopped before it
     * started" case, thrown with no SQLState at all) counts; a real driver
     * cancellation is SQLState {@code 57014} on PostgreSQL, and most others put
     * the word "cancel" in the message somewhere. Anything else that raced a
     * Stop is reported as whatever it actually was, not relabelled "Stopped".
     */
    static boolean looksLikeCancellation(Exception e) {
        if (!(e instanceof SQLException sql)) {
            return false;
        }
        // 57014 PostgreSQL, HY008 SQL Server / the JDBC timeout state.
        if ("57014".equals(sql.getSQLState()) || "HY008".equals(sql.getSQLState())) {
            return true;
        }
        String message = sql.getMessage();
        if (message == null) {
            return false;
        }
        String lower = message.toLowerCase();
        return lower.contains("cancel") || lower.contains("timed out") || lower.contains("interrupted");
    }

    /**
     * Lets the driver's own {@code setQueryTimeout} fire first where it works, so
     * the watchdog only acts where it didn't.
     */
    static final long WATCHDOG_GRACE_NANOS = TimeUnit.SECONDS.toNanos(2);

    /**
     * Cancel the statement at the run's deadline, whatever the driver does with
     * {@code setQueryTimeout}. The MariaDB driver against a MySQL server does not
     * enforce it: measured 29/09/2026, a {@code SLEEP(65)} under a 60 s limit ran
     * the full 65 s and came back as a success.
     */
    static void scheduleWatchdog(Statement statement, long deadlineNanos, AtomicBoolean finished,
                                 AtomicBoolean fired, AtomicBoolean cancelled) {
        long delay = Math.max(0, deadlineNanos - System.nanoTime()) + WATCHDOG_GRACE_NANOS;
        CompletableFuture.runAsync(() -> {
            if (finished.get()) {
                return;
            }
            fired.set(true);
            cancelled.set(true);
            try {
                statement.cancel();
            } catch (SQLException | RuntimeException e) {
                logger.debug("Watchdog could not cancel a statement past its deadline: {}", e.toString());
            }
        }, CompletableFuture.delayedExecutor(delay, TimeUnit.NANOSECONDS));
    }

    static JsonObject describeTimeout() {
        String message = "The query ran past the " + ExecPolicy.timeoutSeconds()
            + " s limit and was stopped (" + ExecPolicy.PROP_TIMEOUT_SECONDS + ").";
        JsonObject error = new JsonObject();
        error.addProperty("type", "TimedOut");
        error.addProperty("message", message);
        error.addProperty("rendered", message);
        error.add("frames", new JsonArray());
        return error;
    }

    /**
     * An {@code ExecError}-shaped failure: {@code type}, {@code message},
     * {@code rendered}, an empty {@code frames} — the same fields the console's
     * Traceback component already knows how to render, so a failure needs no
     * second renderer. SQLState and the vendor code are folded into the message
     * rather than sent as new fields, which is what makes this compatible with a
     * component that has never heard of either.
     *
     * <p>Takes any {@link Exception}, not just {@link SQLException}: opening the
     * connection itself can throw unchecked for a datasource name that does not
     * exist, and that is reported the same way rather than as an unhandled 500 —
     * see the catch block in {@link #runWithPermit}.</p>
     */
    static JsonObject describeFailure(Exception e, boolean wasCancelled) {
        JsonObject error = new JsonObject();
        if (wasCancelled) {
            error.addProperty("type", "Stopped");
            error.addProperty("message", "The query was stopped.");
            error.addProperty("rendered", "The query was stopped.");
            error.add("frames", new JsonArray());
            return error;
        }
        if (e instanceof SQLException sql) {
            String message = sql.getMessage() == null ? sql.getClass().getSimpleName() : sql.getMessage();
            String full = message + " (SQLState " + (sql.getSQLState() == null ? "none" : sql.getSQLState())
                + ", error code " + sql.getErrorCode() + ")";
            error.addProperty("type", "SQLException");
            error.addProperty("message", full);
            error.addProperty("rendered", full);
            error.add("frames", new JsonArray());
            return error;
        }
        String message = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        error.addProperty("type", e.getClass().getSimpleName());
        error.addProperty("message", message);
        error.addProperty("rendered", message);
        error.add("frames", new JsonArray());
        return error;
    }

    // ==================== POST /api/db-queries/cancel ====================

    /** Stop one in-flight run. Only the user who started it may cancel it. */
    public Object cancel(RequestContext req, HttpServletResponse resp) throws IOException {
        Object csrf = HandlerSupport.enforceCsrf(req, resp);
        if (csrf != null) {
            return csrf;
        }
        CancelRequest body;
        try {
            body = HandlerSupport.GSON.fromJson(req.readBody(), CancelRequest.class);
        } catch (JsonParseException e) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Malformed JSON request body");
        }
        if (body == null || body.runId == null || body.runId.isBlank()) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_BAD_REQUEST,
                "Request body must contain a 'runId'");
        }
        String username = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse("unknown");
        // Keyed the same way it was filed: a different user presenting the same
        // run id builds a different RunKey and finds nothing here, rather than
        // needing a separate ownership check that could be forgotten.
        RunningQuery running = runningQueries.get(new RunKey(body.runId, username));
        if (running == null) {
            return HandlerSupport.error(resp, HttpServletResponse.SC_NOT_FOUND,
                "No such run, or it has already finished");
        }
        running.cancelled().set(true);
        Statement statement = running.statement();
        if (statement != null) {
            try {
                statement.cancel();
            } catch (SQLException e) {
                logger.debug("Statement.cancel() failed for run {}: {}", body.runId, e.toString());
            }
        }
        // A null statement means the run is still waiting on getConnection() — the
        // flag alone is enough there; runWithPermit checks it before ever calling
        // execute().
        JsonObject out = new JsonObject();
        out.addProperty("ok", true);
        return out;
    }

    // ==================== GET /api/db-queries/history ====================

    /** This user's past ad hoc queries, newest first. */
    public Object history(RequestContext req, HttpServletResponse resp) {
        String username = SessionSecurity.authenticatedUser(req)
            .map(u -> u.getUserName())
            .orElse(null);
        JsonArray items = new JsonArray();
        QueryHistory history = histories.get();
        if (username != null && !username.isBlank() && history != null) {
            for (QueryHistory.Entry entry : history.list(username)) {
                JsonObject item = new JsonObject();
                item.addProperty("id", entry.id());
                item.addProperty("at", entry.at());
                item.addProperty("datasource", entry.datasource());
                item.addProperty("sql", entry.sql());
                item.addProperty("ok", entry.ok());
                item.addProperty("summary", entry.summary());
                item.addProperty("durationMs", entry.durationMs());
                if (entry.error() != null) {
                    item.addProperty("error", entry.error());
                }
                items.add(item);
            }
        }
        JsonObject out = new JsonObject();
        out.add("runs", items);
        out.addProperty("maxRuns", QueryHistory.MAX_QUERIES);
        return out;
    }

    /** Body of a run: {@code {runId, datasource, sql, maxRows?, project?, recordHistory?, readOnly?}}. */
    static final class RunRequest {
        String runId;
        String datasource;
        String sql;
        Integer maxRows;
        String project;
        /**
         * Default {@code true}. An auto-refresh run sends {@code false} so
         * re-running the same SELECT every few seconds does not flood the
         * per-user history with near-duplicate entries — but the run is still
         * AUDITED either way (see {@link #runWithPermit}): this flag only ever
         * skips the local history write, never the audit trail.
         */
        Boolean recordHistory;
        /**
         * Default {@code false}. Auto-refresh always sends {@code true}: the run
         * happens inside an explicit read-only transaction that is always rolled
         * back, so a repeated query cannot change data even when it is a write
         * the client took for a read ({@code DELETE ... RETURNING}). DDL that a
         * database auto-commits (MySQL, Oracle) and sequence increments are the
         * limits of this.
         */
        Boolean readOnly;
    }

    /** Body of a cancel: {@code {runId}}. */
    static final class CancelRequest {
        String runId;
    }
}
