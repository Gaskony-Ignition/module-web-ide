package com.gaskony.scriptide.gateway.lang;

import java.util.List;

/**
 * What {@link LanguageServer} needs to offer live database-schema completion
 * inside a SQL string literal.
 *
 * <p>A pure interface, deliberately: {@link LanguageServer} depends on this
 * and never on JDBC or the Ignition datasource SDK directly, so it stays
 * unit-testable with a fake and all SDK/JDBC contact stays isolated in
 * {@link SdkDbSchema}. Every method answers NAMES only — a connection's own
 * name, a table's name, a column's name — never a row of data.</p>
 *
 * <p>The call that triggers a completion never names a datasource (a bare
 * {@code system.db.runPrepQuery(sql, args)} does not say which connection it
 * will run against until the third argument is typed, if it ever is), so
 * {@link LanguageServer} asks every method here across EVERY configured
 * datasource and lets {@code detail} say which connection each answer came
 * from, rather than guessing one.</p>
 */
public interface DbSchema {

    /** Bound on how many tables/columns one lookup offers, completion or browser alike. */
    int MAX_SCHEMA_RESULTS = 500;

    /** Configured datasource (database connection) names. */
    List<String> datasources();

    /** Table and view names in one datasource. */
    List<String> tables(String datasource);

    /** Column names of one table in one datasource. */
    List<String> columns(String datasource, String table);

    /** One column's name and its vendor type name, e.g. {@code varchar}. */
    record Column(String name, String type) {
    }

    /**
     * Column name AND type for one table — what the Query Browser's schema tree
     * shows. A separate method rather than widening {@link #columns}: the
     * completion caller only ever wanted names, and every existing caller of that
     * method would otherwise have to unwrap a record for a field it never uses.
     */
    List<Column> columnDetails(String datasource, String table);

    /**
     * {@link #tables}, but a cache miss BLOCKS this thread and answers the real
     * list rather than {@link java.util.List#of()}.
     *
     * <p>{@link #tables} and {@link #columnDetails} exist for completion, whose
     * whole contract is "never wait on a database" (a miss schedules a
     * background refresh and answers empty for that keystroke — see
     * {@link TtlCache}). The Query Browser's schema tree is not a keystroke:
     * clicking a datasource to browse it is a deliberate action, and a person
     * who just clicked it would rather wait a moment than be told a real
     * datasource has no tables. Measured on the rig 28/09/2026 — the
     * non-blocking path reported "no tables" for a datasource with 99 of
     * them, on the very first browse.</p>
     */
    List<String> tablesNow(String datasource);

    /** {@link #columnDetails}, but blocking — see {@link #tablesNow}. */
    List<Column> columnDetailsNow(String datasource, String table);

    /**
     * {@link #columnDetailsNow}, with an explicit schema — the Query Browser's
     * columns route passes the schema a table came from, since two schemas can
     * hold a same-named table. {@code null} leaves the schema unconstrained,
     * exactly as the two-argument overload always did.
     */
    List<Column> columnDetailsNow(String datasource, String schema, String table);

    /**
     * One table or view as the Query Browser's tree needs it — qualified by
     * schema, unlike {@link #tables}, whose callers (LSP completion) never
     * distinguish two same-named tables in different schemas.
     *
     * @param schema the table's schema, or {@code null} when the driver does
     *               not report one (MySQL/MariaDB, where a "database" is a
     *               catalog, not a schema)
     * @param type   the JDBC {@code TABLE_TYPE}, e.g. {@code TABLE} or
     *               {@code VIEW}
     */
    record TableInfo(String schema, String name, String type) {
    }

    /**
     * Connection-wide facts the Query Browser needs to decide whether a name
     * must be schema-qualified and whether it needs quoting — never a property
     * of one table, so it travels once per datasource rather than once per row.
     */
    record ConnectionFacts(String defaultSchema, String identifierQuote,
                           boolean storesLowerCaseIdentifiers, boolean storesUpperCaseIdentifiers,
                           String databaseProductName) {
    }

    /** Both of {@link #tablesDetailedNow}'s halves — one JDBC connection answers both. */
    record TablesDetail(List<TableInfo> tables, ConnectionFacts facts) {
        /** Defensive copy — a nested record in a public interface is a public type, and this is a value, not a shared mutable list. */
        public TablesDetail {
            tables = List.copyOf(tables);
        }
    }

    /**
     * {@link #tablesNow}, qualified and typed, with the connection facts needed
     * to use what it returns — the Query Browser's schema tree. Blocking, for
     * the same reason {@link #tablesNow} is: browsing a datasource is a click,
     * not a keystroke.
     */
    TablesDetail tablesDetailedNow(String datasource);

    /**
     * Forget everything cached for one datasource, so the next read goes to the
     * database. The Query Browser's refresh, and after a run that may have
     * changed the schema: a table created there otherwise stays out of the
     * tree for the cache's five minutes.
     */
    default void invalidate(String datasource) {
    }
}
