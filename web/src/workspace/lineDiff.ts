/**
 * A line-level diff, just good enough to show a user what somebody else changed
 * under them.
 *
 * Deliberately not a Myers diff: the conflict dialog needs "which lines differ",
 * not a minimal edit script, and a dependency-free LCS over the lines that
 * actually differ is a few dozen lines and has no failure mode worse than a
 * slightly noisier diff.
 */

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffRow {
  kind: DiffKind;
  /** Line from the left (mine) side, or null when the row only exists on the right. */
  left: string | null;
  /** Line from the right (theirs) side, or null when the row only exists on the left. */
  right: string | null;
}

/**
 * Above this many differing lines per side the quadratic LCS is abandoned and the
 * two versions are reported as a wholesale replacement. A script that big has
 * diverged past the point where a side-by-side read helps anyway, and an
 * unbounded O(n·m) table on a 20k-line file freezes the tab.
 */
const LCS_LIMIT = 600;

export function diffLines(left: string, right: string): DiffRow[] {
  const a = left.split('\n');
  const b = right.split('\n');

  // Common prefix and suffix first. Real concurrent edits touch a few lines, so
  // this usually reduces the LCS input to almost nothing.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ kind: 'same', left: a[i], right: b[i] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  rows.push(...(midA.length > LCS_LIMIT || midB.length > LCS_LIMIT
    ? wholesale(midA, midB)
    : lcsRows(midA, midB)));

  // The trailing common run is the same length on both sides by construction,
  // so the right index tracks the left one.
  for (let i = endA; i < a.length; i++) {
    rows.push({ kind: 'same', left: a[i], right: b[endB + (i - endA)] });
  }
  return rows;
}

/** Every left line removed, then every right line added. */
function wholesale(a: string[], b: string[]): DiffRow[] {
  return [
    ...a.map((line): DiffRow => ({ kind: 'removed', left: line, right: null })),
    ...b.map((line): DiffRow => ({ kind: 'added', left: null, right: line })),
  ];
}

function lcsRows(a: string[], b: string[]): DiffRow[] {
  // table[i][j] = LCS length of a[i:] and b[j:]
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'same', left: a[i], right: b[j] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: 'removed', left: a[i], right: null });
      i++;
    } else {
      rows.push({ kind: 'added', left: null, right: b[j] });
      j++;
    }
  }
  while (i < a.length) rows.push({ kind: 'removed', left: a[i++], right: null });
  while (j < b.length) rows.push({ kind: 'added', left: null, right: b[j++] });
  return rows;
}

/** True when the two texts differ at all. Byte comparison, never normalised. */
export function textsDiffer(left: string, right: string): boolean {
  return left !== right;
}
