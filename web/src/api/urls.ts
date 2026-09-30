/**
 * URL resolution for the SPA.
 *
 * The same bundle runs at `/` under `npm run dev` and at `/data/scriptide/` on a
 * gateway, so nothing may hardcode either. Everything here derives from
 * `window.location`.
 */

/** Mount alias — must match ScriptIdePaths.MOUNT_ALIAS. */
export const MOUNT_ALIAS = 'scriptide';

/**
 * Base for API calls, with no trailing slash.
 *
 * On a gateway the SPA is served from `/data/scriptide/...`, so the API base is
 * `/data/scriptide`. In dev the page is at `/`, and the base is empty (the Vite
 * proxy or a live gateway origin handles it).
 */
export function resolveApiBase(pathname: string = window.location.pathname): string {
  const marker = `/data/${MOUNT_ALIAS}`;
  const index = pathname.indexOf(marker);
  return index >= 0 ? pathname.slice(0, index + marker.length) : '';
}

/** Absolute URL for an API route, e.g. apiUrl('/api/auth/session'). */
export function apiUrl(route: string, pathname?: string): string {
  return `${resolveApiBase(pathname)}${route}`;
}

/**
 * WebSocket URL for the LSP/exec socket.
 *
 * Note this is NOT under the API base: servlets registered through
 * WebResourceManager live at `/system/<path>`, outside `/data/<alias>`. Must
 * match ScriptIdePaths.SOCKET_PUBLIC_PATH.
 */
export function resolveWsUrl(location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/system/${MOUNT_ALIAS}`;
}

/** Full-page Gateway login, used when the session probe reports anonymous. */
export function gatewayLoginUrl(location: Location = window.location): string {
  return `${location.origin}/web/login`;
}
