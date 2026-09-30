/**
 * Diagnostics for the documents the language server does not own.
 *
 * The gateway's language server is a Jython parser and is the only thing
 * allowed to judge Python — the client's own grammar is Python 3 and would put
 * permanent squiggles on `print "x"`. The consequence, unnoticed until
 * 04/09/2026, was that the ruler, the Problems panel, the gutter mark and the
 * line-number mark were ALL absent on anything that was not a `.py` file:
 * `cell3d`'s HTML, `site.css`, a Web Dev endpoint's JavaScript, a named
 * query's SQL. They could be opened and edited with no error signalling at all,
 * and nothing said so.
 *
 * The fix is not to point the Jython server at them. It is to use each
 * language's OWN parser, which CodeMirror already loads for highlighting — the
 * Lezer tree marks the places it could not parse, and those are real syntax
 * errors in that language.
 *
 * <h2>What each language gets, and why they differ</h2>
 *
 * Measured against the installed parsers on 04/09/2026, on valid and broken
 * input for each:
 *
 * | language | valid input | broken input |
 * | --- | --- | --- |
 * | CSS | 0 error nodes | 2 |
 * | JavaScript | 0 | 2 |
 * | JSON | 0 | 1 |
 * | SQL | 0 (`:v` params included) | 1 |
 * | HTML | 0 | **0** |
 *
 * So four of the five get the error-node check. **HTML's parser reports
 * nothing**, by design — it is error-tolerant, because a browser is. It gets a
 * narrow structural check instead; see `htmlProblems`.
 *
 * Nothing here guesses. A construct a parser accepts is not reported, even if
 * it looks wrong: the standing rule on this module is that a mark on working
 * code costs more than a missed problem, because it teaches the reader to
 * ignore the marks.
 */
import { syntaxTree } from '@codemirror/language';
import { linter, type Diagnostic } from '@codemirror/lint';
import type { EditorState, Extension } from '@codemirror/state';
import type { DocLanguage } from '../workspace/docLanguage';

/** The languages whose own parser is trusted to report a syntax error. */
const PARSER_CHECKED: ReadonlySet<DocLanguage> = new Set<DocLanguage>([
  'css', 'javascript', 'json', 'sql',
]);

/**
 * HTML elements that never take a close tag. An `<img>` with no `</img>` is
 * correct, and reporting it would fire on every real page.
 */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
]);

/**
 * The HTML elements this check will report as unclosed — and ONLY these.
 *
 * An allowlist rather than a denylist, because HTML makes a great many end tags
 * OPTIONAL: `<li>`, `<p>`, `<td>`, `<tr>`, `<option>`, `<thead>` and a dozen
 * others close themselves at the next sibling, so `<div><p>hi</div>` is VALID
 * and must produce nothing. Every tag below is one whose end tag the spec
 * requires, so an unclosed one is a real defect rather than a style.
 */
const MUST_CLOSE: ReadonlySet<string> = new Set([
  'a', 'article', 'aside', 'audio', 'blockquote', 'body', 'button', 'canvas',
  'div', 'fieldset', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'head', 'header', 'html', 'iframe', 'label', 'main', 'map', 'nav',
  'object', 'ol', 'pre', 'script', 'section', 'select', 'span', 'style',
  'svg', 'table', 'textarea', 'title', 'ul', 'video',
]);

/** The text of a node, capped so a message stays a message. */
function textAt(state: EditorState, from: number, to: number): string {
  const raw = state.doc.sliceString(from, Math.min(to, from + 40)).trim();
  return raw.length > 30 ? `${raw.slice(0, 30)}…` : raw;
}

/** The most marks one document may carry. See the cap in `parserProblems`. */
const MAX_MARKS = 50;

/**
 * Places the language's own parser could not parse.
 *
 * A zero-width error node is widened by one character: CodeMirror renders a
 * zero-width squiggle as nothing, and an invisible mark is the same as no mark.
 */
function parserProblems(state: EditorState, language: DocLanguage): Diagnostic[] {
  const out: Diagnostic[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      // The cap is checked on the way IN and stops descending, because
      // returning false from `enter` only skips a subtree — it does not end
      // the walk. `{`.repeat(400) produced 399 marks before this was right.
      if (out.length >= MAX_MARKS) {
        return false;
      }
      if (!node.type.isError) {
        return undefined;
      }
      // A zero-width error node renders as nothing at all, so it is widened by
      // one character — FORWARD normally, and BACKWARD at the end of the
      // document, where there is no next character to take. An unterminated
      // construct always errors at the very end, so that is the common case
      // rather than the edge one.
      let from = node.from;
      let to = node.to;
      if (to <= from) {
        if (from < state.doc.length) {
          to = from + 1;
        } else {
          from = Math.max(0, from - 1);
          to = state.doc.length;
        }
      }
      if (to <= from) {
        return undefined;      // an empty document has nowhere to put a mark
      }
      const near = textAt(state, from, to);
      out.push({
        from,
        to,
        severity: 'error',
        source: language,
        message: near
          ? `${language.toUpperCase()} syntax error near "${near}".`
          : `${language.toUpperCase()} syntax error here.`,
      });
      return undefined;
    },
  });
  return out;
}

/**
 * HTML's structural problems, since its parser reports none.
 *
 * Two shapes, both unambiguous:
 *
 * - an element that requires a close tag and does not have one. The Lezer tree
 *   gives an `Element` its `OpenTag` and, when there is one, its `CloseTag`; a
 *   missing `CloseTag` on a tag in {@link MUST_CLOSE} is the defect.
 * - a close tag that closes nothing — `</div>` with no `<div>` open. The parser
 *   leaves it parented to the document rather than to an element.
 *
 * Self-closing (`<div/>`) counts as closed. Everything else is left alone: the
 * allowlist exists so that HTML's many optional end tags cannot be reported,
 * and an attribute or a doctype this check does not understand is silence, not
 * a guess.
 */
function htmlProblems(state: EditorState): Diagnostic[] {
  const out: Diagnostic[] = [];
  const tree = syntaxTree(state);
  // THE trap, and it is not obvious: CodeMirror parses LAZILY, so `syntaxTree`
  // routinely returns a tree covering only part of the document — measured on
  // `cell3d.html`, 3,041 characters of 72,626 even after `ensureSyntaxTree`
  // was asked for the lot. Everything past that frontier is simply absent from
  // the tree, so `<html>` on line 2 has no `CloseTag` child and looks unclosed.
  //
  // The first version of this check reported exactly that: "<html> is never
  // closed" on a page that renders in every browser, plus `<head>` and
  // `<style>` for the same reason. Three false positives on the first real file
  // it was pointed at.
  //
  // So an element is only judged when the tree actually covers its END. When
  // the parse is complete that is every element; when it is not, an element
  // running past the frontier is left alone, because "no close tag here" and
  // "the parser has not looked yet" are indistinguishable from inside.
  // `tree.length` is how far the tree ACTUALLY reaches, and it is the only
  // honest signal. `syntaxTreeAvailable(state, doc.length)` looks like the right
  // API and is not: measured on this file it returned TRUE while the tree
  // covered 3,041 characters of 72,626. It answers "is a tree available without
  // parsing further", not "does the tree cover this position".
  const complete = tree.length >= state.doc.length;
  const judged = (to: number) => complete || to < tree.length;
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'Element') {
        return undefined;
      }
      if (!judged(node.to)) {
        return undefined;
      }
      const openTag = node.node.getChild('OpenTag');
      if (!openTag) {
        return undefined;      // a stray CloseTag; handled below
      }
      // `<div/>` is closed. The parser gives it no distinct node type — the
      // OpenTag simply ends with a two-character `EndTag` reading `/>` — so
      // that is what is read. Measured, not assumed.
      const openEnd = openTag.getChild('EndTag');
      if (openEnd && state.doc.sliceString(openEnd.from, openEnd.to) === '/>') {
        return undefined;
      }
      const nameNode = openTag.getChild('TagName');
      if (!nameNode) {
        return undefined;
      }
      const name = state.doc.sliceString(nameNode.from, nameNode.to).toLowerCase();
      if (VOID_ELEMENTS.has(name) || !MUST_CLOSE.has(name)) {
        return undefined;
      }
      if (node.node.getChild('CloseTag')) {
        return undefined;
      }
      // The parse frontier, confirmed in the TEXT rather than in the tree.
      //
      // Two goes at reading it off the tree were both wrong. `syntaxTreeAvailable`
      // returns true for a tree covering 3,041 characters of 72,626; and in the
      // real editor `tree.length` equals the document length while most of it is
      // still placeholder, so neither says where parsing actually got to. The
      // symptom both times was "<html> is never closed" on `cell3d.html` — a
      // page that renders in every browser.
      //
      // So before reporting an element unclosed, look for its close tag in the
      // document itself. Present anywhere after the open tag: say nothing. This
      // can miss a genuinely mis-NESTED close, which is the conservative
      // direction and the standing rule on this module — a mark on working code
      // costs more than a missed problem.
      const rest = state.doc.sliceString(openTag.to, state.doc.length);
      if (rest.includes(`</${name}`) || rest.includes(`</ ${name}`)) {
        return undefined;
      }
      out.push({
        from: openTag.from,
        to: openTag.to,
        severity: 'error',
        source: 'html',
        message: `<${name}> is never closed. Its end tag is required.`,
      });
      return undefined;
    },
  });
  // A close tag that closes nothing. The parser names this shape itself —
  // `MismatchedCloseTag` — which is more reliable than inferring it from the
  // parent, and an orphaned `CloseTag` outside any element is caught too.
  tree.iterate({
    enter: (node) => {
      if (node.name !== 'MismatchedCloseTag'
          && !(node.name === 'CloseTag' && node.node.parent?.name !== 'Element')) {
        return undefined;
      }
      const nameNode = node.node.getChild('TagName');
      const name = nameNode ? state.doc.sliceString(nameNode.from, nameNode.to) : '';
      out.push({
        from: node.from,
        to: node.to,
        severity: 'error',
        source: 'html',
        message: name
          ? `</${name}> closes nothing — there is no matching <${name}>.`
          : 'This close tag matches no open tag.',
      });
      return undefined;
    },
  });
  return out;
}

/** Every syntax problem this client can find in a non-Python document. */
export function syntaxDiagnostics(state: EditorState, language: DocLanguage): Diagnostic[] {
  if (language === 'html') {
    return htmlProblems(state);
  }
  if (PARSER_CHECKED.has(language)) {
    return parserProblems(state, language);
  }
  // 'text' and 'python'. Plain text has no syntax to be wrong, and Python
  // belongs to the gateway's Jython parser — see the file comment.
  return [];
}

/** True when this language has a check at all, so a caller can say so. */
export function hasSyntaxCheck(language: DocLanguage): boolean {
  return language === 'html' || PARSER_CHECKED.has(language);
}

/**
 * The linter extension, plus a hook so the ruler and Problems panel see these.
 *
 * `onPublish` exists because those two read from the LSP client's diagnostic
 * store, which is keyed by uri and fed by the server. A document the server
 * does not know about would otherwise be linted in the editor and invisible
 * everywhere else — half a fix, and the confusing half.
 */
export function syntaxLint(
  language: DocLanguage,
  onPublish?: (diagnostics: Diagnostic[]) => void
): Extension {
  return linter((view) => {
    const found = syntaxDiagnostics(view.state, language);
    // A side effect inside the lint source, deliberately: it is the one place
    // the diagnostics are computed, and computing them a second time in an
    // update listener would double the parse walk on every keystroke.
    onPublish?.(found);
    return found;
  });
}
