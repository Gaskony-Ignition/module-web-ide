/**
 * A real shell on the Gateway, in the browser.
 *
 * The server side attaches the shell to a genuine pty (see `TerminalSession`),
 * so this is a terminal emulator rather than a command runner: `git log` pages
 * nothing, `git add -p` works, arrow keys recall history, and Ctrl-C interrupts
 * the foreground job instead of closing the connection.
 *
 * Three things here are not obvious.
 *
 * **The xterm instance is created once and never re-created.** Its scrollback IS
 * the session's history — rebuilding it on a re-render would silently wipe
 * everything the user had done. So the effect that builds it has no dependencies
 * and the palette is pushed into the live instance afterwards.
 *
 * **The palette is read from CSS custom properties, not hard-coded.** xterm
 * paints on a canvas, so it cannot inherit anything: every colour has to be
 * handed to it as a value. A MutationObserver on `data-theme` re-reads them, or
 * switching theme would leave the terminal wearing the old one.
 *
 * **Fit is driven by ResizeObserver, and the size goes to the server.** Columns
 * are what the shell wraps on; a terminal that looks right and tells the shell
 * the wrong width produces mangled output on every long line.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { sharedTermClient } from '../api/termClient';
import '@xterm/xterm/css/xterm.css';
import './Terminal.css';

export interface TerminalViewProps {
  csrfToken?: string;
  /** False when the session may not open a shell — shows why instead. */
  canOpen: boolean;
  /** Told when the shell ends, so the panel can offer a restart. */
  onExit?: (code: number) => void;
}

/** Read one CSS custom property off the document root. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * The xterm palette, from the theme tokens.
 *
 * The sixteen ANSI slots are the theme's own semantic colours where it has one
 * and a neutral otherwise: a terminal that renders `git status` in colours from
 * a different palette than the editor beside it looks like two applications.
 */
function paletteFromTheme() {
  const fg = token('--text-primary', '#e6e6e6');
  const bg = token('--bg-primary', '#1e1e1e');
  const red = token('--error', '#f87171');
  const green = token('--success', '#4ade80');
  const yellow = token('--warning', '#fbbf24');
  const blue = token('--accent-primary', '#60a5fa');
  const magenta = token('--syntax-type', '#c084fc');
  const cyan = token('--syntax-function', '#22d3ee');
  const dim = token('--text-muted', '#9ca3af');
  return {
    foreground: fg,
    background: bg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: token('--accent-primary-bg', 'rgba(120,160,255,0.3)'),
    black: token('--bg-tertiary', '#2a2a2a'),
    red, green, yellow, blue, magenta, cyan,
    white: fg,
    brightBlack: dim,
    brightRed: red,
    brightGreen: green,
    brightYellow: yellow,
    brightBlue: blue,
    brightMagenta: magenta,
    brightCyan: cyan,
    brightWhite: fg,
  };
}

export default function TerminalView({ csrfToken, canOpen, onExit }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const [error, setError] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'opening' | 'ready' | 'ended'>('idle');
  const [noPty, setNoPty] = useState(false);
  const client = sharedTermClient();

  /** Fit to the host and tell the shell the new size. */
  const syncSize = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    try {
      fit.fit();
    } catch {
      // fit() throws while the host is display:none, which is exactly what a
      // hidden panel tab is. Nothing to do — the next fit after it is shown
      // gets it right.
      return;
    }
    if (idRef.current) {
      client.resize(idRef.current, term.cols, term.rows, csrfToken);
    }
  }, [client, csrfToken]);

  // Build the emulator ONCE. Its scrollback is the session; re-creating it would
  // throw away everything the user has run.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const term = new XTerm({
      fontFamily: token('--font-mono', 'ui-monospace, monospace'),
      // From the same token as the editor, parsed because xterm takes a number:
      // a terminal and an editor in one window disagreeing about a character
      // cell is one of those differences nobody names but everybody notices.
      fontSize: Number.parseFloat(token('--font-size-code', '14px')) || 14,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: paletteFromTheme(),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    return () => {
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Re-read the palette when the theme changes. The canvas cannot inherit, so
  // without this the terminal keeps the colours it was born with.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const term = termRef.current;
      if (term) {
        term.options.theme = paletteFromTheme();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  // Open the shell and wire both directions.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !canOpen) return undefined;

    const unsubscribe = client.subscribe((event) => {
      switch (event.kind) {
        case 'opened':
          idRef.current = event.id;
          setStatus('ready');
          setNoPty(!event.pty);
          syncSize();
          break;
        case 'data':
          if (event.id === idRef.current) {
            term.write(event.bytes);
          }
          break;
        case 'exit':
          if (event.id === idRef.current) {
            idRef.current = null;
            setStatus('ended');
            term.write('\r\n[exited with code ' + event.code + ']\r\n');
            onExit?.(event.code);
          }
          break;
        case 'error':
          setError(event.message);
          setStatus('ended');
          break;
      }
    });

    const typing = term.onData((data) => {
      if (idRef.current) {
        client.input(idRef.current, data, csrfToken);
      }
    });

    setStatus('opening');
    // Fit before opening so the shell is told the right size from its first
    // prompt rather than being resized a frame later.
    try {
      fitRef.current?.fit();
    } catch {
      /* hidden host; the resize after mount corrects it */
    }
    const cancelOpen = client.open(term.cols || 80, term.rows || 24, csrfToken);

    return () => {
      cancelOpen();
      typing.dispose();
      unsubscribe();
      if (idRef.current) {
        client.close(idRef.current, csrfToken);
        idRef.current = null;
      }
    };
  }, [canOpen, client, csrfToken, onExit, syncSize]);

  // Fit on every container change: the panel is resizable, collapsible and
  // shares its height with the editor.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => syncSize());
    observer.observe(host);
    return () => observer.disconnect();
  }, [syncSize]);

  return (
    <div className="terminal-view">
      {!canOpen && (
        <p className="terminal-notice">
          Opening a Gateway terminal requires the Administrator role.
        </p>
      )}
      {error && <p className="terminal-notice is-error">{error}</p>}
      {noPty && (
        <p className="terminal-notice">
          No pseudo-terminal was available on this gateway, so the shell is running on
          plain pipes: there is no prompt and interactive programs will not work.
        </p>
      )}
      {status === 'ended' && !error && (
        <p className="terminal-notice">
          This shell has ended. Use the panel&apos;s ✚ button for a new one.
        </p>
      )}
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
