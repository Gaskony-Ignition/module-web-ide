import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/scripts')>()),
  fetchHistory: vi.fn(),
  readHistoryVersion: vi.fn(),
}));

import { fetchHistory, readHistoryVersion } from '../api/scripts';
import HistoryDialog, { sizeLabel, versionLabel } from './HistoryDialog';

const listApi = vi.mocked(fetchHistory);
const readApi = vi.mocked(readHistoryVersion);

function renderDialog(overrides: Partial<React.ComponentProps<typeof HistoryDialog>> = {}) {
  const props = {
    project: 'P',
    path: 'ignition/script-python/util',
    scriptKey: 'code.py',
    label: 'util',
    currentText: 'x = 2',
    onClose: vi.fn(),
    onLoad: vi.fn(),
    ...overrides,
  };
  render(<HistoryDialog {...props} />);
  return props;
}

describe('HistoryDialog', () => {
  beforeEach(() => {
    listApi.mockReset();
    readApi.mockReset();
  });

  it('lists the versions and selects the newest without a click', async () => {
    listApi.mockResolvedValue({
      versions: [
        { id: '3000', savedAt: 3000, size: 120 },
        { id: '2000', savedAt: 2000, size: 90 },
      ],
      maxVersions: 25,
    });
    readApi.mockResolvedValue('x = 1');
    renderDialog();
    expect(await screen.findByText('most recent', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(readApi).toHaveBeenCalledWith(
      'P', 'ignition/script-python/util', 'code.py', '3000'
    ));
  });

  it('says plainly when there is nothing saved yet', async () => {
    listApi.mockResolvedValue({ versions: [], maxVersions: 25 });
    renderDialog();
    expect(await screen.findByText(/Nothing saved from this IDE yet/)).toBeInTheDocument();
  });

  it('loads the selected version into the editor and closes — it does NOT write', async () => {
    // The whole safety property of this feature: a restore is an unsaved edit,
    // so the ordinary save path applies with its If-Match and inheritance rules.
    listApi.mockResolvedValue({ versions: [{ id: '3000', savedAt: 3000, size: 5 }], maxVersions: 25 });
    readApi.mockResolvedValue('x = 1');
    const props = renderDialog();
    const load = await screen.findByRole('button', { name: 'Load into editor' });
    await waitFor(() => expect(load).toBeEnabled());
    fireEvent.click(load);
    expect(props.onLoad).toHaveBeenCalledWith('x = 1');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('will not load a version identical to the buffer, and says why', async () => {
    // The commonest way a restore looks broken is that it restored what was
    // already there.
    listApi.mockResolvedValue({ versions: [{ id: '3000', savedAt: 3000, size: 5 }], maxVersions: 25 });
    readApi.mockResolvedValue('x = 2');
    renderDialog({ currentText: 'x = 2' });
    expect(await screen.findByText(/identical to what is in the editor now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load into editor' })).toBeDisabled();
  });

  it('names a failure to read the list', async () => {
    listApi.mockRejectedValue(new Error('no history store'));
    renderDialog();
    expect(await screen.findByText(/Could not read the history: no history store/))
      .toBeInTheDocument();
  });

  it('names a failure to read one version, and keeps the list', async () => {
    listApi.mockResolvedValue({ versions: [{ id: '3000', savedAt: 3000, size: 5 }], maxVersions: 25 });
    readApi.mockRejectedValue(new Error('pruned'));
    renderDialog();
    expect(await screen.findByText(/Could not read that version: pruned/)).toBeInTheDocument();
    expect(screen.getByText(/most recent/)).toBeInTheDocument();
  });

  it('switching version re-reads it', async () => {
    listApi.mockResolvedValue({
      versions: [
        { id: '3000', savedAt: 3000, size: 5 },
        { id: '2000', savedAt: 2000, size: 5 },
      ],
      maxVersions: 25,
    });
    readApi.mockResolvedValue('x = 1');
    renderDialog();
    await screen.findByText(/most recent/);
    const rows = screen.getAllByRole('button').filter((b) => b.className.includes('history-version'));
    fireEvent.click(rows[1]);
    await waitFor(() => expect(readApi).toHaveBeenCalledWith(
      'P', 'ignition/script-python/util', 'code.py', '2000'
    ));
  });
});

describe('the labels', () => {
  it('renders a size a person can read', () => {
    expect(sizeLabel(400)).toBe('400 B');
    expect(sizeLabel(2048)).toBe('2.0 KB');
  });

  it('says "unknown time" rather than 1970 for a version with no timestamp', () => {
    expect(versionLabel(0)).toBe('unknown time');
  });

  it('renders a real timestamp as a date and a 24-hour time', () => {
    const label = versionLabel(new Date(2026, 8, 5, 22, 30, 15).getTime());
    expect(label).toMatch(/05/);
    expect(label).toMatch(/22:30:15/);
  });
});
