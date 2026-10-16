import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveBlob } from '../api/transfer';
import TagTree, { isUnderTypes, joinTagPath, tagParent, type TagTreeProps } from './TagTree';

vi.mock('../api/transfer', () => ({ saveBlob: vi.fn() }));

interface Call {
  url: string;
  body: Record<string, unknown> | undefined;
}

const BROWSE: Record<string, unknown[]> = {
  '[default]': [
    { name: 'Speed', hasChildren: false, objectType: 'AtomicTag', dataType: 'Float8' },
    { name: 'Line', hasChildren: true, objectType: 'Folder', dataType: null },
    { name: '_types_', hasChildren: true, objectType: 'Folder', dataType: null },
  ],
  '[default]Line': [
    { name: 'Motor', hasChildren: false, objectType: 'AtomicTag', dataType: 'Int4' },
    { name: 'Pump', hasChildren: true, objectType: 'UdtInstance', dataType: null, typeId: 'PumpType' },
  ],
  '[default]_types_': [
    { name: 'PumpType', hasChildren: true, objectType: 'UdtType', dataType: null },
  ],
};

/** A fake gateway: answers every tag route and records what was sent. */
function mockApi(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, body });
    let answer: unknown = { ok: true, results: ['Good'] };
    if (url.includes('/api/tags/providers')) answer = { providers: ['default'] };
    else if (url.includes('/api/tags/browse')) {
      const path = new URL(url, 'http://x').searchParams.get('path') ?? '';
      answer = { children: BROWSE[path] ?? [] };
    } else if (url.includes('/api/tags/export')) {
      answer = url.includes('format=xml') ? { xml: '<Tags MinVersion="8.0.0"/>' } : { json: '{"name":"Speed"}' };
    } else if (url.includes('/api/tags/read')) {
      answer = {
        values: ((body?.paths as string[]) ?? []).map((path) => ({
          path, value: 42, quality: 'Good', good: true, timestamp: null,
        })),
      };
    }
    return new Response(JSON.stringify(answer), { status: 200 });
  }));
  return calls;
}

function props(overrides: Partial<TagTreeProps> = {}): TagTreeProps {
  return {
    csrfToken: 't',
    isAdmin: true,
    executionEnabled: true,
    activePath: null,
    clipboard: null,
    onClipboard: vi.fn(),
    onOpen: vi.fn(),
    onMoved: vi.fn(),
    onDeleted: vi.fn(),
    onNotice: vi.fn(),
    active: false,
    ...overrides,
  };
}

function row(path: string): HTMLElement {
  const found = screen.getAllByRole('treeitem').find((el) => el.dataset.path === path);
  if (!found) throw new Error(`no row ${path}`);
  return found;
}

function posted(calls: Call[], route: string) {
  return calls.filter((call) => call.url.includes(`/api/tags/${route}`)).map((call) => call.body);
}

/** Render, then open the provider (and optionally Line) through the keyboard. */
async function renderOpen(p: TagTreeProps, openLine = false) {
  const view = render(<TagTree {...p} />);
  await waitFor(() => expect(row('[default]')).toBeTruthy());
  row('[default]').focus();
  fireEvent.keyDown(row('[default]'), { key: 'ArrowRight' });
  await waitFor(() => expect(row('[default]Speed')).toBeTruthy());
  if (openLine) {
    fireEvent.keyDown(row('[default]Line'), { key: 'ArrowRight' });
    await waitFor(() => expect(row('[default]Line/Motor')).toBeTruthy());
  }
  return view;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('TagTree', () => {
  it('lists providers as an ARIA tree and browses a folder only when it opens', async () => {
    const calls = mockApi();
    render(<TagTree {...props()} />);
    await waitFor(() => expect(row('[default]')).toBeTruthy());
    expect(screen.getByRole('tree')).toHaveAttribute('aria-multiselectable', 'true');
    expect(row('[default]')).toHaveAttribute('aria-expanded', 'false');
    expect(row('[default]')).toHaveAttribute('aria-level', '1');
    expect(calls.some((call) => call.url.includes('/api/tags/browse'))).toBe(false);

    fireEvent.keyDown(row('[default]'), { key: 'ArrowRight' });
    await waitFor(() => expect(row('[default]Speed')).toBeTruthy());
    expect(row('[default]')).toHaveAttribute('aria-expanded', 'true');
    expect(row('[default]Speed')).toHaveAttribute('aria-level', '2');
  });

  it('shows _types_ first, labelled Data Types, with its real path kept', async () => {
    mockApi();
    await renderOpen(props());
    const types = row('[default]_types_');
    expect(types).toHaveTextContent('Data Types');
    const order = screen.getAllByRole('treeitem').map((el) => el.dataset.path);
    expect(order).toEqual(['[default]', '[default]_types_', '[default]Line', '[default]Speed']);
  });

  it('opens a tag on click but not a folder', async () => {
    mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.click(row('[default]Line'));
    expect(p.onOpen).not.toHaveBeenCalled();
    fireEvent.click(row('[default]Speed'));
    expect(p.onOpen).toHaveBeenCalledWith('[default]Speed');
    expect(row('[default]Speed')).toHaveAttribute('aria-selected', 'true');
  });

  it('multi-selects with Ctrl and Shift', async () => {
    mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.click(row('[default]_types_'));
    fireEvent.click(row('[default]Speed'), { ctrlKey: true });
    expect(row('[default]_types_')).toHaveAttribute('aria-selected', 'true');
    expect(row('[default]Line')).toHaveAttribute('aria-selected', 'false');
    expect(row('[default]Speed')).toHaveAttribute('aria-selected', 'true');
    // Ctrl-click does not open anything — it is a selection gesture.
    expect(p.onOpen).not.toHaveBeenCalled();

    fireEvent.click(row('[default]_types_'));
    fireEvent.click(row('[default]Speed'), { shiftKey: true });
    expect(row('[default]Line')).toHaveAttribute('aria-selected', 'true');
  });

  it('moves with the arrows, opens with Enter, collapses with Left', async () => {
    mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.click(row('[default]Line'));
    fireEvent.keyDown(row('[default]Line'), { key: 'ArrowDown' });
    expect(row('[default]Speed')).toHaveAttribute('aria-selected', 'true');
    expect(row('[default]Speed')).toHaveAttribute('tabindex', '0');
    expect(row('[default]Line')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(row('[default]Speed'), { key: 'Enter' });
    expect(p.onOpen).toHaveBeenCalledWith('[default]Speed');

    fireEvent.keyDown(row('[default]Speed'), { key: 'ArrowLeft' });
    expect(row('[default]')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(row('[default]'), { key: 'ArrowLeft' });
    expect(row('[default]')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('treeitem')).toHaveLength(1);
  });

  it('renames with F2 and tells the owner where the tag went', async () => {
    const calls = mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.click(row('[default]Speed'));
    fireEvent.keyDown(row('[default]Speed'), { key: 'F2' });
    const input = await screen.findByLabelText('New name');
    fireEvent.change(input, { target: { value: 'Rate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(p.onMoved).toHaveBeenCalledWith([{ from: '[default]Speed', to: '[default]Rate' }]));
    expect(posted(calls, 'rename')).toEqual([{ path: '[default]Speed', newName: 'Rate' }]);
  });

  it('refuses a name with a slash or brackets before any round trip', async () => {
    mockApi();
    await renderOpen(props());
    fireEvent.click(row('[default]Speed'));
    fireEvent.keyDown(row('[default]Speed'), { key: 'F2' });
    fireEvent.change(await screen.findByLabelText('New name'), { target: { value: 'a/b' } });
    expect(screen.getByRole('alert')).toHaveTextContent('/ [ or ]');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('deletes the selection on Delete, after confirming', async () => {
    const calls = mockApi();
    const p = props();
    await renderOpen(p, true);
    fireEvent.click(row('[default]Line/Motor'));
    fireEvent.click(row('[default]Speed'), { ctrlKey: true });
    fireEvent.keyDown(row('[default]Speed'), { key: 'Delete' });
    const dialog = await screen.findByRole('alertdialog');
    expect(posted(calls, 'delete')).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(p.onDeleted).toHaveBeenCalled());
    expect(posted(calls, 'delete')).toEqual([{ paths: ['[default]Line/Motor', '[default]Speed'] }]);
  });

  it('copies to the workspace clipboard and pastes it as a renaming copy', async () => {
    const calls = mockApi();
    const p = props();
    const { rerender } = await renderOpen(p);
    fireEvent.click(row('[default]Speed'));
    fireEvent.keyDown(row('[default]Speed'), { key: 'c', ctrlKey: true });
    expect(p.onClipboard).toHaveBeenCalledWith({ paths: ['[default]Speed'], cut: false });

    rerender(<TagTree {...p} clipboard={{ paths: ['[default]Speed'], cut: false }} />);
    fireEvent.click(row('[default]Line'));
    fireEvent.keyDown(row('[default]Line'), { key: 'v', ctrlKey: true });
    await waitFor(() => expect(posted(calls, 'move')).toHaveLength(1));
    expect(posted(calls, 'move')[0]).toEqual({
      paths: ['[default]Speed'], destination: '[default]Line', copy: true, collision: 'Rename',
    });
  });

  it('pastes a cut as a move, and spends the clipboard', async () => {
    const calls = mockApi();
    const p = props({ clipboard: { paths: ['[default]Speed'], cut: true } });
    await renderOpen(p);
    fireEvent.click(row('[default]Line'));
    fireEvent.keyDown(row('[default]Line'), { key: 'v', ctrlKey: true });
    await waitFor(() => expect(p.onClipboard).toHaveBeenCalledWith(null));
    expect(posted(calls, 'move')[0]).toEqual({
      paths: ['[default]Speed'], destination: '[default]Line', copy: false, collision: 'Abort',
    });
    expect(p.onMoved).toHaveBeenCalledWith([{ from: '[default]Speed', to: '[default]Line/Speed' }]);
  });

  it('duplicates beside itself with Ctrl+D', async () => {
    const calls = mockApi();
    await renderOpen(props());
    fireEvent.click(row('[default]Speed'));
    fireEvent.keyDown(row('[default]Speed'), { key: 'd', ctrlKey: true });
    await waitFor(() => expect(posted(calls, 'move')).toHaveLength(1));
    expect(posted(calls, 'move')[0]).toEqual({
      paths: ['[default]Speed'], destination: '[default]', copy: true, collision: 'Rename',
    });
  });

  it('creates a memory tag from the context menu and opens it', async () => {
    const calls = mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.contextMenu(row('[default]Line'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New Memory Tag' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'T1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(p.onOpen).toHaveBeenCalledWith('[default]Line/T1'));
    const [create] = posted(calls, 'create');
    expect(create?.basePath).toBe('[default]Line');
    expect(create?.collision).toBe('Abort');
    expect(JSON.parse(String(create?.json))).toEqual({
      tagType: 'AtomicTag', valueSource: 'memory', dataType: 'Int4', name: 'T1',
    });
  });

  it('exports JSON by default, asking for the format first', async () => {
    const calls = mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.contextMenu(row('[default]Speed'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    expect((await screen.findByLabelText('Format') as HTMLSelectElement).value).toBe('JSON');
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalled());
    const exportUrl = calls.find((c) => c.url.includes('/api/tags/export'))?.url ?? '';
    expect(exportUrl).not.toContain('format=');
    expect(vi.mocked(saveBlob).mock.calls.at(-1)?.[1]).toBe('Speed.json');
  });

  it('exports XML when chosen, with an .xml name', async () => {
    const calls = mockApi();
    await renderOpen(props());
    fireEvent.contextMenu(row('[default]Speed'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    fireEvent.change(await screen.findByLabelText('Format'), { target: { value: 'XML' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('format=xml'))).toBe(true));
    await waitFor(() => expect(vi.mocked(saveBlob).mock.calls.at(-1)?.[1]).toBe('Speed.xml'));
  });

  it('imports a .xml file as xml and a .json file as json', async () => {
    const calls = mockApi();
    await renderOpen(props());
    for (const [file, format] of [['a.xml', 'xml'], ['b.json', 'json']] as const) {
      fireEvent.contextMenu(row('[default]Line'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Import…' }));
      const input = screen.getByLabelText('Choose a tag export to import');
      fireEvent.change(input, { target: { files: [{ name: file, text: async () => '{}' }] } });
      fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
      await waitFor(() => expect(posted(calls, 'import').at(-1)?.format).toBe(format));
    }
  });

  it('offers UDT definitions only under Data Types', async () => {
    mockApi();
    await renderOpen(props());
    fireEvent.contextMenu(row('[default]Line'));
    expect(screen.getByRole('menuitem', { name: 'New UDT Definition' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.contextMenu(row('[default]_types_'));
    expect(screen.getByRole('menuitem', { name: 'New UDT Definition' })).toBeEnabled();
  });

  it('greys out every write when execution is switched off, but keeps Copy Path', async () => {
    mockApi();
    await renderOpen(props({ executionEnabled: false }));
    fireEvent.contextMenu(row('[default]Speed'));
    for (const name of ['Delete', 'Rename', 'Paste', 'New Memory Tag', 'Write Value…']) {
      expect(screen.getByRole('menuitem', { name })).toBeDisabled();
    }
    expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toBeEnabled();
  });

  it('moves on drop, and copies when Ctrl is held', async () => {
    const calls = mockApi();
    const p = props();
    await renderOpen(p);
    fireEvent.dragStart(row('[default]Speed'));
    fireEvent.dragOver(row('[default]Line'));
    fireEvent.drop(row('[default]Line'));
    await waitFor(() => expect(posted(calls, 'move')).toHaveLength(1));
    expect(posted(calls, 'move')[0]).toMatchObject({ destination: '[default]Line', copy: false });

    // jsdom has no DragEvent, so fireEvent's init would drop ctrlKey; a
    // MouseEvent of the same type carries it to React's drag handlers.
    const withCtrl = (type: string) => new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey: true });
    fireEvent.dragStart(row('[default]Speed'));
    fireEvent(row('[default]Line'), withCtrl('dragover'));
    fireEvent(row('[default]Line'), withCtrl('drop'));
    await waitFor(() => expect(posted(calls, 'move')).toHaveLength(2));
    expect(posted(calls, 'move')[1]).toMatchObject({ destination: '[default]Line', copy: true, collision: 'Rename' });
  });

  it('refuses a drop onto a tag, which holds nothing', async () => {
    const calls = mockApi();
    await renderOpen(props(), true);
    fireEvent.dragStart(row('[default]Speed'));
    fireEvent.dragOver(row('[default]Line/Motor'));
    fireEvent.drop(row('[default]Line/Motor'));
    expect(posted(calls, 'move')).toHaveLength(0);
  });

  it('does not read values while the view is not active', async () => {
    const calls = mockApi();
    await renderOpen(props({ active: false }), true);
    expect(calls.filter((call) => call.url.includes('/api/tags/read'))).toHaveLength(0);
  });

  it('reads values for visible atomic tags only, while active', async () => {
    const calls = mockApi();
    await renderOpen(props({ active: true }));
    await waitFor(() => expect(row('[default]Speed')).toHaveTextContent('42'));
    const reads = posted(calls, 'read');
    expect(reads.at(-1)).toEqual({ paths: ['[default]Speed'] });
    expect(row('[default]Speed')).toHaveTextContent('Good');
  });

  it('polls again on its interval and stops on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = mockApi();
    const view = await renderOpen(props({ active: true }));
    await waitFor(() => expect(posted(calls, 'read').length).toBeGreaterThan(0));
    const before = posted(calls, 'read').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(posted(calls, 'read').length).toBeGreaterThan(before);
    view.unmount();
    const after = posted(calls, 'read').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(posted(calls, 'read').length).toBe(after);
  });

  it('says why it is empty to a non-administrator, and calls nothing', () => {
    mockApi();
    render(<TagTree {...props({ isAdmin: false })} />);
    expect(screen.getByText(/Administrator role/)).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('tag path helpers', () => {
  it('joins and splits provider-rooted paths', () => {
    expect(joinTagPath('[default]', 'A')).toBe('[default]A');
    expect(joinTagPath('[default]A', 'B')).toBe('[default]A/B');
    expect(tagParent('[default]A/B')).toBe('[default]A');
    expect(tagParent('[default]A')).toBe('[default]');
    expect(tagParent('[default]')).toBeNull();
  });

  it('knows what is under Data Types', () => {
    expect(isUnderTypes('[default]_types_')).toBe(true);
    expect(isUnderTypes('[default]_types_/Motors')).toBe(true);
    expect(isUnderTypes('[default]Line')).toBe(false);
  });
});
