/**
 * Client for a Web Dev endpoint's per-method settings.
 *
 * A Web Dev resource has NO editable `resource.json` attributes — measured on a
 * real gateway. Everything the Designer shows for an endpoint lives inside a
 * `config.json` DATA FILE beside the handler scripts, which is why this is a
 * separate route and a separate client rather than more of the attributes API.
 */
import { apiUrl } from './urls';

export const WEBDEV_METHODS = [
  'doGet', 'doPost', 'doPut', 'doDelete', 'doHead', 'doOptions', 'doTrace', 'doPatch',
] as const;

export type WebDevMethod = (typeof WEBDEV_METHODS)[number];

/** One method's settings, exactly as the file stores them. */
export interface MethodSettings {
  enabled: boolean;
  'max-retry-attempts': number;
  'require-auth': boolean;
  'require-https': boolean;
  'required-roles': string;
  'user-source': string;
}

export interface WebDevConfig {
  path: string;
  signature: string;
  /** Keyed by method name. A method absent from the file has never been set. */
  config: Partial<Record<WebDevMethod, Partial<MethodSettings>>>;
  methods: string[];
  settings: string[];
}

/** What the Designer writes for a method nobody has configured. */
export const DEFAULT_METHOD_SETTINGS: MethodSettings = {
  enabled: false,
  'max-retry-attempts': 3,
  'require-auth': false,
  'require-https': false,
  'required-roles': '',
  'user-source': '',
};

const CSRF_HEADER = 'X-CSRF-Token';

function configUrl(path: string, project: string): string {
  const query = new URLSearchParams({ project });
  return `${apiUrl(`/api/webdev/config/${encodeURIComponent(path)}`)}?${query.toString()}`;
}

export async function readWebDevConfig(project: string, path: string): Promise<WebDevConfig> {
  const response = await fetch(configUrl(path, project), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as WebDevConfig;
}

/**
 * Write ONE method's settings.
 *
 * Per method rather than the whole document on purpose: the server does a
 * read-modify-write and preserves any key it does not know, so a future Ignition
 * field survives an older build of this module rather than being deleted by a
 * wholesale overwrite.
 */
export async function saveWebDevConfig(request: {
  project: string;
  path: string;
  method: WebDevMethod;
  settings: Partial<MethodSettings>;
  baseSignature: string;
  csrfToken?: string;
}): Promise<{ ok: true; signature?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'If-Match': request.baseSignature,
  };
  if (request.csrfToken) {
    headers[CSRF_HEADER] = request.csrfToken;
  }
  const response = await fetch(configUrl(request.path, request.project), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      method: request.method,
      settings: request.settings,
      baseSignature: request.baseSignature,
    }),
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(await response.text()) as { error?: string };
      message = parsed.error ?? message;
    } catch {
      /* status alone is the message */
    }
    throw new Error(message);
  }
  return (await response.json()) as { ok: true; signature?: string };
}
