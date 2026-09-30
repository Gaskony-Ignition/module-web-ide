import { describe, expect, it } from 'vitest';
import { EMPTY_TEMPLATE, TEMPLATES, templateById } from './templates';

const withCode = TEMPLATES.filter((t) => t.source.length > 0);

/**
 * A template's CODE, with comment lines removed.
 *
 * Written after this file's own first version reported a template as catching
 * `except Exception` when the only occurrence was in a comment explaining why
 * not to. That is precisely the false positive `StyleChecks` goes over the AST
 * to avoid, and a test that makes it is no better than a lint that does.
 */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

describe('templates', () => {
  it('offers the empty file first, because that is the ordinary case', () => {
    expect(TEMPLATES[0]).toBe(EMPTY_TEMPLATE);
    expect(EMPTY_TEMPLATE.source).toBe('');
  });

  it('has a unique id and a hint for every entry', () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const template of TEMPLATES) {
      expect(template.hint.length).toBeGreaterThan(10);
    }
  });

  it('falls back to the empty file for an id this build does not know', () => {
    // The picker's value could come from anywhere; an unknown one must mean
    // "no template", not undefined reaching the create route as the body.
    expect(templateById('nonsense')).toBe(EMPTY_TEMPLATE);
  });

  it.each(withCode.map((t) => [t.id, t] as const))(
    '%s indents with TABS only',
    (_id, template) => {
      // The byte-fidelity rule: this estate writes Jython with tabs and this
      // module never converts one to the other. A template seeding spaces
      // starts every new file on the wrong side of a rule the lints report.
      const spaceIndented = template.source
        .split('\n')
        .filter((line) => /^ +\S/.test(line));
      expect(spaceIndented).toEqual([]);
    }
  );

  it.each(withCode.map((t) => [t.id, t] as const))(
    '%s never catches bare, and never catches Exception around a platform call',
    (_id, template) => {
      // A Stop and the execution timeout arrive as a Java Error — a Throwable
      // and not an Exception. Seeding `except Exception` into every new file
      // would spread the estate's most-repeated bug.
      const body = code(template.source);
      expect(body).not.toMatch(/except\s*:/);
      if (body.includes('system.')) {
        expect(body).not.toMatch(/except\s+Exception/);
      }
    }
  );

  it.each(withCode.map((t) => [t.id, t] as const))(
    '%s opens with a module docstring',
    (_id, template) => {
      expect(template.source.startsWith('"""')).toBe(true);
    }
  );

  it.each(withCode.map((t) => [t.id, t] as const))(
    '%s ends with exactly one newline',
    (_id, template) => {
      // The Designer writes no terminating newline on an empty file, but a file
      // with content ends with one and only one — a trailing blank line shows
      // up as a diff on the first save somebody else makes.
      expect(template.source.endsWith('\n')).toBe(true);
      expect(template.source.endsWith('\n\n')).toBe(false);
    }
  );

  it('imports Throwable wherever it catches one', () => {
    for (const template of withCode) {
      if (/except\s+Throwable/.test(code(template.source))) {
        expect(template.source).toContain('from java.lang import Throwable');
      }
    }
  });

  it('uses beginTransaction, not the named-query one', () => {
    // Measured on 8.3.8: beginNamedQueryTransaction is for runNamedQuery.
    // runPrepUpdate takes the id from beginTransaction.
    const tx = templateById('transaction').source;
    expect(tx).toContain('system.db.beginTransaction(');
    expect(tx).not.toContain('beginNamedQueryTransaction(');
  });

  it('parameterises SQL rather than formatting values into it', () => {
    const db = templateById('db').source;
    expect(db).toContain('runPrepQuery');
    expect(db).toContain('?');
    // The failure this guards: a template that demonstrated string formatting
    // would teach the injection every time somebody started from it.
    expect(db).not.toMatch(/"SELECT[^"]*%s/);
  });

  it('checks tag quality rather than trusting the value', () => {
    // A bad read still carries a value — usually the last good one — so code
    // that ignores quality carries on with a number that means nothing.
    expect(templateById('tags').source).toContain('quality.isGood()');
  });

  it('tells the test template the discovery rule it has to satisfy', () => {
    // Discovery is narrow on purpose; a template that produced an undiscovered
    // module would look like the runner was broken.
    expect(templateById('tests').source).toMatch(/starts with "test"/);
  });
});
