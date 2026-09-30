import { describe, expect, it } from 'vitest';
import { splitStatements, statementAtCursor } from './sqlStatements';

describe('splitStatements', () => {
  it('splits on a top-level semicolon', () => {
    expect(splitStatements('SELECT 1; SELECT 2;')).toEqual([
      { text: 'SELECT 1', start: 0, end: 8 },
      { text: 'SELECT 2', start: 10, end: 18 },
    ]);
  });

  it('keeps a trailing statement with no terminating semicolon', () => {
    const statements = splitStatements('SELECT 1;\nSELECT 2');
    expect(statements).toHaveLength(2);
    expect(statements[1].text).toBe('SELECT 2');
  });

  it('does not split on a semicolon inside a single-quoted string', () => {
    expect(splitStatements("SELECT ';' AS x; SELECT 2")).toHaveLength(2);
  });

  it('a doubled single quote is an escaped quote, not the end of the literal', () => {
    const statements = splitStatements("SELECT 'it''s; not a split' AS x; SELECT 2");
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toBe("SELECT 'it''s; not a split' AS x");
  });

  it('does not split on a semicolon inside a double-quoted identifier', () => {
    expect(splitStatements('SELECT "weird;name" FROM t; SELECT 2')).toHaveLength(2);
  });

  it('a doubled double quote is an escaped quote within the identifier', () => {
    const statements = splitStatements('SELECT "a""b;c" FROM t; SELECT 2');
    expect(statements[0].text).toBe('SELECT "a""b;c" FROM t');
  });

  it('does not split on a semicolon inside a -- line comment', () => {
    const statements = splitStatements('SELECT 1 -- comment; still one statement\nWHERE 1=1; SELECT 2');
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toContain('WHERE 1=1');
  });

  it('does not split on a semicolon inside a /* */ block comment', () => {
    const statements = splitStatements('SELECT 1 /* a; b */ FROM t; SELECT 2');
    expect(statements).toHaveLength(2);
    expect(statements[0].text).toBe('SELECT 1 /* a; b */ FROM t');
  });

  it('treats MySQL backtick and MSSQL bracket quoting the same way', () => {
    expect(splitStatements('SELECT `a;b` FROM t; SELECT [c;d] FROM u')).toHaveLength(2);
  });

  it('an empty statement between two semicolons is skipped, not returned as a blank entry', () => {
    expect(splitStatements('SELECT 1;;SELECT 2;')).toEqual([
      { text: 'SELECT 1', start: 0, end: 8 },
      { text: 'SELECT 2', start: 10, end: 18 },
    ]);
  });

  it('a fully blank buffer produces no statements', () => {
    expect(splitStatements('   \n\n  ')).toEqual([]);
  });

  describe('PostgreSQL', () => {
    it('does not split on a semicolon inside an E-string, and honours its backslash escape', () => {
      const statements = splitStatements("SELECT E'a\\'; still one' AS x; SELECT 2", 'PostgreSQL');
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toBe("SELECT E'a\\'; still one' AS x");
    });

    it('a plain quoted string does NOT get backslash-escape treatment', () => {
      // 'a\' closes the string at the literal quote right after the backslash —
      // so this is TWO statements once the closing "'; SELECT 2'" is reached,
      // not one long string swallowing the semicolon.
      const statements = splitStatements("SELECT 'a\\'; SELECT 2'", 'PostgreSQL');
      expect(statements).toHaveLength(2);
    });

    it('does not split on a semicolon inside a $$-quoted string', () => {
      const statements = splitStatements('SELECT $$it; is one$$ AS x; SELECT 2', 'PostgreSQL');
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toBe('SELECT $$it; is one$$ AS x');
    });

    it('does not split on a semicolon inside a tagged $tag$-quoted string', () => {
      const statements = splitStatements('SELECT $body$it; is one$body$ AS x; SELECT 2', 'PostgreSQL');
      expect(statements).toHaveLength(2);
    });

    it('a nested block comment only closes on its own matching */', () => {
      const statements = splitStatements('SELECT 1 /* outer /* inner; */ still-outer; */ FROM t; SELECT 2', 'PostgreSQL');
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toContain('still-outer');
    });

    it('does not treat # as a comment', () => {
      const statements = splitStatements('SELECT 1 # not a comment ; SELECT 2', 'PostgreSQL');
      expect(statements).toHaveLength(2);
    });
  });

  describe('MySQL/MariaDB', () => {
    it('honours a backslash escape inside a single-quoted string', () => {
      const statements = splitStatements("SELECT 'a\\'; still one' AS x; SELECT 2", 'MySQL');
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toBe("SELECT 'a\\'; still one' AS x");
    });

    it('honours a backslash escape inside a double-quoted string', () => {
      const statements = splitStatements('SELECT "a\\"; still one" AS x; SELECT 2', 'MySQL');
      expect(statements).toHaveLength(2);
    });

    it('treats # as a line comment', () => {
      const statements = splitStatements('SELECT 1 # comment; still one\nFROM t; SELECT 2', 'MariaDB');
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toContain('FROM t');
    });

    it('a block comment does not nest — the first */ closes it', () => {
      const statements = splitStatements('SELECT 1 /* outer /* inner */ ; SELECT 2', 'MySQL');
      expect(statements).toHaveLength(2);
    });
  });

  describe('SQL Server', () => {
    it('splits a batch on a standalone GO line', () => {
      const statements = splitStatements('SELECT 1\nGO\nSELECT 2', 'Microsoft SQL Server');
      expect(statements).toEqual([
        { text: 'SELECT 1', start: 0, end: 8 },
        { text: 'SELECT 2', start: 12, end: 20 },
      ]);
    });

    it('accepts GO <n> as a repeat count', () => {
      const statements = splitStatements('SELECT 1\nGO 3\nSELECT 2', 'Microsoft SQL Server');
      expect(statements).toHaveLength(2);
    });

    it('does not split on GO appearing mid-line, or as part of a longer word', () => {
      const statements = splitStatements("SELECT 'GO' AS x, GOTO_TARGET\nGO\nSELECT 2", 'Microsoft SQL Server');
      expect(statements).toHaveLength(2);
      expect(statements[0].text).toContain('GOTO_TARGET');
    });

    it('still splits on ; within a batch', () => {
      expect(splitStatements('SELECT 1; SELECT 2\nGO\nSELECT 3', 'Microsoft SQL Server')).toHaveLength(3);
    });
  });
});

describe('statementAtCursor', () => {
  const sql = 'SELECT 1;\n\nSELECT 2;\nSELECT 3';

  function textAt(cursor: number, productName?: string | null): string | null {
    const result = statementAtCursor(sql, cursor, productName);
    return result.found ? result.statement.text : null;
  }

  it('the cursor inside the first statement runs the first statement', () => {
    expect(textAt(3)).toBe('SELECT 1');
  });

  it('the cursor inside the second statement runs the second, not the first', () => {
    const idx = sql.indexOf('SELECT 2') + 3;
    expect(textAt(idx)).toBe('SELECT 2');
  });

  it('the cursor on the trailing statement with no semicolon still resolves it', () => {
    const idx = sql.indexOf('SELECT 3') + 3;
    expect(textAt(idx)).toBe('SELECT 3');
  });

  it('the cursor on a blank line between statements runs nothing', () => {
    const blankLineIndex = sql.indexOf('\n\n') + 1; // inside the blank line, past the first \n
    const result = statementAtCursor(sql, blankLineIndex);
    expect(result).toEqual({ found: false, reason: 'blank' });
  });

  it('the cursor right before the semicolon still selects that statement', () => {
    expect(textAt(8)).toBe('SELECT 1'); // index of ';' itself
  });

  it('the cursor right after the semicolon, still on the same line, selects the statement just finished', () => {
    // Position 9 is immediately after 'SELECT 1;' and before the blank
    // line's own newline — the natural place a cursor sits right after
    // typing the semicolon, which should run "SELECT 1", not nothing.
    expect(textAt(9)).toBe('SELECT 1');
  });

  it('a semicolon inside a string literal does not fool the cursor lookup', () => {
    const withLiteral = "SELECT ';' AS x; SELECT 2";
    const idx = withLiteral.indexOf('SELECT 2') + 3;
    const result = statementAtCursor(withLiteral, idx);
    expect(result.found && result.statement.text).toBe('SELECT 2');
  });

  it('an entirely blank buffer resolves to no statement anywhere', () => {
    expect(statementAtCursor('   \n  \n', 3)).toEqual({ found: false, reason: 'blank' });
  });

  it('two statements glued with no gap: right after the first ; still selects it', () => {
    const glued = 'SELECT 1;SELECT 2;SELECT 3';
    const result = statementAtCursor(glued, 9); // right after the first ';'
    expect(result.found && result.statement.text).toBe('SELECT 1');
  });

  it('an unterminated string at the end of the buffer refuses rather than guessing', () => {
    const result = statementAtCursor("SELECT 'unterminated", 3);
    expect(result).toEqual({
      found: false,
      reason: 'unterminated',
      message: expect.stringContaining('unterminated'),
    });
  });

  it('an unterminated block comment at the end of the buffer refuses rather than guessing', () => {
    const result = statementAtCursor('SELECT 1; /* never closed', 3);
    expect(result.found).toBe(false);
    expect(result.found === false && result.reason).toBe('unterminated');
  });

  it('a dialect-specific separator is honoured: GO ends the statement under the cursor', () => {
    const mssql = 'SELECT 1\nGO\nSELECT 2';
    const result = statementAtCursor(mssql, 3, 'Microsoft SQL Server');
    expect(result.found && result.statement.text).toBe('SELECT 1');
  });
});
