import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CSRF_HEADER } from './scripts';
import { organiseImports } from './imports';
import { apiUrl } from './urls';

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

describe('organiseImports', () => {
  // The resolved url, not merely that fetch was called — a hardcoded '/api/...'
  // passes every mocked-fetch test and 404s on a real gateway, where the SPA is
  // served from /data/scriptide/.
  it('resolves through apiUrl, with the project on the query string', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ source: 'import os\n', removed: [], notes: [], suggestions: [] })
    );
    await organiseImports('MyProject', 'import os\n');
    expect(calledUrl().startsWith(apiUrl('/api/scripts/organise-imports'))).toBe(true);
    expect(calledUrl()).toContain('project=MyProject');
  });

  it('POSTs the source as JSON, with no If-Match — there is no resource version here', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ source: 'import os\n', removed: [], notes: [], suggestions: [] })
    );
    await organiseImports('P', 'import sys\nimport os\n');
    const init = calledInit();
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ source: 'import sys\nimport os\n' });
    expect(Object.keys(headers())).not.toContain('If-Match');
  });

  it('sends the CSRF token when one is supplied', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ source: '', removed: [], notes: [], suggestions: [] })
    );
    await organiseImports('P', '', 'tok-123');
    expect(headers()[CSRF_HEADER]).toBe('tok-123');
  });

  it('omits the CSRF header rather than sending it empty', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ source: '', removed: [], notes: [], suggestions: [] })
    );
    await organiseImports('P', '');
    expect(Object.keys(headers())).not.toContain(CSRF_HEADER);
  });

  it('returns the organised source, what was removed, notes and suggestions', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        source: 'import os\n\nprint(os.getcwd())\n',
        removed: ['import sys'],
        notes: [],
        suggestions: [{ name: 'json', statement: 'import json', origin: 'library' }],
      })
    );
    const result = await organiseImports('P', 'import sys\nimport os\n\nprint(os.getcwd())\n');
    expect(result.source).toBe('import os\n\nprint(os.getcwd())\n');
    expect(result.removed).toEqual(['import sys']);
    expect(result.suggestions).toEqual([
      { name: 'json', statement: 'import json', origin: 'library' },
    ]);
  });

  it('defaults every field so a stripped-down response never crashes the caller', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    const result = await organiseImports('P', 'import os\n');
    expect(result.source).toBe('import os\n');
    expect(result.removed).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('throws an ApiError when the gateway refuses the call', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Forbidden' }, 403));
    await expect(organiseImports('P', 'import os\n')).rejects.toBeInstanceOf(ApiError);
  });
});
