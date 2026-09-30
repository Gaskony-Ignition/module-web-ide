/**
 * Name a named query — on create, and on rename.
 *
 * One dialog for both because they ask the same question and validate the same
 * way: the Designer's own create prompt takes `Folder/Name`, and a rename that
 * changes the folder part is how a query is moved.
 *
 * Validation runs as the user types and the button stays disabled until the
 * name is legal, for the same reason `NewScriptDialog` does it: a name the
 * server refuses after a round trip is a name the user has already committed to
 * in their head. The rule itself is the PLATFORM's and lives beside the wire
 * format — see `validateNamedQueryName`. It is deliberately NOT the Python
 * identifier rule: `Order-Intake` is a legal query name and an illegal module.
 *
 * The dialog reuses `NewScriptDialog.css` rather than defining its own shell.
 * Two dialogs that differ by a few pixels read as two different applications.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { validateNamedQueryName } from '../api/namedQueries';
import './NewScriptDialog.css';

export interface NamedQueryDialogProps {
  /**
   * `rename-folder` moves a folder and everything under it. The same field and
   * the same rule — a folder path is a query path with the last segment taken
   * off — so it is a third mode here rather than a second dialog.
   */
  mode: 'create' | 'rename' | 'rename-folder';
  /** `Folder/Name` the field starts on — the current name, when renaming. */
  initialName?: string;
  /** Existing names, so a collision is caught before the round trip. */
  existingNames: string[];
  busy?: boolean;
  error?: string | null;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

export default function NamedQueryDialog({
  mode,
  initialName = '',
  existingNames,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: NamedQueryDialogProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // The name being renamed is not a collision with itself.
  const taken = useMemo(
    () => new Set(existingNames.filter((existing) => existing !== initialName)),
    [existingNames, initialName]
  );

  const problem = useMemo(() => {
    if (!name) {
      return null; // Don't scold an empty field the user has not filled in yet.
    }
    const invalid = validateNamedQueryName(name);
    if (invalid) {
      return invalid;
    }
    if (taken.has(name)) {
      return `${name} already exists in this project`;
    }
    return null;
  }, [name, taken]);

  const changed = mode === 'create' || name !== initialName;
  const canSubmit = name.trim().length > 0 && problem === null && changed && !busy;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (canSubmit) {
      onSubmit(name);
    }
  }

  const title = mode === 'create'
    ? 'New named query'
    : mode === 'rename-folder'
      ? 'Rename folder'
      : 'Rename named query';

  return (
    <div className="newscript-backdrop" role="presentation">
      <form
        className="newscript-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="namedquery-title"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="namedquery-title">{title}</h2>
        <label className="newscript-label" htmlFor="namedquery-name">
          Name
        </label>
        <input
          id="namedquery-name"
          ref={inputRef}
          className="newscript-input"
          value={name}
          spellCheck={false}
          autoComplete="off"
          placeholder="Orders/Daily/Totals"
          aria-describedby="namedquery-hint"
          aria-invalid={problem ? 'true' : undefined}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <p id="namedquery-hint" className="newscript-hint muted">
          Use <code>/</code> for folders — <code>Orders/Daily/Totals</code> is the path{' '}
          <code>system.db.runNamedQuery</code> takes. Letters, digits, <code>-</code> and{' '}
          <code>_</code>.
          {mode === 'rename' && ' Changing the folder part moves the query.'}
          {mode === 'rename-folder'
            && ' Every query in this folder moves with it.'}
        </p>

        {problem && (
          <p className="newscript-problem" role="alert">
            {problem}
          </p>
        )}
        {error && (
          <p className="newscript-problem" role="alert">
            {error}
          </p>
        )}

        <div className="newscript-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {mode === 'create'
              ? busy ? 'Creating…' : 'Create'
              : busy ? 'Renaming…' : mode === 'rename-folder' ? 'Move folder' : 'Rename'}
          </button>
        </div>
      </form>
    </div>
  );
}
