/**
 * This user's past ad hoc queries, kept across gateway restarts.
 *
 * A sibling of {@link RunHistoryDialog}, not a generalisation of it: a console
 * run keeps Jython source and captured output, and a query run keeps a
 * datasource and a row/affected summary instead — different enough fields that
 * forcing one dialog to render both shapes would mean every row special-casing
 * which kind of run it is. Same gateway-side reasoning in `QueryHistory`'s
 * class Javadoc for the store itself.
 *
 * ## Load, don't re-run
 *
 * The button says "Load into editor" and that is all it does — the same
 * principle as the console's history, and arguably more important here: a
 * one-click re-run of SQL from history against a live database, with no chance
 * to read it first, is not a convenience.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchDbQueryHistory, type DbQueryHistoryEntry } from '../api/dbQueries';
import './QueryHistoryDialog.css';

export interface QueryHistoryDialogProps {
  onClose: () => void;
  /** Put this run's datasource and SQL into the browser. */
  onLoad: (datasource: string, sql: string) => void;
}

/** A run's timestamp as a local date and 24-hour time. */
export function runLabel(at: number): string {
  if (!at) return 'unknown time';
  return new Date(at).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** The first non-blank line, which is what a person recognises a query by. */
export function firstLine(sql: string): string {
  const line = sql.split('\n').find((row) => row.trim().length > 0) ?? '';
  return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}

/** How long a run took, in the coarsest unit that still says something. */
export function durationLabel(ms: number): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Does this run match what was typed? Over the SQL, the datasource and the summary/error. */
export function queryMatches(entry: DbQueryHistoryEntry, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (!query) return true;
  return (
    entry.sql.toLowerCase().includes(query)
    || entry.datasource.toLowerCase().includes(query)
    || entry.summary.toLowerCase().includes(query)
    || (entry.error ?? '').toLowerCase().includes(query)
  );
}

/** Elements Tab should cycle between while this dialog is open. */
function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])'
    )
  );
}

export default function QueryHistoryDialog({ onClose, onLoad }: QueryHistoryDialogProps) {
  const [entries, setEntries] = useState<DbQueryHistoryEntry[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Whatever had focus before this dialog opened — the button that opened
  // it, almost always — so closing puts focus back rather than dropping it
  // onto the document body.
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDbQueryHistory()
      .then((result) => {
        if (cancelled) return;
        setEntries(result.runs);
        if (result.runs.length > 0) setSelected(result.runs[0].id);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement : null;
    filterRef.current?.focus();
    return () => {
      openerRef.current?.focus();
    };
  }, []);

  const shown = useMemo(
    () => (entries ?? []).filter((entry) => queryMatches(entry, filter)),
    [entries, filter]
  );

  useEffect(() => {
    if (shown.length === 0) {
      setSelected(null);
    } else if (!shown.some((entry) => entry.id === selected)) {
      setSelected(shown[0].id);
    }
  }, [shown, selected]);

  const current = shown.find((entry) => entry.id === selected) ?? null;

  return (
    <div className="qhist-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="qhist-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Query history"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== 'Tab' || !dialogRef.current) {
            return;
          }
          // A focus trap: Tab must cycle within the dialog, not escape to
          // whatever is behind the backdrop.
          const focusables = focusableElements(dialogRef.current);
          if (focusables.length === 0) {
            return;
          }
          const first = focusables[0];
          const last = focusables[focusables.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="qhist-head">
          <h2>Query history</h2>
          <button type="button" className="qhist-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="qhist-body">
          <div className="qhist-list">
            <div className="qhist-search">
              <input
                ref={filterRef}
                type="search"
                className="qhist-filter"
                placeholder="Search SQL and datasource"
                aria-label="Search the query history"
                spellCheck={false}
                autoComplete="off"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {entries !== null && (
                <span className="qhist-count muted">
                  {filter.trim()
                    ? `${shown.length} of ${entries.length}`
                    : `${entries.length} run${entries.length === 1 ? '' : 's'}`}
                </span>
              )}
            </div>
            {error ? (
              <p className="qhist-empty muted">Could not read the query history: {error}</p>
            ) : entries === null ? (
              <p className="qhist-empty muted">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="qhist-empty muted">
                Nothing run here yet. Every run is kept from now on and survives a gateway
                restart.
              </p>
            ) : shown.length === 0 ? (
              <p className="qhist-empty muted">
                No run here matches “{filter.trim()}”. The search reads the SQL, the datasource
                and the result, and only the last {entries.length} runs are kept.
              </p>
            ) : (
              <ul>
                {shown.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`qhist-run${selected === entry.id ? ' is-selected' : ''}`}
                      onClick={() => setSelected(entry.id)}
                    >
                      <span className="qhist-when">
                        <span className={`qhist-mark is-${entry.ok ? 'ok' : 'failed'}`}>
                          {entry.ok ? '✓' : '✗'}
                        </span>
                        {runLabel(entry.at)} · {entry.datasource}
                        {durationLabel(entry.durationMs) ? ` · ${durationLabel(entry.durationMs)}` : ''}
                      </span>
                      <span className="qhist-first">{firstLine(entry.sql)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="qhist-detail">
            {current === null ? (
              <p className="qhist-empty muted">Select a run to see it.</p>
            ) : (
              <>
                <h3 className="qhist-section">SQL</h3>
                <pre className="qhist-sql">{current.sql}</pre>
                <h3 className="qhist-section">Result</h3>
                <p className="qhist-result">
                  {current.ok ? (current.summary || 'no result') : (current.error ?? 'failed')}
                </p>
              </>
            )}
          </div>
        </div>

        <footer className="qhist-foot">
          <p className="qhist-note muted">
            Loading puts the datasource and SQL into the browser. It does not run it.
          </p>
          <div className="qhist-actions">
            <button type="button" className="button button-quiet" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="button"
              disabled={current === null}
              onClick={() => {
                if (current) {
                  onLoad(current.datasource, current.sql);
                  onClose();
                }
              }}
            >
              Load into editor
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
