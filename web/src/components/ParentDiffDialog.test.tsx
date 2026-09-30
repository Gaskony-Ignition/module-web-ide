import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/scripts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/scripts')>()),
  readInheritedContent: vi.fn(),
}));

import { ApiError, readInheritedContent } from '../api/scripts';
import ParentDiffDialog from './ParentDiffDialog';

const readApi = vi.mocked(readInheritedContent);

function renderDialog(mine: string) {
  render(
    <ParentDiffDialog
      project="Child"
      path="ignition/script-python/util/helpers"
      scriptKey="code.py"
      label="util.helpers"
      mine={mine}
      onClose={vi.fn()}
    />
  );
}

describe('ParentDiffDialog', () => {
  // mockClear, not mockReset: every test sets its own implementation, and
  // resetting the whole mock between them left the rejection cases handing back
  // a promise nothing was listening to.
  beforeEach(() => {
    readApi.mockClear();
  });

  it('names the project it is comparing against', async () => {
    // "the parent" is not specific enough to act on when there is a chain.
    readApi.mockResolvedValue({ text: 'x = 1\n', parent: 'Template' });
    renderDialog('x = 2\n');
    expect(await screen.findByText(/compared with Template/)).toBeInTheDocument();
  });

  it('counts the differing lines', async () => {
    readApi.mockResolvedValue({ text: 'a\nb\nc\n', parent: 'Template' });
    renderDialog('a\nCHANGED\nc\n');
    expect(await screen.findByText(/2 lines differ from Template/)).toBeInTheDocument();
  });

  it('says plainly when an override changes nothing', async () => {
    // Worth stating: an override that differs in no line can be discarded with
    // no loss, and that is not obvious from a diff of blank rows.
    readApi.mockResolvedValue({ text: 'same\n', parent: 'Template' });
    renderDialog('same\n');
    expect(await screen.findByText(/changes nothing/)).toBeInTheDocument();
  });

  it('reads a 404 as an ANSWER, not a failure', async () => {
    // mockImplementation, not mockRejectedValue: the latter builds the rejected
    // promise at SETUP time, so it is unhandled until the component gets to it
    // and vitest reports it as an unhandled rejection rather than a pass.
    readApi.mockImplementation(() => Promise.reject(new ApiError(404, 'no parent copy')));
    renderDialog('x = 1\n');
    expect(await screen.findByText(/nothing is being overridden/)).toBeInTheDocument();
  });

  it('reports a real failure as one', async () => {
    readApi.mockImplementation(() => Promise.reject(new ApiError(502, 'gateway said no')));
    renderDialog('x = 1\n');
    expect(await screen.findByText(/gateway said no/)).toBeInTheDocument();
  });

  it('marks a line the override ADDS with +, and one it drops with a minus', async () => {
    readApi.mockResolvedValue({ text: 'keep\ngone\n', parent: 'Template' });
    renderDialog('keep\nnew\n');
    await screen.findByText(/lines differ/);
    const added = document.querySelectorAll('.parentdiff-row.is-added');
    const removed = document.querySelectorAll('.parentdiff-row.is-removed');
    expect(added).toHaveLength(1);
    expect(removed).toHaveLength(1);
    expect(added[0].textContent).toContain('new');
    expect(removed[0].textContent).toContain('gone');
  });

  it('offers no button that writes — it is a comparison, not a decision', async () => {
    readApi.mockResolvedValue({ text: 'a\n', parent: 'Template' });
    renderDialog('b\n');
    await screen.findByText(/lines differ|line differs/);
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels.filter((l) => l && l !== '×' && l !== 'Close')).toHaveLength(0);
  });
});
