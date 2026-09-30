/**
 * One result set from a Query Browser run — sortable, filterable,
 * drag-resizable columns, a cell viewer, Copy-as-TSV and CSV export (D + F).
 *
 * Sort and filter are held here, not lifted to `QueryBrowser`: they are a
 * property of ONE rendered grid, and lifting them would mean `QueryBrowser`
 * resetting them by hand on every new run instead of it happening for free
 * when this component unmounts with its stale result. `QueryBrowser` keys
 * this component on a MANUAL-run generation counter rather than the result's
 * position, precisely so an auto-refresh rerun of the same SQL does NOT
 * unmount it — sort, filter and column widths must survive a refresh tick;
 * only a genuinely new query should reset them. The cell viewer is the one
 * exception: it closes whenever `result` itself changes (see the effect
 * below), refresh tick or not — the row/column it was showing may no longer
 * mean the same thing once the data underneath it has changed.
 *
 * The header row and the body are each memoised separately from column
 * widths and the cell-viewer's open/closed state — a resize drag or opening
 * a cell must not force React to rebuild every `<tr>` in a 10,000-row grid on
 * every pointer-move; see the module's perf note in QueryBrowser.tsx. Cell
 * focus uses a ROVING tabindex (one cell is `tabIndex=0` at a time, moved
 * with the arrow keys) for the same reason: giving every cell its own
 * `tabIndex={0}` would still work, but only one Tab stop into a 10,000-row
 * grid — landing anywhere else needs the arrow keys either way — and a
 * roving tabindex is the standard grid-navigation pattern screen readers
 * expect. It is kept out of the body's memo deps too: the tabindex/focus
 * bookkeeping is done IMPERATIVELY in the `onFocus` handler below, not via
 * React state, so moving focus around the grid never re-renders it.
 */
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import Resizer from './Resizer';
import { makeDialogKeyDown, useDialogOpener } from './dialogA11y';
import {
  cellToTsv, isNumericType, prettyJsonIfParsable, renderCell, truncatedCharTotal,
} from '../lib/cellText';
import { sortedRowIndices, type SortDirection } from '../lib/sortValues';
import { toCsv } from '../lib/csv';
import { copyText } from './clipboard';
import type { DbQueryResultSet, DbQueryValue } from '../api/dbQueries';
import './ResultsGrid.css';

export interface ResultsGridProps {
  result: DbQueryResultSet;
  index: number;
  /** For the exported filename — `<datasource>-<yyyyMMdd-HHmm>.csv`. */
  datasource: string;
  copied: number | null;
  onCopy: (index: number) => void;
}

const MIN_COLUMN_WIDTH = 60;
const MAX_COLUMN_WIDTH = 2000;
const DEFAULT_COLUMN_WIDTH = 160;

/** `<datasource>-<yyyyMMdd-HHmm>.csv`, from the local clock at export time. */
function csvFilename(datasource: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${datasource || 'query'}-${stamp}.csv`;
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Where the arrow keys (or Home/End) move from `{row, col}` — `null` for any other key. */
function nextCellPosition(
  row: number,
  col: number,
  key: string,
  colCount: number,
  rowCount: number
): { row: number; col: number } | null {
  switch (key) {
    case 'ArrowRight': return { row, col: Math.min(col + 1, colCount - 1) };
    case 'ArrowLeft': return { row, col: Math.max(col - 1, 0) };
    case 'ArrowDown': return { row: Math.min(row + 1, rowCount - 1), col };
    case 'ArrowUp': return { row: Math.max(row - 1, 0), col };
    case 'Home': return { row, col: 0 };
    case 'End': return { row, col: colCount - 1 };
    default: return null;
  }
}

export default function ResultsGrid({
  result, index, datasource, copied, onCopy,
}: ResultsGridProps) {
  const [filterText, setFilterText] = useState('');
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>('ascending');
  const [colWidths, setColWidths] = useState<Record<number, number>>({});
  const [cellViewer, setCellViewer] = useState<{ row: number; col: number } | null>(null);
  const thRefs = useRef<(HTMLTableCellElement | null)[]>([]);
  // The one currently-focused body cell, for the roving tabindex — mutated
  // directly in `onFocus`, never through React state (see the module note).
  const lastFocusedCellRef = useRef<HTMLTableCellElement | null>(null);

  // The cell viewer shows ONE cell's value from THIS result — once the
  // result itself changes (an auto-refresh tick, typically), that cell may
  // no longer exist or may mean something different, so it closes rather
  // than silently show stale data next to a fresh grid.
  useEffect(() => {
    setCellViewer(null);
  }, [result]);

  const needle = filterText.trim().toLowerCase();

  /** Row indices matching the filter — a substring match across every cell's rendered text. */
  const filteredIndices = useMemo(() => {
    const all = result.rows.map((_, i) => i);
    if (!needle) {
      return all;
    }
    return all.filter((rowIndex) =>
      result.rows[rowIndex].some((cell) => renderCell(cell).toLowerCase().includes(needle)));
  }, [result.rows, needle]);

  /** The filtered indices, reordered by the sorted column — Copy/Export both follow this. */
  const visibleIndices = useMemo(() => {
    if (sortColumn === null) {
      return filteredIndices;
    }
    const columnIsNumeric = isNumericType(result.columns[sortColumn]?.type ?? '');
    return sortedRowIndices(filteredIndices, result.rows, sortColumn, sortDirection, columnIsNumeric);
  }, [filteredIndices, sortColumn, sortDirection, result.rows, result.columns]);

  function toggleSort(columnIndex: number) {
    if (sortColumn !== columnIndex) {
      setSortColumn(columnIndex);
      setSortDirection('ascending');
    } else if (sortDirection === 'ascending') {
      setSortDirection('descending');
    } else {
      setSortColumn(null);
    }
  }

  // The last-measured width of a column with no EXPLICIT width yet, kept in
  // a ref (not state) and refreshed in a layout effect — i.e. AFTER the DOM
  // has committed and settled, never read ad hoc during render. Reading
  // `getBoundingClientRect` inside the render itself (the previous code)
  // sees the PREVIOUS commit's layout, which is stale the instant setting
  // any one column's width flips the table from `table-layout: auto` to
  // `fixed` — every other column's natural width changes under fixed layout,
  // and a resize started right after would jump to the old, wrong baseline.
  const measuredWidthsRef = useRef<Record<number, number>>({});
  useLayoutEffect(() => {
    result.columns.forEach((_, columnIndex) => {
      if (colWidths[columnIndex] !== undefined) {
        return;
      }
      const measured = thRefs.current[columnIndex]?.getBoundingClientRect().width;
      if (measured) {
        measuredWidthsRef.current[columnIndex] = measured;
      }
    });
  });

  function beginResize(columnIndex: number): number {
    return colWidths[columnIndex] ?? measuredWidthsRef.current[columnIndex] ?? DEFAULT_COLUMN_WIDTH;
  }

  const tableStyle = Object.keys(colWidths).length > 0 ? { tableLayout: 'fixed' as const } : undefined;

  const headerRow = useMemo(() => (
    <tr>
      {result.columns.map((column, columnIndex) => {
        const sorted = sortColumn === columnIndex;
        return (
          <th
            scope="col"
            key={columnIndex}
            ref={(el) => { thRefs.current[columnIndex] = el; }}
            className={isNumericType(column.type) ? 'qb-col-numeric' : undefined}
            style={colWidths[columnIndex] ? { width: `${colWidths[columnIndex]}px` } : undefined}
            aria-sort={sorted ? sortDirection : undefined}
          >
            <span className="qb-th-inner">
              <button
                type="button"
                className="qb-sort-button"
                onClick={() => toggleSort(columnIndex)}
              >
                {column.name} ({column.type})
                {sorted && (sortDirection === 'ascending' ? ' ▲' : ' ▼')}
              </button>
              <Resizer
                value={beginResize(columnIndex)}
                min={MIN_COLUMN_WIDTH}
                max={MAX_COLUMN_WIDTH}
                side="left"
                label={`Resize the ${column.name} column`}
                onChange={(width) => setColWidths((current) => ({ ...current, [columnIndex]: width }))}
              />
            </span>
          </th>
        );
      })}
    </tr>
    // colWidths IS a dependency here — the header row is a handful of <th>
    // cells, cheap to rebuild on every resize step, and it is the only place
    // a column's width is actually set (table-layout: fixed carries it to
    // every <td> below without them needing their own width style at all).
  ), [result.columns, sortColumn, sortDirection, colWidths]);

  function openCellViewer(row: number, col: number) {
    setCellViewer({ row, col });
  }

  const bodyRows = useMemo(() => (
    visibleIndices.map((rowIndex, rowPos) => (
      <tr key={rowIndex}>
        {result.rows[rowIndex].map((cell, cellIndex) => {
          const numeric = isNumericType(result.columns[cellIndex]?.type ?? '');
          return (
            // The <td> itself is the interactive unit — click or Enter opens
            // the cell viewer — rather than a nested <button> per cell: at
            // the 10,000-row cap that is 50,000 extra DOM nodes for no
            // behaviour a focusable, keydown-handled <td> does not already
            // give (see the module's perf note). Only ONE cell in the whole
            // table is a Tab stop at a time (`rowPos===0 && cellIndex===0`,
            // the grid's initial entry point); `onFocus` moves that
            // bookkeeping to wherever focus actually lands, imperatively,
            // so it never forces this memo to rebuild.
            <td
              key={cellIndex}
              role="gridcell"
              className={numeric ? 'qb-cell qb-col-numeric' : 'qb-cell'}
              tabIndex={rowPos === 0 && cellIndex === 0 ? 0 : -1}
              // The (0,0) cell is the grid's initial Tab stop with nobody
              // ever having focused it — registering it here too means the
              // FIRST focus move away from it still finds something to
              // reset, rather than leaving two cells at tabIndex=0 at once.
              ref={rowPos === 0 && cellIndex === 0
                ? (el) => { lastFocusedCellRef.current = el; }
                : undefined}
              onFocus={(e) => {
                if (lastFocusedCellRef.current && lastFocusedCellRef.current !== e.currentTarget) {
                  lastFocusedCellRef.current.tabIndex = -1;
                }
                e.currentTarget.tabIndex = 0;
                lastFocusedCellRef.current = e.currentTarget;
              }}
              onClick={() => openCellViewer(rowIndex, cellIndex)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  openCellViewer(rowIndex, cellIndex);
                  return;
                }
                const next = nextCellPosition(
                  rowPos, cellIndex, e.key, result.columns.length, visibleIndices.length
                );
                if (!next) return;
                e.preventDefault();
                const tbody = e.currentTarget.closest('tbody');
                const targetRow = tbody?.children[next.row];
                const targetCell = targetRow?.children[next.col];
                if (targetCell instanceof HTMLElement) {
                  targetCell.focus();
                }
              }}
            >
              {renderCell(cell)}
            </td>
          );
        })}
      </tr>
    ))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cellViewer intentionally excluded, see the module comment
  ), [visibleIndices, result.rows, result.columns]);

  function doCopy() {
    const header = result.columns.map((c) => c.name).join('\t');
    const rows = visibleIndices.map((rowIndex) => result.rows[rowIndex].map(cellToTsv).join('\t'));
    void copyText([header, ...rows].join('\n')).then((ok) => {
      if (ok) onCopy(index);
    });
  }

  function doExportCsv() {
    const headers = result.columns.map((c) => c.name);
    const rows = visibleIndices.map((rowIndex) => result.rows[rowIndex].map(renderCellForCsv));
    downloadCsv(csvFilename(datasource), toCsv(headers, rows));
  }

  function renderCellForCsv(value: DbQueryValue): string | null {
    return value === null ? null : String(value);
  }

  const viewerValue = cellViewer ? result.rows[cellViewer.row]?.[cellViewer.col] : undefined;

  return (
    <div className="qb-result">
      <div className="qb-result-head">
        <p className="qb-result-caption muted" role="status">
          {needle
            ? `${filteredIndices.length} of ${result.rowCount} rows`
            : `${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}`}
          {result.truncatedAt !== undefined
            ? ` — showing the first ${result.truncatedAt} rows — the result was larger`
            : ''}
        </p>
        <input
          type="search"
          className="qb-result-filter"
          placeholder="Filter rows"
          aria-label={`Filter result ${index + 1}`}
          spellCheck={false}
          autoComplete="off"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
        />
        {result.truncatedAt !== undefined && (
          <span className="qb-hint muted" title="The export/copy only ever covers what was returned, not the full result">
            (export holds only the returned rows)
          </span>
        )}
        {/* Its own class, never .qb-copy — a live suite selects on class
            names, and that one already means "Copy as TSV" (F). */}
        <button type="button" className="qb-export-csv" onClick={doExportCsv}>
          Export CSV
        </button>
        <button type="button" className="qb-copy" onClick={doCopy}>
          {copied === index ? 'Copied' : 'Copy as TSV'}
        </button>
      </div>
      <div className="qb-scroll">
        <table className="qb-table" role="grid" aria-label={`Result ${index + 1}`} style={tableStyle}>
          <thead>{headerRow}</thead>
          <tbody>{bodyRows}</tbody>
        </table>
      </div>
      {cellViewer && (
        <CellViewer
          value={viewerValue ?? null}
          columnName={result.columns[cellViewer.col]?.name ?? ''}
          onClose={() => setCellViewer(null)}
        />
      )}
    </div>
  );
}

/** The full value of one cell — pretty-printed JSON when it parses, with a copy button. */
function CellViewer({
  value, columnName, onClose,
}: {
  value: DbQueryValue;
  columnName: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const pretty = prettyJsonIfParsable(value);
  const text = pretty ?? renderCell(value);
  const truncatedAt = truncatedCharTotal(value);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useDialogOpener(closeButtonRef, dialogRef);

  return (
    <div className="qb-cellviewer-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="qb-cellviewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="qb-cellviewer-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={makeDialogKeyDown(dialogRef, onClose)}
      >
        <div className="qb-cellviewer-head">
          <h2 id="qb-cellviewer-title">{columnName || 'Cell value'}</h2>
          <button type="button" ref={closeButtonRef} onClick={onClose} aria-label="Close">×</button>
        </div>
        {truncatedAt !== null && (
          <p className="qb-cellviewer-note" role="status">
            The gateway truncated this value at its 16 KB per-cell limit — the real value is{' '}
            {truncatedAt.toLocaleString()} characters long, and only what is shown here reached the browser.
          </p>
        )}
        <pre className="qb-cellviewer-text">{text}</pre>
        <div className="qb-cellviewer-actions">
          <button
            type="button"
            className="primary"
            onClick={() => {
              void copyText(text).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
