package com.gaskony.scriptide.gateway.lang;

import com.inductiveautomation.ignition.gateway.datasource.Datasource;
import com.inductiveautomation.ignition.gateway.datasource.DatasourceManager;
import com.inductiveautomation.ignition.gateway.datasource.SRConnection;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

/**
 * {@link DbSchema} backed by the real {@link DatasourceManager} and JDBC
 * {@link DatabaseMetaData}.
 *
 * <p>Every method opens a JDBC connection, so every method is cached (see
 * {@link TtlCache}) and NEVER on the thread that asked for a completion — a
 * keystroke typed inside a SQL string must not wait on a database round trip.
 * A cache miss schedules the read on {@code refreshExecutor} and answers
 * empty for THAT keystroke; the next completion request for the same key
 * sees whatever the background read produced.</p>
 *
 * <p>Table and column NAMES only, never a row of data — see {@link DbSchema}'s
 * own Javadoc on why every table/every datasource is asked rather than one
 * guessed connection. {@link #tables} asks for both {@code TABLE} and
 * {@code VIEW}, because a view answers a query exactly like a table does and
 * is how people actually write SQL against one.</p>
 */
public final class SdkDbSchema implements DbSchema {

    private static final Logger logger = LoggerFactory.getLogger(SdkDbSchema.class);

    /** Schema changes far less often than a tag tree, hence the longer TTL. */
    private static final long SCHEMA_TTL_MILLIS = 300_000;

    private static final int MAX_CACHE_ENTRIES = 200;

    /** How long a metadata call may block the driver's socket before giving up. */
    private static final int METADATA_TIMEOUT_SECONDS = 30;

    private static final String[] TABLE_TYPES = {"TABLE", "VIEW"};

    private static final String DATASOURCES_KEY = "datasources";

    private final DatasourceManager datasourceManager;
    private final Executor refreshExecutor;
    private final TtlCache<List<String>> datasourcesCache;
    private final TtlCache<List<String>> tablesCache;
    private final TtlCache<List<Column>> columnsCache;
    /** The Query Browser's schema tree — schema-qualified tables plus connection facts. */
    private final TtlCache<TablesDetail> tablesDetailCache;

    /**
     * A metadata read failed. Thrown, never swallowed into an empty list — see
     * {@link DbSchema#tablesNow}'s Javadoc on why a load failure must not be
     * cached as an empty success. {@link TtlCache#get}'s background path already
     * catches {@link RuntimeException} and simply leaves the cache un-warmed
     * (logged, not surfaced) since nothing is synchronously waiting on it there;
     * {@link TtlCache#getOrLoadNow} lets it propagate to the caller, who IS
     * waiting on it.
     */
    static final class SchemaLoadException extends RuntimeException {
        SchemaLoadException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public SdkDbSchema(DatasourceManager datasourceManager, Executor refreshExecutor) {
        this.datasourceManager = datasourceManager;
        this.refreshExecutor = refreshExecutor;
        // Cap of 1: there is exactly one datasources() answer per gateway.
        this.datasourcesCache = new TtlCache<>(SCHEMA_TTL_MILLIS, 1, System::currentTimeMillis, refreshExecutor);
        this.tablesCache =
            new TtlCache<>(SCHEMA_TTL_MILLIS, MAX_CACHE_ENTRIES, System::currentTimeMillis, refreshExecutor);
        this.columnsCache =
            new TtlCache<>(SCHEMA_TTL_MILLIS, MAX_CACHE_ENTRIES, System::currentTimeMillis, refreshExecutor);
        // Cap MAX_CACHE_ENTRIES: one entry per datasource, same reasoning as
        // datasourcesCache scaled up — a gateway with many connections should
        // not evict its own tree cache before every one of them has a chance
        // to be cached.
        this.tablesDetailCache =
            new TtlCache<>(SCHEMA_TTL_MILLIS, MAX_CACHE_ENTRIES, System::currentTimeMillis, refreshExecutor);
    }

    @Override
    public List<String> datasources() {
        return datasourcesCache.get(DATASOURCES_KEY, this::loadDatasources).orElse(List.of());
    }

    private List<String> loadDatasources() {
        List<String> names = new ArrayList<>();
        for (Datasource ds : datasourceManager.getDatasources()) {
            names.add(ds.getName());
        }
        return names;
    }

    @Override
    public List<String> tables(String datasource) {
        return tablesCache.get(datasource, () -> loadTables(datasource)).orElse(List.of());
    }

    @Override
    public List<String> tablesNow(String datasource) {
        return tablesCache.getOrLoadNow(datasource, () -> loadTables(datasource));
    }

    private List<String> loadTables(String datasource) {
        List<String> names = new ArrayList<>();
        try (SRConnection connection = datasourceManager.getConnection(datasource)) {
            Integer previousTimeout = trySetNetworkTimeout(connection);
            try {
                DatabaseMetaData meta = connection.getMetaData();
                // The connection's own catalog, not null: null searches every catalog
                // the user can see, which on MySQL mixes other databases' tables in.
                try (ResultSet rs = meta.getTables(connection.getCatalog(), null, "%", TABLE_TYPES)) {
                    while (rs.next() && names.size() < DbSchema.MAX_SCHEMA_RESULTS) {
                        String name = rs.getString("TABLE_NAME");
                        if (name != null && !isSystemSchema(rs.getString("TABLE_SCHEM"))) {
                            names.add(name);
                        }
                    }
                }
            } finally {
                restoreNetworkTimeout(connection, previousTimeout);
            }
        } catch (SQLException e) {
            throw new SchemaLoadException(
                "Could not read tables for datasource '" + datasource + "': " + e.getMessage(), e);
        }
        return names;
    }

    /**
     * SQL Server reports its {@code sys} and {@code INFORMATION_SCHEMA} catalog
     * views as ordinary VIEWs — measured on SQL Server 2025, they were 499 of the
     * 500 names in the tree. PostgreSQL types its own as SYSTEM VIEW and MySQL
     * keeps them in a separate catalog, so neither needs this, but the check is
     * harmless there.
     */
    static boolean isSystemSchema(String schema) {
        return schema != null && (schema.equalsIgnoreCase("sys")
            || schema.equalsIgnoreCase("information_schema")
            || schema.equalsIgnoreCase("pg_catalog"));
    }

    /**
     * Bounds how long a metadata call may block on the driver's socket, where the
     * driver implements it — {@code setNetworkTimeout} is optional per the JDBC
     * spec, so a driver without it just keeps today's behaviour (unbounded,
     * caught only by whatever the OS socket default is).
     *
     * <p>Returns the timeout it replaced, or null if it set nothing. The caller
     * MUST restore it: the connection goes back to Ignition's shared pool, and a
     * 30-second socket timeout left on it killed every later query over 30 s on
     * that connection — the historian's, a named query's — with a link failure
     * (measured on PostgreSQL and MySQL, 29/09/2026).</p>
     */
    Integer trySetNetworkTimeout(SRConnection connection) {
        try {
            int previous = connection.getNetworkTimeout();
            connection.setNetworkTimeout(refreshExecutor,
                (int) TimeUnit.SECONDS.toMillis(METADATA_TIMEOUT_SECONDS));
            return previous;
        } catch (SQLException | RuntimeException | AbstractMethodError e) {
            logger.debug("Driver does not support a bounded network timeout: {}", e.toString());
            return null;
        }
    }

    void restoreNetworkTimeout(SRConnection connection, Integer previous) {
        if (previous == null) {
            return;
        }
        try {
            connection.setNetworkTimeout(refreshExecutor, previous);
        } catch (SQLException | RuntimeException | AbstractMethodError e) {
            // Leaving the 30 s timeout on a pooled connection is the bug this
            // exists to prevent, so a failure here is worth a warning.
            logger.warn("Could not restore the network timeout on a pooled connection: {}", e.toString());
        }
    }

    @Override
    public List<String> columns(String datasource, String table) {
        return columnDetails(datasource, table).stream().map(Column::name).toList();
    }

    @Override
    public void invalidate(String datasource) {
        tablesCache.invalidateIf(datasource::equals);
        tablesDetailCache.invalidateIf(datasource::equals);
        String prefix = datasource + '.';
        columnsCache.invalidateIf(key -> key.startsWith(prefix));
    }

    @Override
    public TablesDetail tablesDetailedNow(String datasource) {
        return tablesDetailCache.getOrLoadNow(datasource, () -> loadTablesDetail(datasource));
    }

    /**
     * One JDBC connection answers both halves of {@link TablesDetail} — a
     * second connection just to read {@code getSchema()}/{@code getMetaData()}
     * facts would double the round trips for information the table read
     * already has the connection open for.
     */
    private TablesDetail loadTablesDetail(String datasource) {
        List<TableInfo> tables = new ArrayList<>();
        ConnectionFacts facts;
        try (SRConnection connection = datasourceManager.getConnection(datasource)) {
            Integer previousTimeout = trySetNetworkTimeout(connection);
            try {
                DatabaseMetaData meta = connection.getMetaData();
                try (ResultSet rs = meta.getTables(connection.getCatalog(), null, "%", TABLE_TYPES)) {
                    while (rs.next() && tables.size() < DbSchema.MAX_SCHEMA_RESULTS) {
                        String name = rs.getString("TABLE_NAME");
                        String tableSchema = rs.getString("TABLE_SCHEM");
                        if (name != null && !isSystemSchema(tableSchema)) {
                            tables.add(new TableInfo(tableSchema, name, rs.getString("TABLE_TYPE")));
                        }
                    }
                }
                facts = new ConnectionFacts(schemaOf(connection), meta.getIdentifierQuoteString(),
                    meta.storesLowerCaseIdentifiers(), meta.storesUpperCaseIdentifiers(),
                    meta.getDatabaseProductName());
            } finally {
                restoreNetworkTimeout(connection, previousTimeout);
            }
        } catch (SQLException e) {
            throw new SchemaLoadException(
                "Could not read tables for datasource '" + datasource + "': " + e.getMessage(), e);
        }
        return new TablesDetail(tables, facts);
    }

    /**
     * {@code Connection.getSchema()} — MAY be null (a driver with no schema
     * concept, or one that genuinely has none selected), and per the JDBC spec
     * MAY throw {@link java.sql.SQLFeatureNotSupportedException} on a driver
     * that never implements it at all. Either way this is a fact for the
     * Query Browser to display, not a reason to fail the whole tree read.
     */
    private static String schemaOf(SRConnection connection) {
        try {
            return connection.getSchema();
        } catch (SQLException | RuntimeException | AbstractMethodError e) {
            logger.debug("Driver does not report a current schema: {}", e.toString());
            return null;
        }
    }

    /**
     * Escape {@code _} and {@code %} — LIKE wildcards — in a literal name before
     * using it as a {@code DatabaseMetaData} pattern argument. Without this, a
     * table literally named {@code my_table} also matches {@code myXtable},
     * because {@code getColumns}'s {@code tableNamePattern} is a LIKE pattern,
     * not an exact-match filter, and {@code _} means "any one character" in one.
     */
    private static String escapeForPattern(DatabaseMetaData meta, String literal) throws SQLException {
        String escape = meta.getSearchStringEscape();
        if (escape == null || escape.isEmpty()) {
            return literal;
        }
        return literal.replace(escape, escape + escape)
            .replace("_", escape + "_")
            .replace("%", escape + "%");
    }

    @Override
    public List<Column> columnDetails(String datasource, String table) {
        // "." can appear in neither a datasource name nor a table name in
        // isolation the way this key needs it to be unambiguous, but since
        // both are also independently used as map keys of their OWN caches
        // (tablesCache keyed on datasource alone), a collision here would
        // only ever merge two columnDetails() lookups - never cross into
        // tables() or datasources(). Good enough for a cache key, not a
        // security boundary.
        String key = datasource + '.' + table;
        return columnsCache.get(key, () -> loadColumns(datasource, null, table)).orElse(List.of());
    }

    @Override
    public List<Column> columnDetailsNow(String datasource, String table) {
        return columnDetailsNow(datasource, null, table);
    }

    @Override
    public List<Column> columnDetailsNow(String datasource, String schema, String table) {
        // Same key shape as columnDetails() when schema is null — the common
        // case shares cache entries with the completion path exactly as it did
        // before this overload existed. A schema segment is added only when
        // one is actually given, so two schemas' same-named tables get
        // distinct entries instead of clobbering each other.
        String key = schema == null ? datasource + '.' + table : datasource + '.' + schema + '.' + table;
        return columnsCache.getOrLoadNow(key, () -> loadColumns(datasource, schema, table));
    }

    private List<Column> loadColumns(String datasource, String schema, String table) {
        List<Column> columns = new ArrayList<>();
        try (SRConnection connection = datasourceManager.getConnection(datasource)) {
            Integer previousTimeout = trySetNetworkTimeout(connection);
            try {
                DatabaseMetaData meta = connection.getMetaData();
                String pattern = escapeForPattern(meta, table);
                // The schema, escaped the SAME way — getColumns' schemaPattern
                // is a LIKE pattern exactly like tableNamePattern, so a schema
                // literally named e.g. "a_b" would otherwise also match "aXb".
                String schemaPattern = schema == null ? null : escapeForPattern(meta, schema);
                try (ResultSet rs = meta.getColumns(connection.getCatalog(), schemaPattern, pattern, "%")) {
                    while (rs.next() && columns.size() < DbSchema.MAX_SCHEMA_RESULTS) {
                        String name = rs.getString("COLUMN_NAME");
                        if (name != null) {
                            columns.add(new Column(name, rs.getString("TYPE_NAME")));
                        }
                    }
                }
            } finally {
                restoreNetworkTimeout(connection, previousTimeout);
            }
        } catch (SQLException e) {
            throw new SchemaLoadException("Could not read columns for table '" + table
                + "' in datasource '" + datasource + "': " + e.getMessage(), e);
        }
        return columns;
    }
}
