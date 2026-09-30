import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
} from './scripts';
import {
  CACHE_UNITS,
  PARAMETER_TYPES,
  PARAMETER_TYPE_LABELS,
  QUERY_TYPES,
  SQL_TYPES,
  createNamedQuery,
  deleteNamedQuery,
  emptySettings,
  fetchNamedQueries,
  isRowsResult,
  isScalarResult,
  isUpdateResult,
  namedQueryName,
  namedQueryPath,
  namedQueryRouteUrl,
  normaliseParameterType,
  stripResourcePrefix,
  readNamedQuerySettings,
  readNamedQuerySql,
  renameNamedQuery,
  saveNamedQuerySettings,
  saveNamedQuerySql,
  testRunNamedQuery,
  validateNamedQueryName,
  validateParameterIdentifier,
  type NamedQuerySettings,
  type TestRunResult,
} from './namedQueries';

/**
 * The path a route takes: the query's path INSIDE the project.
 *
 * No `ignition/named-query/` prefix, unlike every script route in this client —
 * it is the same string `system.db.runNamedQuery` takes.
 */
const PATH = 'Orders/Daily/Totals';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function calledUrl(index = 0): string {
  return String(fetchMock.mock.calls[index][0]);
}

function calledInit(index = 0): RequestInit {
  return fetchMock.mock.calls[index][1] as RequestInit;
}

function headers(index = 0): Record<string, string> {
  return calledInit(index).headers as Record<string, string>;
}

describe('the platform vocabulary', () => {
  // Measured off the jars and the running 8.3.8 gateway, NAMED-QUERIES.md
  // §1.1–1.2. Widening any of these from memory writes a value the platform
  // never reads, silently — which is what `dataType`/`Date` already did on this
  // rig.
  it('names the three query types the way the wire does, not the way toString does', () => {
    expect(QUERY_TYPES).toEqual(['Query', 'ScalarQuery', 'UpdateQuery']);
    expect(QUERY_TYPES).not.toContain('Scalar Query');
  });

  it('carries the ten parameter SQL types and, in particular, no Date', () => {
    expect(SQL_TYPES).toHaveLength(10);
    expect(SQL_TYPES).toContain('DateTime');
    expect(SQL_TYPES as readonly string[]).not.toContain('Date');
  });

  it('uses TimeUnits for caching, which has MONTH and YEAR that TimeUnit has not', () => {
    expect(CACHE_UNITS).toEqual(['MS', 'SEC', 'MIN', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR']);
  });

  it('names the third parameter type Parameter — "Value" is only its label', () => {
    // ParameterType.Parameter.toString() returns "Value", exactly as
    // Type.ScalarQuery.toString() returns "Scalar Query". This client emitted
    // the LABEL on the wire until the enum was read off the running gateway.
    expect(PARAMETER_TYPES).toEqual(['Database', 'QueryString', 'Parameter']);
    expect(PARAMETER_TYPES as readonly string[]).not.toContain('Value');
    expect(PARAMETER_TYPE_LABELS.Parameter).toBe('Value');
  });

  it('accepts "Value" on the way in as the documented alias, and never emits it', () => {
    expect(normaliseParameterType('Value')).toBe('Parameter');
    expect(normaliseParameterType('Parameter')).toBe('Parameter');
    expect(normaliseParameterType('QueryString')).toBe('QueryString');
  });

  it('has eight cache units, MS included', () => {
    // Seven here until the enum was measured, which is one unit a user could
    // not have chosen and a value the server would have had to reject.
    expect(CACHE_UNITS).toHaveLength(8);
    expect(CACHE_UNITS[0]).toBe('MS');
  });

  it('starts a query on the PLATFORM\u2019s own defaults, not on zeroes', () => {
    // Measured off a fresh NamedQuery: 100 rows, one cache unit, and one empty
    // zone/role requirement already in the list. Zeroes here would show values
    // the gateway does not have, and the first save would write them.
    const fresh = emptySettings();
    expect(fresh.type).toBe('Query');
    expect(fresh.enabled).toBe(true);
    expect(fresh.database).toBe('');
    expect(fresh.maxReturnSize).toBe(100);
    expect(fresh.useMaxReturnSize).toBe(false);
    expect(fresh.cacheAmount).toBe(1);
    expect(fresh.cacheUnit).toBe('SEC');
    expect(fresh.cacheEnabled).toBe(false);
    expect(fresh.permissions).toEqual([{ zone: '', role: '' }]);
    expect(fresh.parameters).toEqual([]);
  });
});

describe('namedQueryRouteUrl', () => {
  // RouteGroup matches :path as ONE segment. A raw path produces a
  // multi-segment URL that matches no route and 404s, which reads exactly like
  // a missing query.
  it('percent-encodes the resource path into a single URL segment', () => {
    const url = namedQueryRouteUrl('/api/named-queries/content', PATH, 'MyProject');
    expect(url).toContain('Orders%2FDaily%2FTotals');
    expect(url).not.toContain('content/Orders/Daily');
  });

  it('carries the project as a query parameter, not a path segment', () => {
    const url = namedQueryRouteUrl('/api/named-queries/settings', PATH, 'My Project');
    expect(url).toContain('?project=My+Project');
  });
});

describe('fetchNamedQueries', () => {
  it('passes the project and tolerates a listing with no queries', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: 'P', mutable: true }));
    const list = await fetchNamedQueries('P');
    expect(calledUrl()).toContain('/api/named-queries?project=P');
    expect(list.queries).toEqual([]);
    expect(calledInit().credentials).toBe('same-origin');
  });
});

describe('readNamedQuerySql', () => {
  it('returns the SQL byte-for-byte and the ETag as the signature', async () => {
    // Tabs and no trailing newline, exactly as for a script body.
    const sql = 'SELECT *\n\tFROM orders\n\tWHERE id = :id';
    fetchMock.mockResolvedValue(new Response(sql, { status: 200, headers: { ETag: 'sig-1' } }));
    const content = await readNamedQuerySql('P', PATH);
    expect(content.sql).toBe(sql);
    expect(content.etag).toBe('sig-1');
  });

  it('strips the quoting a proxy may add to the ETag', async () => {
    // The server compares If-Match by exact string, so a quoted value would
    // round-trip as a permanent 409 that reads on screen as somebody else
    // editing the query.
    fetchMock.mockResolvedValue(new Response('x', { status: 200, headers: { ETag: 'W/"sig-2"' } }));
    await expect(readNamedQuerySql('P', PATH)).resolves.toMatchObject({ etag: 'sig-2' });
  });

  it('throws a typed error carrying the server message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'No such named query: x' }, 404));
    await expect(readNamedQuerySql('P', PATH)).rejects.toMatchObject({
      status: 404,
      message: 'No such named query: x',
    });
  });
});

describe('saveNamedQuerySql', () => {
  it('sends the CSRF token, the If-Match precondition and the SQL verbatim', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-2' }));
    const sql = 'SELECT 1\n\t';
    const result = await saveNamedQuerySql({
      project: 'P',
      path: PATH,
      sql,
      baseSignature: 'sig-1',
      csrfToken: 'tok',
    });
    expect(calledInit().method).toBe('POST');
    expect(headers()['X-CSRF-Token']).toBe('tok');
    expect(headers()['If-Match']).toBe('sig-1');
    expect(JSON.parse(String(calledInit().body))).toEqual({ sql, baseSignature: 'sig-1' });
    expect(result.signature).toBe('sig-2');
  });

  it('reports a 409 as a conflict rather than a generic failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'changed on the gateway' }, 409));
    const failure = (await saveNamedQuerySql({
      project: 'P', path: PATH, sql: 'x', baseSignature: 'sig-1',
    }).catch((e: unknown) => e)) as ApiError;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.isConflict).toBe(true);
    expect(failure.isMissingBaseSignature).toBe(false);
  });

  it('distinguishes a missing base signature (428) from a conflict', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Missing If-Match' }, 428));
    const failure = (await saveNamedQuerySql({
      project: 'P', path: PATH, sql: 'x', baseSignature: '',
    }).catch((e: unknown) => e)) as ApiError;
    expect(failure.isMissingBaseSignature).toBe(true);
    expect(failure.isConflict).toBe(false);
  });

  it('omits the CSRF header when the session had no token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await saveNamedQuerySql({ project: 'P', path: PATH, sql: 'x', baseSignature: 's' });
    expect(Object.keys(headers())).not.toContain('X-CSRF-Token');
  });
});

describe('settings', () => {
  const settings: NamedQuerySettings = {
    ...emptySettings(),
    type: 'ScalarQuery',
    database: 'Postgres_Test',
    cacheEnabled: true,
    cacheAmount: 30,
    cacheUnit: 'MIN',
    parameters: [{ type: 'Parameter', identifier: 'orderId', sqlType: 'Int4' }],
  };

  it('reads the settings, the connections and the editable allowlist', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        settings, signature: 'sig-9', databases: ['Postgres_Test'], editable: ['type'],
      })
    );
    const read = await readNamedQuerySettings('P', PATH);
    expect(read.signature).toBe('sig-9');
    expect(calledUrl()).toContain('/api/named-queries/settings/Orders%2FDaily%2FTotals');
    expect(read.settings.cacheUnit).toBe('MIN');
    expect(read.databases).toEqual(['Postgres_Test']);
    expect(read.editable).toEqual(['type']);
  });

  it('normalises a "Value" parameter type on the way in, once, at the edge', async () => {
    // Left as the alias it would read as clean against a `Parameter` base,
    // render as an unselected dropdown, and post a name the server has to
    // translate back.
    fetchMock.mockResolvedValue(
      jsonResponse({
        settings: { ...settings, parameters: [{ type: 'Value', identifier: 'v', sqlType: 'String' }] },
        signature: 's',
      })
    );
    const read = await readNamedQuerySettings('P', PATH);
    expect(read.settings.parameters[0].type).toBe('Parameter');
  });

  it('reports a legacy resource, so the editor can say why the form is empty', async () => {
    // A version-1 resource reads back as the platform's defaults because the
    // platform cannot read it either — an ordinary-looking form for a query
    // that does not run.
    fetchMock.mockResolvedValue(jsonResponse({ settings, signature: 's', legacy: true, version: 1 }));
    const read = await readNamedQuerySettings('P', PATH);
    expect(read.legacy).toBe(true);
    expect(read.version).toBe(1);
  });

  it('says a current resource is not legacy rather than leaving it undefined', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ settings, signature: 's', version: 2 }));
    await expect(readNamedQuerySettings('P', PATH)).resolves.toMatchObject({ legacy: false });
  });

  it('fills in the whole vocabulary when the server sends a partial object', async () => {
    // Every control reads a field off this object, so a missing key would put
    // an uncontrolled input on screen and lose whatever was typed into it.
    fetchMock.mockResolvedValue(jsonResponse({ settings: { type: 'UpdateQuery' }, signature: 's' }));
    const read = await readNamedQuerySettings('P', PATH);
    expect(read.settings.type).toBe('UpdateQuery');
    expect(read.settings.cacheUnit).toBe('SEC');
    expect(read.settings.maxReturnSize).toBe(100);
    expect(read.settings.parameters).toEqual([]);
    expect(read.databases).toEqual([]);
  });

  it('writes the settings against the same signature the SQL uses', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-10' }));
    await saveNamedQuerySettings({
      project: 'P', path: PATH, settings, baseSignature: 'sig-9', csrfToken: 'tok',
    });
    expect(headers()['If-Match']).toBe('sig-9');
    expect(JSON.parse(String(calledInit().body))).toEqual({ settings, baseSignature: 'sig-9' });
  });
});

describe('createNamedQuery', () => {
  it('sends NO If-Match, because a create has no version to match', async () => {
    // Sending one makes the server read the write as a modify of something
    // absent, which comes back as a 428 the user reads as a bug in this IDE.
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-1' }));
    await createNamedQuery({ project: 'P', path: PATH, csrfToken: 'tok' });
    expect(Object.keys(headers())).not.toContain('If-Match');
    expect(headers()['X-CSRF-Token']).toBe('tok');
    expect(JSON.parse(String(calledInit().body))).toEqual({ sql: '' });
  });

  it('sends settings in the SAME push as the sql, one write rather than two', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-1' }));
    const settings = { ...emptySettings(), type: 'Query' as const, database: 'Postgres_Test' };
    await createNamedQuery({
      project: 'P', path: PATH, sql: 'SELECT 1', settings, csrfToken: 'tok',
    });
    expect(Object.keys(headers())).not.toContain('If-Match');
    expect(JSON.parse(String(calledInit().body))).toEqual({ sql: 'SELECT 1', settings });
  });
});

describe('deleteNamedQuery', () => {
  it('requires the base signature, so a delete cannot discard an unseen edit', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, deleted: PATH }));
    await deleteNamedQuery({ project: 'P', path: PATH, baseSignature: 'sig-1' });
    expect(calledInit().method).toBe('DELETE');
    expect(headers()['If-Match']).toBe('sig-1');
  });
});

describe('renameNamedQuery', () => {
  it('posts both paths with the SOURCE signature as the precondition', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-2' }));
    await renameNamedQuery({
      project: 'P',
      path: PATH,
      newPath: 'Orders/Totals',
      baseSignature: 'sig-1',
      csrfToken: 'tok',
    });
    expect(calledUrl()).toContain('/api/named-queries/rename?project=P');
    expect(headers()['If-Match']).toBe('sig-1');
    expect(JSON.parse(String(calledInit().body))).toEqual({
      path: PATH,
      newPath: 'Orders/Totals',
    });
  });
});

describe('renameNamedQuery — a folder', () => {
  it('sends NO If-Match for a folder, which is not a resource to have a version', () => {
    // A folder is implied by the paths beneath it. Requiring a precondition for
    // one would make it unmovable, which is why the contract drops it here.
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, moved: 4 }));
    return renameNamedQuery({ project: 'P', path: 'Orders', newPath: 'Sales' }).then(() => {
      expect(Object.keys(headers())).not.toContain('If-Match');
      expect(JSON.parse(String(calledInit().body))).toEqual({ path: 'Orders', newPath: 'Sales' });
    });
  });

  it('still sends one where the gateway holds a folder RESOURCE', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await renameNamedQuery({
      project: 'P', path: 'Orders', newPath: 'Sales', baseSignature: 'sig-folder',
    });
    expect(headers()['If-Match']).toBe('sig-folder');
  });
});

describe('testRunNamedQuery', () => {
  it('sends the DRAFT — the path, the parameters, and the SQL and settings on screen', async () => {
    // The tab tests what you are looking at. The path still identifies the
    // resource, which is what resolves inheritance, permissions and the audit
    // line; the sql and settings are what actually runs.
    const settings = { ...emptySettings(), type: 'ScalarQuery' as const };
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, type: 'ScalarQuery', value: 1 }));
    await testRunNamedQuery({
      project: 'P',
      path: PATH,
      parameters: { orderId: '7' },
      sql: 'SELECT :orderId',
      settings,
      csrfToken: 'tok',
    });
    expect(calledUrl()).toContain('/api/named-queries/test?project=P');
    // No precondition: a test run writes no resource, so there is no version to
    // assert.
    expect(Object.keys(headers())).not.toContain('If-Match');
    expect(JSON.parse(String(calledInit().body))).toEqual({
      path: PATH,
      parameters: { orderId: '7' },
      sql: 'SELECT :orderId',
      settings,
    });
  });

  it('returns a failed query as a RESULT, not a thrown error', async () => {
    // A SQL error is a 200 with `{ok:false, error}` — it is something to render
    // in the Testing tab, where a transport failure is not.
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: false, error: { type: 'SQLException', message: 'no such table', frames: [] } })
    );
    const result = await testRunNamedQuery({ project: 'P', path: PATH, parameters: {} });
    expect(result.ok).toBe(false);
  });

  it('still throws when the gateway itself refuses the call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    await expect(
      testRunNamedQuery({ project: 'P', path: PATH, parameters: {} })
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('narrowing a test result', () => {
  it('narrows on `type`, which is on every result including the failure', () => {
    expect(isRowsResult({ ok: true, type: 'Query', columns: [], rows: [], rowCount: 0 })).toBe(true);
    expect(isUpdateResult({ ok: true, type: 'UpdateQuery', affected: 0 })).toBe(true);
    expect(isScalarResult({ ok: true, type: 'ScalarQuery', value: null })).toBe(true);
  });

  it('falls back to the payload when a result carries no type', () => {
    // Kept as a fallback rather than removed: a result whose type is missing
    // still has to render as something, and rows/affected/value are
    // unambiguous on their own. Without it one absent field is a blank panel.
    const rows: TestRunResult = { ok: true, columns: [], rows: [[1]], rowCount: 1 };
    expect(isRowsResult(rows)).toBe(true);
    expect(isScalarResult(rows)).toBe(false);
    const update: TestRunResult = { ok: true, affected: 3 };
    expect(isUpdateResult(update)).toBe(true);
    expect(isRowsResult(update)).toBe(false);
    expect(isScalarResult({ ok: true, value: 42 })).toBe(true);
  });

  it('never calls a failure one of the three success shapes', () => {
    const failure: TestRunResult = {
      ok: false, type: 'Query', error: { type: 'E', message: 'm', frames: [] },
    };
    expect(isRowsResult(failure)).toBe(false);
    expect(isUpdateResult(failure)).toBe(false);
    expect(isScalarResult(failure)).toBe(false);
  });
});

describe('the path a route takes', () => {
  it('is the query name itself — these routes carry no resource-type prefix', () => {
    // Building `ignition/named-query/...` here 404s every call, which reads
    // exactly like a missing query. This client did that until the contract was
    // reconciled.
    expect(namedQueryPath('Orders/Totals')).toBe('Orders/Totals');
    expect(namedQueryName('Orders/Totals')).toBe('Orders/Totals');
  });

  it('tolerates the resource-shaped form a saved link or an LSP location holds', () => {
    expect(stripResourcePrefix('ignition/named-query/Orders/Totals')).toBe('Orders/Totals');
    expect(stripResourcePrefix('Orders/Totals')).toBe('Orders/Totals');
  });
});

describe('validateNamedQueryName', () => {
  // The PLATFORM's rule, not Python's: a query name is a resource path segment
  // and a runNamedQuery key, never a module name.
  it('accepts a hyphen, which a library script name may not have', () => {
    expect(validateNamedQueryName('Orders/Order-Intake')).toBeNull();
  });

  it('accepts folders, digits and underscores', () => {
    expect(validateNamedQueryName('A1/b_2/C-3')).toBeNull();
  });

  it('refuses a leading, trailing or doubled separator', () => {
    expect(validateNamedQueryName('/Orders')).not.toBeNull();
    expect(validateNamedQueryName('Orders/')).not.toBeNull();
    expect(validateNamedQueryName('Orders//Totals')).not.toBeNull();
  });

  it('refuses spaces and punctuation the resource path could not carry', () => {
    expect(validateNamedQueryName('Daily Totals')).not.toBeNull();
    expect(validateNamedQueryName('Totals!')).not.toBeNull();
  });

  it('says nothing useful about an empty field beyond asking for a name', () => {
    expect(validateNamedQueryName('')).toBe('Enter a name');
  });
});

describe('validateParameterIdentifier', () => {
  it('requires a Python identifier, because the value is read out of a dict by it', () => {
    expect(validateParameterIdentifier('orderId', [])).toBeNull();
    expect(validateParameterIdentifier('1st', [])).not.toBeNull();
    expect(validateParameterIdentifier('order id', [])).not.toBeNull();
  });

  it('refuses a duplicate, which would silently shadow the other parameter', () => {
    expect(validateParameterIdentifier('id', ['id'])).toContain('another parameter');
  });
});
