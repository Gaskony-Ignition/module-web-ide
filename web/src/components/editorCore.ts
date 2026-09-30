/**
 * The CodeMirror pieces shared by every editing surface in this app.
 *
 * Extracted when the Script Console arrived: the console is a Python editor too,
 * and giving it its own theme and its own indent rules would have meant a tab
 * typed in the console and a tab typed in a file eventually disagreeing about
 * what a tab is. The byte-fidelity facets in particular are a property of
 * "editing Jython here", not of any one component.
 *
 * Nothing in this file knows about documents, tabs, saving or the language
 * server. Those belong to the component that composes them.
 */
import {
  indentUnit,
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
} from '@codemirror/language';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  highlightSpecialChars,
  type KeyBinding,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentLess, insertTab } from '@codemirror/commands';
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

/**
 * Syntax colours, expressed with the design tokens rather than CodeMirror's own
 * defaults — those are tuned for a light page and are barely legible here.
 */
export const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: 'var(--syntax-keyword)' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName], color: 'var(--text-primary)' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: 'var(--syntax-function)' },
  { tag: [tags.definition(tags.variableName)], color: 'var(--text-primary)' },
  { tag: [tags.className, tags.typeName], color: 'var(--syntax-type)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--text-secondary)' },
  { tag: tags.invalid, color: 'var(--error)' },
]);

export const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      // Transparent: the ground (colour AND --page-glow) belongs to
      // `.code-editor` beneath. An opaque ground here covered the glow and
      // left the biggest surface in the app flat — the 1.8.1 review.
      backgroundColor: 'transparent',
      color: 'var(--text-primary)',
      fontSize: 'var(--font-size-code)',
    },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.4' },
    '.cm-content': { caretColor: 'var(--accent-primary)' },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-secondary)',
      color: 'var(--text-muted)',
      border: 'none',
      borderRight: '1px solid var(--border-light)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--bg-tertiary)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' },
    '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--accent-primary)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--accent-primary-bg)',
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'var(--accent-primary-bg)',
      color: 'inherit',
    },
  },
  { dark: true }
);

/**
 * Facets that make this editor write the bytes the Designer writes.
 *
 * Kept as their own export, and applied LAST by every composer, because a
 * language extension that set its own `indentUnit` would otherwise win a
 * precedence tie and start emitting spaces. See CodeEditor's class comment.
 */
export const byteFidelity: Extension[] = [
  // A literal tab, so every indent CodeMirror generates (auto-indent after a
  // ':', indentMore, indentOnInput) is a tab and never spaces.
  indentUnit.of('\t'),
  // Tab width for DISPLAY and for the column arithmetic the Python indenter
  // does; it never converts a tab into spaces.
  EditorState.tabSize.of(4),
  // Pin the line separator. Left at its default, CodeMirror splits the document
  // on any of CR, LF or CRLF and rejoins with \n — so opening and saving a file
  // with CRLF endings rewrites every line, invisibly.
  EditorState.lineSeparator.of('\n'),
];

/**
 * Find and replace: Ctrl+F, Ctrl+H, F3, and match highlighting.
 *
 * CodeMirror's own panel rather than a hand-rolled one — it already handles
 * regex, case sensitivity, whole-word, replace-all and the wrap-around, and each
 * of those is a small bug waiting to happen if reimplemented.
 *
 * `top: true` puts the panel above the editor, where VS Code's is; the default
 * is the bottom, which on this layout collides with the console pane.
 */
export const findAndReplace: Extension[] = [
  search({ top: true }),
  highlightSelectionMatches(),
  keymap.of(searchKeymap),
];

/**
 * Folding, with its gutter — for FILES only, never the console.
 *
 * Its own export rather than part of {@link pythonSurface} because the Script
 * Console shares that surface, and a fold arrow beside a three-line REPL entry
 * is chrome for a gesture nobody would make. A file is where folding earns the
 * gutter column.
 *
 * `codeFolding` is listed explicitly rather than left to `foldGutter` to pull
 * in: the gutter renders from the fold STATE, and without the state extension
 * the arrows appear and do nothing.
 */
export const folding: Extension[] = [
  codeFolding(),
  foldGutter(),
  keymap.of(foldKeymap),
];

/**
 * Go to line: Ctrl+G, as VS Code binds it.
 *
 * CodeMirror's own `searchKeymap` binds `gotoLine` to Mod-Alt-g, which nobody
 * arrives here knowing. Both work; this adds the one people actually press.
 * Bound in its own keymap ahead of the defaults so the binding wins whatever
 * else claims Mod-g later.
 */
export const goToLine: Extension = keymap.of([
  { key: 'Mod-g', run: gotoLine, preventDefault: true },
]);

/**
 * Everything a surface is except the language.
 *
 * Extracted when Web Dev's real shapes went in (1.9.0) and the two surfaces
 * above became six. They were already identical line for line — a query and the
 * script that calls it are one piece of work, and two editors that look
 * different make them read as two tools — so leaving them as six copies would
 * have meant six places to forget when a gutter changes.
 */
export const commonSurface: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  drawSelection(),
  rectangularSelection(),
  highlightActiveLine(),
  bracketMatching(),
  syntaxHighlighting(highlightStyle, { fallback: true }),
];

/** Editing surface, syntax and history — everything but keymaps and fidelity. */
export const pythonSurface: Extension[] = [...commonSurface, python()];

/**
 * Editing surface for a named query's SQL — the same one, with a different
 * language.
 *
 * Everything above the language is deliberately identical to
 * {@link pythonSurface}: the same theme, the same highlight style, the same
 * gutters. A named query and the script that calls it are one piece of work
 * (NAMED-QUERIES.md §Why), and two editors that look different make them read
 * as two tools.
 *
 * `sql()` with no dialect gives standard SQL. A dialect is not chosen here
 * because the connection decides it and the client is not told which — guessing
 * MySQL for a Postgres connection would mis-highlight, and the highlighting is
 * the only thing riding on it. The Query Browser IS told its connection's
 * product name (the tables route reports it), so it composes its own
 * dialect- and schema-aware `sql({dialect, schema})` from {@link commonSurface}
 * directly rather than using this export — see `QueryBrowser.tsx`.
 *
 * The byte-fidelity facets are NOT included, exactly as they are not in
 * `pythonSurface`: every composer applies them LAST, so a language extension
 * can never win a precedence tie against them.
 */
export const sqlSurface: Extension[] = [...commonSurface, sql()];

/**
 * The surface for one of Web Dev's non-Python files.
 *
 * `html()` brings its own nested JavaScript and CSS parsers, so a
 * `<script>` block inside a Web Dev text resource highlights as script rather
 * than as markup — which matters, because that is exactly what `cell3d`
 * is: 65 KB of HTML whose bulk is an inline WebGL program.
 *
 * The byte-fidelity facets are NOT included here, exactly as they are not in
 * the two surfaces above: every composer applies them LAST, so a language
 * extension can never win a precedence tie against them.
 */
export const htmlSurface: Extension[] = [...commonSurface, html()];
export const javascriptSurface: Extension[] = [...commonSurface, javascript()];
export const cssSurface: Extension[] = [...commonSurface, css()];
export const jsonSurface: Extension[] = [...commonSurface, json()];
/** No grammar at all — for a file type this build does not recognise. */
export const plainSurface: Extension[] = [...commonSurface];

/**
 * Escape drops focus out of the editor.
 *
 * Tab is bound to a literal tab below (byte fidelity), so without this the
 * editor is a keyboard trap (WCAG 2.1.2) — nothing else on the page claims
 * Tab back. `findAndReplace`'s own Escape (`closeSearchPanel`) precedes this
 * in extension order everywhere it is used, so Escape closes an open
 * find/replace panel first; press it again (or once, with no panel open) to
 * leave the editor, then Tab moves on normally.
 */
export const escapeFocusOut: KeyBinding[] = [
  { key: 'Escape', run: (view) => { view.contentDOM.blur(); return true; } },
];

/**
 * The default keymap, with Tab bound to a literal tab.
 *
 * `insertTab` inserts the `indentUnit`, which the facet above pins to a tab, so
 * this binding is what connects the fidelity rule to the keyboard.
 */
export const pythonKeymap: Extension = keymap.of([
  { key: 'Tab', run: insertTab, shift: indentLess },
  ...escapeFocusOut,
  ...defaultKeymap,
  ...historyKeymap,
]);
