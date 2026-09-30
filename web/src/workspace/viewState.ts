/**
 * UI state that has to outlive a component being unmounted.
 *
 * The activity-bar views are a `? :` chain in `Workspace.tsx`, so switching from
 * Scripting to Web Dev does not hide the script tree — it REMOVES it. React
 * discards the component instance, `useState` goes with it, and every folder is
 * collapsed again when you come back (Nigel, 03/09/2026: "its annoying how
 * everytime I shift between a section it resets to default").
 *
 * Two ways to fix that. Keep all three trees mounted and toggle `hidden`, which
 * is what the editor already does for exactly this reason — but that renders
 * three trees for every project on every keystroke. Or move the state somewhere
 * a component's lifetime cannot reach, which is this file.
 *
 * `sessionStorage`, not `localStorage`: "during my session" is the ask, and a
 * tree that is still exactly as you left it three weeks later is a different
 * feature with different surprises. It is wrapped because storage THROWS
 * outright in some embedded contexts rather than returning null — the same
 * guard `index.html` already puts around the theme read.
 */
import { useCallback, useState } from 'react';

const PREFIX = 'scriptide.view.';

/** In-memory fallback, so the state still survives an unmount with no storage. */
const memory = new Map<string, string[]>();

function load(key: string): string[] {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    /* storage unavailable or holding something that is not ours — fall through */
  }
  return memory.get(key) ?? [];
}

function save(key: string, values: string[]): void {
  memory.set(key, values);
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(values));
  } catch {
    /* the in-memory copy above is still correct for this page load */
  }
}

/**
 * A `Set<string>` that survives its component being unmounted and remounted.
 *
 * Same shape as `useState<Set<string>>` — including the updater form, which the
 * trees rely on — so a caller only changes which hook it calls.
 */
export function useStickySet(
  key: string
): [Set<string>, (next: Set<string> | ((current: Set<string>) => Set<string>)) => void] {
  const [value, setValue] = useState<Set<string>>(() => new Set(load(key)));

  const update = useCallback(
    (next: Set<string> | ((current: Set<string>) => Set<string>)) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? next(current) : next;
        save(key, [...resolved]);
        return resolved;
      });
    },
    [key]
  );

  return [value, update];
}

/** Drop everything remembered. Exported for tests, which must not leak state. */
export function clearStickyState(): void {
  memory.clear();
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const name = window.sessionStorage.key(i);
      if (name?.startsWith(PREFIX)) doomed.push(name);
    }
    for (const name of doomed) window.sessionStorage.removeItem(name);
  } catch {
    /* nothing to clear */
  }
}
