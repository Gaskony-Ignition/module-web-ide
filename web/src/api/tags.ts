/**
 * Typed client for the tag routes behind the Tags side-bar view and tag editor.
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
  /** A UDT instance's definition, relative to the provider's `_types_` folder. */
  typeId?: string | null;
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

/** The platform's `CollisionPolicy`. `Rename` is how a duplicate gets a free name. */
export type TagCollision = 'Abort' | 'Overwrite' | 'Rename' | 'Ignore' | 'MergeOverwrite';

export function createTags(
  basePath: string, json: string, collision: TagCollision,
  csrfToken: string | undefined
): Promise<TagMutationResult> {
  return postJson('/api/tags/create', { basePath, json, collision }, csrfToken);
}

export function deleteTags(paths: string[], csrfToken: string | undefined): Promise<TagMutationResult> {
  return postJson('/api/tags/delete', { paths }, csrfToken);
}

/** One tag's configuration, as the editor opens it. */
export interface TagEditInfo {
  /** JSON of the tag's OWN overrides — what the editor edits and save writes back. */
  local: string;
  /** JSON of the full configuration, inherited and default values included. */
  resolved: string;
  /** The precondition for the next save. */
  signature: string;
  tagType: string;
  /** Property -> value inherited from a UDT definition; `{}` for a standalone tag. */
  inherited?: Record<string, unknown>;
}

export function fetchTagEdit(path: string): Promise<TagEditInfo> {
  return getJson<TagEditInfo>(apiUrl(`/api/tags/edit?path=${encodeURIComponent(path)}`));
}

/** Overwrite a tag's own config. A stale `signature` comes back as a 409 ApiError. */
export function saveTagConfig(
  path: string, json: string, signature: string, csrfToken: string | undefined
): Promise<TagMutationResult & { signature?: string }> {
  return postJson('/api/tags/save', { path, json, signature }, csrfToken);
}

/** One property the gateway's config model says applies to a configuration. */
export interface TagPropertyDescriptor {
  name: string;
  type: string;
  default: unknown;
  allowedValues: unknown[] | null;
  category: string;
  label: string | null;
}

export async function fetchTagModel(
  path: string, json: string, csrfToken: string | undefined
): Promise<TagPropertyDescriptor[]> {
  const body = await postJson<{ properties: TagPropertyDescriptor[] }>(
    '/api/tags/model', { path, json }, csrfToken
  );
  return body.properties;
}

export function renameTag(
  path: string, newName: string, csrfToken: string | undefined
): Promise<TagMutationResult> {
  return postJson('/api/tags/rename', { path, newName }, csrfToken);
}

/** Move, or with `copy` copy, tags into `destination`. Duplicate is a copy into the same parent with `Rename`. */
export function moveTags(
  paths: string[], destination: string, copy: boolean, collision: TagCollision,
  csrfToken: string | undefined
): Promise<TagMutationResult> {
  return postJson('/api/tags/move', { paths, destination, copy, collision }, csrfToken);
}

export function importTags(
  basePath: string, content: string, format: 'json' | 'xml', collision: TagCollision,
  csrfToken: string | undefined
): Promise<TagMutationResult> {
  return postJson('/api/tags/import', { basePath, content, format, collision }, csrfToken);
}

/** The Designer-compatible export JSON for the given tags. */
export async function exportTags(paths: string[], format: 'json' | 'xml' = 'json'): Promise<string> {
  const query = paths.map((path) => `path=${encodeURIComponent(path)}`).join('&');
  const body = await getJson<{ json?: string; xml?: string }>(
    apiUrl(`/api/tags/export?${query}${format === 'xml' ? '&format=xml' : ''}`)
  );
  return (format === 'xml' ? body.xml : body.json) ?? '';
}

/** `Bad_NodeIdUnknown("long diagnostic")` → `Bad_NodeIdUnknown`, so a bad quality fits on its row. */
export function qualityCode(quality: string): string {
  const paren = quality.indexOf('(');
  return paren > 0 ? quality.slice(0, paren) : quality;
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
