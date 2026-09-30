/**
 * Save the Query Browser's current buffer as a named query (C).
 *
 * ONE call against the EXISTING named-query write path, never a hand-built
 * resource: `createNamedQuery` (no `If-Match` — a create) with `settings`
 * riding along in the same push, exactly as `NamedQueryRouteHandler.writeContent`
 * already accepts on any content write, create or modify (see
 * `docs/NAMED-QUERIES.md` §2) — so the type and the preselected datasource
 * land in the SAME write as the SQL, not a follow-up settings write against
 * the signature the create returned.
 *
 * `POST …/content/:path` with no `If-Match` would silently OVERRIDE an
 * inherited query rather than refuse, which is why this dialog checks the
 * listing itself first, rather than leaning on the 428 the server would
 * otherwise answer for a query this project already owns. The same listing
 * also catches a FOLDER/query overlap a bare "does this exact path already
 * exist" check would miss: saving over an existing folder's own path, or
 * under/over a path an existing query already occupies (a query cannot also
 * be a folder, in either direction).
 *
 * Reuses `NewScriptDialog.css` exactly as `NamedQueryDialog` does — a second
 * dialog shell a few pixels different reads as a second application.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  QUERY_TYPES, QUERY_TYPE_LABELS, emptySettings, createNamedQuery,
  fetchNamedQueries, validateNamedQueryName, type NamedQueryType,
} from '../api/namedQueries';
import { makeDialogKeyDown, useDialogOpener } from './dialogA11y';
import type { Datasource } from '../api/dbQueries';
import './NewScriptDialog.css';

export interface SaveAsNamedQueryDialogProps {
  /** The project the query is saved into — the current one, or a pop-out's `?project=`. */
  project: string;
  /** The SQL exactly as typed — saved byte for byte, nothing trimmed or reformatted. */
  sql: string;
  /** The Query Browser's currently selected datasource, preselected here. */
  datasource: string;
  datasources: Datasource[];
  csrfToken?: string;
  onSaved: (path: string) => void;
  onCancel: () => void;
}

export default function SaveAsNamedQueryDialog({
  project, sql, datasource, datasources, csrfToken, onSaved, onCancel,
}: SaveAsNamedQueryDialogProps) {
  const [path, setPath] = useState('');
  const [queryType, setQueryType] = useState<NamedQueryType>('Query');
  const [targetDatasource, setTargetDatasource] = useState(datasource);
  const [existingQueryPaths, setExistingQueryPaths] = useState<string[] | null>(null);
  const [existingFolderPaths, setExistingFolderPaths] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  useDialogOpener(pathRef, dialogRef);

  // Read once, on open: this dialog is short-lived and a query created by
  // someone else in the same few seconds is a race no client-side check can
  // close anyway — the gateway's own signature check on the OWN-project path
  // still refuses a genuine collision when this list happens to be stale.
  useEffect(() => {
    let cancelled = false;
    fetchNamedQueries(project)
      .then((list) => {
        if (cancelled) return;
        setExistingQueryPaths(list.queries.filter((q) => !q.isFolder).map((q) => q.path));
        setExistingFolderPaths(list.queries.filter((q) => q.isFolder).map((q) => q.path));
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const problem = useMemo(() => {
    if (!path) {
      return null;
    }
    const invalid = validateNamedQueryName(path);
    if (invalid) {
      return invalid;
    }
    if (existingQueryPaths?.includes(path)) {
      return `A named query already exists at "${path}" — open it from the Named Queries tree instead, `
        + 'or choose a different path.';
    }
    if (existingFolderPaths.includes(path)) {
      return `"${path}" is already a folder — choose a query inside it, or a different path.`;
    }
    // A query cannot also be a folder, in either direction: something
    // already lives UNDER this path (so this path is implicitly a folder
    // already), or an ANCESTOR segment of this path is already a query (so
    // it cannot also contain this one).
    const asFolder = `${path}/`;
    if (existingQueryPaths?.some((q) => q.startsWith(asFolder))) {
      return `"${path}" already contains a named query — choose a different path.`;
    }
    const ancestorQuery = existingQueryPaths?.find((q) => path.startsWith(`${q}/`));
    if (ancestorQuery) {
      return `"${ancestorQuery}" is already a named query, so it cannot also contain "${path}".`;
    }
    return null;
  }, [path, existingQueryPaths, existingFolderPaths]);

  const canSubmit = path.trim().length > 0 && problem === null && !busy && existingQueryPaths !== null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // ONE write: settings ride along with the sql on the same create push
      // (see the module comment) — `emptySettings()` supplies the
      // platform's own measured defaults for everything this dialog does
      // not ask about.
      await createNamedQuery({
        project,
        path,
        sql,
        settings: { ...emptySettings(), type: queryType, database: targetDatasource },
        csrfToken,
      });
      onSaved(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="newscript-backdrop" role="presentation">
      <form
        ref={dialogRef}
        className="newscript-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-nq-title"
        onSubmit={submit}
        onKeyDown={makeDialogKeyDown(dialogRef, onCancel)}
      >
        <h2 id="save-nq-title">Save as named query</h2>
        <p className="newscript-hint muted">Project: {project}</p>

        <label className="newscript-label" htmlFor="save-nq-path">Path</label>
        <input
          id="save-nq-path"
          ref={pathRef}
          className="newscript-input"
          value={path}
          spellCheck={false}
          autoComplete="off"
          placeholder="Orders/Daily/Totals"
          aria-describedby="save-nq-hint"
          aria-invalid={problem ? 'true' : undefined}
          onChange={(event) => setPath(event.target.value)}
          disabled={busy}
        />
        <p id="save-nq-hint" className="newscript-hint muted">
          Use <code>/</code> for folders — the path <code>system.db.runNamedQuery</code> takes.
        </p>

        <label className="newscript-label" htmlFor="save-nq-type">Query type</label>
        <select
          id="save-nq-type"
          className="newscript-input"
          value={queryType}
          disabled={busy}
          onChange={(event) => setQueryType(event.target.value as NamedQueryType)}
        >
          {QUERY_TYPES.map((type) => (
            <option key={type} value={type}>{QUERY_TYPE_LABELS[type]}</option>
          ))}
        </select>

        <label className="newscript-label" htmlFor="save-nq-datasource">Datasource</label>
        <select
          id="save-nq-datasource"
          className="newscript-input"
          value={targetDatasource}
          disabled={busy}
          onChange={(event) => setTargetDatasource(event.target.value)}
        >
          <option value="">(project default)</option>
          {datasources.map((ds) => (
            <option key={ds.name} value={ds.name}>{ds.name}</option>
          ))}
        </select>

        {listError && (
          <p className="newscript-problem" role="alert">
            Could not check for an existing query at this path: {listError}
          </p>
        )}
        {problem && (
          <p className="newscript-problem" role="alert">{problem}</p>
        )}
        {error && (
          <p className="newscript-problem" role="alert">{error}</p>
        )}

        <div className="newscript-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={!canSubmit}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
