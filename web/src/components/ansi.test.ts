import { describe, expect, it } from 'vitest';
import { hasAnsi, parseAnsi, type AnsiSpan } from './ansi';

/** ESC, written as an escape rather than a byte so an editor cannot lose it. */
const E = '\x1b';

const texts = (spans: AnsiSpan[]) => spans.map((s) => s.text);

describe('hasAnsi', () => {
  it('is false for text that merely contains a bracket', () => {
    // The failure this guards: an ordinary `rows[0]` is not an escape, and a
    // parser that thought it was would silently eat part of the line.
    expect(hasAnsi('rows[0] = 1')).toBe(false);
    expect(hasAnsi('[default]Tank/Level')).toBe(false);
  });

  it('is true only when the escape byte is there', () => {
    expect(hasAnsi(`${E}[32mgreen${E}[0m`)).toBe(true);
  });
});

describe('parseAnsi', () => {
  it('returns one plain span for text with no escapes', () => {
    const spans = parseAnsi('just text');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toEqual({ text: 'just text' });
  });

  it('leaves a bracket that is not an escape alone', () => {
    expect(texts(parseAnsi('rows[0] and [default]Tank'))).toEqual(['rows[0] and [default]Tank']);
  });

  it('colours a run and stops at the reset', () => {
    const spans = parseAnsi(`before ${E}[31mred${E}[0m after`);
    expect(texts(spans)).toEqual(['before ', 'red', ' after']);
    expect(spans[1].color).toBe('var(--ansi-red)');
    expect(spans[0].color).toBeUndefined();
    expect(spans[2].color).toBeUndefined();
  });

  it('reads the bright range as its own eight colours', () => {
    expect(parseAnsi(`${E}[92mx`)[0].color).toBe('var(--ansi-bright-green)');
  });

  it('carries bold, italic and underline', () => {
    const [span] = parseAnsi(`${E}[1;3;4mx`);
    expect(span.bold).toBe(true);
    expect(span.italic).toBe(true);
    expect(span.underline).toBe(true);
  });

  it('turns bold off again without resetting the colour', () => {
    const spans = parseAnsi(`${E}[1;31mbold${E}[22mplain`);
    expect(spans[0].bold).toBe(true);
    expect(spans[1].bold).toBeUndefined();
    expect(spans[1].color).toBe('var(--ansi-red)');
  });

  it('reads a 24-bit colour as one code, not as several', () => {
    // The mistake this catches: treating `38;2;255;136;0` as separate SGR codes
    // gives bold plus two colours plus nothing, and the text comes out wrong.
    const [span] = parseAnsi(`${E}[38;2;255;136;0mx`);
    expect(span.color).toBe('rgb(255, 136, 0)');
    expect(span.bold).toBeUndefined();
  });

  it('reads a 256-colour escape from each part of the palette', () => {
    expect(parseAnsi(`${E}[38;5;1mx`)[0].color).toBe('var(--ansi-red)');
    expect(parseAnsi(`${E}[38;5;9mx`)[0].color).toBe('var(--ansi-bright-red)');
    expect(parseAnsi(`${E}[38;5;196mx`)[0].color).toBe('rgb(255, 0, 0)');
    expect(parseAnsi(`${E}[38;5;244mx`)[0].color).toBe('rgb(128, 128, 128)');
  });

  it('sets a background separately from a foreground', () => {
    const [span] = parseAnsi(`${E}[31;44mx`);
    expect(span.color).toBe('var(--ansi-red)');
    expect(span.background).toBe('var(--ansi-blue)');
  });

  it('treats a bare ESC[m as a reset', () => {
    const spans = parseAnsi(`${E}[31mred${E}[mplain`);
    expect(spans[1].color).toBeUndefined();
  });

  it('drops a cursor move rather than printing it', () => {
    // A library that thinks it is talking to a terminal emits these. Showing
    // `[2K` mid-line is worse than showing nothing.
    expect(texts(parseAnsi(`one${E}[2Ktwo${E}[1;1Hthree`))).toEqual(['onetwothree']);
  });

  it('merges neighbouring runs that share a style', () => {
    // Otherwise a reset between every word gives one span per word, and the
    // DOM fills with spans that all look the same.
    const spans = parseAnsi(`${E}[0mone${E}[0mtwo${E}[0mthree`);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe('onetwothree');
  });

  it('keeps its position across calls', () => {
    // The regex is module-level and global, so a leftover lastIndex would make
    // the second call start halfway through its own input.
    const first = parseAnsi(`${E}[31ma${E}[0m`);
    const second = parseAnsi(`${E}[31ma${E}[0m`);
    expect(second).toEqual(first);
  });

  it('survives a truncated escape at the end of a chunk', () => {
    // Streamed output is chunked, so half an escape really does arrive.
    expect(texts(parseAnsi(`text${E}[3`))).toEqual([`text${E}[3`]);
  });

  it('is safe on an empty string', () => {
    expect(parseAnsi('')).toEqual([{ text: '' }]);
  });
});
