/**
 * The console's half of the 1.5.0 execution fixes.
 *
 * These are rendering assertions, not protocol ones — execClient.test.ts already
 * pins the wire. What is asserted here is what a person actually sees: output
 * appearing before the run ends, a traceback that reads like a traceback, one
 * divider per run, and a Reset that says it happened.
 */
import { fireEvent, render, screen, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecError, ExecEvent, RunRequest } from '../api/execClient';
import fixture from '../api/__fixtures__/execError.json';

vi.mock('../api/scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/scripts')>()),
  fetchProjects: vi.fn(),
}));

import { fetchProjects } from '../api/scripts';

/**
 * A stand-in for the shared exec client.
 *
 * Hoisted, because `vi.mock` is lifted above the imports and a factory that
 * closed over an ordinary const would read it before it was assigned.
 */
const harness = vi.hoisted(() => {
  const listeners: Array<(event: ExecEvent) => void> = [];
  const sent: Array<Record<string, unknown>> = [];
  return {
    listeners,
    sent,
    client: {
      subscribe(listener: (event: ExecEvent) => void) {
        listeners.push(listener);
        return () => {
          listeners.splice(listeners.indexOf(listener), 1);
        };
      },
      run(request: RunRequest) {
        sent.push({ action: 'run', ...request });
        return true;
      },
      stop(executionId: string) {
        sent.push({ action: 'stop', executionId });
        return true;
      },
      reset(project: string) {
        sent.push({ action: 'reset', project });
        return true;
      },
    },
  };
});

vi.mock('../api/execClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/execClient')>();
  return { ...actual, sharedExecClient: () => harness.client };
});

const ScriptConsole = (await import('./ScriptConsole')).default;

/** Push one server frame at the mounted console. */
function deliver(event: ExecEvent) {
  act(() => {
    harness.listeners.forEach((listener) => listener(event));
  });
}

function output(): string {
  return screen.getByLabelText('Output').textContent ?? '';
}

function renderConsole(props: Partial<React.ComponentProps<typeof ScriptConsole>> = {}) {
  return render(
    <ScriptConsole project="Demo" csrfToken="t" canExecute {...props} />
  );
}

beforeEach(() => {
  harness.listeners.length = 0;
  harness.sent.length = 0;
  window.localStorage.clear();
  vi.mocked(fetchProjects).mockReset().mockResolvedValue([
    { name: 'Demo', mutable: true },
    { name: 'Other', mutable: true },
  ]);
});

describe('ScriptConsole', () => {
  it('shows streamed output while the run is still going', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    deliver({ kind: 'started', executionId: 'x' });
    deliver({ kind: 'output', executionId: 'x', stream: 'stdout', text: '0\n' });

    // THE assertion for defect 2: this text is on screen with no `finished`
    // frame in sight. On 1.4.3 the pane was empty until the run ended.
    expect(output()).toContain('0');
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();

    deliver({ kind: 'output', executionId: 'x', stream: 'stdout', text: '1\n' });
    // Consecutive chunks of one stream join one block; a chunk boundary is an
    // artefact of flushing, not something the reader should ever see.
    expect(document.querySelectorAll('.console-stdout')).toHaveLength(1);
    expect(document.querySelector('.console-stdout')?.textContent).toBe('0\n1\n');
  });

  it('separates runs with a divider and closes each with its verdict', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(output()).toMatch(/run 1 · Demo · \d{2}:\d{2}:\d{2}/);

    deliver({ kind: 'started', executionId: 'x' });
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: true },
    });
    expect(output()).toMatch(/— finished in \d+\.\d s —/);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(output()).toContain('run 2');
    expect(document.querySelectorAll('.console-run')).toHaveLength(2);
  });

  it('folds a run away from its header, and back', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    deliver({ kind: 'started', executionId: 'x' });
    deliver({ kind: 'output', executionId: 'x', stream: 'stdout', text: 'long output\n' });
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: true },
    });

    const header = screen.getByRole('button', { name: /run 1 · / });
    // Expanded by default, and the header names what it controls.
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(header.getAttribute('aria-controls') ?? '');
    expect(body).not.toBeNull();
    expect(body).toBeVisible();
    expect(body?.textContent).toContain('long output');
    expect(body?.textContent).toMatch(/— finished in/);

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(body).not.toBeVisible();
    expect(header.textContent).toContain('2 blocks hidden');

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(body).toBeVisible();
  });

  it('folds one run without touching the next, and files output under its own run', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    deliver({ kind: 'started', executionId: 'x' });
    deliver({ kind: 'output', executionId: 'x', stream: 'stdout', text: 'first\n' });
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: true },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    deliver({ kind: 'started', executionId: 'y' });
    deliver({ kind: 'output', executionId: 'y', stream: 'stdout', text: 'second\n' });

    fireEvent.click(screen.getByRole('button', { name: /run 1 · / }));

    const runs = document.querySelectorAll('.console-run');
    expect(runs[0].textContent).toContain('first');
    expect(runs[0].textContent).not.toContain('second');
    expect(screen.getByText('first')).not.toBeVisible();
    expect(screen.getByText('second')).toBeVisible();
    expect(screen.getByRole('button', { name: /run 2 · / }))
      .toHaveAttribute('aria-expanded', 'true');
  });

  it('says stopped, not failed, when the gateway reports a cancellation', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    deliver({ kind: 'started', executionId: 'x' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    // The stop is sent with the id the server gave us — which it can now read,
    // because the socket thread is no longer parked inside the run.
    expect(harness.sent).toContainEqual({ action: 'stop', executionId: 'x' });
    expect(screen.getByText('(waiting for the script to reach a stopping point)'))
      .toBeInTheDocument();

    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: true, ok: false },
    });
    expect(output()).toContain('— stopped —');
    expect(output()).not.toContain('— failed —');
  });

  it('renders a traceback the way Python prints one', () => {
    renderConsole();
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: false, error: fixture.zeroDivision as ExecError },
    });

    // Defect 3, in full: the exception type as the headline, and every frame
    // naming its function. 1.4.3 showed "<console>, line 3" three times over.
    expect(output()).toContain('ZeroDivisionError: integer division or modulo by zero');
    expect(output()).toContain('File "<console>", line 2, in f');
    expect(output()).toContain('File "<console>", line 3, in <module>');
  });

  it('makes a library frame open its resource', () => {
    const onOpenFrame = vi.fn();
    renderConsole({ onOpenFrame });
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: false, error: fixture.libraryFrame as ExecError },
    });

    const link = screen.getByRole('button',
      { name: 'File "ignition/script-python/util/helpers", line 11, in load' });
    fireEvent.click(link);
    expect(onOpenFrame).toHaveBeenCalledWith('ignition/script-python/util/helpers', 11);
  });

  it('shows a syntax error with a caret and never the internal token', () => {
    renderConsole();
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: false, error: fixture.syntaxError as ExecError },
    });
    const text = output();
    // The line goes in the headline: a syntax error has no frames to carry it,
    // and where it happened is the only thing the reader can act on.
    expect(text).toContain(
      "SyntaxError: mismatched input '\\n' expecting COLON (line 1)");
    // Defect 4: no raw PyTuple, and nothing spelling our own file token.
    expect(text).not.toContain('script-ide');
    expect(text).not.toContain("('<console>', 1, 7");
    expect(document.querySelector('.console-caret')?.textContent)
      .toBe('if True\n      ^');
  });

  it('resets the console locals and says so', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(harness.sent).toContainEqual({ action: 'reset', project: 'Demo' });

    // The note comes from the server's acknowledgement, not from the click: a
    // reset the gateway refused must not claim to have happened.
    expect(output()).not.toContain('— reset —');
    deliver({ kind: 'reset', project: 'Demo' });
    expect(output()).toContain('— reset —');
  });

  it('refuses Reset while something is running', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    deliver({ kind: 'started', executionId: 'x' });
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  it('offers Run file only when the workspace has one open', () => {
    const { unmount } = renderConsole();
    expect(screen.getByRole('button', { name: 'Run file' })).toBeDisabled();
    unmount();

    renderConsole({
      activeSource: {
        path: 'ignition/script-python/util/helpers',
        label: 'util.helpers',
        getSource: () => 'print 1\n',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run file' }));
    // `target` is what tells the server this is a file rather than the console,
    // and therefore that it gets fresh locals.
    expect(harness.sent[0]).toMatchObject({
      action: 'run',
      project: 'Demo',
      source: 'print 1\n',
      target: 'ignition/script-python/util/helpers',
      lineOffset: 0,
    });
  });

  it('sends a console run with no target at all, so the locals survive', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(harness.sent[0]).not.toHaveProperty('target');
  });
});

describe('the console layout', () => {
  it('opens in rows, with the editor above the output', () => {
    renderConsole();
    expect(document.querySelector('.console')).toHaveClass('console-rows');
    expect(screen.getByRole('button', { name: 'Output below the editor' }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Output beside the editor' }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to columns and remembers it', () => {
    const view = renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Output beside the editor' }));
    expect(document.querySelector('.console')).toHaveClass('console-columns');

    // Remembered across a REMOUNT, which is the case that matters: the console
    // is unmounted every time the bottom panel closes, and popping it out is a
    // whole new document.
    view.unmount();
    renderConsole();
    expect(document.querySelector('.console')).toHaveClass('console-columns');
    expect(screen.getByRole('button', { name: 'Output beside the editor' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('ignores a stored orientation this build has never heard of', () => {
    // A value written by a build that no longer exists must read as "not
    // chosen", not reach the DOM as a class name nothing styles.
    window.localStorage.setItem('scriptide.choice.console.orientation', 'diagonal');
    renderConsole();
    expect(document.querySelector('.console')).toHaveClass('console-rows');
  });

  it('renders both panes with no geometry, and no divider it could not drive', () => {
    // jsdom measures everything as zero. The stylesheet's own shares are the
    // fallback, and the divider is ABSENT rather than present-and-inert: one
    // that cannot convert a drag into a share would move nothing while looking
    // like it should.
    renderConsole();
    expect(document.querySelector('.console-body')).toBeInTheDocument();
    expect(document.querySelector('.console-editor')).toBeInTheDocument();
    expect(screen.getByLabelText('Output')).toBeInTheDocument();
    expect(document.querySelector('.console-editor')).not.toHaveAttribute('style');
    expect(document.querySelector('.resizer')).toBeNull();
  });

  it('keeps a separate share per orientation', () => {
    window.localStorage.setItem('scriptide.width.console-share-rows', '30');
    window.localStorage.setItem('scriptide.width.console-share-columns', '70');
    renderConsole();
    // Nothing on screen shows the number without geometry, so this asserts the
    // STORE is keyed per orientation — switching must not overwrite the other.
    fireEvent.click(screen.getByRole('button', { name: 'Output beside the editor' }));
    expect(window.localStorage.getItem('scriptide.width.console-share-rows')).toBe('30');
    expect(window.localStorage.getItem('scriptide.width.console-share-columns')).toBe('70');
  });
});

describe('the console buffer survives a reload', () => {
  function editorText(): string {
    return document.querySelector('.cm-content')?.textContent ?? '';
  }

  it('restores the saved script whichever project is selected — the buffer is shared, not per-project', () => {
    window.localStorage.setItem('scriptide.console.buffer', 'print "kept"');
    const { unmount } = renderConsole();
    expect(editorText()).toContain('print "kept"');
    unmount();

    // A different `project` prop picks a different picker default; it is not a
    // different buffer.
    renderConsole({ project: 'Other' });
    expect(editorText()).toContain('print "kept"');
  });

  it('Clear script puts the starter back and forgets the saved buffer', () => {
    window.localStorage.setItem('scriptide.console.buffer', 'print "kept"');
    renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'Clear script' }));

    expect(editorText()).not.toContain('print "kept"');
    expect(editorText()).toContain('Runs on the Gateway');
    expect(window.localStorage.getItem('scriptide.console.buffer')).toBeNull();
  });

  it('keeps working when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderConsole();
    expect(editorText()).toContain('Runs on the Gateway');
    getItem.mockRestore();
  });
});

describe("the console's own project picker", () => {
  function projectSelect(): HTMLSelectElement {
    return screen.getByRole('combobox', { name: 'Project' }) as HTMLSelectElement;
  }

  it('starts on the project prop when nothing is remembered', async () => {
    renderConsole({ project: 'Other' });
    // Loaded asynchronously; wait for the fetched list before asserting on it.
    await screen.findByRole('option', { name: 'Other' });
    expect(projectSelect()).toHaveValue('Other');
  });

  it('switches what Run, Reset and Export act on, independent of the prop', async () => {
    renderConsole();
    await screen.findByRole('option', { name: 'Other' });
    fireEvent.change(projectSelect(), { target: { value: 'Other' } });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(harness.sent[0]).toMatchObject({ action: 'run', project: 'Other' });
    // Reset is refused while a script is running — finish this one first.
    deliver({ kind: 'started', executionId: 'x' });
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: true },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(harness.sent[1]).toMatchObject({ action: 'reset', project: 'Other' });
  });

  it('sends a traceback link to open against the SELECTED project, not the prop', async () => {
    const onOpenFrame = vi.fn();
    renderConsole({ onOpenFrame });
    await screen.findByRole('option', { name: 'Other' });
    fireEvent.change(projectSelect(), { target: { value: 'Other' } });

    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: false, error: fixture.libraryFrame as ExecError },
    });
    fireEvent.click(screen.getByRole('button',
      { name: 'File "ignition/script-python/util/helpers", line 11, in load' }));
    // The library frame's own path is what is opened; run() itself is what
    // carried the selected project to the server — asserted above.
    expect(onOpenFrame).toHaveBeenCalledWith('ignition/script-python/util/helpers', 11);
  });

  it('does not remount, or reset the picker, when the IDE project prop changes after mount', async () => {
    const view = renderConsole();
    await screen.findByRole('option', { name: 'Other' });
    fireEvent.change(projectSelect(), { target: { value: 'Other' } });

    view.rerender(<ScriptConsole project="Demo" csrfToken="t" canExecute />);
    expect(projectSelect()).toHaveValue('Other');

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(harness.sent[0]).toMatchObject({ project: 'Other' });
  });

  it('remembers the choice across a remount', async () => {
    const { unmount } = renderConsole();
    await screen.findByRole('option', { name: 'Other' });
    fireEvent.change(projectSelect(), { target: { value: 'Other' } });
    unmount();

    renderConsole();
    await screen.findByRole('option', { name: 'Other' });
    expect(projectSelect()).toHaveValue('Other');
  });

  it('falls back to the prop when the remembered project is no longer on the gateway', async () => {
    window.localStorage.setItem('scriptide.console.project', 'Deleted');
    renderConsole();
    // Optimistic initial value is the stale one, until the fetched list proves
    // it gone.
    expect(projectSelect()).toHaveValue('Deleted');
    await screen.findByRole('option', { name: 'Demo' });
    expect(projectSelect()).toHaveValue('Demo');
  });

  it('names the project a run was actually sent with in that run\'s own header', async () => {
    renderConsole();
    await screen.findByRole('option', { name: 'Other' });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: /run 1 · Demo · / })).toBeInTheDocument();
    deliver({ kind: 'started', executionId: 'x' });
    deliver({
      kind: 'finished',
      result: { executionId: 'x', stdout: '', stderr: '', truncated: false,
        cancelled: false, ok: true },
    });

    // Switching AFTER run 1 started must not relabel it — each header names
    // whichever project ITS OWN run actually used.
    fireEvent.change(projectSelect(), { target: { value: 'Other' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(screen.getByRole('button', { name: /run 1 · Demo · / })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run 2 · Other · / })).toBeInTheDocument();
  });

  it('tells a pop-out which project the picker is on', async () => {
    const onProjectChange = vi.fn();
    renderConsole({ onProjectChange });
    expect(onProjectChange).toHaveBeenCalledWith('Demo');
    await screen.findByRole('option', { name: 'Other' });
    fireEvent.change(projectSelect(), { target: { value: 'Other' } });
    expect(onProjectChange).toHaveBeenLastCalledWith('Other');
  });
});
