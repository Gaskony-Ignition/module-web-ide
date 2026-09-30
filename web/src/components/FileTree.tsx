/**
 * The left rail: every editable script in the open project.
 *
 * The "Scripting" heading belongs to the RAIL, not to this component — the rail
 * shows the active view's name and this tree is one of several views it hosts.
 *
 * The shape is the real Designer's, and it is measured rather than guessed —
 * `web-designer/docs/design-handoff/real-designer/SCRIPTING.md` §1, captured
 * from an 8.3 Designer on 21/08/2026:
 *
 *   Scripting
 *   ├── Gateway Events
 *   │   ├── Message      (folder, shown even when empty)
 *   │   ├── Scheduled    (folder)
 *   │   ├── Tag Change   (folder)
 *   │   ├── Timer        (folder)
 *   │   ├── Shutdown     ← a SCRIPT, not a folder
 *   │   ├── Startup      ← a SCRIPT
 *   │   └── Update       ← a SCRIPT
 *   └── Project Library
 *       └── util/helpers
 *
 * **The four folders come first, then the three singletons.** Not alphabetical
 * across the group — folders-then-leaves, each alphabetical, which is the rule
 * the whole Designer tree follows. Until 1.3.0 this listed the singletons first
 * AND rendered them as collapsible folders containing one nameless row, which is
 * two things the Designer does not do (Nigel, 01/09/2026).
 *
 * Two row decorations are measured too: a singleton's label is **bold** once it
 * has been created, and a disabled event script carries a badge.
 *
 * Script Console is deliberately NOT here any more. It was a row in this tree in
 * 1.1.0–1.2.0, where it read as a script among scripts; it has its own icon on
 * the activity bar and its own tab in the bottom panel now.
 *
 * Project Library entries carry slash-separated package names and are shown as a
 * nested, collapsible tree; each gateway event type is a flat list, because each
 * is genuinely flat on the gateway.
 */
import { useMemo } from 'react';
import { useStickySet } from '../workspace/viewState';
import type { ScriptEntry, ScriptTypeId } from '../api/scripts';
import { IconFolder, IconPlus, IconRevert, IconTrash, iconForType } from './Icons';
import { Chevron } from './Chevron';
import './FileTree.css';
import { markLetter, markTitle, type GitMark } from '../api/git';

export interface FileTreeProps {
  scripts: ScriptEntry[];
  /** Path of the entry currently being edited, if any. */
  selectedPath: string | null;
  onSelect: (entry: ScriptEntry) => void;
  /** Offered only when the session may write — omit to hide create/delete. */
  onCreate?: (typeId: ScriptTypeId) => void;
  onDelete?: (entry: ScriptEntry) => void;
  /**
   * Right-click on a row. Absent leaves the browser's own menu alone.
   *
   * The tree hands up WHERE the pointer was and WHAT was under it, and the
   * workspace owns the menu itself — one menu, one piece of state, and Escape
   * and click-away work without every row subscribing to a document listener.
   * `paths` is what the row covers: one script, or every script under a package.
   */
  onContext?: (event: { x: number; y: number; label: string; paths: string[] }) => void;
  /**
   * Create a singleton that does not exist yet.
   *
   * Separate from {@link onCreate}, which opens a name dialog — a singleton has
   * no name to ask for. The Designer shows Startup, Shutdown and Update whether
   * or not they exist and writes the resource when you first save; here the row
   * creates it and opens it, which reaches the same place in one click.
   */
  onCreateSingleton?: (typeId: ScriptTypeId) => void;
  /**
   * Git marks, already rolled up onto the paths this tree renders.
   *
   * Rolled up by the caller rather than here because the roll-up needs to know
   * about resources that NO LONGER EXIST — a deleted script has no row, and its
   * mark belongs to the package above it. This component only knows what is
   * still there.
   *
   * Absent when the project is not a git working tree, which is most of them.
   */
  gitMarks?: Map<string, GitMark>;
}

/**
 * The four gateway event types the Designer shows as FOLDERS, in its order.
 *
 * Alphabetical by label, and shown even when the project has none of that type —
 * an empty folder is the only place to click "new" for its type, so filtering
 * them out makes the first script of a kind impossible to create.
 */
const GATEWAY_EVENT_FOLDERS: ScriptTypeId[] = [
  'message',
  'scheduled',
  'tag-change',
  'timer',
];

/**
 * The three the Designer shows as single SCRIPTS, in its order.
 *
 * The platform stores each as one resource with no name segment. They are not
 * folders and have no "new" affordance: there can only ever be one.
 */
const GATEWAY_EVENT_SINGLETONS: ScriptTypeId[] = ['shutdown', 'startup', 'update'];

const LIBRARY_TYPE: ScriptTypeId = 'script-python';

const GATEWAY_EVENT_TYPES: ScriptTypeId[] = [
  ...GATEWAY_EVENT_FOLDERS,
  ...GATEWAY_EVENT_SINGLETONS,
];

/**
 * Types this tree deliberately does NOT show, because another view owns them.
 *
 * Web Dev endpoints have their own activity-bar view — a whole tree of their
 * own, with the per-endpoint verbs and the config dialog the script tree cannot
 * offer. Listing them here as well gave every endpoint two homes and made the
 * one with fewer affordances the first one people found (Nigel, 02/09/2026).
 *
 * Distinct from {@link unknownGroups}, which is the catch-all for a type this
 * build has never heard of: that one still renders, because silently dropping a
 * resource the gateway sent is how a script becomes uneditable with no message.
 * This set is the "handled elsewhere" case, and it is the only reason a type may
 * be omitted.
 */
const SHOWN_IN_ANOTHER_VIEW = new Set<string>(['resources']);

/**
 * Labels for a type with no scripts in the open project.
 *
 * Needed because the label normally comes from an ENTRY, and an empty folder
 * has none — which is exactly the folder someone is about to create the first
 * script in.
 */
const TYPE_LABELS: Record<string, string> = {
  timer: 'Timer',
  message: 'Message Handler',
  scheduled: 'Scheduled',
  'tag-change': 'Tag Change',
  startup: 'Startup',
  shutdown: 'Shutdown',
  update: 'Update',
};

interface PackageNode {
  /** Segment name, e.g. `util`. Empty for the root. */
  name: string;
  /** Full package path, used as the collapse key. */
  key: string;
  children: PackageNode[];
  scripts: ScriptEntry[];
}

function emptyNode(name: string, key: string): PackageNode {
  return { name, key, children: [], scripts: [] };
}

/** Build the package tree for the Project Library group. */
export function buildPackageTree(entries: ScriptEntry[]): PackageNode {
  const root = emptyNode('', '');
  for (const entry of entries) {
    const segments = entry.name.split('/').filter((s) => s.length > 0);
    if (entry.isFolder) {
      // An empty package: the gateway reports it as a resource so it isn't
      // dropped, but there is no script here to add — ensure the FOLDER node
      // exists at its full path and stop. Falling through to the ordinary
      // branch below would push it as a leaf `ScriptRow`, and clicking that
      // 404s with "No such data key" — see ScriptResourceRouteHandler#write.
      let node = root;
      for (const segment of segments) {
        const key = node.key ? `${node.key}/${segment}` : segment;
        let child = node.children.find((c) => c.name === segment);
        if (!child) {
          child = emptyNode(segment, key);
          node.children.push(child);
        }
        node = child;
      }
      continue;
    }
    const leaf = segments.pop();
    let node = root;
    for (const segment of segments) {
      const key = node.key ? `${node.key}/${segment}` : segment;
      let child = node.children.find((c) => c.name === segment);
      if (!child) {
        child = emptyNode(segment, key);
        node.children.push(child);
      }
      node = child;
    }
    // A singleton or a name-less entry still needs a row; fall back to its label.
    node.scripts.push({ ...entry, name: leaf ?? entry.typeLabel });
  }
  sortNode(root);
  return root;
}

/**
 * The resource-path prefix a package key sits under, read off the entries.
 *
 * A library entry's `path` ends with its `name`, so what remains is the prefix —
 * `ignition/script-python/`. Derived rather than written down because the tree
 * renders whatever the gateway sends, and a literal would go on matching nothing
 * in silence if a type id ever changed.
 */
export function libraryPathPrefix(entries: { path: string; name: string }[]): string {
  const entry = entries.find((e) => e.name && e.path.endsWith(e.name));
  return entry ? entry.path.slice(0, entry.path.length - entry.name.length) : '';
}

/** Case-insensitive name compare — "Zebra" and "apple" sort as `apple, Zebra`. */
function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Folders (`children`) before files (`scripts`) at every level, each
 * alphabetical — the Designer's own rule (see the file comment) — and
 * case-insensitive throughout. PackageBranch already renders children ahead
 * of scripts; this only has to sort within each group.
 */
function sortNode(node: PackageNode) {
  node.children.sort(byName);
  node.scripts.sort(byName);
  node.children.forEach(sortNode);
}

export default function FileTree({
  scripts,
  selectedPath,
  onSelect,
  onCreate,
  onDelete,
  onContext,
  onCreateSingleton,
  gitMarks,
}: FileTreeProps) {
  /**
   * Which branches are OPEN. Everything starts shut (Nigel, 02/09/2026).
   *
   * Tracked as "expanded" rather than "collapsed" so that default falls out of
   * the empty set: the alternative — a collapsed set seeded with every key —
   * has to enumerate keys that do not exist until the project is loaded, and a
   * branch whose key was missed silently opens itself.
   *
   * The tree is a whole project's scripts, and every group open on landing was
   * a column of forty rows that has to be scrolled before anything can be
   * chosen. Quick open (Ctrl+P) is the fast path now, and the tree is for
   * browsing, which starts by choosing a branch.
   */
  // Sticky: switching activity-bar views unmounts this tree, and plain
  // useState went with it — every folder collapsed again on the way back.
  const [expanded, setExpanded] = useStickySet('scripts.expanded');

  const { library, eventGroups, singletons, unknownGroups } = useMemo(() => {
    const byType = new Map<string, ScriptEntry[]>();
    for (const entry of scripts) {
      const list = byType.get(entry.typeId);
      if (list) list.push(entry);
      else byType.set(entry.typeId, [entry]);
    }
    const known = new Set<string>([LIBRARY_TYPE, ...GATEWAY_EVENT_TYPES]);
    return {
      library: byType.get(LIBRARY_TYPE) ?? [],
      // EVERY event type, not only the ones with scripts in them. The Designer
      // shows all four folders even when empty, and an empty folder is the only
      // place to click "new" for that type — filtering them out made it
      // impossible to create the first script of a kind.
      eventGroups: GATEWAY_EVENT_FOLDERS.map((typeId) => {
        const entries = byType.get(typeId) ?? [];
        return { typeId, label: entries[0]?.typeLabel ?? TYPE_LABELS[typeId] ?? typeId, entries };
      }),
      // The three singletons are ROWS, not folders. Each is listed whether or
      // not it exists: `entry` is undefined until the project has one, and the
      // row is what creates it.
      singletons: GATEWAY_EVENT_SINGLETONS.map((typeId) => {
        const entry = (byType.get(typeId) ?? [])[0];
        return { typeId, label: entry?.typeLabel ?? TYPE_LABELS[typeId] ?? typeId, entry };
      }),
      // Anything the gateway sent that this build does not know about — better
      // shown under its own heading than silently dropped.
      unknownGroups: [...byType.keys()]
        .filter((t) => !known.has(t) && !SHOWN_IN_ANOTHER_VIEW.has(t))
        .map((typeId) => {
          const entries = byType.get(typeId) ?? [];
          return { typeId, label: entries[0]?.typeLabel ?? typeId, entries };
        }),
    };
  }, [scripts]);

  function toggle(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const eventsCollapsed = !expanded.has('group:gateway-events');
  const libraryCollapsed = !expanded.has('group:library');

  return (
    <nav className="file-tree" aria-label="Scripting">
      {/* ---- Gateway Events ---- */}
      <section className="file-tree-group">
        <button
          type="button"
          className="file-tree-header"
          aria-expanded={!eventsCollapsed}
          onClick={() => toggle('group:gateway-events')}
        >
          <Chevron open={!eventsCollapsed} />
          <span>Gateway Events</span>
          <span className="file-tree-count">
            {eventGroups.reduce((total, g) => total + g.entries.length, 0)
              + singletons.filter((s) => s.entry).length}
          </span>
        </button>
        {!eventsCollapsed && (
          <>
            {eventGroups.map((group) => {
              const key = `type:${group.typeId}`;
              const isCollapsed = !expanded.has(key);
              return (
                <div key={group.typeId}>
                  <div className="file-tree-header-row">
                    <button
                      type="button"
                      className="file-tree-package"
                      style={{ paddingLeft: indent(1) }}
                      aria-expanded={!isCollapsed}
                      onClick={() => toggle(key)}
                    >
                      <Chevron open={!isCollapsed} />
                      {iconForType(group.typeId, { className: 'file-tree-icon' })}
                      <span>{group.label}</span>
                      <span className="file-tree-count">{group.entries.length}</span>
                    </button>
                    {onCreate && (
                      <button
                        type="button"
                        className="file-tree-action"
                        title={`New ${group.label} script`}
                        aria-label={`New ${group.label} script`}
                        onClick={() => onCreate(group.typeId)}
                      >
                        <IconPlus size={13} />
                      </button>
                    )}
                  </div>
                  {!isCollapsed && group.entries.length === 0 && (
                    <p className="file-tree-empty muted" style={{ paddingLeft: indent(2) }}>
                      None yet.
                    </p>
                  )}
                  {!isCollapsed && (
                    <ul className="file-tree-list">
                      {[...group.entries]
                        .sort(byName)
                        .map((entry) => (
                          <ScriptRow
                            key={entry.path}
                            entry={entry}
                            depth={2}
                            selectedPath={selectedPath}
                            onSelect={onSelect}
                            onDelete={onDelete}
                            onContext={onContext}
                            gitMark={gitMarks?.get(entry.path)}
                          />
                        ))}
                    </ul>
                  )}
                </div>
              );
            })}

            {/* The three singletons: rows, at the same depth as a folder, after
                all four folders. Folders-then-leaves is the Designer's rule. */}
            <ul className="file-tree-list">
              {singletons.map((single) => (
                <SingletonRow
                  key={single.typeId}
                  typeId={single.typeId}
                  label={single.label}
                  entry={single.entry}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onCreate={onCreateSingleton}
                />
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ---- Project Library ---- */}
      <section className="file-tree-group">
        <div className="file-tree-header-row">
          <button
            type="button"
            className="file-tree-header"
            aria-expanded={!libraryCollapsed}
            onClick={() => toggle('group:library')}
          >
            <Chevron open={!libraryCollapsed} />
            <span>Project Library</span>
            <span className="file-tree-count">{library.length}</span>
            {/* A script deleted from the TOP level of the library has no
                surviving node — its parent is this group. Without a mark here
                the one change most worth noticing would be the one change the
                tree could not show. */}
            {(() => {
              const root = libraryPathPrefix(library).replace(/\/$/, '');
              const mark = root ? gitMarks?.get(root) : undefined;
              return mark ? <GitBadge mark={mark} /> : null;
            })()}
          </button>
          {onCreate && (
            <button
              type="button"
              className="file-tree-action"
              title="New library script"
              aria-label="New library script"
              onClick={() => onCreate('script-python')}
            >
              <IconPlus size={13} />
            </button>
          )}
        </div>
        {!libraryCollapsed &&
          (library.length === 0 ? (
            <p className="file-tree-empty muted">No library scripts yet.</p>
          ) : (
            <PackageBranch
              node={buildPackageTree(library)}
              depth={0}
              expanded={expanded}
              onToggle={toggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onDelete={onDelete}
              onContext={onContext}
              gitMarks={gitMarks}
              pathPrefix={libraryPathPrefix(library)}
            />
          ))}
      </section>

      {/* ---- anything unrecognised ---- */}
      {unknownGroups.map((group) => {
        const key = `type:${group.typeId}`;
        const isCollapsed = !expanded.has(key);
        return (
          <section className="file-tree-group" key={group.typeId}>
            <button
              type="button"
              className="file-tree-header"
              aria-expanded={!isCollapsed}
              onClick={() => toggle(key)}
            >
              <Chevron open={!isCollapsed} />
              <span>{group.label}</span>
              <span className="file-tree-count">{group.entries.length}</span>
            </button>
            {!isCollapsed && (
              <ul className="file-tree-list">
                {group.entries.map((entry) => (
                  <ScriptRow
                    key={entry.path}
                    entry={entry}
                    depth={1}
                    selectedPath={selectedPath}
                    onSelect={onSelect}
                    onDelete={onDelete}
                    onContext={onContext}
                    gitMark={gitMarks?.get(entry.path)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}

    </nav>
  );
}

/** Every script under a package node, at any depth. What a folder's menu acts on. */
function pathsUnder(node: PackageNode): string[] {
  return [
    ...node.scripts.map((s) => s.path),
    ...node.children.flatMap(pathsUnder),
  ];
}

interface BranchProps {
  node: PackageNode;
  depth: number;
  /** Keys of the branches that are OPEN; everything else is shut. */
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onContext?: FileTreeProps['onContext'];
  selectedPath: string | null;
  onSelect: (entry: ScriptEntry) => void;
  onDelete?: (entry: ScriptEntry) => void;
  gitMarks?: Map<string, GitMark>;
  /**
   * What to prefix a package key with to get its resource path.
   *
   * Measured from the entries rather than hardcoded to
   * `ignition/script-python/`: the tree renders whatever the gateway sends, and
   * a literal here would silently stop matching if a type ever moved.
   */
  pathPrefix?: string;
}

function PackageBranch({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
  onDelete,
  onContext,
  gitMarks,
  pathPrefix,
}: BranchProps) {
  return (
    <ul className="file-tree-list">
      {node.children.map((child) => {
        const key = `pkg:${child.key}`;
        const isCollapsed = !expanded.has(key);
        return (
          <li key={child.key}>
            <button
              type="button"
              className="file-tree-package"
              style={{ paddingLeft: indent(depth + 1) }}
              aria-expanded={!isCollapsed}
              onClick={() => onToggle(key)}
              // A package's menu acts on every script UNDER it, at any depth —
              // which is what "export this package" means, and it works whether
              // the branch is open or shut.
              onContextMenu={onContext && ((event) => {
                event.preventDefault();
                onContext({
                  x: event.clientX,
                  y: event.clientY,
                  label: child.name,
                  paths: pathsUnder(child),
                });
              })}
            >
              <Chevron open={!isCollapsed} />
              <IconFolder size={14} className="file-tree-icon" />
              <span>{child.name}</span>
              {/* A collapsed package hides its changed scripts, so it carries
                  the worst mark of everything below it — including deletions,
                  whose own row no longer exists. */}
              {pathPrefix !== undefined && (() => {
                const mark = gitMarks?.get(`${pathPrefix}${child.key}`);
                return mark ? <GitBadge mark={mark} /> : null;
              })()}
            </button>
            {!isCollapsed && (
              <PackageBranch
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                selectedPath={selectedPath}
                onSelect={onSelect}
                onDelete={onDelete}
                onContext={onContext}
                gitMarks={gitMarks}
                pathPrefix={pathPrefix}
              />
            )}
          </li>
        );
      })}
      {node.scripts.map((entry) => (
        <ScriptRow
          key={entry.path}
          entry={entry}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          onDelete={onDelete}
          onContext={onContext}
          gitMark={gitMarks?.get(entry.path)}
        />
      ))}
    </ul>
  );
}

interface SingletonRowProps {
  typeId: ScriptTypeId;
  label: string;
  /** Undefined until this project actually has the script. */
  entry?: ScriptEntry;
  selectedPath: string | null;
  onSelect: (entry: ScriptEntry) => void;
  onDelete?: (entry: ScriptEntry) => void;
  onCreate?: (typeId: ScriptTypeId) => void;
}

/**
 * Shutdown, Startup or Update — one row, never a folder.
 *
 * The Designer lists all three whether or not the project has them, renders the
 * label **bold** once one exists, and offers no rename, cut or copy on them
 * (SCRIPTING.md §1.1 and §5.5). A row for one that does not exist is not dead:
 * clicking it creates the script, which is the only way to get a Startup script
 * into a project from here.
 */
function SingletonRow({
  typeId, label, entry, selectedPath, onSelect, onDelete, onCreate,
}: SingletonRowProps) {
  const selected = Boolean(entry) && entry?.path === selectedPath;
  const disabled = entry?.enabled === false;
  // `defined` comes from the listing; fall back to "it is listed at all", which
  // is what an older gateway response gives us.
  const exists = entry ? entry.defined !== false : false;
  return (
    <li className="file-tree-row">
      <button
        type="button"
        className={`file-tree-item${selected ? ' is-selected' : ''}`}
        style={{ paddingLeft: indent(1) }}
        aria-current={selected ? 'true' : undefined}
        title={exists ? undefined : `Not defined in this project — click to create the ${label} script.`}
        onClick={() => {
          if (entry && exists) {
            onSelect(entry);
          } else {
            onCreate?.(typeId);
          }
        }}
        disabled={!exists && !onCreate}
      >
        {iconForType(typeId, { size: 14, className: 'file-tree-icon' })}
        <span className={`file-tree-name${exists ? ' is-defined' : ' is-undefined'}`}>
          {label}
        </span>
        {disabled && <DisabledBadge />}
      </button>
      {entry && exists && onDelete && entry.origin !== 'inherited' && (
        <button
          type="button"
          className="file-tree-action file-tree-delete"
          title={`Delete the ${label} script`}
          aria-label={`Delete the ${label} script`}
          onClick={() => onDelete(entry)}
        >
          <IconTrash size={13} />
        </button>
      )}
    </li>
  );
}

/**
 * One letter saying how this resource differs from the last commit.
 *
 * A letter and a colour, not an icon: the row already carries a type icon and a
 * chevron, and a third glyph competing with those reads as another file kind.
 * The letters are git's own — M, A, D — so anybody who has used `git status`
 * already knows them, and the tooltip spells each one out for anybody who has
 * not.
 */
function GitBadge({ mark }: { mark: GitMark }) {
  // The letter is sighted-only chrome (title gives the same word on hover);
  // aria-label carries the word itself so the row's accessible name states
  // git status instead of silently dropping it, the way the disabled and
  // inherited/override badges beside it already state theirs in text.
  return (
    <span className={`git-mark git-mark-${mark}`} title={markTitle(mark)} aria-label={markTitle(mark)}>
      {markLetter(mark)}
    </span>
  );
}

/**
 * The Designer's "this event script is switched off" marker.
 *
 * A badge rather than dimming the row: dimming is already what an inherited or
 * unsaved row does, and three meanings on one visual channel is no meaning.
 */
function DisabledBadge() {
  return (
    <span className="badge badge-disabled" title="Disabled — this script will not run">
      off
    </span>
  );
}

interface RowProps {
  entry: ScriptEntry;
  depth: number;
  selectedPath: string | null;
  onSelect: (entry: ScriptEntry) => void;
  onDelete?: (entry: ScriptEntry) => void;
  onContext?: FileTreeProps['onContext'];
  gitMark?: GitMark;
}

function ScriptRow({
  entry, depth, selectedPath, onSelect, onDelete, onContext, gitMark,
}: RowProps) {
  const selected = entry.path === selectedPath;
  // Only a script this project OWNS can be deleted. An inherited one has nothing
  // here to remove, and the server 404s it — so the button is absent rather than
  // present and failing.
  const deletable = Boolean(onDelete) && entry.origin !== 'inherited' && !entry.singleton;
  // On an override, the same button means something else. The Designer offers
  // no Delete at all on an overridden resource — its menu has `Discard
  // Overrides`, and the difference is not pedantic: this removes the local copy
  // and the script keeps working, inherited from the parent. Calling that
  // "Delete" invites the user to think they are about to lose the script.
  const discards = entry.origin === 'override';
  return (
    <li className="file-tree-row">
      <button
        type="button"
        className={`file-tree-item${selected ? ' is-selected' : ''}`}
        style={{ paddingLeft: indent(depth) }}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(entry)}
        onContextMenu={onContext && ((event) => {
          event.preventDefault();
          onContext({
            x: event.clientX,
            y: event.clientY,
            label: entry.name || entry.typeLabel,
            paths: [entry.path],
          });
        })}
      >
        {iconForType(entry.typeId, { size: 14, className: 'file-tree-icon' })}
        <span className="file-tree-name">{entry.name || entry.typeLabel}</span>
        {entry.enabled === false && <DisabledBadge />}
        {/* Inheritance is not decoration: editing an inherited script CREATES a
            local override rather than changing the parent, and the user has to
            know that before they type. */}
        {entry.origin !== 'local' && (
          <span className={`badge badge-${entry.origin}`} title={originTitle(entry)}>
            {entry.origin}
          </span>
        )}
        {gitMark && <GitBadge mark={gitMark} />}
      </button>
      {deletable && (
        <button
          type="button"
          className={`file-tree-action ${discards ? 'file-tree-discard' : 'file-tree-delete'}`}
          title={
            discards
              ? `Discard the local override of ${entry.name} and return to the copy inherited from ${entry.owner}`
              : `Delete ${entry.name}`
          }
          aria-label={
            discards ? `Discard overrides on ${entry.name}` : `Delete ${entry.name}`
          }
          onClick={() => onDelete?.(entry)}
        >
          {discards ? <IconRevert size={13} /> : <IconTrash size={13} />}
        </button>
      )}
    </li>
  );
}

function originTitle(entry: ScriptEntry): string {
  return entry.origin === 'inherited'
    ? `Inherited from ${entry.owner}. Read-only until you override it.`
    : `Overrides the copy inherited from ${entry.owner}. Discarding the override returns to it.`;
}

/** Indentation per tree level, in the token scale. */
function indent(depth: number): string {
  return `calc(var(--space-2) + ${depth} * var(--space-4))`;
}


