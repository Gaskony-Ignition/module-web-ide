/**
 * Local history: the versions this IDE has saved of the open document.
 *
 * This module writes straight into a running gateway, and until 1.15.0 nothing
 * anywhere kept the version before the one you just wrote — not the platform,
 * not this module, and not git, which is a settled decision rather than an
 * oversight. So "I broke it ten minutes ago" had no answer at all.
 *
 * ## Restore loads the buffer. It does not write.
 *
 * The button says "Load into editor" and that is exactly what it does: the old
 * text goes into the tab, dirty, and the ordinary Save writes it — with the same
 * If-Match, the same inheritance rule and the same byte fidelity as any other
 * save. A restore that wrote directly would be a second write path with its own
 * bugs, and it would take away the one moment where someone can look at what
 * they are about to do and press Ctrl+Z instead.
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchHistory, readHistoryVersion, type SavedVersion } from '../api/scripts';
import './HistoryDialog.css';

export interface HistoryDialogProps {
  project: string;
  path: string;
  scriptKey?: string;
  /** The tab's label, for the heading. */
  label: string;
  /** The text in the editor right now, so a version can be marked identical. */
  currentText: string;
  onClose: () => void;
  /** Put this text into the editor as an unsaved edit. */
  onLoad: (text: string) => void;
}

/** A saved-at millis as a local date and time, which is what a person compares. */
export function versionLabel(savedAt: number): string {
  if (!savedAt) return 'unknown time';
  return new Date(savedAt).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Bytes as something readable at a glance. */
export function sizeLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  return `${(size / 1024).toFixed(1)} KB`;
}

export default function HistoryDialog({
  project, path, scriptKey, label, currentText, onClose, onLoad,
}: HistoryDialogProps) {
  const [versions, setVersions] = useState<SavedVersion[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchHistory(project, path, scriptKey)
      .then((result) => {
        if (cancelled) return;
        setVersions(result.versions);
        // Select the newest immediately. A dialog that opens on an empty right
        // pane makes the user do a click whose answer is always the same.
        if (result.versions.length > 0) setSelected(result.versions[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project, path, scriptKey]);

  useEffect(() => {
    if (!selected) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewError('');
    readHistoryVersion(project, path, scriptKey, selected)
      .then((text) => {
        if (!cancelled) setPreview(text);
      })
      .catch((e: unknown) => {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project, path, scriptKey, selected]);

  const load = useCallback(() => {
    if (preview === null) return;
    onLoad(preview);
    onClose();
  }, [onClose, onLoad, preview]);

  return (
    <div className="history-backdrop" role="presentation" onClick={onClose}>
      <div
        className="history-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Local history for ${label}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="history-head">
          <h2>Local history — {label}</h2>
          <button type="button" className="history-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="history-body">
          <div className="history-list">
            {error ? (
              <p className="history-empty muted">Could not read the history: {error}</p>
            ) : versions === null ? (
              <p className="history-empty muted">Loading…</p>
            ) : versions.length === 0 ? (
              <p className="history-empty muted">
                Nothing saved from this IDE yet. Every save from here is kept, starting with
                the version that was on the gateway before the first one.
              </p>
            ) : (
              <ul>
                {versions.map((version, index) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      className={`history-version${selected === version.id ? ' is-selected' : ''}`}
                      onClick={() => setSelected(version.id)}
                    >
                      <span className="history-when">{versionLabel(version.savedAt)}</span>
                      <span className="history-meta">
                        {sizeLabel(version.size)}
                        {index === 0 ? ' · most recent' : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="history-preview">
            {previewError ? (
              <p className="history-empty muted">Could not read that version: {previewError}</p>
            ) : preview === null ? (
              <p className="history-empty muted">
                {selected ? 'Loading…' : 'Select a version to see it.'}
              </p>
            ) : (
              <>
                {preview === currentText && (
                  // Worth saying plainly: the commonest reason a restore looks
                  // like it did nothing is that it restored what was already
                  // there.
                  <p className="history-same" role="status">
                    This is identical to what is in the editor now.
                  </p>
                )}
                <pre className="history-source">{preview}</pre>
              </>
            )}
          </div>
        </div>

        <footer className="history-foot">
          <p className="history-note muted">
            Loading a version puts it in the editor as an unsaved change. Nothing is written
            to the gateway until you save.
          </p>
          <div className="history-actions">
            <button type="button" className="button button-quiet" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="button"
              disabled={preview === null || preview === currentText}
              onClick={load}
            >
              Load into editor
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
