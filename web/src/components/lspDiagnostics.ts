import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import { positionToOffset, type LspClient, type LspDiagnostic } from '../api/lspClient';

/**
 * Render server diagnostics in the editor.
 *
 * The server is the ONLY source of problems here, deliberately. The client's
 * grammar (`@lezer/python`) is Python 3 and would flag `print "x"`,
 * `except E, e:`, `10L` and backticks — all of which are valid in the Jython 2.7
 * these scripts actually run under. Letting it contribute would put permanent
 * red squiggles on correct code, which costs more trust than missing a problem.
 *
 * So this module contains no analysis of its own: it converts what the gateway's
 * real Jython parser reported and nothing else.
 */

/** LSP DiagnosticSeverity → CodeMirror severity. */
function severityOf(diagnostic: LspDiagnostic): Diagnostic['severity'] {
  switch (diagnostic.severity) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    // 3 Information and 4 Hint both map to 'info'; CodeMirror has no separate
    // hint level, and rendering a hint as a warning would overstate it.
    default:
      return 'info';
  }
}

/**
 * Convert one LSP diagnostic to a CodeMirror one.
 *
 * Returns null when the range cannot be placed in the current document — which
 * happens legitimately, because a diagnostic describes the buffer as it was when
 * the server parsed it and the user has kept typing. Dropping it beats throwing
 * inside a view update, which would take the editor down.
 */
export function toCodeMirrorDiagnostic(
  view: EditorView,
  diagnostic: LspDiagnostic
): Diagnostic | null {
  const doc = view.state.doc;
  try {
    const from = positionToOffset(doc, diagnostic.range.start);
    let to = positionToOffset(doc, diagnostic.range.end);
    if (to < from) {
      to = from;
    }
    // A zero-width range renders as nothing at all. Widen it by one character so
    // the problem is actually visible; the server already tries to do this, and
    // this is the backstop for when the buffer has since shrunk.
    if (to === from) {
      to = Math.min(doc.length, from + 1);
    }
    return {
      from: Math.min(from, doc.length),
      to: Math.min(to, doc.length),
      severity: severityOf(diagnostic),
      source: diagnostic.source,
      message: diagnostic.message,
    };
  } catch {
    return null;
  }
}

/**
 * Subscribe a view to its document's diagnostics. Returns an unsubscribe function.
 */
export function attachDiagnostics(
  view: EditorView,
  client: LspClient,
  uri: string
): () => void {
  return client.onDiagnostics(uri, (diagnostics) => {
    const mapped = diagnostics
      .map((diagnostic) => toCodeMirrorDiagnostic(view, diagnostic))
      .filter((diagnostic): diagnostic is Diagnostic => diagnostic !== null);
    view.dispatch(setDiagnostics(view.state, mapped));
  });
}
