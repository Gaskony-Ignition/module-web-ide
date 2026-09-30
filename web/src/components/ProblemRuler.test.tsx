import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LspClient, LspDiagnostic } from '../api/lspClient';
import type { OpenDoc } from '../workspace/documents';
import ProblemRuler, {
  geometryOffset, markOffset, severityName, worstSeverity,
} from './ProblemRuler';

function doc(text: string, partial: Partial<OpenDoc> = {}): OpenDoc {
  return {
    kind: 'script',
    uri: 'P::ignition/script-python/util/helpers::code.py',
    project: 'P',
    path: 'ignition/script-python/util/helpers',
    scriptKey: 'code.py',
    typeLabel: 'Project Library',
    label: 'helpers',
    origin: 'local',
    etag: 'sig',
    baseText: text,
    text,
    overridden: false,
    ...partial,
  };
}

function diagnostic(line: number, message: string, severity = 1): LspDiagnostic {
  return {
    range: { start: { line, character: 4 }, end: { line, character: 9 } },
    message,
    severity,
    source: 'jython',
  };
}

/** A client whose subscribe replays `known` at once, as the real one does. */
function fakeLsp(known: LspDiagnostic[]) {
  const listeners: Array<(d: LspDiagnostic[]) => void> = [];
  const client = {
    onDiagnostics: vi.fn((_uri: string, listener: (d: LspDiagnostic[]) => void) => {
      listeners.push(listener);
      listener(known);
      return () => {};
    }),
  } as unknown as LspClient;
  return { client, push: (d: LspDiagnostic[]) => listeners.forEach((l) => l(d)) };
}

describe('markOffset', () => {
  it('places the first line at the top and the last at the bottom', () => {
    expect(markOffset(0, 100)).toBe(0);
    expect(markOffset(99, 100)).toBe(100);
  });

  it('is proportional to the DOCUMENT, not the viewport', () => {
    // The point of a ruler is a problem that is scrolled off screen.
    expect(markOffset(50, 101)).toBe(50);
  });

  it('never divides by zero on an empty buffer', () => {
    expect(markOffset(0, 0)).toBe(0);
    expect(markOffset(0, 1)).toBe(0);
  });

  it('clamps a stale line number past the end', () => {
    // A diagnostic describes the buffer as it was when the server parsed it;
    // the user may have deleted lines since.
    expect(markOffset(500, 10)).toBe(100);
  });
});

describe('geometryOffset', () => {
  it('divides by the PANE when the document does not fill it', () => {
    // The 1.8.7 defect (Nigel, 04/09/2026: the mark "seems to just appear
    // randomly"). A 28-line script fills about 530px of an 819px pane, so
    // line-count arithmetic drew the last line's mark at the bottom of the
    // ruler while the code sat two thirds up. Dividing by the pane puts the
    // mark exactly beside its line.
    expect(geometryOffset(530, 530, 819)).toBe(64.71);
    expect(geometryOffset(0, 530, 819)).toBe(0);
  });

  it('divides by the CONTENT when the document is taller than the pane', () => {
    // Then the ruler represents the whole file, which is the point of one.
    expect(geometryOffset(1000, 4000, 800)).toBe(25);
    expect(geometryOffset(4000, 4000, 800)).toBe(100);
  });

  it('refuses geometry it cannot use rather than dividing by zero', () => {
    expect(geometryOffset(10, 0, 0)).toBeNull();
    expect(geometryOffset(Number.NaN, 100, 100)).toBeNull();
  });

  it('clamps a line measured past the end of the content', () => {
    expect(geometryOffset(9999, 100, 100)).toBe(100);
    expect(geometryOffset(-20, 100, 100)).toBe(0);
  });
});

describe('severity helpers', () => {
  it('names the four LSP levels', () => {
    expect([1, 2, 3, 4, undefined].map(severityName))
      .toEqual(['error', 'warning', 'info', 'hint', 'hint']);
  });

  it('takes the worst of a group, where error is worst', () => {
    expect(worstSeverity([diagnostic(1, 'a', 3), diagnostic(1, 'b', 1)])).toBe(1);
    expect(worstSeverity([])).toBe(4);
  });
});

describe('ProblemRuler', () => {
  it('draws nothing for a document with no problems, and says so', () => {
    const { client } = fakeLsp([]);
    render(<ProblemRuler doc={doc('x = 1\n')} lsp={client} onSelect={vi.fn()} />);
    expect(screen.getByRole('group')).toHaveAccessibleName('No problems in this script');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('draws a mark per problem line, from diagnostics replayed on subscribe', () => {
    // Replayed, not waited for: a ruler that only showed problems published
    // AFTER it mounted would be blank for every document opened before the
    // panel — the same trap the Problems panel comment records.
    const { client } = fakeLsp([diagnostic(2, 'bad'), diagnostic(7, 'worse')]);
    render(<ProblemRuler doc={doc('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n')} lsp={client} onSelect={vi.fn()} />);
    const marks = screen.getAllByRole('button', { name: /on line/ });
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveAccessibleName('error on line 3: bad');
    expect(marks[1]).toHaveAccessibleName('error on line 8: worse');
  });

  it('merges several problems on one line into one mark carrying the worst severity', () => {
    // Three marks at identical offsets read as one mark with a dirty edge, and
    // the tooltip shows whichever happened to be on top.
    const { client } = fakeLsp([
      diagnostic(3, 'a warning', 2),
      diagnostic(3, 'an error', 1),
    ]);
    render(<ProblemRuler doc={doc('1\n2\n3\n4\n5\n')} lsp={client} onSelect={vi.fn()} />);
    const marks = screen.getAllByRole('button', { name: /on line/ });
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveClass('is-error');
    expect(marks[0]).toHaveAccessibleName('error on line 4: a warning\nan error');
  });

  it('prefers the editor\'s measured geometry over the line count', () => {
    // Both are available here and they disagree; the measured one must win, or
    // the fix for "appears randomly" is only in the helper and not in the UI.
    const { client } = fakeLsp([diagnostic(5, 'x')]);
    render(
      <ProblemRuler
        doc={doc('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n')}
        lsp={client}
        onSelect={vi.fn()}
        offsetOfLine={() => 12.5}
      />
    );
    const slot = document.querySelector('.problem-ruler-slot') as HTMLElement;
    expect(slot.style.top).toBe('12.5%');
  });

  it('falls back to the line count when the editor cannot be measured', () => {
    // A view that has not laid out yet returns null rather than a wrong number.
    const { client } = fakeLsp([diagnostic(5, 'x')]);
    render(
      <ProblemRuler
        doc={doc('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n')}
        lsp={client}
        onSelect={vi.fn()}
        offsetOfLine={() => null}
      />
    );
    const slot = document.querySelector('.problem-ruler-slot') as HTMLElement;
    // 12 lines, not 11: the trailing newline makes a final empty one, exactly
    // as CodeMirror counts it. Line 5 of 12 is 5/11.
    expect(slot.style.top).toBe('45.45%');
  });

  it('reports the caret position of the problem when a mark is clicked', () => {
    const { client } = fakeLsp([diagnostic(4, 'boom')]);
    const onSelect = vi.fn();
    render(<ProblemRuler doc={doc('1\n2\n3\n4\n5\n6\n')} lsp={client} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /on line 5/ }));
    expect(onSelect).toHaveBeenCalledWith(4, 4);
  });

  it('shows the message in a card with a copy button', () => {
    const { client } = fakeLsp([diagnostic(0, 'no viable alternative')]);
    render(<ProblemRuler doc={doc('x = = 1\n')} lsp={client} onSelect={vi.fn()} />);
    // `hidden: true` because vitest loads the stylesheet (css: true) and the
    // card is display:none until its slot is hovered — which jsdom cannot do.
    // What is asserted is that the card and its copy button EXIST with the
    // right content; the hover is CSS and is exercised by the live suite.
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('no viable alternative');
    expect(screen.getByRole('button', { name: 'Copy', hidden: true })).toBeInTheDocument();
  });

  it('copies the message text, not the label around it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { client } = fakeLsp([diagnostic(0, 'copy me')]);
    render(<ProblemRuler doc={doc('x\n')} lsp={client} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy', hidden: true }));
    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(await screen.findByRole('button', { name: 'Copied', hidden: true })).toBeInTheDocument();
  });

  it('follows a new publish, so a fix removes its mark', () => {
    const { client, push } = fakeLsp([diagnostic(1, 'x')]);
    render(<ProblemRuler doc={doc('a\nb\nc\n')} lsp={client} onSelect={vi.fn()} />);
    expect(screen.getAllByRole('button', { name: /on line/ })).toHaveLength(1);
    // The publish arrives from the socket, outside React's event system, so
    // the state update has to be flushed explicitly here.
    act(() => push([]));
    expect(screen.queryAllByRole('button', { name: /on line/ })).toHaveLength(0);
  });

  it('is PRESENT for a named query — it carries its own parser\'s problems', () => {
    // Reversed at 1.14.0. It used to be gated on isPythonDoc, which was right
    // while the Jython server was the only source of diagnostics: a query's SQL
    // is not Python and the server holds no document for it, so the ruler had
    // nothing to draw and hid itself.
    //
    // Since 1.14.0 a non-Python document is linted by its OWN language's parser
    // and publishes into the same store (see syntaxLint), so the ruler must
    // subscribe for every document — gating it left a blank strip beside a file
    // that had a squiggle in it.
    const { client } = fakeLsp([diagnostic(0, 'x')]);
    const { container } = render(
      <ProblemRuler doc={doc('SELECT 1', { kind: 'named-query' })} lsp={client} onSelect={vi.fn()} />
    );
    expect(container).not.toBeEmptyDOMElement();
    expect(client.onDiagnostics).toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: /on line/ })).toHaveLength(1);
  });

  it('is absent with no document at all', () => {
    const { container } = render(<ProblemRuler doc={null} lsp={null} onSelect={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
