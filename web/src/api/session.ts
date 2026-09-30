import { apiUrl } from './urls';

/** Shape of GET /api/auth/session. Mirrors AuthRouteHandler. */
export interface SessionInfo {
  authenticated: boolean;
  username?: string;
  userId?: string;
  roles?: string[];
  securityZones?: string[];
  /** UI convenience only — the server re-checks on every write. */
  writable: boolean;
  /** UI convenience only — the server re-checks on every execution. Folds both `writable` and `executionEnabled`. */
  canExecute: boolean;
  /** Whether execution is switched on gateway-wide (ExecPolicy), independent of this user's role. */
  executionEnabled?: boolean;
  csrfToken?: string;
}

export const ANONYMOUS: SessionInfo = {
  authenticated: false,
  writable: false,
  canExecute: false,
  executionEnabled: false,
};

/**
 * Probe the session.
 *
 * The route is mounted open and answers 200 for anonymous callers, so a non-OK
 * response here means the backend is genuinely unreachable — not that the user
 * is signed out. Keeping those two apart is the whole point of the probe.
 */
export async function fetchSession(): Promise<SessionInfo> {
  const response = await fetch(apiUrl('/api/auth/session'), {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Session probe failed: HTTP ${response.status}`);
  }
  return (await response.json()) as SessionInfo;
}
