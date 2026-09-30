/**
 * Cell text shared between the results grid and the cell-viewer panel —
 * rendering, TSV escaping, and recognising the server's own truncation
 * marker (`DbQueryRouteHandler.boundText`) so the UI can say so plainly
 * rather than showing a value that quietly stops short of the real one.
 */
import type { DbQueryValue } from '../api/dbQueries';

/** `null` is a real SQL value and says so — an empty cell would read as "". */
export function renderCell(value: DbQueryValue): string {
  return value === null ? 'NULL' : String(value);
}

/** A leading character Excel/Sheets/LibreOffice reads as a formula marker. */
const FORMULA_TRIGGER_PATTERN = /^[=+\-@\t\r]/;
/** A plain number, with or without a leading sign — never a formula. */
const PURELY_NUMERIC_PATTERN = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Whether a string cell's text would make Excel/Sheets/LibreOffice read it as
 * a formula when the exported CSV or copied TSV is opened — a leading `=`,
 * `+`, `-`, `@`, tab or CR, per OWASP's CSV-injection guidance (GitHub uses
 * the same fix: a leading apostrophe forces the cell back to text). A
 * leading sign on an otherwise-plain number (`-42`, `+3.5`) is a real value,
 * not a formula, so it's excluded.
 */
export function needsFormulaGuard(text: string): boolean {
  return FORMULA_TRIGGER_PATTERN.test(text) && !PURELY_NUMERIC_PATTERN.test(text.trim());
}

/** Blank, not the on-screen "NULL": a spreadsheet cell should be empty for a SQL NULL. */
export function cellToTsv(value: DbQueryValue): string {
  if (value === null) return '';
  let text = String(value);
  if (typeof value === 'string' && needsFormulaGuard(text)) {
    text = `'${text}`;
  }
  if (text.includes('\t') || text.includes('\n') || text.includes('\r') || text.includes('"')) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Vendor type names that should right-align, however the VALUE was sent (a big number
    or NaN/Infinity travels as a JSON string — see DbQueryRouteHandler's cell coercion). */
const NUMERIC_TYPE_PATTERN = /int|numeric|decimal|float|double|real|serial|money/i;

export function isNumericType(type: string): boolean {
  return NUMERIC_TYPE_PATTERN.test(type);
}

/** `DbQueryRouteHandler.boundText`'s marker, verbatim: `"… (truncated, N chars total)"`. */
const TRUNCATION_MARKER = /… \(truncated, (\d+) chars total\)$/;

/** The value's real total length if the server's 16 KB per-cell cap cut it short, else `null`. */
export function truncatedCharTotal(value: DbQueryValue): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = TRUNCATION_MARKER.exec(value);
  return match ? Number(match[1]) : null;
}

/** The value, pretty-printed, when it parses whole as JSON — otherwise `null`. */
export function prettyJsonIfParsable(value: DbQueryValue): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}
