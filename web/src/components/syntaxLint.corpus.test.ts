/**
 * The client-side checks, run over a REAL file rather than an invented one.
 *
 * The Java side has `UnknownNamesRealScriptsTest` for the same reason, and it
 * earned its place immediately: over 38 real scripts the first version of that
 * check produced 21 complaints and every one was a false positive. Invented
 * fixtures only ever contain the cases you already know are right.
 *
 * This is the same test for the browser side. The corpus is `cell3d.html` from
 * `Machine_HMI_Demo` — the 1,559-line WebGL page that is the reason the Web Dev
 * two-shape model exists at all (Nigel, 03/09/2026). It is served to real
 * browsers and renders, so a mark anywhere in it is a defect in the checker.
 *
 * Opt-in, because the file is not in the repo: dump it and point
 * `SI_HTML_CORPUS` at it. Without the variable this skips rather than passing
 * vacuously.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EditorState } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { ensureSyntaxTree } from '@codemirror/language';
import { syntaxDiagnostics } from './syntaxLint';

const corpus = process.env.SI_HTML_CORPUS;

describe.runIf(corpus)('a real page', () => {
  it('is not marked anywhere — every mark in it would be a false positive', () => {
    const doc = readFileSync(corpus as string, 'utf8');
    const state = EditorState.create({ doc, extensions: [html()] });
    // Asked for the whole document — and NOT necessarily given it. Measured on
    // this very file: the tree came back covering 3,041 characters of 72,626.
    // That is the point of the test, not a flaw in it: this is what the editor
    // itself hands the checker, and the checker has to be right on it.
    ensureSyntaxTree(state, doc.length, 30000);
    const found = syntaxDiagnostics(state, 'html');
    expect(doc.length).toBeGreaterThan(10000);          // a corpus, not a stub
    expect(found.map((d) => `${d.from}: ${d.message}`)).toEqual([]);
  });

  it('is not marked when the tree is only parsed to the FIRST SCREEN either', () => {
    // THE bug this file was written for. CodeMirror parses lazily — a freshly
    // opened document has a tree covering roughly the viewport, and everything
    // past the frontier is simply absent. On `cell3d.html` that put `</html>`
    // (line 1,559) outside the tree, so `<html>` on line 2 looked unclosed and
    // was marked "never closed" on a page that renders in every browser.
    //
    // Measured in the real editor on 05/09/2026, not reasoned about: the run
    // reported marks on lines 2 and 1560 where only 1560 was real.
    const doc = readFileSync(corpus as string, 'utf8');
    const state = EditorState.create({ doc, extensions: [html()] });
    ensureSyntaxTree(state, 2000, 5000);                // a screenful, no more
    expect(syntaxDiagnostics(state, 'html')).toEqual([]);
  });
});
