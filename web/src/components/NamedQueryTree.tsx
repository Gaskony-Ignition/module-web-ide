/**
 * The Named Queries view: every named query in the open project, as folders.
 *
 * The third activity-bar view, and the reason the bar exists — three unrelated
 * resource trees stacked in one scrolling column stops being navigable
 * (ActivityBar's own class comment has said so since 1.3.0).
 *
 * Folders are IMPLIED BY PATHS, exactly as the Designer's tree implies them:
 * `Orders/Daily/Totals` is one resource whose name puts it two folders deep.
 * An empty folder still arrives as a resource in its own right (`isFolder`), the
 * same way an empty Project Library package does, and it must never be opened —
 * there is no `query.sql` under it.
 *
 * The tree ships COLLAPSED, tracking an EXPANDED set, for the same two reasons
 * FileTree does: a project's whole query list on landing is a column to be
 * scrolled before anything can be chosen, and a collapsed set would have to
 * enumerate keys that do not exist until the project loads — a missed key opens
 * itself. The create action sits on the group header so it is reachable while
 * the group is shut.
 */
import { useMemo } from 'react';
import { useStickySet } from '../workspace/viewState';
import type { NamedQueryEntry } from '../api/namedQueries';
import { QUERY_TYPE_LABELS } from '../api/namedQueries';
import { IconDatabase, IconFolder, IconPlus, IconRevert, IconTrash } from './Icons';
import { Chevron } from './Chevron';
import './FileTree.css';

export interface NamedQueryTreeProps {
  queries: NamedQueryEntry[];
  /** Path of the query currently being edited, if any. */
  selectedPath: string | null;
  onSelect: (entry: NamedQueryEntry) => void;
  /** Offered only when the session may write — omit to hide create/rename/delete. */
  onCreate?: () => void;
  onRename?: (entry: NamedQueryEntry) => void;
  /**
   * Move a whole folder, and everything under it.
   *
   * Possible since the contract ruled that a folder rename carries no
   * `If-Match`: a folder is implied by the paths beneath it and mostly is not a
   * resource, so there is no signature to assert. Where the listing DOES carry a
   * folder resource, its entry comes with the call so the ordinary staleness
   * check still applies.
   */
  onRenameFolder?: (folder: string, entry?: NamedQueryEntry) => void;
  onDelete?: (entry: NamedQueryEntry) => void;
}

export interface QueryFolderNode {
  /** Segment name, e.g. `Orders`. Empty for the root. */
  name: string;
  /** Full folder path, used as the expand key. */
  key: string;
  children: QueryFolderNode[];
  queries: Array<NamedQueryEntry & { leaf: string }>;
}

function emptyFolder(name: string, key: string): QueryFolderNode {
  return { name, key, children: [], queries: [] };
}

/**
 * Build the folder tree from the entries' paths.
 *
 * Mirrors `FileTree.buildPackageTree` rather than sharing it. The two look the
 * same and differ in what they are keyed on: a script's package path comes from
 * `entry.name` and falls back to a type label for a singleton, while a query's
 * comes from `folder` + `name` and has no singleton case at all. Generalising
 * them would mean a function taking two accessors and a fallback, which is more
 * to read than either copy.
 */
export function buildQueryTree(entries: NamedQueryEntry[]): QueryFolderNode {
  const root = emptyFolder('', '');
  for (const entry of entries) {
    // `folder` is the server's answer; the path is the fallback, because a
    // listing that omits it must still nest rather than flatten every query
    // into the root.
    const folder = entry.folder || folderOf(entry);
    const segments = folder.split('/').filter((s) => s.length > 0);
    let node = root;
    for (const segment of segments) {
      const key = node.key ? `${node.key}/${segment}` : segment;
      let child = node.children.find((c) => c.name === segment);
      if (!child) {
        child = emptyFolder(segment, key);
        node.children.push(child);
      }
      node = child;
    }
    if (entry.isFolder) {
      // An empty folder: the gateway reports it as a resource so it is not
      // dropped, but there is nothing here to open. Ensure the node exists at
      // its own full path and stop — falling through would push it as a leaf,
      // and clicking that 404s on a `query.sql` it does not have.
      const key = node.key ? `${node.key}/${entry.name}` : entry.name;
      if (entry.name && !node.children.some((c) => c.name === entry.name)) {
        node.children.push(emptyFolder(entry.name, key));
      }
      continue;
    }
    node.queries.push({ ...entry, leaf: entry.name || leafOf(entry.path) });
  }
  sortFolder(root);
  return root;
}

/**
 * The folder part of a path, for a listing that sent no `folder`.
 *
 * The path is already project-relative — `Orders/Daily/Totals` — so this is a
 * plain split on the last separator.
 */
function folderOf(entry: NamedQueryEntry): string {
  const cut = entry.path.lastIndexOf('/');
  return cut < 0 ? '' : entry.path.slice(0, cut);
}

function leafOf(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/** Folders before queries at every level, each alphabetical — the Designer's rule. */
function sortFolder(node: QueryFolderNode) {
  node.children.sort(byName);
  node.queries.sort(byName);
  node.children.forEach(sortFolder);
}

export default function NamedQueryTree({
  queries,
  selectedPath,
  onSelect,
  onCreate,
  onRename,
  onRenameFolder,
  onDelete,
}: NamedQueryTreeProps) {
  // A folder that IS a resource in its own right, by its path — so a rename can
  // send its signature where one exists and nothing where the folder is merely
  // implied by the paths under it.
  const folderResources = useMemo(() => {
    const out = new Map<string, NamedQueryEntry>();
    for (const entry of queries) {
      if (entry.isFolder) {
        out.set(entry.folder ? `${entry.folder}/${entry.name}` : entry.name, entry);
      }
    }
    return out;
  }, [queries]);
  // Sticky across an unmount — see useStickySet.
  const [expanded, setExpanded] = useStickySet('queries.expanded');

  const tree = useMemo(() => buildQueryTree(queries), [queries]);
  const count = useMemo(() => queries.filter((entry) => !entry.isFolder).length, [queries]);

  function toggle(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const groupCollapsed = !expanded.has('group:named-queries');

  return (
    <nav className="file-tree" aria-label="Named Queries">
      <section className="file-tree-group">
        <div className="file-tree-header-row">
          <button
            type="button"
            className="file-tree-header"
            aria-expanded={!groupCollapsed}
            onClick={() => toggle('group:named-queries')}
          >
            <Chevron open={!groupCollapsed} />
            <span>Queries</span>
            <span className="file-tree-count">{count}</span>
          </button>
          {onCreate && (
            <button
              type="button"
              className="file-tree-action"
              title="New named query"
              aria-label="New named query"
              onClick={onCreate}
            >
              <IconPlus size={13} />
            </button>
          )}
        </div>
        {!groupCollapsed &&
          (count === 0 && tree.children.length === 0 ? (
            <p className="file-tree-empty muted">No named queries in this project.</p>
          ) : (
            <FolderBranch
              node={tree}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onRename={onRename}
              onRenameFolder={onRenameFolder}
              folderResources={folderResources}
              onDelete={onDelete}
            />
          ))}
      </section>
    </nav>
  );
}

interface BranchProps {
  node: QueryFolderNode;
  depth: number;
  /** Keys of the branches that are OPEN; everything else is shut. */
  expanded: Set<string>;
  onToggle: (key: string) => void;
  selectedPath: string | null;
  onSelect: (entry: NamedQueryEntry) => void;
  onRename?: (entry: NamedQueryEntry) => void;
  onRenameFolder?: (folder: string, entry?: NamedQueryEntry) => void;
  folderResources: Map<string, NamedQueryEntry>;
  onDelete?: (entry: NamedQueryEntry) => void;
}

function FolderBranch({
  node, depth, expanded, onToggle, selectedPath, onSelect, onRename, onRenameFolder,
  folderResources, onDelete,
}: BranchProps) {
  return (
    <ul className="file-tree-list">
      {node.children.map((child) => {
        const key = `nq:${child.key}`;
        const isCollapsed = !expanded.has(key);
        return (
          <li key={child.key}>
            <div className="file-tree-header-row">
              <button
                type="button"
                className="file-tree-package"
                style={{ paddingLeft: indent(depth + 1) }}
                aria-expanded={!isCollapsed}
                onClick={() => onToggle(key)}
              >
                <Chevron open={!isCollapsed} />
                <IconFolder size={14} className="file-tree-icon" />
                <span>{child.name}</span>
              </button>
              {onRenameFolder && (
                <button
                  type="button"
                  className="file-tree-action"
                  title={`Rename or move the ${child.name} folder and everything in it`}
                  aria-label={`Rename folder ${child.name}`}
                  onClick={() => onRenameFolder(child.key, folderResources.get(child.key))}
                >
                  ✎
                </button>
              )}
            </div>
            {!isCollapsed && (
              <FolderBranch
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onRename={onRename}
                onRenameFolder={onRenameFolder}
                folderResources={folderResources}
                onDelete={onDelete}
              />
            )}
          </li>
        );
      })}
      {node.queries.map((entry) => (
        <QueryRow
          key={entry.path}
          entry={entry}
          label={entry.leaf}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
        />
      ))}
    </ul>
  );
}

interface RowProps {
  entry: NamedQueryEntry;
  label: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (entry: NamedQueryEntry) => void;
  onRename?: (entry: NamedQueryEntry) => void;
  onDelete?: (entry: NamedQueryEntry) => void;
}

function QueryRow({
  entry, label, depth, selectedPath, onSelect, onRename, onDelete,
}: RowProps) {
  const selected = entry.path === selectedPath;
  // Only a query this project OWNS can be renamed or deleted. An inherited one
  // has nothing here to move or remove and the server 404s it, so the buttons
  // are absent rather than present and failing.
  const mutable = entry.origin !== 'inherited';
  // Same distinction the script tree draws: DELETE on an overridden resource
  // removes only this project's copy and the query keeps working, inherited
  // from the parent again. The Designer calls that Discard Overrides, and
  // wording a reversible action as a permanent one is how people learn to click
  // past confirmations.
  const discards = entry.origin === 'override';
  return (
    <li className="file-tree-row">
      <button
        type="button"
        className={`file-tree-item${selected ? ' is-selected' : ''}`}
        style={{ paddingLeft: indent(depth) }}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(entry)}
        title={entry.type ? QUERY_TYPE_LABELS[entry.type] : undefined}
      >
        <IconDatabase size={14} className="file-tree-icon" />
        <span className="file-tree-name">{label}</span>
        {entry.enabled === false && (
          <span className="badge badge-disabled" title="Disabled — this query will not run">
            off
          </span>
        )}
        {/* Not decoration and not a warning about style: a version-1 resource is
            DEAD. The platform's own reader returns a blank query for one and
            runNamedQuery raises a NullPointerException, so this row looks like
            every other and does nothing. Saving it converts it. */}
        {entry.legacy && (
          <span
            className="badge badge-legacy"
            title={'Stored in the legacy version-1 format, which the gateway cannot run — '
              + 'system.db.runNamedQuery fails on it. Open it and save to convert it.'}
          >
            legacy
          </span>
        )}
        {/* Inheritance is not decoration: editing an inherited query CREATES a
            local override rather than changing the parent, and the user has to
            know that before they type. */}
        {entry.origin !== 'local' && (
          <span className={`badge badge-${entry.origin}`} title={originTitle(entry)}>
            {entry.origin}
          </span>
        )}
      </button>
      {mutable && onRename && (
        <button
          type="button"
          className="file-tree-action"
          title={`Rename or move ${label}`}
          aria-label={`Rename ${label}`}
          onClick={() => onRename(entry)}
        >
          ✎
        </button>
      )}
      {mutable && onDelete && (
        <button
          type="button"
          className={`file-tree-action ${discards ? 'file-tree-discard' : 'file-tree-delete'}`}
          title={
            discards
              ? `Discard the local override of ${label} and return to the copy inherited from ${entry.owner}`
              : `Delete ${label}`
          }
          aria-label={discards ? `Discard overrides on ${label}` : `Delete ${label}`}
          onClick={() => onDelete(entry)}
        >
          {discards ? <IconRevert size={13} /> : <IconTrash size={13} />}
        </button>
      )}
    </li>
  );
}

function originTitle(entry: NamedQueryEntry): string {
  return entry.origin === 'inherited'
    ? `Inherited from ${entry.owner}. Read-only until you override it.`
    : `Overrides the copy inherited from ${entry.owner}. Discarding the override returns to it.`;
}

/** Indentation per tree level, in the token scale — the script tree's own. */
function indent(depth: number): string {
  return `calc(var(--space-2) + ${depth} * var(--space-4))`;
}
