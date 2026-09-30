/**
 * The Database Query Browser: ad hoc SQL against a configured datasource, from
 * the browser rather than the console.
 *
 * A structural sibling of ScriptConsole — a scratch buffer that runs on the
 * Gateway, a toolbar above the body — but plain JDBC rather than Jython, so
 * three things differ on purpose:
 *
 * **Three keys, not one.** Ctrl+Enter runs the current SELECTION when there is
 * one, else the whole buffer. Ctrl+Shift+Enter runs only the statement the
 * cursor is inside (G), split on `;` outside string/identifier literals and
 * comments (`../lib/sqlStatements`) — a cursor on a blank line between two
 * statements runs nothing and says so, rather than guessing a neighbour.
 * `pythonKeymap` is not reused here: it binds the console's own two-shortcut
 * rule, which is not this one.
 *
 * **The run id is generated HERE, not by the server.** `POST /run` is
 * synchronous — the response does not arrive until the query finishes — so a
 * server-minted id would reach a Stop click too late to be of any use. See
 * `DbQueryRouteHandler`'s class Javadoc for the same reasoning on the gateway
 * side.
 *
 * **`isAdmin` and `executionEnabled` are separate props, not one `canExecute`
 * boolean.** The server gates run/cancel/tables/columns ALL on the
 * Administrator role (see `ScriptIdeRouteRegistrar`'s Database Query Browser
 * section) — schema browsing is not the looser lookup it might look like, and
 * a notice claiming otherwise would be a live lie to a non-admin session.
 * `executionEnabled` is the SEPARATE, role-independent `ExecPolicy` switch —
 * an admin whose gateway has execution disabled can still browse and edit,
 * just not run, which is a different notice from "you lack the role"
 * entirely. Datasources and history stay open to any authenticated user
 * either way.
 *
 * **The schema tree IS schema-qualified (A).** `tables()` now reports each
 * table's own schema and JDBC type, plus the connection facts needed to
 * qualify and quote a name (`../lib/sqlIdentifier`); two same-named tables in
 * different schemas each get their own row, key and columns cache entry.
 * Tables are shown flat when the datasource has at most one schema in play,
 * and grouped under a schema heading when it has several — the flat case is
 * by far the common one (one schema, or a MySQL/MariaDB datasource with none
 * at all) and a group wrapper around a single group would be chrome nobody
 * asked for.
 *
 * **A 10,000-row grid is never virtualised.** `ResultsGrid` renders every row
 * a result set carries — see its own module comment for the perf note.
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { sql, type SQLNamespace } from '@codemirror/lang-sql';
import {
  commonSurface, editorTheme, escapeFocusOut, findAndReplace, folding, goToLine,
} from './editorCore';
import Resizer from './Resizer';
import QueryHistoryDialog from './QueryHistoryDialog';
import SaveAsNamedQueryDialog from './SaveAsNamedQueryDialog';
import ResultsGrid from './ResultsGrid';
import { Traceback } from './ScriptConsole';
import { generateRunId } from './runId';
import { IconChevronDown, IconChevronRight } from './Icons';
import { rememberWidth, storedWidth } from '../workspace/layoutStore';
import { dialectForProductName } from '../lib/sqlDialect';
import { statementAtCursor } from '../lib/sqlStatements';
import {
  DEFAULT_CONNECTION_FACTS, qualifiedTableName, tableKey,
} from '../lib/sqlIdentifier';
import { ApiError } from '../api/scripts';
import {
  cancelDbQuery,
  fetchDbColumns,
  fetchDbDatasources,
  fetchDbTables,
  isDbQueryResultSet,
  runDbQuery,
  type Datasource,
  type DbConnectionFacts,
  type DbQueryColumn,
  type DbQueryRunResponse,
  type DbTableInfo,
} from '../api/dbQueries';
import './QueryBrowser.css';

export interface QueryBrowserProps {
  project: string;
  csrfToken?: string;
  /** False when the session lacks the Administrator role — run AND browse both require it. */
  isAdmin: boolean;
  /** False when execution is switched off gateway-wide (ExecPolicy), independent of role. */
  executionEnabled: boolean;
  /** Told the selected datasource, so a popped-out tab can name it in its title. */
  onDatasourceChange?: (datasource: string) => void;
  /**
   * Present only in the MAIN WORKSPACE — refreshes the Named Queries tree
   * after a successful "Save as Named Query" (C). Absent in a pop-out tab,
   * which has no tree to refresh; there the dialog just confirms the save.
   */
  onNamedQuerySaved?: (path: string) => void;
  /**
   * Present only in the main workspace — offers to open the saved query in
   * the named-query editor. Absent in a pop-out for the same reason as
   * {@link onNamedQuerySaved}.
   */
  onOpenNamedQuery?: (path: string) => void;
}

/** Persisted keys, free-form strings rather than a closed set — see ThemePicker.tsx. */
const DATASOURCE_KEY = 'scriptide.query.datasource';
const SQL_KEY = 'scriptide.query.sql';

/** The schema pane's remembered width, in `layoutStore`'s own namespace. */
const SCHEMA_WIDTH_KEY = 'query-schema';
const SCHEMA_WIDTH_DEFAULT = 220;
const SCHEMA_WIDTH_MIN = 140;
const SCHEMA_WIDTH_MAX = 360;

/** Matches the server's `DbQueryRouteHandler.MAX_ROW_CAP` — enforced there regardless. */
const MAX_ROW_CAP = 10_000;
const DEFAULT_MAX_ROWS = 1000;

/** Off / 5 / 10 / 30 / 60 s (E) — 0 means Off. */
const AUTO_REFRESH_OPTIONS = [0, 5, 10, 30, 60] as const;

function readStoredDatasource(): string {
  try {
    return window.localStorage.getItem(DATASOURCE_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeDatasource(value: string) {
  try {
    window.localStorage.setItem(DATASOURCE_KEY, value);
  } catch {
    /* not remembered; the session still works */
  }
}

function readStoredSql(): string {
  try {
    return window.localStorage.getItem(SQL_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeSql(value: string) {
  try {
    window.localStorage.setItem(SQL_KEY, value);
  } catch {
    /* not remembered; the session still works */
  }
}

/**
 * The SQL-completion namespace (B): every loaded table, nested under its
 * OWN (raw, unquoted) schema and table name, mapped to its loaded column
 * names — or an empty array before they have loaded, so the table itself
 * still completes even before its columns do.
 *
 * Raw names, not the pre-quoted string {@link qualifiedTableName} builds for
 * the click-to-insert path (A) — `schemaCompletionSource` quotes and
 * qualifies a completion ITSELF (via `defaultSchema` below and its own
 * `caseInsensitiveIdentifiers` handling, default `false`, which quotes a name
 * carrying an upper-case letter exactly the way this database folds an
 * unquoted one). Handing it an already-quoted string as a namespace KEY would
 * both fail to match what the user is typing (a label starting with a literal
 * `"`) and insert the quoting twice over for a name that needed it. The one
 * quoting decision lives in `sqlIdentifier.ts`; completion defers to
 * `lang-sql`'s own, separate implementation of the same idea.
 */
function buildSqlNamespace(
  tables: readonly DbTableInfo[],
  facts: DbConnectionFacts,
  columnsByTable: Readonly<Record<string, DbQueryColumn[]>>
): { schema: SQLNamespace; defaultSchema?: string } {
  // A table with NO schema (MySQL/MariaDB, or a driver that reports none at
  // all) sits at the TOP level, exactly as if there were no schemas in play —
  // `lang-sql` tells a table entry (an array of column names) apart from a
  // nested schema entry (a plain object) by shape, so the two can share one
  // namespace object. A table WITH a real schema nests under that schema's
  // own name; `defaultSchema` then tells `lang-sql` which ONE nested schema
  // ALSO completes unqualified, the same one `qualifiedTableName` (A) treats
  // as needing no qualification on insert.
  const topLevel: Record<string, readonly string[]> = {};
  const bySchema = new Map<string, Record<string, readonly string[]>>();
  for (const table of tables) {
    const columns = columnsByTable[tableKey(table)];
    const columnNames = columns ? columns.map((c) => c.name) : [];
    if (table.schema == null) {
      topLevel[table.name] = columnNames;
    } else {
      const tablesInSchema = bySchema.get(table.schema) ?? {};
      tablesInSchema[table.name] = columnNames;
      bySchema.set(table.schema, tablesInSchema);
    }
  }
  const schema: Record<string, SQLNamespace> = { ...topLevel };
  for (const [schemaName, tablesInSchema] of bySchema) {
    schema[schemaName] = tablesInSchema;
  }
  return { schema, defaultSchema: facts.defaultSchema ?? undefined };
}

/** A raw `FROM`/`JOIN` target from the buffer, unquoted, split into its schema/name parts. */
function parseTableReference(raw: string): { schema: string | null; name: string } {
  const parts = raw.split('.').map((part) => part.replace(/^[`"[]|[`"\]]$/g, ''));
  const name = parts[parts.length - 1];
  const schema = parts.length > 1 ? parts[parts.length - 2] : null;
  return { schema, name };
}

/** Every table the buffer references after `FROM`/`JOIN`, matched against what is known. */
function tablesReferencedIn(text: string, tables: readonly DbTableInfo[]): DbTableInfo[] {
  const pattern = /\b(?:FROM|JOIN)\s+([`"[\]\w.]+)/gi;
  const found: DbTableInfo[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match !== null) {
    const { schema, name } = parseTableReference(match[1]);
    for (const table of tables) {
      if (table.name.toLowerCase() !== name.toLowerCase()) {
        continue;
      }
      if (schema && table.schema && table.schema.toLowerCase() !== schema.toLowerCase()) {
        continue;
      }
      const key = tableKey(table);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(table);
      }
    }
    match = pattern.exec(text);
  }
  return found;
}

interface LastRun {
  datasource: string;
  sql: string;
  ok: boolean;
  /** Every result of the run was a SELECT-shaped result set — E's precondition for auto-refresh. */
  allResultSets: boolean;
}

export default function QueryBrowser({
  project, csrfToken, isAdmin, executionEnabled, onDatasourceChange,
  onNamedQuerySaved, onOpenNamedQuery,
}: QueryBrowserProps) {
  const canExecute = isAdmin && executionEnabled;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const runIdRef = useRef<string | null>(null);
  // The re-entrancy guard for doRun. NOT `running` state: two Ctrl+Enters
  // fired before React re-renders would both still see the OLD `running`
  // value in their closures (state updates are batched, a ref mutation is
  // immediate), and each would generate its own run id and fire its own
  // request — two concurrent runs from one user action, and a Stop that can
  // only ever reference the second one.
  const runningRef = useRef(false);
  const csrfTokenRef = useRef(csrfToken);
  // Read via refs inside the keymap: the editor's extensions are built once,
  // so a closure over these there would freeze at its first identity.
  const doRunRef = useRef<(explicitSql?: string, recordHistory?: boolean, readOnly?: boolean) => void>(() => {});
  // Bumped on every MANUAL run (never an auto-refresh tick, see `doRun`) and
  // folded into ResultsGrid's `key` below — a genuinely new query remounts
  // the grid (resetting sort/filter/column widths/cell viewer), an
  // auto-refresh rerun of the SAME sql does not.
  const runGenerationRef = useRef(0);
  const doRunStatementAtCursorRef = useRef<() => void>(() => {});

  const [datasources, setDatasources] = useState<Datasource[] | null>(null);
  const [datasourcesError, setDatasourcesError] = useState('');
  const [datasource, setDatasourceState] = useState(() => readStoredDatasource());
  useEffect(() => {
    onDatasourceChange?.(datasource);
  }, [datasource, onDatasourceChange]);
  const [maxRows, setMaxRows] = useState(DEFAULT_MAX_ROWS);

  const [tablesDetail, setTablesDetail] = useState<{ tables: DbTableInfo[]; facts: DbConnectionFacts } | null>(null);
  const [tablesError, setTablesError] = useState('');
  const [tablesTruncated, setTablesTruncated] = useState(false);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [columnsByTable, setColumnsByTable] = useState<Record<string, DbQueryColumn[]>>({});
  const [columnsError, setColumnsError] = useState<Record<string, string>>({});
  const [columnsTruncated, setColumnsTruncated] = useState<Record<string, boolean>>({});
  const [loadingColumns, setLoadingColumns] = useState<ReadonlySet<string>>(() => new Set());

  const facts = tablesDetail?.facts ?? DEFAULT_CONNECTION_FACTS;

  const [schemaWidth, setSchemaWidth] = useState(
    () => storedWidth(SCHEMA_WIDTH_KEY, SCHEMA_WIDTH_DEFAULT)
  );

  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [lastResult, setLastResult] = useState<DbQueryRunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);

  // ---- C: save as named query ---------------------------------------------
  const [savingAsQuery, setSavingAsQuery] = useState(false);
  const [savedNotice, setSavedNotice] = useState<{ path: string } | null>(null);

  // ---- E: auto-refresh -----------------------------------------------------
  const [autoRefreshSeconds, setAutoRefreshSeconds] = useState<number>(0);
  const [autoRefreshReason, setAutoRefreshReason] = useState<string | null>(null);
  const [nextRefreshIn, setNextRefreshIn] = useState<number | null>(null);
  const lastRunRef = useRef<LastRun | null>(null);
  const isFirstDatasourceRender = useRef(true);
  // Read from `doRun`, which is declared before the rest of this section —
  // a plain ref mirror, updated on every render, is simpler here than
  // reordering every declaration below into dependency order.
  const autoRefreshSecondsRef = useRef(autoRefreshSeconds);
  autoRefreshSecondsRef.current = autoRefreshSeconds;

  useEffect(() => {
    csrfTokenRef.current = csrfToken;
  }, [csrfToken]);

  // A run left in flight when this component goes away — the project was
  // switched (Workspace keys QueryBrowser on `project`, so a switch unmounts
  // this instance) or the tab/pop-out closed — is stopped rather than left to
  // run to completion for nobody. Best-effort, matching Stop's own click
  // handler: nothing here can await the result once the component is gone.
  useEffect(() => () => {
    if (runningRef.current && runIdRef.current) {
      void cancelDbQuery({ runId: runIdRef.current, csrfToken: csrfTokenRef.current }).catch(() => {});
    }
  }, []);

  const setDatasource = useCallback((name: string) => {
    setDatasourceState(name);
    storeDatasource(name);
  }, []);

  // Fetched once: the datasource list rarely changes within a session, and
  // there is no cheaper "became visible" signal than the socket the console
  // already needs and this panel does not.
  useEffect(() => {
    let cancelled = false;
    fetchDbDatasources()
      .then((list) => {
        if (cancelled) return;
        setDatasources(list);
        // Keep the remembered choice only if this gateway still has it, so a
        // stale name from a previous gateway does not sit selected forever.
        setDatasourceState((current) =>
          current && list.some((d) => d.name === current) ? current : (list[0]?.name ?? ''));
      })
      .catch((e: unknown) => {
        if (!cancelled) setDatasourcesError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Tables belong to the CHOSEN datasource; switching it invalidates the whole
  // cached tree, not just the list — a column cached under "Orders" against
  // one datasource means nothing against another. It also stops auto-refresh
  // (E) — the skip guards the very first render, which is a mount, not a
  // "change".
  // Each request takes a number; only the newest one may land, so a slow load
  // for a datasource the user has already left never overwrites the tree.
  const tablesRequestRef = useRef(0);
  const refreshSchemaRef = useRef<() => void>(() => {});
  const fetchTables = useCallback((ds: string, fresh: boolean) => {
    tablesRequestRef.current += 1;
    const request = tablesRequestRef.current;
    setTablesDetail(null);
    fetchDbTables(ds, fresh)
      .then(({ tables, truncated, facts: connectionFacts }) => {
        if (request !== tablesRequestRef.current) return;
        setTablesDetail({ tables, facts: connectionFacts });
        setTablesTruncated(truncated);
      })
      .catch((e: unknown) => {
        if (request !== tablesRequestRef.current) return;
        setTablesDetail({ tables: [], facts: DEFAULT_CONNECTION_FACTS });
        setTablesError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    setExpanded(new Set());
    setColumnsByTable({});
    setColumnsError({});
    setColumnsTruncated({});
    // Without this, a table sharing its NAME with one in the previous
    // datasource stays stuck on "Loading columns…" forever: the old fetch's
    // own `datasourceRef` guard (see loadColumns) makes it a no-op rather than
    // populate the new tree, but it never clears this flag either, and
    // toggleTable refuses to start a new load while a table is still marked
    // loading.
    setLoadingColumns(new Set());
    setTablesError('');
    setTablesTruncated(false);
    if (isFirstDatasourceRender.current) {
      isFirstDatasourceRender.current = false;
    } else {
      setAutoRefreshSeconds(0);
      setAutoRefreshReason(null);
      lastRunRef.current = null;
    }
    if (!datasource) {
      setTablesDetail(null);
      return undefined;
    }
    if (!isAdmin) {
      // tables/columns are Administrator-gated exactly like run/cancel — see
      // the class Javadoc. Not fetching at all avoids a guaranteed 403 and
      // keeps the reason the tree shows accurate (isAdmin, not a fetch error).
      setTablesDetail(null);
      return undefined;
    }
    fetchTables(datasource, false);
    return () => {
      tablesRequestRef.current += 1;
    };
  }, [datasource, isAdmin, fetchTables]);

  // Reload the tree from the database, not the gateway's five-minute cache.
  const refreshSchema = useCallback(() => {
    if (!datasource || !isAdmin) return;
    setExpanded(new Set());
    setColumnsByTable({});
    setColumnsError({});
    setColumnsTruncated({});
    setLoadingColumns(new Set());
    setTablesError('');
    setTablesTruncated(false);
    fetchTables(datasource, true);
  }, [datasource, isAdmin, fetchTables]);
  refreshSchemaRef.current = refreshSchema;

  // Which datasource each in-flight columns fetch was made FOR — a fetch
  // started against one datasource must not write into the tree after the
  // datasource has since changed, even though `loadColumns`'s own closure
  // still has the OLD datasource value baked in via its dependency array.
  const datasourceRef = useRef(datasource);
  useEffect(() => {
    datasourceRef.current = datasource;
  }, [datasource]);

  const loadColumns = useCallback((table: DbTableInfo) => {
    const key = tableKey(table);
    const forDatasource = datasource;
    setLoadingColumns((current) => new Set(current).add(key));
    fetchDbColumns(datasource, table.name, table.schema ?? undefined)
      .then(({ columns, truncated }) => {
        if (datasourceRef.current !== forDatasource) return;
        setColumnsByTable((current) => ({ ...current, [key]: columns }));
        setColumnsTruncated((current) => ({ ...current, [key]: truncated }));
      })
      .catch((e: unknown) => {
        if (datasourceRef.current !== forDatasource) return;
        setColumnsError((current) => ({
          ...current, [key]: e instanceof Error ? e.message : String(e),
        }));
      })
      .finally(() => {
        if (datasourceRef.current !== forDatasource) return;
        setLoadingColumns((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      });
  }, [datasource]);

  const loadColumnsRef = useRef(loadColumns);
  useEffect(() => {
    loadColumnsRef.current = loadColumns;
  }, [loadColumns]);

  const toggleTable = useCallback((table: DbTableInfo) => {
    const key = tableKey(table);
    const opening = !expanded.has(key);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Lazy load on first expand only — cached per table so re-collapsing and
    // re-expanding does not refetch.
    if (opening && !columnsByTable[key] && !loadingColumns.has(key)) {
      loadColumns(table);
    }
  }, [expanded, columnsByTable, loadingColumns, loadColumns]);

  const filteredTables = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = tablesDetail?.tables ?? [];
    return needle ? list.filter((t) => t.name.toLowerCase().includes(needle)) : list;
  }, [tablesDetail, filter]);

  /**
   * Grouped under a schema heading only when several schemas are actually in
   * play — the common case (one schema, or none at all on MySQL/MariaDB) is a
   * flat list exactly as before this batch, and a group wrapper around a
   * single group would be chrome nobody asked for.
   */
  const schemaGroups = useMemo(() => {
    const distinct = new Set(filteredTables.map((t) => t.schema));
    if (distinct.size <= 1) {
      return null;
    }
    const byName = new Map<string, DbTableInfo[]>();
    for (const table of filteredTables) {
      const groupKey = table.schema ?? '';
      const group = byName.get(groupKey);
      if (group) group.push(table); else byName.set(groupKey, [table]);
    }
    return [...byName.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filteredTables]);

  const insertAtCursor = useCallback((text: string) => {
    const view = viewRef.current;
    if (!view) return;
    const range = view.state.selection.main;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      selection: { anchor: range.from + text.length },
    });
    view.focus();
  }, []);

  const insertTableSelectAll = useCallback((table: DbTableInfo) => {
    const view = viewRef.current;
    if (!view) return;
    const name = qualifiedTableName(table, facts);
    const snippet = `SELECT * FROM ${name}\n`;
    // Replace the WHOLE buffer only when there is nothing worth keeping in
    // it — double-clicking a table over a half-written query must not throw
    // it away, so this falls back to an ordinary insert at the caret instead.
    if (view.state.doc.toString().trim().length === 0) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: snippet } });
      view.focus();
    } else {
      insertAtCursor(snippet);
    }
  }, [insertAtCursor, facts]);

  // A table row has BOTH a click and a double-click handler, and a browser's
  // own double-click ALWAYS fires click, click, dblclick in that order — not
  // just one dblclick. Left undebounced, insertTableSelectAll's "buffer is
  // empty" check above would never see an empty buffer on a real double
  // click, because the two preceding clicks have already inserted the name
  // twice by the time it runs. Delaying the single-click insert gives a
  // following double-click a chance to cancel it and run instead.
  const tableClickTimer = useRef<number | null>(null);

  const handleTableClick = useCallback((table: DbTableInfo) => {
    if (tableClickTimer.current !== null) {
      window.clearTimeout(tableClickTimer.current);
    }
    tableClickTimer.current = window.setTimeout(() => {
      tableClickTimer.current = null;
      insertAtCursor(qualifiedTableName(table, facts));
    }, 250);
  }, [insertAtCursor, facts]);

  const handleTableDoubleClick = useCallback((table: DbTableInfo) => {
    if (tableClickTimer.current !== null) {
      window.clearTimeout(tableClickTimer.current);
      tableClickTimer.current = null;
    }
    insertTableSelectAll(table);
  }, [insertTableSelectAll]);

  useEffect(() => () => {
    if (tableClickTimer.current !== null) {
      window.clearTimeout(tableClickTimer.current);
    }
  }, []);

  // ---- running -------------------------------------------------------------

  const doRun = useCallback((explicitSql?: string, recordHistory?: boolean, readOnly?: boolean) => {
    const view = viewRef.current;
    if (!view || runningRef.current || !canExecute || !datasource) {
      return;
    }
    let sqlText: string;
    if (explicitSql !== undefined) {
      sqlText = explicitSql;
    } else {
      const range = view.state.selection.main;
      sqlText = range.empty ? view.state.doc.toString() : view.state.sliceDoc(range.from, range.to);
    }
    if (!sqlText.trim()) {
      return;
    }
    // A manual run of SQL other than what auto-refresh is re-running stops it
    // (E) — reruning the SAME sql (auto-refresh's own tick, or pressing Run
    // again unchanged) does not.
    if (autoRefreshSeconds !== 0 && sqlText !== lastRunRef.current?.sql) {
      setAutoRefreshSeconds(0);
      setAutoRefreshReason(null);
    }
    // recordHistory is only ever explicitly false for an auto-refresh tick
    // (see the interval effect below) — every other caller is a genuinely
    // new manual run, which is what ResultsGrid's key should reset on.
    if (recordHistory !== false) {
      runGenerationRef.current += 1;
    }
    const runId = generateRunId();
    runIdRef.current = runId;
    runningRef.current = true;
    setRunning(true);
    setStopping(false);
    setRunError(null);
    runDbQuery({
      runId, datasource, sql: sqlText, maxRows, project, csrfToken, recordHistory, readOnly,
    })
      .then((response) => {
        setLastResult(response);
        // Empty (`.every` is vacuously true on []) and truncated runs are
        // NOT eligible either — "show me the data again" presumes there was
        // a whole result set to show, not a partial one.
        const allResultSets = response.ok
          && response.results.length > 0
          && !response.resultsTruncated
          && response.results.every(isDbQueryResultSet);
        lastRunRef.current = { datasource, sql: sqlText, ok: response.ok, allResultSets };
        // An update count means the run may have created, altered or dropped a
        // table; reload the tree so it shows now, not in five minutes.
        if (readOnly !== true && response.ok
          && response.results.some((result) => !isDbQueryResultSet(result))) {
          refreshSchemaRef.current();
        }
        if (autoRefreshSecondsRef.current !== 0 && !allResultSets) {
          setAutoRefreshSeconds(0);
          setAutoRefreshReason(response.ok
            ? 'the run returned nothing, was truncated, or included a result that was not a '
              + 'result set (an update/DDL statement)'
            : 'the run failed');
        }
      })
      .catch((e: unknown) => {
        setLastResult(null);
        setRunError(e instanceof Error ? e.message : String(e));
        // A 409 (too many queries already running) is transient — the next
        // tick just tries again — everything else (a dropped connection, an
        // auth failure) is treated the same as a failed run above.
        const isConflict = e instanceof ApiError && e.isConflict;
        if (autoRefreshSecondsRef.current !== 0 && !isConflict) {
          setAutoRefreshSeconds(0);
          setAutoRefreshReason('the run failed');
        }
      })
      .finally(() => {
        runningRef.current = false;
        setRunning(false);
        setStopping(false);
        runIdRef.current = null;
      });
  }, [canExecute, datasource, maxRows, project, csrfToken, autoRefreshSeconds]);

  doRunRef.current = doRun;

  // ---- G: run the statement under the cursor -------------------------------

  const doRunStatementAtCursor = useCallback(() => {
    const view = viewRef.current;
    if (!view || runningRef.current || !canExecute || !datasource) {
      return;
    }
    const text = view.state.doc.toString();
    const cursor = view.state.selection.main.head;
    const result = statementAtCursor(text, cursor, facts.databaseProductName);
    if (!result.found) {
      // Clears the last result too — otherwise a stale success grid would sit
      // beside "nothing to run" as though this click had done something.
      setLastResult(null);
      setRunError(result.reason === 'unterminated'
        ? result.message
        : 'The cursor is not inside a statement — nothing to run.');
      return;
    }
    doRun(result.statement.text);
  }, [canExecute, datasource, doRun, facts.databaseProductName]);

  doRunStatementAtCursorRef.current = doRunStatementAtCursor;

  const doStop = useCallback(() => {
    if (!running || !runIdRef.current) return;
    setStopping(true);
    setAutoRefreshSeconds(0);
    // Best-effort, like the console's own Stop: the run's own request is
    // still in flight and resolves on its own once the database returns.
    void cancelDbQuery({ runId: runIdRef.current, csrfToken }).catch(() => {});
  }, [running, csrfToken]);

  // An ordinary CodeMirror edit, not a special "reset" path — Ctrl+Z undoes
  // it via the editor's own history exactly like undoing any other delete.
  const doClearSql = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
    view.focus();
    // AFTER dispatch: the updateListener above already ran synchronously and
    // re-stored the (now empty) text, so removing the key here — rather than
    // before — is what actually leaves no key behind, matching Clear script.
    try {
      window.localStorage.removeItem(SQL_KEY);
    } catch {
      /* not remembered; the session still works */
    }
  }, []);

  const doCopy = useCallback((resultIndex: number) => {
    setCopied(resultIndex);
    window.setTimeout(() => setCopied((current) => (current === resultIndex ? null : current)), 1200);
  }, []);

  // ---- E: auto-refresh -----------------------------------------------------

  const refreshEligible = lastRunRef.current !== null
    && lastRunRef.current.datasource === datasource
    && lastRunRef.current.ok
    && lastRunRef.current.allResultSets;

  useEffect(() => {
    if (autoRefreshSeconds === 0) {
      setNextRefreshIn(null);
      return undefined;
    }
    let remaining = autoRefreshSeconds;
    setNextRefreshIn(remaining);
    const timer = window.setInterval(() => {
      // Pauses while hidden (E): a tick that fires with the page hidden does
      // not consume a second of the countdown at all, rather than silently
      // refreshing a tab nobody is looking at.
      if (document.hidden) {
        return;
      }
      remaining -= 1;
      if (remaining <= 0) {
        remaining = autoRefreshSeconds;
        // Never overlaps a running query (E) — a tick that lands mid-run is
        // simply skipped; the next one tries again. Guarded on lastRunRef
        // too: with nothing run yet there is no SQL to repeat, and calling
        // through with `undefined` would fall back to reading the LIVE
        // buffer instead, exactly what auto-refresh must never do.
        // `doRunRef.current`, not the closed-over `doRun` — this effect only
        // re-subscribes on `[autoRefreshSeconds, datasource]`, so a `doRun`
        // dependency that changed for another reason (maxRows, project,
        // csrfToken) would otherwise run with a stale value baked in.
        if (!runningRef.current && lastRunRef.current) {
          doRunRef.current(lastRunRef.current.sql, false, true);
        }
      }
      setNextRefreshIn(remaining);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRefreshSeconds, datasource]);

  // Announced only on an on/off (or interval) TRANSITION, never per second —
  // the visible countdown below has no `role="status"` for exactly that
  // reason; a screen reader hearing "next refresh in 9s / 8s / 7s…" once a
  // second is noise, not information.
  const [autoRefreshAnnouncement, setAutoRefreshAnnouncement] = useState('');
  useEffect(() => {
    setAutoRefreshAnnouncement(
      autoRefreshSeconds === 0 ? 'Auto-refresh off' : `Auto-refresh on, every ${autoRefreshSeconds} seconds`
    );
  }, [autoRefreshSeconds]);

  function chooseAutoRefresh(seconds: number) {
    if (seconds !== 0 && !refreshEligible) {
      setAutoRefreshReason(lastRunRef.current === null
        ? 'run a query first — auto-refresh reruns the last executed SQL'
        : 'the last run was not entirely a result set (an update/DDL statement, or it failed)');
      return;
    }
    setAutoRefreshReason(null);
    setAutoRefreshSeconds(seconds);
  }

  // Pausing on hidden is read live inside the interval above; nothing to wire
  // here beyond making sure the tab's OWN visibility state is what the
  // interval reads — `document.hidden` already is that, with no listener
  // needed for a value read fresh on every tick.

  // ---- the editor ---------------------------------------------------------

  const sqlCompartment = useMemo(() => new Compartment(), []);
  const scanTablesRef = useRef<(text: string) => void>(() => {});
  const lazyLoadTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) {
      return undefined;
    }
    const view = new EditorView({
      state: EditorState.create({
        doc: readStoredSql(),
        extensions: [
          ...commonSurface,
          sqlCompartment.of(sql()),
          // Table/column completion (B) rides on the language support's own
          // completion source (schemaCompletionSource, wired in by sql());
          // this extension is what actually shows the popup and answers
          // typing — a LanguageSupport with no autocompletion() active
          // contributes a source nothing ever asks for.
          autocompletion({ activateOnTyping: true, closeOnBlur: true, icons: true }),
          editorTheme,
          ...findAndReplace,
          ...folding,
          goToLine,
          EditorView.contentAttributes.of({ 'aria-label': 'Query Browser SQL' }),
          keymap.of([
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                doRunRef.current();
                return true;
              },
            },
            {
              key: 'Mod-Shift-Enter',
              preventDefault: true,
              run: () => {
                doRunStatementAtCursorRef.current();
                return true;
              },
            },
            ...completionKeymap,
            ...escapeFocusOut,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              storeSql(text);
              // Lazily load columns for a table the user just typed or
              // qualified (B) — debounced, so a fast typist does not fire a
              // fetch per keystroke.
              if (lazyLoadTimerRef.current !== null) {
                window.clearTimeout(lazyLoadTimerRef.current);
              }
              lazyLoadTimerRef.current = window.setTimeout(() => {
                scanTablesRef.current(text);
              }, 300);
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; everything reached here goes through a ref
  }, []);

  // The SQL-completion namespace and dialect (B): reconfigured whenever the
  // loaded tables, connection facts or loaded columns change. A schema/table
  // completion never blocks typing — this only ever REPLACES the compartment
  // with fresh, already-known data; it never itself makes a network call.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const tables = tablesDetail?.tables ?? [];
    const dialect = dialectForProductName(facts.databaseProductName);
    const { schema, defaultSchema } = buildSqlNamespace(tables, facts, columnsByTable);
    view.dispatch({
      effects: sqlCompartment.reconfigure(sql({ dialect, schema, defaultSchema })),
    });
  }, [tablesDetail, facts, columnsByTable, sqlCompartment]);

  // The lazy-column-load scan (B) — kept fresh via a ref because the
  // `updateListener` above is built once, at mount.
  useEffect(() => {
    scanTablesRef.current = (text: string) => {
      const tables = tablesDetail?.tables ?? [];
      if (tables.length === 0) return;
      for (const table of tablesReferencedIn(text, tables)) {
        const key = tableKey(table);
        if (!columnsByTable[key] && !loadingColumns.has(key)) {
          loadColumnsRef.current(table);
        }
      }
    };
  }, [tablesDetail, columnsByTable, loadingColumns]);

  const busy = running;

  function renderTableNode(table: DbTableInfo) {
    const key = tableKey(table);
    const isOpen = expanded.has(key);
    const columns = columnsByTable[key];
    const displayName = qualifiedTableName(table, facts);
    return (
      <div className="qb-node" key={key}>
        <div className="qb-node-row">
          <button
            type="button"
            className="qb-disclosure"
            aria-expanded={isOpen}
            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${displayName}`}
            onClick={() => toggleTable(table)}
          >
            {isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </button>
          <button
            type="button"
            className="qb-table-name"
            onClick={() => handleTableClick(table)}
            onDoubleClick={() => handleTableDoubleClick(table)}
            title="Click to insert the name; double-click for SELECT *"
          >
            {displayName}
          </button>
        </div>
        {isOpen && (
          <div className="qb-columns">
            {loadingColumns.has(key) && (
              <p className="qb-tree-empty muted">Loading columns…</p>
            )}
            {columnsError[key] && (
              <p className="qb-tree-empty muted">
                Could not load columns: {columnsError[key]}
              </p>
            )}
            {columns && columns.length === 0 && (
              <p className="qb-tree-empty muted">No columns.</p>
            )}
            {columnsTruncated[key] && (
              <p className="qb-tree-empty muted">
                Showing the first {columns?.length ?? 0} columns — this table has more.
              </p>
            )}
            {columns?.map((column) => (
              <button
                type="button"
                key={column.name}
                className="qb-column-name"
                onClick={() => insertAtCursor(column.name)}
                title={column.type}
              >
                {column.name}
                <span className="qb-col-type muted">{column.type}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="qb" aria-label="Query Browser">
      {historyOpen && (
        <QueryHistoryDialog
          onClose={() => setHistoryOpen(false)}
          onLoad={(loadedDatasource, sqlText) => {
            setDatasource(loadedDatasource);
            const view = viewRef.current;
            if (view) {
              view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sqlText } });
              view.focus();
            }
          }}
        />
      )}

      {savingAsQuery && (
        <SaveAsNamedQueryDialog
          project={project}
          sql={viewRef.current?.state.doc.toString() ?? ''}
          datasource={datasource}
          datasources={datasources ?? []}
          csrfToken={csrfToken}
          onCancel={() => setSavingAsQuery(false)}
          onSaved={(path) => {
            setSavingAsQuery(false);
            setSavedNotice({ path });
            onNamedQuerySaved?.(path);
          }}
        />
      )}

      <div className="qb-toolbar">
        <label className="qb-field">
          <span className="qb-field-label">Datasource</span>
          <select value={datasource} onChange={(e) => setDatasource(e.target.value)}>
            {datasource === '' && <option value="">(choose one)</option>}
            {(datasources ?? []).map((ds) => (
              <option key={ds.name} value={ds.name}>
                {ds.name}{ds.status === 'VALID' ? '' : ` — ${ds.status}`}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => doRun()}
          disabled={busy || !canExecute || !datasource}
          title="Ctrl+Enter"
        >
          {busy ? 'Running…' : 'Run'}
        </button>
        <button
          type="button"
          onClick={doRunStatementAtCursor}
          disabled={busy || !canExecute || !datasource}
          title="Ctrl+Shift+Enter"
        >
          Run statement
        </button>
        <button type="button" onClick={doStop} disabled={!busy}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
        {stopping && (
          <span className="qb-hint muted">(waiting for the database to stop the statement)</span>
        )}
        <button type="button" className="qb-clear-sql" onClick={doClearSql} disabled={busy}>
          Clear SQL
        </button>
        <label className="qb-field">
          <span className="qb-field-label">Max rows</span>
          <input
            type="number"
            min={1}
            max={MAX_ROW_CAP}
            value={maxRows}
            onChange={(e) => setMaxRows(Number(e.target.value))}
          />
        </label>
        <label className="qb-field">
          <span className="qb-field-label">Auto-refresh</span>
          <select
            value={autoRefreshSeconds}
            onChange={(e) => chooseAutoRefresh(Number(e.target.value))}
            disabled={!canExecute}
          >
            {AUTO_REFRESH_OPTIONS.map((seconds) => (
              <option key={seconds} value={seconds}>{seconds === 0 ? 'Off' : `${seconds} s`}</option>
            ))}
          </select>
        </label>
        {autoRefreshSeconds !== 0 && nextRefreshIn !== null && (
          <span className="qb-hint muted">next refresh in {nextRefreshIn}s</span>
        )}
        <span className="visually-hidden" role="status">{autoRefreshAnnouncement}</span>
        <span className="qb-spacer" />
        <button type="button" onClick={() => setSavingAsQuery(true)} disabled={!isAdmin}>
          Save as Named Query…
        </button>
        <button type="button" onClick={() => setHistoryOpen(true)}>
          History
        </button>
      </div>

      {autoRefreshReason && (
        <p className="qb-autorefresh-note" role="status">
          Auto-refresh is off: {autoRefreshReason}
        </p>
      )}

      {savedNotice && (
        <p className="qb-saved-notice" role="status">
          <span>Saved as {savedNotice.path}.</span>
          {onOpenNamedQuery && (
            <button
              type="button"
              onClick={() => {
                onOpenNamedQuery(savedNotice.path);
                setSavedNotice(null);
              }}
            >
              Open in editor
            </button>
          )}
          <button type="button" onClick={() => setSavedNotice(null)}>Dismiss</button>
        </p>
      )}

      {!isAdmin && (
        <p className="qb-denied" role="status">
          Running queries and browsing the schema both require the Administrator role. You can
          still write SQL here by hand; nothing will be sent to the gateway.
        </p>
      )}
      {isAdmin && !executionEnabled && (
        <p className="qb-denied" role="status">
          Script execution is disabled on this gateway. You can still browse the schema and edit
          the SQL here; Run is disabled until an administrator re-enables it.
        </p>
      )}
      {datasourcesError && (
        <p className="qb-fetch-error" role="alert">
          Could not load datasources: {datasourcesError}
        </p>
      )}

      <div className="qb-workspace">
        <div className="qb-editor-row">
          <div className="qb-schema" style={{ flex: `0 0 ${schemaWidth}px` }}>
            <div className="qb-schema-bar">
              <input
                type="search"
                className="qb-filter"
                placeholder="Filter tables"
                aria-label="Filter tables"
                spellCheck={false}
                autoComplete="off"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button
                type="button"
                className="qb-schema-refresh"
                onClick={refreshSchema}
                disabled={!datasource || !isAdmin}
                aria-label="Refresh tables"
                title="Reload tables and columns from the database"
              >
                ↻
              </button>
            </div>
            <div className="qb-tree" aria-label="Tables">
              {!datasource && (
                <p className="qb-tree-empty muted">Choose a datasource to browse its tables.</p>
              )}
              {datasource && !isAdmin && (
                <p className="qb-tree-empty muted">
                  Browsing the schema requires the Administrator role, the same as running a query.
                </p>
              )}
              {datasource && isAdmin && tablesDetail === null && !tablesError && (
                <p className="qb-tree-empty muted">Loading tables…</p>
              )}
              {isAdmin && tablesError && (
                <p className="qb-tree-empty muted">Could not load tables: {tablesError}</p>
              )}
              {datasource && isAdmin && tablesDetail !== null && tablesDetail.tables.length === 0 && !tablesError && (
                <p className="qb-tree-empty muted">No tables in this datasource.</p>
              )}
              {datasource && isAdmin && tablesDetail !== null && tablesDetail.tables.length > 0
                && filteredTables.length === 0 && (
                <p className="qb-tree-empty muted">No table matches “{filter.trim()}”.</p>
              )}
              {isAdmin && tablesTruncated && (
                <p className="qb-tree-empty muted">
                  Showing the first {tablesDetail?.tables.length ?? 0} tables — this datasource has more.
                </p>
              )}
              {isAdmin && schemaGroups === null && filteredTables.map(renderTableNode)}
              {isAdmin && schemaGroups !== null && schemaGroups.map(([schemaName, tables]) => (
                <div className="qb-schema-group" key={schemaName || '\u0000'}>
                  <p className="qb-schema-group-name muted">
                    {schemaName || '(no schema)'}
                    {schemaName === facts.defaultSchema ? ' (default)' : ''}
                  </p>
                  {tables.map(renderTableNode)}
                </div>
              ))}
            </div>
          </div>

          <Resizer
            value={schemaWidth}
            min={SCHEMA_WIDTH_MIN}
            max={SCHEMA_WIDTH_MAX}
            // The schema pane is the one being sized and it sits to the LEFT
            // of this divider, so dragging right grows it.
            side="left"
            label="Resize the schema tree"
            onChange={(width) => {
              setSchemaWidth(width);
              rememberWidth(SCHEMA_WIDTH_KEY, width);
            }}
          />

          <div className="qb-editor" ref={hostRef} />
        </div>

        <section className="qb-results" aria-label="Results">
          {runError && <p className="qb-run-error" role="alert">{runError}</p>}
          {!runError && !lastResult && (
            <p className="qb-results-empty muted">Nothing yet. Run a query to see results here.</p>
          )}
          {lastResult && !lastResult.ok && (
            <div className="qb-result qb-error">
              <pre>{`${lastResult.error.type}: ${lastResult.error.message}`}</pre>
              <Traceback error={lastResult.error} onOpenFrame={() => {}} />
            </div>
          )}
          {lastResult && lastResult.ok && (
            <>
              <p className="qb-run-status muted" role="status">
                {lastResult.results.length === 0
                  ? 'No result.'
                  : `Finished in ${lastResult.elapsedMs} ms`}
              </p>
              {lastResult.resultsTruncated && (
                <p className="qb-run-note muted" role="status">
                  Not everything is shown — this run hit a size, count or time limit before
                  finishing.
                </p>
              )}
              {lastResult.rolledBackTransaction && (
                <p className="qb-run-note muted" role="status">
                  This query left a transaction open; it was rolled back before the connection
                  went back to the pool.
                </p>
              )}
              {lastResult.results.map((result, resultIndex) => (
                isDbQueryResultSet(result) ? (
                  <ResultsGrid
                    key={`${runGenerationRef.current}-${resultIndex}`}
                    index={resultIndex}
                    result={result}
                    datasource={datasource}
                    copied={copied}
                    onCopy={doCopy}
                  />
                ) : (
                  <p key={resultIndex} className="qb-affected" role="status">
                    {result.affected} {result.affected === 1 ? 'row' : 'rows'} affected.
                  </p>
                )
              ))}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
