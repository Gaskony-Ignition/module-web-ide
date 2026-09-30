/**
 * Typed client for the named-query API.
 *
 * Mirrors the script routes header for header — same auth gate, same CSRF
 * header, same quoted `ETag` / tolerant `If-Match`, same 428 (no base) and 409
 * (stale) — so the HTTP plumbing is IMPORTED from `scripts.ts` rather than
 * copied. See `docs/NAMED-QUERIES.md` §2 for the contract this codes against.
 *
 * The vocabulary in this file is the platform's, MEASURED on the running 8.3.8
 * gateway (NAMED-QUERIES.md §1.1–1.2), and it is exported as `as const` arrays so
 * the UI, the validation and the tests all read one list. Two of those lists were
 * wrong in the first draft of this client and were corrected from the measurement
 * — `Value` is a label and not a name, and `TimeUnits` has eight constants, not
 * seven. That is the whole lesson of this batch restated: a vocabulary taken from
 * a class file, or from memory, writes values the platform never reads.
 *
 * Paths here are the query's path INSIDE the project — `Folder/Sub/Name`, the
 * same string `system.db.runNamedQuery` takes. Unlike the script routes there is
 * no `<moduleId>/<typeId>` prefix, because the type is fixed and the runnable
 * path is the one the client needs anyway.
 */
import {
  CSRF_HEADER,
  postJson,
  readEtag,
  toApiError,
  type SaveResult,
  type ScriptOrigin,
} from './scripts';
import type { ExecError } from './execClient';
import { apiUrl } from './urls';

// ==================== The platform's vocabulary ====================

/**
 * `NamedQuery$Type`, by NAME.
 *
 * `toString()` on the middle one gives "Scalar Query" — that is the LABEL, and
 * the value on the wire is `ScalarQuery`. Sending the label writes a type the
 * platform does not have.
 */
export const QUERY_TYPES = ['Query', 'ScalarQuery', 'UpdateQuery'] as const;
export type NamedQueryType = (typeof QUERY_TYPES)[number];

/** How each type reads in the UI. The Designer's own words. */
export const QUERY_TYPE_LABELS: Record<NamedQueryType, string> = {
  Query: 'Query',
  ScalarQuery: 'Scalar Query',
  UpdateQuery: 'Update Query',
};

/**
 * `NamedQuery$Parameter$ParameterType`, by NAME.
 *
 * **The third constant is `Parameter`, not `Value`.** `Value` is what
 * `ParameterType.Parameter.toString()` returns — the Designer's LABEL, exactly as
 * `Type.ScalarQuery.toString()` gives "Scalar Query". This client emitted `Value`
 * on the wire until the platform was measured; the server accepts it as a
 * documented alias and never emits it, and neither does this file.
 */
export const PARAMETER_TYPES = ['Database', 'QueryString', 'Parameter'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/**
 * How each parameter type reads in the UI — the enum's own `toString()`.
 *
 * `Parameter` → "Value" is measured (§1.2). The other two are the enum name with
 * the camel case split, which is the same convention that measurement showed for
 * `ScalarQuery` → "Scalar Query".
 */
export const PARAMETER_TYPE_LABELS: Record<ParameterType, string> = {
  Database: 'Database',
  QueryString: 'Query String',
  Parameter: 'Value',
};

/**
 * A parameter type as the platform names it.
 *
 * `Value` arrives from an older client, an older build of this module's server
 * half, or a hand-written fixture; it means `Parameter`. Normalising on the way
 * IN means nothing downstream — the dropdown, the dirty comparison, the write —
 * has to know the alias exists.
 */
export function normaliseParameterType(value: string): ParameterType {
  if (value === 'Value') return 'Parameter';
  return (PARAMETER_TYPES as readonly string[]).includes(value)
    ? (value as ParameterType)
    : 'Parameter';
}

/**
 * `NamedQuery.PARAMETER_TYPES` — the ten a parameter may use, read off the
 * running gateway. **There is no `Date`.**
 *
 * These travel as NAMES on the wire and as `DataType.getIntValue()` integers on
 * disk; the server converts. Nothing here ever sends the integer.
 */
export const SQL_TYPES = [
  'Int1', 'Int2', 'Int4', 'Int8', 'Float4', 'Float8',
  'Boolean', 'String', 'DateTime', 'ByteArray',
] as const;
export type SqlType = (typeof SQL_TYPES)[number];

/**
 * `TimeUnits`, the caching unit — NOT `java.util.concurrent.TimeUnit`.
 *
 * EIGHT constants: `MS` leads, and `MONTH` and `YEAR` have no TimeUnit
 * equivalent at all, which is the tell that the two enums are not
 * interchangeable. This list was seven long until the enum was read off the
 * running gateway, which is one unit a user could not have chosen.
 */
export const CACHE_UNITS = ['MS', 'SEC', 'MIN', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const;
export type CacheUnit = (typeof CACHE_UNITS)[number];

/** How each cache unit reads in the UI. */
export const CACHE_UNIT_LABELS: Record<CacheUnit, string> = {
  MS: 'Milliseconds',
  SEC: 'Seconds',
  MIN: 'Minutes',
  HOUR: 'Hours',
  DAY: 'Days',
  WEEK: 'Weeks',
  MONTH: 'Months',
  YEAR: 'Years',
};

/** One row of the Authoring tab's parameter table. */
export interface NamedQueryParameter {
  type: ParameterType;
  identifier: string;
  sqlType: SqlType;
}

/**
 * One security row: a zone and a role, both possibly empty.
 *
 * The rig's Designer-written files carry a single `{"zone":"","role":""}`, so an
 * empty pair is a value the platform writes rather than a row to filter out.
 */
export interface ZoneRoleRequirement {
  zone: string;
  role: string;
}

/**
 * The FULL attribute vocabulary, as JSON, exactly as §2's settings route sends
 * it. Every key is present on the wire — a partial object here would be a
 * partial object on the way back, and the settings write takes the whole set.
 */
export interface NamedQuerySettings {
  type: NamedQueryType;
  enabled: boolean;
  /** Connection name. Empty means the project default. */
  database: string;
  /**
   * NOT an attribute on the resource: `toResource` writes it to the resource's
   * top-level `documentation` (§1.6). It round-trips as `settings.description`
   * because the server reads it back from the documentation — nothing here
   * should ever hang a `description` attribute on a resource by hand.
   */
  description: string;
  fallbackEnabled: boolean;
  fallbackValue: string;
  useMaxReturnSize: boolean;
  maxReturnSize: number;
  /** Java field is `cachingEnabled`; the resource KEY is `cacheEnabled`. */
  cacheEnabled: boolean;
  cacheAmount: number;
  cacheUnit: CacheUnit;
  autoBatchEnabled: boolean;
  permissions: ZoneRoleRequirement[];
  parameters: NamedQueryParameter[];
  /**
   * Carried, never edited. No screen offers it in 1.7.0 (§4), and a settings
   * write is a PARTIAL update, so echoing back the value that was read is what
   * keeps a Designer-set provider alive instead of blanking it.
   */
  syntaxProvider?: string;
}

/**
 * A fresh query's settings — the PLATFORM's own defaults, measured off a new
 * `NamedQuery` on the running gateway (§1.1).
 *
 * Not a guess and not zeroes: `maxReturnSize` is 100, `cacheAmount` is 1, and a
 * fresh query already holds ONE empty zone/role requirement. Filling those with
 * zeroes here would show a user values the gateway does not have, and a save
 * would then write them.
 */
export function emptySettings(): NamedQuerySettings {
  return {
    type: 'Query',
    enabled: true,
    database: '',
    description: '',
    fallbackEnabled: false,
    fallbackValue: '',
    useMaxReturnSize: false,
    maxReturnSize: 100,
    cacheEnabled: false,
    cacheAmount: 1,
    cacheUnit: 'SEC',
    autoBatchEnabled: false,
    permissions: [{ zone: '', role: '' }],
    parameters: [],
  };
}

// ==================== Listing ====================

export interface NamedQueryEntry {
  /** `Folder/Sub/Name` — the path INSIDE the project, with no resource-type prefix. */
  path: string;
  /** Bare name within its folder. */
  name: string;
  /** Slash-separated folder path, or empty at the root. */
  folder: string;
  /** Resource signature — the optimistic-concurrency token. */
  signature: string;
  origin: ScriptOrigin;
  /** Project that defines the resource; differs from the open one when inherited. */
  owner: string;
  /** Resource version. 2 is current; 1 is the dead legacy format — see `legacy`. */
  version?: number;
  /**
   * A version-1 resource, which the PLATFORM cannot read either.
   *
   * `fromResource` returns a blank query for one and `runNamedQuery` NPEs on it
   * (§1.5) — all 37 in the rig's `Whiteboard` project are in that state. It is
   * not a display quirk: the query does not run. Saving it rewrites it through
   * `toResource`, which stamps version 2 and repairs it, so the UI badges it and
   * says so rather than showing an ordinary row that silently does nothing.
   */
  legacy?: boolean;
  /** The row listed, but its settings would not parse. Still openable. */
  unreadable?: boolean;
  /** Omitted on a legacy row: the gateway cannot read those attributes either. */
  type?: NamedQueryType;
  database?: string;
  enabled?: boolean;
  /**
   * An empty folder the gateway reports as a resource in its own right
   * (`dataKeys: []`), exactly as it does for an empty Project Library package.
   * It has no `query.sql` and must never be opened.
   */
  isFolder?: boolean;
}

export interface NamedQueryList {
  project: string;
  mutable: boolean;
  queries: NamedQueryEntry[];
}

export interface NamedQuerySql {
  /** The SQL, byte-for-byte as stored. Never trimmed. */
  sql: string;
  etag: string;
}

export interface NamedQuerySettingsResponse {
  settings: NamedQuerySettings;
  /**
   * The resource signature. Named `signature` on the wire, as on the listing —
   * it is the same value the content route returns as its `ETag`, and it is the
   * If-Match for both halves of the next save.
   */
  signature: string;
  version?: number;
  /** See {@link NamedQueryEntry.legacy}. The editor says so on a legacy query. */
  legacy?: boolean;
  origin?: ScriptOrigin;
  owner?: string;
  mutable?: boolean;
  /** The gateway's database connections, for the Settings tab's dropdown. */
  databases: string[];
  /**
   * Settings keys the server will accept. Empty means "all of them" — the same
   * convention the script attributes route uses, where a non-empty list is an
   * allowlist and the UI must not offer what is not on it.
   */
  editable: string[];
  /**
   * The allowed values for every enum, sent so a UI need not hardcode them.
   *
   * Read but not used for the controls: the `as const` arrays above are what the
   * dropdowns, the validation and the tests share, and they are checked against
   * this in `namedQueries.test.ts`. If the two ever disagree, the GATEWAY is
   * right — that is the whole point of measuring it.
   */
  vocabulary?: {
    type?: string[];
    parameterType?: string[];
    sqlType?: string[];
    cacheUnit?: string[];
  };
}

// ==================== Test run ====================

export interface TestRunColumn {
  name: string;
  type: string;
}

/** Anything a cell can hold. `null` is a real SQL value, not "missing". */
export type TestRunValue = string | number | boolean | null;

export interface TestRunRows {
  ok: true;
  type?: 'Query';
  columns: TestRunColumn[];
  rows: TestRunValue[][];
  rowCount: number;
  elapsedMs?: number;
  /** Present when the server capped the result — the rest is gone, not pending. */
  truncatedAt?: number;
}

export interface TestRunScalar {
  ok: true;
  type?: 'ScalarQuery';
  value: TestRunValue;
  elapsedMs?: number;
}

export interface TestRunUpdate {
  ok: true;
  type?: 'UpdateQuery';
  affected: number;
  elapsedMs?: number;
}

export interface TestRunFailure {
  ok: false;
  /** The query's type, sent on the failure shape as well as the three successes. */
  type?: NamedQueryType;
  elapsedMs?: number;
  /** The same structured traceback the console gets — rendered the same way. */
  error: ExecError;
}

export type TestRunResult = TestRunRows | TestRunScalar | TestRunUpdate | TestRunFailure;

/**
 * Which success shape came back.
 *
 * `type` is on EVERY test-run result — all three successes and the failure — so
 * it is what these read first. The payload check stays as the fallback rather
 * than being replaced by it: a result whose `type` is missing or unknown still
 * has to render as SOMETHING, and rows/affected/value are unambiguous on their
 * own. Deleting the fallback would turn one absent field into a blank panel.
 */
export function isRowsResult(result: TestRunResult): result is TestRunRows {
  if (!result.ok) return false;
  if (result.type) return result.type === 'Query';
  return Array.isArray((result as TestRunRows).rows);
}

export function isUpdateResult(result: TestRunResult): result is TestRunUpdate {
  if (!result.ok) return false;
  if (result.type) return result.type === 'UpdateQuery';
  return typeof (result as TestRunUpdate).affected === 'number';
}

export function isScalarResult(result: TestRunResult): result is TestRunScalar {
  return result.ok && !isRowsResult(result) && !isUpdateResult(result);
}

// ==================== Routes ====================

type NamedQueryRoute = '/api/named-queries/content' | '/api/named-queries/settings';

/**
 * URL for a per-query route.
 *
 * Same rule as {@link scriptRouteUrl}: `RouteGroup` matches `:path` as ONE
 * segment, so the resource path's slashes are percent-encoded. Passed raw the
 * URL matches no route and 404s, which reads exactly like a missing query.
 */
export function namedQueryRouteUrl(base: NamedQueryRoute, path: string, project: string): string {
  const query = new URLSearchParams({ project });
  return `${apiUrl(`${base}/${encodeURIComponent(path)}`)}?${query.toString()}`;
}

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

/** GET /api/named-queries?project=P */
export async function fetchNamedQueries(project: string): Promise<NamedQueryList> {
  const query = new URLSearchParams({ project });
  const body = await getJson<NamedQueryList>(`${apiUrl('/api/named-queries')}?${query.toString()}`);
  return { ...body, queries: body.queries ?? [] };
}

/**
 * GET /api/named-queries/content/:path — the SQL plus its ETag.
 *
 * `text/plain`, not JSON: it is a SQL file and the byte-fidelity rule applies to
 * it exactly as it does to a script body.
 */
export async function readNamedQuerySql(project: string, path: string): Promise<NamedQuerySql> {
  const response = await fetch(namedQueryRouteUrl('/api/named-queries/content', path, project), {
    credentials: 'same-origin',
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return { sql: await response.text(), etag: readEtag(response) };
}

/** POST /api/named-queries/content/:path */
export function saveNamedQuerySql(request: {
  project: string;
  path: string;
  /** Sent verbatim. Nothing here trims it or appends a newline. */
  sql: string;
  baseSignature: string;
  csrfToken?: string;
}): Promise<SaveResult> {
  return postJson(
    namedQueryRouteUrl('/api/named-queries/content', request.path, request.project),
    { sql: request.sql, baseSignature: request.baseSignature },
    request.csrfToken,
    request.baseSignature
  );
}

/** GET /api/named-queries/settings/:path */
export async function readNamedQuerySettings(
  project: string,
  path: string
): Promise<NamedQuerySettingsResponse> {
  const body = await getJson<NamedQuerySettingsResponse>(
    namedQueryRouteUrl('/api/named-queries/settings', path, project)
  );
  const settings = { ...emptySettings(), ...(body.settings ?? {}) };
  return {
    ...body,
    // Both lists are optional on the wire and a missing one must not crash a
    // dropdown; a missing SETTINGS object would, so it is filled from the same
    // placeholder an unread document uses.
    settings: {
      ...settings,
      // `Value` is a documented alias for `Parameter` on the way in (§1.2).
      // Normalised HERE, once, so the dropdown, the dirty comparison and the
      // write never have to know the alias exists — a row left as `Value` would
      // read as clean, render as unselected, and post a name the server has to
      // translate back.
      parameters: (settings.parameters ?? []).map((parameter) => ({
        ...parameter,
        type: normaliseParameterType(String(parameter.type)),
      })),
    },
    // A legacy resource reads back with the platform's defaults, so the caller
    // needs `legacy` to say why the form is empty rather than showing it as a
    // query that happens to be unconfigured.
    legacy: body.legacy === true,
    databases: body.databases ?? [],
    editable: body.editable ?? [],
  };
}

/** POST /api/named-queries/settings/:path */
export function saveNamedQuerySettings(request: {
  project: string;
  path: string;
  settings: NamedQuerySettings;
  baseSignature: string;
  csrfToken?: string;
}): Promise<SaveResult> {
  return postJson(
    namedQueryRouteUrl('/api/named-queries/settings', request.path, request.project),
    { settings: request.settings, baseSignature: request.baseSignature },
    request.csrfToken,
    request.baseSignature
  );
}

/**
 * Create a query.
 *
 * There is no separate create route: POST to a path the project does not define
 * takes the server's create branch. What matters is the PRECONDITION — a create
 * must NOT send an If-Match, because there is no version to match and sending
 * one makes the server read it as a modify of something absent (428). Hence
 * this deliberately does not go through {@link postJson}, which always sets the
 * header.
 *
 * `settings` is optional and, when given, rides along in the SAME push as the
 * SQL — `NamedQueryRouteHandler.writeContent` applies it before storing the
 * query either way (§2's content-write body is `{sql, settings?,
 * baseSignature?}`), so a caller that wants the type and datasource set on
 * create need not follow up with a second write against the signature this
 * one returns.
 */
export async function createNamedQuery(request: {
  project: string;
  path: string;
  /** Initial SQL. Empty by default — the Designer creates an empty query. */
  sql?: string;
  settings?: NamedQuerySettings;
  csrfToken?: string;
}): Promise<SaveResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (request.csrfToken) {
    headers[CSRF_HEADER] = request.csrfToken;
  }
  const response = await fetch(
    namedQueryRouteUrl('/api/named-queries/content', request.path, request.project),
    {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      // No baseSignature: absent means create.
      body: JSON.stringify({ sql: request.sql ?? '', settings: request.settings }),
    }
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as SaveResult;
}

/**
 * DELETE /api/named-queries/content/:path
 *
 * `If-Match` is REQUIRED (428 without it), and it is what stops a delete
 * discarding an edit nobody saw: if the query changed since the listing, this
 * 409s instead of destroying the newer version.
 */
export async function deleteNamedQuery(request: {
  project: string;
  path: string;
  baseSignature: string;
  csrfToken?: string;
}): Promise<{ ok: true; deleted?: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'If-Match': request.baseSignature,
  };
  if (request.csrfToken) {
    headers[CSRF_HEADER] = request.csrfToken;
  }
  const response = await fetch(
    namedQueryRouteUrl('/api/named-queries/content', request.path, request.project),
    { method: 'DELETE', credentials: 'same-origin', headers }
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as { ok: true; deleted?: string };
}

/** POST /api/named-queries/rename?project=P — `If-Match` on the SOURCE. */
export interface RenameResult {
  ok: true;
  /** The destination path, echoed. */
  path?: string;
  /** The moved query's new signature — absent on a folder move. */
  signature?: string;
  /**
   * What moved: a COUNT from the current server, or a row per resource. Read by
   * nothing here — the listing is re-read after a rename, because the server
   * decides every new signature and inventing one would give the next save a
   * base the gateway never agreed to.
   */
  moved?: number | Array<{ from: string; to: string; signature: string }>;
}

/**
 * POST /api/named-queries/rename?project=P
 *
 * `If-Match` on the SOURCE for a query: the move destroys the old path, and a
 * caller who has not read the resource must not be able to move one that
 * changed underneath them.
 *
 * **A FOLDER has no signature, so it sends no precondition.** A folder is
 * implied by the paths under it; only sometimes is it a resource in its own
 * right. Where the listing gives one, its signature is sent and the same
 * staleness check applies; where the folder is implied, there is nothing to
 * match and requiring one would make a folder unmovable.
 */
export function renameNamedQuery(request: {
  project: string;
  path: string;
  newPath: string;
  /** Omitted for a folder rename. */
  baseSignature?: string;
  csrfToken?: string;
}): Promise<RenameResult> {
  const query = new URLSearchParams({ project: request.project });
  const url = `${apiUrl('/api/named-queries/rename')}?${query.toString()}`;
  const body = { path: request.path, newPath: request.newPath };
  if (request.baseSignature) {
    return postJson(url, body, request.csrfToken, request.baseSignature) as Promise<RenameResult>;
  }
  return postWithoutPrecondition(url, body, request.csrfToken) as Promise<RenameResult>;
}

/**
 * POST /api/named-queries/test?project=P
 *
 * Runs through the execution service — the same policy gate, audit line, pool
 * and Stop as a console run, because this is arbitrary SQL against a live
 * database and a second, softer gate is exactly what must not exist.
 *
 * It runs the DRAFT: the body carries the SQL and the settings as they are on
 * screen alongside the path, so the Testing tab tests what you are looking at
 * rather than what was last written. The path still identifies the resource —
 * inheritance, permissions and the audit line all resolve from it.
 */
export function testRunNamedQuery(request: {
  project: string;
  path: string;
  /** Keyed by parameter identifier. Values are sent as the user typed them. */
  parameters: Record<string, TestRunValue>;
  /** The buffer as it is on screen. Sent ALWAYS — see the note above. */
  sql?: string;
  /** The settings as they are on screen, for the parameter types the run coerces by. */
  settings?: NamedQuerySettings;
  csrfToken?: string;
}): Promise<TestRunResult> {
  const query = new URLSearchParams({ project: request.project });
  return postTest(`${apiUrl('/api/named-queries/test')}?${query.toString()}`, {
    path: request.path,
    parameters: request.parameters,
    sql: request.sql,
    settings: request.settings,
  }, request.csrfToken);
}

/**
 * The test route's POST.
 *
 * A FAILED query is a 200 with `{ok:false, error}`, which is the point: a SQL
 * error is a result to render in the Testing tab, not a transport failure.
 */
async function postTest(url: string, body: unknown, csrfToken?: string): Promise<TestRunResult> {
  return postWithoutPrecondition(url, body, csrfToken) as Promise<TestRunResult>;
}

/**
 * A POST that sends no `If-Match`.
 *
 * For the two operations that have no version to assert: a test run, which
 * writes nothing, and a folder rename, whose subject is not a resource. Sending
 * a precondition for either would be claiming a version that does not exist.
 */
async function postWithoutPrecondition(
  url: string,
  body: unknown,
  csrfToken?: string
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (csrfToken) {
    headers[CSRF_HEADER] = csrfToken;
  }
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return await response.json();
}

// ==================== Names ====================

/**
 * Validate a proposed query path (`Folder/Sub/Name`), returning an error string
 * or null.
 *
 * The rule is the PLATFORM's, not Python's: a named query's name is a resource
 * path segment and a lookup key for `system.db.runNamedQuery`, never a module
 * name, so `Order-Intake` is legal here where it would be refused for a library
 * script. Letters, digits, `-` and `_` per segment; `/` separates folders; no
 * leading, trailing or doubled separator.
 */
export function validateNamedQueryName(name: string): string | null {
  if (!name || !name.trim()) {
    return 'Enter a name';
  }
  if (name !== name.trim()) {
    return 'Name cannot start or end with a space';
  }
  if (name.startsWith('/') || name.endsWith('/')) {
    return 'Name cannot start or end with "/"';
  }
  if (name.includes('//')) {
    return 'Name cannot contain an empty folder segment';
  }
  for (const segment of name.split('/')) {
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
      return `"${segment}" is not a valid name — letters, digits, "-" and "_" only`;
    }
  }
  if (name.length > 200) {
    return 'Name is too long';
  }
  return null;
}

/**
 * A Python identifier, and unique among the query's other parameters.
 *
 * The identifier is substituted into the SQL as `:name` and read back out of a
 * dict by the caller, so a duplicate silently shadows and a name with a space in
 * it can never be passed. Both are refused before the write rather than after.
 */
export function validateParameterIdentifier(
  identifier: string,
  others: readonly string[]
): string | null {
  if (!identifier) {
    return 'Enter an identifier';
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    return 'Letters, digits and underscores only, and it cannot start with a digit';
  }
  if (others.includes(identifier)) {
    return `"${identifier}" is used by another parameter`;
  }
  return null;
}

/**
 * The path a route takes for a query the user has named `Folder/Sub/Name`.
 *
 * The identity function, and it exists to say so: the named-query routes take
 * the path INSIDE the project, with no `ignition/named-query/` prefix, unlike
 * every script route in this client. This module built that prefix until the
 * contract was reconciled, and every call 404'd — which reads exactly like a
 * missing query. A tolerant strip is kept for a caller holding the older,
 * resource-shaped form (an LSP location, a saved link).
 */
export function namedQueryPath(name: string): string {
  return stripResourcePrefix(name);
}

/** The `Folder/Sub/Name` a path names. Also the identity — see above. */
export function namedQueryName(path: string): string {
  return stripResourcePrefix(path);
}

/** `ignition/named-query/Orders/Totals` → `Orders/Totals`; anything else unchanged. */
export function stripResourcePrefix(path: string): string {
  return path.replace(/^ignition\/named-query\//, '');
}

/** True for a path in the resource-shaped form an LSP location would carry. */
export function isNamedQueryResourcePath(path: string): boolean {
  return path.startsWith('ignition/named-query/');
}
