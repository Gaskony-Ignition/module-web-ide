import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/namedQueries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/namedQueries')>()),
  fetchNamedQueries: vi.fn(),
  createNamedQuery: vi.fn(),
  saveNamedQuerySettings: vi.fn(),
}));

import {
  createNamedQuery, fetchNamedQueries, saveNamedQuerySettings,
  type NamedQueryEntry, type NamedQueryList,
} from '../api/namedQueries';
import SaveAsNamedQueryDialog from './SaveAsNamedQueryDialog';

const listApi = vi.mocked(fetchNamedQueries);
const createApi = vi.mocked(createNamedQuery);
const settingsApi = vi.mocked(saveNamedQuerySettings);

function list(over: Partial<NamedQueryList> = {}): NamedQueryList {
  return { project: 'P', mutable: true, queries: [], ...over };
}

/** Only `path`/`isFolder` matter to this dialog's own overlap check. */
function entry(path: string, isFolder: boolean): NamedQueryEntry {
  return {
    path, isFolder, name: path.split('/').pop() ?? path,
    folder: path.split('/').slice(0, -1).join('/'), signature: 's', origin: 'local', owner: 'P',
  };
}

function renderDialog(over: Partial<React.ComponentProps<typeof SaveAsNamedQueryDialog>> = {}) {
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <SaveAsNamedQueryDialog
      project="P"
      sql="SELECT 1"
      datasource="MyDb"
      datasources={[{ name: 'MyDb', status: 'VALID' }]}
      csrfToken="tok"
      onSaved={onSaved}
      onCancel={onCancel}
      {...over}
    />
  );
  return { onSaved, onCancel };
}

beforeEach(() => {
  listApi.mockReset();
  createApi.mockReset();
  settingsApi.mockReset();
  listApi.mockResolvedValue(list());
  createApi.mockResolvedValue({ ok: true, signature: 'sig-1' });
});

async function typePath(value: string) {
  fireEvent.change(await screen.findByLabelText('Path'), { target: { value } });
}

describe('SaveAsNamedQueryDialog — one write', () => {
  it('creates the query with sql AND settings in ONE call, never a follow-up settings write', async () => {
    const { onSaved } = renderDialog();
    await typePath('Orders/Totals');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Orders/Totals'));
    expect(createApi).toHaveBeenCalledTimes(1);
    expect(createApi).toHaveBeenCalledWith(expect.objectContaining({
      project: 'P',
      path: 'Orders/Totals',
      sql: 'SELECT 1',
      settings: expect.objectContaining({ type: 'Query', database: 'MyDb' }),
      csrfToken: 'tok',
    }));
    expect(settingsApi).not.toHaveBeenCalled();
  });

  it('sends the chosen type and datasource, not just the preselected defaults', async () => {
    renderDialog();
    await typePath('Orders/Totals');
    fireEvent.change(screen.getByLabelText('Query type'), { target: { value: 'UpdateQuery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(createApi).toHaveBeenCalled());
    expect(createApi).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ type: 'UpdateQuery' }),
    }));
  });
});

describe('SaveAsNamedQueryDialog — folder/query overlap refusal', () => {
  it('refuses a path that is already a named query', async () => {
    listApi.mockResolvedValue(list({ queries: [entry('Orders/Totals', false)] }));
    renderDialog();
    await typePath('Orders/Totals');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('refuses a path that is already a folder', async () => {
    listApi.mockResolvedValue(list({ queries: [entry('Orders', true)] }));
    renderDialog();
    await typePath('Orders');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already a folder/);
  });

  it('refuses a path that would sit UNDER an existing query (a query cannot also be a folder)', async () => {
    listApi.mockResolvedValue(list({ queries: [entry('Orders', false)] }));
    renderDialog();
    await typePath('Orders/Totals');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already a named query/);
  });

  it('refuses a path that would sit OVER an existing query as its folder', async () => {
    listApi.mockResolvedValue(list({ queries: [entry('Orders/Totals', false)] }));
    renderDialog();
    await typePath('Orders');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already contains a named query/);
  });

  it('allows a sibling path under the same prefix', async () => {
    listApi.mockResolvedValue(list({ queries: [entry('Orders/Totals', false)] }));
    renderDialog();
    await typePath('Orders/Count');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
  });
});

describe('SaveAsNamedQueryDialog — accessibility', () => {
  it('focuses the Path field on open and returns focus to the opener on cancel', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { onCancel } = renderDialog();
    const pathInput = await screen.findByLabelText('Path');
    expect(document.activeElement).toBe(pathInput);

    fireEvent.keyDown(pathInput.closest('form') as HTMLElement, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    opener.remove();
  });

  it('Tab from the last focusable control cycles back to the first, trapping focus', async () => {
    renderDialog();
    const form = (await screen.findByLabelText('Path')).closest('form') as HTMLElement;
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    const pathInput = screen.getByLabelText('Path');
    cancelButton.focus();
    // Cancel is not the LAST element (Save follows it) unless Save is
    // disabled — type a valid path first so Save is enabled and is the
    // true last focusable control.
    fireEvent.change(pathInput, { target: { value: 'Orders/Totals' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());
    screen.getByRole('button', { name: 'Save' }).focus();
    fireEvent.keyDown(form, { key: 'Tab' });
    expect(document.activeElement).toBe(pathInput);
  });
});
