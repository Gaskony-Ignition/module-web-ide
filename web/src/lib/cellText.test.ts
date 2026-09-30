import { describe, expect, it } from 'vitest';
import {
  cellToTsv, isNumericType, needsFormulaGuard, prettyJsonIfParsable, renderCell, truncatedCharTotal,
} from './cellText';

describe('renderCell', () => {
  it('renders null as the literal word NULL', () => {
    expect(renderCell(null)).toBe('NULL');
  });

  it('renders other values via String()', () => {
    expect(renderCell(42)).toBe('42');
    expect(renderCell(false)).toBe('false');
  });
});

describe('cellToTsv', () => {
  it('null becomes an empty field, not the word NULL', () => {
    expect(cellToTsv(null)).toBe('');
  });

  it('quotes a value containing a tab', () => {
    expect(cellToTsv('a\tb')).toBe('"a\tb"');
  });

  it('doubles an embedded quote', () => {
    expect(cellToTsv('say "hi"')).toBe('"say ""hi"""');
  });

  it('an ordinary string is untouched', () => {
    expect(cellToTsv('hello')).toBe('hello');
  });

  it('prefixes a formula-injection risk with a leading apostrophe', () => {
    expect(cellToTsv("=cmd|'/c calc'")).toBe("'=cmd|'/c calc'");
  });

  it('prefixes a value starting with @', () => {
    expect(cellToTsv('@mention')).toBe("'@mention");
  });

  it('prefixes a value that starts with a sign but is not purely numeric', () => {
    expect(cellToTsv('+1+1')).toBe("'+1+1");
  });

  it('does not prefix a purely numeric string with a leading sign', () => {
    expect(cellToTsv('-42')).toBe('-42');
    expect(cellToTsv('+3.5')).toBe('+3.5');
  });

  it('a genuine number is never prefixed even if it stringifies oddly', () => {
    expect(cellToTsv(-42)).toBe('-42');
  });

  it('prefixes a tab-leading value and still quotes it for the embedded tab', () => {
    expect(cellToTsv('\tx')).toBe(`"'\tx"`);
  });

  it('prefixes a CR-leading value and still quotes it for the embedded CR', () => {
    expect(cellToTsv('\rx')).toBe(`"'\rx"`);
  });

  it('doubles an embedded quote on top of a formula-guard prefix', () => {
    expect(cellToTsv('=say "hi"')).toBe(`"'=say ""hi"""`);
  });
});

describe('needsFormulaGuard', () => {
  it('is true for the trigger characters on non-numeric text', () => {
    expect(needsFormulaGuard('=1+1')).toBe(true);
    expect(needsFormulaGuard('+1+1')).toBe(true);
    expect(needsFormulaGuard('-rm -rf')).toBe(true);
    expect(needsFormulaGuard('@mention')).toBe(true);
    expect(needsFormulaGuard('\tx')).toBe(true);
    expect(needsFormulaGuard('\rx')).toBe(true);
  });

  it('is false for a purely numeric string, signed or not', () => {
    expect(needsFormulaGuard('-42')).toBe(false);
    expect(needsFormulaGuard('+3.5')).toBe(false);
    expect(needsFormulaGuard('42')).toBe(false);
  });

  it('is false for ordinary text', () => {
    expect(needsFormulaGuard('hello')).toBe(false);
  });
});

describe('isNumericType', () => {
  it('matches common numeric vendor type names', () => {
    expect(isNumericType('int4')).toBe(true);
    expect(isNumericType('NUMERIC')).toBe(true);
    expect(isNumericType('decimal(38,9)')).toBe(true);
  });

  it('does not match a text type', () => {
    expect(isNumericType('varchar')).toBe(false);
  });
});

describe('truncatedCharTotal', () => {
  it('reads the real total off the server\'s truncation marker', () => {
    expect(truncatedCharTotal('x'.repeat(100) + '… (truncated, 20000 chars total)')).toBe(20000);
  });

  it('a plain string with no marker is not truncated', () => {
    expect(truncatedCharTotal('plain text')).toBeNull();
  });

  it('a non-string value is not truncated', () => {
    expect(truncatedCharTotal(42)).toBeNull();
    expect(truncatedCharTotal(null)).toBeNull();
  });
});

describe('prettyJsonIfParsable', () => {
  it('pretty-prints a value that parses whole as a JSON object', () => {
    expect(prettyJsonIfParsable('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('pretty-prints a JSON array', () => {
    expect(prettyJsonIfParsable('[1,2,3]')).toBe('[\n  1,\n  2,\n  3\n]');
  });

  it('returns null for plain text', () => {
    expect(prettyJsonIfParsable('hello')).toBeNull();
  });

  it('returns null for text that merely starts with { but is not valid JSON', () => {
    expect(prettyJsonIfParsable('{not json')).toBeNull();
  });

  it('returns null for a non-string value', () => {
    expect(prettyJsonIfParsable(42)).toBeNull();
  });
});
