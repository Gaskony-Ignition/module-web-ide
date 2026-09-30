/**
 * Mark the LINE NUMBER of a line that has a problem.
 *
 * Nigel, 04/09/2026, of the overview ruler: *"I intentionally put in a faulted
 * line of code and then the error mark showed up high instead of in line with
 * the actual line of code. I'm wondering if it makes sense to move it to the
 * left side and sync the error display with the line number instead?"*
 *
 * The ruler was not wrong — it maps the WHOLE document, so a fault on line 22
 * of 190 belongs a tenth of the way down whatever is on screen, and that is
 * what VS Code's own overview ruler does too. But it is the only line-level
 * signal the editor had that a reader can see from anywhere, and reading it as
 * if it were aligned to the viewport is the obvious mistake to make. The
 * answer is not to move the ruler; it is to give the line itself a mark, which
 * is what was missing.
 *
 * `lintGutter()` already draws a dot in a gutter of its own, and in the theme's
 * default it is a 3px unstyled speck at the far left edge — present, and not
 * something anyone would find. This adds the signal to the element a reader is
 * already using to locate a line: the number. An error turns it red and bold, a
 * warning amber. Nothing moves and no column is added, so the code does not
 * shift sideways when a diagnostic arrives.
 *
 * `gutterLineClass` puts the class on the gutter element for that line in EVERY
 * gutter, so the CSS scopes itself to `.cm-lineNumbers`; the fold gutter and the
 * lint gutter are left alone.
 */
import { RangeSet, RangeSetBuilder, StateField, type EditorState } from '@codemirror/state';
import { GutterMarker, gutterLineClass } from '@codemirror/view';
import { forEachDiagnostic } from '@codemirror/lint';

const errorLine = new (class extends GutterMarker {
  elementClass = 'cm-lint-line cm-lint-line-error';
})();

const warningLine = new (class extends GutterMarker {
  elementClass = 'cm-lint-line cm-lint-line-warning';
})();

/**
 * The worst diagnostic on each line, as a marker per line.
 *
 * One marker per LINE, not per diagnostic: three problems on one line are one
 * red number, and a RangeSet will not accept two markers at the same position
 * anyway. Error beats warning beats everything else, which is the same
 * precedence the ruler uses.
 */
export function lintLineMarkers(state: EditorState): RangeSet<GutterMarker> {
  const worst = new Map<number, 'error' | 'warning'>();
  forEachDiagnostic(state, (diagnostic, from) => {
    // Clamp: a diagnostic can outlive the edit that invalidated it by a frame,
    // and `lineAt` throws on a position past the end of the document.
    const at = Math.min(Math.max(0, from), state.doc.length);
    const line = state.doc.lineAt(at).number;
    if (diagnostic.severity === 'error') {
      worst.set(line, 'error');
    } else if (diagnostic.severity === 'warning' && worst.get(line) !== 'error') {
      worst.set(line, 'warning');
    }
  });

  const builder = new RangeSetBuilder<GutterMarker>();
  // Ascending, because a RangeSetBuilder requires it and a Map iterates in
  // insertion order — which is the order the server happened to publish in.
  for (const line of [...worst.keys()].sort((a, b) => a - b)) {
    const from = state.doc.line(line).from;
    builder.add(from, from, worst.get(line) === 'error' ? errorLine : warningLine);
  }
  return builder.finish();
}

export const lintLineGutter = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => lintLineMarkers(state),
  // Rebuilt on every transaction rather than on a diagnostic effect: the lint
  // state is a field of its own and its updates are not something this field
  // can subscribe to, and the work is O(diagnostics) over a handful of them.
  update: (_value, transaction) => lintLineMarkers(transaction.state),
  provide: (field) => gutterLineClass.from(field),
});
