/**
 * Shown when a save comes back 409 — the resource changed on the gateway since
 * this tab read it.
 *
 * This is a P1 requirement rather than polish. The gateway's script resources are
 * not owned by this IDE: a Designer, or the web-designer module, can be editing
 * the same resource on the same gateway at the same time. Without this dialog the
 * only two options a user gets are "lose their work" and "lose yours", and
 * neither is offered as a choice.
 *
 * "Keep mine" is a deliberate force: it re-reads to obtain the CURRENT signature
 * and saves against that, which is exactly the overwrite the 409 prevented. It is
 * safe only because the other version is on screen beside it.
 */
import { useEffect, useMemo, useRef } from 'react';
import { diffLines } from '../workspace/lineDiff';
import './ConflictDialog.css';

export interface ConflictDialogProps {
  label: string;
  /** The buffer in this tab. */
  mine: string;
  /** What the gateway holds now. */
  theirs: string;
  /** Who last wrote the gateway's copy, when the server told us. */
  theirsOwner?: string;
  busy?: boolean;
  onReloadTheirs: () => void;
  onKeepMine: () => void;
  onCancel: () => void;
}

export default function ConflictDialog({
  label,
  mine,
  theirs,
  theirsOwner,
  busy = false,
  onReloadTheirs,
  onKeepMine,
  onCancel,
}: ConflictDialogProps) {
  const rows = useMemo(() => diffLines(mine, theirs), [mine, theirs]);
  // A diff with nothing changed in it. It happens when the resource SIGNATURE
  // moved and the bytes did not — a gateway restart re-stamps resources — and
  // showing two identical columns with no comment is what Nigel hit on
  // 04/09/2026: "when i click on the compare I couldn't see any differences".
  // There were none. Saying so is the whole fix; guessing is not.
  const identical = mine === theirs;
  const changed = useMemo(
    () => rows.filter((row) => row.kind !== 'same').length,
    [rows]
  );

  /*
   * Put the FIRST difference on screen.
   *
   * A conflict on line 400 of a 600-line script opens at line 1, and the
   * reader's first act is to scroll looking for the colour. Scrolling to it is
   * the difference between a diff that answers the question and one that sets
   * a search task.
   */
  const firstChange = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    firstChange.current?.scrollIntoView({ block: 'center' });
  }, [rows]);

  let seenChange = false;

  // Escape cancels, as it does for every other modal here. Bound on the
  // document rather than the dialog: focus may be inside the diff panes, which
  // are scrollable regions of their own.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="conflict-backdrop" role="presentation">
      <div className="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
        <h2 id="conflict-title">
          {identical
            ? `${label} — the gateway's copy is identical`
            : `${label} changed on the gateway`}
        </h2>
        {identical ? (
          <p className="muted">
            The stored copy was re-saved{theirsOwner ? ` by ${theirsOwner}` : ''},
            but its text is byte for byte what you have. Nothing of yours is at
            risk. Reloading and keeping yours do the same thing here; either one
            clears this.
          </p>
        ) : (
          <p className="muted">
            This script was written on the gateway after you opened it
            {theirsOwner ? ` (${theirsOwner})` : ''}. Your changes were not saved.
            {' '}
            <strong>{changed}</strong> {changed === 1 ? 'line differs' : 'lines differ'} —
            marked below.
          </p>
        )}

        <div className="conflict-diff" aria-label="Differences">
          <div className="conflict-column-heads">
            <span>Yours (in this tab)</span>
            <span>On the gateway</span>
          </div>
          {identical && (
            <p className="conflict-identical muted" role="status">
              No differences. Every line below is the same on both sides.
            </p>
          )}
          <ol className="conflict-rows">
            {rows.map((row, index) => {
              const isFirstChange = row.kind !== 'same' && !seenChange;
              if (isFirstChange) seenChange = true;
              return (
              <li
                key={index}
                ref={isFirstChange ? firstChange : undefined}
                className={`conflict-row conflict-${row.kind}`}
              >
                <code className="conflict-side">{row.left ?? ''}</code>
                <code className="conflict-side">{row.right ?? ''}</code>
              </li>
              );
            })}
          </ol>
        </div>

        <div className="conflict-actions">
          <button type="button" className="button" onClick={onReloadTheirs} disabled={busy}>
            Reload theirs (discard mine)
          </button>
          <button type="button" className="button button-danger" onClick={onKeepMine} disabled={busy}>
            Keep mine (overwrite theirs)
          </button>
          <button type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
