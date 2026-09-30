import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CSRF_HEADER } from './scripts';
import {
  applyImport,
  exportScripts,
  filenameFrom,
  inspectImport,
} from './transfer';
import { apiUrl } from './urls';

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

describe('transfer client urls', () => {
  // The RESOLVED url, not merely that fetch was called: a mocked fetch accepts
  // any string, and three routes shipped to the rig broken that way at 1.15.0.
  it('resolves the export route through apiUrl, with one path parameter each', async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }));
    await exportScripts('MyProject', ['a/b', 'c/d']);
    expect(calledUrl().startsWith(apiUrl('/api/scripts/export'))).toBe(true);
    // Repeated, never delimited — a resource path already contains slashes and
    // dots, and every delimiter tried in this module turned out to be a
    // character some real path contains.
    expect(calledUrl()).toContain('path=a%2Fb');
    expect(calledUrl()).toContain('path=c%2Fd');
    expect(calledUrl()).toContain('project=MyProject');
  });

  it('resolves the inspect route, and sends the CSRF token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ entries: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await inspectImport('MyProject', new Blob(['zip']), 'tok');
    expect(calledUrl().startsWith(apiUrl('/api/scripts/import/inspect'))).toBe(true);
    expect(calledInit().method).toBe('POST');
    expect((calledInit().headers as Record<string, string>)[CSRF_HEADER]).toBe('tok');
  });

  it('resolves the import route and carries the selection', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, written: 1, results: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await applyImport('MyProject', ['x/y'], new Blob(['zip']), 'tok');
    expect(calledUrl().startsWith(apiUrl('/api/scripts/import'))).toBe(true);
    // NOT the inspect route: `/api/scripts/import` is a prefix of
    // `/api/scripts/import/inspect`, so a startsWith check alone would pass for
    // either and the write could be going to the read.
    expect(calledUrl()).not.toContain('/inspect');
    expect(calledUrl()).toContain('path=x%2Fy');
  });

  it('raises an ApiError rather than returning a broken blob', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'nope' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(exportScripts('P', ['a'])).rejects.toThrow();
  });
});

describe('filenameFrom', () => {
  it('reads the name the server chose', () => {
    expect(filenameFrom('attachment; filename="Mining_Demo_2026-09-07_0330.zip"'))
      .toBe('Mining_Demo_2026-09-07_0330.zip');
    expect(filenameFrom('attachment; filename=plain.zip')).toBe('plain.zip');
  });

  it('falls back rather than failing when a proxy drops the header', () => {
    // A rewritten or absent header must cost a worse filename, never a failed
    // download.
    expect(filenameFrom(null)).toBe('project-export.zip');
    expect(filenameFrom('attachment')).toBe('project-export.zip');
  });
});
