/**
 * Compare two result-grid cells for the sortable column header (D).
 *
 * Numeric vs text is decided ONCE per column, from its declared JDBC type
 * (`isNumericType` in `./cellText` — the same rule the grid already uses to
 * right-align a column), never sniffed per cell. Two cells that merely LOOK
 * numeric in a TEXT column (a zip code "02134" next to a code "5") must sort
 * as text, the same way every other cell in that column does — deciding it
 * per cell instead is how a comparator stops being a total order: whether
 * "5" sorts before or after "02134" would depend on what else happens to sit
 * in the column that render, not on a fixed rule for the column.
 *
 * A numeric column's cell may still arrive as a NUMBER-SHAPED STRING — the
 * server sends a bigint past JS's safe-integer ceiling, or a `BigDecimal` a
 * `double` cannot hold exactly, as a string for exactly this reason (see
 * `DbQueryRouteHandler`'s cell-coercion Javadoc). An integral value compares
 * via `BigInt`. A decimal one compares digit-by-digit as a STRING — never
 * through `Number`, which rounds to float64 and can call two different
 * decimals equal.
 *
 * A date/timestamp cell is already an ISO-8601 string, whose lexical order is
 * its chronological order — it sorts correctly as an ordinary text column,
 * no separate date path needed.
 *
 * Nulls sort last, in EITHER direction: flipping the whole comparator for a
 * descending sort would otherwise put them first.
 */
import type { DbQueryValue } from '../api/dbQueries';

export type SortDirection = 'ascending' | 'descending';

const NUMERIC_STRING = /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/;
const INTEGER_STRING = /^\s*-?\d+\s*$/;
const EXPONENT_FORM = /^(\d+)(?:\.(\d+))?[eE]([-+]?\d+)$/;
const PLAIN_FORM = /^(\d+)(?:\.(\d+))?$/;

function asNumericString(value: DbQueryValue): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) {
    return value.trim();
  }
  return null;
}

/** A numeric string's sign, integer digits and fractional digits, any exponent normalised away. */
function toPlainDecimalParts(numeric: string): { negative: boolean; intPart: string; fracPart: string } {
  const negative = numeric.startsWith('-');
  const unsigned = negative || numeric.startsWith('+') ? numeric.slice(1) : numeric;
  const exponential = EXPONENT_FORM.exec(unsigned);
  if (exponential) {
    const [, digitsInt, digitsFrac = '', expStr] = exponential;
    const exp = Number(expStr);
    const digits = digitsInt + digitsFrac;
    const pointPos = digitsInt.length + exp;
    let intPart: string;
    let fracPart: string;
    if (pointPos <= 0) {
      intPart = '0';
      fracPart = '0'.repeat(-pointPos) + digits;
    } else if (pointPos >= digits.length) {
      intPart = digits + '0'.repeat(pointPos - digits.length);
      fracPart = '';
    } else {
      intPart = digits.slice(0, pointPos);
      fracPart = digits.slice(pointPos);
    }
    return { negative, intPart: intPart.replace(/^0+(?=\d)/, '') || '0', fracPart };
  }
  const plain = PLAIN_FORM.exec(unsigned);
  const intPart = (plain?.[1] ?? '0').replace(/^0+(?=\d)/, '') || '0';
  return { negative, intPart, fracPart: plain?.[2] ?? '' };
}

/** Exact decimal-string comparison — no float64 rounding, unlike `Number(a) - Number(b)`. */
function compareDecimalStrings(a: string, b: string): number {
  const pa = toPlainDecimalParts(a);
  const pb = toPlainDecimalParts(b);
  const aIsZero = pa.intPart === '0' && pa.fracPart.replace(/0+$/, '') === '';
  const bIsZero = pb.intPart === '0' && pb.fracPart.replace(/0+$/, '') === '';
  if (aIsZero && bIsZero) {
    return 0; // +0 and -0 are equal — sign alone must not decide the order
  }
  if (pa.negative !== pb.negative) {
    return pa.negative ? -1 : 1;
  }
  const intLen = Math.max(pa.intPart.length, pb.intPart.length);
  const fracLen = Math.max(pa.fracPart.length, pb.fracPart.length);
  // Equal-length digit strings, padded on the side that keeps their place
  // value (leading zeros for the integer part, trailing for the fraction) —
  // plain string comparison on THOSE is exact, the same trick the integer
  // path already gets for free from BigInt.
  const digitsA = pa.intPart.padStart(intLen, '0') + pa.fracPart.padEnd(fracLen, '0');
  const digitsB = pb.intPart.padStart(intLen, '0') + pb.fracPart.padEnd(fracLen, '0');
  const cmp = digitsA < digitsB ? -1 : digitsA > digitsB ? 1 : 0;
  return pa.negative ? -cmp : cmp;
}

function compareNumericNonNull(a: NonNullable<DbQueryValue>, b: NonNullable<DbQueryValue>): number {
  const na = asNumericString(a);
  const nb = asNumericString(b);
  if (na === null || nb === null) {
    // A numeric column with a non-conforming cell (should not happen, but a
    // sort comparator must never throw) falls back to text for this ONE
    // pair rather than claim a numeric order it cannot compute.
    return String(a).localeCompare(String(b));
  }
  if (INTEGER_STRING.test(na) && INTEGER_STRING.test(nb)) {
    try {
      const ba = BigInt(na);
      const bb = BigInt(nb);
      return ba < bb ? -1 : ba > bb ? 1 : 0;
    } catch {
      // Falls through to the decimal compare below — should not happen for
      // a string that already matched INTEGER_STRING, but never worth a
      // thrown exception in a sort comparator either way.
    }
  }
  return compareDecimalStrings(na, nb);
}

/**
 * A comparator for `Array.prototype.sort`, honouring the direction, the
 * nulls-last rule, and — via `columnIsNumeric` — whether THIS column sorts
 * numerically or as plain text (see the module comment for why that is a
 * per-column decision, not a per-cell one).
 */
export function compareForSort(
  a: DbQueryValue,
  b: DbQueryValue,
  direction: SortDirection,
  columnIsNumeric: boolean
): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  const cmp = columnIsNumeric ? compareNumericNonNull(a, b) : String(a).localeCompare(String(b));
  return direction === 'ascending' ? cmp : -cmp;
}

/**
 * `rowIndices`, reordered by column `columnIndex` — stable for equal values.
 * Takes the indices to sort rather than sorting every row itself, so a
 * caller can sort an already-FILTERED subset (the results grid's own use)
 * without this needing to know anything about filtering.
 */
export function sortedRowIndices(
  rowIndices: readonly number[],
  rows: readonly DbQueryValue[][],
  columnIndex: number,
  direction: SortDirection,
  columnIsNumeric: boolean
): number[] {
  return rowIndices
    .slice()
    .sort((ia, ib) => {
      const cmp = compareForSort(rows[ia][columnIndex], rows[ib][columnIndex], direction, columnIsNumeric);
      // Stable tie-break on the original index — Array.prototype.sort is
      // spec-stable in every engine this module targets, but making it
      // explicit means the behaviour does not quietly depend on that.
      return cmp !== 0 ? cmp : ia - ib;
    });
}
