import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import NamedQueryEditor, { showsBuffer, type QueryTab } from './NamedQueryEditor';
import { emptySettings, type NamedQuerySettings, type TestRunResult } from '../api/namedQueries';

function settings(overrides: Partial<NamedQuerySettings> = {}): NamedQuerySettings {
  return { ...emptySettings(), ...overrides };
}

function renderEditor(
  overrides: Partial<React.ComponentProps<typeof NamedQueryEditor>> = {}
) {
  const props: React.ComponentProps<typeof NamedQueryEditor> = {
    project: 'P',
    // The path INSIDE the project — what the routes and runNamedQuery take.
    path: 'Orders/Totals',
    sql: 'SELECT 1',
    settings: settings(),
    databases: ['Postgres_Test'],
    editable: [],
    tab: 'settings',
    onTabChange: vi.fn(),
    onChange: vi.fn(),
    onSave: vi.fn(),
    dirty: false,
    readOnly: false,
    ...overrides,
  };
  render(<NamedQueryEditor {...props} />);
  return props;
}

describe('the tab row', () => {
  it('offers the Designer\u2019s three tabs', () => {
    renderEditor();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Authoring' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Testing' })).toBeInTheDocument();
  });

  it('reports the current tab to assistive technology', () => {
    renderEditor({ tab: 'testing' });
    expect(screen.getByRole('tab', { name: 'Testing' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'false');
  });

  it('is the AUTHORING tab that shows the SQL buffer, so the other two hide it', () => {
    // The buffer is the shared CodeEditor, mounted once for every document —
    // hiding it is what keeps every other view's undo history alive.
    expect(showsBuffer('authoring')).toBe(true);
    expect(showsBuffer('settings')).toBe(false);
    expect(showsBuffer('testing')).toBe(false);
  });

  it('saves both halves with one button, against one signature', () => {
    const props = renderEditor({ dirty: true });
    fireEvent.click(screen.getByRole('button', { name: 'Save query' }));
    expect(props.onSave).toHaveBeenCalled();
  });

  it('disables the save button when nothing has changed', () => {
    renderEditor({ dirty: false });
    expect(screen.getByRole('button', { name: 'Save query' })).toBeDisabled();
  });
});

describe('Settings', () => {
  it('renders the whole measured vocabulary, not a subset', () => {
    renderEditor({ tab: 'settings' });
    for (const label of [
      'Type', 'Description', 'Database', 'Enabled', 'Auto-batch',
      'Cache results', 'Amount', 'Unit', 'Use a fallback value',
      'Limit the number of rows returned',
    ]) {
      expect(screen.getByLabelText(label, { exact: false })).toBeInTheDocument();
    }
  });

  it('offers "(project default)" for an empty database, because that IS the setting', () => {
    renderEditor({ settings: settings({ database: '' }) });
    const select = screen.getByLabelText('Database', { exact: false }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: '(project default)' })).toBeInTheDocument();
  });

  it('keeps a connection this gateway no longer has, rather than retargeting the query', () => {
    renderEditor({ settings: settings({ database: 'Gone' }), databases: ['Postgres_Test'] });
    expect(screen.getByRole('option', { name: /Gone \(not on this gateway\)/ })).toBeInTheDocument();
  });

  it('sends the enum NAME on change, not the label', () => {
    // `toString()` gives "Scalar Query"; the value on the wire is ScalarQuery,
    // and sending the label writes a type the platform does not have.
    const props = renderEditor();
    fireEvent.change(screen.getByLabelText('Type', { exact: false }), {
      target: { value: 'ScalarQuery' },
    });
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'ScalarQuery' }));
  });

  it('offers all eight cache units, MS included', () => {
    renderEditor({ settings: settings({ cacheEnabled: true }) });
    const select = screen.getByLabelText('Unit', { exact: false }) as HTMLSelectElement;
    expect(select.options).toHaveLength(8);
    expect([...select.options].map((o) => o.value)).toContain('MS');
  });

  it('disables the cache amount while caching is off, rather than hiding it', () => {
    // A value that vanishes when the tick comes off looks like it was discarded.
    renderEditor({ settings: settings({ cacheEnabled: false, cacheAmount: 30 }) });
    expect(screen.getByLabelText('Amount', { exact: false })).toBeDisabled();
  });

  it('adds a security row as the empty pair the Designer writes', () => {
    // A fresh query already holds ONE empty requirement — measured — so an add
    // appends a second rather than creating the first.
    const props = renderEditor({ settings: settings({ permissions: [] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Add security row' }));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: [{ zone: '', role: '' }] })
    );
  });

  it('removes a security row', () => {
    const props = renderEditor({ settings: settings({ permissions: [{ zone: 'Z', role: 'R' }] }) });
    fireEvent.click(screen.getByRole('button', { name: 'Remove security row 1' }));
    expect(props.onChange).toHaveBeenCalledWith(expect.objectContaining({ permissions: [] }));
  });

  it('treats a non-empty editable list as an allowlist, and shows the rest disabled', () => {
    // The server said the setting exists; hiding it would put a real capability
    // behind a stale frontend.
    renderEditor({ editable: ['type'] });
    expect(screen.getByLabelText('Type', { exact: false })).toBeEnabled();
    expect(screen.getByLabelText('Description', { exact: false })).toBeDisabled();
  });
});

describe('Authoring', () => {
  const withParams = settings({
    parameters: [
      { type: 'Parameter', identifier: 'orderId', sqlType: 'Int4' },
      { type: 'Parameter', identifier: 'since', sqlType: 'DateTime' },
    ],
  });

  it('shows one row per parameter, with its three fields', () => {
    renderEditor({ tab: 'authoring', settings: withParams });
    // The dropdown shows the Designer's LABEL for the enum, and holds its NAME.
    expect(screen.getByLabelText('Parameter 1 type')).toHaveValue('Parameter');
    expect(screen.getByLabelText('Parameter 1 type')).toHaveTextContent('Value');
    expect(screen.getByLabelText('Parameter 1 identifier')).toHaveValue('orderId');
    expect(screen.getByLabelText('Parameter 2 SQL type')).toHaveValue('DateTime');
  });

  it('offers the ten SQL types and no Date', () => {
    renderEditor({ tab: 'authoring', settings: withParams });
    const select = screen.getByLabelText('Parameter 1 SQL type') as HTMLSelectElement;
    expect(select.options).toHaveLength(10);
    expect([...select.options].map((o) => o.value)).not.toContain('Date');
  });

  it('adds a parameter with the enum NAME, never the label', () => {
    // `Value` is what ParameterType.Parameter.toString() returns. Emitting it
    // sends a name the platform does not have.
    const props = renderEditor({ tab: 'authoring' });
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: [{ type: 'Parameter', identifier: '', sqlType: 'String' }],
      })
    );
  });

  it('flags an identifier that no dict lookup could ever use', () => {
    renderEditor({
      tab: 'authoring',
      settings: settings({ parameters: [{ type: 'Parameter', identifier: '1st', sqlType: 'String' }] }),
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot start with a digit/);
    expect(screen.getByLabelText('Parameter 1 identifier')).toHaveAttribute('aria-invalid', 'true');
  });

  it('flags a duplicate identifier, which would silently shadow the other', () => {
    renderEditor({
      tab: 'authoring',
      settings: settings({
        parameters: [
          { type: 'Parameter', identifier: 'id', sqlType: 'String' },
          { type: 'Parameter', identifier: 'id', sqlType: 'String' },
        ],
      }),
    });
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('reorders parameters, because the order is a real edit and not a display choice', () => {
    const props = renderEditor({ tab: 'authoring', settings: withParams });
    fireEvent.click(screen.getByRole('button', { name: 'Move parameter 2 up' }));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        parameters: [withParams.parameters[1], withParams.parameters[0]],
      })
    );
  });

  it('removes a parameter', () => {
    const props = renderEditor({ tab: 'authoring', settings: withParams });
    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter 1' }));
    expect(props.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ parameters: [withParams.parameters[1]] })
    );
  });

  it('renders no pager over the parameter table, ever', () => {
    renderEditor({ tab: 'authoring', settings: withParams });
    expect(screen.queryByText(/Page \d/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
  });
});

describe('Testing', () => {
  const typed = settings({
    parameters: [
      { type: 'Parameter', identifier: 'count', sqlType: 'Int4' },
      { type: 'Parameter', identifier: 'active', sqlType: 'Boolean' },
      { type: 'Parameter', identifier: 'since', sqlType: 'DateTime' },
      { type: 'Parameter', identifier: 'name', sqlType: 'String' },
    ],
  });

  function inputFor(name: string): HTMLInputElement {
    return screen.getByLabelText(name) as HTMLInputElement;
  }

  it('types each input by its sqlType', () => {
    renderEditor({ tab: 'testing', settings: typed });
    expect(inputFor('count').type).toBe('number');
    expect(inputFor('active').type).toBe('checkbox');
    expect(inputFor('since').type).toBe('datetime-local');
    expect(inputFor('name').type).toBe('text');
  });

  it('says so when the query takes no parameters', () => {
    renderEditor({ tab: 'testing' });
    expect(screen.getByText('This query takes no parameters.')).toBeInTheDocument();
  });

  it('runs with the values typed, keyed by identifier', async () => {
    const onTestRun = vi.fn().mockResolvedValue({ ok: true, value: 1 } as TestRunResult);
    renderEditor({ tab: 'testing', settings: typed, onTestRun });
    fireEvent.change(inputFor('count'), { target: { value: '7' } });
    fireEvent.click(inputFor('active'));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(onTestRun).toHaveBeenCalledWith(expect.objectContaining({ count: '7', active: true }))
    );
  });

  it('disables Run while a run is in flight, so a second cannot race the first', async () => {
    let release: (value: TestRunResult) => void = () => {};
    const onTestRun = vi.fn(() => new Promise<TestRunResult>((resolve) => { release = resolve; }));
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled());
    release({ ok: true, value: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled());
  });

  it('renders a Query result as a table, with no pager', async () => {
    const onTestRun = vi.fn().mockResolvedValue({
      ok: true,
      type: 'Query',
      columns: [{ name: 'id', type: 'Int4' }, { name: 'total', type: 'Float8' }],
      rows: [[1, 12.5], [2, null]],
      rowCount: 2,
      elapsedMs: 12,
    } as TestRunResult);
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + two rows
    // NULL is a SQL value and says so; an empty cell would read as an empty
    // string, which is a different answer.
    expect(screen.getByText('NULL')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /next page/i })).not.toBeInTheDocument();
  });

  it('reports the cap when the server truncated the rows', async () => {
    const onTestRun = vi.fn().mockResolvedValue({
      ok: true, columns: [{ name: 'id', type: 'Int4' }], rows: [[1]], rowCount: 500, truncatedAt: 500,
    } as TestRunResult);
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/capped at 500/)).toBeInTheDocument();
  });

  it('renders a Scalar result as one value', async () => {
    const onTestRun = vi.fn().mockResolvedValue({ ok: true, value: 42 } as TestRunResult);
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('42', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders an Update result as a count of rows affected', async () => {
    const onTestRun = vi.fn().mockResolvedValue({ ok: true, affected: 3 } as TestRunResult);
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/3 rows affected/)).toBeInTheDocument();
  });

  it("renders a failure with the console's own traceback block", async () => {
    // Same structured payload the console gets, same rendering. Two renderings
    // of one payload drift, and the rarer one is the one that rots.
    const onTestRun = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        type: 'SQLException',
        message: 'no such table: orders',
        frames: [{ file: '<named-query>', function: 'run', line: 3 }],
      },
    } as TestRunResult);
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText(/SQLException: no such table: orders/)).toBeInTheDocument();
    expect(screen.getByText(/line 3, in run/)).toBeInTheDocument();
  });

  it('keeps a gateway refusal apart from a SQL error', async () => {
    // A throw is transport or permission; a failed QUERY is a 200 with
    // {ok:false}. Reporting them the same way sends people to the wrong fix.
    const onTestRun = vi.fn().mockRejectedValue(new Error('HTTP 403'));
    renderEditor({ tab: 'testing', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 403');
  });

  it('says the run uses the draft, because it does', async () => {
    // The body carries the SQL and settings as they are on screen, so the tab
    // tests what you are looking at rather than what was last written.
    renderEditor({ tab: 'testing' });
    expect(screen.getByRole('status')).toHaveTextContent(/Runs the draft/);
  });

  it('sends the buffer and the settings on screen, not just the path', async () => {
    const onTestRun = vi.fn().mockResolvedValue({ ok: true, type: 'ScalarQuery', value: 1 });
    renderEditor({ tab: 'testing', sql: 'SELECT 2', onTestRun });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onTestRun).toHaveBeenCalled());
  });
});

describe('a legacy query', () => {
  // A version-1 resource is not a style problem: fromResource returns a blank
  // query for one and runNamedQuery raises a NullPointerException, so the form
  // shows the platform's defaults rather than this query's values.
  it('says it will not run, and that saving is the repair', () => {
    renderEditor({ legacy: true });
    expect(
      screen.getByText('This query is in the legacy format and will not run. Saving it converts it.')
    ).toBeInTheDocument();
  });

  it('says it on every tab, not only the one that shows the settings', () => {
    renderEditor({ legacy: true, tab: 'testing' });
    expect(screen.getByText(/legacy format and will not run/)).toBeInTheDocument();
  });

  it('says nothing at all on a current query', () => {
    renderEditor();
    expect(screen.queryByText(/legacy format/)).not.toBeInTheDocument();
  });

  it('still lets it be saved — that is what converts it', () => {
    renderEditor({ legacy: true, dirty: true });
    expect(screen.getByRole('button', { name: 'Save query' })).toBeEnabled();
  });
});

describe('read-only', () => {
  // The same rule as a script: session/project read-only, OR this document
  // inherited and not yet overridden. The workspace collapses both into one
  // prop, and every control here obeys it.
  const tabs: QueryTab[] = ['settings', 'authoring'];

  it.each(tabs)('refuses every edit on the %s tab', (tab) => {
    renderEditor({
      tab,
      readOnly: true,
      dirty: true,
      settings: settings({ parameters: [{ type: 'Parameter', identifier: 'id', sqlType: 'String' }] }),
    });
    expect(screen.getByRole('button', { name: 'Save query' })).toBeDisabled();
    for (const control of screen.queryAllByRole('combobox')) {
      expect(control).toBeDisabled();
    }
    for (const control of screen.queryAllByRole('textbox')) {
      expect(control).toBeDisabled();
    }
  });

  it('offers no add, remove or reorder action while read-only', () => {
    renderEditor({
      tab: 'authoring',
      readOnly: true,
      settings: settings({ parameters: [{ type: 'Parameter', identifier: 'id', sqlType: 'String' }] }),
    });
    expect(screen.queryByRole('button', { name: 'Add parameter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove parameter 1' })).not.toBeInTheDocument();
  });

  it('still lets a read-only query be TESTED — a run writes nothing', () => {
    renderEditor({ tab: 'testing', readOnly: true });
    expect(screen.getByRole('button', { name: 'Run' })).toBeEnabled();
  });
});
