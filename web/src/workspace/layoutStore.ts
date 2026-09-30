/**
 * Remembered layout sizes and choices, per viewer.
 *
 * Every read and write is wrapped: `localStorage` throws outright in a private
 * window, under a thumbnail capture, and in a browser set to block site data,
 * and a layout preference is never worth taking the page down for. A missing
 * value is not an error either — it is a viewer who has not chosen yet, which
 * is what the fallback is for.
 *
 * Lifted out of `Workspace.tsx` at 1.19.0 because the Script Console needs the
 * same store and is rendered in TWO places: inside the workspace, and alone in
 * the popped-out tab, where no workspace exists to inherit helpers from. A
 * second copy would have drifted on the first key either side renamed.
 */

const PREFIX = 'scriptide.';

/** A remembered pixel size, or `fallback` if there is none worth trusting. */
export function storedWidth(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}width.${key}`);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export function rememberWidth(key: string, value: number) {
  try {
    window.localStorage.setItem(`${PREFIX}width.${key}`, String(Math.round(value)));
  } catch {
    /* not remembered; the session still works */
  }
}

/** A remembered panel height, with the same caution as widths. */
export function storedHeight(key: string, fallback: number): number {
  return storedWidth(key, fallback);
}

/**
 * A remembered choice from a closed set — an orientation, a mode, a tab.
 *
 * `allowed` is checked rather than trusted: the stored string is whatever was
 * written by a BUILD THAT MAY NO LONGER EXIST, and a value this version has
 * never heard of must read as "not chosen" rather than reach the DOM as a class
 * name or a flex direction nothing styles.
 */
export function storedChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  try {
    const raw = window.localStorage.getItem(`${PREFIX}choice.${key}`);
    return allowed.includes(raw as T) ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

export function rememberChoice(key: string, value: string) {
  try {
    window.localStorage.setItem(`${PREFIX}choice.${key}`, value);
  } catch {
    /* not remembered; the session still works */
  }
}
