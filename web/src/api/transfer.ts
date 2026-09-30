/**
 * Export and import project resources, in the Designer's own zip format.
 *
 * Three calls for two gestures. Export is one; import is `inspectImport` — which
 * reads an archive and answers what is in it, writing nothing — followed by
 * `applyImport`, which writes the subset the user then ticked. The server holds
 * nothing between the two, so the file is sent twice: see the handler's Javadoc
 * for why that is the cheaper mistake than keeping uploaded archives on a
 * gateway against a token.
 */
import { apiUrl } from './urls';
import { CSRF_HEADER, toApiError } from './scripts';

/** One resource found inside an uploaded archive. */
export interface ImportEntry {
  /** The resource path it will be written to, exactly as the archive names it. */
  path: string;
  /** False for a resource type this module will not write — listed, not offered. */
  importable: boolean;
  /** True when this project already has it, so the client can say "replace". */
  exists: boolean;
  /** Data files beside the resource.json, e.g. `code.py`. */
  files: string[];
  bytes: number;
}

/** What the archive's own `project.json` said, when it had one. */
export interface ImportSource {
  title?: string;
  description?: string;
  parent?: string;
  inheritable?: boolean;
  enabled?: boolean;
}

export interface ImportInspection {
  project: string;
  source?: ImportSource;
  entries: ImportEntry[];
}

export type ImportStatus = 'created' | 'replaced' | 'skipped' | 'missing' | 'failed';

export interface ImportResult {
  path: string;
  status: ImportStatus;
  detail?: string;
}

export interface ImportOutcome {
  ok: boolean;
  written: number;
  results: ImportResult[];
}

/** `?project=X&path=A&path=B` — repeated, never delimited. See ScriptIdePaths. */
function withPaths(route: string, project: string, paths: string[]): string {
  const query = new URLSearchParams();
  query.set('project', project);
  paths.forEach((path) => query.append('path', path));
  return `${apiUrl(route)}?${query.toString()}`;
}

/**
 * Download the selected resources as a zip.
 *
 * Returns the blob and the filename the SERVER chose, rather than saving it
 * here: the name follows the Designer's convention and is built where the
 * project's real name is known, so a caller cannot drift from it by
 * reconstructing one.
 */
export async function exportScripts(
  project: string,
  paths: string[]
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(withPaths('/api/scripts/export', project, paths), {
    credentials: 'include',
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return {
    blob: await response.blob(),
    filename: filenameFrom(response.headers.get('Content-Disposition')),
  };
}

/**
 * The name out of a Content-Disposition, or a plain fallback.
 *
 * Deliberately forgiving: a proxy that rewrites or drops the header must cost
 * the user a worse filename, never a failed download.
 */
export function filenameFrom(header: string | null): string {
  const match = header?.match(/filename="?([^"]+)"?/);
  return match ? match[1] : 'project-export.zip';
}

/** Read an archive and report what it holds. Writes nothing. */
export async function inspectImport(
  project: string,
  file: Blob,
  csrfToken?: string
): Promise<ImportInspection> {
  const response = await fetch(
    `${apiUrl('/api/scripts/import/inspect')}?project=${encodeURIComponent(project)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/zip',
        ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
      },
      body: file,
    }
  );
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as ImportInspection;
}

/** Write the selected resources from the archive. */
export async function applyImport(
  project: string,
  paths: string[],
  file: Blob,
  csrfToken?: string
): Promise<ImportOutcome> {
  const response = await fetch(withPaths('/api/scripts/import', project, paths), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/zip',
      ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
    },
    body: file,
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as ImportOutcome;
}

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked on the next tick rather than immediately: revoking
 * it in the same frame as the click races the browser's own fetch of it in
 * Chromium, and the symptom is a download that silently does not happen.
 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
