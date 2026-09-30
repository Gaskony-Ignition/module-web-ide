/**
 * The Tests panel: what this project declares, and what happens when it runs.
 *
 * A bottom-panel view rather than a side-bar one, next to the console and the
 * Problems list, because a test result is OUTPUT — you read it after asking for
 * something, and you want the editor still visible while you do.
 *
 * **Three outcomes, never two.** A `fail` is an assertion that is not true; an
 * `error` is a test that did not get far enough to have an opinion. Collapsing
 * them into "failed" sends you to read an assertion that never executed, which
 * is the wrong half of the file.
 *
 * **The discovery rule is on screen whenever the list is empty.** A convention
 * nobody can see reads as a broken feature: the first thing a person does with
 * an empty test panel is wonder whether it works.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchTests, runTests,
  type TestListing, type TestResult, type TestRun, type TestStatus,
} from '../api/tests';
import { IconPlay } from './Icons';
import './TestsPanel.css';

export interface TestsPanelProps {
  project: string;
  csrfToken: string | undefined;
  /** False for a reader who cannot execute — the run button is then absent. */
  canRun: boolean;
  /** Open the module that holds a test, at the `def`. */
  onOpenTest: (moduleName: string, line: number) => void;
}

/** The word each status gets, and the class that colours it. */
const STATUS_WORD: Record<TestStatus, string> = {
  pass: 'passed',
  fail: 'failed',
  error: 'errored',
  skip: 'skipped',
};

/** The glyph shown ahead of a result, or `·` for a test that has not run yet. */
const STATUS_MARK: Record<TestStatus, string> = {
  pass: '✓',
  fail: '✕',
  error: '!',
  skip: '–',
};

/**
 * The rolled-up status of a parameterised test's cases: error beats fail beats
 * skip, and only pass if nothing else applies — a mix of skip and pass is a
 * pass, because something in the group actually ran and asserted.
 */
function rollupStatus(results: TestResult[]): TestStatus {
  if (results.some((r) => r.status === 'error')) return 'error';
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.every((r) => r.status === 'skip')) return 'skip';
  return 'pass';
}

/**
 * The parent ids of every failed or errored result, deduplicated and in the
 * order they first appear. A parameterised case is not separately runnable —
 * a re-run always targets the discovered test, never the case.
 */
export function rerunTargets(run: TestRun | null): string[] {
  if (!run) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const result of run.results) {
    if (result.status !== 'fail' && result.status !== 'error') continue;
    if (seen.has(result.parentId)) continue;
    seen.add(result.parentId);
    ids.push(result.parentId);
  }
  return ids;
}

/** One result's reason and output, shown when its Why toggle is open. */
function ResultDetail({ result }: { result: TestResult }) {
  return (
    <div className="tests-row-detail">
      <p className="tests-row-message">
        <strong>{STATUS_WORD[result.status]}</strong>
        {result.message ? ` — ${result.message}` : ''}
      </p>
      {result.traceback && (
        <pre className="tests-row-trace">{result.traceback}</pre>
      )}
      {result.output && (
        <>
          <p className="tests-row-caption">Output</p>
          <pre className="tests-row-output">
            {result.output}
            {result.outputTruncated && '\n… truncated'}
          </pre>
        </>
      )}
    </div>
  );
}

export default function TestsPanel({
  project, csrfToken, canRun, onOpenTest,
}: TestsPanelProps) {
  const [listing, setListing] = useState<TestListing | null>(null);
  const [run, setRun] = useState<TestRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const reload = useCallback(() => {
    if (!project) return;
    fetchTests(project)
      .then(setListing)
      .catch((e: unknown) => {
        setListing(null);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [project]);

  useEffect(() => {
    // Results belong to the project that produced them. Left standing across a
    // project switch they would be read as the new project's.
    setRun(null);
    setError('');
    reload();
  }, [project, reload]);

  const start = useCallback(async (ids?: string[]) => {
    setBusy(true);
    setError('');
    try {
      setRun(await runTests(project, ids, csrfToken));
    } catch (e: unknown) {
      setRun(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [project, csrfToken]);

  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Grouped by the discovered test that produced them, not by result id: a
  // parameterised test's cases all carry the SAME parentId, and that is the
  // key a re-run and a click-to-open both need to use.
  const byParent = new Map<string, TestResult[]>();
  for (const result of run?.results ?? []) {
    const group = byParent.get(result.parentId);
    if (group) group.push(result);
    else byParent.set(result.parentId, [result]);
  }

  const rerunIds = useMemo(() => rerunTargets(run), [run]);
  const rerunCount = run ? run.failed + run.errored : 0;

  return (
    <div className="tests-panel">
      <div className="tests-panel-bar">
        <span className="tests-panel-count">
          {listing ? `${listing.total} ${listing.total === 1 ? 'test' : 'tests'}` : 'Loading…'}
        </span>
        {run && (
          <span className="tests-panel-tally" role="status">
            <span className="tests-tally-pass">{run.passed} passed</span>
            {run.failed > 0 && <span className="tests-tally-fail">{run.failed} failed</span>}
            {run.errored > 0 && <span className="tests-tally-error">{run.errored} errored</span>}
            {run.skipped > 0 && <span className="tests-tally-skip">{run.skipped} skipped</span>}
            <span className="tests-panel-elapsed">{run.elapsedMs} ms</span>
          </span>
        )}
        {canRun && (
          <button
            type="button"
            className="button tests-panel-run"
            disabled={busy || !listing || listing.total === 0}
            onClick={() => void start()}
          >
            <IconPlay size={14} />
            {busy ? 'Running…' : 'Run all'}
          </button>
        )}
        {canRun && (
          <button
            type="button"
            className="button tests-panel-rerun"
            disabled={busy || rerunIds.length === 0}
            onClick={() => void start(rerunIds)}
          >
            <IconPlay size={14} />
            {`Re-run ${rerunCount} failed`}
          </button>
        )}
      </div>

      {error && <p className="tests-panel-error" role="alert">{error}</p>}

      {listing && listing.total === 0 && (
        <p className="tests-panel-empty">
          No tests in this project. {listing.convention}
        </p>
      )}

      {listing && listing.total > 0 && (
        <div className="tests-panel-body">
          {listing.modules.map((module) => (
            <section key={module.module} className="tests-module">
              <header className="tests-module-head">
                <span className="tests-module-name">{module.module}</span>
                {module.hasBeforeAll && <span className="tests-module-tag">beforeAll</span>}
                {module.hasSetUp && <span className="tests-module-tag">setUp</span>}
                {module.hasBeforeEach && <span className="tests-module-tag">beforeEach</span>}
                {module.hasAfterEach && <span className="tests-module-tag">afterEach</span>}
                {module.hasTearDown && <span className="tests-module-tag">tearDown</span>}
                {module.hasAfterAll && <span className="tests-module-tag">afterAll</span>}
                {canRun && (
                  <button
                    type="button"
                    className="tests-module-run"
                    disabled={busy}
                    onClick={() => void start(module.tests.map((t) => t.id))}
                  >
                    Run
                  </button>
                )}
              </header>
              <ul className="tests-module-list">
                {module.tests.map((test) => {
                  const group = byParent.get(test.id);
                  // An ordinary test: no result yet, or exactly one result that
                  // IS the discovered test rather than one of its cases. No
                  // visual change from before parameterised cases existed.
                  const ordinary = !group || (group.length === 1 && group[0].id === test.id);
                  const result = ordinary ? group?.[0] : undefined;
                  const open = expanded.has(test.id);
                  const testName = test.class ? `${test.class}.${test.function}` : test.function;
                  return (
                    <li key={test.id}>
                      <div className={`tests-row${result ? ` is-${result.status}` : group ? ` is-${rollupStatus(group)}` : ''}`}>
                        {/* A glyph as well as a colour, and the word in the
                            detail below: colour alone fails on a projector. */}
                        <span className="tests-row-mark" aria-hidden="true">
                          {result
                            ? STATUS_MARK[result.status]
                            : group
                              ? STATUS_MARK[rollupStatus(group)]
                              : '·'}
                        </span>
                        <button
                          type="button"
                          className="tests-row-name"
                          onClick={() => onOpenTest(module.module, test.line)}
                          title={test.id}
                        >
                          {testName}
                        </button>
                        {/* Visible only before a run: once a result exists, the
                            row's own status glyph and word already say why it
                            did not execute. */}
                        {test.skipped && !result && !group && (
                          <span className="tests-row-tag">skip</span>
                        )}
                        {result && (
                          <span className="tests-row-elapsed">{result.elapsedMs} ms</span>
                        )}
                        {result && result.status !== 'pass' && (
                          <button
                            type="button"
                            className="tests-row-toggle"
                            aria-expanded={open}
                            onClick={() => toggle(test.id)}
                          >
                            {open ? 'Hide' : 'Why'}
                          </button>
                        )}
                        {!result && group && (
                          <span className="tests-row-cases">
                            {group.length} {group.length === 1 ? 'case' : 'cases'}
                          </span>
                        )}
                        {canRun && (
                          <button
                            type="button"
                            className="tests-row-run"
                            disabled={busy}
                            onClick={() => void start([test.id])}
                            aria-label={`Run ${test.id}`}
                          >
                            <IconPlay size={12} />
                          </button>
                        )}
                      </div>
                      {result && open && <ResultDetail result={result} />}
                      {!result && group && (
                        <ul className="tests-case-list">
                          {group.map((caseResult) => {
                            const caseOpen = expanded.has(caseResult.id);
                            return (
                              <li key={caseResult.id}>
                                <div className={`tests-case-row is-${caseResult.status}`}>
                                  <span className="tests-row-mark" aria-hidden="true">
                                    {STATUS_MARK[caseResult.status]}
                                  </span>
                                  <span className="tests-case-label">
                                    {caseResult.case ?? caseResult.id}
                                  </span>
                                  <span className="tests-row-elapsed">{caseResult.elapsedMs} ms</span>
                                  {caseResult.status !== 'pass' && (
                                    <button
                                      type="button"
                                      className="tests-row-toggle"
                                      aria-expanded={caseOpen}
                                      onClick={() => toggle(caseResult.id)}
                                    >
                                      {caseOpen ? 'Hide' : 'Why'}
                                    </button>
                                  )}
                                </div>
                                {caseOpen && <ResultDetail result={caseResult} />}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {listing && listing.total > 0 && (
        // Said once, at the bottom, rather than in a tooltip nobody opens. It is
        // the one thing about this runner that will surprise someone who knows
        // pytest, and finding it out from a flaky test is worse than reading it.
        <p className="tests-panel-note">
          Each run executes every module into a namespace private to that run, so
          module-level state does not carry between runs. The tests within one run
          still share that namespace and still share one interpreter with each
          other. {listing.convention}
        </p>
      )}
    </div>
  );
}
