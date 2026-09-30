/**
 * Who else is in this file, shown where you would already be looking.
 *
 * Two surfaces, deliberately different in weight:
 *
 * - {@link PresenceBadge} on a tab and on a tree row — small, ambient, tells you
 *   a file is occupied without asking you to read anything.
 * - {@link PresenceBar} above the editor for the file you are actually IN —
 *   names people, says where they are, and is the one that has to be legible
 *   because it is the one that changes what you do next.
 *
 * Neither of them blocks anything. See `api/presence.ts` for why this is a
 * warning and not a lock.
 */
import { describeCrowd, describePeer, peerName, type Peer } from '../api/presence';
import './Presence.css';

/** The letter in the badge: a person's initial, or a dot where there is no name. */
function initial(peer: Peer): string {
  const name = peer.username.trim();
  return name ? name.charAt(0).toUpperCase() : '•';
}

export interface PresenceBadgeProps {
  peers: Peer[];
  /** How many faces before it collapses to a count. Tabs are narrow. */
  max?: number;
}

/**
 * A stack of initials, one per person.
 *
 * Capped, because a popular file would otherwise widen a tab until the tab
 * strip scrolls — and the badge is an ambient signal, not the list. The list is
 * in the title, which is where a mouse already goes when a badge is unfamiliar,
 * and in the bar above the editor for the file being read.
 */
export function PresenceBadge({ peers, max = 2 }: PresenceBadgeProps) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, max);
  const extra = peers.length - shown.length;
  return (
    <span className="presence-badge" title={describeCrowd(peers)} aria-label={describeCrowd(peers)}>
      {shown.map((peer, index) => (
        <span
          // Session identity is never sent to the browser, so the key is the
          // one thing that IS unique here: where they are plus who they are.
          key={`${peer.kind}:${peer.host}:${peer.username}:${index}`}
          className={`presence-dot is-${peer.kind}`}
        >
          {initial(peer)}
        </span>
      ))}
      {extra > 0 && <span className="presence-dot is-more">+{extra}</span>}
    </span>
  );
}

export interface PresenceBarProps {
  peers: Peer[];
  /**
   * False when the gateway could not read Designer per-file presence.
   *
   * Shown as a caveat rather than hidden: "nobody else is here" and "I cannot
   * see half of who is here" are different statements, and only one of them
   * should let someone start editing with confidence.
   */
  designerFeed: boolean;
}

/**
 * The line above the editor when somebody else has this file open.
 *
 * Renders nothing when the file is yours alone — an always-present bar saying
 * "nobody else is here" costs a row of the editor forever to tell you the
 * ordinary case, and it trains the eye to skip exactly the row that matters.
 */
export function PresenceBar({ peers, designerFeed }: PresenceBarProps) {
  if (peers.length === 0) return null;
  const designers = peers.filter((peer) => peer.kind === 'designer');
  return (
    <div className="presence-bar" role="status">
      <PresenceBadge peers={peers} max={4} />
      <span className="presence-bar-text">
        {describeCrowd(peers)}
        {' '}
        {/* The honest verb. The Designer reports what a session has OPEN, and so
            do we, so a tab left open over lunch counts as presence. Saying
            "editing" would be a claim neither feed can support. */}
        <span className="muted">Saving is not blocked — talk to them first.</span>
      </span>
      {designers.length > 0 && !designerFeed && (
        <span className="presence-bar-caveat muted">
          Designer files are not visible on this gateway; these are sessions only.
        </span>
      )}
    </div>
  );
}

/**
 * The same information as a list, for the status footer's popover.
 *
 * Exported separately because the footer shows presence for the whole PROJECT,
 * not for one file: someone in the Designer who has opened nothing yet is worth
 * knowing about and belongs to no file at all.
 */
export function PresenceList({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) {
    return <p className="presence-empty muted">Nobody else has this project open.</p>;
  }
  return (
    <ul className="presence-list">
      {peers.map((peer, index) => (
        <li key={`${peer.kind}:${peer.host}:${peer.username}:${index}`}>
          <span className={`presence-dot is-${peer.kind}`}>{initial(peer)}</span>
          <span className="presence-who">{describePeer(peer)}</span>
          <span className="presence-what muted">
            {peer.resources.length === 0
              ? 'no script open'
              : `${peer.resources.length} script${peer.resources.length === 1 ? '' : 's'} open`}
          </span>
        </li>
      ))}
    </ul>
  );
}

export { peerName };
