import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/scripts')>()),
  fetchRuns: vi.fn(),
}));

import { fetchRuns, type PastRun } from '../api/scripts';
import RunHistoryDialog, { durationLabel, runMatches } from './RunHistoryDialog';

const runsApi = vi.mocked(fetchRuns);

/**
 * The row's own first-line span.
 *
 * A run's source is on screen TWICE by design — the row's summary and the
 * detail pane below it — so an unscoped query for it is ambiguous rather than
 * absent, and reads as "the list did not render" when the list is fine.
 */
const ROW = '.runhist-first';

function run(over: Partial<PastRun> = {}): PastRun {
  return {
    id: 'r1',
    at: 1_700_000_000_000,
    project: 'P',
    source: 'print 1',
    output: '1',
    ok: true,
    outputTruncated: false,
    durationMs: 0,
    ...over,
  };
}

describe('durationLabel', () => {
  it('says nothing at all for a record kept before durations were', () => {
    // The distinction the whole field turns on: 0 is "not known", and a run
    // labelled "0 ms" is a claim about speed nobody measured.
    expect(durationLabel(0)).toBe('');
    expect(durationLabel(-5)).toBe('');
  });

  it('picks the coarsest unit that still says something', () => {
    expect(durationLabel(240)).toBe('240 ms');
    expect(durationLabel(1500)).toBe('1.5 s');
    expect(durationLabel(125_000)).toBe('2m 5s');
  });
});

describe('runMatches', () => {
  it('matches the OUTPUT, not only the source', () => {
    // "which run printed that error" is not answerable from the code, and it is
    // half the reason anyone opens this dialog.
    expect(runMatches(run({ source: 'x = 1', output: 'IntegrityError' }), 'integrity')).toBe(true);
  });

  it('matches the error text and the project', () => {
    expect(runMatches(run({ error: 'Stopped' }), 'stopped')).toBe(true);
    expect(runMatches(run({ project: 'Water' }), 'wat')).toBe(true);
  });

  it('treats regex metacharacters as literal text', () => {
    // A stray bracket in a search box must narrow the list, never throw.
    expect(runMatches(run({ source: 'rows[0]' }), '[0]')).toBe(true);
    expect(() => runMatches(run(), '(')).not.toThrow();
  });

  it('matches everything when nothing is typed', () => {
    expect(runMatches(run(), '   ')).toBe(true);
  });
});

describe('RunHistoryDialog', () => {
  beforeEach(() => {
    runsApi.mockReset();
  });

  it('shows a run duration beside its time, and shows none where there is none', async () => {
    runsApi.mockResolvedValue({
      runs: [
        run({ id: 'a', source: 'slow()', durationMs: 2400 }),
        run({ id: 'b', source: 'old()', durationMs: 0 }),
      ],
      maxRuns: 50,
    });
    render(<RunHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    const row = (await screen.findByText('slow()', { selector: ROW })).closest('button');
    expect(row?.textContent).toContain('2.4 s');
    const older = screen.getByText('old()', { selector: ROW }).closest('button');
    expect(older?.textContent).not.toMatch(/\bms\b|\bs\b·/);
  });

  it('filters the list and says how many of how many are left', async () => {
    runsApi.mockResolvedValue({
      runs: [
        run({ id: 'a', source: 'query_tanks()' }),
        run({ id: 'b', source: 'print 2' }),
      ],
      maxRuns: 50,
    });
    render(<RunHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    await screen.findByText('query_tanks()', { selector: ROW });
    fireEvent.change(screen.getByLabelText('Search the run history'), {
      target: { value: 'tanks' },
    });
    expect(screen.queryByText('print 2', { selector: ROW })).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('moves the selection to the first match rather than showing a hidden run', async () => {
    // The defect this catches: filtering away the selected run leaves its source
    // in the right-hand pane beside a list that no longer contains it, so
    // "Load into console" loads something the user cannot see.
    runsApi.mockResolvedValue({
      runs: [
        run({ id: 'a', source: 'newest()' }),
        run({ id: 'b', source: 'wanted()' }),
      ],
      maxRuns: 50,
    });
    const onLoad = vi.fn();
    render(<RunHistoryDialog onClose={vi.fn()} onLoad={onLoad} />);
    await screen.findByText('newest()', { selector: ROW });
    fireEvent.change(screen.getByLabelText('Search the run history'), {
      target: { value: 'wanted' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load into console' }));
    expect(onLoad).toHaveBeenCalledWith('wanted()');
  });

  it('says the search found nothing, rather than looking empty', async () => {
    runsApi.mockResolvedValue({ runs: [run({ source: 'print 1' })], maxRuns: 50 });
    render(<RunHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    await screen.findByText('print 1', { selector: ROW });
    fireEvent.change(screen.getByLabelText('Search the run history'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(/No run here matches/)).toBeInTheDocument();
  });
});
