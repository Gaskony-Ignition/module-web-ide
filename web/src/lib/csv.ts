/**
 * RFC 4180 CSV, the way Excel expects it: CRLF line endings and a UTF-8 BOM
 * so it opens as text rather than being guessed at as another codepage.
 */

import { needsFormulaGuard } from './cellText';

/** Prepended so Excel (and anything else sniffing the codepage) reads this as UTF-8. */
export const CSV_BOM = '﻿';

/** A cell value as CSV wants it to arrive — `null` becomes an empty field, never the word "null". */
export type CsvCell = string | number | boolean | null | undefined;

function quoteField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** A string cell that reads as a formula gets the same leading-apostrophe guard as {@link cellToTsv}. */
function cellText(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return typeof value === 'string' && needsFormulaGuard(text) ? `'${text}` : text;
}

/** One row, comma-joined, each field quoted only when it needs to be. */
export function csvRow(cells: CsvCell[]): string {
  return cells.map((cell) => quoteField(cellText(cell))).join(',');
}

/** A full CSV document: the BOM, the header row, every data row, CRLF throughout. */
export function toCsv(headers: string[], rows: CsvCell[][]): string {
  const lines = [csvRow(headers), ...rows.map(csvRow)];
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
