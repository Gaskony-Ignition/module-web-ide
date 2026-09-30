import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { toCodeMirrorDiagnostic } from './lspDiagnostics';
import type { LspDiagnostic } from '../api/lspClient';

/**
 * Converting server diagnostics into editor markers.
 *
 * The governing rule is that the SERVER is the only source of problems: the
 * client grammar is Python 3 and would flag valid Jython. So these tests are
 * about faithfully rendering what the gateway said, and about degrading safely
 * when the buffer has moved on since it said it.
 */
describe('toCodeMirrorDiagnostic', () => {
  let view: EditorView | null = null;

  function viewFor(text: string): EditorView {
    view = new EditorView({ state: EditorState.create({ doc: text }) });
    return view;
  }

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  const at = (
    startLine: number,
    startChar: number,
    endLine: number,
    endChar: number,
    severity = 1
  ): LspDiagnostic => ({
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    severity,
    source: 'jython',
    message: 'no viable alternative at input =',
  });

  it('maps a range onto the right document offsets', () => {
    const v = viewFor('a = 1\nb = 2\nc = = 3\n');
    const mapped = toCodeMirrorDiagnostic(v, at(2, 4, 2, 7));
    // Line 2 starts at offset 12 ("a = 1\n" is 6, "b = 2\n" is 6).
    expect(mapped).not.toBeNull();
    expect(mapped?.from).toBe(16);
    expect(mapped?.to).toBe(19);
    expect(mapped?.message).toContain('no viable alternative');
    expect(mapped?.source).toBe('jython');
  });

  it('maps LSP severities onto CodeMirror ones', () => {
    const v = viewFor('x = 1\n');
    expect(toCodeMirrorDiagnostic(v, at(0, 0, 0, 1, 1))?.severity).toBe('error');
    expect(toCodeMirrorDiagnostic(v, at(0, 0, 0, 1, 2))?.severity).toBe('warning');
    // 3 Information and 4 Hint both become 'info' — CodeMirror has no hint level,
    // and showing a hint as a warning would overstate it.
    expect(toCodeMirrorDiagnostic(v, at(0, 0, 0, 1, 3))?.severity).toBe('info');
    expect(toCodeMirrorDiagnostic(v, at(0, 0, 0, 1, 4))?.severity).toBe('info');
  });

  it('widens a zero-width range so the marker is actually visible', () => {
    const v = viewFor('x = 1\n');
    const mapped = toCodeMirrorDiagnostic(v, at(0, 2, 0, 2));
    // A from === to range renders as nothing at all.
    expect(mapped?.to).toBeGreaterThan(mapped!.from);
  });

  it('clamps a range that runs past a buffer the user has since shortened', () => {
    // A diagnostic describes the buffer as it was when the server parsed it. The
    // user keeps typing, so a stale range beyond the end is normal, not exotic.
    const v = viewFor('short\n');
    const mapped = toCodeMirrorDiagnostic(v, at(50, 0, 50, 10));
    expect(mapped).not.toBeNull();
    expect(mapped!.from).toBeLessThanOrEqual(v.state.doc.length);
    expect(mapped!.to).toBeLessThanOrEqual(v.state.doc.length);
  });

  it('never returns an inverted range', () => {
    const v = viewFor('a = 1\nb = 2\n');
    const mapped = toCodeMirrorDiagnostic(v, at(1, 4, 0, 0));
    expect(mapped!.to).toBeGreaterThanOrEqual(mapped!.from);
  });
});
