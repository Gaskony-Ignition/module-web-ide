/**
 * The single WebSocket the whole app shares.
 *
 * There is ONE socket per browser tab, not one per document and not one per
 * channel. That is a server-side constraint as much as a client-side economy:
 * `ScriptIdeSocket` holds the per-connection LanguageServer and the console's
 * REPL locals, so a second socket would be a second, independent server with its
 * own document set and its own variables.
 *
 * Every frame in both directions carries the envelope
 * `{ch, msg, project?}`. `project` is a SIBLING of `ch`, never a field inside
 * `msg`: the server reads it before it looks at the payload, to pick the
 * project's ScriptManager, and a JSON-RPC message with an extra `project`
 * member is not a JSON-RPC message.
 *
 * Reconnection is the part worth reading. The server's document set lives in
 * the connection, so a reconnect gives us a server that has never heard of any
 * open file. Every position we then send — completion, hover, signature help —
 * is computed against a document the server does not have, and the answers are
 * silently wrong rather than absent. So a reconnect is not "the socket came
 * back": it is a full resynchronisation, and {@link LspTransport.onOpen}
 * exists for the client to hook that.
 */

import { resolveWsUrl } from './urls';

/** Channels multiplexed over the one socket. Mirrors ScriptIdeSocket. */
export type Channel = 'lsp' | 'exec' | 'term' | 'ping' | 'presence' | 'git' | 'error';

/** The wire envelope. `project` is deliberately outside `msg`. */
export interface Envelope<T = unknown> {
  ch: Channel;
  msg: T;
  project?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * The slice of WebSocket this module uses.
 *
 * Declared structurally so a test can inject a fake without a socket server and
 * without jsdom's WebSocket, which cannot be driven deterministically.
 */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type TransportStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface TransportOptions {
  /** Resolved lazily so `window.location` is read at connect time, not import time. */
  url?: () => string;
  createSocket?: SocketFactory;
  /** A reply that never arrives rejects after this long. */
  requestTimeoutMs?: number;
  /** First reconnect delay; doubles per attempt up to {@link maxBackoffMs}. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Thrown when a request gets no reply, or the socket died under it. */
export class LspTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LspTransportError';
  }
}

/** Thrown when the server answers a request with a JSON-RPC `error` member. */
export class JsonRpcResponseError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'JsonRpcResponseError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INITIAL_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class LspTransport {
  private readonly resolveUrl: () => string;
  private readonly createSocket: SocketFactory;
  private readonly requestTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  private socket: SocketLike | null = null;
  private status: TransportStatus = 'idle';
  private nextId = 1;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set by close(); stops the backoff loop from resurrecting the socket. */
  private shutDown = false;

  private readonly pending = new Map<number, Pending>();
  private readonly channelListeners = new Map<Channel, Set<(msg: unknown, envelope: Envelope) => void>>();
  private readonly openListeners = new Set<() => void>();
  private readonly statusListeners = new Set<(status: TransportStatus) => void>();

  constructor(options: TransportOptions = {}) {
    // A thunk, not a string: nothing may touch `window.location` until the
    // socket is actually opened, and a test injects its own.
    this.resolveUrl = options.url ?? (() => defaultUrl());
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  }

  getStatus(): TransportStatus {
    return this.status;
  }

  /**
   * Subscribe to one channel's incoming payloads.
   *
   * This is how the execution UI will share the socket: `on('exec', …)` plus
   * `send('exec', …)` is the whole surface it needs, and it needs no knowledge
   * of the JSON-RPC matching the `lsp` channel does.
   */
  on(channel: Channel, listener: (msg: unknown, envelope: Envelope) => void): () => void {
    let set = this.channelListeners.get(channel);
    if (!set) {
      set = new Set();
      this.channelListeners.set(channel, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /**
   * Run after every successful connect — the first one and every reconnect
   * alike, because they are the same event as far as server state goes: a
   * server with no documents.
   *
   * This is the ONLY place server-side state is (re)established: frames sent
   * while the socket is down are dropped rather than queued, so a handler here
   * must send everything the server needs to know, from live state.
   */
  onOpen(listener: () => void): () => void {
    this.openListeners.add(listener);
    return () => this.openListeners.delete(listener);
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Open the socket if it is not already opening or open. Idempotent. */
  connect(): void {
    this.shutDown = false;
    if (this.socket || this.status === 'connecting') return;
    this.setStatus('connecting');
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.resolveUrl());
    } catch {
      // A constructor that throws (a bad URL, a blocked scheme) is a failed
      // attempt like any other — retry on the same backoff rather than dying.
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => this.handleOpen();
    socket.onclose = () => this.handleClose();
    socket.onerror = () => {
      /* onclose always follows; handling both would reconnect twice */
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
  }

  /** Deliberate shutdown: no reconnect, and everything in flight is rejected. */
  close(): void {
    this.shutDown = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.failPending(new LspTransportError('The Web IDE connection was closed.'));
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    this.setStatus('closed');
  }

  /**
   * Send one envelope, opening the socket if it is not up yet.
   *
   * A frame sent while the socket is down is DROPPED, not buffered. Buffering
   * looks kinder and is wrong twice over: a `didChange` held across a reconnect
   * lands on top of the fresh `didOpen` that resynchronisation sends, applying
   * the same edit twice; and a `didOpen` buffered before the first connect is
   * then sent again by that same resynchronisation. The {@link onOpen} hook
   * exists so that nothing needs the queue — whatever the server must know is
   * re-sent from live state the moment there is a server to tell.
   *
   * @returns whether the frame actually went out
   */
  send(channel: Channel, msg: unknown, project?: string): boolean {
    // Built here rather than by the caller so `project` can never end up inside
    // `msg` — the one mistake this wire format invites.
    const envelope: Envelope = project === undefined ? { ch: channel, msg } : { ch: channel, msg, project };
    if (this.status === 'open' && this.socket) {
      this.socket.send(JSON.stringify(envelope));
      return true;
    }
    if (!this.shutDown) this.connect();
    return false;
  }

  /** Send a JSON-RPC notification. Notifications get no reply, by definition. */
  notify(channel: Channel, method: string, params: unknown, project?: string): void {
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(channel, message, project);
  }

  /**
   * Send a JSON-RPC request and resolve with its `result`.
   *
   * The timeout is not belt-and-braces. Completion and hover are awaited inside
   * CodeMirror, and a promise that never settles leaves the popup spinning for
   * the life of the tab with nothing in any log to say why.
   */
  request<T = unknown>(channel: Channel, method: string, params: unknown, project?: string): Promise<T> {
    if (this.status !== 'open') {
      // Rejecting now rather than sending into a socket that will drop the frame:
      // the alternative is a caller waiting out the full timeout for an answer
      // that was never asked for.
      if (!this.shutDown) this.connect();
      return Promise.reject(
        new LspTransportError(`The Web IDE connection is not ready (${this.status}).`)
      );
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspTransportError(`No reply to ${method} after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.send(channel, message, project);
    });
  }

  private handleOpen(): void {
    this.attempt = 0;
    this.setStatus('open');
    // Resynchronisation happens here and only here — see onOpen and send().
    for (const listener of [...this.openListeners]) {
      listener();
    }
  }

  private handleClose(): void {
    this.socket = null;
    // Anything in flight died with the connection. Rejecting now rather than
    // waiting for each timeout means the UI stops spinning immediately.
    this.failPending(new LspTransportError('The Web IDE connection dropped.'));
    if (this.shutDown) {
      this.setStatus('closed');
      return;
    }
    this.setStatus('closed');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.socket = null;
    if (this.shutDown || this.reconnectTimer !== null) return;
    // Deterministic doubling, capped. No jitter: this is one browser tab
    // reconnecting to one gateway, so there is no thundering herd to spread,
    // and jitter would make the backoff untestable.
    const delay = Math.min(this.initialBackoffMs * 2 ** this.attempt, this.maxBackoffMs);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(data) as Envelope;
    } catch {
      return;
    }
    if (!envelope || typeof envelope.ch !== 'string') return;

    if (envelope.ch === 'lsp') {
      this.routeJsonRpc(envelope.msg);
    }
    const listeners = this.channelListeners.get(envelope.ch);
    if (listeners) {
      for (const listener of [...listeners]) {
        listener(envelope.msg, envelope);
      }
    }
  }

  /**
   * Match a reply to its request by `id`.
   *
   * A frame on the lsp channel with no `id` is not a JSON-RPC response: the
   * server also sends `{ch:"lsp", msg:{error:…}}` for transport-level failures
   * (a shutting-down module). Those go to the channel listeners and must not be
   * mistaken for anybody's reply.
   */
  private routeJsonRpc(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const response = msg as Partial<JsonRpcResponse>;
    if (typeof response.id !== 'number') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error) {
      pending.reject(new JsonRpcResponseError(response.error.code, response.error.message));
    } else {
      pending.resolve(response.result ?? null);
    }
  }

  private failPending(error: Error): void {
    const inFlight = [...this.pending.values()];
    this.pending.clear();
    for (const entry of inFlight) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private setStatus(status: TransportStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of [...this.statusListeners]) {
      listener(status);
    }
  }
}

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

function defaultUrl(): string {
  // Resolved here rather than in the constructor: `window.location` must be
  // read at connect time, so a test or a future embedded host can override the
  // location before the first frame is sent.
  return resolveWsUrl();
}

/**
 * The app-wide transport.
 *
 * Created on first use rather than at import so nothing opens a socket merely by
 * importing this module — which is what a component test does.
 */
let shared: LspTransport | null = null;

export function sharedTransport(): LspTransport {
  if (!shared) {
    shared = new LspTransport();
  }
  return shared;
}
