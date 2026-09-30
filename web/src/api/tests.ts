/**
 * Discovering and running a project's Jython tests.
 *
 * Two calls, and they are different in kind: the listing is a read anyone
 * authenticated can make, and the run is arbitrary project code behind the same
 * gate and the same execution service as the console. The client mirrors that —
 * `runTests` sends the CSRF token, `fetchTests` does not need to.
 */
import { apiUrl } from './urls';
import { CSRF_HEADER, toApiError } from './scripts';

export interface TestCase {
  /** `module.function`, or `module.Class.function`. The runner's own name for it. */
  id: string;
  function: string;
  class?: string;
  /** 0-based line of the `def`, for click-to-open. */
  line: number;
  /** Found by `@test` rather than by the `test_*` naming convention. */
  decorated: boolean;
  /** Carries `@skip` — discovered, but the runner will not execute it. */
  skipped: boolean;
}

export interface TestModule {
  module: string;
  hasSetUp: boolean;
  hasTearDown: boolean;
  hasBeforeAll: boolean;
  hasAfterAll: boolean;
  hasBeforeEach: boolean;
  hasAfterEach: boolean;
  tests: TestCase[];
}

export interface TestListing {
  project: string;
  total: number;
  modules: TestModule[];
  /** The discovery rule, in words, so an empty panel can show it. */
  convention: string;
  /** A one-line example of the import a test module writes, for the empty state. */
  helperImport: string;
}

export type TestStatus = 'pass' | 'fail' | 'error' | 'skip';

export interface TestResult {
  id: string;
  module: string;
  function: string;
  status: TestStatus;
  message: string;
  traceback: string;
  output: string;
  outputTruncated: boolean;
  elapsedMs: number;
  /**
   * The discovered test this row came from. Equal to `id` for an ordinary
   * test; differs for a parameterised case, which is not separately runnable
   * — a re-run always targets the parent id.
   */
  parentId: string;
  /** The case label, e.g. `"(2, 3) -> 5"`, or null for an ordinary test. */
  case: string | null;
}

export interface TestRun {
  results: TestResult[];
  requested: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  elapsedMs: number;
}

/** GET /api/tests?project=X */
export async function fetchTests(project: string): Promise<TestListing> {
  const query = new URLSearchParams({ project });
  const response = await fetch(`${apiUrl('/api/tests')}?${query.toString()}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as TestListing;
  return { ...body, modules: body.modules ?? [] };
}

/**
 * POST /api/tests/run?project=X
 *
 * `ids` omitted or empty runs every discovered test. The ids are a SELECTION:
 * the server looks each one up in its own discovery rather than trusting the
 * client to say what a test is, so an unknown id is a 400 and not a call to an
 * arbitrary function.
 */
export async function runTests(
  project: string,
  ids: string[] | undefined,
  csrfToken: string | undefined
): Promise<TestRun> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (csrfToken) {
    headers[CSRF_HEADER] = csrfToken;
  }
  const query = new URLSearchParams({ project });
  const response = await fetch(`${apiUrl('/api/tests/run')}?${query.toString()}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({ ids: ids ?? [] }),
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body = (await response.json()) as TestRun;
  return { ...body, results: body.results ?? [] };
}
