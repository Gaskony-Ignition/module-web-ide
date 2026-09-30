import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LspClient, SymbolInformation } from '../api/lspClient';
import type { ScriptEntry } from '../api/scripts';
import type { NamedQueryEntry } from '../api/namedQueries';
import QuickOpen, { fuzzyScore } from './QuickOpen';

function entry(path: string, partial: Partial<ScriptEntry> = {}): ScriptEntry {
  const name = path.split('/').pop() ?? '';
  return {
    path,
    typeId: 'script-python',
    name,
    signature: 'sig',
    dataKeys: ['code.py'],
    scriptKey: 'code.py',
    typeLabel: 'Project Library',
    singleton: false,
    origin: 'local',
    owner: 'P',
    ...partial,
  };
}

const SCRIPTS = [
  entry('ignition/script-python/util/helpers'),
  entry('ignition/script-python/util/parsing'),
  entry('ignition/script-python/orders/intake'),
  entry('ignition/script-python/empty', { isFolder: true, dataKeys: [], scriptKey: '' }),
];

function query(path: string, partial: Partial<NamedQueryEntry> = {}): NamedQueryEntry {
  // The path INSIDE the project, as the named-query routes and the listing use
  // it — no resource-type prefix, unlike a script's.
  const name = path.split('/').pop() ?? '';
  const folder = path.split('/').slice(0, -1).join('/');
  return {
    path,
    name,
    folder,
    signature: 'sig',
    origin: 'local',
    owner: 'P',
    ...partial,
  };
}

const QUERIES = [
  query('Orders/Intake'),
  query('Totals'),
  query('Empty', { isFolder: true }),
];

/** An LSP client that answers only workspaceSymbols. */
function fakeLsp(symbols: SymbolInformation[]): LspClient {
  return {
    workspaceSymbols: vi.fn().mockResolvedValue(symbols),
  } as unknown as LspClient;
}

function renderPalette(overrides: Partial<React.ComponentProps<typeof QuickOpen>> = {}) {
  const props = {
    project: 'P',
    scripts: SCRIPTS,
    lsp: null,
    initialQuery: '',
    onOpenEntry: vi.fn(),
    onOpenLocation: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<QuickOpen {...props} />);
  return props;
}

function input(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('fuzzyScore', () => {
  it('matches a subsequence, VS Code style', () => {
    expect(fuzzyScore('FooParser', 'fpa')).not.toBeNull();
  });

  it('refuses letters that are not in order', () => {
    expect(fuzzyScore('FooParser', 'raf')).toBeNull();
  });

  it('ranks a substring above a subsequence, however early the subsequence starts', () => {
    // When someone types a whole word they mean the file with that word in it,
    // not one whose letters happen to be in order. Without the offset, a
    // one-character-per-word match at index 0 beats an exact hit at index 20.
    const substring = fuzzyScore('orders/intake', 'intake');
    const subsequence = fuzzyScore('i-n-t-a-k-e-elsewhere', 'intake');
    expect(substring).not.toBeNull();
    expect(subsequence).not.toBeNull();
    expect(substring!).toBeLessThan(subsequence!);
  });

  it('ranks an earlier substring above a later one', () => {
    expect(fuzzyScore('util/helpers', 'util')!).toBeLessThan(fuzzyScore('x/util', 'util')!);
  });

  it('matches everything on an empty needle', () => {
    expect(fuzzyScore('anything', '')).toBe(0);
  });

  it('ignores case in both directions', () => {
    expect(fuzzyScore('Helpers', 'HELP')).not.toBeNull();
    expect(fuzzyScore('HELPERS', 'help')).not.toBeNull();
  });
});

describe('QuickOpen — scripts', () => {
  it('lists every script before anything is typed', () => {
    renderPalette();
    // Three scripts and one folder; the folder is not a row.
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('never offers a folder, which has no body to open', () => {
    // An empty Project Library package is a resource in its own right and
    // clicking it 404s with "No such data key 'code.py'" — the 1.5.0 finding.
    renderPalette();
    expect(screen.queryByText('empty')).not.toBeInTheDocument();
  });

  it('filters as you type', () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: 'intake' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('intake');
  });

  it('opens the highlighted row on Enter', () => {
    const props = renderPalette();
    fireEvent.change(input(), { target: { value: 'helpers' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(props.onOpenEntry).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'ignition/script-python/util/helpers' })
    );
    expect(props.onClose).toHaveBeenCalled();
  });

  it('moves the highlight with the arrow keys and wraps at both ends', () => {
    renderPalette();
    const options = () => screen.getAllByRole('option');
    expect(options()[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    expect(options()[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    fireEvent.keyDown(input(), { key: 'ArrowUp' });
    expect(options()[2]).toHaveAttribute('aria-selected', 'true');
  });

  it('resets the highlight to the top row on every keystroke', () => {
    // Otherwise typing a second character keeps row 3 highlighted while the list
    // under it has changed, and Enter opens something nobody looked at.
    renderPalette();
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    fireEvent.change(input(), { target: { value: 'util' } });
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('closes on Escape without opening anything', () => {
    const props = renderPalette();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onOpenEntry).not.toHaveBeenCalled();
  });

  it('says so rather than showing an empty list when nothing matches', () => {
    renderPalette();
    fireEvent.change(input(), { target: { value: 'zzzz' } });
    expect(screen.getByText('No script matches.')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});

describe('QuickOpen — named queries', () => {
  // One path filter over both, because the whole point of the batch is that a
  // query and the script calling it are one piece of work. Two palettes would
  // put them back in two workspaces.
  function renderWithQueries(overrides: Partial<React.ComponentProps<typeof QuickOpen>> = {}) {
    return renderPalette({ queries: QUERIES, onOpenQuery: vi.fn(), ...overrides });
  }

  it('lists queries beside scripts', () => {
    renderWithQueries();
    // Three scripts and two queries; neither folder row is offered.
    expect(screen.getAllByRole('option')).toHaveLength(5);
    expect(screen.getAllByText('Named Query')).toHaveLength(2);
  });

  it('never offers an empty query FOLDER, which has no SQL to open', () => {
    renderWithQueries();
    expect(screen.queryByText('Empty')).not.toBeInTheDocument();
  });

  it('ranks a query above a script when the query matches better', () => {
    // Two lists concatenated would put every script above every query however
    // well the query matched, which is the opposite of one filter over one
    // project.
    renderWithQueries();
    fireEvent.change(input(), { target: { value: 'intake' } });
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Orders/Intake');
  });

  it('opens a query through its own callback, not the script one', () => {
    const props = renderWithQueries();
    fireEvent.change(input(), { target: { value: 'Totals' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(props.onOpenQuery).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Totals' })
    );
    expect(props.onOpenEntry).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it('lists no query at all where the workspace offers no way to open one', () => {
    renderPalette({ queries: QUERIES });
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('says what was searched when nothing matches', () => {
    renderWithQueries();
    fireEvent.change(input(), { target: { value: 'zzzz' } });
    expect(screen.getByText('No script or query matches.')).toBeInTheDocument();
  });

  it('leaves symbol mode alone — there is no SQL index in this version', () => {
    const lsp = fakeLsp([]);
    renderWithQueries({ lsp, initialQuery: '#Totals' });
    expect(screen.queryByText('Totals')).not.toBeInTheDocument();
  });
});

describe('QuickOpen — symbols', () => {
  const symbols: SymbolInformation[] = [
    {
      name: 'compute',
      kind: 12,
      containerName: 'util.helpers',
      location: {
        uri: 'ignition://P/ignition/script-python/util/helpers',
        range: { start: { line: 7, character: 4 }, end: { line: 7, character: 4 } },
      },
    },
  ];

  it('starts in symbol mode when opened with a # (what Ctrl+T does)', async () => {
    const lsp = fakeLsp(symbols);
    renderPalette({ lsp, initialQuery: '#' });
    await waitFor(() => expect(lsp.workspaceSymbols).toHaveBeenCalledWith('P', ''));
    expect(await screen.findByText('compute')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Go to symbol');
  });

  it('switches to symbols when a # is typed, so the prefix works without the shortcut', async () => {
    // Ctrl+T is refused by Chrome and cannot be intercepted, so the prefix is
    // the guarantee and the shortcut is the convenience.
    const lsp = fakeLsp(symbols);
    renderPalette({ lsp });
    fireEvent.change(input(), { target: { value: '#comp' } });
    await waitFor(() => expect(lsp.workspaceSymbols).toHaveBeenCalledWith('P', 'comp'));
  });

  it('opens a symbol at its own line and column', async () => {
    const lsp = fakeLsp(symbols);
    const props = renderPalette({ lsp, initialQuery: '#' });
    await screen.findByText('compute');
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(props.onOpenLocation).toHaveBeenCalledWith(
      'ignition://P/ignition/script-python/util/helpers',
      7,
      4
    );
  });

  it('survives the server answering with an error', async () => {
    const lsp = {
      workspaceSymbols: vi.fn().mockRejectedValue(new Error('socket closed')),
    } as unknown as LspClient;
    renderPalette({ lsp, initialQuery: '#x' });
    expect(await screen.findByText('No symbol of that name in this project.'))
      .toBeInTheDocument();
  });
});
