/**
 * Typed client for the script-resource API.
 *
 * Mirrors ScriptResourceRouteHandler and ScriptAttributesRouteHandler. Two
 * things here are load-bearing rather than stylistic:
 *
 * 1. Every call sends `credentials: 'same-origin'` — the Gateway identifies the
 *    user by its own session cookie, and a fetch without it is anonymous even on
 *    a page the user is signed into.
 * 2. Resource paths are encoded with encodeURIComponent, so their slashes become
 *    %2F. See {@link scriptRouteUrl}.
 */
import { apiUrl } from './urls';

/** Resource types this IDE edits. Mirrors ScriptResourceTypes. */
export type ScriptTypeId =
  | 'script-python'
  /** Web Dev endpoint. NOTE: a different module id — com.inductiveautomation.webdev. */
  | 'resources'
  | 'timer'
  | 'message'
  | 'scheduled'
  | 'tag-change'
  | 'startup'
  | 'shutdown'
  | 'update';

/** Where a resource comes from, relative to the project being edited. */
export type ScriptOrigin = 'local' | 'inherited' | 'override';

export interface ProjectSummary {
  name: string;
  /** False for an immutable project — the UI disables saving up front. */
  mutable: boolean;
}

/** One static file on a Web Dev endpoint. */
export interface WebDevFile {
  /** The resource's data key — a plain filename. */
  key: string;
  /** Size in bytes, so a row can say why a big bundle is not offered. */
  size: number;
  /**
   * Whether this IDE will open it. False for a type it cannot round-trip as
   * text (a PNG would come back as replacement characters and save corrupted),
   * and false for anything over half a megabyte.
   */
  editable: boolean;
}

export interface ScriptEntry {
  /** `<moduleId>/<typeId>[/<name>]`, e.g. `ignition/script-python/util/helpers`. */
  path: string;
  typeId: ScriptTypeId;
  /** Bare name within the type; empty string for a singleton (startup/shutdown/update). */
  name: string;
  /** Resource signature — the optimistic-concurrency token. */
  signature: string;
  dataKeys: string[];
  /**
   * The `.py` data key this resource actually carries. Always use this, never a
   * per-type default: a resource written by an older Designer can legitimately
   * differ, and writing to the wrong key adds a second key instead of updating
   * the script.
   */
  scriptKey: string;
  /** Human-readable type name, e.g. "Project Library". Drives the tree grouping. */
  typeLabel: string;
  singleton: boolean;
  origin: ScriptOrigin;
  /** Project that defines the resource — differs from the open one when inherited. */
  owner: string;
  /**
   * True for a project-library PACKAGE with nothing in it — a directory the
   * gateway reports as a resource in its own right (`dataKeys: []`) alongside
   * the scripts nested inside it. It still needs a row so an empty package
   * shows as an empty folder, but it carries no `scriptKey` and must never be
   * opened: see ScriptResourceRouteHandler#isPackageContainer. Absent (falsy)
   * on every ordinary script.
   */
  isFolder?: boolean;
  /**
   * For a Web Dev endpoint: the HTTP methods it actually implements.
   *
   * Absent for every other type. Sent on the LISTING so the tree can show an
   * endpoint's verbs without a request per endpoint.
   */
  methods?: string[];
  /**
   * For a Web Dev endpoint: WHICH of the two shapes the platform wrote.
   *
   * `'python'` is a set of `do<Verb>.py` handlers — what this module assumed
   * every Web Dev resource was until 1.9.0. `'text'` is a static file whose
   * whole body is a string inside `config.json`, with a `contentType` beside
   * it; `cell3d` on the demo gateway is 65 KB of HTML held that way, and under
   * the old model it rendered as eight empty verb slots with an "add doGet"
   * button that would have put Python onto a static HTML resource.
   *
   * Absent for every other resource type, and absent from an older gateway
   * response — treat that as `'python'`, which is what it always was.
   */
  webdevKind?: 'python' | 'text';
  /** A text resource's declared MIME type, e.g. `text/html`. */
  contentType?: string;
  /**
   * Static files the endpoint carries beside its handlers.
   *
   * `lib` ships `three.min.js` this way. These were readable through the
   * content route the whole time and appeared nowhere in the UI.
   */
  files?: WebDevFile[];
  /**
   * The event script's `enabled` attribute, when it has one.
   *
   * On the listing because the Designer badges a disabled script in its tree,
   * and asking per row would be one request per gateway event script.
   */
  enabled?: boolean;
  /**
   * Singletons only: whether the resource actually carries a script yet.
   *
   * The Designer shows Startup, Shutdown and Update whether or not they exist,
   * and renders the label bold once one does. Absent for every other type.
   */
  defined?: boolean;
}

export interface ScriptTree {
  project: string;
  mutable: boolean;
  scripts: ScriptEntry[];
}

export interface ScriptContent {
  /** The script body, byte-for-byte as stored. Never trimmed. */
  text: string;
  /** The ETag the read returned — the resource signature. */
  etag: string;
}

export interface SaveResult {
  ok: true;
  /** The signature AFTER the write; becomes the next call's base. */
  signature?: string;
}

/** Attribute values the API accepts. Types are exact — see ScriptResourceTypes. */
/**
 * A script resource attribute.
 *
 * `string[]` since 1.16.0: Tag Change's `paths` and `changeTypes` are JSON
 * ARRAYS on a real resource, and every other attribute on every other type is a
 * scalar. Storing them joined would round-trip through this module and be
 * unreadable to the Designer.
 */
export type AttributeValue = string | number | boolean | string[];

export interface ScriptAttributes {
  path: string;
  signature: string;
  /**
   * Attribute names this resource type accepts. Empty means body-only, and the
   * UI must then render no attribute controls at all — the server rejects a
   * write for those types rather than guessing what the Designer writes.
   */
  editable: string[];
  attributes: Record<string, AttributeValue>;
}

/**
 * An API failure carrying the server's status and its `{error: "..."}` message.
 *
 * The status is part of the contract, not diagnostics: 409 means somebody else
 * changed the resource and must open the conflict dialog rather than be reported
 * as a generic failure.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Concurrent edit — another Designer, or the web-designer module. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  /** The write arrived with no base signature; re-read and retry. */
  get isMissingBaseSignature(): boolean {
    return this.status === 428;
  }

  /**
   * The session is gone — the gateway restarted, or the session timed out.
   *
   * Its own predicate because it is the one failure where the message is the
   * least useful part of the answer. Nigel, 04/09/2026, on losing a session
   * mid-edit: *"it came up with an authentication error... now I could
   * potentially lose work. how are we managing this?"* — what the user needs
   * is a way back in and their buffer left alone, not the status.
   *
   * 403 counts as well as 401: the gateway answers 403 when the session is
   * valid but no longer carries the role, which happens on the same restart.
   */
  get isUnauthenticated(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Header the Gateway's WebUiSession CSRF filter reads. Must match exactly.
 *
 * Exported since 1.7.0 for the named-query client, which mirrors these routes
 * exactly. A second copy of the header name is a second thing to get wrong, and
 * the failure — the write rejected as cross-site — reads as a permissions
 * problem rather than a typo.
 */
export const CSRF_HEADER = 'X-CSRF-Token';

/**
 * URL for a per-resource route.
 *
 * `RouteGroup` matches `:path` as a SINGLE segment, so the resource path's own
 * slashes MUST be percent-encoded — `ignition/script-python/util/helpers`
 * becomes `ignition%2Fscript-python%2Futil%2Fhelpers`. Passing it raw produces
 * a multi-segment URL that matches no route and 404s, which reads exactly like
 * a missing script.
 */
export function scriptRouteUrl(base: '/api/scripts/content' | '/api/scripts/attributes' | '/api/scripts/inherited', path: string, project: string): string {
  const query = new URLSearchParams({ project });
  return `${apiUrl(`${base}/${encodeURIComponent(path)}`)}?${query.toString()}`;
}

/**
 * Turn a non-OK response into an ApiError carrying the server's message.
 *
 * Exported for the named-query client: the status codes ARE the contract there
 * too (428 no base, 409 stale), and a second implementation would be a second
 * place for a 409 to become a generic failure.
 */
export async function toApiError(response: Response): Promise<ApiError> {
  let message = `HTTP ${response.status}`;
  try {
    const text = await response.text();
    if (text) {
      // Error bodies are {error: "..."} — but a proxy or the servlet container
      // can answer with plain HTML, so parsing must not itself throw.
      try {
        // `error` is this module's own shape. `message` is what the servlet
        // container answers with — its 401 body is
        // `{"message":"Unauthorized","url":"...","status":"401"}`, and taking
        // the whole object put that JSON on screen verbatim under "Could not
        // save api:" (Nigel, 04/09/2026). Read the field, never the envelope.
        const parsed = JSON.parse(text) as { error?: string; message?: string };
        message = parsed.error ?? parsed.message ?? `HTTP ${response.status}`;
      } catch {
        // Not JSON at all: a proxy's HTML error page, most often. Its markup is
        // not a message either, so only short plain text is used.
        const plain = text.trim();
        message = plain.length <= 200 && !plain.startsWith('<')
          ? plain
          : `HTTP ${response.status}`;
      }
    }
  } catch {
    /* body unreadable — the status alone is the message */
  }
  return new ApiError(response.status, message);
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

/**
 * A precondition-carrying POST. Shared with the named-query client, which posts
 * to routes that mirror these ones header for header.
 */
export async function postJson(url: string, body: unknown, csrfToken: string | undefined, baseSignature: string): Promise<SaveResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // If-Match wins over the body's baseSignature server-side; both are sent so
    // the write still carries its precondition if a proxy strips the header.
    'If-Match': baseSignature,
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
  return (await response.json()) as SaveResult;
}

/** GET /api/projects */
export async function fetchProjects(): Promise<ProjectSummary[]> {
  const body = await getJson<{ projects: ProjectSummary[] }>(apiUrl('/api/projects'));
  return body.projects ?? [];
}

/** GET /api/scripts?project=X */
export async function fetchScriptTree(project: string): Promise<ScriptTree> {
  const query = new URLSearchParams({ project });
  const body = await getJson<ScriptTree>(`${apiUrl('/api/scripts')}?${query.toString()}`);
  return { ...body, scripts: body.scripts ?? [] };
}

/**
 * GET /api/scripts/content/:path — the raw body plus its ETag.
 *
 * The response is text/plain, NOT JSON: it is a Python source file and must not
 * pass through a JSON parser, which would normalise nothing useful and could
 * fail on a lone backslash.
 */
export async function readScriptContent(
  project: string,
  path: string,
  key?: string
): Promise<ScriptContent> {
  let url = scriptRouteUrl('/api/scripts/content', path, project);
  if (key) {
    url += `&key=${encodeURIComponent(key)}`;
  }
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return { text: await response.text(), etag: readEtag(response) };
}

/**
 * The ETag, stripped of the quoting an intermediary may add.
 *
 * The handler sets the bare signature, but a caching proxy is entitled to
 * rewrite it as `W/"..."`, and the server compares If-Match by exact string —
 * so a quoted value round-trips as a permanent 409.
 */
export function readEtag(response: Response): string {
  const raw = response.headers.get('ETag') ?? '';
  return raw.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

export interface SaveContentRequest {
  project: string;
  path: string;
  /** Sent verbatim. Nothing here trims it or appends a newline — see CodeEditor. */
  source: string;
  /** The resource's own script data key, from the listing. */
  key?: string;
  /** The ETag from the read this edit started from. */
  baseSignature: string;
  csrfToken?: string;
}

/** POST /api/scripts/content/:path */
export function saveScriptContent(request: SaveContentRequest): Promise<SaveResult> {
  return postJson(
    scriptRouteUrl('/api/scripts/content', request.path, request.project),
    { source: request.source, key: request.key, baseSignature: request.baseSignature },
    request.csrfToken,
    request.baseSignature
  );
}

/** GET /api/scripts/attributes/:path */
export async function readScriptAttributes(project: string, path: string): Promise<ScriptAttributes> {
  const body = await getJson<ScriptAttributes>(
    scriptRouteUrl('/api/scripts/attributes', path, project)
  );
  return { ...body, editable: body.editable ?? [], attributes: body.attributes ?? {} };
}

export interface SaveAttributesRequest {
  project: string;
  path: string;
  attributes: Record<string, AttributeValue>;
  baseSignature: string;
  csrfToken?: string;
}

/** POST /api/scripts/attributes/:path */
export function saveScriptAttributes(request: SaveAttributesRequest): Promise<SaveResult> {
  return postJson(
    scriptRouteUrl('/api/scripts/attributes', request.path, request.project),
    { attributes: request.attributes, baseSignature: request.baseSignature },
    request.csrfToken,
    request.baseSignature
  );
}

// ==================== Create and delete ====================

/**
 * Create a new, empty Project Library script.
 *
 * There is no separate create route: POST to a path the project does not yet
 * define takes the server's create branch. The distinction that matters is the
 * PRECONDITION — a create must NOT send an If-Match, because there is no version
 * to match and sending one would make the server treat it as a modify of
 * something absent. So this deliberately does not go through {@link postJson},
 * which always sets the header.
 *
 * The body is created empty. The real Designer writes a zero-byte `code.py` for
 * a new library script, and matching that keeps a fresh script byte-identical
 * whichever tool made it.
 */
export async function createScript(request: {
  project: string;
  path: string;
  /** Initial body. Empty for a library script; a handler stub for an event. */
  source?: string;
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
    scriptRouteUrl('/api/scripts/content', request.path, request.project),
    {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      // No baseSignature: absent means create.
      body: JSON.stringify({ source: request.source ?? '' }),
    }
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as SaveResult;
}

/**
 * DELETE /api/scripts/content/:path
 *
 * `baseSignature` is REQUIRED by the server (428 without it) and is the reason a
 * delete cannot discard an edit the user never saw: if the script changed since
 * the tree was listed, this fails with a 409 instead of destroying the newer
 * version.
 */
export async function deleteScript(request: {
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
    scriptRouteUrl('/api/scripts/content', request.path, request.project),
    { method: 'DELETE', credentials: 'same-origin', headers }
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as { ok: true; deleted?: string };
}

/**
 * Validate a proposed Project Library script name, returning an error string or
 * null.
 *
 * This is a real constraint, not input hygiene: a library script's resource name
 * becomes its Python module path, so `my-utils` creates a module that cannot be
 * imported by any syntax Python has — `import project.my-utils` is a parse error.
 * The Designer refuses such a name and so must this. Folders are allowed, since
 * `util/helpers` is an ordinary package path, but each segment must independently
 * be a valid identifier.
 */
export function validateScriptName(name: string, typeId: ScriptTypeId = 'script-python'): string | null {
  // Gateway event scripts are named RESOURCES, not modules. The Designer's own
  // fixture is called "Probe Scheduled" — with a space — so applying the Python
  // identifier rule to them would refuse names the Designer creates every day.
  // Only the project library's names become import paths.
  if (typeId !== 'script-python') {
    return validateEventScriptName(name);
  }
  return validateLibraryName(name);
}

/**
 * A gateway event script name.
 *
 * Permissive on purpose — the name becomes a directory on the gateway, and the
 * platform accepts spaces. What is refused is what would break the addressing:
 * a path separator (the route matches one segment), a leading or trailing space
 * (invisible, and it round-trips into a directory name nobody can retype), and
 * control characters.
 */
function validateEventScriptName(name: string): string | null {
  if (!name || !name.trim()) {
    return 'Enter a name';
  }
  if (name !== name.trim()) {
    return 'Name cannot start or end with a space';
  }
  if (name.includes('/') || name.includes('\\')) {
    return 'Name cannot contain "/" or "\\"';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return 'Name cannot contain control characters';
  }
  if (name === '.' || name === '..') {
    return 'That name is reserved';
  }
  if (name.length > 120) {
    return 'Name is too long';
  }
  return null;
}

function validateLibraryName(name: string): string | null {
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
  const segments = name.split('/');
  for (const segment of segments) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return `"${segment}" is not a valid Python name — letters, digits and `
        + 'underscores only, and it cannot start with a digit';
    }
    if (PYTHON_KEYWORDS.has(segment)) {
      return `"${segment}" is a Python keyword, so the module could never be imported`;
    }
  }
  return null;
}

/**
 * Python 2.7 keywords. Jython 2.7 is what runs these scripts, so this is the
 * py2 list — `print` and `exec` ARE keywords here and `True`/`False`/`None` are
 * not, which is the opposite of Python 3 on three counts.
 */
const PYTHON_KEYWORDS = new Set([
  'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'exec', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'not', 'or', 'pass', 'print', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

// ==================== Local history (1.15.0) ====================

/** One version this IDE saved, from `GET /api/history`. */
export interface SavedVersion {
  id: string;
  /** Epoch millis. */
  savedAt: number;
  size: number;
}

export interface SavedVersions {
  versions: SavedVersion[];
  maxVersions: number;
}

function historyQuery(project: string, path: string, key?: string): string {
  const params = new URLSearchParams({ project, path });
  if (key) params.set('key', key);
  return params.toString();
}

/**
 * The versions this user has saved for one document, newest first.
 *
 * The user is never a parameter: the gateway resolves it from the session, so
 * there is no URL to edit into somebody else's history.
 */
export async function fetchHistory(
  project: string,
  path: string,
  key?: string
): Promise<SavedVersions> {
  // apiUrl, NOT a bare path. The SPA is served from `/data/scriptide/` on a
  // gateway and from `/` under `npm run dev`, so a hardcoded `/api/...` 404s on
  // the gateway and works everywhere it is tested with a mocked fetch. That is
  // exactly how these three routes shipped broken to the rig — caught by
  // validate_v13's console-error check, not by 588 unit tests.
  return getJson<SavedVersions>(`${apiUrl('/api/history')}?${historyQuery(project, path, key)}`);
}

/** One saved version's source. */
export async function readHistoryVersion(
  project: string,
  path: string,
  key: string | undefined,
  id: string
): Promise<string> {
  const response = await fetch(
    `${apiUrl('/api/history/content')}?${historyQuery(project, path, key)}`
      + `&id=${encodeURIComponent(id)}`,
    { credentials: 'same-origin', headers: { Accept: 'text/plain' } }
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.text();
}

// ==================== Runtime errors (1.15.0) ====================

/** One distinct problem the gateway has logged about a project. */
export interface RuntimeError {
  logger: string;
  level: string;
  message: string;
  /** Epoch millis of the most recent occurrence. */
  lastSeen: number;
  count: number;
  exception?: string;
}

/** How badly one gateway event script is doing, over the window. */
export interface ScriptHealth {
  script: string;
  count: number;
  lastSeen: number;
}

export interface RuntimeErrors {
  errors: RuntimeError[];
  /**
   * Per-script attribution, for badging a tree row.
   *
   * Only FAILURES: the SDK exposes no timer-task registry, so there is no last
   * fire or next fire to report. Inventing one from a log line that appears only
   * on failure would make a healthy script look like one that never runs.
   */
  byScript: ScriptHealth[];
  windowMinutes: number;
  /**
   * How an event was tied to this project, in the server's own words.
   *
   * Rendered verbatim rather than paraphrased: the match is by project NAME in
   * the message or logger, which is looser than "errors this project caused",
   * and the panel must not imply the stronger claim.
   */
  matchedBy: string;
}

/** What this project's scripts have actually thrown, from the gateway log. */
export async function fetchRuntimeErrors(
  project: string,
  minutes?: number
): Promise<RuntimeErrors> {
  const params = new URLSearchParams({ project });
  if (minutes) params.set('minutes', String(minutes));
  return getJson<RuntimeErrors>(`${apiUrl('/api/runtime/errors')}?${params.toString()}`);
}

// ==================== Rename, parent compare (1.16.0) ====================

export interface RenameResult {
  ok: true;
  /** The new resource path, as the listing spells it. */
  path: string;
  /** Dotted module names, present only for a library script. */
  oldModule?: string;
  newModule?: string;
  signature?: string;
}

/**
 * Move one script to a new path.
 *
 * One resource only — never a folder. See the handler's Javadoc: a folder move
 * is a multi-resource push with subtree collision checking, and a half-version
 * that moved direct children only would be worse than none.
 */
export async function renameScript(request: {
  project: string;
  path: string;
  newPath: string;
  baseSignature: string;
  csrfToken?: string;
}): Promise<RenameResult> {
  const query = new URLSearchParams({ project: request.project });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'If-Match': request.baseSignature,
  };
  if (request.csrfToken) headers[CSRF_HEADER] = request.csrfToken;
  const response = await fetch(`${apiUrl('/api/scripts/rename')}?${query.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      path: request.path,
      newPath: request.newPath,
      baseSignature: request.baseSignature,
    }),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as RenameResult;
}

/** A parent project's copy of a resource, and which project it came from. */
export interface InheritedCopy {
  text: string;
  parent: string;
}

/**
 * The parent project's copy, for comparing an override against what it
 * overrides. Throws a 404 ApiError when no ancestor has one.
 */
export async function readInheritedContent(
  project: string,
  path: string,
  key?: string
): Promise<InheritedCopy> {
  let url = scriptRouteUrl('/api/scripts/inherited', path, project);
  if (key) url += `&key=${encodeURIComponent(key)}`;
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'text/plain' },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return {
    text: await response.text(),
    parent: response.headers.get('X-Parent-Project') ?? 'the parent project',
  };
}

// ==================== Run history (R3, 1.16.0) ====================

/** One finished console execution, kept across gateway restarts. */
export interface PastRun {
  id: string;
  at: number;
  project: string;
  source: string;
  output: string;
  ok: boolean;
  error?: string;
  outputTruncated: boolean;
  /**
   * Wall milliseconds the run took, or 0 for a record kept before 1.23.0.
   *
   * Zero is "not known", not "instant" — the dialog leaves the column blank
   * rather than claiming a run that took a second finished in none.
   */
  durationMs: number;
}

export interface PastRuns {
  runs: PastRun[];
  maxRuns: number;
}

/**
 * What this user has run, newest first.
 *
 * Read from the run store, not the audit profile: the audit keeps a HASH of the
 * source by design, so it can say a run happened and never what was run.
 */
export async function fetchRuns(): Promise<PastRuns> {
  return getJson<PastRuns>(apiUrl('/api/runs'));
}
