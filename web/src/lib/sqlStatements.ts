/**
 * Split a SQL buffer into statements on a top-level separator, and find the
 * one statement a cursor position sits inside — "run the statement under the
 * cursor" (Ctrl+Shift+Enter).
 *
 * A separator is top-level only outside a single-quoted string, a
 * double-quoted or backtick/bracket-quoted identifier, a line comment and a
 * block comment — a single character scan, not a SQL parser, because that is
 * all splitting needs: where a statement ends, never what is inside it. The
 * scan is DIALECT-AWARE ({@link dialectRulesFor}) because "what ends a
 * string" and "what separates statements" are not the same across engines:
 * PostgreSQL nests `/* *\/` comments and treats `$tag$...$tag$` as a string
 * whatever `;`/quotes it holds; MySQL/MariaDB honour `\` as an escape inside
 * `'...'`/`"..."` and treat `#` as a line comment the way PostgreSQL treats
 * `#` as a plain operator; SQL Server has no multi-statement `;` batching at
 * all in the same sense — a line whose only content is `GO` (optionally
 * `GO <n>`) is what actually separates batches there.
 */

export interface SqlStatement {
  /** The statement's own text, trimmed of the whitespace around it. */
  text: string;
  /** Offset of `text` (post-trim) in the original buffer. */
  start: number;
  /** End offset of `text` (post-trim, exclusive) in the original buffer. */
  end: number;
}

/** What separates statements, and what a string/comment looks like, for one dialect. */
export interface StatementSeparatorRules {
  /** MySQL/MariaDB: `\` escapes the next character inside a `'...'`/`"..."` string. */
  backslashEscapes: boolean;
  /** PostgreSQL: an `E'...'`/`e'...'` string additionally allows `\` escapes; a plain `'...'` never does. */
  postgresEscapeStrings: boolean;
  /** MySQL/MariaDB: `#` starts a line comment, the same as `--`. */
  hashComments: boolean;
  /** PostgreSQL: `$tag$...$tag$` is a string, whatever `;`/quotes it contains. */
  dollarQuotedStrings: boolean;
  /** PostgreSQL: `/* /* *\/ *\/` nests; every other dialect's first `*\/` closes the comment. */
  nestedBlockComments: boolean;
  /** SQL Server: a line whose only content is `GO` (optionally `GO <n>`) ends a batch. */
  goSeparator: boolean;
}

const STANDARD_RULES: StatementSeparatorRules = {
  backslashEscapes: false,
  postgresEscapeStrings: false,
  hashComments: false,
  dollarQuotedStrings: false,
  nestedBlockComments: false,
  goSeparator: false,
};

/**
 * Rules for a `databaseProductName` as JDBC reports it (the same string the
 * tables route forwards as `ConnectionFacts.databaseProductName`, and
 * {@link dialectForProductName} in `./sqlDialect` already switches on).
 * An unrecognised or missing name falls back to the standard rules — `;`
 * only, no dialect-specific string/comment forms — rather than guessing.
 */
export function dialectRulesFor(productName?: string | null): StatementSeparatorRules {
  const name = (productName ?? '').toLowerCase();
  if (name.includes('postgres')) {
    return {
      ...STANDARD_RULES,
      postgresEscapeStrings: true,
      dollarQuotedStrings: true,
      nestedBlockComments: true,
    };
  }
  if (name.includes('mysql') || name.includes('mariadb')) {
    return { ...STANDARD_RULES, backslashEscapes: true, hashComments: true };
  }
  if (name.includes('sql server') || name.includes('microsoft')) {
    return { ...STANDARD_RULES, goSeparator: true };
  }
  return STANDARD_RULES;
}

type ScanState =
  | 'normal' | 'single' | 'double' | 'backtick' | 'bracket'
  | 'dollar' | 'line-comment' | 'block-comment';

/** One separator's span in the buffer — a `;` (length 1) or a `GO` line (its trimmed text). */
interface Mark { start: number; end: number; }

/** A `$tag$` (or bare `$$`) at `sql[i]`, or `null` — capped lookahead, real tags are short. */
function matchDollarTag(sql: string, i: number): string | null {
  const window = sql.slice(i, i + 64);
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(window);
  return m ? m[0] : null;
}

/**
 * A line at `lineStart` whose only content is `GO` (optionally `GO <n>`,
 * case-insensitive) — SQL Server's batch separator, which is a client/tool
 * convention, not SQL the server itself parses, so it must stand alone on
 * its line. Returns the trimmed "GO ..." text's own span plus the line's end.
 */
function matchGoLine(sql: string, lineStart: number): { markStart: number; markEnd: number; lineEnd: number } | null {
  let lineEnd = sql.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = sql.length;
  const rawLine = sql.slice(lineStart, lineEnd);
  if (!/^[ \t]*GO(?:[ \t]+\d+)?[ \t]*\r?$/i.test(rawLine)) {
    return null;
  }
  const leading = /^[ \t]*/.exec(rawLine)![0].length;
  const trailing = /[ \t\r]*$/.exec(rawLine)![0].length;
  return { markStart: lineStart + leading, markEnd: lineEnd - trailing, lineEnd };
}

/**
 * Every top-level separator in `sql`, as `{start, end}` marks, in order, plus
 * whether the scan ended still inside a string, quoted identifier or block
 * comment — a buffer that is not safe to guess a statement boundary in.
 */
function scanSeparators(sql: string, rules: StatementSeparatorRules): { marks: Mark[]; unterminated: boolean } {
  const marks: Mark[] = [];
  let state: ScanState = 'normal';
  let blockDepth = 0;
  let dollarTag = '';
  let stringAllowsBackslash = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    switch (state) {
      case 'single':
        if (stringAllowsBackslash && ch === '\\') { i++; break; }
        if (ch === "'") { if (next === "'") { i++; } else { state = 'normal'; } }
        break;
      case 'double':
        if (stringAllowsBackslash && ch === '\\') { i++; break; }
        if (ch === '"') { if (next === '"') { i++; } else { state = 'normal'; } }
        break;
      case 'backtick':
        if (ch === '`') { if (next === '`') { i++; } else { state = 'normal'; } }
        break;
      case 'bracket':
        if (ch === ']') { if (next === ']') { i++; } else { state = 'normal'; } }
        break;
      case 'dollar':
        if (ch === '$' && sql.startsWith(dollarTag, i)) {
          i += dollarTag.length - 1;
          state = 'normal';
          dollarTag = '';
        }
        break;
      case 'line-comment':
        if (ch === '\n') { state = 'normal'; }
        break;
      case 'block-comment':
        if (rules.nestedBlockComments && ch === '/' && next === '*') {
          blockDepth++; i++;
        } else if (ch === '*' && next === '/') {
          i++;
          if (blockDepth > 0) { blockDepth--; } else { state = 'normal'; }
        }
        break;
      default: { // 'normal'
        const atLineStart = i === 0 || sql[i - 1] === '\n';
        if (rules.goSeparator && atLineStart) {
          const go = matchGoLine(sql, i);
          if (go) {
            marks.push({ start: go.markStart, end: go.markEnd });
            i = go.lineEnd - 1; // the loop's own i++ lands exactly on lineEnd
            break;
          }
        }
        if (ch === "'") {
          // Postgres: E'...'/e'...' additionally allows `\` escapes; a plain
          // '...' never does, however backslashEscapes/postgresEscapeStrings
          // is set for the OTHER dialect's own strings.
          const prev = sql[i - 1];
          const beforePrev = sql[i - 2];
          const isPgEscapeString = rules.postgresEscapeStrings
            && (prev === 'E' || prev === 'e')
            && !(beforePrev !== undefined && /[A-Za-z0-9_]/.test(beforePrev));
          stringAllowsBackslash = rules.backslashEscapes || isPgEscapeString;
          state = 'single';
        } else if (ch === '"') {
          stringAllowsBackslash = rules.backslashEscapes;
          state = 'double';
        } else if (ch === '`') {
          state = 'backtick';
        } else if (ch === '[') {
          state = 'bracket';
        } else if (rules.dollarQuotedStrings && ch === '$') {
          const tag = matchDollarTag(sql, i);
          if (tag) { dollarTag = tag; state = 'dollar'; i += tag.length - 1; }
        } else if (ch === '-' && next === '-') {
          state = 'line-comment'; i++;
        } else if (rules.hashComments && ch === '#') {
          state = 'line-comment';
        } else if (ch === '/' && next === '*') {
          state = 'block-comment'; blockDepth = 0; i++;
        } else if (ch === ';') {
          marks.push({ start: i, end: i + 1 });
        }
        break;
      }
    }
  }
  const unterminated = state !== 'normal' && state !== 'line-comment';
  return { marks, unterminated };
}

/** A range trimmed of the whitespace around it — empty once trimmed if it was blank. */
function trimmedRange(sql: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(sql[s])) s++;
  while (e > s && /\s/.test(sql[e - 1])) e--;
  return { start: s, end: e };
}

/**
 * `from`, extended through any immediately-following whitespace that does not
 * cross a newline — used to let a cursor sitting right after a statement's
 * own separator (before the next line starts) still count as "inside" that
 * statement, matching how a text cursor at end-of-line reads.
 */
function lineExtendedEnd(sql: string, from: number): number {
  let end = from;
  while (end < sql.length && sql[end] !== '\n' && /\s/.test(sql[end])) end++;
  return end;
}

/**
 * Every statement in `sql`, in order — including a trailing one with no
 * terminating separator. `productName` selects the dialect's separator and
 * string/comment rules ({@link dialectRulesFor}); omitted, only `;` splits.
 */
export function splitStatements(sql: string, productName?: string | null): SqlStatement[] {
  const rules = dialectRulesFor(productName);
  const { marks } = scanSeparators(sql, rules);
  const statements: SqlStatement[] = [];
  let from = 0;
  for (const mark of marks) {
    const { start, end } = trimmedRange(sql, from, mark.start);
    if (start < end) {
      statements.push({ text: sql.slice(start, end), start, end });
    }
    from = mark.end;
  }
  const { start, end } = trimmedRange(sql, from, sql.length);
  if (start < end) {
    statements.push({ text: sql.slice(start, end), start, end });
  }
  return statements;
}

export type StatementLookup =
  | { found: true; statement: SqlStatement }
  | { found: false; reason: 'blank' }
  | { found: false; reason: 'unterminated'; message: string };

/**
 * The statement containing `cursor` (a plain character offset into `sql`).
 *
 * A cursor in the whitespace between two statements — including a blank line
 * between them — resolves to `{found: false, reason: 'blank'}` rather than
 * guessing which neighbour was meant, UNLESS it sits right after a
 * statement's own separator and before the next line starts (typing
 * `SELECT 1;` and pressing the shortcut with the cursor right where it was
 * left, still on that line, must run the statement just finished — see
 * {@link lineExtendedEnd}).
 *
 * A buffer that ends inside an unterminated string, quoted identifier or
 * block comment resolves to `{found: false, reason: 'unterminated', message}`
 * — there is no statement boundary to trust in the rest of a buffer whose
 * quoting the scan never saw close.
 */
export function statementAtCursor(sql: string, cursor: number, productName?: string | null): StatementLookup {
  const rules = dialectRulesFor(productName);
  const { marks, unterminated } = scanSeparators(sql, rules);
  if (unterminated) {
    return {
      found: false,
      reason: 'unterminated',
      message: 'The buffer ends inside an unterminated string, quoted identifier or comment — '
        + 'refusing to guess where the statement under the cursor ends.',
    };
  }
  let from = 0;
  const segments: Array<{ rawStart: number; rawEnd: number; markEnd: number | null }> = [];
  for (const mark of marks) {
    segments.push({ rawStart: from, rawEnd: mark.start, markEnd: mark.end });
    from = mark.end;
  }
  segments.push({ rawStart: from, rawEnd: sql.length, markEnd: null });

  for (const segment of segments) {
    const { start, end } = trimmedRange(sql, segment.rawStart, segment.rawEnd);
    if (start >= end) {
      continue;
    }
    const claimEnd = segment.markEnd === null ? end : Math.max(end, lineExtendedEnd(sql, segment.markEnd));
    if (cursor >= start && cursor <= claimEnd) {
      return { found: true, statement: { text: sql.slice(start, end), start, end } };
    }
  }
  return { found: false, reason: 'blank' };
}
