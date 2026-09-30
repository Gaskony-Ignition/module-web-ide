/**
 * The right rail: every class and function in the open script, click to jump.
 *
 * The Designer has this and it is the thing you miss most in a long script, so
 * it is a first-class panel rather than a popup.
 *
 * The symbols come from the gateway's own Jython parse, not from a client-side
 * grammar — the client grammar is Python 3 and would mis-parse `print "x"`,
 * producing an outline that silently loses everything after the first py2-only
 * line. That is also why a transient syntax error does NOT empty this panel: the
 * server keeps the last good symbol table, so the outline stays usable while you
 * are mid-edit, which is exactly when you need it.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LspClient, SymbolInformation } from '../api/lspClient';
import { IconClose } from './Icons';
import './OutlinePanel.css';

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      className="outline-close"
      aria-label="Hide the outline"
      title="Hide the outline"
      onClick={onClose}
    >
      <IconClose size={13} />
    </button>
  );
}

export interface OutlinePanelProps {
  /** URI of the document to outline, or null when nothing is open. */
  uri: string | null;
  /** Bumped by the workspace when the buffer changes, to re-request. */
  revision?: number;
  lsp?: LspClient | null;
  onJump: (line: number, character: number) => void;
  /** Set by the workspace's splitter. Remembered per viewer. */
  width?: number;
  onClose?: () => void;
}

/** LSP SymbolKind values the server emits. */
const KIND_CLASS = 5;
const KIND_METHOD = 6;
const KIND_FUNCTION = 12;

function kindLabel(kind: number): string {
  if (kind === KIND_CLASS) return 'class';
  if (kind === KIND_METHOD) return 'method';
  if (kind === KIND_FUNCTION) return 'def';
  return 'name';
}

interface OutlineRow {
  symbol: SymbolInformation;
  /** 0 for a top-level symbol, 1 for something inside a class. */
  depth: number;
}

/**
 * Flatten the server's SymbolInformation list into display rows.
 *
 * The server sends a flat list; the only record of nesting is `containerName`.
 * A symbol whose container is also a symbol in this document is shown indented
 * under it. A container we cannot see — a module name, say — is NOT treated as
 * nesting, because indenting under an invisible parent just looks like a bug.
 */
export function toOutlineRows(symbols: SymbolInformation[]): OutlineRow[] {
  const names = new Set(symbols.map((s) => s.name));
  const ordered = [...symbols].sort(
    (a, b) => a.location.range.start.line - b.location.range.start.line
  );
  return ordered.map((symbol) => ({
    symbol,
    depth: symbol.containerName && names.has(symbol.containerName) ? 1 : 0,
  }));
}

export default function OutlinePanel({
  uri,
  revision = 0,
  lsp,
  onJump,
  width,
  onClose,
}: OutlinePanelProps) {
  const [symbols, setSymbols] = useState<SymbolInformation[]>([]);
  const [filter, setFilter] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!uri || !lsp) {
      setSymbols([]);
      return;
    }
    // Debounced: the workspace bumps `revision` on every keystroke, and asking
    // the server to re-parse per character would make typing the slow thing.
    const timer = setTimeout(() => {
      lsp
        .documentSymbols(uri)
        .then((result) => {
          if (!cancelled) {
            setSymbols(result);
            setFailed(false);
          }
        })
        .catch(() => {
          // Keep whatever is on screen. An outline that empties itself because
          // one request failed is worse than a slightly stale one.
          if (!cancelled) setFailed(true);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [uri, revision, lsp]);

  const rows = useMemo(() => {
    const all = toOutlineRows(symbols);
    if (!filter.trim()) return all;
    const needle = filter.trim().toLowerCase();
    return all.filter((row) => row.symbol.name.toLowerCase().includes(needle));
  }, [symbols, filter]);

  const style = width ? { width, flex: `0 0 ${width}px` } : undefined;

  if (!uri) {
    return (
      <aside className="outline" aria-label="Outline" style={style}>
        <div className="outline-head">
          <span className="outline-title">Outline</span>
          <span className="outline-spacer" />
          {onClose && <CloseButton onClose={onClose} />}
        </div>
        <p className="outline-empty muted">Open a script to see its outline.</p>
      </aside>
    );
  }

  return (
    <aside className="outline" aria-label="Outline" style={style}>
      <div className="outline-head">
        <span className="outline-title">Outline</span>
        <span className="outline-count muted">{symbols.length}</span>
        <span className="outline-spacer" />
        {onClose && <CloseButton onClose={onClose} />}
      </div>
      <input
        className="outline-filter"
        type="search"
        value={filter}
        placeholder="Filter…"
        aria-label="Filter outline"
        spellCheck={false}
        onChange={(event) => setFilter(event.target.value)}
      />
      {failed && (
        <p className="outline-stale muted" role="status">
          Showing the last outline — the gateway did not answer the latest request.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="outline-empty muted">
          {symbols.length === 0 ? 'No functions or classes.' : 'Nothing matches.'}
        </p>
      ) : (
        <ul className="outline-list">
          {rows.map((row) => (
            <li key={`${row.symbol.name}-${row.symbol.location.range.start.line}`}>
              <button
                type="button"
                className="outline-item"
                style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * var(--space-4))` }}
                onClick={() =>
                  onJump(
                    row.symbol.location.range.start.line,
                    row.symbol.location.range.start.character
                  )
                }
                title={`Line ${row.symbol.location.range.start.line + 1}`}
              >
                <span className={`outline-kind outline-kind-${kindLabel(row.symbol.kind)}`}>
                  {kindLabel(row.symbol.kind)}
                </span>
                <span className="outline-name">{row.symbol.name}</span>
                <span className="outline-line muted">{row.symbol.location.range.start.line + 1}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
