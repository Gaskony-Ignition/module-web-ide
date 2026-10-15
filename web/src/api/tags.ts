/**
 * Typed client for the Tag Browser API.
 *
 * Same plumbing as `dbQueries.ts`: `credentials: 'same-origin'`, the CSRF header
 * on a write, `toApiError` on a non-OK response. See `TagRouteHandler` on the
 * gateway for the contract.
 */
import { apiUrl } from './urls';
import { CSRF_HEADER, toApiError } from './scripts';

export interface TagNode {
  name: string;
  hasChildren: boolean;
  /** Ignition's `TagObjectType` name, e.g. `AtomicTag`, `Folder`, `UdtType`. */
  objectType: string;
  /** Not reliable for telling tag kinds apart — a UDT definition reports one too. Use `objectType`. */
  dataType: string | null;
}

export interface TagBrowseResult {
  children: TagNode[];
  truncated: boolean;
}

export interface TagValue {
  path: string;
  value: string | number | boolean | null;
  quality: string;
  good: boolean;
  timestamp: string | null;
}

export interface TagMutationResult {
  ok: boolean;
  results: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown, csrfToken: string | undefined): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(csrfToken ? { [CSRF_HEADER]: csrfToken } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

export async function fetchTagProviders(): Promise<string[]> {
  const body = await getJson<{ providers: string[] }>(apiUrl('/api/tags/providers'));
  return body.providers;
}

export async function browseTags(path: string): Promise<TagBrowseResult> {
  const body = await getJson<{ children: TagNode[]; truncated?: boolean }>(
    apiUrl(`/api/tags/browse?path=${encodeURIComponent(path)}`)
  );
  return { children: body.children, truncated: body.truncated === true };
}

export async function readTags(paths: string[], csrfToken: string | undefined): Promise<TagValue[]> {
  const body = await postJson<{ values: TagValue[] }>('/api/tags/read', { paths }, csrfToken);
  return body.values;
}

export function writeTag(
  path: string, value: string | number | boolean, csrfToken: string | undefined
): Promise<TagMutationResult> {
  return postJson('/api/tags/write', { path, value }, csrfToken);
}

export async function fetchTagConfig(path: string): Promise<string> {
  const body = await getJson<{ json: string }>(apiUrl(`/api/tags/config?path=${encodeURIComponent(path)}`));
  return body.json;
}

export function createTags(
  basePath: string, json: string, collision: 'Abort' | 'Ignore' | 'Overwrite' | 'MergeOverwrite',
  csrfToken: string | undefined
): Promise<TagMutationResult> {
  return postJson('/api/tags/create', { basePath, json, collision }, csrfToken);
}

export function deleteTags(paths: string[], csrfToken: string | undefined): Promise<TagMutationResult> {
  return postJson('/api/tags/delete', { paths }, csrfToken);
}

/** `[provider]a/b` from a provider and a slash path with no leading slash. */
export function tagPath(provider: string, path: string): string {
  return `[${provider}]${path}`;
}

/**
 * Coerces what was typed into the JSON primitive the tag's data type implies.
 * Returns `undefined` when the text is not valid for the type, so the caller
 * can refuse rather than send a string to an integer tag.
 */
export function parseTagInput(text: string, dataType: string | null): string | number | boolean | undefined {
  const type = (dataType ?? '').toLowerCase();
  const trimmed = text.trim();
  if (type === 'boolean') {
    if (/^(true|1)$/i.test(trimmed)) return true;
    if (/^(false|0)$/i.test(trimmed)) return false;
    return undefined;
  }
  if (type.startsWith('int') || type.startsWith('float')) {
    if (trimmed === '' || !Number.isFinite(Number(trimmed))) return undefined;
    return Number(trimmed);
  }
  return text;
}
