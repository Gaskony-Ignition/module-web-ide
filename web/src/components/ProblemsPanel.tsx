/**
 * Problems: every open document's diagnostics in one list.
 *
 * The editor has shown an inline squiggle and a gutter marker since P5, and both
 * are per-file and only visible in the file you are looking at. With six tabs
 * open, a syntax error in the one you are not looking at is invisible until you
 * switch to it — which is exactly when it is least useful to find out.
 *
 * **Open documents only, and the empty state says so.** The gateway publishes
 * diagnostics for documents the language server holds, and it holds the ones
 * this client opened. A list headed "Problems" that silently covered a third of
 * the project would be worse than no list: an empty one would read as "the
 * project is clean".
 *
 * ## Two lists, because they are two different claims (1.15.0)
 *
 * Everything above is STATIC analysis of code that has not run. The second list
 * is the opposite: what the gateway has actually logged while running this
 * project's scripts in the last hour. A timer script that has been failing every
 * thirty seconds since Tuesday produces nothing at all in the first list — it
 * parses, its names resolve — and is the most urgent thing on the screen.
 *
 * They are kept visibly apart rather than merged. A merged list would have to
 * pretend the two have comparable positions and severities, and a runtime error
 * has no line number here at all: the gateway logs a message, not a range.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LspClient, LspDiagnostic } from '../api/lspClient';
import { lspUri } from '../api/lspClient';
import { fetchRuntimeErrors, type RuntimeErrors } from '../api/scripts';
import type { OpenDoc } from '../workspace/documents';
import { IconAlert } from './Icons';
import { copyText } from './clipboard';
import './ProblemsPanel.css';

/** How often the runtime list refreshes itself while the panel is open. */
const RUNTIME_REFRESH_MS = 60_000;

export interface ProblemsPanelProps {
  docs: OpenDoc[];
  lsp: LspClient | null;
  /** Jump to a problem: the workspace document key, and where in it. */
  onOpen: (uri: string, line: number, character: number) => void;
  /**
   * The project whose gateway log to read, or undefined to show only the
   * static list — which is what a caller with no project selected should do.
   */
  project?: string;
}

/** A timestamp as "3 min ago", which is what the reader actually wants. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One row: a diagnostic plus the document it belongs to. */
export interface ProblemRow {
  /** The WORKSPACE document key, which is what `onOpen` and the tabs use. */
  docUri: string;
  label: string;
  diagnostic: LspDiagnostic;
}

/**
 * Errors first, then by file, then by line.
 *
 * Severity leads because a list sorted only by position buries the one thing
 * that stops the script running under a dozen hints. Ties fall back to the
 * document label and line so the order is stable between renders — a list that
 * reshuffles as diagnostics are republished cannot be clicked reliably.
 */
export function sortProblems(rows: ProblemRow[]): ProblemRow[] {
  return [...rows].sort((a, b) => {
    const severityA = a.diagnostic.severity ?? 1;
    const severityB = b.diagnostic.severity ?? 1;
    return (
      severityA - severityB
      || a.label.localeCompare(b.label)
      || a.diagnostic.range.start.line - b.diagnostic.range.start.line
      || a.diagnostic.range.start.character - b.diagnostic.range.start.character
    );
  });
}

/** LSP DiagnosticSeverity → the word on the row. */
export function severityLabel(severity: number | undefined): string {
  switch (severity) {
    case 2:
      return 'warning';
    case 3:
      return 'info';
    case 4:
      return 'hint';
    default:
      return 'error';
  }
}

export default function ProblemsPanel({ docs, lsp, onOpen, project }: ProblemsPanelProps) {
  // Keyed by workspace document URI, so a closed tab's entry can be dropped
  // without touching anything else.
  const [byDoc, setByDoc] = useState<Record<string, LspDiagnostic[]>>({});
  /**
   * The (document key, server URI) pairs to subscribe to.
   *
   * Two keys per document, because the workspace and the language server do NOT
   * agree on one: the workspace uses `project::path::key` and the server
   * `ignition://project/path#key`. Subscribing with the wrong one is silent —
   * every diagnostic is dropped and the list stays empty however broken the code
   * is. That exact confusion cost a day in P5; see the LSP-key finding in
   * `docs/STATE.md`.
   */
  const subscriptions = useMemo(
    () => docs.map((doc) => ({
      docKey: doc.uri,
      serverUri: lspUri(doc.project, doc.path, doc.scriptKey),
    })),
    [docs]
  );

  // Resubscribed when the SET of open documents changes, not on every keystroke:
  // `docs` is a new array on every edit, and tearing every subscription down and
  // rebuilding it per character typed would drop pushes arriving in between.
  const subscriptionKey = subscriptions.map((s) => s.docKey).join('\n');

  useEffect(() => {
    if (!lsp) return;
    const unsubscribes = subscriptions.map(({ docKey, serverUri }) =>
      lsp.onDiagnostics(serverUri, (diagnostics) => {
        setByDoc((current) => ({ ...current, [docKey]: diagnostics }));
      })
    );
    // Drop anything that is no longer open, in the same pass that resubscribes:
    // a closed tab's problems must leave the list, and its own unsubscribe only
    // stops FUTURE updates — it does not retract what was already stored.
    const openKeys = new Set(subscriptions.map((s) => s.docKey));
    setByDoc((current) => {
      const next: Record<string, LspDiagnostic[]> = {};
      for (const [key, value] of Object.entries(current)) {
        if (openKeys.has(key)) next[key] = value;
      }
      return next;
    });
    return () => {
      for (const off of unsubscribes) off();
    };
    // `subscriptions` is derived from `docs` and changes identity on every edit;
    // the key above is what actually decides when to resubscribe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionKey, lsp]);

  // ---- the runtime half -------------------------------------------------
  const [runtime, setRuntime] = useState<RuntimeErrors | null>(null);
  const [runtimeError, setRuntimeError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const loadRuntime = useCallback(() => {
    if (!project) {
      setRuntime(null);
      return;
    }
    fetchRuntimeErrors(project)
      .then((next) => {
        setRuntime(next);
        setRuntimeError('');
        setNow(Date.now());
      })
      .catch((e: unknown) => {
        // Named rather than swallowed: an empty runtime list and a broken
        // runtime query look identical, and one of them means "you are fine".
        setRuntime(null);
        setRuntimeError(e instanceof Error ? e.message : String(e));
      });
  }, [project]);

  useEffect(() => {
    loadRuntime();
    const timer = window.setInterval(loadRuntime, RUNTIME_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [loadRuntime]);

  const rows = useMemo(() => {
    const out: ProblemRow[] = [];
    for (const doc of docs) {
      for (const diagnostic of byDoc[doc.uri] ?? []) {
        out.push({ docUri: doc.uri, label: doc.label, diagnostic });
      }
    }
    return sortProblems(out);
  }, [byDoc, docs]);

  // The runtime list renders whether or not anything is open, because a failing
  // timer script has nothing to do with which tabs happen to be up. Before
  // 1.15.0 the whole panel returned early on an empty editor and the most urgent
  // thing on the gateway had nowhere to appear.
  const runtimeSection = (
    <RuntimeProblems
      project={project}
      runtime={runtime}
      error={runtimeError}
      now={now}
      onRefresh={loadRuntime}
    />
  );

  if (docs.length === 0) {
    return (
      <div className="problems">
        <p className="problems-empty muted">Open a script to see its problems.</p>
        {runtimeSection}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="problems">
        <p className="problems-empty muted">
          No problems in the {docs.length === 1 ? 'open script' : `${docs.length} open scripts`}.
          Only open scripts are checked.
        </p>
        {runtimeSection}
      </div>
    );
  }

  return (
    <div className="problems">
      <ul className="problems-list">
        {rows.map((row) => {
          const severity = severityLabel(row.diagnostic.severity);
          const line = row.diagnostic.range.start.line;
          const character = row.diagnostic.range.start.character;
          return (
            <li key={`${row.docUri}:${line}:${character}:${row.diagnostic.message}`}>
              <button
                type="button"
                className="problems-row"
                onClick={() => onOpen(row.docUri, line, character)}
              >
                <IconAlert size={14} className={`problems-icon is-${severity}`} />
                <span className="problems-message">{row.diagnostic.message}</span>
                <span className="problems-where">
                  {row.label} · {line + 1}:{character + 1}
                </span>
              </button>
              {/* Take the text away. A parser message is what you paste into a
                  search or a question, and selecting it out of a button by hand
                  is not something a button lets you do (Nigel, 03/09/2026). */}
              <button
                type="button"
                className="problems-copy"
                aria-label={`Copy: ${row.diagnostic.message}`}
                title="Copy this message"
                onClick={() => {
                  void copyText(
                    `${row.label}:${line + 1}:${character + 1} ${row.diagnostic.message}`
                  );
                }}
              >
                Copy
              </button>
            </li>
          );
        })}
      </ul>
      {runtimeSection}
    </div>
  );
}

/**
 * What the gateway has logged about this project, as opposed to what the parser
 * thinks of the code.
 *
 * Rows are not clickable. A log line carries a message and no range, and a row
 * that looked clickable and did nothing — or worse, guessed a file — would be a
 * worse answer than one that plainly is not a link.
 */
function RuntimeProblems({
  project, runtime, error, now, onRefresh,
}: {
  project?: string;
  runtime: RuntimeErrors | null;
  error: string;
  now: number;
  onRefresh: () => void;
}) {
  if (!project) return null;
  return (
    <section className="problems-runtime">
      <h3 className="problems-runtime-head">
        <span>
          From the gateway
          {runtime ? ` · last ${runtime.windowMinutes} min` : ''}
        </span>
        <button type="button" className="problems-runtime-refresh" onClick={onRefresh}>
          Refresh
        </button>
      </h3>

      {/* Which SCRIPTS are failing, ahead of the individual messages. This is
          the R2 question — "has that timer been throwing since Tuesday" — and
          it is the half of it the SDK can actually answer: there is no
          timer-task registry, so there is no last fire or next fire, and a log
          line appears only on failure. Silence here is not proof of health, and
          the wording says only what it knows. */}
      {runtime && runtime.byScript.length > 0 && (
        <p className="problems-runtime-scripts" role="status">
          <strong>Failing scripts:</strong>{' '}
          {runtime.byScript
            .map((s) => `${s.script} (${s.count}×, ${relativeTime(s.lastSeen, now)})`)
            .join(' · ')}
        </p>
      )}

      {error ? (
        <p className="problems-empty muted">Could not read the gateway log: {error}</p>
      ) : !runtime ? (
        <p className="problems-empty muted">Reading the gateway log…</p>
      ) : runtime.errors.length === 0 ? (
        <p className="problems-empty muted">
          Nothing at warning level or worse mentioning “{project}”.
        </p>
      ) : (
        <>
          <ul className="problems-list">
            {runtime.errors.map((row) => (
              <li key={`${row.logger}:${row.message}`}>
                {/* NOT `.problems-row`. That class is what the live suites
                    count to assert how many static problems there are, and
                    sharing it would make a warning in the gateway log look like
                    a diagnostic in the code — to a suite, and to a reader. */}
                <div className="problems-runtime-row">
                  <IconAlert
                    size={14}
                    className={`problems-icon is-${row.level === 'WARN' ? 'warning' : 'error'}`}
                  />
                  <span className="problems-message">
                    {row.message}
                    {row.exception ? <span className="problems-trace">{row.exception}</span> : null}
                  </span>
                  <span className="problems-where">
                    {row.count > 1 ? `${row.count}× · ` : ''}
                    {relativeTime(row.lastSeen, now)}
                  </span>
                </div>
                <button
                  type="button"
                  className="problems-copy"
                  aria-label={`Copy: ${row.message}`}
                  title="Copy this message"
                  onClick={() => void copyText(`${row.logger} ${row.message}`)}
                >
                  Copy
                </button>
              </li>
            ))}
          </ul>
          {/* The server's own words for how it matched, because the rule is
              looser than the heading implies and a reader has to know that
              before acting on a row. */}
          <p className="problems-runtime-note muted">
            Matched by {runtime.matchedBy}. The full stack trace is in the gateway log.
          </p>
        </>
      )}
    </section>
  );
}
