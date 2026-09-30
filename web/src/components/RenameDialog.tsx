/**
 * Rename one script, and offer to fix the call sites.
 *
 * Named queries have had rename since 1.7.0 and scripts have not, so moving a
 * library module meant create-at-the-new-path, delete-the-old, and then find
 * every import by hand. The last step is the one that gets missed, and it is the
 * one that breaks at run time rather than at save time.
 *
 * ## Two steps, on purpose
 *
 * The rename moves the resource. Updating the call sites is a SEPARATE,
 * confirmed project-wide replace — the same one the Search view runs, with the
 * same preview, the same skipping of inherited scripts and dirty buffers, and
 * the same per-file report. Folding it into the rename would be a bulk write
 * with none of those guards, behind a button that says "Rename".
 *
 * ## One resource, never a folder
 *
 * The server refuses a folder, and this says so before you type. A folder move
 * is a multi-resource push with collision checking across the subtree; shipping
 * a version that silently moved only the direct children would be worse than not
 * offering it.
 */
import { useMemo, useState } from 'react';
import { validateScriptName, type ScriptEntry } from '../api/scripts';
import './RenameDialog.css';

export interface RenameDialogProps {
  entry: ScriptEntry;
  /** Current dotted module name, when this is a library script. */
  moduleName?: string;
  busy?: boolean;
  onCancel: () => void;
  /** The new leaf name, and whether to offer the call-site update afterwards. */
  onRename: (newName: string, updateCallSites: boolean) => void;
}

/** `ignition/script-python/util/helpers` → `helpers`. */
export function leafOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

export default function RenameDialog({
  entry, moduleName, busy, onCancel, onRename,
}: RenameDialogProps) {
  const current = leafOf(entry.path);
  const [name, setName] = useState(current);
  const [updateCallSites, setUpdateCallSites] = useState(Boolean(moduleName));

  // The same validator the create dialog uses, so a name this refuses is a name
  // the create path would have refused too.
  const problem = useMemo(() => {
    if (name === current) return 'That is the current name.';
    return validateScriptName(name, entry.typeId);
  }, [name, current, entry.typeId]);

  const nextModule = moduleName && name
    ? moduleName.split('.').slice(0, -1).concat(name).join('.')
    : undefined;

  return (
    <div className="rename-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Rename ${current}`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Rename {current}</h2>

        <label className="rename-field">
          <span>New name</span>
          <input
            type="text"
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !problem && !busy) {
                onRename(name, updateCallSites);
              }
            }}
          />
        </label>

        {problem ? (
          <p className="rename-problem" role="alert">{problem}</p>
        ) : nextModule ? (
          <p className="rename-note muted">
            Imports of <code>{moduleName}</code> become <code>{nextModule}</code>.
          </p>
        ) : (
          <p className="rename-note muted">
            This resource is not imported by name, so nothing else refers to it.
          </p>
        )}

        {moduleName && (
          <label className="rename-check">
            <input
              type="checkbox"
              checked={updateCallSites}
              onChange={(event) => setUpdateCallSites(event.target.checked)}
            />
            <span>
              Afterwards, offer to replace <code>{moduleName}</code> across the project.
              You will see the file list and confirm before anything is written.
            </span>
          </label>
        )}

        <p className="rename-note muted">
          Renames one script. A folder has to be moved a script at a time — the
          gateway refuses a folder here rather than half-moving it.
        </p>

        <div className="rename-actions">
          <button type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="button"
            disabled={Boolean(problem) || busy}
            onClick={() => onRename(name, updateCallSites)}
          >
            {busy ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );
}
