/**
 * ANSI SGR escapes → styled spans, for the console's output blocks.
 *
 * The terminal does not need this — xterm.js interprets ANSI itself — but the
 * console renders its output as plain text in a `<pre>`, so a `cprint` from a
 * script would otherwise show its escape bytes. This is the smallest parser that
 * covers what `cprint` and `jsonPrint` emit plus what a person's own escapes are
 * likely to be.
 *
 * **Every other CSI sequence is consumed and dropped, not printed.** A cursor
 * move or an erase-line from a library that thinks it is talking to a terminal
 * has no meaning in a scrollback block, and showing `[2K` in the middle of a
 * line is worse than showing nothing.
 *
 * The sixteen named colours resolve to CSS custom properties so a theme can move
 * them. A 256-colour or 24-bit escape carries its own value, so it becomes an
 * inline colour — that is data the page was handed, not a design decision.
 */

/** One run of text that shares a style. */
export interface AnsiSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** A CSS colour: a `var(--ansi-…)` reference, or an `rgb(…)` from an escape. */
  color?: string;
  background?: string;
}

const NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
] as const;

/** 30-37 and 90-97, and their background twins. */
function named(index: number, bright: boolean): string {
  return `var(--ansi-${bright ? 'bright-' : ''}${NAMES[index]})`;
}

/**
 * One entry of the xterm 256 palette.
 *
 * 0-15 are the named colours, so they follow the theme. 16-231 are a 6×6×6 cube
 * and 232-255 a 24-step grey ramp; both carry their own values and become rgb.
 */
function palette256(n: number): string | undefined {
  if (n < 0 || n > 255) return undefined;
  if (n < 8) return named(n, false);
  if (n < 16) return named(n - 8, true);
  if (n < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const index = n - 16;
    const r = steps[Math.floor(index / 36) % 6];
    const g = steps[Math.floor(index / 6) % 6];
    const b = steps[index % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey}, ${grey}, ${grey})`;
}

interface State {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color?: string;
  background?: string;
}

/**
 * The state a reset returns to.
 *
 * `color` and `background` are listed EXPLICITLY as undefined, and that is not
 * decoration. `Object.assign` copies own enumerable keys, so a blank that simply
 * omitted them would leave a previous colour in place — a reset that turned bold
 * off and left the text red, which is what the first version of this did.
 */
function blank(): State {
  return {
    bold: false, italic: false, underline: false, color: undefined, background: undefined,
  };
}

/**
 * Apply one SGR parameter list to the running state.
 *
 * Extended colours (`38;5;n`, `38;2;r;g;b`) consume the parameters that follow
 * them, which is why this walks an index rather than iterating: treating those
 * as separate codes is how `38;2;255;0;0` comes out as bold-plus-something.
 */
function applySgr(state: State, parameters: number[]): void {
  for (let i = 0; i < parameters.length; i++) {
    const code = parameters[i];
    if (code === 0) {
      Object.assign(state, blank());
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 22) {
      state.bold = false;
    } else if (code === 3) {
      state.italic = true;
    } else if (code === 23) {
      state.italic = false;
    } else if (code === 4) {
      state.underline = true;
    } else if (code === 24) {
      state.underline = false;
    } else if (code >= 30 && code <= 37) {
      state.color = named(code - 30, false);
    } else if (code === 39) {
      state.color = undefined;
    } else if (code >= 90 && code <= 97) {
      state.color = named(code - 90, true);
    } else if (code >= 40 && code <= 47) {
      state.background = named(code - 40, false);
    } else if (code === 49) {
      state.background = undefined;
    } else if (code >= 100 && code <= 107) {
      state.background = named(code - 100, true);
    } else if (code === 38 || code === 48) {
      const foreground = code === 38;
      const mode = parameters[i + 1];
      if (mode === 5) {
        const resolved = palette256(parameters[i + 2]);
        if (foreground) state.color = resolved;
        else state.background = resolved;
        i += 2;
      } else if (mode === 2) {
        const [r, g, b] = [parameters[i + 2], parameters[i + 3], parameters[i + 4]];
        if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
          const value = `rgb(${r}, ${g}, ${b})`;
          if (foreground) state.color = value;
          else state.background = value;
        }
        i += 4;
      }
    }
  }
}

// The ESC is load-bearing, not decoration: matching a bare `[` would treat an
// ordinary `rows[0]` in somebody's output as an escape and swallow it. Written
// as \x1b rather than the byte itself, so an editor or a diff cannot lose it.
// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;]*)([A-Za-z])/g;

/** True when the text has anything worth parsing, so the common case stays cheap. */
export function hasAnsi(text: string): boolean {
  return text.includes('\x1b[');
}

/**
 * Split text into styled spans.
 *
 * Text with no escapes comes back as a single unstyled span, so a caller can
 * render the result unconditionally without a special case.
 */
export function parseAnsi(text: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  const state = blank();
  let last = 0;

  const push = (chunk: string) => {
    if (!chunk) return;
    const span: AnsiSpan = { text: chunk };
    if (state.bold) span.bold = true;
    if (state.italic) span.italic = true;
    if (state.underline) span.underline = true;
    if (state.color) span.color = state.color;
    if (state.background) span.background = state.background;
    // Merge with the previous span when nothing about the style changed —
    // otherwise a reset between every word makes one span per word.
    const previous = spans[spans.length - 1];
    if (
      previous
      && previous.bold === span.bold
      && previous.italic === span.italic
      && previous.underline === span.underline
      && previous.color === span.color
      && previous.background === span.background
    ) {
      previous.text += chunk;
      return;
    }
    spans.push(span);
  };

  CSI.lastIndex = 0;
  let match = CSI.exec(text);
  while (match !== null) {
    push(text.slice(last, match.index));
    if (match[2] === 'm') {
      const parameters = match[1] === ''
        ? [0]   // a bare `ESC[m` is a reset, the same as `ESC[0m`
        : match[1].split(';').map((part) => (part === '' ? 0 : Number(part)));
      applySgr(state, parameters);
    }
    // Anything else — a cursor move, an erase — is dropped along with its bytes.
    last = match.index + match[0].length;
    match = CSI.exec(text);
  }
  push(text.slice(last));

  return spans.length > 0 ? spans : [{ text: '' }];
}
