/**
 * The bottom of the left rail: language-server connection, and what the open
 * project contains.
 *
 * The connection line is the reason this component exists. When the socket is
 * down, completions and diagnostics stop arriving and nothing else in the UI
 * says so — a request made while the transport is not `open` is rejected before
 * it is sent, so the popup simply never appears. That is indistinguishable from
 * "this function has no completions", which is a wrong answer rather than a
 * missing one. A three-state dot is the cheapest way to make the difference
 * visible.
 *
 * The count line is the other half of the job: the rail is a fixed-width column
 * and a small project leaves most of it empty, so the footer anchors the bottom
 * edge with something true rather than with decoration.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ScriptEntry, ScriptTypeId } from '../api/scripts';
import type { TransportStatus } from '../api/lspTransport';
import './StatusFooter.css';

/**
 * The slice of {@link LspTransport} this component needs.
 *
 * Declared structurally, like `SocketLike`, so a test can drive every state
 * synchronously without a socket, a server, or fake timers.
 */
export interface ConnectionSource {
  getStatus(): TransportStatus;
  onStatus(listener: (status: TransportStatus) => void): () => void;
}

/** What the user is told, as opposed to what the transport calls itself. */
export type ConnectionState = 'idle' | 'connected' | 'reconnecting' | 'offline';

export interface StatusFooterProps {
  /** The loaded script list. Empty while the tree is still loading, or on error. */
  scripts: ScriptEntry[];
  transport: ConnectionSource;
}

const STATE_LABELS: Record<ConnectionState, string> = {
  idle: 'Language server idle',
  connected: 'Language server connected',
  reconnecting: 'Language server reconnecting…',
  offline: 'Language server offline',
};

/**
 * Transport status → what to show.
 *
 * `connecting` covers the first connect and every backoff retry alike, and
 * "reconnecting" is the honest word for both: either way there is no server yet
 * and answers are not coming.
 *
 * `idle` — nothing has ever opened the socket, because the LSP connects
 * lazily on the first script opened — is its OWN state, not folded into
 * `offline`. Before this fix it was: the footer showed "Language server
 * offline" in red on the landing page before any document was opened, which
 * reads as a fault when nothing has actually failed — a connection that was
 * never attempted cannot have dropped. `offline` is reserved for `closed`,
 * which the transport only reaches after `connecting` — i.e. after a real
 * attempt failed or a live connection dropped.
 */
export function connectionState(status: TransportStatus): ConnectionState {
  switch (status) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'reconnecting';
    case 'idle':
      return 'idle';
    default:
      return 'offline';
  }
}

/**
 * Count segments after the total, in the order FileTree groups them.
 *
 * Project Library entries get no segment of their own — they are the bulk of
 * the total and repeating them would say the same thing twice in a line that
 * has room for about thirty characters.
 */
const SEGMENTS: ReadonlyArray<{ typeId: ScriptTypeId; one: string; many: string }> = [
  { typeId: 'timer', one: 'timer', many: 'timers' },
  { typeId: 'message', one: 'message', many: 'messages' },
  { typeId: 'startup', one: 'startup', many: 'startups' },
  { typeId: 'shutdown', one: 'shutdown', many: 'shutdowns' },
  { typeId: 'update', one: 'update', many: 'updates' },
  { typeId: 'scheduled', one: 'scheduled', many: 'scheduled' },
  { typeId: 'tag-change', one: 'tag change', many: 'tag changes' },
];

/** `7 scripts · 2 timers`, from the tree the rail is already showing. */
export function describeCounts(scripts: ScriptEntry[]): string {
  // An empty Project Library package (`isFolder`) is a placeholder row so the
  // tree can show it as a folder, not a script anyone wrote — counting it
  // would claim a script that does not exist.
  const real = scripts.filter((entry) => !entry.isFolder);
  if (real.length === 0) return 'No scripts';
  const byType = new Map<string, number>();
  for (const entry of real) {
    byType.set(entry.typeId, (byType.get(entry.typeId) ?? 0) + 1);
  }
  const parts = [`${real.length} ${real.length === 1 ? 'script' : 'scripts'}`];
  for (const segment of SEGMENTS) {
    const count = byType.get(segment.typeId) ?? 0;
    if (count > 0) parts.push(`${count} ${count === 1 ? segment.one : segment.many}`);
  }
  return parts.join(' · ');
}

export default function StatusFooter({ scripts, transport }: StatusFooterProps) {
  const [status, setStatus] = useState<TransportStatus>(() => transport.getStatus());

  useEffect(() => {
    // Re-read on subscribe, not just on notification: a listener only ever
    // hears TRANSITIONS after it was added, so a socket that opened between the
    // first render and this effect would leave the dot permanently wrong.
    setStatus(transport.getStatus());
    return transport.onStatus(setStatus);
  }, [transport]);

  const state = connectionState(status);
  const counts = useMemo(() => describeCounts(scripts), [scripts]);

  return (
    <footer className="rail-footer">
      {/* A live region: losing the language server mid-session is exactly the
          kind of change a screen-reader user would otherwise never learn of. */}
      <p className={`rail-status is-${state}`} role="status">
        <span className="rail-status-dot" aria-hidden="true" />
        <span className="rail-status-label">{STATE_LABELS[state]}</span>
      </p>
      {/* The title carries the full string: the rail is 260px and a project with
          several event-script types will ellipsise. */}
      <p className="rail-counts" title={counts}>
        {counts}
      </p>
    </footer>
  );
}
