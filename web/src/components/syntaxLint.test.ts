/**
 * The client-side syntax checks, for the documents the Jython server does not
 * own.
 *
 * Same shape as every other check on this module: each "it finds X" has an "and
 * it leaves Y alone" beside it. The false-positive half matters more — these
 * run on a Web Dev endpoint's real stylesheet and a real minified library, and
 * a mark on working code is what teaches a reader to stop reading the marks.
 */
import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { sql } from '@codemirror/lang-sql';
import { python } from '@codemirror/lang-python';
import { ensureSyntaxTree } from '@codemirror/language';
import { hasSyntaxCheck, syntaxDiagnostics } from './syntaxLint';
import type { DocLanguage } from '../workspace/docLanguage';

const SUPPORT: Record<string, () => ReturnType<typeof css>> = {
  css, html, javascript, json, sql, python,
} as never;

/** A state with the language loaded and its tree fully parsed. */
function stateOf(doc: string, language: DocLanguage): EditorState {
  const extension = SUPPORT[language]?.();
  const state = EditorState.create({ doc, extensions: extension ? [extension] : [] });
  // The tree is parsed lazily and in slices; a diagnostic pass over a partial
  // tree sees no errors past the parse frontier, which would make every check
  // below pass for the wrong reason.
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
}

function problems(doc: string, language: DocLanguage): string[] {
  return syntaxDiagnostics(stateOf(doc, language), language).map((d) => d.message);
}

describe('which languages are checked at all', () => {
  it('checks the four whose parser reports errors, plus HTML', () => {
    for (const language of ['css', 'javascript', 'json', 'sql', 'html'] as DocLanguage[]) {
      expect(hasSyntaxCheck(language), language).toBe(true);
    }
  });

  it('checks NEITHER python nor plain text', () => {
    // Python belongs to the gateway's Jython parser — the client's grammar is
    // Python 3 and would flag `print "x"`. Plain text has no syntax at all.
    expect(hasSyntaxCheck('python')).toBe(false);
    expect(hasSyntaxCheck('text')).toBe(false);
    expect(problems('print "x"\nexcept E, e:\n', 'python')).toEqual([]);
    expect(problems('anything at all ((( ', 'text')).toEqual([]);
  });
});

describe('CSS', () => {
  it('reports a broken rule', () => {
    expect(problems('a { color: ; }}}', 'css').length).toBeGreaterThan(0);
  });

  it('leaves a real stylesheet alone', () => {
    const real = `:root { --a: #fff; }\n`
      + `.panel, .panel > .row:hover { color: var(--a); margin: 0 auto; }\n`
      + `@media (max-width: 600px) { .panel { display: none } }\n`
      + `@supports (display: grid) { .g { display: grid; grid-template-columns: 1fr 2fr } }\n`;
    expect(problems(real, 'css')).toEqual([]);
  });
});

describe('JavaScript', () => {
  it('reports a broken statement', () => {
    expect(problems('const a = ;;;function(', 'javascript').length).toBeGreaterThan(0);
  });

  it('leaves modern, minified-looking code alone', () => {
    const real = `const f=(a,b=2,...r)=>({a,b,r});`
      + `class K extends Object{#p=1;get v(){return this.#p}}`
      + `async function g(){for await(const x of []) await x;}`
      + `export default f;`;
    expect(problems(real, 'javascript')).toEqual([]);
  });
});

describe('JSON', () => {
  it('reports a missing value', () => {
    expect(problems('{"a":}', 'json').length).toBeGreaterThan(0);
  });

  it('leaves a Web Dev config.json shape alone', () => {
    const real = JSON.stringify({
      'resource-type': 'text-resource',
      'content-type': 'text/html',
      text: '<!doctype html><html><body>hi</body></html>',
    });
    expect(problems(real, 'json')).toEqual([]);
  });
});

describe('SQL', () => {
  it('reports broken SQL', () => {
    expect(problems('SELEC ** FROM (', 'sql').length).toBeGreaterThan(0);
  });

  it('leaves a named query\'s :parameters alone', () => {
    // THE case that decides whether SQL can be checked at all: every named
    // query on the gateway uses `:identifier` binding, and a parser that
    // flagged those would put a red mark on every one of them.
    expect(problems('SELECT :v AS echoed, :n AS counted', 'sql')).toEqual([]);
    expect(problems(
      'SELECT a.id, b.name FROM orders a JOIN lines b ON b.order_id = a.id '
      + "WHERE a.created > :since AND a.status IN ('OPEN','HELD') ORDER BY a.id DESC",
      'sql'
    )).toEqual([]);
  });
});

describe('HTML — its parser reports nothing, so the checks are structural', () => {
  it('reports an element whose end tag is required and missing', () => {
    const found = problems('<div><span>hi</span>', 'html');
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('<div> is never closed');
  });

  it('reports a close tag that closes nothing', () => {
    const found = problems('<p>hi</span>', 'html');
    expect(found.some((m) => m.includes('closes nothing'))).toBe(true);
  });

  it('leaves an optional end tag alone — <div><p>hi</div> is VALID HTML', () => {
    // The reason the check is an allowlist. HTML makes `p`, `li`, `td`, `tr`,
    // `option` and a dozen more close themselves at the next sibling, so a
    // naive "every element needs a close tag" rule would fire on correct
    // markup constantly.
    expect(problems('<div><p>hi</div>', 'html')).toEqual([]);
    expect(problems('<ul><li>one<li>two</ul>', 'html')).toEqual([]);
    expect(problems('<table><tr><td>a<td>b</table>', 'html')).toEqual([]);
  });

  it('leaves void and self-closing elements alone', () => {
    expect(problems('<div><br><img src="x"><input><hr></div>', 'html')).toEqual([]);
    expect(problems('<div/>', 'html')).toEqual([]);
  });

  it('leaves a real page alone', () => {
    const real = '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n'
      + '<title>Cell</title>\n<style>body{margin:0}</style>\n</head>\n'
      + '<body>\n<canvas id="c"></canvas>\n<script src="three.min.js"></script>\n'
      + '<script>const s=1;</script>\n</body>\n</html>\n';
    expect(problems(real, 'html')).toEqual([]);
  });
});

describe('the marks themselves', () => {
  it('never emits a zero-width range, which would render as nothing', () => {
    for (const [doc, language] of [
      ['a { color: ; }}}', 'css'],
      ['const a = ;;;function(', 'javascript'],
      ['{"a":}', 'json'],
      ['<div><span>hi</span>', 'html'],
    ] as [string, DocLanguage][]) {
      for (const d of syntaxDiagnostics(stateOf(doc, language), language)) {
        expect(d.to, `${language}: ${d.message}`).toBeGreaterThan(d.from);
      }
    }
  });

  it('caps a cascade so one stray brace cannot paint the whole file', () => {
    const found = syntaxDiagnostics(stateOf('{'.repeat(400), 'json'), 'json');
    expect(found.length).toBeLessThanOrEqual(50);
  });
});
