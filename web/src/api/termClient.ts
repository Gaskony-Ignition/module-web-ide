/**
 * Typed client for the terminal channel.
 *
 * Shares the ONE authenticated WebSocket with the language server and the
 * console — see LspTransport. A terminal is a byte stream in both directions and
 * nothing here is RPC, so the surface is `on('term', …)` plus `send('term', …)`,
 * exactly as the exec channel is.
 *
 * **Bytes travel base64-encoded, deliberately.** A pty carries ANSI control
 * sequences and whatever a program decides to print, and a UTF-8 sequence can
 * straddle two reads on the server side. Decoding either end to a String
 * corrupts both cases; xterm.js accepts `Uint8Array` and does the decoding it
 * was written to do.
 */
import { sharedTransport } from './lspTransport';
import type { LspTransport } from './lspTransport';

export type TermEvent =
  /** A shell started. `pty` false means no real terminal was obtainable. */
  | { kind: 'opened'; id: string; pty: boolean }
  | { kind: 'data'; id: string; bytes: Uint8Array }
  | { kind: 'exit'; id: string; code: number }
  | { kind: 'error'; message: string };

interface RawTermMessage {
  event?: string;
  id?: string;
  data?: string;
  code?: number;
  pty?: boolean;
  error?: string;
}

/** Decode base64 to bytes without assuming any character encoding. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encode bytes to base64. Chunked, so a large paste does not blow the stack. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function toTermEvent(raw: unknown): TermEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const msg = raw as RawTermMessage;
  if (typeof msg.error === 'string') {
    return { kind: 'error', message: msg.error };
  }
  if (msg.event === 'opened' && msg.id) {
    return { kind: 'opened', id: msg.id, pty: msg.pty !== false };
  }
  if (msg.event === 'data' && msg.id && typeof msg.data === 'string') {
    return { kind: 'data', id: msg.id, bytes: decodeBase64(msg.data) };
  }
  if (msg.event === 'exit' && msg.id) {
    return { kind: 'exit', id: msg.id, code: msg.code ?? 0 };
  }
  return null;
}

export class TermClient {
  constructor(private readonly transport: LspTransport = sharedTransport()) {}

  /**
   * Subscribe to terminal events.
   *
   * Connects eagerly for the same measured reason the exec client does: `send()`
   * opens the socket lazily but still returns false for the attempt that
   * triggered it, so without this the first terminal a user opens silently does
   * nothing.
   */
  subscribe(listener: (event: TermEvent) => void): () => void {
    this.transport.connect();
    return this.transport.on('term', (msg) => {
      const event = toTermEvent(msg);
      if (event) {
        listener(event);
      }
    });
  }

  /**
   * Ask for a shell. Returns a function that withdraws the request if it has
   * not gone out yet.
   *
   * The terminal opens the moment its view mounts, and on a tab where nothing
   * else has used the socket that moment is BEFORE the socket is open: the
   * transport's `send()` starts the connection and then returns false, and the
   * one frame that mattered is dropped — measured 02/09/2026, the xterm mounted
   * and the prompt never came. So a frame that cannot go now is sent by the
   * transport's next `onOpen`, once. The disposer exists because a view that
   * unmounts in that window must not have a shell opened for it afterwards;
   * nothing would ever close it.
   */
  open(cols: number, rows: number, csrfToken?: string): () => void {
    const frame = { action: 'open', cols, rows, ...(csrfToken ? { csrfToken } : {}) };
    if (this.transport.send('term', frame)) {
      return () => {};
    }
    const unsubscribe = this.transport.onOpen(() => {
      unsubscribe();
      this.transport.send('term', frame);
    });
    return unsubscribe;
  }

  input(id: string, data: string, csrfToken?: string): boolean {
    const bytes = new TextEncoder().encode(data);
    return this.transport.send('term', {
      action: 'input', id, data: encodeBase64(bytes),
      ...(csrfToken ? { csrfToken } : {}),
    });
  }

  resize(id: string, cols: number, rows: number, csrfToken?: string): boolean {
    return this.transport.send('term', {
      action: 'resize', id, cols, rows, ...(csrfToken ? { csrfToken } : {}),
    });
  }

  close(id: string, csrfToken?: string): boolean {
    return this.transport.send('term', {
      action: 'close', id, ...(csrfToken ? { csrfToken } : {}),
    });
  }
}

let shared: TermClient | null = null;

export function sharedTermClient(): TermClient {
  if (!shared) {
    shared = new TermClient();
  }
  return shared;
}
