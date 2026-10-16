/**
 * The one small dialog every tag-tree prompt goes through: a name for a new
 * tag, a rename, a value to write, a UDT definition to instantiate, or how an
 * import should treat a tag that already exists.
 *
 * One component rather than five because they are the same shape — at most one
 * text field and one choice, validated as you type, with the button disabled
 * until the answer is legal — the pattern `NamedQueryDialog` set. Its own
 * `tag-dialog-*` classes: the shell looks like the other dialogs here, but a
 * live suite that finds "the new-script dialog" by its class must not find this.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { makeDialogKeyDown, useDialogOpener } from './dialogA11y';

export interface TagNameDialogProps {
  title: string;
  /** The text field. Absent for a dialog that only asks a choice. */
  field?: {
    label: string;
    initial?: string;
    placeholder?: string;
    /** A problem to show, or null when the text is acceptable. */
    validate?: (value: string) => string | null;
    hint?: ReactNode;
  };
  choice?: { label: string; options: string[]; initial?: string };
  submitLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string, choice: string) => void;
  onCancel: () => void;
}

/**
 * A tag name the platform will take as ONE path segment.
 *
 * `/` would make it a path and `[` `]` would read as a provider, so a name with
 * any of them silently lands somewhere other than where it was asked for.
 */
export function validateTagName(name: string): string | null {
  if (name.trim() === '') return 'A tag name cannot be blank';
  if (/[/[\]]/.test(name)) return 'A tag name cannot contain / [ or ]';
  return null;
}

export default function TagNameDialog({
  title, field, choice, submitLabel, busy = false, error = null, onSubmit, onCancel,
}: TagNameDialogProps) {
  const [value, setValue] = useState(field?.initial ?? '');
  const [picked, setPicked] = useState(choice?.initial ?? choice?.options[0] ?? '');
  const dialogRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  useDialogOpener(field ? inputRef : selectRef, dialogRef);

  const problem = useMemo(
    () => (field && value !== '' ? field.validate?.(value) ?? null : null),
    [field, value]
  );
  const canSubmit = !busy && problem === null
    && (!field || value !== '') && (!choice || picked !== '');

  return (
    <div className="tag-dialog-backdrop" role="presentation">
      <form
        ref={dialogRef}
        className="tag-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-dialog-title"
        onKeyDown={makeDialogKeyDown(dialogRef, onCancel)}
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) onSubmit(value, picked);
        }}
      >
        <h2 id="tag-dialog-title">{title}</h2>
        {field && (
          <>
            <label className="tag-dialog-label" htmlFor="tag-dialog-input">{field.label}</label>
            <input
              id="tag-dialog-input"
              ref={inputRef}
              className="tag-dialog-input"
              value={value}
              spellCheck={false}
              autoComplete="off"
              placeholder={field.placeholder}
              aria-invalid={problem ? 'true' : undefined}
              onChange={(event) => setValue(event.target.value)}
              onFocus={(event) => event.target.select()}
              disabled={busy}
            />
            {field.hint && <p className="tag-dialog-hint">{field.hint}</p>}
          </>
        )}
        {choice && (
          <>
            <label className="tag-dialog-label" htmlFor="tag-dialog-choice">{choice.label}</label>
            <select
              id="tag-dialog-choice"
              ref={selectRef}
              className="tag-dialog-input"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              disabled={busy || choice.options.length === 0}
            >
              {choice.options.length === 0 && <option value="">None available</option>}
              {choice.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </>
        )}
        {problem && <p className="tag-dialog-problem" role="alert">{problem}</p>}
        {error && <p className="tag-dialog-problem" role="alert">{error}</p>}
        <div className="tag-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={!canSubmit}>{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}
