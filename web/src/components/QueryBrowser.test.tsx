import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { isolateHistory, undo } from '@codemirror/commands';

vi.mock('../api/dbQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/dbQueries')>()),
  fetchDbDatasources: vi.fn(),
  fetchDbTables: vi.fn(),
  fetchDbColumns: vi.fn(),
  runDbQuery: vi.fn(),
  cancelDbQuery: vi.fn(),
  fetchDbQueryHistory: vi.fn(),
}));

vi.mock('../api/namedQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/namedQueries')>()),
  fetchNamedQueries: vi.fn(),
  createNamedQuery: vi.fn(),
  saveNamedQuerySettings: vi.fn(),
}));

import {
  cancelDbQuery, fetchDbColumns, fetchDbDatasources, fetchDbQueryHistory, fetchDbTables, runDbQuery,
  type DbConnectionFacts, type DbQueryRunResponse, type DbTableInfo,
} from '../api/dbQueries';
import { createNamedQuery, fetchNamedQueries, saveNamedQuerySettings } from '../api/namedQueries';
import { ApiError } from '../api/scripts';
import QueryBrowser from './QueryBrowser';

const DEFAULT_FACTS: DbConnectionFacts = {
  defaultSchema: null,
  identifierQuote: '"',
  storesLowerCaseIdentifiers: false,
  storesUpperCaseIdentifiers: false,
  databaseProductName: 'PostgreSQL',
};

function ordersTable(overrides: Partial<DbTableInfo> = {}): DbTableInfo {
  return { schema: null, name: 'Orders', type: 'TABLE', ...overrides };
}

/**
 * The live EditorView, the same way CodeEditor.test.tsx reaches it: through
 * `EditorView.findFromDOM`, not by scraping `.cm-content` text, which does not
 * reliably reflect newlines across CodeMirror's per-line DOM nodes.
 */
function activeView(): EditorView {
  const host = document.querySelector<HTMLElement>('.qb-editor .cm-editor');
  const view = host ? EditorView.findFromDOM(host) : null;
  if (!view) throw new Error('no EditorView mounted');
  return view;
}

function renderBrowser(overrides: Partial<React.ComponentProps<typeof QueryBrowser>> = {}) {
  return render(
    <QueryBrowser project="P" csrfToken="tok" isAdmin executionEnabled {...overrides} />
  );
}

/** Populate the (empty) buffer via the double-click snippet, then click Run. */
async function runWithSql() {
  const tableButton = await screen.findByRole('button', { name: 'Orders' });
  fireEvent.doubleClick(tableButton);
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(fetchDbDatasources).mockReset().mockResolvedValue([{ name: 'MyDb', status: 'VALID' }]);
  vi.mocked(fetchDbTables).mockReset()
    .mockResolvedValue({ tables: [ordersTable()], truncated: false, facts: DEFAULT_FACTS });
  vi.mocked(fetchDbColumns).mockReset()
    .mockResolvedValue({ columns: [{ name: 'id', type: 'int4' }], truncated: false });
  vi.mocked(runDbQuery).mockReset();
  vi.mocked(cancelDbQuery).mockReset().mockResolvedValue(true);
  vi.mocked(fetchDbQueryHistory).mockReset().mockResolvedValue({ runs: [], maxRuns: 50 });
  vi.mocked(fetchNamedQueries).mockReset().mockResolvedValue({ project: 'P', mutable: true, queries: [] });
  vi.mocked(createNamedQuery).mockReset().mockResolvedValue({ ok: true, signature: 'sig-1' });
  vi.mocked(saveNamedQuerySettings).mockReset().mockResolvedValue({ ok: true, signature: 'sig-2' });
});

// Safety net: no test in this file is meant to leave fake timers active, but
// a failing assertion partway through one that did would otherwise hang
// every test that runs after it.
afterEach(() => {
  vi.useRealTimers();
});

describe('QueryBrowser', () => {
  it('renders with the fetched datasource options', async () => {
    renderBrowser();
    expect(await screen.findByRole('option', { name: 'MyDb' })).toBeInTheDocument();
  });

  it('disables Run when no datasource is selected', async () => {
    vi.mocked(fetchDbDatasources).mockResolvedValue([]);
    renderBrowser();
    await waitFor(() => expect(fetchDbDatasources).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('disables Run and shows the denied notice, and does not browse either, without the role', async () => {
    renderBrowser({ isAdmin: false });
    await screen.findByRole('option', { name: 'MyDb' });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    const notice = document.querySelector('.qb-denied');
    expect(notice).not.toBeNull();
    expect(notice).toHaveAttribute('role', 'status');
    expect(notice).toHaveTextContent(/Administrator role/);
    expect(fetchDbTables).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Orders' })).not.toBeInTheDocument();
    expect(screen.getByText(/Browsing the schema requires the Administrator role/))
      .toBeInTheDocument();
  });

  it('disables Run but still browses the schema when execution is disabled gateway-wide', async () => {
    renderBrowser({ isAdmin: true, executionEnabled: false });
    await screen.findByRole('option', { name: 'MyDb' });
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    expect(screen.getByText(/disabled on this gateway/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Orders' })).toBeInTheDocument();
  });

  it('inserts SELECT * FROM <table> on double-click when the buffer is empty', async () => {
    renderBrowser();
    const tableButton = await screen.findByRole('button', { name: 'Orders' });
    fireEvent.doubleClick(tableButton);
    expect(activeView().state.doc.toString()).toBe('SELECT * FROM Orders\n');
  });

  it('inserts at the caret instead of destroying existing text on double-click', async () => {
    renderBrowser();
    const tableButton = await screen.findByRole('button', { name: 'Orders' });
    fireEvent.click(screen.getByRole('button', { name: 'Orders' }));
    await waitFor(() => expect(activeView().state.doc.toString()).toBe('Orders'));
    fireEvent.doubleClick(tableButton);
    expect(activeView().state.doc.toString()).not.toBe('SELECT * FROM Orders\n');
    expect(activeView().state.doc.toString()).toContain('SELECT * FROM Orders');
  });

  it('posts a client-generated runId, the SQL and the CSRF token when Run is clicked', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'server-does-not-choose-this', elapsedMs: 5, results: [{ affected: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalled());
    expect(runDbQuery).toHaveBeenCalledWith(expect.objectContaining({
      runId: expect.any(String),
      datasource: 'MyDb',
      sql: 'SELECT * FROM Orders\n',
      maxRows: 1000,
      project: 'P',
      csrfToken: 'tok',
    }));
  });

  it('renders a rows-result via the results grid', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true,
      runId: 'r1',
      elapsedMs: 12,
      results: [{
        columns: [{ name: 'id', type: 'int4' }],
        rows: [[1], [2]],
        rowCount: 2,
      }],
    });
    renderBrowser();
    await runWithSql();
    expect(await screen.findByText('id (int4)')).toBeInTheDocument();
    expect(document.querySelector('.qb-table')).not.toBeNull();
  });

  it('renders an affected-only result as a one-line summary', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 3, results: [{ affected: 4 }],
    });
    renderBrowser();
    await runWithSql();
    expect(await screen.findByText('4 rows affected.')).toBeInTheDocument();
  });

  it('renders a failed run via Traceback, not as a thrown error', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: false,
      runId: 'r1',
      elapsedMs: 4,
      error: {
        type: 'SQLException', message: 'no such table',
        rendered: 'no such table (SQLState 42S02, error code 0)', frames: [],
      },
    });
    renderBrowser();
    await runWithSql();
    expect(await screen.findByText(/SQLException: no such table/)).toBeInTheDocument();
  });

  it('cancels an in-flight run when the component unmounts', async () => {
    vi.mocked(runDbQuery).mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderBrowser();
    await runWithSql();
    unmount();
    await waitFor(() => expect(cancelDbQuery).toHaveBeenCalled());
  });

  it('a columns fetch in flight when the datasource changes does not land in the new datasource cache', async () => {
    vi.mocked(fetchDbDatasources).mockResolvedValue([
      { name: 'DbA', status: 'VALID' }, { name: 'DbB', status: 'VALID' },
    ]);
    let resolveColumnsForA: (value: { columns: { name: string; type: string }[]; truncated: boolean }) => void =
      () => {};
    vi.mocked(fetchDbTables).mockResolvedValue({
      tables: [{ schema: null, name: 'SameName', type: 'TABLE' }], truncated: false, facts: DEFAULT_FACTS,
    });
    vi.mocked(fetchDbColumns).mockImplementation((datasource: string) => {
      if (datasource === 'DbA') {
        return new Promise((resolve) => { resolveColumnsForA = resolve; });
      }
      return Promise.resolve({ columns: [{ name: 'b_col', type: 'varchar' }], truncated: false });
    });

    renderBrowser();
    await screen.findByRole('option', { name: 'DbA' });
    await screen.findByRole('button', { name: 'SameName' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand SameName' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Datasource' }), { target: { value: 'DbB' } });
    await screen.findByRole('button', { name: 'SameName' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand SameName' }));
    await screen.findByText('b_col');

    resolveColumnsForA({ columns: [{ name: 'a_col', type: 'varchar' }], truncated: false });
    await Promise.resolve();
    expect(screen.queryByText('a_col')).not.toBeInTheDocument();
    expect(screen.getByText('b_col')).toBeInTheDocument();
  });

  it('sends the same runId to cancel that the run was started with', async () => {
    let resolveRun: (value: DbQueryRunResponse) => void = () => {};
    vi.mocked(runDbQuery).mockImplementation(() => new Promise<DbQueryRunResponse>((resolve) => {
      resolveRun = resolve;
    }));
    renderBrowser();
    await runWithSql();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(cancelDbQuery).toHaveBeenCalled());
    const sentRunId = (vi.mocked(runDbQuery).mock.calls[0][0]).runId;
    expect(cancelDbQuery).toHaveBeenCalledWith({ runId: sentRunId, csrfToken: 'tok' });
    resolveRun({
      ok: false, runId: sentRunId, elapsedMs: 1,
      error: { type: 'Stopped', message: 'The query was stopped.', frames: [] },
    });
  });
});

describe('QueryBrowser — schema-qualified names (A)', () => {
  it('a table outside the default schema is inserted qualified', async () => {
    vi.mocked(fetchDbTables).mockResolvedValue({
      tables: [{ schema: 'reporting', name: 'orders', type: 'TABLE' }],
      truncated: false,
      facts: { ...DEFAULT_FACTS, defaultSchema: 'public', storesLowerCaseIdentifiers: true },
    });
    renderBrowser();
    const tableButton = await screen.findByRole('button', { name: 'reporting.orders' });
    fireEvent.doubleClick(tableButton);
    expect(activeView().state.doc.toString()).toBe('SELECT * FROM reporting.orders\n');
  });

  it('a name needing quoting is quoted on insert', async () => {
    vi.mocked(fetchDbTables).mockResolvedValue({
      tables: [{ schema: 'public', name: 'Orders', type: 'TABLE' }],
      truncated: false,
      facts: { ...DEFAULT_FACTS, defaultSchema: 'public', storesLowerCaseIdentifiers: true },
    });
    renderBrowser();
    const tableButton = await screen.findByRole('button', { name: '"Orders"' });
    fireEvent.doubleClick(tableButton);
    expect(activeView().state.doc.toString()).toBe('SELECT * FROM "Orders"\n');
  });

  it('groups the tree under schema headings when several schemas are present', async () => {
    vi.mocked(fetchDbTables).mockResolvedValue({
      tables: [
        { schema: 'sales', name: 'orders', type: 'TABLE' },
        { schema: 'archive', name: 'orders', type: 'TABLE' },
      ],
      truncated: false,
      facts: { ...DEFAULT_FACTS, defaultSchema: 'sales' },
    });
    renderBrowser();
    expect(await screen.findByText(/sales \(default\)/)).toBeInTheDocument();
    expect(screen.getByText('archive')).toBeInTheDocument();
    // Duplicate table names in different schemas both appear, distinctly:
    // the default-schema one bare, the other schema-qualified.
    expect(screen.getByRole('button', { name: 'orders' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'archive.orders' })).toBeInTheDocument();
  });

  it('does not group when only one schema is in play', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Orders' });
    expect(document.querySelector('.qb-schema-group')).toBeNull();
  });
});

describe('QueryBrowser — SQL completion (B)', () => {
  it('offers a loaded table name from a typed prefix', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Orders' });
    const view = activeView();
    await act(async () => {
      view.dispatch({ changes: { from: 0, insert: 'SELECT * FROM Ord' } });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      startCompletion(view);
      await new Promise((resolve) => { window.setTimeout(resolve, 100); });
    });
    const labels = Array.from(document.querySelectorAll('.cm-completionLabel')).map((n) => n.textContent);
    expect(labels).toContain('Orders');
  });

  it('accepting a completion for a mixed-case table inserts it QUOTED — lang-sql does the quoting, not a pre-quoted namespace key', async () => {
    vi.mocked(fetchDbTables).mockResolvedValue({
      tables: [{ schema: null, name: 'MixedCase', type: 'TABLE' }], truncated: false, facts: DEFAULT_FACTS,
    });
    renderBrowser();
    await screen.findByRole('button', { name: 'MixedCase' });
    const view = activeView();
    view.focus();
    act(() => {
      view.dispatch({ changes: { from: 0, insert: 'SELECT * FROM Mixed' } });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      startCompletion(view);
    });
    // Read the completion's own `apply` text rather than driving
    // `acceptCompletion`'s async command dispatch — a busy full-suite run
    // leaves too small a window between the tooltip settling and the accept
    // command reading it, which flaked here; the `apply` field is what
    // actually gets inserted either way, so this proves the same thing
    // without racing the tooltip's own lifecycle.
    let mixedCase: ReturnType<typeof currentCompletions>[number] | undefined;
    await waitFor(() => {
      mixedCase = currentCompletions(view.state).find((c) => c.label === 'MixedCase');
      expect(mixedCase).toBeDefined();
    });
    // PostgreSQL folds an unquoted identifier to lower case, so a mixed-case
    // name only round-trips quoted — this is `lang-sql`'s own
    // `caseInsensitiveIdentifiers` behaviour (default false), proving the
    // namespace handed it the RAW name rather than a pre-quoted string (a
    // pre-quoted key would show up quoted in `label` too, not just `apply`).
    expect(mixedCase?.label).toBe('MixedCase');
    expect(mixedCase?.apply).toBe('"MixedCase"');
  });
});

describe('QueryBrowser — save as named query (C)', () => {
  it('opens the dialog and, on save, shows a confirmation and calls onNamedQuerySaved', async () => {
    const onNamedQuerySaved = vi.fn();
    renderBrowser({ onNamedQuerySaved });
    await screen.findByRole('option', { name: 'MyDb' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as Named Query…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: 'Orders/Totals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createNamedQuery).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'P', path: 'Orders/Totals' })
    ));
    // ONE write — settings ride along with the sql on the same create push,
    // never a follow-up saveNamedQuerySettings call.
    expect(saveNamedQuerySettings).not.toHaveBeenCalled();
    expect(await screen.findByText(/Saved as Orders\/Totals/)).toBeInTheDocument();
    expect(onNamedQuerySaved).toHaveBeenCalledWith('Orders/Totals');
  });

  it('offers to open the saved query only when onOpenNamedQuery is given (main workspace, not a pop-out)', async () => {
    const onOpenNamedQuery = vi.fn();
    renderBrowser({ onOpenNamedQuery });
    await screen.findByRole('option', { name: 'MyDb' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as Named Query…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: 'Orders/Totals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    const openButton = await screen.findByRole('button', { name: 'Open in editor' });
    fireEvent.click(openButton);
    expect(onOpenNamedQuery).toHaveBeenCalledWith('Orders/Totals');
  });

  it('in a pop-out (no callbacks given) the confirmation has no Open button', async () => {
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as Named Query…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: 'Orders/Totals' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as Orders\/Totals/);
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
  });

  it('refuses to overwrite an existing named query at the same path', async () => {
    vi.mocked(fetchNamedQueries).mockResolvedValue({
      project: 'P', mutable: true,
      queries: [{ path: 'Orders/Totals', name: 'Totals', folder: 'Orders', signature: 's', origin: 'local', owner: 'P' }],
    });
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    fireEvent.click(screen.getByRole('button', { name: 'Save as Named Query…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Path'), { target: { value: 'Orders/Totals' } });
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(createNamedQuery).not.toHaveBeenCalled();
  });
});

describe('QueryBrowser — auto-refresh (E)', () => {
  it('refuses a nonzero interval before any eligible run has happened', async () => {
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(await screen.findByText(/Auto-refresh is off/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('0');
  });

  it('refuses to enable after a run that included an update (not every result was a result set)', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({ ok: true, runId: 'r1', elapsedMs: 1, results: [{ affected: 1 }] });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalled());
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(await screen.findByText(/Auto-refresh is off/)).toBeInTheDocument();
  });

  it('shows a countdown once enabled, against the last executed SQL', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('30');
    expect(await screen.findByText(/next refresh in 30s/)).toBeInTheDocument();
    // The actual interval firing — reunning the SAME sql, not the live buffer,
    // with recordHistory:false — is proved live (validate_query_browser.py),
    // where a real clock and a real gateway make the timing meaningful; a
    // fake-timer unit test here only proves jsdom's own timer plumbing.
  });

  it('stops on a manual run of different SQL', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('30');

    const view = activeView();
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'SELECT 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('0');
  });

  it('stops on Stop', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('30');

    let resolveRun: (value: DbQueryRunResponse) => void = () => {};
    vi.mocked(runDbQuery).mockImplementation(() => new Promise<DbQueryRunResponse>((resolve) => {
      resolveRun = resolve;
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('0');
    resolveRun({
      ok: false, runId: 'r2', elapsedMs: 1,
      error: { type: 'Stopped', message: 'The query was stopped.', frames: [] },
    });
  });

  it('stops on a datasource change', async () => {
    vi.mocked(fetchDbDatasources).mockResolvedValue([
      { name: 'DbA', status: 'VALID' }, { name: 'DbB', status: 'VALID' },
    ]);
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await screen.findByRole('option', { name: 'DbA' });
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('30');

    fireEvent.change(screen.getByRole('combobox', { name: 'Datasource' }), { target: { value: 'DbB' } });
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('0');
  });

  it('a run with no results, or with a truncated result, is not eligible — enabling refuses', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({ ok: true, runId: 'r1', elapsedMs: 1, results: [] });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(await screen.findByText(/Auto-refresh is off/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('0');
  });

  it('a truncated result set is not eligible either', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1, resultsTruncated: true,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '30' } });
    expect(await screen.findByText(/Auto-refresh is off/)).toBeInTheDocument();
  });

  it('the tick reruns the LAST EXECUTED sql, not the live buffer, with recordHistory:false and readOnly:true', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    const executedSql = vi.mocked(runDbQuery).mock.calls[0][0].sql;

    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '5' } });
    // Edit the LIVE buffer after enabling — the tick must ignore this.
    activeView().dispatch({
      changes: { from: 0, to: activeView().state.doc.length, insert: 'SELECT 999' },
    });

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runDbQuery).mock.calls[1][0]).toMatchObject({
      sql: executedSql, recordHistory: false, readOnly: true,
    });
  });

  it('reads the LATEST maxRows on the tick, not whatever it was when auto-refresh was enabled', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max rows' }), { target: { value: '42' } });

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runDbQuery).mock.calls[1][0]).toMatchObject({ maxRows: 42 });
  });

  it('a 409 (too many queries running) on the tick is treated as transient — auto-refresh stays on', async () => {
    vi.mocked(runDbQuery).mockResolvedValueOnce({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '5' } });

    vi.mocked(runDbQuery).mockRejectedValueOnce(new ApiError(409, 'Too many queries already running'));
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('5');
    expect(screen.queryByText(/Auto-refresh is off/)).not.toBeInTheDocument();
  });

  it('a non-409 failure on the tick DOES stop auto-refresh', async () => {
    vi.mocked(runDbQuery).mockResolvedValueOnce({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '5' } });

    vi.mocked(runDbQuery).mockRejectedValueOnce(new Error('connection reset'));
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Auto-refresh' })).toHaveValue('0'));
    expect(await screen.findByText(/Auto-refresh is off/)).toBeInTheDocument();
  });
});

describe('QueryBrowser — run statement under cursor (G)', () => {
  it('the toolbar button runs only the statement containing the cursor', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({ ok: true, runId: 'r1', elapsedMs: 1, results: [{ affected: 1 }] });
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    const view = activeView();
    view.dispatch({ changes: { from: 0, insert: 'SELECT 1;\nSELECT 2;' } });
    // Place the cursor inside "SELECT 2".
    const cursor = view.state.doc.toString().indexOf('SELECT 2') + 3;
    view.dispatch({ selection: { anchor: cursor } });

    fireEvent.click(screen.getByRole('button', { name: 'Run statement' }));
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledWith(expect.objectContaining({ sql: 'SELECT 2' })));
  });

  it('a cursor on a blank line between statements runs nothing and says so', async () => {
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    const view = activeView();
    view.dispatch({ changes: { from: 0, insert: 'SELECT 1;\n\nSELECT 2;' } });
    const blankLine = view.state.doc.toString().indexOf('\n\n') + 1;
    view.dispatch({ selection: { anchor: blankLine } });

    fireEvent.click(screen.getByRole('button', { name: 'Run statement' }));
    expect(await screen.findByText(/nothing to run/i)).toBeInTheDocument();
    expect(runDbQuery).not.toHaveBeenCalled();
  });

  it('an unterminated string refuses with a message rather than guessing a statement', async () => {
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    const view = activeView();
    view.dispatch({ changes: { from: 0, insert: "SELECT 'unterminated" } });
    view.dispatch({ selection: { anchor: 3 } });

    fireEvent.click(screen.getByRole('button', { name: 'Run statement' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/unterminated/i);
    expect(runDbQuery).not.toHaveBeenCalled();
  });
});

describe('QueryBrowser — Clear SQL', () => {
  it('empties the editor as an undoable edit and forgets the stored buffer', async () => {
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    const view = activeView();
    // isolateHistory: these two edits happen milliseconds apart in a test,
    // which CodeMirror's history would otherwise GROUP into one undo step —
    // exactly the way two real keystrokes typed quickly are one step, but
    // not how "type a query, then click Clear" should behave.
    view.dispatch({ changes: { from: 0, insert: 'SELECT 1' }, annotations: isolateHistory.of('after') });
    expect(window.localStorage.getItem('scriptide.query.sql')).toBe('SELECT 1');

    fireEvent.click(screen.getByRole('button', { name: 'Clear SQL' }));
    expect(view.state.doc.toString()).toBe('');
    expect(window.localStorage.getItem('scriptide.query.sql')).toBeNull();

    // An ordinary edit — Ctrl+Z (the `undo` command, bound in historyKeymap)
    // brings it back.
    undo(view);
    expect(view.state.doc.toString()).toBe('SELECT 1');
  });

  it('every keystroke flushes to storage synchronously, not on a debounce', async () => {
    renderBrowser();
    await screen.findByRole('option', { name: 'MyDb' });
    const view = activeView();
    view.dispatch({ changes: { from: 0, insert: 'S' } });
    // No timer advance at all — a reload right after one keystroke must
    // already see it.
    expect(window.localStorage.getItem('scriptide.query.sql')).toBe('S');
  });
});

describe('QueryBrowser — ResultsGrid identity across a run (auto-refresh must not reset it)', () => {
  it('a manual run of different SQL resets the grid; an auto-refresh tick of the SAME sql does not', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{
        columns: [{ name: 'id', type: 'int4' }],
        rows: [[3], [1], [2]],
        rowCount: 3,
      }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(1));

    // Sort the grid.
    fireEvent.click(screen.getByRole('button', { name: /id \(int4\)/ }));
    expect(screen.getByRole('columnheader', { name: /id/ })).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.change(screen.getByRole('combobox', { name: 'Auto-refresh' }), { target: { value: '5' } });
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(5000);
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(2));
    // The auto-refresh tick reran the SAME sql — sort must survive it.
    expect(screen.getByRole('columnheader', { name: /id/ })).toHaveAttribute('aria-sort', 'ascending');

    // A manual run of DIFFERENT sql is a genuinely new query — sort resets.
    activeView().dispatch({
      changes: { from: 0, to: activeView().state.doc.length, insert: 'SELECT 2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runDbQuery).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('columnheader', { name: /id/ })).not.toHaveAttribute('aria-sort');
  });
});

describe('QueryBrowser — refreshing the schema tree', () => {
  it('the refresh button reloads the tables past the gateway cache', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Orders' });
    expect(fetchDbTables).toHaveBeenLastCalledWith('MyDb', false);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh tables' }));

    await waitFor(() => expect(fetchDbTables).toHaveBeenLastCalledWith('MyDb', true));
    await screen.findByRole('button', { name: 'Orders' });
  });

  it('a run that returns an update count (CREATE TABLE, say) reloads the tree', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({ ok: true, runId: 'r1', elapsedMs: 1, results: [{ affected: 0 }] });
    renderBrowser();
    await runWithSql();

    await waitFor(() => expect(fetchDbTables).toHaveBeenLastCalledWith('MyDb', true));
  });

  it('a run that only returns rows leaves the tree alone', async () => {
    vi.mocked(runDbQuery).mockResolvedValue({
      ok: true, runId: 'r1', elapsedMs: 1,
      results: [{ columns: [{ name: 'id', type: 'int4' }], rows: [[1]], rowCount: 1 }],
    });
    renderBrowser();
    await runWithSql();
    await waitFor(() => expect(runDbQuery).toHaveBeenCalled());
    await Promise.resolve();

    expect(fetchDbTables).not.toHaveBeenCalledWith('MyDb', true);
  });
});
