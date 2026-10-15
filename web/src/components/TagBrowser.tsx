/**
 * The Tag Browser: a lazy tree of tag providers and folders beside a detail pane
 * for the selected tag — value, write, configuration JSON, create and delete.
 *
 * Mounted for the life of the page and hidden by the bottom panel when another
 * tab is showing, so `visible` is what stops the value polling: a hidden tab
 * must not keep reading the gateway.
 *
 * Only the children of EXPANDED folders are read, and only atomic tags — the
 * same rule that keeps the poll cheap on a provider with tens of thousands of
 * tags. A folder's children are browsed once when it opens; the refresh button
 * re-browses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  browseTags, createTags, deleteTags, fetchTagConfig, fetchTagProviders, parseTagInput,
  readTags, writeTag,
} from '../api/tags';
import type { TagNode, TagValue } from '../api/tags';
import { copyText } from './clipboard';
import './TagBrowser.css';

/** Matches the Designer's own tag browser refresh. */
const POLL_MILLIS = 5000;

export interface TagBrowserProps {
  csrfToken: string | undefined;
  isAdmin: boolean;
  executionEnabled: boolean;
  /** False while another panel tab is showing, or the panel is closed. */
  visible: boolean;
}

interface Row {
  /** Full `[provider]a/b` path — the identity of a row. */
  path: string;
  name: string;
  depth: number;
  node: TagNode;
  /** A non-selectable line saying the folder above was cut off at the browse cap. */
  truncatedNote?: boolean;
}

const COLLISIONS = ['Abort', 'Ignore', 'Overwrite', 'MergeOverwrite'] as const;

/** By object type, not data type: a UDT definition reports a data type too. */
function isAtomic(node: TagNode): boolean {
  return node.objectType === 'AtomicTag';
}

/** `Bad_NodeIdUnknown("long diagnostic")` → `Bad_NodeIdUnknown`; the detail pane keeps the whole text. */
export function qualityCode(quality: string): string {
  const paren = quality.indexOf('(');
  return paren > 0 ? quality.slice(0, paren) : quality;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function TagBrowser({ csrfToken, isAdmin, executionEnabled, visible }: TagBrowserProps) {
  const canMutate = isAdmin && executionEnabled;
  const [providers, setProviders] = useState<string[]>([]);
  /** Children by parent path; providers are keyed `[name]`. */
  const [children, setChildren] = useState<Record<string, TagNode[]>>({});
  /** Folders whose browse hit the gateway's cap — shown in the tree, not as a status. */
  const [truncated, setTruncated] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, TagValue>>({});
  const [selected, setSelected] = useState<{ path: string; node: TagNode | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [writeText, setWriteText] = useState('');
  const [configText, setConfigText] = useState('');
  const [collision, setCollision] = useState<(typeof COLLISIONS)[number]>('Abort');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadChildren = useCallback(async (path: string) => {
    try {
      const result = await browseTags(path);
      setChildren((prev) => ({ ...prev, [path]: result.children }));
      setTruncated((prev) => {
        if (prev.has(path) === result.truncated) return prev;
        const next = new Set(prev);
        if (result.truncated) next.add(path); else next.delete(path);
        return next;
      });
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const loadProviders = useCallback(async () => {
    try {
      const names = await fetchTagProviders();
      setProviders(names);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    if (isAdmin) void loadProviders();
  }, [isAdmin, loadProviders]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (parent: string, depth: number) => {
      for (const node of children[parent] ?? []) {
        const path = parent.endsWith(']') ? `${parent}${node.name}` : `${parent}/${node.name}`;
        out.push({ path, name: node.name, depth, node });
        if (expanded.has(path)) walk(path, depth + 1);
      }
      if (truncated.has(parent)) {
        out.push({ path: `${parent}\u0000more`, name: '', depth, node: { name: '', hasChildren: false, objectType: '', dataType: null }, truncatedNote: true });
      }
    };
    for (const provider of providers) {
      const root = `[${provider}]`;
      out.push({
        path: root, name: provider, depth: 0,
        node: { name: provider, hasChildren: true, objectType: 'Provider', dataType: null },
      });
      if (expanded.has(root)) walk(root, 1);
    }
    return out;
  }, [providers, children, expanded, truncated]);

  // Atomic tags under an expanded folder, plus the selection, are what the poll reads.
  const polledPaths = useMemo(() => {
    const paths = rows.filter((row) => isAtomic(row.node)).map((row) => row.path);
    if (selected && !paths.includes(selected.path) && selected.node && isAtomic(selected.node)) {
      paths.push(selected.path);
    }
    return paths;
  }, [rows, selected]);

  const pathsRef = useRef<string[]>([]);
  pathsRef.current = polledPaths;

  const poll = useCallback(async () => {
    const paths = pathsRef.current;
    if (paths.length === 0) return;
    try {
      const read = await readTags(paths.slice(0, 500), csrfToken);
      setValues((prev) => {
        const next = { ...prev };
        for (const value of read) next[value.path] = value;
        return next;
      });
    } catch (e) {
      setError(message(e));
    }
  }, [csrfToken]);

  useEffect(() => {
    if (!visible || !isAdmin) return undefined;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MILLIS);
    return () => window.clearInterval(timer);
  }, [visible, isAdmin, poll, polledPaths]);

  const toggle = useCallback((row: Row) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.path)) {
        next.delete(row.path);
      } else {
        next.add(row.path);
        void loadChildren(row.path);
      }
      return next;
    });
  }, [loadChildren]);

  const select = useCallback((row: Row) => {
    setSelected({ path: row.path, node: row.node });
    setConfirmDelete(false);
    setStatus(null);
    setConfigText('');
    const current = values[row.path];
    setWriteText(current && current.value !== null ? String(current.value) : '');
  }, [values]);

  const refresh = useCallback(async () => {
    setStatus(null);
    await loadProviders();
    await Promise.all([...expanded].map((path) => loadChildren(path)));
    await poll();
  }, [expanded, loadChildren, loadProviders, poll]);

  const doWrite = useCallback(async () => {
    if (!selected?.node) return;
    const parsed = parseTagInput(writeText, selected.node.dataType);
    if (parsed === undefined) {
      setError(`'${writeText}' is not a valid ${selected.node.dataType} value.`);
      return;
    }
    try {
      const result = await writeTag(selected.path, parsed, csrfToken);
      setError(null);
      setStatus(result.ok ? 'Written.' : `Write refused: ${result.results.join(', ')}`);
      await poll();
    } catch (e) {
      setError(message(e));
    }
  }, [selected, writeText, csrfToken, poll]);

  const doConfig = useCallback(async () => {
    if (!selected) return;
    try {
      setConfigText(await fetchTagConfig(selected.path));
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [selected]);

  const doCreate = useCallback(async () => {
    if (!selected) return;
    try {
      const result = await createTags(selected.path, configText, collision, csrfToken);
      setError(null);
      setStatus(result.ok ? 'Created.' : `Create refused: ${result.results.join(', ')}`);
      await loadChildren(selected.path);
      setExpanded((prev) => new Set(prev).add(selected.path));
    } catch (e) {
      setError(message(e));
    }
  }, [selected, configText, collision, csrfToken, loadChildren]);

  const doDelete = useCallback(async () => {
    if (!selected) return;
    try {
      const result = await deleteTags([selected.path], csrfToken);
      setError(null);
      setStatus(result.ok ? 'Deleted.' : `Delete refused: ${result.results.join(', ')}`);
      setSelected(null);
      setConfirmDelete(false);
      const parent = selected.path.slice(0, Math.max(selected.path.lastIndexOf('/'), selected.path.indexOf(']') + 1));
      await loadChildren(parent);
    } catch (e) {
      setError(message(e));
    }
  }, [selected, csrfToken, loadChildren]);

  if (!isAdmin) {
    return <div className="tb tb-note">The Tag Browser needs the Administrator role.</div>;
  }

  const selectedValue = selected ? values[selected.path] : undefined;
  const selectedIsProvider = selected !== null && selected.node?.objectType === 'Provider';

  return (
    <div className="tb">
      <div className="tb-tree" role="tree" aria-label="Tags">
        <div className="tb-toolbar">
          <button type="button" onClick={() => void refresh()}>Refresh</button>
          <span className="tb-hint">{providers.length} provider{providers.length === 1 ? '' : 's'}</span>
        </div>
        {rows.map((row) => {
          if (row.truncatedNote) {
            return (
              <div key={row.path} className="tb-row tb-more" style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * var(--space-3) + 1.2em)` }}>
                First 2000 shown
              </div>
            );
          }
          const isOpen = expanded.has(row.path);
          const value = values[row.path];
          const isSelected = selected?.path === row.path;
          return (
            <div
              key={row.path}
              role="treeitem"
              aria-selected={isSelected}
              aria-expanded={row.node.hasChildren ? isOpen : undefined}
              className={`tb-row${isSelected ? ' tb-row-selected' : ''}`}
              style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * var(--space-3))` }}
            >
              <button
                type="button"
                className="tb-disclosure"
                aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${row.name}`}
                onClick={() => toggle(row)}
                disabled={!row.node.hasChildren}
              >
                {row.node.hasChildren ? (isOpen ? '▾' : '▸') : ''}
              </button>
              <button type="button" className="tb-name" onClick={() => select(row)}>{row.name}</button>
              {value && (
                <span className={`tb-value${value.good ? '' : ' tb-value-bad'}`}>
                  {value.value === null ? 'null' : String(value.value)} [{qualityCode(value.quality)}]
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="tb-detail">
        {error && <div className="tb-error" role="alert">{error}</div>}
        {!selected && (status
          ? <div className="tb-status" role="status">{status}</div>
          : <div className="tb-note">Select a tag or folder.</div>)}
        {selected && (
          <>
            <div className="tb-path">{selected.path}</div>
            {status && <div className="tb-status" role="status">{status}</div>}
            <div className="tb-actions">
              <button type="button" onClick={() => void copyText(selected.path)}>Copy path</button>
              {!selectedIsProvider && <button type="button" onClick={() => void doConfig()}>Get configuration</button>}
              {!selectedIsProvider && (
                confirmDelete ? (
                  <>
                    <button type="button" className="primary" onClick={() => void doDelete()} disabled={!canMutate}>
                      Confirm delete
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmDelete(true)} disabled={!canMutate}>Delete</button>
                )
              )}
            </div>

            {selectedValue && (
              <div className="tb-readout">
                {selectedValue.value === null ? 'null' : String(selectedValue.value)}
                {' '}<span className="tb-hint">{selectedValue.quality} · {selectedValue.timestamp ?? 'no timestamp'}</span>
              </div>
            )}

            {selected.node && isAtomic(selected.node) && (
              <div className="tb-actions">
                <input
                  className="tb-input"
                  aria-label={`New value (${selected.node.dataType})`}
                  value={writeText}
                  onChange={(e) => setWriteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canMutate) void doWrite(); }}
                />
                <button type="button" className="primary" onClick={() => void doWrite()} disabled={!canMutate}>
                  Write
                </button>
              </div>
            )}

            {(configText !== '' || selected.node?.hasChildren) && (
              <>
              <label className="tb-label" htmlFor="tb-config">
                Configuration JSON{selected.node?.hasChildren ? ' — Create adds it under this folder' : ''}
              </label>
              <textarea
                id="tb-config"
                className="tb-config"
                spellCheck={false}
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
              />
              </>
            )}
            {selected.node?.hasChildren && (
              <div className="tb-actions">
                <select
                  aria-label="If a tag already exists"
                  value={collision}
                  onChange={(e) => setCollision(e.target.value as (typeof COLLISIONS)[number])}
                >
                  {COLLISIONS.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void doCreate()}
                  disabled={!canMutate || configText.trim() === ''}
                >
                  Create
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
