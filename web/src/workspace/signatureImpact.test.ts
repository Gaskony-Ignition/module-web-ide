import { describe, expect, it } from 'vitest';
import {
  describeImpact,
  hasImpact,
  signatureImpact,
  topLevelDefs,
} from './signatureImpact';

describe('topLevelDefs', () => {
  it('finds functions and classes at column zero', () => {
    const found = topLevelDefs('def compute(a, b):\n\tpass\n\nclass Thing(object):\n\tpass\n');
    expect([...found.keys()]).toEqual(['compute', 'Thing']);
  });

  it('ignores an INDENTED def — a method is not what a caller imports', () => {
    const found = topLevelDefs('class Thing(object):\n\tdef method(self):\n\t\tpass\n');
    expect([...found.keys()]).toEqual(['Thing']);
  });

  it('ignores a decorator line', () => {
    expect([...topLevelDefs('@staticmethod\ndef go():\n\tpass\n').keys()]).toEqual(['go']);
  });
});

describe('signatureImpact', () => {
  it('reports a removed function', () => {
    const impact = signatureImpact('def gone():\n\tpass\n', '');
    expect(impact.removed).toEqual(['gone']);
    expect(impact.changed).toEqual([]);
    expect(hasImpact(impact)).toBe(true);
  });

  it('reports a changed parameter list', () => {
    const impact = signatureImpact('def f(a):\n\tpass\n', 'def f(a, b):\n\tpass\n');
    expect(impact.changed).toEqual(['f']);
  });

  it('does NOT report a whitespace-only reformat', () => {
    // `f(a, b)` and `f(a,b)` take the same call. Reporting one would train the
    // warning away on the first tidy-up someone does.
    const impact = signatureImpact('def f(a, b):\n\tpass\n', 'def f(a,b):\n\tpass\n');
    expect(hasImpact(impact)).toBe(false);
  });

  it('does NOT report a body change', () => {
    const impact = signatureImpact('def f(a):\n\treturn 1\n', 'def f(a):\n\treturn 2\n');
    expect(hasImpact(impact)).toBe(false);
  });

  it('does NOT report a NEW function — nothing can be calling it yet', () => {
    const impact = signatureImpact('def a():\n\tpass\n', 'def a():\n\tpass\n\ndef b():\n\tpass\n');
    expect(hasImpact(impact)).toBe(false);
  });

  it('reports a rename as both a removal and nothing else', () => {
    const impact = signatureImpact('def old():\n\tpass\n', 'def new():\n\tpass\n');
    expect(impact.removed).toEqual(['old']);
    expect(impact.changed).toEqual([]);
  });

  it('is empty for an empty edit', () => {
    expect(hasImpact(signatureImpact('', ''))).toBe(false);
  });
});

describe('describeImpact', () => {
  it('names what changed and how many callers', () => {
    const text = describeImpact({ removed: ['gone'], changed: ['f'] }, 4);
    expect(text).toContain('“gone”');
    expect(text).toContain('“f”');
    expect(text).toContain('4 places');
  });

  it('reads correctly for exactly one', () => {
    expect(describeImpact({ removed: ['gone'], changed: [] }, 1)).toContain('1 place in');
  });
});
