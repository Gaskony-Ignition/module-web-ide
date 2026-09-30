import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ResultsGrid from './ResultsGrid';
import type { DbQueryResultSet } from '../api/dbQueries';

function threeRows(): DbQueryResultSet {
  return {
    columns: [{ name: 'id', type: 'int4' }, { name: 'name', type: 'varchar' }],
    rows: [[3, 'charlie'], [1, 'alpha'], [2, 'bravo']],
    rowCount: 3,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('ResultsGrid — rendering (no paging)', () => {
  it('renders every row with a sticky header, and no pager', async () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    expect(await screen.findByText('id (int4)')).toBeInTheDocument();
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('bravo')).toBeInTheDocument();
    expect(screen.getByText('charlie')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next/i })).not.toBeInTheDocument();
  });

  it('right-aligns a numeric column even when the cell travelled as a string', () => {
    const result: DbQueryResultSet = {
      columns: [{ name: 'big', type: 'int8' }],
      rows: [['9007199254740993']],
      rowCount: 1,
    };
    render(<ResultsGrid result={result} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    expect(screen.getByText('9007199254740993')).toHaveClass('qb-col-numeric');
  });

  it('reports a truncated result rather than hiding how much came back', () => {
    const result: DbQueryResultSet = {
      columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1, truncatedAt: 1000,
    };
    render(<ResultsGrid result={result} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    expect(screen.getByText(/showing the first 1000 rows/)).toBeInTheDocument();
    expect(screen.getByText(/export holds only the returned rows/)).toBeInTheDocument();
  });
});

describe('ResultsGrid — sort', () => {
  it('a column header is a button with aria-sort, cycling ascending -> descending -> off', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const idHeader = screen.getByRole('columnheader', { name: /id/ });
    expect(idHeader).not.toHaveAttribute('aria-sort');

    fireEvent.click(screen.getByRole('button', { name: /id \(int4\)/ }));
    expect(idHeader).toHaveAttribute('aria-sort', 'ascending');
    let cells = screen.getAllByRole('gridcell').filter((c) => c.textContent === '1' || c.textContent === '2' || c.textContent === '3');
    expect(cells.map((c) => c.textContent)).toEqual(['1', '2', '3']);

    fireEvent.click(screen.getByRole('button', { name: /id \(int4\)/ }));
    expect(idHeader).toHaveAttribute('aria-sort', 'descending');
    cells = screen.getAllByRole('gridcell').filter((c) => c.textContent === '1' || c.textContent === '2' || c.textContent === '3');
    expect(cells.map((c) => c.textContent)).toEqual(['3', '2', '1']);

    fireEvent.click(screen.getByRole('button', { name: /id \(int4\)/ }));
    expect(idHeader).not.toHaveAttribute('aria-sort');
  });

  it('nulls sort last regardless of direction', () => {
    const result: DbQueryResultSet = {
      columns: [{ name: 'n', type: 'int4' }],
      rows: [[null], [2], [1]],
      rowCount: 3,
    };
    render(<ResultsGrid result={result} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /n \(int4\)/ }));
    let cells = screen.getAllByRole('gridcell');
    expect(cells.map((c) => c.textContent)).toEqual(['1', '2', 'NULL']);
    fireEvent.click(screen.getByRole('button', { name: /n \(int4\)/ }));
    cells = screen.getAllByRole('gridcell');
    expect(cells.map((c) => c.textContent)).toEqual(['2', '1', 'NULL']);
  });
});

describe('ResultsGrid — filter', () => {
  it('filters rows by substring, case-insensitively, and reports n of m', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter result 1' }), { target: { value: 'ALPHA' } });
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('bravo')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 3 rows')).toBeInTheDocument();
  });
});

describe('ResultsGrid — cell viewer', () => {
  it('clicking a cell opens a panel with the full value and a copy button', async () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByText('alpha'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('alpha', { selector: 'pre' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('pressing Enter on a focused cell opens the same panel', async () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const cell = screen.getByText('alpha');
    cell.focus();
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('only the first cell is a Tab stop — a roving tabindex, not one per cell', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    expect(screen.getByText('3')).toHaveAttribute('tabIndex', '0'); // row 0, col 0
    expect(screen.getByText('alpha')).toHaveAttribute('tabIndex', '-1');
  });

  it('focusing a different cell moves the roving tabindex to it', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const first = screen.getByText('3');
    const alpha = screen.getByText('alpha');
    // .focus(), not fireEvent.focus() — a plain DOM 'focus' event does not
    // bubble, and React's onFocus is delegated on the bubbling 'focusin'.
    alpha.focus();
    expect(alpha).toHaveAttribute('tabIndex', '0');
    expect(first).toHaveAttribute('tabIndex', '-1');
  });

  it('ArrowRight/ArrowDown move focus within the grid, ArrowLeft/ArrowUp move back', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const first = screen.getByText('3'); // row 0, col 0
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toHaveTextContent('charlie'); // row 0, col 1
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveTextContent('alpha'); // row 1, col 1
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' });
    expect(document.activeElement).toHaveTextContent('1'); // row 1, col 0
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });

  it('arrow keys clamp at the edge of the grid rather than wrapping or leaving it', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const first = screen.getByText('3');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(first);
  });

  it('End moves to the last column of the row, Home back to the first', () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const first = screen.getByText('3');
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    expect(document.activeElement).toHaveTextContent('charlie');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(first);
  });

  it('pretty-prints a cell that parses as JSON', async () => {
    const result: DbQueryResultSet = {
      columns: [{ name: 'payload', type: 'jsonb' }],
      rows: [['{"a":1}']],
      rowCount: 1,
    };
    render(<ResultsGrid result={result} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByText('{"a":1}'));
    await screen.findByRole('dialog');
    // getByText normalises whitespace, which would collapse away the very
    // newlines this test exists to prove are there — compare textContent
    // directly instead.
    expect(document.querySelector('.qb-cellviewer-text')?.textContent).toBe('{\n  "a": 1\n}');
  });

  it('says clearly when the server truncated the cell at its 16 KB marker', async () => {
    const truncated = `${'x'.repeat(50)}… (truncated, 20000 chars total)`;
    const result: DbQueryResultSet = {
      columns: [{ name: 'note', type: 'text' }],
      rows: [[truncated]],
      rowCount: 1,
    };
    render(<ResultsGrid result={result} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByText(truncated));
    expect(await screen.findByText(/truncated this value/)).toBeInTheDocument();
    expect(screen.getByText(/20,000 characters long/)).toBeInTheDocument();
  });

  it('Escape closes the panel', async () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByText('alpha'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('opening the panel moves focus into it, onto Close, and closing it returns focus to the opening cell', async () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    const alpha = screen.getByText('alpha');
    alpha.focus();
    fireEvent.click(alpha);
    await screen.findByRole('dialog');
    // aria-label="Close" (header ×) AND the plain-text footer button both
    // have the accessible name "Close" — the FIRST one in document order is
    // the initial-focus target.
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Close' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(alpha);
  });

  it('Tab from the last focusable element cycles back to the first, trapping focus in the dialog', async () => {
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByText('alpha'));
    const dialog = await screen.findByRole('dialog');
    const closeHeaderButton = screen.getAllByRole('button', { name: 'Close' })[0];
    const closeFooterButton = screen.getAllByRole('button', { name: 'Close' })[1];
    closeFooterButton.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(closeHeaderButton);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(closeFooterButton);
  });
});

describe('ResultsGrid — copy and export follow sort/filter', () => {
  it('Copy as TSV copies only the filtered, sorted rows', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onCopy = vi.fn();
    render(<ResultsGrid result={threeRows()} index={0} datasource="MyDb" copied={null} onCopy={onCopy} />);
    fireEvent.click(screen.getByRole('button', { name: /id \(int4\)/ })); // sort ascending
    fireEvent.click(screen.getByRole('button', { name: 'Copy as TSV' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('id\tname\n1\talpha\n2\tbravo\n3\tcharlie'));
    expect(onCopy).toHaveBeenCalledWith(0);
  });

  it('Export CSV triggers a download of the filtered, sorted rows as RFC 4180 CSV', () => {
    const clicks: string[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag);
      if (tag === 'a') {
        el.click = () => clicks.push(el.getAttribute('download') ?? '');
      }
      return el;
    });
    const createObjectURL = vi.fn().mockReturnValue('blob:fake');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });

    render(<ResultsGrid result={threeRows()} index={0} datasource="Postgres_Test" copied={null} onCopy={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    expect(createObjectURL).toHaveBeenCalled();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatch(/^Postgres_Test-\d{8}-\d{4}\.csv$/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
