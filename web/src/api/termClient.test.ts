import { describe, expect, it, vi } from 'vitest';
import { TermClient, decodeBase64, encodeBase64, toTermEvent } from './termClient';
import type { LspTransport } from './lspTransport';

/** A transport double: records what was sent and lets a test push frames back. */
function fakeTransport() {
  const sent: Array<{ channel: string; msg: unknown }> = [];
  let listener: ((msg: unknown) => void) | null = null;
  const transport = {
    connect: vi.fn(),
    send: vi.fn((channel: string, msg: unknown) => {
      sent.push({ channel, msg });
      return true;
    }),
    on: vi.fn((_channel: string, fn: (msg: unknown) => void) => {
      listener = fn;
      return () => { listener = null; };
    }),
  } as unknown as LspTransport;
  return { transport, sent, emit: (msg: unknown) => listener?.(msg) };
}

describe('base64 transport', () => {
  it('round-trips bytes that are not valid UTF-8 text', () => {
    // A pty carries ANSI escapes and raw program output; anything that decodes
    // to a String on the way through corrupts exactly this case.
    const bytes = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0xfe, 0x00, 0x41]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });

  it('encodes a payload larger than one apply() argument list', () => {
    // String.fromCharCode(...bytes) blows the stack somewhere around 100k
    // arguments, which a paste into a terminal reaches easily. The encoder
    // chunks for that reason, so the large case is the one worth testing.
    const bytes = new Uint8Array(200_000).fill(0x61);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});

describe('toTermEvent', () => {
  it('reads a data frame back into bytes', () => {
    const event = toTermEvent({ event: 'data', id: 't1', data: encodeBase64(new Uint8Array([1, 2, 3])) });
    expect(event).toEqual({ kind: 'data', id: 't1', bytes: new Uint8Array([1, 2, 3]) });
  });

  it('treats a top-level error string as a channel error', () => {
    expect(toTermEvent({ error: 'The Gateway terminal is disabled on this gateway.' }))
      .toEqual({ kind: 'error', message: 'The Gateway terminal is disabled on this gateway.' });
  });

  it('defaults pty to true, so only an explicit false warns the user', () => {
    expect(toTermEvent({ event: 'opened', id: 't1' })).toEqual({ kind: 'opened', id: 't1', pty: true });
    expect(toTermEvent({ event: 'opened', id: 't1', pty: false }))
      .toEqual({ kind: 'opened', id: 't1', pty: false });
  });

  it('ignores anything it does not recognise rather than guessing', () => {
    expect(toTermEvent(null)).toBeNull();
    expect(toTermEvent({ event: 'data' })).toBeNull();
    expect(toTermEvent({ event: 'nonsense', id: 't1' })).toBeNull();
  });
});

describe('TermClient', () => {
  it('connects when it subscribes, not when it first sends', () => {
    // Measured on the exec channel in 1.2.0: send() opens the socket lazily but
    // still returns false for the attempt that triggered it, so the FIRST
    // terminal a user opened would silently do nothing.
    const { transport } = fakeTransport();
    new TermClient(transport).subscribe(() => {});
    expect(transport.connect).toHaveBeenCalled();
  });

  it('sends the CSRF token on open', () => {
    const { transport, sent } = fakeTransport();
    new TermClient(transport).open(120, 30, 'tok');
    expect(sent[0]).toEqual({
      channel: 'term',
      msg: { action: 'open', cols: 120, rows: 30, csrfToken: 'tok' },
    });
  });

  it('sends the open frame on the next connect when the socket is not open yet', () => {
    // The terminal mounts before the socket is open on a tab where nothing else
    // has used it; the transport starts connecting and drops the frame. The
    // request must survive that, and go out exactly once.
    const { transport, sent } = fakeTransport();
    const hook: { listener: (() => void) | null } = { listener: null };
    (transport.send as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    (transport as unknown as { onOpen: unknown }).onOpen = vi.fn((fn: () => void) => {
      hook.listener = fn;
      return () => { hook.listener = null; };
    });
    new TermClient(transport).open(80, 24, 'tok');
    expect(sent).toHaveLength(0); // the first attempt was dropped by the transport
    hook.listener?.();
    hook.listener?.();
    expect(sent).toHaveLength(1);
    expect(sent[0].msg).toEqual({ action: 'open', cols: 80, rows: 24, csrfToken: 'tok' });
  });

  it('withdraws a deferred open when the view goes away first', () => {
    const { transport, sent } = fakeTransport();
    const hook: { listener: (() => void) | null } = { listener: null };
    (transport.send as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
    (transport as unknown as { onOpen: unknown }).onOpen = vi.fn((fn: () => void) => {
      hook.listener = fn;
      return () => { hook.listener = null; };
    });
    const cancel = new TermClient(transport).open(80, 24);
    cancel();
    expect(hook.listener).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('base64-encodes keystrokes', () => {
    const { transport, sent } = fakeTransport();
    new TermClient(transport).input('t1', 'git status\r');
    const msg = sent[0].msg as { data: string };
    expect(new TextDecoder().decode(decodeBase64(msg.data))).toBe('git status\r');
  });

  it('delivers only frames it understood', () => {
    const { transport, emit } = fakeTransport();
    const seen: unknown[] = [];
    new TermClient(transport).subscribe((event) => seen.push(event));
    emit({ event: 'nonsense' });
    emit({ event: 'exit', id: 't1', code: 0 });
    expect(seen).toEqual([{ kind: 'exit', id: 't1', code: 0 }]);
  });
});
