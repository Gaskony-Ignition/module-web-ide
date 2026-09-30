/**
 * Client for the import-organiser route.
 *
 * A pure transform, not a write: the caller already has the buffer open and is
 * asking for the SAME text back, organised — see ImportOrganiser and
 * ScriptResourceRouteHandler#organiseImports. No `If-Match` is sent, because
 * there is no resource version to assert against something that never reaches
 * the gateway's own copy of the script; CSRF is still enforced because it is a
 * POST from a browser session.
 */
import { CSRF_HEADER, toApiError } from './scripts';
import { apiUrl } from './urls';

/** One offered import for a name the source reads but never binds. */
export interface ImportSuggestion {
  name: string;
  /** The statement to insert, e.g. `from util.helpers import compute`. */
  statement: string;
  /** Whether `name` was found in a project module, or the built-in fallback table. */
  origin: 'project' | 'library';
}

export interface OrganiseImportsResult {
  /** The organised source. Identical to the request when nothing changed. */
  source: string;
  /** Import statements dropped — exact duplicates, or provably unused. */
  removed: string[];
  /** Why the block was left alone, or partly alone: a syntax error, a refusal, exec/eval/star. */
  notes: string[];
  suggestions: ImportSuggestion[];
}

/**
 * POST /api/scripts/organise-imports?project=X — organise the leading import
 * block of `source`, and suggest an import for each name it reads but never
 * binds.
 *
 * Authenticated, not Administrator: the route writes nothing to the gateway.
 */
export async function organiseImports(
  project: string,
  source: string,
  csrfToken?: string
): Promise<OrganiseImportsResult> {
  const query = new URLSearchParams({ project });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (csrfToken) {
    headers[CSRF_HEADER] = csrfToken;
  }
  const response = await fetch(`${apiUrl('/api/scripts/organise-imports')}?${query.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ source }),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as Partial<OrganiseImportsResult>;
  return {
    source: body.source ?? source,
    removed: body.removed ?? [],
    notes: body.notes ?? [],
    suggestions: body.suggestions ?? [],
  };
}
