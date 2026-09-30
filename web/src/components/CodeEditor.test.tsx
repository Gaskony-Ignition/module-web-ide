import { EditorView } from '@codemirror/view';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import CodeEditor from './CodeEditor';
import type { OpenDoc } from '../workspace/documents';

/**
 * A body in the shape the real Designer writes it: tab indentation, and NO
 * terminating newline. Both halves of that are invariants — if the editor
 * normalises either, every later git diff of the project is noise.
 */
const DESIGNER_SOURCE =
  'def compute(values):\n' +
  '\ttotal = 0\n' +
  '\tfor value in values:\n' +
  '\t\tif value > 0:\n' +
  '\t\t\ttotal += value\n' +
  '\treturn total';

function doc(overrides: Partial<OpenDoc> = {}): OpenDoc {
  return {
    // Every document was a script before 1.7.0, and these cases still are.
    kind: 'script',
    uri: 'P::ignition/script-python/util/helpers',
    project: 'P',
    path: 'ignition/script-python/util/helpers',
    scriptKey: 'code.py',
    typeLabel: 'Project Library',
    label: 'helpers',
    origin: 'local',
    etag: 'sig-1',
    baseText: DESIGNER_SOURCE,
    text: DESIGNER_SOURCE,
    overridden: false,
    ...overrides,
  };
}

/** The live CodeMirror view for the visible document. */
function activeView(): EditorView {
  const host = document.querySelector<HTMLElement>('.code-editor-host .cm-editor');
  const view = host ? EditorView.findFromDOM(host) : null;
  if (!view) throw new Error('no EditorView mounted');
  return view;
}

describe('CodeEditor byte fidelity', () => {
  it('round-trips tabs and a missing trailing newline through the editor', () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    );

    const view = activeView();
    // The document as loaded is already byte-identical.
    expect(view.state.doc.toString()).toBe(DESIGNER_SOURCE);

    // Edit it the way a user would, then assert on the EXACT string the save
    // path would POST. This is the single most important assertion in P1.
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\t# tail' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    const [, saved] = onChange.mock.calls[0] as [string, string];
    expect(saved).toBe(DESIGNER_SOURCE + '\n\t# tail');
    expect(saved.endsWith('\n')).toBe(false);
    expect(saved).not.toContain('    ');
  });

  it('preserves CRLF line endings instead of rewriting them to LF', () => {
    // CodeMirror's default lineSeparator splits on CR, LF and CRLF and rejoins
    // with LF — so without the pinned separator, merely opening and saving a
    // CRLF file rewrites every line of it.
    const crlf = 'a = 1\r\nb = 2';
    const onChange = vi.fn();
    render(
      <CodeEditor
        docs={[doc({ baseText: crlf, text: crlf })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    );
    expect(activeView().state.doc.toString()).toBe(crlf);
  });

  it('preserves a trailing newline when the file genuinely has one', () => {
    const withNewline = 'x = 1\n';
    render(
      <CodeEditor
        docs={[doc({ baseText: withNewline, text: withNewline })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(activeView().state.doc.toString()).toBe(withNewline);
  });
});

describe('CodeEditor keys', () => {
  it('inserts a literal tab on Tab, never spaces', () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        docs={[doc({ baseText: '', text: '' })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    );
    const view = activeView();
    fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(view.state.doc.toString()).toBe('\t');
  });

  it('auto-indents with a tab after a colon', () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        docs={[doc({ baseText: 'if True:', text: 'if True:' })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    );
    const view = activeView();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    fireEvent.keyDown(view.contentDOM, { key: 'Enter', code: 'Enter', keyCode: 13 });
    expect(view.state.doc.toString()).toBe('if True:\n\t');
  });

  it('saves on Ctrl+S and does not let the browser handle it', () => {
    const onSave = vi.fn();
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={onSave}
      />
    );
    const view = activeView();
    const handled = fireEvent.keyDown(view.contentDOM, { key: 's', code: 'KeyS', ctrlKey: true });
    expect(onSave).toHaveBeenCalledWith(doc().uri);
    // fireEvent returns false when a handler called preventDefault.
    expect(handled).toBe(false);
  });
});

describe('CodeEditor view lifecycle', () => {
  const first = doc();
  const second = doc({
    uri: 'P::ignition/timer/Poller',
    path: 'ignition/timer/Poller',
    label: 'Poller',
    baseText: 'poll()',
    text: 'poll()',
  });

  it('keeps one mounted view per document and hides the inactive ones', () => {
    const { rerender } = render(
      <CodeEditor
        docs={[first, second]}
        activeUri={first.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    const hosts = () =>
      Array.from(document.querySelectorAll<HTMLElement>('.code-editor-host'));
    expect(hosts()).toHaveLength(2);
    expect(hosts().map((h) => h.style.display)).toEqual(['block', 'none']);

    rerender(
      <CodeEditor
        docs={[first, second]}
        activeUri={second.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    // Still two views: switching tabs hides one and shows the other rather than
    // swapping a single view's state, so scroll position and undo history live.
    expect(hosts()).toHaveLength(2);
    expect(hosts().map((h) => h.style.display)).toEqual(['none', 'block']);
  });

  it('destroys the view when its document is closed', () => {
    const { rerender } = render(
      <CodeEditor
        docs={[first, second]}
        activeUri={first.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    rerender(
      <CodeEditor
        docs={[first]}
        activeUri={first.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(document.querySelectorAll('.code-editor-host')).toHaveLength(1);
  });

  it('refuses edits when read-only', () => {
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const view = activeView();
    expect(view.state.readOnly).toBe(true);
    fireEvent.keyDown(view.contentDOM, { key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(view.state.doc.toString()).toBe(DESIGNER_SOURCE);
  });

  it('adopts text changed outside the editor, such as a conflict reload', () => {
    const original = doc();
    const { rerender } = render(
      <CodeEditor
        docs={[original]}
        activeUri={original.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const theirs = 'their\tversion';
    rerender(
      <CodeEditor
        docs={[{ ...original, text: theirs, baseText: theirs }]}
        activeUri={original.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(activeView().state.doc.toString()).toBe(theirs);
  });
});

describe('CodeEditor container', () => {
  it('renders its host element even with nothing open', () => {
    render(
      <CodeEditor docs={[]} activeUri={null} readOnly={false} onChange={vi.fn()} onSave={vi.fn()} />
    );
    expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    expect(document.querySelectorAll('.code-editor-host')).toHaveLength(0);
  });
});

/**
 * Inheritance is a per-DOCUMENT read-only, not a per-session one.
 *
 * Measured off the real 8.3.8 Designer (01/09/2026): an inherited Project
 * Library script opens through `Open read-only` with the header
 * `Chart  (Read-Only)`, and typing into it changes nothing — I typed four
 * characters and the buffer was byte-identical. `Override Resource` is what
 * makes it writable.
 *
 * These are here rather than in a workspace test because the failure they guard
 * is invisible above CodeMirror: `EditorState.readOnly` is ADVISORY, so a view
 * that was never given the extension accepts a dispatch quite happily and the
 * only place the truth exists is the view's own state.
 */
describe('CodeEditor inheritance lock', () => {
  it('refuses edits to an inherited document even when the session may write', () => {
    render(
      <CodeEditor
        docs={[doc({ origin: 'inherited' })]}
        activeUri="P::ignition/script-python/util/helpers"
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(activeView().state.readOnly).toBe(true);
  });

  it('unlocks that document once it is overridden', () => {
    render(
      <CodeEditor
        docs={[doc({ origin: 'inherited', overridden: true })]}
        activeUri="P::ignition/script-python/util/helpers"
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(activeView().state.readOnly).toBe(false);
  });

  it('unlocks ONLY the overridden document, not every open tab', () => {
    const inherited = doc({
      uri: 'P::ignition/script-python/a',
      path: 'ignition/script-python/a',
      origin: 'inherited',
    });
    const overridden = doc({
      uri: 'P::ignition/script-python/b',
      path: 'ignition/script-python/b',
      origin: 'inherited',
      overridden: true,
    });
    const { rerender } = render(
      <CodeEditor
        docs={[inherited, overridden]}
        activeUri="P::ignition/script-python/a"
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    // Re-render so the reconfigure effect runs over both views, which is the
    // path a real override takes: the doc object is replaced, not remounted.
    rerender(
      <CodeEditor
        docs={[inherited, { ...overridden }]}
        activeUri="P::ignition/script-python/a"
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const views = Array.from(document.querySelectorAll<HTMLElement>('.code-editor-host .cm-editor'))
      .map((host) => EditorView.findFromDOM(host))
      .filter((view): view is EditorView => view !== null);
    expect(views).toHaveLength(2);
    expect(views.map((view) => view.state.readOnly)).toEqual([true, false]);
  });

  it('keeps a session-wide read-only in force over an override', () => {
    // Overriding is a resource decision; it cannot hand write access to a user
    // who has none. Both inputs are ANDed, and this is the one that must win.
    render(
      <CodeEditor
        docs={[doc({ origin: 'inherited', overridden: true })]}
        activeUri="P::ignition/script-python/util/helpers"
        readOnly
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(activeView().state.readOnly).toBe(true);
  });
});

// ============================ navigation (1.6.0) ============================

/** Every mounted view, in DOM order. */
function allViews(): EditorView[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.code-editor-host .cm-editor'))
    .map((host) => EditorView.findFromDOM(host))
    .filter((view): view is EditorView => view !== null);
}

function reveal(detail: { line: number; character?: number; uri?: string }) {
  act(() => {
    window.dispatchEvent(new CustomEvent('scriptide:reveal', { detail }));
  });
}

describe('CodeEditor reveal', () => {
  it('moves the caret in the active view when no uri is given', () => {
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    reveal({ line: 2, character: 1 });
    const view = activeView();
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
  });

  it('clamps a line past the end of the buffer instead of throwing', () => {
    // The symbol table can be a moment behind the buffer, and CodeMirror throws
    // rather than saturating when asked for a line that is not there.
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    reveal({ line: 9_999 });
    const view = activeView();
    expect(view.state.doc.lineAt(view.state.selection.main.head).number)
      .toBe(view.state.doc.lines);
  });

  it('moves the view NAMED by the event, not whichever tab is showing', () => {
    const other = doc({
      uri: 'P::ignition/script-python/util/parsing',
      path: 'ignition/script-python/util/parsing',
      label: 'parsing',
    });
    render(
      <CodeEditor
        docs={[doc(), other]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    reveal({ line: 4, uri: other.uri });
    const [first, second] = allViews();
    expect(first.state.selection.main.head).toBe(0);
    expect(second.state.doc.lineAt(second.state.selection.main.head).number).toBe(5);
  });

  it('REMEMBERS a reveal for a view that does not exist yet, and applies it on arrival', () => {
    // Every cross-file jump opens a script and then asks for a line in it, and
    // the open is React state — the view is created by an effect on the NEXT
    // render, which has not run when the caller's await resolves. Dropping the
    // reveal here is what made a clicked traceback frame land on line 1 with
    // nothing saying why.
    const other = doc({
      uri: 'P::ignition/script-python/util/parsing',
      path: 'ignition/script-python/util/parsing',
      label: 'parsing',
    });
    const view = render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    reveal({ line: 3, uri: other.uri });
    view.rerender(
      <CodeEditor
        docs={[doc(), other]}
        activeUri={other.uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const second = allViews()[1];
    expect(second.state.doc.lineAt(second.state.selection.main.head).number).toBe(4);
  });
});

describe('CodeEditor folding and go-to-line', () => {
  it('renders a fold gutter beside the line numbers', () => {
    // A file is where folding earns a gutter column; the console shares
    // pythonSurface and deliberately does not get one.
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(document.querySelector('.cm-foldGutter')).not.toBeNull();
  });

  it('binds Ctrl+G to go-to-line', () => {
    // CodeMirror's own searchKeymap binds gotoLine to Mod-Alt-g, which nobody
    // arrives here knowing.
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    const view = activeView();
    fireEvent.keyDown(view.contentDOM, { key: 'g', ctrlKey: true });
    // The command opens CodeMirror's own panel, which is the observable effect.
    expect(document.querySelector('.cm-panel')).not.toBeNull();
  });
});
