import { fireEvent, render as renderRaw, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NamedQueryTree, { buildQueryTree } from './NamedQueryTree';
import type { NamedQueryEntry } from '../api/namedQueries';

function entry(overrides: Partial<NamedQueryEntry> & Pick<NamedQueryEntry, 'path' | 'name'>): NamedQueryEntry {
  return {
    folder: '',
    signature: 'sig',
    origin: 'local',
    owner: 'MyProject',
    ...overrides,
  };
}

const QUERIES: NamedQueryEntry[] = [
  entry({ path: 'Totals', name: 'Totals' }),
  entry({
    path: 'Orders/Insert',
    name: 'Insert',
    folder: 'Orders',
    type: 'UpdateQuery',
  }),
  entry({
    path: 'Orders/Daily/Count',
    name: 'Count',
    folder: 'Orders/Daily',
  }),
  entry({
    path: 'Shared/Lookup',
    name: 'Lookup',
    folder: 'Shared',
    origin: 'inherited',
    owner: 'ParentProject',
  }),
  entry({
    path: 'Shared/Rates',
    name: 'Rates',
    folder: 'Shared',
    origin: 'override',
    owner: 'ParentProject',
  }),
];

/**
 * Render with every branch OPEN.
 *
 * The tree ships collapsed for the same reasons the script tree does, and that
 * default is asserted on its own below. Every other check is about what a branch
 * CONTAINS, so they open it first — repeatedly, because opening a folder reveals
 * the folders nested inside it.
 */
function render(ui: React.ReactElement) {
  const result = renderRaw(ui);
  for (let pass = 0; pass < 6; pass++) {
    const shut = screen.queryAllByRole('button', { expanded: false });
    if (shut.length === 0) break;
    for (const button of shut) fireEvent.click(button);
  }
  return result;
}

describe('buildQueryTree', () => {
  it('makes folders out of the paths, as the Designer does', () => {
    const tree = buildQueryTree(QUERIES);
    expect(tree.children.map((c) => c.name)).toEqual(['Orders', 'Shared']);
    expect(tree.queries.map((q) => q.name)).toEqual(['Totals']);
    const orders = tree.children.find((c) => c.name === 'Orders')!;
    expect(orders.queries.map((q) => q.name)).toEqual(['Insert']);
    expect(orders.children.map((c) => c.name)).toEqual(['Daily']);
  });

  it('nests from the PATH when the listing sends no folder field', () => {
    // The folder is derivable from the path, and a listing that omits it must
    // still nest rather than flatten every query into the root.
    const tree = buildQueryTree([
      entry({ path: 'A/B/C', name: 'C' }),
    ]);
    expect(tree.children[0].name).toBe('A');
    expect(tree.children[0].children[0].queries.map((q) => q.name)).toEqual(['C']);
  });

  it('renders an empty folder as a folder, never as an openable row', () => {
    // The gateway reports an empty folder as a resource in its own right so it
    // is not dropped. It has no query.sql, and opening it 404s.
    const tree = buildQueryTree([
      entry({ path: 'Empty', name: 'Empty', isFolder: true }),
    ]);
    expect(tree.queries).toEqual([]);
    expect(tree.children.map((c) => c.name)).toEqual(['Empty']);
  });

  it('sorts folders before queries, each alphabetically and case-insensitively', () => {
    const tree = buildQueryTree([
      entry({ path: 'zebra', name: 'zebra' }),
      entry({ path: 'Apple', name: 'Apple' }),
      entry({ path: 'beta/One', name: 'One', folder: 'beta' }),
      entry({ path: 'Alpha/Two', name: 'Two', folder: 'Alpha' }),
    ]);
    expect(tree.children.map((c) => c.name)).toEqual(['Alpha', 'beta']);
    expect(tree.queries.map((q) => q.name)).toEqual(['Apple', 'zebra']);
  });
});

describe('NamedQueryTree', () => {
  it('ships collapsed — nothing but the group header is on screen', () => {
    // Quick open is the fast path; the tree is for browsing, which starts by
    // choosing a branch. Tracked as an EXPANDED set so this default falls out
    // of the empty set rather than an enumeration that can miss a key.
    renderRaw(<NamedQueryTree queries={QUERIES} selectedPath={null} onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Queries/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Totals')).not.toBeInTheDocument();
  });

  it('counts the queries but not the folders', () => {
    renderRaw(
      <NamedQueryTree
        queries={[...QUERIES, entry({ path: 'Empty', name: 'Empty', isFolder: true })]}
        selectedPath={null}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /Queries/ })).toHaveTextContent('5');
  });

  it('opens a query when its row is clicked', () => {
    const onSelect = vi.fn();
    render(<NamedQueryTree queries={QUERIES} selectedPath={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Insert'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Orders/Insert' })
    );
  });

  it('badges an inherited query, because editing one forks the parent', () => {
    render(<NamedQueryTree queries={QUERIES} selectedPath={null} onSelect={vi.fn()} />);
    expect(screen.getByText('inherited')).toBeInTheDocument();
    expect(screen.getByText('override')).toBeInTheDocument();
  });

  it('offers rename and delete only for queries this project owns', () => {
    // An inherited query has nothing here to move or remove, and the server
    // 404s it — so the buttons are absent rather than present and failing.
    render(
      <NamedQueryTree
        queries={QUERIES}
        selectedPath={null}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Delete Insert' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Lookup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename Lookup' })).not.toBeInTheDocument();
  });

  it('calls deleting an OVERRIDE what it is — discarding, not deleting', () => {
    // It removes this project's copy and the query keeps working, inherited
    // from the parent. Wording a reversible action as a permanent one is how
    // people learn to click past confirmations.
    render(
      <NamedQueryTree queries={QUERIES} selectedPath={null} onSelect={vi.fn()} onDelete={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Discard overrides on Rates' })).toBeInTheDocument();
  });

  it('badges a legacy query, which is DEAD rather than merely unusual', () => {
    // fromResource returns a blank query for a version-1 resource and
    // runNamedQuery raises on it. Without the badge the row looks like every
    // other one and does nothing.
    render(
      <NamedQueryTree
        queries={[entry({ path: 'Old', name: 'Old', legacy: true })]}
        selectedPath={null}
        onSelect={vi.fn()}
      />
    );
    const badge = screen.getByText('legacy');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', expect.stringContaining('cannot run'));
  });

  it('badges nothing on a current query', () => {
    render(<NamedQueryTree queries={QUERIES} selectedPath={null} onSelect={vi.fn()} />);
    expect(screen.queryByText('legacy')).not.toBeInTheDocument();
  });

  it('offers a folder rename, which the contract allows with no precondition', () => {
    const onRenameFolder = vi.fn();
    render(
      <NamedQueryTree
        queries={QUERIES}
        selectedPath={null}
        onSelect={vi.fn()}
        onRenameFolder={onRenameFolder}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename folder Orders' }));
    // No folder RESOURCE in this listing, so nothing to send a signature for.
    expect(onRenameFolder).toHaveBeenCalledWith('Orders', undefined);
  });

  it('hands over the folder RESOURCE where the gateway has one, so it can be checked', () => {
    const onRenameFolder = vi.fn();
    const folder = entry({ path: 'Empty', name: 'Empty', isFolder: true, signature: 'sig-folder' });
    render(
      <NamedQueryTree
        queries={[...QUERIES, folder]}
        selectedPath={null}
        onSelect={vi.fn()}
        onRenameFolder={onRenameFolder}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename folder Empty' }));
    expect(onRenameFolder).toHaveBeenCalledWith('Empty', expect.objectContaining({
      signature: 'sig-folder',
    }));
  });

  it('hides create, rename and delete when the session cannot write', () => {
    render(<NamedQueryTree queries={QUERIES} selectedPath={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'New named query' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Insert' })).not.toBeInTheDocument();
  });

  it('offers create on the group header, which is reachable while it is shut', () => {
    const onCreate = vi.fn();
    renderRaw(
      <NamedQueryTree queries={[]} selectedPath={null} onSelect={vi.fn()} onCreate={onCreate} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'New named query' }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('says the project has none rather than showing an empty branch', () => {
    render(<NamedQueryTree queries={[]} selectedPath={null} onSelect={vi.fn()} />);
    expect(screen.getByText('No named queries in this project.')).toBeInTheDocument();
  });

  it('marks the open query as the current row', () => {
    render(
      <NamedQueryTree
        queries={QUERIES}
        selectedPath="Orders/Insert"
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByText('Insert').closest('button')).toHaveAttribute('aria-current', 'true');
  });
});
