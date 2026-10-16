/**
 * The Tags side-bar view: every tag provider as a lazy tree, worked the way the
 * Designer's Tag Browser is — click a tag to edit it in a tab, right-click for
 * new/rename/duplicate/copy/cut/paste/delete/import/export/write, drag to move.
 *
 * 15/10/2026: the 1.30.7 bottom-panel browser was "useless" — tags were
 * expected to sit on the left and open in the editor like scripts. This
 * replaces it.
 *
 * Children are browsed when a folder opens and re-browsed after every change
 * this view makes, on Refresh, and every {@link WATCH_MILLIS} while the view is
 * on screen — a tag added in the Designer turns up without a click. Values are
 * read only for atomic tags in OPEN folders, and only while `active`: a
 * provider can hold tens of thousands of tags, and a hidden view must not keep
 * reading the gateway.
 *
 * The rows are one flat list of `treeitem`s carrying `aria-level`, with a
 * roving tabindex — the WAI-ARIA tree pattern, which the module's WCAG 2.1 AA
 * claim needs. Every gesture has a key: arrows, Enter, F2, Delete, Ctrl+C/X/V/D
 * and the context-menu key.
 */
import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent,
} from 'react';
import {
  browseTags, createTags, deleteTags, exportTags, fetchTagProviders, importTags, moveTags,
  parseTagInput, qualityCode, readTags, renameTag, writeTag,
  type TagCollision, type TagNode, type TagValue,
} from '../api/tags';
import { saveBlob } from '../api/transfer';
import { tagLabel } from '../workspace/documents';
import { useStickySet } from '../workspace/viewState';
import { copyText } from './clipboard';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import { makeDialogKeyDown } from './dialogA11y';
import {
  IconChevronDown, IconChevronRight, IconFolder, IconTag, IconTagProvider, IconUdtInstance, IconUdtType,
} from './Icons';
import TagNameDialog, { validateTagName } from './TagNameDialog';
import './TagTree.css';

/** Matches the Designer's own tag browser refresh. */
const POLL_MILLIS = 5000;
/** The same interval the script tree watches the gateway at. */
const WATCH_MILLIS = 20_000;
/** Most values read in one poll — the read route's own sanity cap. */
const POLL_CAP = 500;

/** What Copy or Cut put aside, held by the workspace so it outlives this view. */
export interface TagClipboard {
  paths: string[];
  cut: boolean;
}

export interface TagTreeProps {
  csrfToken: string | undefined;
  /** The session's role. Without it nothing is read: every tag route is Administrator-only. */
  isAdmin: boolean;
  /** Gateway-wide execution switch; every write is refused while it is off. */
  executionEnabled: boolean;
  /** The tag open in the focused editor tab, if any — marked in the tree. */
  activePath: string | null;
  clipboard: TagClipboard | null;
  onClipboard: (next: TagClipboard | null) => void;
  /** Open a tag in an editor tab. */
  onOpen: (path: string) => void;
  /** Tags that now live somewhere else — open tabs on them follow. */
  onMoved: (moves: Array<{ from: string; to: string }>) => void;
  /** Tags that no longer exist — open tabs on them close. */
  onDeleted: (paths: string[]) => void;
  onNotice: (kind: 'info' | 'error', text: string) => void;
  /** False stops the value poll and the watch. Defaults to true. */
  active?: boolean;
  /** Bumped by the owner to re-browse now, e.g. after a save renamed a tag. */
  refreshKey?: number;
}

interface Row {
  /** Full `[provider]a/b` path — a row's identity. */
  path: string;
  label: string;
  depth: number;
  node: TagNode;
}

/** The kinds "New" offers, by the value source each writes. */
const NEW_ATOMIC: Array<{ label: string; config: Record<string, unknown> }> = [
  { label: 'New Memory Tag', config: { valueSource: 'memory', dataType: 'Int4' } },
  { label: 'New OPC Tag', config: { valueSource: 'opc', dataType: 'Int4' } },
  { label: 'New Expression Tag', config: { valueSource: 'expr', dataType: 'Int4', expression: '' } },
  { label: 'New Query Tag', config: { valueSource: 'db', dataType: 'Int4' } },
  { label: 'New Reference Tag', config: { valueSource: 'reference', dataType: 'Int4' } },
  { label: 'New Derived Tag', config: { valueSource: 'derived', dataType: 'Int4' } },
];

const COLLISIONS: TagCollision[] = ['Abort', 'Overwrite', 'Rename', 'Ignore', 'MergeOverwrite'];

const TYPES_FOLDER = '_types_';

export function joinTagPath(parent: string, name: string): string {
  return parent.endsWith(']') ? `${parent}${name}` : `${parent}/${name}`;
}

/** The folder a tag sits in; null for a provider root. */
export function tagParent(path: string): string | null {
  const close = path.indexOf(']');
  if (close === path.length - 1) return null;
  const slash = path.lastIndexOf('/');
  return slash > close ? path.slice(0, slash) : path.slice(0, close + 1);
}

function providerRoot(path: string): string {
  return path.slice(0, path.indexOf(']') + 1);
}

/** True for the provider's Data Types folder and anything inside it. */
export function isUnderTypes(path: string): boolean {
  const types = `${providerRoot(path)}${TYPES_FOLDER}`;
  return path === types || path.startsWith(`${types}/`);
}

/** Somewhere a tag can be put: dropped on, pasted into, created in. */
function isContainer(node: TagNode): boolean {
  return node.objectType === 'Provider' || node.objectType === 'Folder' || node.objectType === 'UdtType';
}

function isExpandable(node: TagNode): boolean {
  return node.hasChildren || isContainer(node);
}

/** Folders and providers have nothing the editor would show; everything else opens. */
function isOpenable(node: TagNode): boolean {
  return node.objectType !== 'Provider' && node.objectType !== 'Folder';
}

/** `under` is `path` itself or inside it. */
function within(under: string, path: string): boolean {
  return under === path || under.startsWith(path.endsWith(']') ? path : `${path}/`);
}

/** Data Types first, as the Designer shows it, then folders, then everything else, by name. */
function sortNodes(nodes: TagNode[]): TagNode[] {
  const rank = (node: TagNode) => (node.name === TYPES_FOLDER ? 0 : node.objectType === 'Folder' ? 1 : 2);
  return [...nodes].sort((a, b) => rank(a) - rank(b)
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function iconFor(node: TagNode) {
  switch (node.objectType) {
    case 'Provider': return <IconTagProvider size={14} className="tag-tree-icon" />;
    case 'Folder': return <IconFolder size={14} className="tag-tree-icon" />;
    case 'UdtInstance': return <IconUdtInstance size={14} className="tag-tree-icon" />;
    case 'UdtType': return <IconUdtType size={14} className="tag-tree-icon" />;
    default: return <IconTag size={14} className="tag-tree-icon" />;
  }
}

/** A prompt the tree is showing, if any. */
type Prompt =
  | { kind: 'new'; folder: string; label: string; config: Record<string, unknown> }
  | { kind: 'new-udt-instance'; folder: string; types: string[] }
  | { kind: 'rename'; path: string }
  | { kind: 'write'; path: string; dataType: string | null; initial: string }
  | { kind: 'export'; paths: string[] }
  | { kind: 'import'; folder: string; content: string; format: 'json' | 'xml'; fileName: string }
  | { kind: 'delete'; paths: string[] };

export default function TagTree({
  csrfToken, isAdmin, executionEnabled, activePath, clipboard, onClipboard, onOpen, onMoved,
  onDeleted, onNotice, active = true, refreshKey = 0,
}: TagTreeProps) {
  const canEdit = isAdmin && executionEnabled;
  const editTitle = !isAdmin
    ? 'Changing tags needs the Administrator role'
    : 'Execution is switched off on this gateway, so tags cannot be changed';

  const [providers, setProviders] = useState<string[]>([]);
  /** Children by parent path; a provider is keyed `[name]`. */
  const [children, setChildren] = useState<Record<string, TagNode[]>>({});
  const [truncated, setTruncated] = useState<ReadonlySet<string>>(new Set());
  // Sticky: switching side-bar views unmounts this tree — see useStickySet.
  const [expanded, setExpanded] = useStickySet('tags.expanded');
  const [values, setValues] = useState<Record<string, TagValue>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(activePath ? [activePath] : [])
  );
  const [anchor, setAnchor] = useState<string | null>(activePath);
  const [focusPath, setFocusPath] = useState<string | null>(activePath);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const deleteRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const importFolderRef = useRef<string | null>(null);
  const dragRef = useRef<string[] | null>(null);
  /** Set when a keystroke moved the focus, so the effect below moves DOM focus too. */
  const moveFocusRef = useRef(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  // ---- reading ------------------------------------------------------------

  /** Browse one folder. `quiet` for background re-reads, where a vanished folder is not news. */
  const loadChildren = useCallback(async (path: string, quiet = false): Promise<boolean> => {
    try {
      const result = await browseTags(path);
      setChildren((prev) => ({ ...prev, [path]: sortNodes(result.children) }));
      setTruncated((prev) => {
        if (prev.has(path) === result.truncated) return prev;
        const next = new Set(prev);
        if (result.truncated) next.add(path); else next.delete(path);
        return next;
      });
      return true;
    } catch (e) {
      if (quiet) {
        // Deleted or renamed elsewhere: forget it rather than re-asking every 20 s.
        setExpanded((prev) => {
          if (!prev.has(path)) return prev;
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      } else {
        noticeRef.current('error', `Could not browse ${path}: ${describe(e)}`);
      }
      return false;
    }
  }, [setExpanded]);

  const loadProviders = useCallback(async () => {
    try {
      setProviders(await fetchTagProviders());
    } catch (e) {
      noticeRef.current('error', `Could not list tag providers: ${describe(e)}`);
    }
  }, []);

  /** Re-read the providers and every open folder. */
  const refreshAll = useCallback(async () => {
    await loadProviders();
    await Promise.all([...expandedRef.current].map((path) => loadChildren(path, true)));
  }, [loadChildren, loadProviders]);

  useEffect(() => {
    if (isAdmin) void refreshAll();
  }, [isAdmin, refreshAll, refreshKey]);

  useEffect(() => {
    if (!isAdmin || !active) return undefined;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshAll();
    }, WATCH_MILLIS);
    return () => window.clearInterval(timer);
  }, [active, isAdmin, refreshAll]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const walk = (parent: string, depth: number) => {
      for (const node of children[parent] ?? []) {
        const path = joinTagPath(parent, node.name);
        // The real path is kept — only the label changes.
        const label = node.name === TYPES_FOLDER && parent.endsWith(']') ? 'Data Types' : node.name;
        out.push({ path, label, depth, node });
        if (expanded.has(path)) walk(path, depth + 1);
      }
    };
    for (const provider of providers) {
      const root = `[${provider}]`;
      out.push({
        path: root, label: provider, depth: 0,
        node: { name: provider, hasChildren: true, objectType: 'Provider', dataType: null },
      });
      if (expanded.has(root)) walk(root, 1);
    }
    return out;
  }, [providers, children, expanded]);

  const rowByPath = useMemo(() => new Map(rows.map((row) => [row.path, row])), [rows]);

  // ---- live values --------------------------------------------------------

  const polled = useMemo(
    () => rows.filter((row) => row.node.objectType === 'AtomicTag').map((row) => row.path).slice(0, POLL_CAP),
    [rows]
  );
  const polledRef = useRef(polled);
  polledRef.current = polled;
  const pollKey = polled.join('\n');

  const poll = useCallback(async () => {
    const paths = polledRef.current;
    if (paths.length === 0 || document.hidden) return;
    try {
      const read = await readTags(paths, csrfToken);
      setValues((prev) => {
        const next = { ...prev };
        for (const value of read) next[value.path] = value;
        return next;
      });
    } catch {
      /* A failed poll is not worth a notice — the next one may well succeed. */
    }
  }, [csrfToken]);

  useEffect(() => {
    if (!isAdmin || !active || pollKey === '') return undefined;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MILLIS);
    return () => window.clearInterval(timer);
  }, [active, isAdmin, poll, pollKey]);

  // ---- expand, select, focus ---------------------------------------------

  const setOpen = useCallback((path: string, open: boolean) => {
    setExpanded((prev) => {
      if (prev.has(path) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(path); else next.delete(path);
      return next;
    });
    if (open) void loadChildren(path);
  }, [loadChildren, setExpanded]);

  const toggle = useCallback((row: Row) => {
    if (isExpandable(row.node)) setOpen(row.path, !expandedRef.current.has(row.path));
  }, [setOpen]);

  const focusRow = useCallback((path: string) => {
    moveFocusRef.current = true;
    setFocusPath(path);
  }, []);

  useEffect(() => {
    if (!moveFocusRef.current || !focusPath) return;
    moveFocusRef.current = false;
    // Matched on the dataset rather than a selector: a tag name may hold any
    // character a selector would have to escape.
    Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])
      .find((element) => element.dataset.path === focusPath)
      ?.focus();
  }, [focusPath, rows]);

  const selectOnly = useCallback((path: string) => {
    setSelected(new Set([path]));
    setAnchor(path);
  }, []);

  const selectRange = useCallback((from: string, to: string) => {
    const a = rows.findIndex((row) => row.path === from);
    const b = rows.findIndex((row) => row.path === to);
    if (a < 0 || b < 0) {
      setSelected(new Set([to]));
      return;
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelected(new Set(rows.slice(lo, hi + 1).map((row) => row.path)));
  }, [rows]);

  /** What an action applies to: the selection if `row` is in it, else `row` alone. */
  const targetsFor = useCallback((row: Row): string[] => (
    selected.has(row.path) ? rows.filter((r) => selected.has(r.path)).map((r) => r.path) : [row.path]
  ), [rows, selected]);

  // ---- writing ------------------------------------------------------------

  /** Run a write, report it, and re-read. A refused result is an error, not a success. */
  const mutate = useCallback(async (
    label: string, write: () => Promise<{ ok: boolean; results: string[] }>, done?: string
  ): Promise<boolean> => {
    try {
      const result = await write();
      if (!result.ok) {
        noticeRef.current('error', `${label} refused: ${result.results.map(qualityCode).join(', ')}`);
        await refreshAll();
        return false;
      }
      if (done) noticeRef.current('info', done);
      await refreshAll();
      return true;
    } catch (e) {
      noticeRef.current('error', `${label} failed: ${describe(e)}`);
      return false;
    }
  }, [refreshAll]);

  const create = useCallback(async (folder: string, config: Record<string, unknown>, name: string) => {
    setBusy(true);
    setPromptError(null);
    try {
      const result = await createTags(folder, JSON.stringify({ ...config, name }), 'Abort', csrfToken);
      if (!result.ok) {
        setPromptError(`Refused: ${result.results.map(qualityCode).join(', ')}`);
        return;
      }
      setPrompt(null);
      setOpen(folder, true);
      await refreshAll();
      const path = joinTagPath(folder, name);
      selectOnly(path);
      focusRow(path);
      noticeRef.current('info', `Created ${name}.`);
      if (config.tagType !== 'Folder') onOpen(path);
    } catch (e) {
      setPromptError(describe(e));
    } finally {
      setBusy(false);
    }
  }, [csrfToken, focusRow, onOpen, refreshAll, selectOnly, setOpen]);

  const rename = useCallback(async (path: string, newName: string) => {
    setBusy(true);
    setPromptError(null);
    try {
      const result = await renameTag(path, newName, csrfToken);
      if (!result.ok) {
        setPromptError(`Refused: ${result.results.map(qualityCode).join(', ')}`);
        return;
      }
      setPrompt(null);
      const to = joinTagPath(tagParent(path) ?? path, newName);
      onMoved([{ from: path, to }]);
      await refreshAll();
      selectOnly(to);
      focusRow(to);
      noticeRef.current('info', `Renamed to ${newName}.`);
    } catch (e) {
      setPromptError(describe(e));
    } finally {
      setBusy(false);
    }
  }, [csrfToken, focusRow, onMoved, refreshAll, selectOnly]);

  /** Copy each tag beside itself; `Rename` is what gives the copy a free name. */
  const duplicate = useCallback(async (paths: string[]) => {
    const byParent = new Map<string, string[]>();
    for (const path of paths) {
      const parent = tagParent(path);
      if (parent === null) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), path]);
    }
    for (const [parent, group] of byParent) {
      const ok = await mutate('Duplicate', () => moveTags(group, parent, true, 'Rename', csrfToken));
      if (!ok) return;
    }
    noticeRef.current('info', `Duplicated ${plural(paths.length, 'tag')}.`);
  }, [csrfToken, mutate]);

  /** Move or copy `paths` into `destination` — drag-and-drop and paste both land here. */
  const transfer = useCallback(async (paths: string[], destination: string, copy: boolean) => {
    if (paths.some((path) => within(destination, path))) {
      noticeRef.current('error', 'A tag cannot be put inside itself.');
      return false;
    }
    // A move into the folder it is already in does nothing; a copy there is a duplicate.
    const moving = copy ? paths : paths.filter((path) => tagParent(path) !== destination);
    if (moving.length === 0) return true;
    const ok = await mutate(
      copy ? 'Copy' : 'Move',
      // A copy never overwrites: `Rename` gives it a free name, the way paste
      // does in the Designer. A move refuses rather than replacing a tag.
      () => moveTags(moving, destination, copy, copy ? 'Rename' : 'Abort', csrfToken),
      `${copy ? 'Copied' : 'Moved'} ${plural(moving.length, 'tag')} to ${tagLabel(destination)}.`
    );
    if (ok && !copy) {
      onMoved(moving.map((from) => ({ from, to: joinTagPath(destination, tagLabel(from)) })));
    }
    if (ok) setOpen(destination, true);
    return ok;
  }, [csrfToken, mutate, onMoved, setOpen]);

  const paste = useCallback(async (destination: string) => {
    if (!clipboard) return;
    const ok = await transfer(clipboard.paths, destination, !clipboard.cut);
    // A cut is used up by its paste, as everywhere else; a copy can be pasted again.
    if (ok && clipboard.cut) onClipboard(null);
  }, [clipboard, onClipboard, transfer]);

  const remove = useCallback(async (paths: string[]) => {
    setBusy(true);
    try {
      const ok = await mutate('Delete', () => deleteTags(paths, csrfToken), `Deleted ${plural(paths.length, 'tag')}.`);
      if (ok) {
        onDeleted(paths);
        setSelected(new Set());
      }
    } finally {
      setBusy(false);
      setPrompt(null);
    }
  }, [csrfToken, mutate, onDeleted]);

  const doExport = useCallback(async (paths: string[], format: 'json' | 'xml') => {
    setBusy(true);
    try {
      const content = await exportTags(paths, format);
      const name = paths.length === 1 ? tagLabel(paths[0]) : 'tags';
      const type = format === 'xml' ? 'text/xml' : 'application/json';
      saveBlob(new Blob([content], { type }), `${name}.${format}`);
      noticeRef.current('info', `Exported ${plural(paths.length, 'tag')} as ${name}.${format}.`);
      setPrompt(null);
    } catch (e) {
      setPromptError(`Could not export: ${describe(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const writeValue = useCallback(async (path: string, raw: string, dataType: string | null) => {
    const value = parseTagInput(raw, dataType);
    if (value === undefined) return;
    setBusy(true);
    setPromptError(null);
    try {
      const result = await writeTag(path, value, csrfToken);
      if (!result.ok) {
        setPromptError(`Refused: ${result.results.map(qualityCode).join(', ')}`);
        return;
      }
      setPrompt(null);
      noticeRef.current('info', `Wrote ${raw} to ${tagLabel(path)}.`);
      await poll();
    } catch (e) {
      setPromptError(describe(e));
    } finally {
      setBusy(false);
    }
  }, [csrfToken, poll]);

  /** Every UDT definition under a provider's Data Types, as the `typeId` an instance names. */
  const udtTypes = useCallback(async (provider: string): Promise<string[]> => {
    const root = `${provider}${TYPES_FOLDER}`;
    const found: string[] = [];
    const queue = [root];
    // Bounded: a definitions tree is small, and an unbounded walk of a
    // pathological one would be the worst way for a menu item to hang.
    for (let reads = 0; queue.length > 0 && reads < 200; reads += 1) {
      const folder = queue.shift() as string;
      const result = await browseTags(folder);
      for (const node of result.children) {
        const path = joinTagPath(folder, node.name);
        if (node.objectType === 'UdtType') found.push(path.slice(root.length + 1));
        else if (node.objectType === 'Folder') queue.push(path);
      }
    }
    return found.sort((a, b) => a.localeCompare(b));
  }, []);

  // ---- gestures -----------------------------------------------------------

  const startRename = useCallback((path: string) => {
    if (!canEdit || tagParent(path) === null) return;
    setPromptError(null);
    setPrompt({ kind: 'rename', path });
  }, [canEdit]);

  const startDelete = useCallback((paths: string[]) => {
    const deletable = paths.filter((path) => tagParent(path) !== null);
    if (!canEdit || deletable.length === 0) return;
    setPrompt({ kind: 'delete', paths: deletable });
  }, [canEdit]);

  const containerFor = useCallback((row: Row): string => (
    isContainer(row.node) ? row.path : tagParent(row.path) ?? row.path
  ), []);

  const putAside = useCallback((paths: string[], cut: boolean) => {
    const movable = paths.filter((path) => tagParent(path) !== null);
    if (movable.length === 0) return;
    onClipboard({ paths: movable, cut });
    noticeRef.current('info', `${cut ? 'Cut' : 'Copied'} ${plural(movable.length, 'tag')}. Paste into a folder.`);
  }, [onClipboard]);

  const activate = useCallback((row: Row) => {
    if (isOpenable(row.node)) onOpen(row.path);
    else toggle(row);
  }, [onOpen, toggle]);

  const onRowClick = useCallback((event: MouseEvent, row: Row) => {
    if (event.shiftKey && anchor) {
      selectRange(anchor, row.path);
    } else if (event.ctrlKey || event.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(row.path)) next.delete(row.path); else next.add(row.path);
        return next;
      });
      setAnchor(row.path);
    } else {
      selectOnly(row.path);
      if (isOpenable(row.node)) onOpen(row.path);
    }
    setFocusPath(row.path);
  }, [anchor, onOpen, selectOnly, selectRange]);

  const openMenu = useCallback((x: number, y: number, row: Row) => {
    if (!selected.has(row.path)) selectOnly(row.path);
    setFocusPath(row.path);
    setMenu({ x, y, row });
  }, [selectOnly, selected]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    // The row the key landed on; the roving focus is the fallback for a key on the tree itself.
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-path]')?.dataset.path ?? focusPath;
    const index = Math.max(0, rows.findIndex((row) => row.path === target));
    const row = rows[index];
    const mod = event.ctrlKey || event.metaKey;
    const go = (target: Row | undefined) => {
      if (!target) return;
      if (event.shiftKey) selectRange(anchor ?? row.path, target.path);
      else selectOnly(target.path);
      focusRow(target.path);
    };
    let handled = true;
    if (event.key === 'ArrowDown') go(rows[index + 1]);
    else if (event.key === 'ArrowUp') go(rows[index - 1]);
    else if (event.key === 'Home') go(rows[0]);
    else if (event.key === 'End') go(rows[rows.length - 1]);
    else if (event.key === 'ArrowRight') {
      if (isExpandable(row.node) && !expanded.has(row.path)) setOpen(row.path, true);
      else if (rows[index + 1]?.depth > row.depth) go(rows[index + 1]);
    } else if (event.key === 'ArrowLeft') {
      if (expanded.has(row.path)) setOpen(row.path, false);
      else go(rowByPath.get(tagParent(row.path) ?? ''));
    } else if (event.key === 'Enter') activate(row);
    else if (event.key === 'F2') startRename(row.path);
    else if (event.key === 'Delete') startDelete(targetsFor(row));
    else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const box = (event.target as HTMLElement).getBoundingClientRect();
      openMenu(box.left + 24, box.bottom, row);
    } else if (mod && event.key.toLowerCase() === 'c') putAside(targetsFor(row), false);
    else if (mod && event.key.toLowerCase() === 'x' && canEdit) putAside(targetsFor(row), true);
    else if (mod && event.key.toLowerCase() === 'v' && canEdit) void paste(containerFor(row));
    else if (mod && event.key.toLowerCase() === 'd' && canEdit) void duplicate(targetsFor(row));
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, [activate, anchor, canEdit, containerFor, duplicate, expanded, focusPath, focusRow, openMenu,
    paste, putAside, rowByPath, rows, selectOnly, selectRange, setOpen, startDelete, startRename,
    targetsFor]);

  // ---- drag and drop ------------------------------------------------------

  const onDragStart = useCallback((event: DragEvent, row: Row) => {
    const paths = targetsFor(row).filter((path) => tagParent(path) !== null);
    dragRef.current = paths;
    try {
      event.dataTransfer.setData('text/plain', paths.join('\n'));
      event.dataTransfer.effectAllowed = 'copyMove';
    } catch {
      /* no DataTransfer (a synthetic event) — the ref above carries the drag */
    }
  }, [targetsFor]);

  const canDrop = (row: Row): boolean => {
    const paths = dragRef.current;
    return canEdit && paths !== null && paths.length > 0 && isContainer(row.node)
      && !paths.some((path) => within(row.path, path));
  };

  const onDragOver = (event: DragEvent, row: Row) => {
    if (!canDrop(row)) return;
    event.preventDefault();
    try {
      event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move';
    } catch {
      /* synthetic event */
    }
    if (dropTarget !== row.path) setDropTarget(row.path);
  };

  const onDrop = (event: DragEvent, row: Row) => {
    const paths = dragRef.current;
    const allowed = canDrop(row);
    dragRef.current = null;
    setDropTarget(null);
    if (!allowed || !paths) return;
    event.preventDefault();
    // Ctrl held at the drop copies, as in the Designer and every file manager.
    void transfer(paths, row.path, Boolean(event.ctrlKey || event.metaKey));
  };

  // ---- the menu -----------------------------------------------------------

  const menuItems = useCallback((row: Row): ContextMenuItem[] => {
    const targets = targetsFor(row);
    const folder = containerFor(row);
    const single = targets.length === 1;
    const anyRoot = targets.some((path) => tagParent(path) === null);
    const editable = (ok: boolean, why: string) => ({
      enabled: canEdit && ok,
      title: !canEdit ? editTitle : ok ? undefined : why,
    });
    const items: ContextMenuItem[] = NEW_ATOMIC.map((entry) => ({
      label: entry.label,
      ...editable(true, ''),
      onSelect: () => {
        setPromptError(null);
        setPrompt({ kind: 'new', folder, label: entry.label, config: { tagType: 'AtomicTag', ...entry.config } });
      },
    }));
    items.push(
      {
        label: 'New Folder',
        ...editable(true, ''),
        onSelect: () => {
          setPromptError(null);
          setPrompt({ kind: 'new', folder, label: 'New Folder', config: { tagType: 'Folder' } });
        },
      },
      {
        label: 'New UDT Instance…',
        ...editable(true, ''),
        onSelect: () => {
          setPromptError(null);
          void udtTypes(providerRoot(folder))
            .then((types) => setPrompt({ kind: 'new-udt-instance', folder, types }))
            .catch((e: unknown) => noticeRef.current('error', `Could not list UDT definitions: ${describe(e)}`));
        },
      },
      {
        label: 'New UDT Definition',
        ...editable(isUnderTypes(folder), 'UDT definitions live under Data Types'),
        onSelect: () => {
          setPromptError(null);
          setPrompt({ kind: 'new', folder, label: 'New UDT Definition', config: { tagType: 'UdtType' } });
        },
      },
      {
        label: 'Rename',
        ...editable(single && !anyRoot, anyRoot ? 'A provider cannot be renamed here' : 'Rename one tag at a time'),
        onSelect: () => startRename(targets[0]),
      },
      {
        label: 'Duplicate',
        ...editable(!anyRoot, 'A provider cannot be duplicated'),
        onSelect: () => void duplicate(targets),
      },
      {
        label: 'Copy',
        enabled: !anyRoot,
        title: anyRoot ? 'A provider cannot be copied' : undefined,
        onSelect: () => putAside(targets, false),
      },
      {
        label: 'Cut',
        ...editable(!anyRoot, 'A provider cannot be moved'),
        onSelect: () => putAside(targets, true),
      },
      {
        label: 'Paste',
        ...editable(clipboard !== null, 'Copy or cut a tag first'),
        onSelect: () => void paste(folder),
      },
      {
        label: 'Delete',
        ...editable(!anyRoot, 'A provider cannot be deleted here'),
        onSelect: () => startDelete(targets),
      },
      { label: 'Copy Path', onSelect: () => void copyText(targets.join('\n')) },
      { label: 'Export…', onSelect: () => { setPromptError(null); setPrompt({ kind: 'export', paths: targets }); } },
      {
        label: 'Import…',
        ...editable(true, ''),
        onSelect: () => {
          importFolderRef.current = folder;
          fileRef.current?.click();
        },
      },
      {
        label: 'Write Value…',
        ...editable(single && row.node.objectType === 'AtomicTag', 'Values are written to one tag at a time'),
        onSelect: () => {
          const current = values[row.path];
          setPromptError(null);
          setPrompt({
            kind: 'write',
            path: row.path,
            dataType: row.node.dataType,
            initial: current && current.value !== null ? String(current.value) : '',
          });
        },
      },
      { label: 'Refresh', onSelect: () => void refreshAll() },
    );
    return items;
  }, [canEdit, clipboard, containerFor, duplicate, editTitle, paste, putAside, refreshAll,
    startDelete, startRename, targetsFor, udtTypes, values]);

  // ---- render -------------------------------------------------------------

  if (!isAdmin) {
    return (
      <nav className="tag-tree" aria-label="Tags">
        <p className="tag-tree-note">The Tags view needs the Administrator role.</p>
      </nav>
    );
  }

  const tabStop = rowByPath.has(focusPath ?? '') ? focusPath : rows[0]?.path ?? null;
  const cutPaths = clipboard?.cut ? new Set(clipboard.paths) : null;

  return (
    <>
      <nav className="tag-tree" aria-label="Tags">
        <div className="tag-tree-toolbar">
          <button type="button" className="tag-tree-button" onClick={() => void refreshAll()}>
            Refresh
          </button>
          {clipboard && (
            <span className="tag-tree-hint" role="status">
              {plural(clipboard.paths.length, 'tag')} {clipboard.cut ? 'cut' : 'copied'}
            </span>
          )}
        </div>
        {rows.length === 0 && <p className="tag-tree-note">No tag providers.</p>}
        <div
          ref={treeRef}
          className="tag-tree-rows"
          role="tree"
          aria-label="Tag providers"
          aria-multiselectable="true"
          onKeyDown={onKeyDown}
        >
          {rows.map((row) => {
            const open = expanded.has(row.path);
            const expandable = isExpandable(row.node);
            const value = values[row.path];
            const classes = ['tag-tree-row'];
            if (selected.has(row.path)) classes.push('is-selected');
            if (row.path === activePath) classes.push('is-open');
            if (row.path === dropTarget) classes.push('is-drop-target');
            if (cutPaths?.has(row.path)) classes.push('is-cut');
            return (
              <Fragment key={row.path}>
                <div
                  role="treeitem"
                  data-path={row.path}
                  aria-level={row.depth + 1}
                  aria-expanded={expandable ? open : undefined}
                  aria-selected={selected.has(row.path)}
                  tabIndex={row.path === tabStop ? 0 : -1}
                  className={classes.join(' ')}
                  style={{ paddingLeft: `calc(var(--space-2) + ${row.depth} * var(--space-4))` }}
                  draggable={canEdit && row.depth > 0}
                  onClick={(event) => onRowClick(event, row)}
                  onDoubleClick={() => { if (!isOpenable(row.node)) toggle(row); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(event.clientX, event.clientY, row);
                  }}
                  onFocus={() => setFocusPath(row.path)}
                  onDragStart={(event) => onDragStart(event, row)}
                  onDragOver={(event) => onDragOver(event, row)}
                  onDragLeave={() => setDropTarget((t) => (t === row.path ? null : t))}
                  onDrop={(event) => onDrop(event, row)}
                  onDragEnd={() => { dragRef.current = null; setDropTarget(null); }}
                >
                  <span
                    className="tag-tree-chevron"
                    aria-hidden="true"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggle(row);
                    }}
                  >
                    {expandable && (open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />)}
                  </span>
                  {iconFor(row.node)}
                  <span className="tag-tree-name">{row.label}</span>
                  {value && (
                    <span className={`tag-tree-value${value.good ? '' : ' is-bad'}`}>
                      {value.value === null ? 'null' : String(value.value)}
                      <span className="tag-tree-quality">{qualityCode(value.quality)}</span>
                    </span>
                  )}
                </div>
                {open && truncated.has(row.path) && (
                  <div
                    role="treeitem"
                    aria-level={row.depth + 2}
                    aria-disabled="true"
                    aria-selected={false}
                    className="tag-tree-note"
                    style={{ paddingLeft: `calc(var(--space-2) + ${row.depth + 1} * var(--space-4))` }}
                  >
                    First 2000 shown
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </nav>

      {/* Off-screen rather than display:none, so `.click()` opens the chooser in every browser. */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,.xml,application/json,text/xml"
        aria-label="Choose a tag export to import"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          const folder = importFolderRef.current;
          if (!file || !folder) return;
          void file.text().then((content) => {
            setPromptError(null);
            setPrompt({
              kind: 'import',
              folder,
              content,
              format: /\.xml$/i.test(file.name) ? 'xml' : 'json',
              fileName: file.name,
            });
          });
        }}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          heading={targetsFor(menu.row).length > 1 ? plural(targetsFor(menu.row).length, 'tag') : menu.row.label}
          items={menuItems(menu.row)}
          dense
          onClose={() => setMenu(null)}
        />
      )}

      {prompt?.kind === 'new' && (
        <TagNameDialog
          title={`${prompt.label} in ${tagLabel(prompt.folder)}`}
          field={{ label: 'Name', validate: validateTagName }}
          submitLabel={busy ? 'Creating…' : 'Create'}
          busy={busy}
          error={promptError}
          onSubmit={(name) => void create(prompt.folder, prompt.config, name)}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === 'new-udt-instance' && (
        <TagNameDialog
          title={`New UDT Instance in ${tagLabel(prompt.folder)}`}
          field={{ label: 'Name', validate: validateTagName }}
          choice={{ label: 'UDT definition', options: prompt.types }}
          submitLabel={busy ? 'Creating…' : 'Create'}
          busy={busy}
          error={promptError ?? (prompt.types.length === 0 ? 'This provider has no UDT definitions yet.' : null)}
          onSubmit={(name, typeId) => void create(prompt.folder, { tagType: 'UdtInstance', typeId }, name)}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === 'rename' && (
        <TagNameDialog
          title={`Rename ${tagLabel(prompt.path)}`}
          field={{
            label: 'New name',
            initial: tagLabel(prompt.path),
            validate: (name) => validateTagName(name)
              ?? (name === tagLabel(prompt.path) ? 'That is its name now' : null),
          }}
          submitLabel={busy ? 'Renaming…' : 'Rename'}
          busy={busy}
          error={promptError}
          onSubmit={(name) => void rename(prompt.path, name)}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === 'write' && (
        <TagNameDialog
          title={`Write to ${tagLabel(prompt.path)}`}
          field={{
            label: `Value (${prompt.dataType ?? 'unknown type'})`,
            initial: prompt.initial,
            validate: (raw) => (parseTagInput(raw, prompt.dataType) === undefined
              ? `Not a valid ${prompt.dataType} value` : null),
          }}
          submitLabel={busy ? 'Writing…' : 'Write'}
          busy={busy}
          error={promptError}
          onSubmit={(raw) => void writeValue(prompt.path, raw, prompt.dataType)}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === 'export' && (
        <TagNameDialog
          title={`Export ${prompt.paths.length === 1 ? tagLabel(prompt.paths[0]) : plural(prompt.paths.length, 'tag')}`}
          choice={{ label: 'Format', options: ['JSON', 'XML'], initial: 'JSON' }}
          submitLabel={busy ? 'Exporting…' : 'Export'}
          busy={busy}
          error={promptError}
          onSubmit={(_value, format) => void doExport(prompt.paths, format === 'XML' ? 'xml' : 'json')}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === 'import' && (
        <TagNameDialog
          title={`Import ${prompt.fileName} into ${tagLabel(prompt.folder)}`}
          choice={{ label: 'If a tag already exists', options: COLLISIONS, initial: 'Abort' }}
          submitLabel={busy ? 'Importing…' : 'Import'}
          busy={busy}
          error={promptError}
          onSubmit={(_value, collision) => {
            setBusy(true);
            void mutate(
              'Import',
              () => importTags(prompt.folder, prompt.content, prompt.format, collision as TagCollision, csrfToken),
              `Imported ${prompt.fileName}.`
            ).then((ok) => {
              setBusy(false);
              if (ok) {
                setPrompt(null);
                setOpen(prompt.folder, true);
              }
            });
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
      {prompt?.kind === 'delete' && (
        <div className="tag-dialog-backdrop" role="presentation">
          <div
            ref={deleteRef}
            className="tag-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="tag-delete-title"
            onKeyDown={makeDialogKeyDown(deleteRef, () => { if (!busy) setPrompt(null); })}
          >
            <h2 id="tag-delete-title">
              Delete {prompt.paths.length === 1 ? tagLabel(prompt.paths[0]) : plural(prompt.paths.length, 'tag')}?
            </h2>
            <p className="tag-dialog-hint">
              {prompt.paths.length === 1 ? prompt.paths[0] : prompt.paths.join(', ')} — and anything
              inside — is removed from the gateway. Open editors on them close. It cannot be undone
              from here.
            </p>
            <div className="tag-dialog-actions">
              <button type="button" onClick={() => setPrompt(null)} disabled={busy} autoFocus>Cancel</button>
              <button type="button" className="danger" onClick={() => void remove(prompt.paths)} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
