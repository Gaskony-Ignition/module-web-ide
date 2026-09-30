/**
 * Typed client for the execution channel.
 *
 * Shares the ONE authenticated WebSocket with the language server — see
 * LspTransport. `on('exec', …)` plus `send('exec', …)` is the entire surface
 * needed, and this file deliberately knows nothing about JSON-RPC: the exec
 * channel is a plain request/event protocol, not RPC.
 *
 * Three properties of the server protocol shape everything here:
 *
 * 1. **Output IS streamed, and `finished` then carries none of it.** The server
 *    sends `started`, then an `output` frame per chunk (flushed on a newline, at
 *    4 KB, or every 100 ms), then exactly one `finished` whose `stdout` and
 *    `stderr` are EMPTY. That split is the contract: everything has already been
 *    delivered, so a client that renders both would print every line twice.
 *    Ordering within a stream is guaranteed, and `finished` always comes last.
 *    Until 1.5.0 it was the other way round — one `finished` carrying the lot,
 *    and a twenty-second script showing nothing for twenty seconds.
 * 2. **The console keeps its locals; a file run does not.** Omitting `target`
 *    marks the run as a console run, and the server then reuses that project's
 *    locals so the console behaves like a REPL. Sending a `target` gets fresh
 *    locals every time, because a script file is not a REPL and carrying state
 *    between runs of one makes results depend on invisible history.
 * 3. **`reset` drops those locals**, which is the Designer's Reset button. The
 *    server refuses it while that connection has a script running.
 */
import { sharedTransport } from './lspTransport';
import type { LspTransport } from './lspTransport';

/**
 * One traceback frame, EXACTLY as `TracebackFormatter.describe` emits it.
 *
 * The names are the server's and are pinned on both sides — see
 * `TracebackFormatterTest#pinsTheFrameContract` and `__fixtures__/execError.json`.
 * Until 1.5.0 this interface invented its own (`path`, `module`, `functionName`,
 * `isTarget`); nothing threw, because TypeScript cannot check a wire, and every
 * frame on screen read "<console>, line N" with no function name and no
 * exception type. Rename nothing here without renaming it there.
 */
export interface ExecErrorFrame {
  /** The frame's `co_filename`: our own submitted token, or `<module:dotted.name>`. */
  file?: string;
  /** The function the frame is in; `<module>` at the top level. */
  function?: string;
  line: number;
  /** True when this frame is in the source the user just ran. */
  isSubmitted?: boolean;
  /**
   * Dotted module name for a project-library frame, e.g. `util.helpers`, which
   * maps to `ignition/script-python/util/helpers`. Null for anything else — this
   * is what makes a frame clickable.
   */
  libraryModule?: string | null;
}

export interface ExecError {
  /** The exception class, e.g. `ZeroDivisionError`. Shown as the headline. */
  type: string;
  message: string;
  frames: ExecErrorFrame[];
  /** The rendered traceback, shown when there are no frames to walk. */
  rendered?: string;
  /** Syntax errors only: the offending line, in the editor's numbering. */
  line?: number;
  /** Syntax errors only: 1-based column, for the caret. */
  offset?: number;
  /** Syntax errors only: the source line itself. NOT the rendered traceback. */
  text?: string;
}

export interface ExecResult {
  executionId: string;
  stdout: string;
  stderr: string;
  /** Output hit the server's cap and was cut — the rest is gone, not pending. */
  truncated: boolean;
  /** The run was stopped rather than completing or failing. */
  cancelled: boolean;
  ok: boolean;
  error?: ExecError;
}

export interface RunRequest {
  project: string;
  source: string;
  csrfToken?: string;
  /**
   * The resource being run. OMIT for a console run — its presence is what tells
   * the server this is a file, and the server keys REPL locals on its absence.
   */
  target?: string;
  /**
   * Blank lines the client prepended so a selection run's traceback line numbers
   * still match the editor. The server subtracts it back off.
   */
  lineOffset?: number;
}

export type OutputStream = 'stdout' | 'stderr';

export type ExecEvent =
  | { kind: 'started'; executionId: string }
  | { kind: 'output'; executionId: string; stream: OutputStream; text: string }
  | { kind: 'stopping'; executionId: string; detail?: string }
  | { kind: 'finished'; result: ExecResult }
  | { kind: 'reset'; project?: string }
  | { kind: 'error'; message: string };

/** Shape of anything arriving on the exec channel. Validated, never trusted. */
interface RawExecMessage {
  event?: string;
  executionId?: string;
  detail?: string;
  stream?: string;
  text?: string;
  project?: string;
  error?: string | ExecError;
  stdout?: string;
  stderr?: string;
  truncated?: boolean;
  cancelled?: boolean;
  ok?: boolean;
}

/**
 * Normalise one incoming frame.
 *
 * `error` is overloaded by the server: a STRING at the top level is a channel
 * error (execution disabled, not an admin, bad CSRF), while an OBJECT inside a
 * `finished` frame is a Python traceback. Conflating them shows "TypeError" when
 * what actually happened is "you are not an administrator", so they are split
 * here rather than at the call site.
 */
export function toExecEvent(raw: unknown): ExecEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const msg = raw as RawExecMessage;

  if (typeof msg.error === 'string') {
    return { kind: 'error', message: msg.error };
  }
  if (msg.event === 'started' && msg.executionId) {
    return { kind: 'started', executionId: msg.executionId };
  }
  if (msg.event === 'output' && msg.executionId && typeof msg.text === 'string') {
    // Anything but an explicit 'stderr' is treated as stdout: a chunk with an
    // unrecognised stream name is still the user's output and losing it would be
    // worse than colouring it wrong.
    return {
      kind: 'output',
      executionId: msg.executionId,
      stream: msg.stream === 'stderr' ? 'stderr' : 'stdout',
      text: msg.text,
    };
  }
  if (msg.event === 'reset') {
    return { kind: 'reset', project: msg.project };
  }
  if (msg.event === 'stopping' && msg.executionId) {
    return { kind: 'stopping', executionId: msg.executionId, detail: msg.detail };
  }
  if (msg.event === 'finished' && msg.executionId) {
    return {
      kind: 'finished',
      result: {
        executionId: msg.executionId,
        stdout: msg.stdout ?? '',
        stderr: msg.stderr ?? '',
        truncated: msg.truncated === true,
        cancelled: msg.cancelled === true,
        ok: msg.ok === true,
        error: typeof msg.error === 'object' && msg.error !== null
          ? (msg.error as ExecError)
          : undefined,
      },
    };
  }
  return null;
}

export class ExecClient {
  constructor(private readonly transport: LspTransport = sharedTransport()) {}

  /** Subscribe to normalised exec events. Returns an unsubscribe function. */
  subscribe(listener: (event: ExecEvent) => void): () => void {
    // Open the socket NOW, when the console mounts, rather than leaving it to
    // the first run.
    //
    // `send()` connects lazily but still returns false for the attempt that
    // triggered it, so without this the first Run a user ever clicks reports
    // "not connected" and does nothing — measured 01/09/2026 in the browser.
    // It is worse in the popped-out console, which has no language client to
    // have opened the socket for it, so EVERY first run failed there.
    // connect() is idempotent.
    this.transport.connect();
    return this.transport.on('exec', (msg) => {
      const event = toExecEvent(msg);
      if (event) {
        listener(event);
      }
    });
  }

  /**
   * Start a run. Returns false if the socket is not open — the caller should
   * surface that rather than leaving a spinner up forever, because there is no
   * queueing: a send on a closed socket is simply dropped.
   */
  run(request: RunRequest): boolean {
    const msg: Record<string, unknown> = {
      action: 'run',
      project: request.project,
      source: request.source,
    };
    if (request.csrfToken) {
      msg.csrfToken = request.csrfToken;
    }
    // Only set when present: an explicit undefined would still serialise as a
    // key for some encoders, and the server keys console-vs-file on `has`.
    if (request.target !== undefined) {
      msg.target = request.target;
    }
    if (request.lineOffset) {
      msg.lineOffset = request.lineOffset;
    }
    return this.transport.send('exec', msg);
  }

  /**
   * Ask the gateway to stop a run. Best-effort — see the Stop UI copy.
   *
   * Sendable DURING a run since 1.5.0. It always could be sent; the server was
   * simply not reading, because the socket thread was parked inside the previous
   * frame's execution.
   */
  stop(executionId: string, csrfToken?: string): boolean {
    const msg: Record<string, unknown> = { action: 'stop', executionId };
    if (csrfToken) {
      msg.csrfToken = csrfToken;
    }
    return this.transport.send('exec', msg);
  }

  /**
   * Drop the console's locals for a project — the Designer's Reset.
   *
   * Refused by the server while that connection has a script in flight, because
   * swapping the locals map under a running script produces a NameError from a
   * line that plainly assigns the name.
   */
  reset(project: string, csrfToken?: string): boolean {
    const msg: Record<string, unknown> = { action: 'reset', project };
    if (csrfToken) {
      msg.csrfToken = csrfToken;
    }
    return this.transport.send('exec', msg);
  }
}

let shared: ExecClient | null = null;

/** The process-wide client, sharing the process-wide transport. */
export function sharedExecClient(): ExecClient {
  if (!shared) {
    shared = new ExecClient();
  }
  return shared;
}
