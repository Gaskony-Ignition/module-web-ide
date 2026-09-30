/**
 * Choosing what to import out of a Designer resource zip.
 *
 * The Designer's own import dialog lists the archive's resources with a
 * checkbox each and one Import button — measured, see `docs/EXPORT-FORMAT.md`.
 * This one adds the two things that dialog leaves the user to find out
 * afterwards:
 *
 * **which ones already exist**, because every other write path in this module is
 * built on never replacing something the user has not seen, and an import that
 * quietly overwrote a script would be the one hole in that; and
 *
 * **which ones will not be written at all** — a Designer export can carry
 * Perspective views and images, and a script IDE that silently dropped them
 * would look like it had lost them. They are listed, greyed, and say why.
 */
import { useMemo, useState } from 'react';
import type { ImportInspection, ImportOutcome } from '../api/transfer';
import './ImportDialog.css';

export interface ImportDialogProps {
  project: string;
  fileName: string;
  inspection: ImportInspection;
  /** In flight, so the button says so and cannot be pressed twice. */
  busy?: boolean;
  /** Set once the write has happened; the dialog then reports rather than asks. */
  outcome?: ImportOutcome;
  error?: string;
  onImport: (paths: string[]) => void;
  onClose: () => void;
}

/** `ignition/script-python/util/helpers` → `util.helpers`, the name people use. */
export function displayName(path: string): string {
  const library = 'ignition/script-python/';
  if (path.startsWith(library)) {
    return path.slice(library.length).replace(/\//g, '.');
  }
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

export default function ImportDialog({
  project, fileName, inspection, busy, outcome, error, onImport, onClose,
}: ImportDialogProps) {
  const importable = useMemo(
    () => inspection.entries.filter((e) => e.importable),
    [inspection.entries]
  );
  const rejected = useMemo(
    () => inspection.entries.filter((e) => !e.importable),
    [inspection.entries]
  );
  // Everything importable, ticked. The Designer opens with everything ticked
  // too, and an import where the user has to tick twelve boxes before the
  // button does anything is a worse default than one they can untick.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(importable.map((e) => e.path))
  );

  const replacing = importable.filter((e) => chosen.has(e.path) && e.exists).length;

  function toggle(path: string) {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="import-backdrop" role="presentation">
      <div className="import-dialog" role="dialog" aria-modal="true"
           aria-label="Import project resources">
        <header className="import-head">
          <h2>Import into {project}</h2>
          <p className="muted import-file">{fileName}</p>
        </header>

        {outcome ? (
          <ImportReport outcome={outcome} />
        ) : (
          <>
            {inspection.source?.title && (
              <p className="muted import-source">
                Exported from <strong>{inspection.source.title}</strong>
              </p>
            )}

            <div className="import-list" role="group" aria-label="Resources to import">
              {importable.map((entry) => (
                <label key={entry.path} className="import-row">
                  <input
                    type="checkbox"
                    checked={chosen.has(entry.path)}
                    onChange={() => toggle(entry.path)}
                  />
                  <span className="import-name">{displayName(entry.path)}</span>
                  {/* The word the Designer never says. */}
                  {entry.exists && <span className="import-badge is-replaces">replaces</span>}
                  {!entry.exists && <span className="import-badge is-new">new</span>}
                </label>
              ))}
              {importable.length === 0 && (
                <p className="muted import-empty">
                  Nothing in this file can be imported here.
                </p>
              )}
            </div>

            {rejected.length > 0 && (
              <details className="import-rejected">
                <summary>
                  {rejected.length} other resource{rejected.length === 1 ? '' : 's'} in this
                  file will not be imported
                </summary>
                <p className="muted">
                  This is a script editor. It writes Project Library scripts and gateway
                  event scripts, and leaves everything else to the Designer — importing a
                  view here would write a resource nothing in this tool can open or undo.
                </p>
                <ul>
                  {rejected.map((entry) => <li key={entry.path}>{entry.path}</li>)}
                </ul>
              </details>
            )}

            {error && <p className="import-error" role="alert">{error}</p>}

            {replacing > 0 && (
              <p className="import-warning" role="status">
                {replacing} of these already exist in {project} and will be replaced.
                {' '}Their previous contents stay in this project's save history.
              </p>
            )}
          </>
        )}

        <footer className="import-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            {outcome ? 'Close' : 'Cancel'}
          </button>
          {!outcome && (
            <button
              type="button"
              className="button"
              disabled={busy || chosen.size === 0}
              onClick={() => onImport([...chosen])}
            >
              {busy ? 'Importing…' : `Import ${chosen.size}`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/**
 * What actually happened, per resource.
 *
 * Every path is reported, including the ones that did nothing. An import that
 * writes eight of ten and says "done" is how somebody discovers the other two
 * a week later.
 */
function ImportReport({ outcome }: { outcome: ImportOutcome }) {
  const failures = outcome.results.filter((r) => r.status === 'failed'
    || r.status === 'missing');
  return (
    <div className="import-report">
      <p className={failures.length ? 'import-error' : 'import-ok'}>
        {outcome.written} written{failures.length ? `, ${failures.length} failed` : ''}.
      </p>
      <ul className="import-list">
        {outcome.results.map((result) => (
          <li key={result.path} className={`import-result is-${result.status}`}>
            <span className="import-name">{displayName(result.path)}</span>
            <span className="import-status">{result.status}</span>
            {result.detail && <span className="muted import-detail">{result.detail}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
