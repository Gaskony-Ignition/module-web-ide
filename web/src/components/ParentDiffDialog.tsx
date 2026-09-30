/**
 * What an override actually changed, against the copy it overrides.
 *
 * Overriding a resource does not lose inheritance — the Designer's menu on an
 * overridden script offers *Discard Overrides*, whose dialog says it will
 * "return to its inherited state" — and until 1.16.0 neither this IDE nor the
 * Designer could show you what you were about to discard. So the destructive
 * action existed and the look-first did not.
 *
 * Read-only by design. It answers one question and offers no button that writes:
 * the two things a reader might want next — take the parent's copy, or discard
 * the override — are both real decisions that belong to the controls already
 * built for them, not to a comparison view.
 */
import { useEffect, useMemo, useState } from 'react';
import { readInheritedContent } from '../api/scripts';
import { ApiError } from '../api/scripts';
import { diffLines } from '../workspace/lineDiff';
import './ParentDiffDialog.css';

export interface ParentDiffDialogProps {
  project: string;
  path: string;
  scriptKey?: string;
  label: string;
  /** The buffer as it stands — what the parent is being compared against. */
  mine: string;
  onClose: () => void;
}

export default function ParentDiffDialog({
  project, path, scriptKey, label, mine, onClose,
}: ParentDiffDialogProps) {
  const [theirs, setTheirs] = useState<string | null>(null);
  const [parent, setParent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    readInheritedContent(project, path, scriptKey)
      .then((copy) => {
        if (cancelled) return;
        setTheirs(copy.text);
        setParent(copy.parent);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // A 404 here is an ANSWER, not a failure: this project owns the resource
        // outright and there is nothing above it to differ from.
        setError(
          e instanceof ApiError && e.status === 404
            ? 'No parent project has a copy of this script — nothing is being overridden.'
            : e instanceof Error ? e.message : String(e)
        );
      });
    return () => {
      cancelled = true;
    };
  }, [project, path, scriptKey]);

  const rows = useMemo(
    // (left, right) = (the parent's copy, mine). `diffLines` calls a line present
    // only in LEFT `removed` and one present only in RIGHT `added`, so `+` is a
    // line your override adds and `−` is one it drops — which is what the
    // footer promises.
    () => (theirs === null ? [] : diffLines(theirs, mine)),
    [theirs, mine]
  );
  const changed = rows.filter((row) => row.kind !== 'same').length;

  return (
    <div className="parentdiff-backdrop" role="presentation" onClick={onClose}>
      <div
        className="parentdiff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Compare ${label} with the parent project`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="parentdiff-head">
          <h2>{label} — compared with {parent || 'the parent project'}</h2>
          <button type="button" className="parentdiff-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {error ? (
          <p className="parentdiff-empty muted">{error}</p>
        ) : theirs === null ? (
          <p className="parentdiff-empty muted">Reading the parent's copy…</p>
        ) : (
          <>
            <p className="parentdiff-status" role="status">
              {changed === 0
                ? 'Identical. This override changes nothing — discarding it would lose no work.'
                : `${changed} ${changed === 1 ? 'line differs' : 'lines differ'} from `
                  + `${parent}. Discarding the override would return the file to that copy.`}
            </p>
            <div className="parentdiff-body">
              {rows.map((row, index) => (
                <div
                  key={`${index}:${row.kind}`}
                  className={`parentdiff-row is-${row.kind}`}
                >
                  {/* A glyph AND a fill AND an edge, the same three signals the
                      conflict dialog settled on: colour alone fails for a
                      colour-blind reader and on a projector. */}
                  <span className="parentdiff-mark">
                    {row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}
                  </span>
                  <span className="parentdiff-text">
                    {(row.kind === 'removed' ? row.left : row.right) ?? ' '}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <footer className="parentdiff-foot">
          <p className="parentdiff-note muted">
            Read-only. <strong>+</strong> is in your override, <strong>−</strong> is in
            the parent.
          </p>
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
