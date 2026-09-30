import { describe, expect, it } from 'vitest';
import { stampOf, transcriptOf } from './ScriptConsole';

/** ESC, written as an escape so an editor cannot lose it. */
const E = '\x1b';

// The shape ScriptConsole keeps its output in. Built here rather than imported
// because the interface is internal to that module — what is exported, and
// what this file is about, is the pair of pure functions over it.
function entry(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    kind: 'stdout' as const,
    text: 'hello',
    at: new Date(2026, 8, 7, 14, 5, 9, 42).getTime(),
    ...over,
  };
}

describe('stampOf', () => {
  it('is a 24-hour clock with milliseconds', () => {
    // Milliseconds because the reason to turn stamps on is usually to see how
    // long something took, and seconds answer that badly in a loop.
    expect(stampOf(entry().at)).toBe('14:05:09.042');
  });

  it('says plainly that it does not know, rather than showing an epoch', () => {
    expect(stampOf(0)).toBe('--:--:--.---');
  });
});

describe('transcriptOf', () => {
  it('names the project and admits whose clock the times are', () => {
    // They are the BROWSER's, and anyone lining this up against a gateway log
    // needs to know that before they conclude the gateway is slow.
    const text = transcriptOf([entry()], 'Mining_Demo');
    expect(text).toContain('# project: Mining_Demo');
    expect(text).toContain("BROWSER's clock");
  });

  it('strips ANSI rather than preserving it', () => {
    // The export is for pasting into a ticket or grepping. Escape bytes in a
    // text file are mojibake everywhere except a terminal.
    const text = transcriptOf([entry({ text: `${E}[31mred${E}[0m` })], 'P');
    expect(text).toContain('red');
    expect(text).not.toContain(E);
  });

  it('stamps every block, whatever the on-screen toggle says', () => {
    // The toggle is about reading the console now; a transcript with no times
    // is much less useful later.
    expect(transcriptOf([entry()], 'P')).toContain('14:05:09.042  hello');
  });

  it('indents continuation lines instead of repeating a time they did not arrive at', () => {
    const text = transcriptOf([entry({ text: 'one\ntwo' })], 'P');
    expect(text).toContain('14:05:09.042  one');
    expect(text).toContain('              two');
    // One stamp for the block, not one per line.
    expect(text.match(/14:05:09\.042/g)).toHaveLength(1);
  });

  it('keeps the run divider as it always read, and exports a folded run in full', () => {
    const text = transcriptOf([
      entry({ kind: 'note', text: 'run 1 · 14:05:09', runHeader: true }),
      entry({ id: 'e2', text: 'inside', run: 'e1' }),
    ], 'P');
    expect(text).toContain('14:05:09.042  ▸ run 1 · 14:05:09');
    expect(text).toContain('inside');
  });

  it('is still a valid file with no output at all', () => {
    const text = transcriptOf([], 'P');
    expect(text).toContain('# project: P');
    expect(text.endsWith('\n')).toBe(true);
  });
});
