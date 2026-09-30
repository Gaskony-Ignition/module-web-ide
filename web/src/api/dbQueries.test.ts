import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelDbQuery,
  fetchDbColumns,
  fetchDbDatasources,
  fetchDbQueryHistory,
  fetchDbTables,
  isDbQueryResultSet,
  runDbQuery,
  type DbQueryResult,
} from './dbQueries';

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

describe('fetchDbDatasources', () => {
  it('unwraps the envelope', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ datasources: [{ name: 'MyDb', status: 'VALID' }] })
    );
    const datasources = await fetchDbDatasources();
    expect(datasources).toEqual([{ name: 'MyDb', status: 'VALID' }]);
    expect(calledUrl()).toContain('/api/db-queries/datasources');
  });

  it('throws on a non-OK response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    await expect(fetchDbDatasources()).rejects.toMatchObject({ status: 403 });
  });
});

describe('fetchDbTables / fetchDbColumns', () => {
  it('sends the datasource as a query parameter, and unwraps schema-qualified tables plus connection facts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      tables: [
        { schema: 'public', name: 'Orders', type: 'TABLE' },
        { schema: 'public', name: 'V_Orders', type: 'VIEW' },
      ],
      defaultSchema: 'public',
      identifierQuote: '"',
      storesLowerCaseIdentifiers: true,
      storesUpperCaseIdentifiers: false,
      databaseProductName: 'PostgreSQL',
    }));
    const tables = await fetchDbTables('MyDb');
    expect(tables).toEqual({
      tables: [
        { schema: 'public', name: 'Orders', type: 'TABLE' },
        { schema: 'public', name: 'V_Orders', type: 'VIEW' },
      ],
      truncated: false,
      facts: {
        defaultSchema: 'public',
        identifierQuote: '"',
        storesLowerCaseIdentifiers: true,
        storesUpperCaseIdentifiers: false,
        databaseProductName: 'PostgreSQL',
      },
    });
    expect(calledUrl()).toContain('/api/db-queries/tables?datasource=MyDb');
  });

  it('reports truncation when the server flags it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      tables: [{ schema: null, name: 'Orders', type: 'TABLE' }], truncated: true,
    }));
    const tables = await fetchDbTables('MyDb');
    expect(tables.truncated).toBe(true);
  });

  it('falls back to safe connection facts when the server omits them', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ tables: [] }));
    const tables = await fetchDbTables('MyDb');
    expect(tables.facts).toEqual({
      defaultSchema: null,
      identifierQuote: '"',
      storesLowerCaseIdentifiers: false,
      storesUpperCaseIdentifiers: false,
      databaseProductName: null,
    });
  });

  it('sends both the datasource and the table', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ columns: [{ name: 'id', type: 'int4' }] }));
    const columns = await fetchDbColumns('MyDb', 'Orders');
    expect(columns).toEqual({ columns: [{ name: 'id', type: 'int4' }], truncated: false });
    const url = calledUrl();
    expect(url).toContain('datasource=MyDb');
    expect(url).toContain('table=Orders');
    expect(url).not.toContain('schema=');
  });

  it('sends the schema when one is given, for a table outside the default schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ columns: [] }));
    await fetchDbColumns('MyDb', 'Orders', 'reporting');
    expect(calledUrl()).toContain('schema=reporting');
  });
});

describe('runDbQuery', () => {
  it('sends the runId it was given, the datasource, the sql and the CSRF header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, runId: 'r1', elapsedMs: 5, results: [{ affected: 1 }] })
    );
    await runDbQuery({
      runId: 'r1',
      datasource: 'MyDb',
      sql: 'UPDATE t SET x=1',
      maxRows: 500,
      project: 'P',
      csrfToken: 'tok',
    });
    expect(calledUrl()).toContain('/api/db-queries/run');
    expect(headers()['X-CSRF-Token']).toBe('tok');
    expect(JSON.parse(String(calledInit().body))).toEqual({
      runId: 'r1',
      datasource: 'MyDb',
      sql: 'UPDATE t SET x=1',
      maxRows: 500,
      project: 'P',
    });
  });

  it('returns a failed query as a RESULT, not a thrown error', async () => {
    // A SQL error is a 200 with `{ok:false, error}` — a result to render, not a
    // transport failure, exactly like the named-query test route.
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: false, runId: 'r1', elapsedMs: 3,
        error: { type: 'SQLException', message: 'no such table', frames: [] },
      })
    );
    const result = await runDbQuery({ runId: 'r1', datasource: 'MyDb', sql: 'bad' });
    expect(result.ok).toBe(false);
  });

  it('omits recordHistory from the body when not given, so the server sees its own default', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: 'r1', elapsedMs: 5, results: [] }));
    await runDbQuery({ runId: 'r1', datasource: 'MyDb', sql: 'SELECT 1' });
    expect(JSON.parse(String(calledInit().body))).not.toHaveProperty('recordHistory');
  });

  it('sends recordHistory:false for an auto-refresh run', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: 'r1', elapsedMs: 5, results: [] }));
    await runDbQuery({ runId: 'r1', datasource: 'MyDb', sql: 'SELECT 1', recordHistory: false });
    expect(JSON.parse(String(calledInit().body))).toMatchObject({ recordHistory: false });
  });

  it('omits readOnly from the body when not given, so the server sees its own default', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: 'r1', elapsedMs: 5, results: [] }));
    await runDbQuery({ runId: 'r1', datasource: 'MyDb', sql: 'SELECT 1' });
    expect(JSON.parse(String(calledInit().body))).not.toHaveProperty('readOnly');
  });

  it('sends readOnly:true for an auto-refresh run', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, runId: 'r1', elapsedMs: 5, results: [] }));
    await runDbQuery({
      runId: 'r1', datasource: 'MyDb', sql: 'SELECT 1', recordHistory: false, readOnly: true,
    });
    expect(JSON.parse(String(calledInit().body))).toMatchObject({ recordHistory: false, readOnly: true });
  });

  it('still throws when the gateway itself refuses the call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Script execution is disabled' }, 403));
    await expect(
      runDbQuery({ runId: 'r1', datasource: 'MyDb', sql: 'SELECT 1' })
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('cancelDbQuery', () => {
  it('sends the runId and the CSRF header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    const cancelled = await cancelDbQuery({ runId: 'r1', csrfToken: 'tok' });
    expect(cancelled).toBe(true);
    expect(calledUrl()).toContain('/api/db-queries/cancel');
    expect(headers()['X-CSRF-Token']).toBe('tok');
    expect(JSON.parse(String(calledInit().body))).toEqual({ runId: 'r1' });
  });

  it('answers false rather than throwing when the run already finished', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'No such run' }, 404));
    await expect(cancelDbQuery({ runId: 'r1' })).resolves.toBe(false);
  });

  it('still throws for a status other than 404', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    await expect(cancelDbQuery({ runId: 'r1' })).rejects.toMatchObject({ status: 403 });
  });
});

describe('fetchDbQueryHistory', () => {
  it('returns the envelope, runs and maxRuns both', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ runs: [{ id: '1', at: 1, datasource: 'MyDb', sql: 'SELECT 1', ok: true, summary: '1 row', durationMs: 2 }], maxRuns: 50 })
    );
    const history = await fetchDbQueryHistory();
    expect(history.maxRuns).toBe(50);
    expect(history.runs).toHaveLength(1);
    expect(calledUrl()).toContain('/api/db-queries/history');
  });
});

describe('isDbQueryResultSet', () => {
  it('narrows on the presence of rows, not on a discriminant field', () => {
    const rows: DbQueryResult = { columns: [], rows: [[1]], rowCount: 1 };
    const affected: DbQueryResult = { affected: 3 };
    expect(isDbQueryResultSet(rows)).toBe(true);
    expect(isDbQueryResultSet(affected)).toBe(false);
  });
});
