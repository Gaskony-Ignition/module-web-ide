import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The workspace wiring for tool tabs, rendered for real. Everything that would
 * reach a gateway is stubbed: the console and Query Browser are replaced with
 * a counter whose state lives in the component (what this is about), and the
 * language server, presence and git clients answer nothing.
 */
vi.mock('../components/ScriptConsole', () => ({
  default: function FakeConsole() {
    const [n, setN] = useState(0);
    return <button type="button" onClick={() => setN((v) => v + 1)}>console runs {n}</button>;
  },
}));
vi.mock('../components/QueryBrowser', () => ({
  default: function FakeQuery() {
    const [n, setN] = useState(0);
    return <button type="button" onClick={() => setN((v) => v + 1)}>query runs {n}</button>;
  },
}));
vi.mock('../components/OutlinePanel', () => ({
  default: () => <aside aria-label="Outline">outline</aside>,
}));
vi.mock('../api/lspClient', () => ({
  lspUri: (p: string, path: string) => `ignition://${p}/${path}`,
  sharedLspClient: () => null,
}));
vi.mock('../api/lspTransport', () => ({
  sharedTransport: () => ({ getStatus: () => 'idle', onStatus: () => () => {} }),
}));
vi.mock('../api/presence', async (orig) => ({
  ...(await orig<typeof import('../api/presence')>()),
  presenceClient: () => ({ subscribe: () => () => {}, report: () => {} }),
}));
vi.mock('../api/git', async (orig) => ({
  ...(await orig<typeof import('../api/git')>()),
  gitClient: () => ({ subscribe: () => () => {}, watch: () => {} }),
}));

import Workspace from './Workspace';

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/projects')) return json({ projects: [{ name: 'P', mutable: true }] });
    if (url.includes('/api/scripts')) return json({ project: 'P', mutable: true, scripts: [] });
    if (url.includes('/api/named-queries')) return json({ queries: [] });
    return json({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SESSION = {
  authenticated: true, writable: true, canExecute: true, executionEnabled: true, csrfToken: 't',
};

async function renderWorkspace() {
  render(<Workspace session={SESSION} />);
  await act(async () => { await Promise.resolve(); });
}

/** An activity-bar button — a tab of the same name is also a button. */
function activity(name: string) {
  return within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name });
}

function openTabs() {
  return [...document.querySelectorAll('.tab-strip .tab-name')].map((el) => el.textContent);
}

describe('Script Console and Query as editor tabs', () => {
  it('open as a tab from the activity bar, not in the bottom panel', async () => {
    await renderWorkspace();
    fireEvent.click(activity('Script Console'));
    expect(openTabs()).toEqual(['Script Console']);
    expect(screen.getByText('console runs 0')).toBeInTheDocument();
    expect(document.querySelector('.panel')).toBeNull();
    expect(activity('Script Console')).toHaveAttribute('aria-pressed', 'true');
    // Pressing it again focuses the one tab rather than opening a second.
    fireEvent.click(activity('Script Console'));
    expect(openTabs()).toEqual(['Script Console']);
  });

  it('keep their state across a switch between the two tabs', async () => {
    await renderWorkspace();
    fireEvent.click(activity('Script Console'));
    fireEvent.click(screen.getByText('console runs 0'));
    fireEvent.click(activity('Query'));
    expect(screen.queryByText(/console runs/)).toBeNull();
    expect(activity('Query')).toHaveAttribute('aria-pressed', 'true');
    expect(activity('Script Console')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByText('query runs 0'));
    fireEvent.click(activity('Script Console'));
    expect(screen.getByText('console runs 1')).toBeInTheDocument();
    fireEvent.click(activity('Query'));
    expect(screen.getByText('query runs 1')).toBeInTheDocument();
  });

  it('keep their state when moved to the other pane', async () => {
    await renderWorkspace();
    fireEvent.click(activity('Query'));
    fireEvent.click(activity('Script Console'));
    fireEvent.click(screen.getByText('console runs 0'));
    fireEvent.click(screen.getByRole('button', { name: 'Open this document in a second editor beside this one' }));
    const panes = document.querySelectorAll('.workspace-pane');
    expect(panes).toHaveLength(2);
    expect(within(panes[1] as HTMLElement).getByText('console runs 1')).toBeInTheDocument();
  });

  it('offer the pop-out in the tab strip, which opens a new browser tab and closes this one', async () => {
    const open = vi.fn(() => ({ opener: {} }) as unknown as Window);
    vi.stubGlobal('open', open);
    await renderWorkspace();
    fireEvent.click(activity('Query'));
    fireEvent.click(screen.getByRole('button', { name: 'Open the Query Browser in a new browser tab' }));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('?view=query&project=P'), '_blank');
    // Popped out means popped out: the tab goes.
    expect(openTabs()).toEqual([]);
  });

  it('hide the outline and the Save button while a tool tab is active', async () => {
    await renderWorkspace();
    expect(screen.getByLabelText('Outline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle secondary side bar' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(activity('Script Console'));
    expect(screen.queryByLabelText('Outline')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
    const toggle = screen.getByRole('button', { name: /^Toggle secondary side bar \(unavailable/ });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Close Script Console' }));
    expect(screen.getByLabelText('Outline')).toBeInTheDocument();
    // The stored preference was never touched.
    expect(screen.getByRole('button', { name: 'Toggle secondary side bar' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('closing the tab closes the tool', async () => {
    await renderWorkspace();
    fireEvent.click(activity('Script Console'));
    fireEvent.click(screen.getByText('console runs 0'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Script Console' }));
    fireEvent.click(activity('Script Console'));
    expect(screen.getByText('console runs 0')).toBeInTheDocument();
  });
});
