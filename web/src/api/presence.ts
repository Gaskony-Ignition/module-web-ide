/**
 * Who else has this file open, and where they are working from.
 *
 * The gateway keeps the list — see `PresenceRegistry` — and pushes it whenever
 * it changes, from either of two feeds: other browsers connected to this module,
 * and Ignition Designers, which report their open resources to the gateway for
 * their own concurrent-editing banner.
 *
 * ## This is a warning, not a lock
 *
 * Nothing here stops a save. The write path already has optimistic concurrency
 * through `If-Match`, and that is what actually prevents a lost update. Presence
 * exists so two people find out about each other BEFORE the conflict rather than
 * after it, and the wording throughout says "has it open" rather than "is
 * editing" because that is what the Designer reports and what we can honestly
 * claim — a tab left open over lunch counts.
 *
 * ## Reporting is a full list, every time
 *
 * The client sends every path it has open, not a delta. The server replaces that
 * session's set outright, which means a dropped frame self-heals on the next one
 * instead of leaving a name on a file nobody has. It also means the report must
 * be re-sent on RECONNECT: the server's peer entry dies with the socket, so a
 * client that reconnected silently and said nothing would be invisible to
 * everyone else while believing itself announced.
 */
import { sharedTransport } from './lspTransport';

export type PeerKind = 'ide' | 'designer';

/** One other person, in one place. */
export interface Peer {
  /** Blank when the platform did not say — render as "someone", never as "". */
  username: string;
  /** Hostname, or the address where there is no name. */
  host: string;
  kind: PeerKind;
  project: string;
  /** Resource paths, in this module's `<moduleId>/<typeId>/<name>` form. */
  resources: string[];
  /** Session start, epoch millis, or 0 when unknown. */
  since: number;
}

export interface PresenceState {
  peers: Peer[];
  /**
   * Whether per-file Designer presence is working on this gateway.
   *
   * False means the platform's internal event type was not the shape this build
   * expects, so Designer sessions are known at PROJECT level only. The UI says
   * so rather than showing less and looking the same — an indicator that has
   * quietly stopped seeing half its input is worse than one that admits it.
   */
  designerFeed: boolean;
  version: number;
}

export const EMPTY_PRESENCE: PresenceState = { peers: [], designerFeed: false, version: -1 };

type Subscriber = (state: PresenceState) => void;

/**
 * The one presence client for the tab.
 *
 * Shared for the same reason the transport is: two of these would each report
 * their own half of the open tabs, and the last one to send would win.
 */
class PresenceClient {
  private state: PresenceState = EMPTY_PRESENCE;

  private readonly subscribers = new Set<Subscriber>();

  /** The last thing reported, replayed on reconnect. */
  private reported: { project: string; open: string[] } | null = null;

  private started = false;

  private start() {
    if (this.started) return;
    this.started = true;
    const transport = sharedTransport();
    transport.on('presence', (msg) => {
      const payload = msg as Partial<PresenceState> | undefined;
      if (!payload || !Array.isArray(payload.peers)) return;
      this.state = {
        peers: payload.peers as Peer[],
        designerFeed: payload.designerFeed === true,
        version: typeof payload.version === 'number' ? payload.version : 0,
      };
      for (const subscriber of [...this.subscribers]) subscriber(this.state);
    });
    // The server's entry for us died with the old socket, so a reconnect has to
    // re-announce or we are invisible to everyone while believing otherwise.
    transport.onOpen(() => {
      if (this.reported) {
        transport.send('presence', this.reported);
      }
    });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.start();
    this.subscribers.add(subscriber);
    subscriber(this.state);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Tell the gateway what this browser has open. Idempotent. */
  report(project: string, open: string[]) {
    this.start();
    const next = { project, open: [...open].sort() };
    if (
      this.reported
      && this.reported.project === next.project
      && this.reported.open.length === next.open.length
      && this.reported.open.every((path, index) => path === next.open[index])
    ) {
      // Nothing changed. Re-sending on every render would put a frame on the
      // wire per keystroke, and each one costs every other client a broadcast.
      return;
    }
    this.reported = next;
    sharedTransport().send('presence', next);
  }
}

let client: PresenceClient | null = null;

export function presenceClient(): PresenceClient {
  if (!client) client = new PresenceClient();
  return client;
}

/** Everyone except you who has this exact path open, in this project. */
export function peersOn(state: PresenceState, project: string, path: string): Peer[] {
  return state.peers.filter(
    (peer) => peer.project === project && peer.resources.includes(path)
  );
}

/** A peer's name as it is shown. Never blank. */
export function peerName(peer: Peer): string {
  return peer.username.trim() || 'someone';
}

/** Where a peer is, as one short phrase: `sam in the Designer on sams-laptop`. */
export function describePeer(peer: Peer): string {
  const where = peer.kind === 'designer' ? 'in the Designer' : 'in the IDE';
  return peer.host ? `${peerName(peer)} ${where} on ${peer.host}` : `${peerName(peer)} ${where}`;
}

/**
 * The sentence shown above a file somebody else also has open.
 *
 * Names everyone rather than counting them: "2 others" makes you go looking,
 * and the whole point is that you already know who to talk to.
 */
export function describeCrowd(peers: Peer[]): string {
  if (peers.length === 0) return '';
  const described = peers.map(describePeer);
  if (described.length === 1) return `${described[0]} also has this open.`;
  const last = described[described.length - 1];
  return `${described.slice(0, -1).join(', ')} and ${last} also have this open.`;
}
