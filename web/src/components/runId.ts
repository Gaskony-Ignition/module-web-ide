/**
 * Generate a client-side correlation id, including where `crypto.randomUUID`
 * does not exist.
 *
 * **This gateway is commonly served over plain HTTP.** `randomUUID()` is
 * gated on a secure context exactly like `navigator.clipboard` (see
 * `clipboard.ts`, found on the same rig, the same way) — on
 * `http://<gateway>:8088` it is not a function that refuses, it is simply
 * undefined, and calling it directly (rather than through an optional chain)
 * throws instead of silently doing nothing. The unit test for this used to
 * pass regardless, because jsdom exposes `randomUUID` with no such
 * restriction — the one environment that mattered was the one nothing
 * checked, again.
 *
 * `getRandomValues` carries no such restriction, so the fallback builds an
 * RFC 4122 v4 UUID from it by hand. Nothing security-sensitive rides on this
 * id's unpredictability — CSRF is what protects the routes that key on it —
 * so the fallback only needs to be a good-enough correlation key; the v4
 * shape just keeps it looking like every other id in a history list.
 */
export function generateRunId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      /* reported but refused outside a secure context — fall through */
    }
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // Neither API exists at all — an ancient or deliberately locked-down browser.
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
