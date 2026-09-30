/**
 * Typed client for the Query Browser API.
 *
 * Same HTTP plumbing as every other client here — `credentials: 'same-origin'`,
 * the `X-CSRF-Token` header on a write, `toApiError` on a non-OK response —
 * imported from `scripts.ts` rather than redefined, exactly as `namedQueries.ts`
 * does: a second copy of the CSRF header name is a second thing to get wrong.
 * `getJson` stays a small private copy, as it is in every other client here —
 * it is three lines with nothing to get wrong twice.
 *
 * See `DbQueryRouteHandler`'s class Javadoc on the gateway for the contract
 * this codes against.
 */
import { apiUrl } from './urls';
import { CSRF_HEADER, toApiError } from './scripts';
import type { ExecError } from './execClient';

// ==================== Schema ====================

/**
 * `DatasourceStatus`, by NAME — an in-memory field read on the gateway, not a
 * live connection test, so it is cheap enough to show for every row of the
 * picker rather than only the selected one.
 */
export type DatasourceStatusName =
  | 'VALID' | 'FAULTED' | 'DISABLED' | 'CONNECTING' | 'RECONNECTING' | 'SHUTDOWN' | 'UNKNOWN';

export interface Datasource {
  name: string;
  status: DatasourceStatusName;
}

/** One column's name and its vendor type name, e.g. `varchar`. */
export interface DbQueryColumn {
  name: string;
  type: string;
}

/**
 * One table or view, schema-qualified. `schema` is `null` when the driver
 * does not report one at all (MySQL/MariaDB, where a "database" is a catalog,
 * not a schema) — never the literal string `"null"`.
 */
export interface DbTableInfo {
  schema: string | null;
  name: string;
  /** The JDBC `TABLE_TYPE`, e.g. `TABLE` or `VIEW`. */
  type: string;
}

/**
 * Connection-wide facts the Query Browser needs to decide whether a table
 * name must be schema-qualified and whether either part needs quoting — see
 * `sqlIdentifier.ts`. Never a property of one table, so it travels once per
 * datasource rather than once per row.
 */
export interface DbConnectionFacts {
  defaultSchema: string | null;
  identifierQuote: string;
  storesLowerCaseIdentifiers: boolean;
  storesUpperCaseIdentifiers: boolean;
  /** JDBC `getDatabaseProductName()` — the SQL-completion dialect is chosen from this. */
  databaseProductName: string | null;
}

// ==================== Run ====================

/** Anything a cell can hold. `null` is a real SQL value, not "missing". */
export type DbQueryValue = string | number | boolean | null;

export interface DbQueryResultSet {
  columns: DbQueryColumn[];
  rows: DbQueryValue[][];
  rowCount: number;
  /** Present when the server capped the result — the rest is gone, not pending. */
  truncatedAt?: number;
}

export interface DbQueryAffected {
  affected: number;
}

export type DbQueryResult = DbQueryResultSet | DbQueryAffected;

/** True for a `SELECT`-shaped result; false for an update/DDL result. */
export function isDbQueryResultSet(result: DbQueryResult): result is DbQueryResultSet {
  return Array.isArray((result as DbQueryResultSet).rows);
}

export interface DbQueryRunSuccess {
  ok: true;
  runId: string;
  elapsedMs: number;
  results: DbQueryResult[];
  /** The run hit a size, count or time budget and stopped before producing everything. */
  resultsTruncated?: boolean;
  /** The statement left a transaction open; it was rolled back before the connection returned to the pool. */
  rolledBackTransaction?: boolean;
}

export interface DbQueryRunFailure {
  ok: false;
  runId: string;
  elapsedMs: number;
  /** The same structured traceback the console gets — rendered the same way. */
  error: ExecError;
}

export type DbQueryRunResponse = DbQueryRunSuccess | DbQueryRunFailure;

// ==================== History ====================

/** One kept ad hoc query run. Its own store — see `QueryHistory` on the gateway. */
export interface DbQueryHistoryEntry {
  id: string;
  at: number;
  datasource: string;
  sql: string;
  ok: boolean;
  /** A short precomputed line, e.g. "2 rows" or "3 affected". May be blank. */
  summary: string;
  durationMs: number;
  error?: string;
}

export interface DbQueryHistoryList {
  runs: DbQueryHistoryEntry[];
  maxRuns: number;
}

// ==================== Routes ====================

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

/** GET /api/db-queries/datasources */
export async function fetchDbDatasources(): Promise<Datasource[]> {
  const body = await getJson<{ datasources: Datasource[] }>(apiUrl('/api/db-queries/datasources'));
  return body.datasources ?? [];
}

export interface DbQueryTables {
  tables: DbTableInfo[];
  /** The datasource has at least as many tables as the server's cap — the list is not everything. */
  truncated: boolean;
  facts: DbConnectionFacts;
}

export interface DbQueryColumns {
  columns: DbQueryColumn[];
  /** The table has at least as many columns as the server's cap — the list is not everything. */
  truncated: boolean;
}

/**
 * GET /api/db-queries/tables?datasource=X — schema-qualified tables and
 * views, plus the connection facts needed to qualify/quote a name (A) and to
 * pick a SQL-completion dialect (B).
 */
export async function fetchDbTables(datasource: string, fresh = false): Promise<DbQueryTables> {
  const query = new URLSearchParams({ datasource });
  // Skips the gateway's five-minute schema cache: a refresh, or a run that
  // may have created or dropped a table.
  if (fresh) query.set('fresh', '1');
  const body = await getJson<{
    tables: DbTableInfo[];
    truncated?: boolean;
    defaultSchema?: string | null;
    identifierQuote?: string;
    storesLowerCaseIdentifiers?: boolean;
    storesUpperCaseIdentifiers?: boolean;
    databaseProductName?: string | null;
  }>(`${apiUrl('/api/db-queries/tables')}?${query.toString()}`);
  return {
    tables: body.tables ?? [],
    truncated: body.truncated === true,
    facts: {
      defaultSchema: body.defaultSchema ?? null,
      identifierQuote: body.identifierQuote || '"',
      storesLowerCaseIdentifiers: body.storesLowerCaseIdentifiers === true,
      storesUpperCaseIdentifiers: body.storesUpperCaseIdentifiers === true,
      databaseProductName: body.databaseProductName ?? null,
    },
  };
}

/**
 * GET /api/db-queries/columns?datasource=X&table=Y[&schema=Z]
 *
 * `schema` is OPTIONAL — omitted for a datasource with one schema (or none),
 * sent when a table's own schema differs, so two same-named tables in
 * different schemas each get their own columns rather than one clobbering
 * the other in the server's cache.
 */
export async function fetchDbColumns(
  datasource: string,
  table: string,
  schema?: string | null
): Promise<DbQueryColumns> {
  const query = new URLSearchParams({ datasource, table });
  if (schema) {
    query.set('schema', schema);
  }
  const body = await getJson<{ columns: DbQueryColumn[]; truncated?: boolean }>(
    `${apiUrl('/api/db-queries/columns')}?${query.toString()}`
  );
  return { columns: body.columns ?? [], truncated: body.truncated === true };
}

/**
 * POST /api/db-queries/run
 *
 * `runId` is generated by the CALLER (`crypto.randomUUID()`), not the server:
 * this request is synchronous — the response does not arrive until the query
 * finishes — so a server-minted id would reach the browser too late for a Stop
 * clicked while the request is still in flight. Send the same id to
 * {@link cancelDbQuery}.
 *
 * A failed query is a 200 with `{ok:false, error}`, exactly like a failed
 * named-query test run — it is a result to render, not a transport failure.
 * Only a request that never reached a database (bad params, execution
 * disabled, CSRF) throws.
 */
export async function runDbQuery(request: {
  runId: string;
  datasource: string;
  sql: string;
  maxRows?: number;
  project?: string;
  csrfToken?: string;
  /**
   * Default `true` (omitted). Auto-refresh (E) sends `false` so re-running
   * the same SELECT every few seconds does not flood the per-user history —
   * the run is still AUDITED on the gateway either way.
   */
  recordHistory?: boolean;
  /**
   * Default `false` (omitted). Auto-refresh sends `true` as a best-effort
   * JDBC read-only hint for the rerun — see `DbQueryRouteHandler.RunRequest`.
   * Not a guarantee on its own; the real guard is the client's own
   * eligibility check (every result of the run being repeated was itself a
   * result set).
   */
  readOnly?: boolean;
}): Promise<DbQueryRunResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (request.csrfToken) {
    headers[CSRF_HEADER] = request.csrfToken;
  }
  const response = await fetch(apiUrl('/api/db-queries/run'), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      runId: request.runId,
      datasource: request.datasource,
      sql: request.sql,
      maxRows: request.maxRows,
      project: request.project,
      recordHistory: request.recordHistory,
      readOnly: request.readOnly,
    }),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as DbQueryRunResponse;
}

/**
 * POST /api/db-queries/cancel
 *
 * Returns `false` rather than throwing on a 404 — that means the run had
 * already finished by the time Stop reached the server, which is a race the
 * caller lost, not a failure it needs to report differently from a run that
 * simply completed.
 */
export async function cancelDbQuery(request: {
  runId: string;
  csrfToken?: string;
}): Promise<boolean> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (request.csrfToken) {
    headers[CSRF_HEADER] = request.csrfToken;
  }
  const response = await fetch(apiUrl('/api/db-queries/cancel'), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ runId: request.runId }),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  return true;
}

/** GET /api/db-queries/history — this user's past ad hoc queries, newest first. */
export async function fetchDbQueryHistory(): Promise<DbQueryHistoryList> {
  return getJson<DbQueryHistoryList>(apiUrl('/api/db-queries/history'));
}
