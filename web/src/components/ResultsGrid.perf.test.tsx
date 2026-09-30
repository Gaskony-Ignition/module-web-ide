/**
 * A rough render-time measurement for the 10,000-row cap (D) — "measure
 * first, then virtualise or not." jsdom has no real layout/paint, so this is
 * a proxy for DOM-construction cost only, not a real browser's frame time;
 * the number is reported in the release write-up alongside a real-browser
 * measurement taken live against the test gateway.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ResultsGrid from './ResultsGrid';
import type { DbQueryResultSet } from '../api/dbQueries';

function bigResult(rowCount: number): DbQueryResultSet {
  const columns = ['id', 'name', 'amount', 'created_at', 'note'].map((name) => ({ name, type: 'varchar' }));
  const rows = Array.from({ length: rowCount }, (_, i) => [
    i, `row-${i}`, (i * 1.5).toFixed(2), '2026-09-29T00:00:00Z', `note for row ${i}`,
  ]);
  return { columns, rows, rowCount };
}

describe('ResultsGrid perf (informational)', () => {
  it('measures the 10,000-row cap render in jsdom — a DOM-construction proxy only, not a real frame time', () => {
    const result = bigResult(10_000);
    const start = performance.now();
    render(<ResultsGrid result={result} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const elapsed = performance.now() - start;
    // eslint-disable-next-line no-console -- deliberately reported in the release write-up
    console.log(`ResultsGrid: initial render of 10,000 rows x 5 columns took ${elapsed.toFixed(0)} ms (jsdom)`);
    // jsdom has no real layout/paint and is known to be far slower than a
    // browser at raw DOM-node construction; this only guards against a
    // pathological regression (an accidental O(n^2) path), not real-world
    // speed — the number that decides virtualisation comes from the live
    // Playwright check against a real browser instead.
    expect(elapsed).toBeLessThan(30_000);
  });
});
