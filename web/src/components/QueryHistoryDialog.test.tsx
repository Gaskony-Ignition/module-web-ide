import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/dbQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/dbQueries')>()),
  fetchDbQueryHistory: vi.fn(),
}));

import { fetchDbQueryHistory, type DbQueryHistoryEntry } from '../api/dbQueries';
import QueryHistoryDialog, {
  durationLabel, firstLine, queryMatches,
} from './QueryHistoryDialog';

const historyApi = vi.mocked(fetchDbQueryHistory);

const ROW = '.qhist-first';

function entry(over: Partial<DbQueryHistoryEntry> = {}): DbQueryHistoryEntry {
  return {
    id: 'h1',
    at: 1_700_000_000_000,
    datasource: 'MyDb',
    sql: 'SELECT 1',
    ok: true,
    summary: '1 row',
    durationMs: 0,
    ...over,
  };
}

beforeEach(() => {
  historyApi.mockReset();
});

describe('durationLabel', () => {
  it('says nothing for a duration nobody measured', () => {
    expect(durationLabel(0)).toBe('');
    expect(durationLabel(-1)).toBe('');
  });

  it('picks the coarsest unit that still says something', () => {
    expect(durationLabel(240)).toBe('240 ms');
    expect(durationLabel(1500)).toBe('1.5 s');
  });
});

describe('firstLine', () => {
  it('takes the first non-blank line', () => {
    expect(firstLine('\n\nSELECT 1\nFROM orders')).toBe('SELECT 1');
  });
});

describe('queryMatches', () => {
  it('matches the SQL, the datasource, the summary and the error', () => {
    expect(queryMatches(entry({ sql: 'SELECT * FROM orders' }), 'orders')).toBe(true);
    expect(queryMatches(entry({ datasource: 'Water' }), 'wat')).toBe(true);
    expect(queryMatches(entry({ summary: '3 affected' }), 'affected')).toBe(true);
    expect(queryMatches(entry({ error: 'no such table' }), 'no such')).toBe(true);
  });

  it('matches everything when nothing is typed', () => {
    expect(queryMatches(entry(), '   ')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(queryMatches(entry({ sql: 'SELECT * FROM Orders' }), 'orders')).toBe(true);
  });
});

describe('QueryHistoryDialog', () => {
  it('lists a run by when it ran, its datasource and its first line', async () => {
    historyApi.mockResolvedValue({
      runs: [entry({ sql: 'SELECT * FROM orders', datasource: 'MyDb' })],
      maxRuns: 50,
    });
    render(<QueryHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    const row = await screen.findByText('SELECT * FROM orders', { selector: ROW });
    expect(row.closest('button')?.textContent).toContain('MyDb');
  });

  it('filters the list and says how many of how many are left', async () => {
    historyApi.mockResolvedValue({
      runs: [
        entry({ id: 'a', sql: 'SELECT * FROM tanks' }),
        entry({ id: 'b', sql: 'SELECT 1' }),
      ],
      maxRuns: 50,
    });
    render(<QueryHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    await screen.findByText('SELECT * FROM tanks', { selector: ROW });
    fireEvent.change(screen.getByLabelText('Search the query history'), {
      target: { value: 'tanks' },
    });
    expect(screen.queryByText('SELECT 1', { selector: ROW })).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('loads the datasource and SQL, then closes, on Load — never running it', async () => {
    historyApi.mockResolvedValue({
      runs: [entry({ datasource: 'Postgres_Test', sql: 'DELETE FROM orders' })],
      maxRuns: 50,
    });
    const onLoad = vi.fn();
    const onClose = vi.fn();
    render(<QueryHistoryDialog onClose={onClose} onLoad={onLoad} />);
    await screen.findByText('DELETE FROM orders', { selector: ROW });
    fireEvent.click(screen.getByRole('button', { name: 'Load into editor' }));
    expect(onLoad).toHaveBeenCalledWith('Postgres_Test', 'DELETE FROM orders');
    expect(onClose).toHaveBeenCalled();
  });

  it('says the search found nothing, rather than looking empty', async () => {
    historyApi.mockResolvedValue({ runs: [entry({ sql: 'SELECT 1' })], maxRuns: 50 });
    render(<QueryHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    await screen.findByText('SELECT 1', { selector: ROW });
    fireEvent.change(screen.getByLabelText('Search the query history'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(/No run here matches/)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    historyApi.mockResolvedValue({ runs: [entry()], maxRuns: 50 });
    const onClose = vi.fn();
    render(<QueryHistoryDialog onClose={onClose} onLoad={vi.fn()} />);
    await screen.findByRole('dialog');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('returns focus to whatever opened it, once it closes', async () => {
    historyApi.mockResolvedValue({ runs: [entry()], maxRuns: 50 });
    const opener = document.createElement('button');
    opener.textContent = 'History';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(<QueryHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    await screen.findByRole('dialog');
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('traps Tab inside the dialog — Tab from the last focusable wraps to the first', async () => {
    historyApi.mockResolvedValue({ runs: [entry()], maxRuns: 50 });
    render(<QueryHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    // Wait for the run to load and become selected — "Load into editor" is
    // disabled until then, and Tab must skip a disabled button anyway.
    await screen.findByText('SELECT 1', { selector: ROW });
    // The header's "x" and the footer's "Close" are BOTH named "Close" —
    // scoped by class rather than an ambiguous role/name lookup.
    const headerClose = dialog.querySelector('.qhist-close') as HTMLElement;
    const loadButton = screen.getByRole('button', { name: 'Load into editor' });
    loadButton.focus();
    expect(document.activeElement).toBe(loadButton);

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(headerClose);
  });

  it('traps Shift+Tab from the first focusable back to the last', async () => {
    historyApi.mockResolvedValue({ runs: [entry()], maxRuns: 50 });
    render(<QueryHistoryDialog onClose={vi.fn()} onLoad={vi.fn()} />);
    const dialog = await screen.findByRole('dialog');
    await screen.findByText('SELECT 1', { selector: ROW });
    const headerClose = dialog.querySelector('.qhist-close') as HTMLElement;
    const loadButton = screen.getByRole('button', { name: 'Load into editor' });
    headerClose.focus();
    expect(document.activeElement).toBe(headerClose);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(loadButton);
  });
});
