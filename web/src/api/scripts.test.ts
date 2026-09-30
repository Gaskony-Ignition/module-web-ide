import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  fetchProjects,
  fetchScriptTree,
  readScriptAttributes,
  readScriptContent,
  saveScriptAttributes,
  saveScriptContent,
  scriptRouteUrl,
  fetchHistory,
  readHistoryVersion,
  fetchRuntimeErrors,
} from './scripts';

const LIBRARY_PATH = 'ignition/script-python/util/helpers';
const SINGLETON_PATH = 'ignition/startup';

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

/** The last URL fetch was called with. */
function calledUrl(index = 0): string {
  return String(fetchMock.mock.calls[index][0]);
}

function calledInit(index = 0): RequestInit {
  return fetchMock.mock.calls[index][1] as RequestInit;
}

describe('scriptRouteUrl', () => {
  // RouteGroup matches :path as ONE segment. A raw path produces a
  // multi-segment URL that matches no route and 404s — which reads exactly like
  // a missing script, so this is the encoding bug that costs an afternoon.
  it('percent-encodes the resource path into a single URL segment', () => {
    const url = scriptRouteUrl('/api/scripts/content', LIBRARY_PATH, 'MyProject');
    expect(url).toContain('ignition%2Fscript-python%2Futil%2Fhelpers');
    expect(url).not.toContain('content/ignition/script-python');
  });

  it('leaves exactly one path segment after the route base', () => {
    const url = scriptRouteUrl('/api/scripts/content', LIBRARY_PATH, 'MyProject');
    const segment = url.split('?')[0].split('/api/scripts/content/')[1];
    expect(segment.includes('/')).toBe(false);
    expect(decodeURIComponent(segment)).toBe(LIBRARY_PATH);
  });

  it('encodes a singleton path, which has no name segment at all', () => {
    const url = scriptRouteUrl('/api/scripts/content', SINGLETON_PATH, 'MyProject');
    expect(url).toContain('ignition%2Fstartup');
  });

  it('carries the project as a query parameter, not a path segment', () => {
    const url = scriptRouteUrl('/api/scripts/attributes', LIBRARY_PATH, 'My Project');
    expect(url).toContain('?project=My+Project');
  });
});

describe('fetchProjects', () => {
  it('unwraps the projects array', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ projects: [{ name: 'A', mutable: true }, { name: 'B', mutable: false }] })
    );
    await expect(fetchProjects()).resolves.toEqual([
      { name: 'A', mutable: true },
      { name: 'B', mutable: false },
    ]);
    expect(calledInit().credentials).toBe('same-origin');
  });
});

describe('fetchScriptTree', () => {
  it('passes the project and tolerates a listing with no scripts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: 'P', mutable: true }));
    const tree = await fetchScriptTree('P');
    expect(calledUrl()).toContain('/api/scripts?project=P');
    expect(tree.scripts).toEqual([]);
  });
});

describe('readScriptContent', () => {
  it('returns the body byte-for-byte and the ETag as the signature', async () => {
    // Tabs and no trailing newline: exactly what the real Designer writes.
    const source = 'def go():\n\tif True:\n\t\treturn 1';
    fetchMock.mockResolvedValue(
      new Response(source, { status: 200, headers: { ETag: 'sig-1' } })
    );
    const content = await readScriptContent('P', LIBRARY_PATH, 'code.py');
    expect(content.text).toBe(source);
    expect(content.etag).toBe('sig-1');
    expect(calledUrl()).toContain('key=code.py');
  });

  it('strips the quoting a proxy may add to the ETag', async () => {
    // The server compares If-Match by exact string, so a quoted value would
    // round-trip as a permanent 409.
    fetchMock.mockResolvedValue(new Response('x', { status: 200, headers: { ETag: 'W/"sig-2"' } }));
    await expect(readScriptContent('P', LIBRARY_PATH)).resolves.toMatchObject({ etag: 'sig-2' });
  });

  it('throws a typed error carrying the server message', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'No such script: x' }, 404));
    await expect(readScriptContent('P', LIBRARY_PATH)).rejects.toMatchObject({
      status: 404,
      message: 'No such script: x',
    });
  });
});

describe('saveScriptContent', () => {
  it('sends the CSRF token, the If-Match precondition and the source verbatim', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-2' }));
    const source = 'x = 1\n\ty = 2';
    const result = await saveScriptContent({
      project: 'P',
      path: LIBRARY_PATH,
      source,
      key: 'code.py',
      baseSignature: 'sig-1',
      csrfToken: 'tok',
    });

    const init = calledInit();
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(headers['X-CSRF-Token']).toBe('tok');
    expect(headers['If-Match']).toBe('sig-1');
    expect(JSON.parse(String(init.body))).toEqual({
      source,
      key: 'code.py',
      baseSignature: 'sig-1',
    });
    expect(result.signature).toBe('sig-2');
  });

  it('reports a 409 as a conflict rather than a generic failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'This script changed on the gateway since you opened it' }, 409)
    );
    const failure = await saveScriptContent({
      project: 'P',
      path: LIBRARY_PATH,
      source: 'x',
      baseSignature: 'sig-1',
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    const error = failure as ApiError;
    expect(error.isConflict).toBe(true);
    expect(error.status).toBe(409);
    expect(error.message).toContain('changed on the gateway');
  });

  it('distinguishes a missing base signature (428) from a conflict', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Missing If-Match' }, 428));
    const failure = (await saveScriptContent({
      project: 'P',
      path: LIBRARY_PATH,
      source: 'x',
      baseSignature: '',
    }).catch((e: unknown) => e)) as ApiError;

    expect(failure.isMissingBaseSignature).toBe(true);
    expect(failure.isConflict).toBe(false);
  });

  it('does NOT put a proxy\'s HTML error page on screen as the message', async () => {
    // It used to. Markup is not a message, and the notice strip is one line —
    // so an HTML error page arrived as a wall of angle brackets under "Could
    // not save". The status is the honest answer when the body is not one.
    fetchMock.mockResolvedValue(new Response('<html>403</html>', { status: 403 }));
    await expect(
      saveScriptContent({ project: 'P', path: LIBRARY_PATH, source: 'x', baseSignature: 's' })
    ).rejects.toMatchObject({ status: 403, message: 'HTTP 403' });
  });

  it('keeps a short plain-text body, which IS a message', async () => {
    fetchMock.mockResolvedValue(new Response('Gateway is starting', { status: 503 }));
    await expect(
      saveScriptContent({ project: 'P', path: LIBRARY_PATH, source: 'x', baseSignature: 's' })
    ).rejects.toMatchObject({ status: 503, message: 'Gateway is starting' });
  });

  it('reads the container\'s 401 body by its FIELD, not as an envelope', async () => {
    // Measured on the rig, 04/09/2026. The servlet container answers a 401
    // with {message, url, status}, and taking the whole object printed that
    // JSON verbatim on screen: `Could not save api: { "message":"Unauthorized",
    // "url":"/data/scriptide/api/...", "status":"401" }` (Nigel).
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ message: 'Unauthorized', url: '/data/scriptide/api/x', status: '401' }),
      { status: 401 }
    ));
    await expect(
      saveScriptContent({ project: 'P', path: LIBRARY_PATH, source: 'x', baseSignature: 's' })
    ).rejects.toMatchObject({ status: 401, message: 'Unauthorized' });
  });

  it('flags 401 and 403 as the session being gone, and nothing else', async () => {
    // The predicate the save path branches on: it is what puts up the
    // "your session has ended" bar instead of a one-line notice.
    for (const [status, expected] of [[401, true], [403, true], [409, false], [500, false]] as const) {
      fetchMock.mockResolvedValue(new Response('{"error":"x"}', { status }));
      const failure = await saveScriptContent({
        project: 'P', path: LIBRARY_PATH, source: 'x', baseSignature: 's',
      }).catch((e: unknown) => e);
      expect((failure as ApiError).isUnauthenticated, `status ${status}`).toBe(expected);
    }
  });

  it('omits the CSRF header when the session had no token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await saveScriptContent({ project: 'P', path: LIBRARY_PATH, source: 'x', baseSignature: 's' });
    expect(Object.keys(calledInit().headers as object)).not.toContain('X-CSRF-Token');
  });
});

describe('script attributes', () => {
  it('reads the editable allowlist and the values', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        path: 'ignition/timer/Poller',
        signature: 'sig-9',
        editable: ['enabled', 'delay', 'fixedDelay', 'sharedThread'],
        attributes: { enabled: true, delay: 5000, fixedDelay: false, sharedThread: true },
      })
    );
    const read = await readScriptAttributes('P', 'ignition/timer/Poller');
    expect(read.editable).toEqual(['enabled', 'delay', 'fixedDelay', 'sharedThread']);
    expect(read.attributes.delay).toBe(5000);
    expect(calledUrl()).toContain('/api/scripts/attributes/ignition%2Ftimer%2FPoller');
  });

  it('treats a response with no editable array as body-only', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: 'p', signature: 's' }));
    const read = await readScriptAttributes('P', 'ignition/update');
    expect(read.editable).toEqual([]);
    expect(read.attributes).toEqual({});
  });

  it('writes attributes as their own request, separate from the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, signature: 'sig-10' }));
    await saveScriptAttributes({
      project: 'P',
      path: 'ignition/message/Handler',
      // Case-sensitive on the wire: 'shared' is accepted by the resource layer
      // and then behaves wrongly.
      attributes: { enabled: true, threadType: 'Dedicated' },
      baseSignature: 'sig-9',
      csrfToken: 'tok',
    });
    expect(calledUrl()).toContain('/api/scripts/attributes/');
    expect(JSON.parse(String(calledInit().body))).toEqual({
      attributes: { enabled: true, threadType: 'Dedicated' },
      baseSignature: 'sig-9',
    });
  });
});

describe('the 1.15.0 routes are resolved against the SPA base', () => {
  // Every one of these shipped to the rig with a bare `/api/...` and 404'd
  // there while passing 588 unit tests, because a mocked fetch accepts any
  // string. The SPA is served from `/data/scriptide/` on a gateway and from `/`
  // in dev, so the base is never hardcoded and never omitted.
  beforeEach(() => {
    window.history.replaceState({}, '', '/data/scriptide/');
  });

  it('history list', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ versions: [], maxVersions: 25 }));
    await fetchHistory('P', 'ignition/script-python/util', 'code.py');
    expect(calledUrl()).toContain('/data/scriptide/api/history?');
    expect(calledUrl()).toContain('key=code.py');
  });

  it('history content', async () => {
    fetchMock.mockResolvedValue(new Response('x = 1', { status: 200 }));
    await readHistoryVersion('P', 'ignition/script-python/util', 'code.py', '1757');
    expect(calledUrl()).toContain('/data/scriptide/api/history/content?');
    expect(calledUrl()).toContain('id=1757');
  });

  it('runtime errors', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ errors: [], windowMinutes: 60, matchedBy: 'x' }));
    await fetchRuntimeErrors('P', 30);
    expect(calledUrl()).toContain('/data/scriptide/api/runtime/errors?');
    expect(calledUrl()).toContain('minutes=30');
  });

  it('a history call with no data key omits the parameter rather than sending empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ versions: [], maxVersions: 25 }));
    await fetchHistory('P', 'ignition/startup');
    expect(calledUrl()).not.toContain('key=');
  });
});
