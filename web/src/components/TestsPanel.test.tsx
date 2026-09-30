import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestListing, TestResult, TestRun } from '../api/tests';

vi.mock('../api/tests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/tests')>()),
  fetchTests: vi.fn(),
  runTests: vi.fn(),
}));

import { fetchTests, runTests } from '../api/tests';
import TestsPanel from './TestsPanel';

const CONVENTION =
  "A test is a top-level def test_* (or a test_* method on a class named Test*) in a module "
  + "whose last name starts with 'test' or that sits under a 'tests' package.";
const HELPER_IMPORT = 'from scriptide import test, assertEquals, mockTags';

function listing(overrides: Partial<TestListing> = {}): TestListing {
  return {
    project: 'MyProject',
    total: 2,
    convention: CONVENTION,
    helperImport: HELPER_IMPORT,
    modules: [{
      module: 'orders.test_totals',
      hasSetUp: true,
      hasTearDown: false,
      hasBeforeAll: false,
      hasAfterAll: false,
      hasBeforeEach: false,
      hasAfterEach: false,
      tests: [
        {
          id: 'orders.test_totals.test_sums', function: 'test_sums', line: 4,
          decorated: false, skipped: false,
        },
        {
          id: 'orders.test_totals.test_rounds', function: 'test_rounds', line: 9,
          decorated: false, skipped: false,
        },
      ],
    }],
    ...overrides,
  };
}

function passResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'orders.test_totals.test_sums', module: 'orders.test_totals', function: 'test_sums',
    status: 'pass', message: '', traceback: '', output: '', outputTruncated: false,
    elapsedMs: 3, parentId: 'orders.test_totals.test_sums', case: null,
    ...overrides,
  };
}

function failResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    id: 'orders.test_totals.test_rounds', module: 'orders.test_totals',
    function: 'test_rounds', status: 'fail', message: 'expected 4, got 5',
    traceback: 'Traceback...\nAssertionError', output: 'about to round\n',
    outputTruncated: false, elapsedMs: 39,
    parentId: 'orders.test_totals.test_rounds', case: null,
    ...overrides,
  };
}

function run(overrides: Partial<TestRun> = {}): TestRun {
  return {
    requested: 2,
    passed: 1,
    failed: 1,
    errored: 0,
    skipped: 0,
    elapsedMs: 42,
    results: [passResult(), failResult()],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchTests).mockReset();
  vi.mocked(runTests).mockReset();
});

describe('TestsPanel', () => {
  // A discovery convention nobody can see reads as a broken feature: the first
  // thing anyone does with an empty test panel is wonder whether it works.
  it('states the discovery rule when the project declares no tests', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing({ total: 0, modules: [] }));
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    expect(await screen.findByText(new RegExp('module whose last name starts'))).toBeTruthy();
  });

  it('lists each module with its tests', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    expect(await screen.findByText('orders.test_totals')).toBeTruthy();
    expect(screen.getByText('test_sums')).toBeTruthy();
    expect(screen.getByText('test_rounds')).toBeTruthy();
  });

  it('badges a module that brackets its tests with setUp', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    expect(await screen.findByText('setUp')).toBeTruthy();
    expect(screen.queryByText('tearDown')).toBeNull();
  });

  it('badges a module that declares beforeAll/afterEach fixtures', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing({
      modules: [{
        module: 'orders.test_totals',
        hasSetUp: false,
        hasTearDown: false,
        hasBeforeAll: true,
        hasAfterAll: false,
        hasBeforeEach: false,
        hasAfterEach: true,
        tests: listing().modules[0].tests,
      }],
    }));
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    expect(await screen.findByText('beforeAll')).toBeTruthy();
    expect(screen.getByText('afterEach')).toBeTruthy();
    expect(screen.queryByText('afterAll')).toBeNull();
    expect(screen.queryByText('beforeEach')).toBeNull();
  });

  // A visible Run that always 403s teaches people the tool is broken rather
  // than that they lack a role.
  it('offers no run button to a reader who cannot execute', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    render(<TestsPanel project="P" csrfToken="t" canRun={false} onOpenTest={vi.fn()} />);
    await screen.findByText('orders.test_totals');
    expect(screen.queryByRole('button', { name: /Run all/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-run/ })).toBeNull();
  });

  it('runs everything with no id list', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    await waitFor(() => expect(runTests).toHaveBeenCalledWith('P', undefined, 't'));
  });

  it('runs one module with just its ids', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await waitFor(() => expect(runTests).toHaveBeenCalledWith(
      'P', ['orders.test_totals.test_sums', 'orders.test_totals.test_rounds'], 't'
    ));
  });

  it('runs one test alone', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run orders.test_totals.test_sums' }));
    await waitFor(() => expect(runTests).toHaveBeenCalledWith(
      'P', ['orders.test_totals.test_sums'], 't'
    ));
  });

  it('shows a tally of the four outcomes', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run({ errored: 2, skipped: 1 }));
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    expect(await screen.findByText('1 passed')).toBeTruthy();
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(screen.getByText('2 errored')).toBeTruthy();
    expect(screen.getByText('1 skipped')).toBeTruthy();
  });

  it('does not show a skipped count when nothing was skipped', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    await screen.findByText('1 passed');
    expect(screen.queryByText(/skipped/)).toBeNull();
  });

  // An error is a test that never got far enough to have an opinion; calling it
  // "failed" sends the reader to an assertion that never executed.
  it('keeps fail and error distinct in the detail', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run({
      results: [{
        id: 'orders.test_totals.test_sums', module: 'orders.test_totals', function: 'test_sums',
        status: 'error', message: 'ImportError: no module named nope', traceback: 'tb',
        output: '', outputTruncated: false, elapsedMs: 1,
        parentId: 'orders.test_totals.test_sums', case: null,
      }],
    }));
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Why' }));
    expect(await screen.findByText('errored')).toBeTruthy();
    expect(screen.getByText(/ImportError/)).toBeTruthy();
  });

  it('offers no reason toggle on a test that passed', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run({
      results: [run().results[0]], passed: 1, failed: 0,
    }));
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    await screen.findByText('1 passed');
    expect(screen.queryByRole('button', { name: 'Why' })).toBeNull();
  });

  // What a test printed before it failed is the question a failure always
  // raises, and one interpreter per run means it has to be captured per test.
  it('shows the output a failing test produced', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Why' }));
    expect(await screen.findByText(/about to round/)).toBeTruthy();
  });

  it('opens the module at the test definition', async () => {
    const onOpenTest = vi.fn();
    vi.mocked(fetchTests).mockResolvedValue(listing());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={onOpenTest} />);
    fireEvent.click(await screen.findByText('test_rounds'));
    expect(onOpenTest).toHaveBeenCalledWith('orders.test_totals', 9);
  });

  it('describes the per-run namespace, replacing the old shared-module-state note', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    expect(await screen.findByText(/does not carry between runs/)).toBeTruthy();
    expect(screen.getByText(/share one interpreter/)).toBeTruthy();
  });

  it('reports a refusal instead of an empty result set', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockImplementation(
      () => Promise.reject(new Error('Script execution is disabled on this gateway'))
    );
    render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('execution is disabled');
  });

  // Results belong to the project that produced them: left standing across a
  // switch they would be read as the new project's.
  it('drops results when the project changes', async () => {
    vi.mocked(fetchTests).mockResolvedValue(listing());
    vi.mocked(runTests).mockResolvedValue(run());
    const view = render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
    await screen.findByText('1 passed');
    view.rerender(<TestsPanel project="Q" csrfToken="t" canRun onOpenTest={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('1 passed')).toBeNull());
  });

  // ---- skip status --------------------------------------------------------

  describe('skip status', () => {
    it('shows a skip tag on a test the listing marks skipped, before any run', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing({
        modules: [{
          ...listing().modules[0],
          tests: [
            { id: 'orders.test_totals.test_sums', function: 'test_sums', line: 4,
              decorated: false, skipped: true },
            { id: 'orders.test_totals.test_rounds', function: 'test_rounds', line: 9,
              decorated: false, skipped: false },
          ],
        }],
      }));
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      await screen.findByText('test_sums');
      expect(screen.getByText('skip')).toBeTruthy();
    });

    it('renders a skipped result with the skipped word and its own glyph', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValue(run({
        passed: 0, failed: 0, errored: 0, skipped: 1,
        results: [passResult({
          status: 'skip', message: 'requires a live PLC', id: 'orders.test_totals.test_sums',
          parentId: 'orders.test_totals.test_sums',
        })],
      }));
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      expect(await screen.findByText('1 skipped')).toBeTruthy();
      expect(screen.getByText('–')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Why' }));
      expect(await screen.findByText('skipped')).toBeTruthy();
      expect(screen.getByText(/requires a live PLC/)).toBeTruthy();
    });

    it('drops the pre-run skip tag once the test has actually run', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing({
        modules: [{
          ...listing().modules[0],
          tests: [{ id: 'orders.test_totals.test_sums', function: 'test_sums', line: 4,
            decorated: false, skipped: true }],
        }],
      }));
      vi.mocked(runTests).mockResolvedValue(run({
        passed: 0, failed: 0, errored: 0, skipped: 1,
        results: [passResult({ status: 'skip' })],
      }));
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      await screen.findByText('1 skipped');
      expect(screen.queryByText('skip')).toBeNull();
    });
  });

  // ---- re-run failed --------------------------------------------------------

  describe('re-run failed', () => {
    it('is disabled before any run has happened', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      expect(await screen.findByRole('button', { name: 'Re-run 0 failed' })).toBeDisabled();
    });

    it('is disabled after an all-pass run', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValue(run({
        results: [passResult()], passed: 1, failed: 0, errored: 0,
      }));
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      await screen.findByText('1 passed');
      expect(screen.getByRole('button', { name: 'Re-run 0 failed' })).toBeDisabled();
    });

    it('is enabled with a live count once something failed or errored', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValue(run({ errored: 1 }));
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      const button = await screen.findByRole('button', { name: 'Re-run 2 failed' });
      expect(button).not.toBeDisabled();
    });

    it('sends the deduplicated parent ids of every failed or errored result, in order', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValueOnce(run({
        failed: 1, errored: 1, passed: 0,
        results: [
          failResult({
            id: 'orders.test_totals.test_rounds[0]', parentId: 'orders.test_totals.test_rounds',
            case: '(1) -> 1',
          }),
          { id: 'orders.test_totals.test_rounds[1]', module: 'orders.test_totals',
            function: 'test_rounds', status: 'error', message: 'boom', traceback: 'tb',
            output: '', outputTruncated: false, elapsedMs: 2,
            parentId: 'orders.test_totals.test_rounds', case: '(2) -> 2' },
          passResult({ id: 'orders.test_totals.test_sums', parentId: 'orders.test_totals.test_sums' }),
        ],
      }));
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      const rerun = await screen.findByRole('button', { name: 'Re-run 2 failed' });
      vi.mocked(runTests).mockResolvedValueOnce(run());
      fireEvent.click(rerun);
      await waitFor(() => expect(runTests).toHaveBeenLastCalledWith(
        'P', ['orders.test_totals.test_rounds'], 't'
      ));
    });
  });

  // ---- parameterised cases --------------------------------------------------

  describe('parameterised cases', () => {
    function paramRun(): TestRun {
      return run({
        passed: 1, failed: 1, errored: 0,
        results: [
          passResult({ id: 'orders.test_totals.test_sums[0]',
            parentId: 'orders.test_totals.test_sums', case: '(2, 3) -> 5' }),
          failResult({ id: 'orders.test_totals.test_sums[1]',
            parentId: 'orders.test_totals.test_sums', case: '(0, 0) -> 1',
            message: 'expected 1, got 0' }),
        ],
      });
    }

    it('rolls several cases up under their discovered test, with an error-first status', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValue(paramRun());
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      expect(await screen.findByText('2 cases')).toBeTruthy();
      expect(screen.getByText('(2, 3) -> 5')).toBeTruthy();
      expect(screen.getByText('(0, 0) -> 1')).toBeTruthy();
    });

    it('gives each case its own status and its own Why toggle', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValue(paramRun());
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      await screen.findByText('2 cases');
      // Only the failing case offers a reason.
      expect(screen.getAllByRole('button', { name: 'Why' })).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Why' }));
      expect(await screen.findByText(/expected 1, got 0/)).toBeTruthy();
    });

    it('renders a single ordinary result exactly as before — no case grouping', async () => {
      vi.mocked(fetchTests).mockResolvedValue(listing());
      vi.mocked(runTests).mockResolvedValue(run());
      render(<TestsPanel project="P" csrfToken="t" canRun onOpenTest={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /Run all/ }));
      await screen.findByText('1 passed');
      expect(screen.queryByText(/case/)).toBeNull();
      expect(screen.getByText('39 ms')).toBeTruthy();
    });
  });
});
