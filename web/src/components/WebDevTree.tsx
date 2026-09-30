/**
 * The Web Dev view: endpoints, and the HTTP methods each implements.
 *
 * Web Dev is its own activity-bar view rather than another section under
 * Scripting, because it is a different resource under a different module id and
 * because named queries will want the same treatment — three unrelated resource
 * trees stacked in one scrolling column stops being navigable.
 *
 * An endpoint is a FOLDER, so a row expands rather than opening one file. What
 * it expands to depends on which of the two shapes the gateway wrote — and
 * until 1.9.0 this component only knew one of them:
 *
 * - a **python resource** lists its eight verbs. Ones it does not implement are
 *   shown greyed with an "add" affordance: that is the only way to create
 *   `doPost.py` on an endpoint that currently has only `doGet.py`, and hiding
 *   them made it impossible.
 * - a **text resource** has no verbs at all. Its body is a static file — 65 KB
 *   of HTML, in `cell3d`'s case — living inside `config.json`, so it lists one
 *   row for that file and NO add-a-verb buttons. Offering them was not merely
 *   useless: pressing one would have put a Python handler onto a resource the
 *   platform serves as static HTML.
 *
 * Either shape may also carry static FILES beside all that (`lib` ships
 * `three.min.js`). Those were readable through the content route the whole time
 * and appeared nowhere at all.
 */
import { useMemo } from 'react';
import { useStickySet } from '../workspace/viewState';
import type { ScriptEntry, WebDevFile } from '../api/scripts';
import { WEBDEV_TEXT_KEY } from '../workspace/documents';
import { IconGlobe, IconPlus, IconTrash } from './Icons';
import { Chevron } from './Chevron';
import './FileTree.css';

/** Every method an endpoint can implement, in the Designer's order. */
export const WEBDEV_METHODS = [
  'doGet', 'doPost', 'doPut', 'doDelete', 'doHead', 'doOptions', 'doTrace', 'doPatch',
] as const;

export interface WebDevTreeProps {
  /** Web Dev entries from the script listing — same endpoint, filtered by type. */
  endpoints: ScriptEntry[];
  selectedPath: string | null;
  /**
   * The data key of the open document, so the right child row is highlighted.
   *
   * The raw key rather than a method name: a row can now be a verb handler
   * (`doGet.py`), a static file (`three.min.js`) or a text resource's body
   * (`config.json#text`), and only one of those three has a method at all.
   */
  selectedKey?: string | null;
  onOpen: (entry: ScriptEntry, method: string) => void;
  /** Open a file by its data key — a static asset, or a text resource's body. */
  onOpenFile: (entry: ScriptEntry, dataKey: string) => void;
  /** Omitted when the session cannot write. */
  onCreate?: () => void;
  onDelete?: (entry: ScriptEntry) => void;
  onAddMethod?: (entry: ScriptEntry, method: string) => void;
  onEditConfig?: (entry: ScriptEntry) => void;
}

export default function WebDevTree({
  endpoints,
  selectedPath,
  selectedKey,
  onOpen,
  onOpenFile,
  onCreate,
  onDelete,
  onAddMethod,
  onEditConfig,
}: WebDevTreeProps) {
  // Sticky across an unmount — see useStickySet. This tree in particular was
  // called out for it: "everytime I go to that tab they return to being fully
  // expanded regardless of what I set it to" (Nigel, 03/09/2026).
  //
  // Tracked as EXPANDED, like the script and named-query trees, so the default
  // falls out of the empty set: this tree shipped tracking the COLLAPSED keys
  // instead, which made "nothing remembered yet" mean "everything open" — and
  // an eight-verb endpoint opens eight rows, so a project with six endpoints
  // landed on fifty rows to scroll past (Nigel, 04/09/2026: "I want by default
  // the WebDev to start shrunk but remember what i've expanded between tabs").
  // The key is renamed with it, so a set stored by the old build is not read
  // back with its meaning inverted.
  const [expanded, setExpanded] = useStickySet('webdev.expanded');

  const sorted = useMemo(
    () => [...endpoints].sort((a, b) => a.name.localeCompare(b.name)),
    [endpoints]
  );

  function toggle(key: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <nav className="file-tree" aria-label="Web Dev">
      <div className="file-tree-header-row">
        <div className="file-tree-header file-tree-static">
          <span>Endpoints</span>
          <span className="file-tree-count">{sorted.length}</span>
        </div>
        {onCreate && (
          <button
            type="button"
            className="file-tree-action"
            title="New Web Dev endpoint"
            aria-label="New Web Dev endpoint"
            onClick={onCreate}
          >
            <IconPlus size={13} />
          </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="file-tree-empty muted">No Web Dev endpoints in this project.</p>
      ) : (
        <ul className="file-tree-list">
          {sorted.map((entry) => {
            const key = `wd:${entry.path}`;
            const isCollapsed = !expanded.has(key);
            const implemented = new Set(entry.methods ?? []);
            // Absent means python: that is what every endpoint was assumed to
            // be before 1.9.0, and an older gateway sends no discriminant.
            const isText = entry.webdevKind === 'text';
            const files = entry.files ?? [];
            return (
              <li key={entry.path}>
                <div className="file-tree-row">
                  <button
                    type="button"
                    className="file-tree-package"
                    aria-expanded={!isCollapsed}
                    onClick={() => toggle(key)}
                  >
                    <Chevron open={!isCollapsed} />
                    <IconGlobe size={14} className="file-tree-icon" />
                    <span className="file-tree-name">{entry.name}</span>
                    {entry.origin !== 'local' && (
                      <span className={`badge badge-${entry.origin}`}>{entry.origin}</span>
                    )}
                  </button>
                  {onEditConfig && !isText && (
                    <button
                      type="button"
                      className="file-tree-action"
                      title={`Settings for ${entry.name}`}
                      aria-label={`Settings for ${entry.name}`}
                      onClick={() => onEditConfig(entry)}
                    >
                      ⚙
                    </button>
                  )}
                  {onDelete && entry.origin !== 'inherited' && (
                    <button
                      type="button"
                      className="file-tree-action file-tree-delete"
                      title={`Delete ${entry.name}`}
                      aria-label={`Delete ${entry.name}`}
                      onClick={() => onDelete(entry)}
                    >
                      <IconTrash size={13} />
                    </button>
                  )}
                </div>

                {!isCollapsed && (
                  <ul className="file-tree-list">
                    {isText ? (
                      // One row, for the file this endpoint serves. No verbs:
                      // a text resource has none, and offering "add doGet"
                      // would put Python onto a static HTML resource.
                      <li className="file-tree-row">
                        <button
                          type="button"
                          className={`file-tree-item${
                            entry.path === selectedPath && selectedKey === WEBDEV_TEXT_KEY
                              ? ' is-selected'
                              : ''
                          }`}
                          aria-current={
                            entry.path === selectedPath && selectedKey === WEBDEV_TEXT_KEY
                              ? 'true'
                              : undefined
                          }
                          onClick={() => onOpenFile(entry, WEBDEV_TEXT_KEY)}
                          title={`Edit the ${entry.contentType ?? 'text'} this endpoint serves`}
                        >
                          <span className="file-tree-name">
                            {entry.name}.{extensionFor(entry.contentType)}
                          </span>
                          <span className="file-tree-note">{entry.contentType}</span>
                        </button>
                      </li>
                    ) : (
                      WEBDEV_METHODS.map((method) => {
                        const has = implemented.has(method);
                        const isSelected =
                          entry.path === selectedPath && `${method}.py` === selectedKey;
                        if (!has) {
                          // Not implemented. Shown, not hidden — this is the
                          // only place to create doPost.py on a doGet-only
                          // endpoint.
                          return onAddMethod ? (
                            <li key={method} className="file-tree-row">
                              <button
                                type="button"
                                className="file-tree-item is-absent"
                                onClick={() => onAddMethod(entry, method)}
                                title={`Add ${method} to ${entry.name}`}
                              >
                                <IconPlus size={12} className="file-tree-icon" />
                                <span className="file-tree-name">{method}</span>
                              </button>
                            </li>
                          ) : null;
                        }
                        return (
                          <li key={method} className="file-tree-row">
                            <button
                              type="button"
                              className={`file-tree-item${isSelected ? ' is-selected' : ''}`}
                              aria-current={isSelected ? 'true' : undefined}
                              onClick={() => onOpen(entry, method)}
                            >
                              <span className="file-tree-method">{method}</span>
                            </button>
                          </li>
                        );
                      })
                    )}

                    {files.map((file) => (
                      <FileRow
                        key={file.key}
                        file={file}
                        endpoint={entry.name}
                        selected={entry.path === selectedPath && file.key === selectedKey}
                        onOpen={() => onOpenFile(entry, file.key)}
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}

/**
 * A static file the endpoint carries — `lib`'s `three.min.js`, and anything
 * else somebody has put beside their handlers.
 *
 * A file this IDE will not open is still SHOWN, greyed, with its size. It is
 * part of the resource, the Designer lists it, and a row that says "670 KB,
 * too big to edit here" is a better answer than a file that appears not to
 * exist — which is what every one of these was until 1.9.0.
 */
function FileRow({
  file, endpoint, selected, onOpen,
}: {
  file: WebDevFile;
  endpoint: string;
  selected: boolean;
  onOpen: () => void;
}) {
  const size = formatSize(file.size);
  if (!file.editable) {
    return (
      <li className="file-tree-row">
        <span className="file-tree-item is-absent" title={`${file.key} — ${size}, not editable here`}>
          <span className="file-tree-name">{file.key}</span>
          <span className="file-tree-note">{size}</span>
        </span>
      </li>
    );
  }
  return (
    <li className="file-tree-row">
      <button
        type="button"
        className={`file-tree-item${selected ? ' is-selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        title={`Edit ${file.key} on ${endpoint} — ${size}`}
      >
        <span className="file-tree-name">{file.key}</span>
        <span className="file-tree-note">{size}</span>
      </button>
    </li>
  );
}

/** Bytes, in the shortest form that still says which unit it is. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file extension to show a text resource's MIME type as. */
function extensionFor(contentType: string | undefined): string {
  const base = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (base.includes('html') || base.includes('xml')) return 'html';
  if (base.includes('javascript')) return 'js';
  if (base.includes('css')) return 'css';
  if (base.includes('json')) return 'json';
  return 'txt';
}
