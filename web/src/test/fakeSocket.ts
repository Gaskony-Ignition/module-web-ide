/**
 * A WebSocket stand-in the tests can drive frame by frame.
 *
 * jsdom does have a WebSocket, and it is useless here: it needs a real server,
 * it opens on its own schedule, and there is no way to make it drop a connection
 * at a chosen moment — which is the single most important thing to test about
 * this transport.
 */
import type { Envelope, SocketLike } from '../api/lspTransport';

export class FakeSocket implements SocketLike {
  /** Every socket the factory has produced, oldest first. A reconnect appends. */
  static readonly instances: FakeSocket[] = [];

  readonly sent: string[] = [];
  closedByClient = false;

  onopen: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  static reset(): void {
    FakeSocket.instances.length = 0;
  }

  /** The factory to hand to LspTransport. */
  static factory = (url: string): SocketLike => new FakeSocket(url);

  static latest(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('no socket was created');
    return socket;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
  }

  /** The server accepted the upgrade. */
  open(): void {
    this.onopen?.();
  }

  /** The connection went away without anybody asking it to. */
  drop(): void {
    this.onclose?.();
  }

  /** Deliver one envelope to the client. */
  deliver(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  /** Everything sent on this socket, parsed. */
  frames(): Envelope[] {
    return this.sent.map((raw) => JSON.parse(raw) as Envelope);
  }

  /** The JSON-RPC methods sent on the lsp channel, in order. */
  methods(): string[] {
    return this.frames()
      .filter((frame) => frame.ch === 'lsp')
      .map((frame) => (frame.msg as { method?: string }).method ?? '(response)');
  }

  clear(): void {
    this.sent.length = 0;
  }
}
