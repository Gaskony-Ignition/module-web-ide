/**
 * The Search view: project-wide text search, and the results of a references
 * lookup.
 *
 * Both land here rather than in a peek popup because they answer the same
 * question — "where else does this appear?" — and a results list you can leave
 * open while you read the code is more useful than one that closes when you
 * click a result. It is also the view `ActivityBar` said was missing since P4:
 * `scriptide/searchText` has been answered by the gateway since 1.0.0 and had no
 * caller.
 *
 * **Replace is offered for a TEXT search and never for references.** The server
 * matches references by name, not by receiver, so the list can contain two
 * unrelated members that happen to share a name — replacing across it would
 * rename the wrong one, which is exactly the trap the label below warns about.
 * The replace row is hidden in references mode rather than disabled, because a
 * disabled control invites you to look for the way to enable it.
 *
 * **References are labelled name-based on screen, every time.** The server
 * matches whole identifiers, not receivers (see `LspClient#references`), so two
 * unrelated `write` methods both appear. A results list that did not say so
 * would be read as a find-references it is not, and the first time someone
 * renamed from it they would break the other one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LspClient, TextSearchHit } from '../api/lspClient';
import { labelForLocation } from '../workspace/locations';
import { summarise as summariseReport, type ReplaceReport } from '../workspace/replaceAll';
import { IconSearch } from './Icons';
import './SearchPanel.css';

/** What the results currently are. */
export type SearchMode = 'text' | 'references' | 'unused';

export interface SearchPanelProps {
  project: string;
  lsp: LspClient | null;
  /**
   * A references request from elsewhere — Shift+F12 in the editor.
   *
   * A counter rides with the name so pressing Shift+F12 twice on the same
   * identifier re-runs the search: the name alone would compare equal and the
   * second press would look like nothing happened.
   */
  referencesRequest: { name: string; nonce: number } | null;
  onOpenLocation: (uri: string, line: number, character: number) => void;
  /**
   * Replace the search term in every file listed, or undefined when the caller
   * cannot write — a non-administrator gets the search and no replace row at
   * all, rather than a button that 403s.
   */
  onReplaceAll?: (
    uris: string[],
    term: string,
    replacement: string,
    caseSensitive: boolean
  ) => Promise<ReplaceReport>;
  /**
   * A replace handed over by a rename: search for `from`, pre-fill `to`.
   *
   * The panel does NOT run it. A rename that rewrote every file mentioning the
   * old name would be a bulk write with no preview; this puts the user in front
   * of the file list with both boxes filled and the confirm still to press.
   */
  pendingReplace?: { from: string; to: string } | null;
  onPendingReplaceHandled?: () => void;
}

/** Results grouped by the file they are in, in the order the server sent them. */
function groupByFile(hits: TextSearchHit[]): Array<{ label: string; hits: TextSearchHit[] }> {
  const groups = new Map<string, { label: string; hits: TextSearchHit[] }>();
  for (const hit of hits) {
    const label = labelForLocation(hit);
    const group = groups.get(hit.uri);
    if (group) {
      group.hits.push(hit);
    } else {
      groups.set(hit.uri, { label, hits: [hit] });
    }
  }
  return [...groups.values()];
}

export default function SearchPanel({
  project, lsp, referencesRequest, onOpenLocation, onReplaceAll,
  pendingReplace, onPendingReplaceHandled,
}: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<TextSearchHit[]>([]);
  const [mode, setMode] = useState<SearchMode>('text');
  /** The name a references list is FOR — shown in the heading. */
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Null until a search has actually run, so the empty view is not "no results". */
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [replacement, setReplacement] = useState('');
  /** The confirmation step. Null when no replace has been asked for. */
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [report, setReport] = useState<ReplaceReport | null>(null);

  const runText = useCallback(
    async (term: string, matchCase: boolean) => {
      if (!lsp || !project || term.length === 0) {
        setHits([]);
        setSearched(false);
        return;
      }
      setMode('text');
      setSubject(term);
      setBusy(true);
      setError('');
      // A report describes the list it ran against, so a new search retires it.
      // Cleared HERE rather than in an effect on `hits`: the replace re-runs the
      // search itself and then posts its report, and an effect would have raced
      // that and wiped the report the user is meant to read.
      setReport(null);
      setConfirming(false);
      try {
        // caseSensitive is passed through the same request the server already
        // reads it from; it is not filtered here, or the result cap would be
        // applied before the case rule and silently lose matches.
        setHits(await lsp.searchText(project, term, matchCase));
      } catch (e: unknown) {
        setHits([]);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        setSearched(true);
      }
    },
    [lsp, project]
  );

  const runUnused = useCallback(async () => {
    if (!lsp || !project) return;
    setMode('unused');
    setSubject('');
    setBusy(true);
    setError('');
    setReport(null);
    setConfirming(false);
    try {
      setHits(await lsp.unusedSymbols(project));
    } catch (e: unknown) {
      setHits([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setSearched(true);
    }
  }, [lsp, project]);

  // A rename has just moved a module and wants its call sites updated.
  useEffect(() => {
    if (!pendingReplace) return;
    setQuery(pendingReplace.from);
    setReplacement(pendingReplace.to);
    void runText(pendingReplace.from, true);
    onPendingReplaceHandled?.();
    // `runText` is stable for a given project and lsp; re-running this on its
    // identity would re-search on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReplace]);

  // A references request arrives from the editor. It sets the input to the name
  // too, so the box always says what the list below it is about — and so the
  // next Enter re-runs it as an ordinary text search, which is the honest
  // widening when the name-based list missed something.
  useEffect(() => {
    if (!referencesRequest || !lsp || !project) return;
    const { name } = referencesRequest;
    let cancelled = false;
    setQuery(name);
    setMode('references');
    setSubject(name);
    setBusy(true);
    setError('');
    setReport(null);
    setConfirming(false);
    lsp
      .references(project, name)
      .then((found) => {
        if (!cancelled) setHits(found);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setHits([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (cancelled) return;
        setBusy(false);
        setSearched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [lsp, project, referencesRequest]);

  // Changing project invalidates every result: the URIs in them name the old
  // one, and clicking a row would try to open a script from a project the tree
  // is no longer showing.
  useEffect(() => {
    setHits([]);
    setSearched(false);
    setError('');
  }, [project]);

  const groups = useMemo(() => groupByFile(hits), [hits]);

  /** The files a replace would touch, in the order they are listed. */
  const fileUris = useMemo(() => [...new Set(hits.map((hit) => hit.uri))], [hits]);

  // Text mode only. A references list matches by name, and an unused list is a
  // list of DEFINITIONS — replacing across either renames things that merely
  // share a spelling.
  const canReplace =
    Boolean(onReplaceAll) && mode === 'text' && searched && hits.length > 0 && subject.length > 0;

  const doReplace = useCallback(async () => {
    if (!onReplaceAll || subject.length === 0) return;
    setReplacing(true);
    setConfirming(false);
    try {
      const result = await onReplaceAll(fileUris, subject, replacement, caseSensitive);
      // Re-run the search so the list shows the world after the write. Without
      // this the results still name the old text and clicking one jumps to a
      // line that no longer contains it.
      //
      // The report is posted AFTER that search, not before: `runText` retires
      // any standing report as its first act, so setting it first put the
      // report on screen and then cleared it a tick later.
      await runText(subject, caseSensitive);
      setReport(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplacing(false);
    }
  }, [caseSensitive, fileUris, onReplaceAll, replacement, runText, subject]);

  return (
    <div className="search-panel">
      <form
        className="search-panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          void runText(query, caseSensitive);
        }}
      >
        <div className="search-panel-input">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            spellCheck={false}
            placeholder="Search the project library"
            aria-label="Search the project library"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <label className="search-panel-case">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => {
              const next = event.target.checked;
              setCaseSensitive(next);
              // Re-run immediately: a toggle that changes the answer but not the
              // list on screen reads as a broken control.
              if (searched && mode === 'text') void runText(query, next);
            }}
          />
          Match case
        </label>
        <button
          type="button"
          className="search-panel-unused"
          onClick={() => void runUnused()}
          title="Library functions and classes nothing in the project appears to call"
        >
          Unused
        </button>
      </form>

      {canReplace && (
        <div className="search-panel-replace">
          {/* NOT `.search-panel-input`. That class already addresses the search
              box, and adding a second element under it made every existing
              `.search-panel-input input` selector ambiguous — which broke
              validate_v16_nav the moment a search returned hits. */}
          <div className="search-panel-replace-input">
            <input
              type="text"
              value={replacement}
              spellCheck={false}
              placeholder="Replace with"
              aria-label="Replace with"
              onChange={(event) => {
                setReplacement(event.target.value);
                setConfirming(false);
              }}
            />
          </div>
          <button
            type="button"
            className="search-panel-replace-button"
            disabled={replacing}
            onClick={() => (confirming ? void doReplace() : setConfirming(true))}
          >
            {replacing
              ? 'Replacing…'
              : confirming
                ? `Replace in ${fileUris.length} ${fileUris.length === 1 ? 'file' : 'files'}`
                : 'Replace all…'}
          </button>
        </div>
      )}

      {canReplace && confirming && (
        // A confirmation with the actual numbers in it, not a yes/no. The whole
        // risk of this feature is doing more than you meant to, and the two
        // things that say whether it is about to are the count and the exact
        // text — including an EMPTY replacement, which deletes rather than
        // replaces and reads like a mistake unless it is spelled out.
        <p className="search-panel-confirm" role="status">
          {replacement.length === 0
            ? `This will DELETE all ${hits.length} occurrences of “${subject}” in `
            : `This will replace all ${hits.length} occurrences of “${subject}” with `
              + `“${replacement}” in `}
          {fileUris.length} {fileUris.length === 1 ? 'file' : 'files'}, on the gateway.
          {' '}Inherited scripts and files with unsaved changes are skipped.
          {' '}Press the button again to go ahead.
        </p>
      )}

      {report && (
        <div className="search-panel-report" role="status">
          <p className="search-panel-report-line">{summariseReport(report)}</p>
          {report.outcomes
            .filter((outcome) => outcome.status !== 'changed')
            .map((outcome) => (
              <p key={outcome.uri} className="search-panel-report-skip">
                <span className="search-panel-report-file">{outcome.label}</span>
                {' — '}
                {outcome.reason ?? outcome.status}
              </p>
            ))}
        </div>
      )}

      <p className="search-panel-status" role="status">
        {busy
          ? 'Searching…'
          : error
            ? error
            : !searched
              ? 'Searches every script on the gateway — Project Library, Gateway Events, '
                + 'Web Dev handlers and pages, and named-query SQL — not just the open ones.'
              : mode === 'unused'
                ? `${hits.length} top-level ${hits.length === 1 ? 'function or class' : 'functions and classes'} `
                  + 'that nothing in this project names anywhere else — matched by NAME, so '
                  + 'anything called from a Perspective binding, a Vision window, an alarm '
                  + 'pipeline or outside this project will appear here and is NOT unused. '
                  + 'Read it; do not delete from it unexamined.'
              : mode === 'references'
                ? `${hits.length} ${hits.length === 1 ? 'place' : 'places'} where “${subject}” `
                  + 'is written — matched by NAME, not by type, so unrelated members '
                  + 'with the same name are included.'
                : `${hits.length} ${hits.length === 1 ? 'result' : 'results'} for “${subject}”, `
                  + 'across every script and named query in the project.'}
      </p>

      <div className="search-panel-results">
        {groups.map((group) => (
          <section key={group.label} className="search-panel-group">
            <h3 className="search-panel-file">{group.label}</h3>
            <ul>
              {group.hits.map((hit) => (
                <li key={`${hit.uri}:${hit.line}:${hit.character ?? 0}`}>
                  <button
                    type="button"
                    className="search-panel-hit"
                    onClick={() => onOpenLocation(hit.uri, hit.line, hit.character ?? 0)}
                  >
                    <span className="search-panel-line">{hit.line + 1}</span>
                    {/* The matching line verbatim, INCLUDING its indentation:
                        the shape of the code around a hit is most of what tells
                        you whether it is the one you wanted. */}
                    <span className="search-panel-text">{hit.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
