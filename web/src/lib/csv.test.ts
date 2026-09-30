import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvRow, toCsv } from './csv';

describe('csvRow', () => {
  it('joins plain fields with a comma, unquoted', () => {
    expect(csvRow(['a', 'b', 1, true])).toBe('a,b,1,true');
  });

  it('quotes a field containing a comma', () => {
    expect(csvRow(['a,b', 'c'])).toBe('"a,b",c');
  });

  it('quotes a field containing a quote, doubling it', () => {
    expect(csvRow(['say "hi"'])).toBe('"say ""hi"""');
  });

  it('quotes a field containing a newline', () => {
    expect(csvRow(['line1\nline2'])).toBe('"line1\nline2"');
  });

  it('quotes a field containing a carriage return', () => {
    expect(csvRow(['a\rb'])).toBe('"a\rb"');
  });

  it('null and undefined become empty fields, never the word null', () => {
    expect(csvRow([null, undefined, 'x'])).toBe(',,x');
  });

  it('an ordinary string is untouched', () => {
    expect(csvRow(['hello'])).toBe('hello');
  });

  it('prefixes a formula-injection risk with a leading apostrophe', () => {
    expect(csvRow(["=cmd|'/c calc'"])).toBe("'=cmd|'/c calc'");
  });

  it('prefixes a value starting with @', () => {
    expect(csvRow(['@mention'])).toBe("'@mention");
  });

  it('prefixes a value that starts with a sign but is not purely numeric', () => {
    expect(csvRow(['+1+1'])).toBe("'+1+1");
  });

  it('does not prefix a purely numeric string with a leading sign', () => {
    expect(csvRow(['-42'])).toBe('-42');
    expect(csvRow(['+3.5'])).toBe('+3.5');
  });

  it('a genuine number cell is never prefixed', () => {
    expect(csvRow([-42])).toBe('-42');
  });

  it('prefixes a tab-leading value; a tab alone does not force CSV quoting', () => {
    expect(csvRow(['\tx'])).toBe("'\tx");
  });

  it('prefixes a CR-leading value, which does force CSV quoting', () => {
    expect(csvRow(['\rx'])).toBe(`"'\rx"`);
  });

  it('a formula guard prefix still gets CSV-quoted for an embedded comma', () => {
    expect(csvRow(['=1,2'])).toBe(`"'=1,2"`);
  });

  it('doubles an embedded quote on top of a formula-guard prefix', () => {
    expect(csvRow(['=say "hi"'])).toBe(`"'=say ""hi"""`);
  });
});

describe('toCsv', () => {
  it('starts with a UTF-8 BOM', () => {
    expect(toCsv(['a'], [['1']]).startsWith(CSV_BOM)).toBe(true);
  });

  it('uses CRLF between every line, including after the header', () => {
    const csv = toCsv(['a', 'b'], [['1', '2'], ['3', '4']]);
    expect(csv).toBe(`${CSV_BOM}a,b\r\n1,2\r\n3,4\r\n`);
  });

  it('a null cell in a data row is an empty field', () => {
    const csv = toCsv(['a'], [[null]]);
    expect(csv).toBe(`${CSV_BOM}a\r\n\r\n`);
  });

  it('a formula-injection-risk cell in a data row is guarded with a leading apostrophe', () => {
    const csv = toCsv(['a'], [['=1+1']]);
    expect(csv).toBe(`${CSV_BOM}a\r\n'=1+1\r\n`);
  });
});
