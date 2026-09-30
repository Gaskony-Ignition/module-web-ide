/**
 * Quick open — Ctrl+P for scripts, Ctrl+T (or a `#` prefix) for symbols.
 *
 * The one navigation control that scales past a tree. A project with four
 * hundred library modules is unnavigable by scrolling, and the tree is the only
 * way to reach a file before 1.6.0; this is the same three keystrokes VS Code
 * users already have in their fingers.
 *
 * **Named queries are listed beside scripts** (1.7.0). One path filter over
 * both, because the whole point of the batch is that a query and the script
 * calling it are one piece of work — a second palette for queries would put
 * them back in two workspaces. Symbol mode is unchanged: the AST index covers
 * Python, and there is no SQL index in this version.
 *
 * **Files are matched locally, symbols on the gateway.** The script tree is
 * already in memory and filtering it is instant, which is what makes typing feel
 * like typing. Symbols cannot be — they come from the AST index, which is the
 * only thing that knows what is defined where — so that mode debounces and shows
 * its own "searching" state rather than pretending to be instant.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScriptEntry } from '../api/scripts';
import type { NamedQueryEntry } from '../api/namedQueries';
import type { LspClient, SymbolInformation } from '../api/lspClient';
import { labelFor } from '../workspace/documents';
import { IconDatabase, IconScript, IconSearch } from './Icons';
import './QuickOpen.css';

export interface QuickOpenProps {
  project: string;
  scripts: ScriptEntry[];
  /** Named queries in the same project. Absent is the same as none. */
  queries?: NamedQueryEntry[];
  lsp: LspClient | null;
  /** `#` starts the palette in symbol mode — what Ctrl+T opens. */
  initialQuery: string;
  onOpenEntry: (entry: ScriptEntry) => void;
  /** Omitted where queries are not offered; a query row then cannot appear. */
  onOpenQuery?: (entry: NamedQueryEntry) => void;
  /** A symbol hit: its LSP uri and where in that file it is. */
  onOpenLocation: (uri: string, line: number, character: number) => void;
  onClose: () => void;
}

/** How many rows are rendered. Beyond this, refine the query. */
const MAX_ROWS = 50;

/**
 * Subsequence match, VS Code style: `fpa` matches `FooParser`.
 *
 * Returns a score (lower is better) or null for no match. The score is
 * `firstIndex` — an early match ranks above a late one — with an exact substring
 * hit pulled to the front, because when someone types the whole name they mean
 * that file and not a file whose letters happen to be in order.
 */
export function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const exact = lowerHay.indexOf(lowerNeedle);
  if (exact >= 0) return exact;
  let at = -1;
  let first = -1;
  for (const character of lowerNeedle) {
    at = lowerHay.indexOf(character, at + 1);
    if (at < 0) return null;
    if (first < 0) first = at;
  }
  // Offset past every substring score, so a subsequence never outranks a
  // substring however early it starts.
  return 1000 + first;
}

/** LSP SymbolKind → a word for the row. Only the kinds this server emits. */
function kindLabel(kind: number): string {
  switch (kind) {
    case 5:
      return 'class';
    case 6:
      return 'method';
    case 12:
      return 'function';
    default:
      return 'variable';
  }
}

/**
 * One row of the file list — a script or a query.
 *
 * A tagged union rather than two lists, because the ranking is over BOTH: two
 * lists concatenated would put every script above every query however well the
 * query matched, which is the opposite of what one filter over one project
 * should do.
 */
type FileCandidate =
  | { kind: 'script'; entry: ScriptEntry }
  | { kind: 'query'; entry: NamedQueryEntry };

export default function QuickOpen({
  project, scripts, queries = [], lsp, initialQuery, onOpenEntry, onOpenQuery,
  onOpenLocation, onClose,
}: QuickOpenProps) {
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);
  const [symbols, setSymbols] = useState<SymbolInformation[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const symbolMode = query.startsWith('#');
  const term = symbolMode ? query.slice(1) : query;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Every keystroke resets the highlight to the top row. Without this, typing a
  // second character keeps row 5 selected while the list under it has changed,
  // and Enter opens something nobody looked at.
  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Symbols, debounced. The 120ms is not a guess at network latency — it is
  // roughly one keystroke at a fast typing speed, so a burst of typing sends one
  // request rather than one per character.
  useEffect(() => {
    if (!symbolMode || !lsp || !project) {
      setSymbols([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      lsp
        .workspaceSymbols(project, term)
        .then((found) => {
          if (!cancelled) setSymbols(found);
        })
        .catch(() => {
          if (!cancelled) setSymbols([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [lsp, project, symbolMode, term]);

  const fileRows = useMemo(() => {
    if (symbolMode) return [];
    const candidates: FileCandidate[] = [
      // A folder row is a directory, not a script — it has no body to open.
      // Same rule for an empty named-query folder.
      ...scripts.filter((entry) => !entry.isFolder).map(
        (entry) => ({ kind: 'script', entry }) as FileCandidate
      ),
      ...(onOpenQuery
        ? queries.filter((entry) => !entry.isFolder).map(
            (entry) => ({ kind: 'query', entry }) as FileCandidate
          )
        : []),
    ];
    return candidates
      .map((candidate) => ({ candidate, score: fuzzyScore(candidate.entry.path, term) }))
      .filter((row): row is { candidate: FileCandidate; score: number } => row.score !== null)
      .sort((a, b) => a.score - b.score
        || a.candidate.entry.path.localeCompare(b.candidate.entry.path))
      .slice(0, MAX_ROWS);
  }, [onOpenQuery, queries, scripts, symbolMode, term]);

  const symbolRows = useMemo(() => symbols.slice(0, MAX_ROWS), [symbols]);
  const rowCount = symbolMode ? symbolRows.length : fileRows.length;

  const choose = useCallback(
    (index: number) => {
      if (symbolMode) {
        const hit = symbolRows[index];
        if (!hit) return;
        onOpenLocation(hit.location.uri, hit.location.range.start.line,
          hit.location.range.start.character);
      } else {
        const row = fileRows[index];
        if (!row) return;
        if (row.candidate.kind === 'query') onOpenQuery?.(row.candidate.entry);
        else onOpenEntry(row.candidate.entry);
      }
      onClose();
    },
    [fileRows, onClose, onOpenEntry, onOpenLocation, onOpenQuery, symbolMode, symbolRows]
  );

  // Keep the highlighted row on screen when it moves off the end of the list.
  // Feature-detected: jsdom does not implement scrollIntoView, and a palette
  // that throws in the test environment cannot be tested at all.
  useEffect(() => {
    const node = listRef.current?.children[selected] as HTMLElement | undefined;
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected((n) => (rowCount === 0 ? 0 : (n + 1) % rowCount));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected((n) => (rowCount === 0 ? 0 : (n - 1 + rowCount) % rowCount));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(selected);
    }
  }

  return (
    // A click on the backdrop dismisses, exactly as pressing Escape does: a
    // palette that traps the pointer is a modal dialog, and this is not one.
    <div className="quick-open-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="quick-open"
        role="dialog"
        aria-modal="true"
        aria-label={symbolMode ? 'Go to symbol' : 'Go to script'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="quick-open-input">
          <IconSearch size={14} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            spellCheck={false}
            aria-label={symbolMode ? 'Symbol name' : 'Script path'}
            // The listbox is not focusable — the input keeps focus and drives it
            // — so the active row is announced through aria-activedescendant.
            aria-activedescendant={rowCount > 0 ? `quick-open-row-${selected}` : undefined}
            aria-controls="quick-open-list"
            placeholder={
              symbolMode
                ? 'Symbol name — a function, class or method in this project'
                : 'Script path — type # to search symbols instead'
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <ul
          className="quick-open-list"
          id="quick-open-list"
          role="listbox"
          aria-label={symbolMode ? 'Symbols' : 'Scripts and named queries'}
          ref={listRef}
        >
          {symbolMode
            ? symbolRows.map((hit, index) => (
                <li
                  key={`${hit.location.uri}:${hit.location.range.start.line}:${hit.name}`}
                  id={`quick-open-row-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  className={`quick-open-row${index === selected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setSelected(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(index);
                  }}
                >
                  <IconScript size={14} />
                  <span className="quick-open-name">{hit.name}</span>
                  <span className="quick-open-kind">{kindLabel(hit.kind)}</span>
                  <span className="quick-open-detail">{hit.containerName ?? ''}</span>
                </li>
              ))
            : fileRows.map((row, index) => {
                const candidate = row.candidate;
                const isQuery = candidate.kind === 'query';
                return (
                  <li
                    key={candidate.kind === 'query'
                      ? candidate.entry.path
                      : `${candidate.entry.path}::${candidate.entry.scriptKey}`}
                    id={`quick-open-row-${index}`}
                    role="option"
                    aria-selected={index === selected}
                    className={`quick-open-row${index === selected ? ' is-selected' : ''}`}
                    onMouseEnter={() => setSelected(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(index);
                    }}
                  >
                    {isQuery ? <IconDatabase size={14} /> : <IconScript size={14} />}
                    <span className="quick-open-name">
                      {candidate.kind === 'query'
                        ? candidate.entry.name
                        : labelFor(candidate.entry)}
                    </span>
                    <span className="quick-open-kind">
                      {candidate.kind === 'query' ? 'Named Query' : candidate.entry.typeLabel}
                    </span>
                    <span className="quick-open-detail">{candidate.entry.path}</span>
                  </li>
                );
              })}
          {rowCount === 0 && (
            <li className="quick-open-empty muted">
              {searching
                ? 'Searching…'
                : symbolMode
                  ? 'No symbol of that name in this project.'
                  : onOpenQuery
                    ? 'No script or query matches.'
                    : 'No script matches.'}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
