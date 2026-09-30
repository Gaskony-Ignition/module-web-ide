/**
 * The Script Console: a scratch buffer that runs on the Gateway.
 *
 * The Designer's console is a REPL against the gateway's script manager, and
 * this is the same thing with an actual editor above it. Four behaviours are
 * deliberate and are the ones worth knowing:
 *
 * **Locals persist between runs, exactly like the Designer's.** The server keys
 * console locals on the ABSENCE of a `target`, so a name bound in one run is
 * still bound in the next. That is what makes it a console rather than a
 * scratch file, and it is also why "Clear output" does not reset them — losing
 * your bindings because you tidied the output would be a nasty surprise. Reset
 * is the control that drops them, which is where the Designer puts it too.
 *
 * **Run selection runs only the selection**, with the preceding lines replaced
 * by blank ones so a traceback still points at the line you can see. The offset
 * is sent so the server can subtract it back off.
 *
 * **Output arrives as it is produced.** The server streams `output` frames and
 * the `finished` frame then carries none of that text — see execClient.ts. So a
 * chunk is APPENDED to the block it continues rather than starting a new one,
 * or a loop printing a hundred lines would render as a hundred blocks.
 *
 * **Stop is best-effort and says so.** Jython's interrupt fires at the next
 * trace point: a busy loop stops in about three seconds, but a `time.sleep(10)`
 * blocked in Java runs its full ten. The button changes its own label rather
 * than pretending the script died.
 *
 * **The console owns its own project, like the Query Browser owns its own
 * datasource.** The `project` prop is only where the picker STARTS — the
 * workspace's current project at mount, or `?project=` in a pop-out — and is
 * never read again after that for Run, Reset, Export or a traceback link; see
 * `selectedProject` below. That is also why this component must never again be
 * keyed on `project` (`key={project}` at its call site): a remount would drop
 * the picker's choice and the running-locals distinction the server keeps per
 * project (see `ScriptIdeSocket.consoleLocals`) the moment the IDE's own
 * project switcher moved, which is the opposite of "independent".
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import RunHistoryDialog from './RunHistoryDialog';
import Resizer from './Resizer';
import { IconChevronDown, IconChevronRight, IconColumns, IconRows } from './Icons';
import {
  rememberChoice,
  rememberWidth,
  storedChoice,
  storedWidth,
} from '../workspace/layoutStore';
import { byteFidelity, editorTheme, findAndReplace, pythonKeymap, pythonSurface } from './editorCore';
import {
  sharedExecClient,
  type ExecError,
  type ExecErrorFrame,
  type ExecEvent,
  type ExecResult,
} from '../api/execClient';
import { fetchProjects, type ProjectSummary } from '../api/scripts';
import { hasAnsi, parseAnsi } from './ansi';
import './ScriptConsole.css';

/** A script file the console can run instead of its own buffer. */
export interface ActiveSource {
  /** Resource path, e.g. `ignition/script-python/util/helpers`. */
  path: string;
  /** What to call it on the button's tooltip and in a traceback frame. */
  label: string;
  /** Read the CURRENT editor text — never a snapshot taken at render time. */
  getSource: () => string;
}

export interface ScriptConsoleProps {
  /** Where the picker STARTS — never read again after mount. See `selectedProject`. */
  project: string;
  csrfToken?: string;
  /** False when the session may not execute; the console renders read-only. */
  canExecute: boolean;
  /** Jump to a traceback frame that resolved to a project script. */
  onOpenFrame?: (path: string, line: number) => void;
  /** Told the picker's current project, so a popped-out tab can name it in its title. */
  onProjectChange?: (project: string) => void;
  /**
   * The file the workspace has open, so "Run file" can run it.
   *
   * Optional: the popped-out console has no editor behind it, and the button is
   * disabled rather than hidden so its absence reads as "nothing open" instead
   * of "this build cannot do that".
   */
  activeSource?: ActiveSource;
}

/** One entry in the output log. Kept as a list so runs stay visually separated. */
interface OutputEntry {
  id: string;
  kind: 'stdout' | 'stderr' | 'note' | 'error';
  text: string;
  error?: ExecError;
  /**
   * The resource a submitted-source frame belongs to, or undefined for a console
   * run. Held per ENTRY, not per component: by the time someone clicks a frame
   * the console may well be running something else.
   */
  sourcePath?: string;
  /** Whether a further chunk of the same stream may be appended to this block. */
  open?: boolean;
  /** This entry opens a run: its header, which folds the run's output. */
  runHeader?: boolean;
  /** The id of the run header this entry belongs to, or undefined between runs. */
  run?: string;
  /**
   * When this block STARTED, epoch millis.
   *
   * Started, not finished: a chunk is appended to an open block as it arrives,
   * so a block's time is when its first byte reached the browser. Re-stamping
   * on each append would make a loop that prints for a minute claim to have
   * printed at the end of it.
   *
   * Browser clock, not the gateway's. It is the only one available here, and
   * the two can differ — which matters if anyone lines these up against a
   * gateway log, so the export says which clock it used.
   */
  at: number;
}

const STARTER = '# Runs on the Gateway. Ctrl+Enter to run, Ctrl+Shift+Enter for the selection.\n';

/**
 * The console's buffer survives a reload, a sign-out, a closed pop-out, OR a
 * change of project: ONE shared draft in this browser, like editor drafts —
 * and like the Query Browser's own `scriptide.query.sql`, which was never
 * per-project either. A script mid-edit is not scoped to whichever project
 * the picker happens to be on; a draft is per VIEWER. Every read and write is
 * wrapped, since localStorage throws in a private window or when full.
 */
const CONSOLE_BUFFER_KEY = 'scriptide.console.buffer';

export function readConsoleBuffer(): string | null {
  try {
    return window.localStorage.getItem(CONSOLE_BUFFER_KEY);
  } catch {
    return null;
  }
}

export function storeConsoleBuffer(text: string): void {
  try {
    if (text === STARTER) {
      window.localStorage.removeItem(CONSOLE_BUFFER_KEY);
    } else {
      window.localStorage.setItem(CONSOLE_BUFFER_KEY, text);
    }
  } catch {
    // Full or blocked storage loses only the autosave, never the run.
  }
}

/** The picker's own remembered choice — separate key, independent of the buffer. */
const PROJECT_KEY = 'scriptide.console.project';

function readStoredProject(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProject(project: string): void {
  try {
    window.localStorage.setItem(PROJECT_KEY, project);
  } catch {
    // Full or blocked storage loses only the remembered choice, never the run.
  }
}

/**
 * One block's arrival time, as a 24-hour clock with milliseconds.
 *
 * Milliseconds because the reason to turn stamps on is usually to see how long
 * something took, and second resolution answers that badly for anything that
 * prints in a loop.
 */
export function stampOf(at: number): string {
  if (!at) return '--:--:--.---';
  const d = new Date(at);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * The whole output as plain text, for the file the Export button hands over.
 *
 * ANSI is STRIPPED, not preserved: the point of the export is something you can
 * paste into a ticket or grep, and escape bytes in a text file render as
 * mojibake everywhere except a terminal. What is on screen in colour is on the
 * page in words.
 *
 * Every line is stamped regardless of the on-screen toggle, and the header says
 * whose clock it is. A transcript with no times is much less useful later, and
 * the toggle is about reading the console now, not about what is worth keeping.
 */
export function transcriptOf(entries: OutputEntry[], project: string): string {
  const header = [
    `# Web IDE console output`,
    `# project: ${project}`,
    `# exported: ${new Date().toISOString()}`,
    `# times are this BROWSER's clock, not the gateway's`,
    '',
  ];
  const body = entries.map((entry) => {
    const raw = entry.runHeader ? `▸ ${entry.text}` : entry.text;
    const text = hasAnsi(raw)
      ? parseAnsi(raw).map((span) => span.text).join('')
      : raw;
    const lines = text.split('\n');
    // The stamp goes on the block, and continuation lines are indented to match
    // rather than repeating a time they did not each arrive at.
    const stamp = stampOf(entry.at);
    const pad = ' '.repeat(stamp.length);
    return lines
      .map((line, index) => `${index === 0 ? stamp : pad}  ${line}`)
      .join('\n');
  });
  return `${header.join('\n')}${body.join('\n')}\n`;
}

/** Where the platform keeps project-library modules. */
const LIBRARY_ROOT = 'ignition/script-python/';

/**
 * How the editor and the output sit relative to each other.
 *
 * `rows` is the original layout and stays the default — it is what the
 * Designer's console does, and a wide short output block is worse for a
 * traceback than a tall narrow one. `columns` exists because a wide monitor
 * running a stacked console wastes most of its width, which is Nigel's
 * complaint (07/09/2026): the two were "fixed at 50/50" and could not be put
 * side by side.
 */
export const ORIENTATIONS = ['rows', 'columns'] as const;
export type ConsoleOrientation = (typeof ORIENTATIONS)[number];

/**
 * The editor's share of the console body, as a percentage.
 *
 * A SHARE, not a pixel count, and that is the whole reason this is not three
 * lines shorter. The popped-out console is a browser tab people resize, and a
 * remembered 620px editor is two thirds of one window and the entire height of
 * the next. A share survives the resize, and it also carries between the docked
 * console and the popped-out one, which are different sizes by construction.
 *
 * Kept per orientation: a split that reads well stacked is not the one that
 * reads well side by side, and sharing one number made switching orientation
 * feel like it had lost the setting.
 */
const SHARE_KEY: Record<ConsoleOrientation, string> = {
  rows: 'console-share-rows',
  columns: 'console-share-columns',
};

/** Today's stacked split, so an existing user sees no change until they drag. */
const DEFAULT_SHARE: Record<ConsoleOrientation, number> = { rows: 45, columns: 55 };

/** Neither pane may be driven to nothing: a zero-height editor cannot be typed in. */
const MIN_SHARE = 15;
const MAX_SHARE = 85;

/** 24-hour local time, for the divider that separates one run from the next. */
function clockTime(): string {
  return new Date().toLocaleTimeString('en-AU', { hour12: false });
}

/** `util.helpers` → `ignition/script-python/util/helpers`. */
export function libraryPathOf(module: string): string {
  return LIBRARY_ROOT + module.replace(/\./g, '/');
}

/**
 * What a frame should be CALLED, and what (if anything) it opens.
 *
 * The server has already decided which frames are which — `libraryModule` for a
 * project-library frame, `isSubmitted` for the source that was just run — so
 * this only spells the answer, it does not re-derive it from filenames.
 */
export function describeFrame(
  frame: ExecErrorFrame,
  sourcePath?: string
): { label: string; path?: string } {
  if (frame.libraryModule) {
    return { label: libraryPathOf(frame.libraryModule), path: libraryPathOf(frame.libraryModule) };
  }
  if (frame.isSubmitted) {
    // A file run knows its own path; a console run has none, and `<console>` is
    // what the server calls it too.
    return { label: sourcePath ?? '<console>', path: sourcePath };
  }
  return { label: frame.file ?? '<unknown>' };
}

export default function ScriptConsole({
  project,
  csrfToken,
  canExecute,
  onOpenFrame,
  onProjectChange,
  activeSource,
}: ScriptConsoleProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** True while the run-history dialog is open. */
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * The console's OWN project, independent of the IDE's — the same shape as the
   * Query Browser's `datasource`. Starts on the remembered choice, or on the
   * `project` prop when nothing is remembered yet; never re-synced from the
   * prop after that, which is what makes it survive the IDE's own project
   * switcher without a remount.
   */
  const [selectedProject, setSelectedProjectState] = useState(
    () => readStoredProject() ?? project
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsError, setProjectsError] = useState('');

  const setSelectedProject = useCallback((name: string) => {
    setSelectedProjectState(name);
    storeProject(name);
  }, []);

  // Fetched once: the project list rarely changes within a session, the same
  // reasoning QueryBrowser gives for its own datasource fetch.
  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        // The remembered project only survives if this gateway still has it —
        // a stale name left over from a previous gateway, or a project since
        // deleted, falls back to the IDE's own current project instead.
        setSelectedProjectState((current) =>
          list.some((p) => p.name === current) ? current : project);
      })
      .catch((e: unknown) => {
        if (!cancelled) setProjectsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // Mount-only, deliberately: the picker is independent once mounted, so a
    // later change to the IDE's own `project` prop must not re-run this and
    // override a choice the user already made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onProjectChange?.(selectedProject);
  }, [selectedProject, onProjectChange]);
  /**
   * Whether each output block is prefixed with the time it arrived.
   *
   * Off by default and remembered per viewer. It is genuinely useful when you
   * are timing something or lining output up against a gateway log, and it is
   * noise the rest of the time — so it is a choice rather than a default.
   */
  const [stamps, setStamps] = useState(
    () => storedChoice('console.timestamps', ['on', 'off'] as const, 'off') === 'on'
  );
  const [entries, setEntries] = useState<OutputEntry[]>([]);
  /** Run headers the user has folded. Every run starts expanded. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  // Read by the export through a ref: the callback is memoised on
  // `selectedProject`, and closing over `entries` would export whatever was on
  // screen at the last time that identity changed.
  const entriesRef = useRef<OutputEntry[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const outputRef = useRef<HTMLDivElement | null>(null);
  /** The flex box holding editor + divider + output, measured along the split. */
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [orientation, setOrientation] = useState<ConsoleOrientation>(
    () => storedChoice('console.orientation', ORIENTATIONS, 'rows')
  );
  const [share, setShare] = useState(
    () => storedWidth(SHARE_KEY[orientation], DEFAULT_SHARE[orientation])
  );
  /**
   * The body's size along the split axis, in px, or 0 when it is not known.
   *
   * Zero is a real state, not a loading one: jsdom measures everything as zero,
   * and so does any environment without `ResizeObserver`. The layout falls back
   * to the CSS shares in that case and the divider is not rendered — a divider
   * that cannot convert a drag into a share would move nothing while looking
   * like it should.
   */
  const [bodySize, setBodySize] = useState(0);

  /** Monotonic, so two entries appended in the same millisecond differ. */
  const nextId = useRef(0);
  /** Which run this is, for the divider. Counts from 1 per mounted console. */
  const runNumber = useRef(0);
  const runStartedAt = useRef(0);
  /** The header id of the run in flight; its output is filed under it. */
  const currentRun = useRef<string | undefined>(undefined);
  /** The resource the in-flight run submitted, or undefined for the console. */
  const runSourcePath = useRef<string | undefined>(undefined);

  entriesRef.current = entries;

  const exec = useMemo(() => sharedExecClient(), []);

  /**
   * Hand the output over as a file.
   *
   * An object URL and a synthetic click, revoked straight after: a data: URL
   * carrying a megabyte of output hits the address-length limit in some
   * browsers, and leaving the object URL alive holds the whole transcript in
   * memory for the life of the page.
   */
  const doExport = useCallback(() => {
    const text = transcriptOf(entriesRef.current, selectedProject);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    link.download = `script-console-${selectedProject}-${now.getFullYear()}`
      + `${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [selectedProject]);

  const append = useCallback((entry: Omit<OutputEntry, 'id' | 'at'>) => {
    if (!entry.text && !entry.error) {
      return;
    }
    // Read now, not in the updater: the run may have ended by the time it runs.
    const run = currentRun.current;
    setEntries((previous) => [
      ...previous,
      { run, ...entry, id: `e${(nextId.current += 1)}`, at: Date.now() },
    ]);
  }, []);

  /**
   * Append streamed output, continuing the previous block where it belongs.
   *
   * A chunk boundary is an artefact of flushing, not of the script — `print` in
   * a loop must not turn into one bordered block per line. So consecutive chunks
   * on the same stream are concatenated into one entry, and anything else (a
   * note, the other stream, the next run's divider) closes it.
   */
  const appendChunk = useCallback((kind: 'stdout' | 'stderr', text: string) => {
    if (!text) {
      return;
    }
    const run = currentRun.current;
    setEntries((previous) => {
      const last = previous[previous.length - 1];
      if (last && last.open && last.kind === kind) {
        const merged = { ...last, text: last.text + text };
        return [...previous.slice(0, -1), merged];
      }
      return [...previous,
        { id: `e${(nextId.current += 1)}`, kind, text, open: true, at: Date.now(), run }];
    });
  }, []);

  // ---- run / stop -------------------------------------------------------

  // Read through a ref inside the keymap: the extensions are built once, so a
  // closure over `running` would freeze at its first value and the Ctrl+Enter
  // binding would keep firing while a script was already running.
  const runRef = useRef<(selectionOnly: boolean) => void>(() => {});

  /**
   * Start a run: the divider, the clock, and the send.
   *
   * `project` is the one THIS run was sent with, captured at the moment it
   * started — not a live read of `selectedProject`, which the picker can
   * move on to a different project before this run even finishes. Named in
   * the header so a scrollback spanning more than one project (the picker is
   * independent now, see the module comment) never leaves a run's project
   * to be guessed.
   */
  const beginRun = useCallback(
    (sent: boolean, project: string, sourcePath?: string) => {
      if (!sent) {
        append({
          kind: 'error',
          text: 'Not connected to the gateway — the run was not sent. '
            + 'The connection retries on its own; try again in a moment.',
        });
        return;
      }
      runNumber.current += 1;
      runStartedAt.current = Date.now();
      runSourcePath.current = sourcePath;
      const header = `e${(nextId.current += 1)}`;
      currentRun.current = header;
      setEntries((previous) => [...previous, {
        id: header, kind: 'note', text: `run ${runNumber.current} · ${project} · ${clockTime()}`,
        runHeader: true, at: Date.now(),
      }]);
      // Optimistic: the server answers `started` almost immediately, but the
      // button must not stay clickable in the gap.
      setRunning('pending');
      setStopping(false);
    },
    [append]
  );

  const doRun = useCallback(
    (selectionOnly: boolean) => {
      const view = viewRef.current;
      if (!view || running || !canExecute) {
        return;
      }
      const doc = view.state.doc;
      let source: string;
      let lineOffset = 0;
      if (selectionOnly) {
        const range = view.state.selection.main;
        if (range.empty) {
          append({ kind: 'note', text: 'Nothing selected.' });
          return;
        }
        // Pad with newlines rather than sending the raw selection, so line
        // numbers in a traceback match what the user is looking at.
        const startLine = doc.lineAt(range.from).number;
        lineOffset = startLine - 1;
        source = '\n'.repeat(lineOffset) + view.state.sliceDoc(range.from, range.to);
      } else {
        source = doc.toString();
      }
      if (!source.trim()) {
        append({ kind: 'note', text: 'Nothing to run.' });
        return;
      }
      beginRun(exec.run({ project: selectedProject, source, csrfToken, lineOffset }), selectedProject);
    },
    [append, beginRun, canExecute, csrfToken, exec, selectedProject, running]
  );

  runRef.current = doRun;

  /**
   * Run the file the workspace has open, not this buffer.
   *
   * Sends a `target`, which is what tells the server this is a file: it then
   * runs against FRESH locals, because a script file is not a REPL.
   */
  const doRunFile = useCallback(() => {
    if (!activeSource || running || !canExecute) {
      return;
    }
    const source = activeSource.getSource();
    if (!source.trim()) {
      append({ kind: 'note', text: `${activeSource.label} is empty.` });
      return;
    }
    beginRun(
      exec.run({
        project: selectedProject, source, csrfToken, target: activeSource.path, lineOffset: 0,
      }),
      selectedProject,
      activeSource.path
    );
  }, [activeSource, append, beginRun, canExecute, csrfToken, exec, selectedProject, running]);

  const doStop = useCallback(() => {
    if (!running || running === 'pending') {
      return;
    }
    setStopping(true);
    exec.stop(running, csrfToken);
  }, [csrfToken, exec, running]);

  /** Drop the console's locals. Refused server-side while a script is running. */
  const doReset = useCallback(() => {
    if (running || !canExecute) {
      return;
    }
    exec.reset(selectedProject, csrfToken);
  }, [canExecute, csrfToken, exec, selectedProject, running]);

  /** Put the console's own cursor on a line — for a frame in the buffer above. */
  const goToConsoleLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
    const target = view.state.doc.line(clamped);
    view.dispatch({
      selection: { anchor: target.from },
      scrollIntoView: true,
    });
    view.focus();
  }, []);

  const openFrame = useCallback(
    (path: string | undefined, line: number) => {
      // A frame in the submitted console source has no resource to open, so the
      // console moves its own cursor instead — the same gesture, locally.
      if (!path) {
        goToConsoleLine(line);
        return;
      }
      onOpenFrame?.(path, line);
    },
    [goToConsoleLine, onOpenFrame]
  );

  // ---- socket subscription ---------------------------------------------

  useEffect(() => {
    return exec.subscribe((event: ExecEvent) => {
      if (event.kind === 'started') {
        setRunning(event.executionId);
        return;
      }
      if (event.kind === 'output') {
        appendChunk(event.stream, event.text);
        return;
      }
      if (event.kind === 'stopping') {
        append({ kind: 'note', text: event.detail || 'Stopping…' });
        return;
      }
      if (event.kind === 'reset') {
        append({ kind: 'note', text: '— reset —' });
        return;
      }
      if (event.kind === 'error') {
        setRunning(null);
        setStopping(false);
        append({ kind: 'error', text: event.message });
        currentRun.current = undefined;
        return;
      }
      if (event.kind === 'finished') {
        setRunning(null);
        setStopping(false);
        appendResult(event.result);
      }
    });

    function appendResult(result: ExecResult) {
      // stdout/stderr here are empty by contract — everything was streamed. They
      // are still read, so a gateway that has not been upgraded yet still shows
      // its output rather than nothing at all.
      if (result.stdout) {
        appendChunk('stdout', result.stdout);
      }
      if (result.stderr) {
        appendChunk('stderr', result.stderr);
      }
      if (result.error) {
        append({
          kind: 'error',
          text: headlineOf(result.error),
          error: result.error,
          sourcePath: runSourcePath.current,
        });
      }
      if (result.truncated) {
        append({
          kind: 'note',
          text: 'Output was truncated — the rest was discarded, not withheld.',
        });
      }
      append({ kind: 'note', text: closingNote(result) });
      currentRun.current = undefined;
    }

    /**
     * `ZeroDivisionError: integer division or modulo by zero`.
     *
     * A syntax error has no frames to carry its position, so the line goes in
     * the headline — it is the only thing the reader can act on.
     */
    function headlineOf(error: ExecError): string {
      const where = error.line === undefined ? '' : ` (line ${error.line})`;
      return `${error.type}: ${error.message}${where}`;
    }

    /** The quiet line that ends a run, so the next one starts somewhere new. */
    function closingNote(result: ExecResult): string {
      if (result.cancelled) {
        return '— stopped —';
      }
      if (!result.ok || result.error) {
        return '— failed —';
      }
      const seconds = Math.max(0, Date.now() - runStartedAt.current) / 1000;
      return `— finished in ${seconds.toFixed(1)} s —`;
    }
  }, [append, appendChunk, exec]);

  // Keep the newest output visible without fighting a user who scrolled up.
  useEffect(() => {
    const node = outputRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    if (nearBottom) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries]);

  // ---- the editor -------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    if (!host || viewRef.current) {
      return;
    }
    const view = new EditorView({
      state: EditorState.create({
        doc: readConsoleBuffer() ?? STARTER,
        extensions: [
          ...pythonSurface,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              // Synchronous, on every change — not debounced. A keystroke
              // followed immediately by a reload must not lose it.
              storeConsoleBuffer(update.state.doc.toString());
            }
          }),
          ...byteFidelity,
          ...findAndReplace,
          // See CodeEditor.tsx for why: role="textbox" with no name is an axe
          // aria-input-field-name failure, and the console has exactly one
          // buffer so its name never needs to change.
          EditorView.contentAttributes.of({ 'aria-label': 'Script Console input' }),
          keymap.of([
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                runRef.current(false);
                return true;
              },
            },
            {
              key: 'Mod-Shift-Enter',
              preventDefault: true,
              run: () => {
                runRef.current(true);
                return true;
              },
            },
          ]),
          pythonKeymap,
          editorTheme,
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // ---- the split ---------------------------------------------------------

  /**
   * Keep `bodySize` equal to the body's extent along the CURRENT split axis.
   *
   * Measured rather than derived from the window: the docked console sits
   * inside a panel the user is also resizing, so the window tells you nothing
   * about how much room the console actually has. `useLayoutEffect` takes the
   * first reading before the browser paints, so the divider is present on the
   * first frame instead of appearing a tick later.
   */
  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return undefined;
    const measure = () => {
      const box = node.getBoundingClientRect();
      setBodySize(orientation === 'rows' ? box.height : box.width);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [orientation]);

  const applyShare = useCallback(
    (next: number, mode: ConsoleOrientation) => {
      const clamped = Math.min(MAX_SHARE, Math.max(MIN_SHARE, Math.round(next)));
      setShare(clamped);
      rememberWidth(SHARE_KEY[mode], clamped);
    },
    []
  );

  const chooseOrientation = useCallback((next: ConsoleOrientation) => {
    setOrientation(next);
    rememberChoice('console.orientation', next);
    // Each orientation carries its OWN remembered share, so switching restores
    // what you last chose there rather than reinterpreting a height as a width.
    setShare(storedWidth(SHARE_KEY[next], DEFAULT_SHARE[next]));
  }, []);

  /**
   * `flex` for the editor pane.
   *
   * A fixed basis in px once the body has been measured, and nothing at all
   * before that — the stylesheet's own `1 1 45%` is the fallback, so a console
   * that has never been measured looks exactly like it did before 1.19.0.
   */
  const editorFlex = bodySize > 0
    ? { flex: `0 0 ${(bodySize * share) / 100}px` }
    : undefined;

  const busy = running !== null;

  return (
    <section className={`console console-${orientation}`} aria-label="Script Console">
      {historyOpen && (
        <RunHistoryDialog
          onClose={() => setHistoryOpen(false)}
          onLoad={(source) => {
            // Into the buffer, not into a run. The Run button stays the user's.
            const view = viewRef.current;
            if (!view) return;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert: source },
            });
            view.focus();
          }}
        />
      )}
      <div className="console-toolbar">
        <button
          type="button"
          className="primary"
          onClick={() => doRun(false)}
          disabled={busy || !canExecute}
          title="Ctrl+Enter"
        >
          {busy ? 'Running…' : 'Run'}
        </button>
        <button
          type="button"
          onClick={() => doRun(true)}
          disabled={busy || !canExecute}
          title="Ctrl+Shift+Enter"
        >
          Run selection
        </button>
        <button
          type="button"
          onClick={doRunFile}
          disabled={busy || !canExecute || !activeSource}
          title={activeSource
            ? `Run ${activeSource.label} on the Gateway, with fresh locals`
            : 'Open a script to run it'}
        >
          Run file
        </button>
        <button type="button" onClick={doStop} disabled={!busy || running === 'pending'}>
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
        {stopping && (
          <span className="console-hint muted">
            (waiting for the script to reach a stopping point)
          </span>
        )}
        <span className="console-spacer" />
        <label className="console-field">
          <span className="console-field-label">Project</span>
          <select
            value={selectedProject}
            onChange={(e) => setSelectedProject(e.target.value)}
            disabled={projects.length === 0}
            title="Scripts run in this project's scope"
          >
            {projects.length === 0 && <option value={selectedProject}>No projects</option>}
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.mutable ? '' : ' (read-only)'}
              </option>
            ))}
          </select>
        </label>
        <div className="console-layout-toggle" role="group" aria-label="Console layout">
          <button
            type="button"
            className={orientation === 'rows' ? 'is-active' : ''}
            aria-pressed={orientation === 'rows'}
            onClick={() => chooseOrientation('rows')}
            title="Output below the editor"
          >
            <IconRows size={16} />
          </button>
          <button
            type="button"
            className={orientation === 'columns' ? 'is-active' : ''}
            aria-pressed={orientation === 'columns'}
            onClick={() => chooseOrientation('columns')}
            title="Output beside the editor"
          >
            <IconColumns size={16} />
          </button>
        </div>
        <button type="button" onClick={() => setHistoryOpen(true)}>
          History
        </button>
        <button
          type="button"
          aria-pressed={stamps}
          className={stamps ? 'is-on' : undefined}
          onClick={() => {
            const next = !stamps;
            setStamps(next);
            rememberChoice('console.timestamps', next ? 'on' : 'off');
          }}
          title="Show the time each block of output arrived"
        >
          Times
        </button>
        <button
          type="button"
          onClick={doExport}
          disabled={entries.length === 0}
          title="Save the output as a text file, with times and without colour codes"
        >
          Export
        </button>
        <button
          type="button"
          onClick={() => {
            setEntries([]);
            setFolded(new Set());
          }}
          disabled={entries.length === 0}
        >
          Clear output
        </button>
        <button
          type="button"
          onClick={() => {
            const view = viewRef.current;
            if (!view) return;
            // An ordinary edit, so Ctrl+Z brings the script back.
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: STARTER } });
            view.focus();
          }}
          title="Start again from an empty script. Ctrl+Z undoes it."
        >
          Clear script
        </button>
        <button
          type="button"
          onClick={doReset}
          disabled={busy || !canExecute}
          title="Forget every variable this console has bound, like the Designer's Reset"
        >
          Reset
        </button>
      </div>

      {!canExecute && (
        <p className="console-denied" role="status">
          Running scripts requires the Administrator role. You can still edit here;
          nothing will be sent to the gateway.
        </p>
      )}
      {projectsError && (
        <p className="console-fetch-error" role="alert">
          Could not load projects: {projectsError}
        </p>
      )}

      {/* Editor, divider and output as ONE flex box, so the divider's arithmetic
          is over a container it can measure. Before 1.19.0 the two panes were
          direct children of `.console`, sharing the box with the toolbar and the
          denied notice — a share computed against that would have counted chrome
          the user cannot drag into. */}
      <div className="console-body" ref={bodyRef}>
        <div className="console-editor" ref={hostRef} style={editorFlex} />

        {bodySize > 0 && (
          <Resizer
            value={(bodySize * share) / 100}
            min={(bodySize * MIN_SHARE) / 100}
            max={(bodySize * MAX_SHARE) / 100}
            // The editor is the pane being sized and it is first, so dragging
            // towards it grows it in either orientation.
            side={orientation === 'rows' ? 'above' : 'left'}
            label={orientation === 'rows'
              ? 'Resize the editor and the output'
              : 'Resize the editor and the output, side by side'}
            onChange={(px) => applyShare((px / bodySize) * 100, orientation)}
          />
        )}

      {/* The output is its own titled panel, not a region below the editor.
          Without the header and the rule it read as more editor, and people
          could not tell where their script stopped and its output began. */}
      <section className="console-output-panel" aria-label="Output">
        <header className="console-output-head">
          <span className="console-output-title">Output</span>
          {running && <span className="console-running" aria-live="polite">running…</span>}
          <span className="console-spacer" />
          <span className="console-output-count muted">
            {entries.length === 0 ? '' : `${entries.length} block${entries.length === 1 ? '' : 's'}`}
          </span>
        </header>
        <div className="console-output" ref={outputRef} aria-live="polite">
          {entries.length === 0 ? (
            <p className="muted console-empty">
              Nothing yet. Ctrl+Enter runs the buffer above on the Gateway.
            </p>
          ) : (
            groupByRun(entries).map(({ header, items }) => {
              const blocks = items.map((entry) => (
                <OutputBlock
                  key={entry.id}
                  entry={entry}
                  stamps={stamps}
                  onOpenFrame={openFrame}
                />
              ));
              if (!header) {
                return blocks;
              }
              const isFolded = folded.has(header.id);
              return (
                <div key={header.id} className="console-run">
                  {stamps && <span className="console-stamp muted">{stampOf(header.at)}</span>}
                  <button
                    type="button"
                    className="console-run-toggle"
                    aria-expanded={!isFolded}
                    aria-controls={`${header.id}-output`}
                    onClick={() => setFolded((previous) => {
                      const next = new Set(previous);
                      if (!next.delete(header.id)) next.add(header.id);
                      return next;
                    })}
                  >
                    <span className="console-run-chevron" aria-hidden="true">
                      {isFolded ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
                    </span>
                    {header.text}
                    {isFolded && items.length > 0 && (
                      <span className="console-run-folded">
                        {` · ${items.length} block${items.length === 1 ? '' : 's'} hidden`}
                      </span>
                    )}
                  </button>
                  <div id={`${header.id}-output`} hidden={isFolded}>
                    {blocks}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
      </div>
    </section>
  );
}

/**
 * The output as runs: each header with the entries filed under it, and anything
 * between runs (a Reset, "Nothing selected.") on its own.
 */
function groupByRun(entries: OutputEntry[]): Array<{ header?: OutputEntry; items: OutputEntry[] }> {
  const groups: Array<{ header?: OutputEntry; items: OutputEntry[] }> = [];
  const byHeader = new Map<string, OutputEntry[]>();
  for (const entry of entries) {
    if (entry.runHeader) {
      const items: OutputEntry[] = [];
      byHeader.set(entry.id, items);
      groups.push({ header: entry, items });
      continue;
    }
    const items = entry.run === undefined ? undefined : byHeader.get(entry.run);
    if (items) {
      items.push(entry);
    } else {
      groups.push({ items: [entry] });
    }
  }
  return groups;
}

function OutputBlock({
  entry,
  stamps,
  onOpenFrame,
}: {
  entry: OutputEntry;
  stamps: boolean;
  onOpenFrame: (path: string | undefined, line: number) => void;
}) {
  return (
    <div className={`console-block console-${entry.kind}`}>
      {/* Outside the <pre>, so a copy of the output does not carry a column of
          times somebody then has to strip out of a bug report. */}
      {stamps && <span className="console-stamp muted">{stampOf(entry.at)}</span>}
      <pre>{hasAnsi(entry.text) ? <AnsiText text={entry.text} /> : entry.text}</pre>
      {entry.error && (
        <Traceback error={entry.error} sourcePath={entry.sourcePath} onOpenFrame={onOpenFrame} />
      )}
    </div>
  );
}

/**
 * Output that carries ANSI colour, as spans.
 *
 * Only reached when the text actually holds an escape — the check is one
 * `includes`, and the overwhelming majority of output has none, so the ordinary
 * case never builds a span list at all.
 *
 * The named colours arrive as `var(--ansi-…)` references and a 24-bit escape as
 * an `rgb(…)`. Both are inline, and deliberately: the second is a value the
 * script chose, which is data rather than a design decision, and the first is
 * already a variable so a theme can still move it.
 */
function AnsiText({ text }: { text: string }) {
  return (
    <>
      {parseAnsi(text).map((span, index) => (
        <span
          // Index keys: the spans are derived from one immutable string and are
          // never reordered or edited, so there is nothing for a stable key to
          // preserve.
          key={index}
          className="console-ansi"
          style={{
            color: span.color,
            backgroundColor: span.background,
            fontWeight: span.bold ? 'bold' : undefined,
            fontStyle: span.italic ? 'italic' : undefined,
            textDecoration: span.underline ? 'underline' : undefined,
          }}
        >
          {span.text}
        </span>
      ))}
    </>
  );
}

/**
 * The traceback, in the shape Python itself prints it.
 *
 * `File "<console>", line 2, in f` is what the Designer shows and what anyone
 * who has read a Python traceback expects — 1.4.3 rendered `<console>, line 2`
 * for every frame with no function name and no exception type at all, because
 * the client was reading field names the server does not send.
 *
 * Frames are extracted structurally by the server, never by regex over rendered
 * text, so a frame either resolves to something openable or it does not. A frame
 * that does not still shows: a traceback with holes in it is worse than one with
 * some unclickable lines.
 *
 * Exported since 1.7.0 for a failed named-query test run, which the server
 * answers with the SAME structured error (NAMED-QUERIES.md §2). Two renderings
 * of one payload would drift, and the one people see less often is the one that
 * would rot.
 */
export function Traceback({
  error,
  sourcePath,
  onOpenFrame,
}: {
  error: ExecError;
  sourcePath?: string;
  onOpenFrame: (path: string | undefined, line: number) => void;
}) {
  // A syntax error has no frames — it never ran — but it does know the line and
  // the column, which is enough to point at.
  const caret = error.text !== undefined && error.offset
    ? `${error.text.replace(/\n$/, '')}\n${' '.repeat(Math.max(0, error.offset - 1))}^`
    : null;

  if (!error.frames || error.frames.length === 0) {
    return (
      <>
        {caret && <pre className="console-caret">{caret}</pre>}
        {!caret && error.rendered && (
          <pre className="console-traceback">{error.rendered}</pre>
        )}
      </>
    );
  }

  return (
    <>
      <ol className="console-frames">
        {error.frames.map((frame, index) => {
          const { label, path } = describeFrame(frame, sourcePath);
          const suffix = frame.function ? `, in ${frame.function}` : '';
          const text = `File "${label}", line ${frame.line}${suffix}`;
          // A submitted-source frame with no resource still navigates — the
          // console moves its own cursor. So every frame we can place is a link.
          const clickable = Boolean(path) || frame.isSubmitted === true;
          return (
            <li key={`${frame.file ?? 'x'}-${frame.line}-${index}`}>
              {clickable ? (
                <button
                  type="button"
                  className="console-frame-link"
                  onClick={() => onOpenFrame(path, frame.line)}
                >
                  {text}
                </button>
              ) : (
                <span className="console-frame">{text}</span>
              )}
            </li>
          );
        })}
      </ol>
      {caret && <pre className="console-caret">{caret}</pre>}
    </>
  );
}
