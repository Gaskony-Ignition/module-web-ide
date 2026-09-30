import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket } from '../test/fakeSocket';
import { LspTransport, type Envelope } from './lspTransport';

function transport(options: { requestTimeoutMs?: number } = {}) {
  return new LspTransport({
    url: () => 'ws://gateway.test/system/scriptide',
    createSocket: FakeSocket.factory,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    initialBackoffMs: 100,
    maxBackoffMs: 1_600,
  });
}

/** A transport with its socket already open — the state requests need. */
function connected(options: { requestTimeoutMs?: number } = {}) {
  const client = transport(options);
  client.connect();
  const socket = FakeSocket.latest();
  socket.open();
  return { client, socket };
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('envelope', () => {
  it('puts project beside ch, never inside msg', () => {
    const { client, socket } = connected();
    client.notify('lsp', 'textDocument/didOpen', { textDocument: { uri: 'ignition://P/x' } }, 'P');

    const [frame] = socket.frames();
    expect(frame.ch).toBe('lsp');
    expect(frame.project).toBe('P');
    // The server reads `project` off the envelope to pick the ScriptManager, and
    // a JSON-RPC message with a stray `project` member is not JSON-RPC. Both
    // halves of that matter, so both are asserted.
    expect(frame.msg).not.toHaveProperty('project');
    expect(frame.msg).toMatchObject({ jsonrpc: '2.0', method: 'textDocument/didOpen' });
  });

  it('omits project entirely when there is none, rather than sending null', () => {
    const { client, socket } = connected();
    client.send('ping', {});
    expect(socket.frames()[0]).toEqual({ ch: 'ping', msg: {} });
  });
});

describe('request/response matching', () => {
  it('resolves each request with the reply carrying its own id', async () => {
    const { client, socket } = connected();
    const first = client.request('lsp', 'textDocument/hover', {}, 'P');
    const second = client.request('lsp', 'textDocument/completion', {}, 'P');

    const ids = socket.frames().map((frame) => (frame.msg as { id: number }).id);
    expect(ids).toEqual([1, 2]);

    // Answered out of order on purpose: matching by arrival order rather than by
    // id is the bug this test exists to catch, and it passes every in-order test.
    socket.deliver({ ch: 'lsp', msg: { jsonrpc: '2.0', id: ids[1], result: 'completion' } });
    socket.deliver({ ch: 'lsp', msg: { jsonrpc: '2.0', id: ids[0], result: 'hover' } });

    await expect(first).resolves.toBe('hover');
    await expect(second).resolves.toBe('completion');
  });

  it('rejects a request the server answers with a JSON-RPC error', async () => {
    const { client, socket } = connected();
    const pending = client.request('lsp', 'textDocument/hover', {}, 'P');
    socket.deliver({
      ch: 'lsp',
      msg: { jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'index unavailable' } },
    });
    await expect(pending).rejects.toThrow('index unavailable');
  });

  it('times out a reply that never arrives instead of hanging forever', async () => {
    const { client } = connected({ requestTimeoutMs: 250 });
    const pending = client.request('lsp', 'textDocument/completion', {}, 'P');
    const assertion = expect(pending).rejects.toThrow(/No reply to textDocument\/completion/);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('ignores a late reply to a request that already timed out', async () => {
    const { socket, client } = connected({ requestTimeoutMs: 100 });
    const pending = client.request('lsp', 'textDocument/hover', {}, 'P');
    const assertion = expect(pending).rejects.toThrow(/No reply/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    // Must not throw, and must not resolve anything: the pending entry is gone.
    expect(() =>
      socket.deliver({ ch: 'lsp', msg: { jsonrpc: '2.0', id: 1, result: 'too late' } })
    ).not.toThrow();
  });

  it('rejects everything in flight when the socket drops', async () => {
    const { socket, client } = connected();
    const pending = client.request('lsp', 'textDocument/hover', {}, 'P');
    const assertion = expect(pending).rejects.toThrow(/connection dropped/);
    socket.drop();
    await assertion;
  });
});

describe('channel routing', () => {
  it('delivers each channel to its own listeners so exec can share the socket', () => {
    const { client, socket } = connected();
    const exec: unknown[] = [];
    const lsp: unknown[] = [];
    client.on('exec', (msg) => exec.push(msg));
    client.on('lsp', (msg) => lsp.push(msg));

    socket.deliver({ ch: 'exec', msg: { event: 'finished', stdout: '2\n' } });
    socket.deliver({ ch: 'lsp', msg: { jsonrpc: '2.0', id: 99, result: null } });

    expect(exec).toEqual([{ event: 'finished', stdout: '2\n' }]);
    expect(lsp).toEqual([{ jsonrpc: '2.0', id: 99, result: null }]);
  });

  it('treats an lsp frame with no id as a channel message, not a reply', () => {
    const { client, socket } = connected();
    const seen: unknown[] = [];
    client.on('lsp', (msg) => seen.push(msg));
    // What the server sends when the module is shutting down.
    socket.deliver({ ch: 'lsp', msg: { error: 'The module is shutting down.' } });
    expect(seen).toEqual([{ error: 'The module is shutting down.' }]);
  });

  it('survives a frame that is not JSON', () => {
    const { socket } = connected();
    expect(() => socket.onmessage?.({ data: '<html>proxy error</html>' })).not.toThrow();
  });
});

describe('connection lifecycle', () => {
  it('opens no socket until something is sent', () => {
    transport();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('drops frames sent before the socket opens rather than replaying them late', () => {
    const client = transport();
    client.notify('lsp', 'initialize', {}, 'P');
    client.notify('lsp', 'initialized', {}, 'P');
    const socket = FakeSocket.latest();
    socket.open();
    // Buffering these would double them up: the onOpen resynchronisation sends
    // initialize and didOpen from live state on this very connection.
    expect(socket.sent).toHaveLength(0);
  });

  it('rejects a request made before the socket is up instead of waiting out the timeout', async () => {
    const client = transport();
    await expect(client.request('lsp', 'textDocument/hover', {}, 'P')).rejects.toThrow(/not ready/);
    // It still starts connecting, so the next attempt has a socket to use.
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects with exponential backoff, capped', () => {
    const client = transport();
    client.send('ping', {});
    FakeSocket.latest().open();
    expect(FakeSocket.instances).toHaveLength(1);

    // 100, 200, 400, 800, then the 1600 cap. Each drop is followed by exactly
    // its own delay, so a socket appearing early would fail the count.
    for (const delay of [100, 200, 400, 800, 1600, 1600]) {
      FakeSocket.latest().drop();
      const before = FakeSocket.instances.length;
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.instances).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(before + 1);
    }
    expect(client.getStatus()).toBe('connecting');
  });

  it('resets the backoff once a connection succeeds', () => {
    const client = transport();
    client.send('ping', {});
    FakeSocket.latest().open();
    FakeSocket.latest().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.latest().open();

    // Back to the first delay, not the second: the attempt counter cleared.
    FakeSocket.latest().drop();
    const before = FakeSocket.instances.length;
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(before + 1);
    expect(client.getStatus()).toBe('connecting');
  });

  it('drops a frame sent while offline rather than replaying it after the reconnect', () => {
    const client = transport();
    client.send('ping', {});
    const socket = FakeSocket.latest();
    socket.open();
    socket.drop();
    // A didChange replayed after a reconnect lands on top of the didOpen that
    // resynchronisation sends — the same edit applied twice.
    expect(client.notify('lsp', 'textDocument/didChange', {}, 'P')).toBeUndefined();
    vi.advanceTimersByTime(100);
    const reconnected = FakeSocket.latest();
    reconnected.open();
    expect(reconnected.methods()).not.toContain('textDocument/didChange');
  });

  it('runs onOpen handlers on every connect, first and reconnect alike', () => {
    const client = transport();
    let opens = 0;
    client.onOpen(() => {
      opens++;
      client.notify('lsp', 'initialize', {}, 'P');
    });
    client.send('ping', {});
    FakeSocket.latest().open();
    expect(opens).toBe(1);
    expect(FakeSocket.latest().methods()).toEqual(['initialize']);

    FakeSocket.latest().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.latest().open();
    expect(opens).toBe(2);
    expect(FakeSocket.latest().methods()).toEqual(['initialize']);
  });

  it('stops reconnecting after a deliberate close', async () => {
    const { client } = connected();
    const pending = client.request('lsp', 'textDocument/hover', {}, 'P');
    const assertion = expect(pending).rejects.toThrow(/connection was closed/);
    client.close();
    await assertion;

    expect(FakeSocket.latest().closedByClient).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(client.getStatus()).toBe('closed');
  });

  it('reports status transitions to subscribers', () => {
    const client = transport();
    const seen: string[] = [];
    client.onStatus((status) => seen.push(status));
    client.send('ping', {});
    FakeSocket.latest().open();
    FakeSocket.latest().drop();
    expect(seen).toEqual(['connecting', 'open', 'closed']);
  });
});

describe('url resolution', () => {
  it('connects to the URL the factory was given', () => {
    transport().connect();
    expect(FakeSocket.latest().url).toBe('ws://gateway.test/system/scriptide');
  });

  it('exposes the envelope alongside the payload for channel listeners', () => {
    const { client, socket } = connected();
    const envelopes: Envelope[] = [];
    client.on('exec', (_msg, envelope) => envelopes.push(envelope));
    socket.deliver({ ch: 'exec', msg: { event: 'started' }, project: 'P' });
    expect(envelopes[0]?.project).toBe('P');
  });
});
