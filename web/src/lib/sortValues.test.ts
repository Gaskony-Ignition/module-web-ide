import { describe, expect, it } from 'vitest';
import { compareForSort, sortedRowIndices } from './sortValues';

describe('compareForSort', () => {
  it('compares plain numbers numerically, not lexically, on a numeric column', () => {
    expect(compareForSort(9, 80, 'ascending', true)).toBeLessThan(0);
  });

  it('compares number-shaped strings numerically, the way a bigint or precise decimal travels', () => {
    expect(compareForSort('9', '80', 'ascending', true)).toBeLessThan(0);
  });

  it('keeps exact ordering for integers beyond JS safe-integer precision', () => {
    const a = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    const b = '9007199254740995'; // MAX_SAFE_INTEGER + 4 — both round to the SAME float64
    expect(compareForSort(a, b, 'ascending', true)).toBeLessThan(0);
    expect(compareForSort(b, a, 'ascending', true)).toBeGreaterThan(0);
  });

  it('keeps exact ordering for decimals a float64 cannot tell apart', () => {
    // Both round to the SAME float64 (0.1 to double precision) — a compare
    // that went through Number() would call these equal.
    const a = '0.10000000000000000000001';
    const b = '0.10000000000000000000002';
    expect(compareForSort(a, b, 'ascending', true)).toBeLessThan(0);
    expect(compareForSort(b, a, 'ascending', true)).toBeGreaterThan(0);
  });

  it('falls back to numeric compare for a decimal string', () => {
    expect(compareForSort('3.5', '10.2', 'ascending', true)).toBeLessThan(0);
  });

  it('a negative decimal compares below a positive one', () => {
    expect(compareForSort('-1.5', '1.5', 'ascending', true)).toBeLessThan(0);
    expect(compareForSort('-1.5', '-1.2', 'ascending', true)).toBeLessThan(0);
  });

  it('handles exponential notation exactly, without going through a float', () => {
    expect(compareForSort('1.5e3', '2000', 'ascending', true)).toBeLessThan(0); // 1500 < 2000
    expect(compareForSort('1e-2', '0.02', 'ascending', true)).toBeLessThan(0); // 0.01 < 0.02
  });

  it('an ISO date string sorts chronologically via plain lexical order on a non-numeric column', () => {
    expect(compareForSort('2026-01-01T00:00:00Z', '2026-09-29T00:00:00Z', 'ascending', false)).toBeLessThan(0);
  });

  it('descending reverses a real comparison', () => {
    expect(compareForSort(1, 2, 'descending', true)).toBeGreaterThan(0);
  });

  it('null sorts last ascending', () => {
    expect(compareForSort(null, 1, 'ascending', true)).toBeGreaterThan(0);
    expect(compareForSort(1, null, 'ascending', true)).toBeLessThan(0);
  });

  it('null STILL sorts last descending — flipping the comparator must not move it to the front', () => {
    expect(compareForSort(null, 1, 'descending', true)).toBeGreaterThan(0);
    expect(compareForSort(1, null, 'descending', true)).toBeLessThan(0);
  });

  it('two nulls are equal', () => {
    expect(compareForSort(null, null, 'ascending', true)).toBe(0);
  });

  it('non-numeric text falls back to locale string comparison', () => {
    expect(compareForSort('apple', 'banana', 'ascending', false)).toBeLessThan(0);
  });

  it('a number-shaped value in a TEXT column sorts lexically, not numerically', () => {
    // "5" and "02134" — a numeric read would put "5" after "02134"
    // (5 > 2134 is false, so "02134" < "5" numerically); lexically "02134"
    // sorts before "5" too here, so use a pair that actually disagrees:
    // "10" vs "9" — numerically 9 < 10, lexically "10" < "9".
    expect(compareForSort('10', '9', 'ascending', false)).toBeLessThan(0);
    expect(compareForSort('10', '9', 'ascending', true)).toBeGreaterThan(0);
  });

  it('the same column-type decision applies consistently regardless of what else is in the column '
    + '(a total order, not a per-cell guess)', () => {
    const direction = 'ascending' as const;
    // Every pairwise comparison among these three, on a TEXT column, must be
    // consistent with plain string order — no pair flips because of what it
    // happens to look like.
    const values = ['02134', '5', '100'];
    const sorted = values.slice().sort((a, b) => compareForSort(a, b, direction, false));
    expect(sorted).toEqual([...values].sort((a, b) => a.localeCompare(b)));
  });
});

describe('sortedRowIndices', () => {
  it('orders rows by the given column, ascending, on a numeric column', () => {
    const rows = [[3], [1], [2]];
    expect(sortedRowIndices([0, 1, 2], rows, 0, 'ascending', true)).toEqual([1, 2, 0]);
  });

  it('nulls sort last regardless of direction', () => {
    const rows = [[null], [2], [1]];
    expect(sortedRowIndices([0, 1, 2], rows, 0, 'ascending', true)).toEqual([2, 1, 0]);
    expect(sortedRowIndices([0, 1, 2], rows, 0, 'descending', true)).toEqual([1, 2, 0]);
  });

  it('is stable for equal values', () => {
    const rows = [['a', 1], ['a', 2], ['a', 3]];
    expect(sortedRowIndices([0, 1, 2], rows, 0, 'ascending', false)).toEqual([0, 1, 2]);
  });

  it('only sorts the given subset of row indices, leaving a filtered-out row untouched', () => {
    const rows = [[3], [1], [2]];
    // Row 1 is excluded, as if it had been filtered out.
    expect(sortedRowIndices([0, 2], rows, 0, 'ascending', true)).toEqual([2, 0]);
  });
});
