/**
 * Name a new Project Library script.
 *
 * Validation runs as the user types and the create button stays disabled until
 * the name is legal, because the failure it prevents is not cosmetic: a library
 * script's resource name IS its Python module path, so `my-utils` produces a
 * module that no `import` statement can name. Catching that after a round trip
 * would mean the gateway holds a resource the user can never use.
 *
 * Project Library only, deliberately. A timer or message handler also needs
 * attributes (a delay, a threading mode) whose Designer-written defaults this
 * module has not measured, and inventing them writes a value onto a live gateway
 * on the strength of a guess — the same rule that keeps `scheduled` and
 * `tag-change` attribute writes refused.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { validateScriptName, type ScriptTypeId } from '../api/scripts';
import { EMPTY_TEMPLATE, TEMPLATES, templateById } from '../api/templates';
import './NewScriptDialog.css';

export interface NewScriptDialogProps {
  /** Existing names of this type, so a collision is caught before the round trip. */
  existingNames: string[];
  /** What is being created. Drives the label, the hint and the naming rules. */
  typeId: ScriptTypeId;
  typeLabel: string;
  busy?: boolean;
  error?: string | null;
  /**
   * The second argument is the chosen template's source.
   *
   * Passed up rather than written here so there is still ONE create path: the
   * dialog decides the starting text, `doCreate` writes it through the same
   * route as an empty script and gets the same signature, the same tree refresh
   * and the same error handling.
   */
  onCreate: (name: string, source?: string) => void;
  onCancel: () => void;
}

export default function NewScriptDialog({
  existingNames,
  typeId,
  typeLabel,
  busy = false,
  error = null,
  onCreate,
  onCancel,
}: NewScriptDialogProps) {
  const isLibrary = typeId === 'script-python';
  const [name, setName] = useState('');
  /**
   * Library scripts only.
   *
   * An event script's body is not a free choice — its handler signature is
   * dictated by the type, and it is already seeded from the measured stub. A
   * template picker there would offer to replace a correct answer with a
   * guess.
   */
  const [templateId, setTemplateId] = useState(EMPTY_TEMPLATE.id);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const taken = useMemo(() => new Set(existingNames), [existingNames]);
  const problem = useMemo(() => {
    if (!name) {
      return null; // Don't scold an empty field the user has not filled in yet.
    }
    const invalid = validateScriptName(name, typeId);
    if (invalid) {
      return invalid;
    }
    if (taken.has(name)) {
      return `${name} already exists in this project`;
    }
    return null;
  }, [name, taken, typeId]);

  const canCreate = name.trim().length > 0 && problem === null && !busy;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (canCreate) {
      onCreate(name, isLibrary ? templateById(templateId).source : undefined);
    }
  }

  return (
    <div className="newscript-backdrop" role="presentation">
      <form
        className="newscript-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="newscript-title"
        onSubmit={submit}
        // Escape closes, matching every other dialog in the app.
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
        }}
      >
        <h2 id="newscript-title">New {typeLabel.toLowerCase()} script</h2>
        <label className="newscript-label" htmlFor="newscript-name">
          Name
        </label>
        <input
          id="newscript-name"
          ref={inputRef}
          className="newscript-input"
          value={name}
          spellCheck={false}
          autoComplete="off"
          placeholder={isLibrary ? 'util/helpers' : 'MyHandler'}
          aria-describedby="newscript-hint"
          aria-invalid={problem ? 'true' : undefined}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
        <p id="newscript-hint" className="newscript-hint muted">
          {isLibrary ? (
            <>
              Use <code>/</code> for packages — <code>util/helpers</code> becomes{' '}
              <code>project.util.helpers</code>.
            </>
          ) : (
            <>
              The name identifies this handler on the gateway. Spaces are allowed;
              the script starts with its handler stub.
            </>
          )}
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

        {isLibrary && (
          <>
            <label className="newscript-label" htmlFor="newscript-template">
              Start from
            </label>
            <select
              id="newscript-template"
              className="newscript-input"
              value={templateId}
              disabled={busy}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              {TEMPLATES.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.label}
                </option>
              ))}
            </select>
            <p className="newscript-hint muted">{templateById(templateId).hint}</p>
          </>
        )}

        <div className="newscript-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}
