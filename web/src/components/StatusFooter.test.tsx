import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StatusFooter, { connectionState, describeCounts, type ConnectionSource } from './StatusFooter';
import type { ScriptEntry } from '../api/scripts';
import type { TransportStatus } from '../api/lspTransport';

/**
 * A transport that is nothing but its status.
 *
 * The real one cannot reach `open` without a socket and a server, and the whole
 * point of the footer is what it shows when neither is there — so the fake is
 * the only way to assert all three states without fake timers.
 */
function fakeTransport(initial: TransportStatus = 'idle') {
  let status = initial;
  const listeners = new Set<(next: TransportStatus) => void>();
  const source: ConnectionSource = {
    getStatus: () => status,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ...source,
    set(next: TransportStatus) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function entry(overrides: Partial<ScriptEntry> & Pick<ScriptEntry, 'path' | 'typeId' | 'name' | 'typeLabel'>): ScriptEntry {
  return {
    signature: 'sig',
    dataKeys: ['code.py'],
    scriptKey: 'code.py',
    singleton: false,
    origin: 'local',
    owner: 'MyProject',
    ...overrides,
  };
}

function library(name: string): ScriptEntry {
  return entry({
    path: `ignition/script-python/${name}`,
    typeId: 'script-python',
    name,
    typeLabel: 'Project Library',
  });
}

function timer(name: string): ScriptEntry {
  return entry({
    path: `ignition/timer/${name}`,
    typeId: 'timer',
    name,
    typeLabel: 'Timer',
    scriptKey: 'handleTimerEvent.py',
  });
}

describe('connection state', () => {
  it.each([
    ['idle', 'idle', 'Language server idle'],
    ['open', 'connected', 'Language server connected'],
    ['connecting', 'reconnecting', 'Language server reconnecting…'],
    ['closed', 'offline', 'Language server offline'],
  ] as const)('renders %s as %s', (status, state, label) => {
    render(<StatusFooter scripts={[]} transport={fakeTransport(status)} />);

    const line = screen.getByRole('status');
    expect(line).toHaveTextContent(label);
    // The dot's colour is the at-a-glance signal, and it hangs off this class.
    expect(line).toHaveClass(`is-${state}`);
  });

  it('treats a socket nothing has ever opened as idle, not as offline', () => {
    // The LSP connects lazily on the first script opened. Before this fix
    // `idle` folded into `offline` and the landing page showed "Language
    // server offline" in red before any document existed — a fault reading
    // for a connection that was never even attempted. `offline` means a real
    // attempt failed or a live connection dropped; neither has happened yet.
    expect(connectionState('idle')).toBe('idle');
  });

  it('follows the transport when the socket drops and comes back', () => {
    const transport = fakeTransport('open');
    render(<StatusFooter scripts={[]} transport={transport} />);
    expect(screen.getByRole('status')).toHaveTextContent('connected');

    act(() => transport.set('closed'));
    expect(screen.getByRole('status')).toHaveTextContent('offline');

    act(() => transport.set('connecting'));
    expect(screen.getByRole('status')).toHaveTextContent('reconnecting');

    act(() => transport.set('open'));
    expect(screen.getByRole('status')).toHaveTextContent('connected');
  });

  it('picks up a status that changed before the subscription was made', () => {
    // The gap between render and effect is real: the socket can open in it, and
    // a listener is only ever told about transitions AFTER it was added.
    const transport = fakeTransport('connecting');
    transport.set('open');
    render(<StatusFooter scripts={[]} transport={transport} />);

    expect(screen.getByRole('status')).toHaveTextContent('connected');
  });

  it('unsubscribes on unmount', () => {
    const transport = fakeTransport();
    const { unmount } = render(<StatusFooter scripts={[]} transport={transport} />);
    expect(transport.listenerCount).toBe(1);

    unmount();
    expect(transport.listenerCount).toBe(0);
  });
});

describe('counts', () => {
  it('totals every script and calls out the event types', () => {
    const scripts = [
      library('util/helpers'),
      library('util/text/format'),
      library('toplevel'),
      timer('Poller'),
      timer('Sweeper'),
    ];

    expect(describeCounts(scripts)).toBe('5 scripts · 2 timers');
  });

  it('singularises each segment independently', () => {
    expect(describeCounts([library('only'), timer('Poller')])).toBe('2 scripts · 1 timer');
  });

  it('lists event types in the order the tree groups them', () => {
    const scripts = [
      library('helpers'),
      entry({ path: 'ignition/tag-change/OnChange', typeId: 'tag-change', name: 'OnChange', typeLabel: 'Tag Change' }),
      entry({ path: 'ignition/startup', typeId: 'startup', name: '', typeLabel: 'Startup', singleton: true }),
      timer('Poller'),
    ];

    expect(describeCounts(scripts)).toBe('4 scripts · 1 timer · 1 startup · 1 tag change');
  });

  it('says so plainly when the project has nothing in it', () => {
    expect(describeCounts([])).toBe('No scripts');
  });

  it('does not count an empty package folder as a script', () => {
    // `isFolder` marks a placeholder row for an empty Project Library
    // package (see FileTree/ScriptResourceRouteHandler#isPackageContainer) —
    // it holds no code anyone wrote, and counting it would say "1 script"
    // for a project that in fact has none.
    const folder = library('MiningDemo');
    folder.isFolder = true;
    expect(describeCounts([folder])).toBe('No scripts');
    expect(describeCounts([folder, library('helpers')])).toBe('1 script');
  });

  it('renders the count line, with the full text kept in the title', () => {
    render(<StatusFooter scripts={[library('a'), timer('b')]} transport={fakeTransport()} />);

    const counts = screen.getByText('2 scripts · 1 timer');
    // The rail is 260px wide, so the line ellipsises; the title is what makes
    // the truncated half recoverable.
    expect(counts).toHaveAttribute('title', '2 scripts · 1 timer');
  });
});
