import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WebDevTree, { formatSize } from './WebDevTree';
import type { ScriptEntry } from '../api/scripts';
import { clearStickyState } from '../workspace/viewState';

beforeEach(() => clearStickyState());

function endpoint(overrides: Partial<ScriptEntry> & Pick<ScriptEntry, 'name'>): ScriptEntry {
  return {
    path: `com.inductiveautomation.webdev/resources/${overrides.name}`,
    typeId: 'resources',
    signature: 'sig',
    dataKeys: [],
    scriptKey: 'doGet.py',
    typeLabel: 'Web Dev',
    singleton: false,
    origin: 'local',
    owner: 'Machine_HMI_Demo',
    ...overrides,
  } as ScriptEntry;
}

/** The three shapes measured on the rig, 04/09/2026. */
const ADMIN = endpoint({
  name: 'admin',
  webdevKind: 'python',
  methods: ['doGet', 'doPost'],
  files: [],
});
const LIB = endpoint({
  name: 'lib',
  webdevKind: 'python',
  methods: ['doGet'],
  files: [{ key: 'three.min.js', size: 669884, editable: false }],
});
const CELL3D = endpoint({
  name: 'cell3d',
  webdevKind: 'text',
  contentType: 'text/html',
  methods: [],
  files: [],
  scriptKey: 'config.json#text',
});

function show(entries: ScriptEntry[], props: Partial<React.ComponentProps<typeof WebDevTree>> = {}) {
  const result = render(
    <WebDevTree
      endpoints={entries}
      selectedPath={null}
      onOpen={vi.fn()}
      onOpenFile={vi.fn()}
      onAddMethod={vi.fn()}
      onEditConfig={vi.fn()}
      {...props}
    />
  );
  // This tree SHIPS COLLAPSED from 1.12.2, like the other two, so every check
  // below about what an endpoint contains has to open it first. Opening is
  // one click on the row, and going through the real control is the point:
  // reaching into the state would stop the tests noticing if the chevron ever
  // stopped working.
  openAll();
  return result;
}

/** Click every closed endpoint row open. */
function openAll() {
  for (const header of screen.queryAllByRole('button', { expanded: false })) {
    fireEvent.click(header);
  }
}

describe('a python endpoint', () => {
  it('lists every verb, so an unimplemented one can be added', () => {
    show([ADMIN]);
    expect(screen.getByTitle('Add doPut to admin')).toBeTruthy();
    expect(screen.getByText('doGet')).toBeTruthy();
  });

  it('offers its per-method settings', () => {
    show([ADMIN]);
    expect(screen.getByRole('button', { name: 'Settings for admin' })).toBeTruthy();
  });
});

describe('a text endpoint', () => {
  /**
   * The defect this component was rewritten for.
   *
   * cell3d is 65 KB of HTML inside config.json. Under the verb-only model it
   * reported no methods, so the tree drew eight "add doGet" buttons — and
   * pressing one would have put a Python handler onto a resource the platform
   * serves as static HTML — with no row at all for the file itself.
   */
  it('offers NO verbs, because it has none', () => {
    show([CELL3D]);
    expect(screen.queryByTitle('Add doGet to cell3d')).toBeNull();
    expect(screen.queryByText('doGet')).toBeNull();
  });

  it('opens the file it actually serves, named for its type', () => {
    const onOpenFile = vi.fn();
    show([CELL3D], { onOpenFile });
    fireEvent.click(screen.getByText('cell3d.html'));
    expect(onOpenFile).toHaveBeenCalledWith(CELL3D, 'config.json#text');
  });

  it('says which content type that is', () => {
    show([CELL3D]);
    expect(screen.getByText('text/html')).toBeTruthy();
  });

  it('hides the per-method settings, which it does not have', () => {
    // Not cosmetic: the gateway refuses a settings write on a text resource
    // (WebDevConfigRouteHandler), so the dialog could only ever end in an error.
    show([CELL3D]);
    expect(screen.queryByRole('button', { name: 'Settings for cell3d' })).toBeNull();
  });

  it('differs from a python endpoint — the same tree, two shapes', () => {
    // Asserting the DIFFERENCE, not each shape's presence: a component that
    // ignored `webdevKind` would pass "python lists verbs" on its own.
    show([ADMIN, CELL3D]);
    expect(screen.queryByTitle('Add doPut to admin')).toBeTruthy();
    expect(screen.queryByTitle('Add doPut to cell3d')).toBeNull();
  });
});

describe('static files beside the handlers', () => {
  it('shows a file the endpoint carries, which used to appear nowhere', () => {
    show([LIB]);
    expect(screen.getByText('three.min.js')).toBeTruthy();
  });

  it('shows a file too large to edit, greyed, with its size rather than hiding it', () => {
    // 670 KB of minified JavaScript on a handful of enormous lines. Listing it
    // as un-openable is a better answer than a file that appears not to exist.
    show([LIB]);
    expect(screen.getByText('654 KB')).toBeTruthy();
    expect(screen.queryByTitle(/^Edit three\.min\.js/)).toBeNull();
  });

  it('opens an editable one by its data key', () => {
    const onOpenFile = vi.fn();
    const withCss = endpoint({
      name: 'lib',
      webdevKind: 'python',
      methods: ['doGet'],
      files: [{ key: 'site.css', size: 2048, editable: true }],
    });
    show([withCss], { onOpenFile });
    fireEvent.click(screen.getByText('site.css'));
    expect(onOpenFile).toHaveBeenCalledWith(withCss, 'site.css');
  });
});

describe('the selected row', () => {
  it('follows the DATA KEY, so any of an endpoint’s files can be the open one', () => {
    // Before 1.9.0 this prop was a method name, which no static file and no
    // text resource has.
    show([LIB], { selectedPath: LIB.path, selectedKey: 'doGet.py' });
    const row = screen.getByText('doGet').closest('button');
    expect(row?.getAttribute('aria-current')).toBe('true');
  });

  it('highlights a text resource’s body row', () => {
    show([CELL3D], { selectedPath: CELL3D.path, selectedKey: 'config.json#text' });
    const row = screen.getByText('cell3d.html').closest('button');
    expect(row?.getAttribute('aria-current')).toBe('true');
  });
});

describe('an endpoint with no discriminant', () => {
  it('is treated as python, which is what it always was', () => {
    // An older gateway sends no `webdevKind`. Falling back to "text" would hide
    // every handler on every endpoint it serves.
    const legacy = endpoint({ name: 'legacy', methods: ['doGet'] });
    show([legacy]);
    expect(screen.getByText('doGet')).toBeTruthy();
    expect(screen.getByTitle('Add doPost to legacy')).toBeTruthy();
  });
});

describe('formatSize', () => {
  it('picks a unit that still says which unit it is', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(669884)).toBe('654 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('expansion', () => {
  it('ships collapsed — nothing remembered means nothing open', () => {
    // Nigel, 04/09/2026: "I want by default the WebDev to start shrunk".
    // It tracked the COLLAPSED keys until 1.12.2, so an empty set meant every
    // endpoint open — and a python endpoint opens EIGHT rows, one per verb.
    render(
      <WebDevTree endpoints={[ADMIN, LIB, CELL3D]} selectedPath={null}
        onOpen={vi.fn()} onOpenFile={vi.fn()} onAddMethod={vi.fn()} onEditConfig={vi.fn()} />
    );
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(0);
    expect(screen.queryByText('doGet')).toBeNull();
    expect(screen.queryByText('three.min.js')).toBeNull();
    // The endpoints themselves are still listed — collapsed, not hidden.
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.queryAllByRole('button', { expanded: false })).toHaveLength(3);
  });

  it('opens one endpoint and leaves the others shut', () => {
    render(
      <WebDevTree endpoints={[ADMIN, LIB]} selectedPath={null}
        onOpen={vi.fn()} onOpenFile={vi.fn()} onAddMethod={vi.fn()} onEditConfig={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'admin', expanded: false }));
    expect(screen.getByText('doGet')).toBeTruthy();
    expect(screen.queryByText('three.min.js')).toBeNull();
    expect(screen.queryAllByRole('button', { expanded: true })).toHaveLength(1);
  });

  it('remembers what was opened across an unmount, and only that', () => {
    // The whole point of the sticky set: switching views REMOVES this tree
    // (the activity bar is a `? :` chain), so without it every branch would
    // shut again on the way back.
    const first = render(
      <WebDevTree endpoints={[ADMIN, LIB]} selectedPath={null}
        onOpen={vi.fn()} onOpenFile={vi.fn()} onAddMethod={vi.fn()} onEditConfig={vi.fn()} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'admin', expanded: false }));
    first.unmount();

    render(
      <WebDevTree endpoints={[ADMIN, LIB]} selectedPath={null}
        onOpen={vi.fn()} onOpenFile={vi.fn()} onAddMethod={vi.fn()} onEditConfig={vi.fn()} />
    );
    expect(screen.getByText('doGet')).toBeTruthy();
    expect(screen.queryByText('three.min.js')).toBeNull();
  });

  it('closes an endpoint again, and forgets it', () => {
    show([ADMIN]);
    const header = screen.getByRole('button', { expanded: true });
    fireEvent.click(header);
    expect(screen.queryByText('doGet')).toBeNull();
    expect(within(screen.getByRole('navigation')).getByRole('button', { expanded: false }))
      .toBeTruthy();
  });
});
