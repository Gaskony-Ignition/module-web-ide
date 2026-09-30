/**
 * The named-query editor: the Designer's three tabs, above the buffer.
 *
 * Replaces `ConfigStrip` for a query document, and is laid out the same way —
 * a chrome band between the tab strip and the code — because the SQL buffer is
 * the shared `CodeEditor`, mounted once for every open document. Rendering the
 * editor inside the Authoring tab would unmount every other view on a tab
 * click, and with them every undo history and scroll position. So the buffer
 * stays where it is and the two non-authoring tabs simply hide it; that is what
 * `showsBuffer` reports to the workspace.
 *
 * Tabs, and what each one is for, are measured off the 8.3.8 Designer
 * (NAMED-QUERIES.md §3):
 *
 * - **Settings** — the resource attributes, the full §1.1 vocabulary.
 * - **Authoring** — the parameter table, above the SQL.
 * - **Testing** — one input per parameter, a Run button, and the result.
 *
 * Every control is `--control-height` tall. Set the height, not the padding: a
 * select and a button with the same padding come out different heights, which
 * is the 1.4.2 finding this file must not undo.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CACHE_UNITS,
  CACHE_UNIT_LABELS,
  PARAMETER_TYPES,
  PARAMETER_TYPE_LABELS,
  QUERY_TYPES,
  QUERY_TYPE_LABELS,
  SQL_TYPES,
  isRowsResult,
  isUpdateResult,
  testRunNamedQuery,
  validateParameterIdentifier,
  type NamedQueryParameter,
  type NamedQuerySettings,
  type SqlType,
  type TestRunResult,
  type TestRunValue,
} from '../api/namedQueries';
import { Traceback } from './ScriptConsole';
import './NamedQueryEditor.css';

/** Which tab is showing. `authoring` is the one the SQL buffer belongs to. */
export type QueryTab = 'settings' | 'authoring' | 'testing';

export interface NamedQueryEditorProps {
  project: string;
  /** The query's path inside the project — `Folder/Sub/Name`, what a run names. */
  path: string;
  /**
   * The SQL buffer as it is on screen.
   *
   * Held by the workspace, not by this component: the buffer is the shared
   * CodeEditor. It is passed in because a test run sends the DRAFT, so the
   * Testing tab runs what the user is looking at.
   */
  sql: string;
  settings: NamedQuerySettings;
  /**
   * A version-1 resource, which the gateway cannot run (NAMED-QUERIES.md §1.5).
   * The editor says so; saving is the repair.
   */
  legacy?: boolean;
  /** The gateway's database connections. */
  databases: string[];
  /** Settings keys the server will accept. Empty means all of them. */
  editable: string[];
  tab: QueryTab;
  onTabChange: (tab: QueryTab) => void;
  onChange: (settings: NamedQuerySettings) => void;
  onSave: () => void;
  dirty: boolean;
  /** Session/project read-only, OR this document locked by inheritance. */
  readOnly: boolean;
  saving?: boolean;
  csrfToken?: string;
  /** Rendered first, on the tab row — the inheritance notice. */
  leading?: ReactNode;
  /**
   * Injected for tests, which must not reach a gateway. Defaults to the real
   * client, so nothing in the app passes it.
   */
  onTestRun?: (parameters: Record<string, TestRunValue>) => Promise<TestRunResult>;
}

const TABS: Array<{ id: QueryTab; label: string }> = [
  { id: 'settings', label: 'Settings' },
  { id: 'authoring', label: 'Authoring' },
  { id: 'testing', label: 'Testing' },
];

/** The "no connection chosen" option. Empty string is what the platform stores. */
const PROJECT_DEFAULT = '(project default)';

export default function NamedQueryEditor({
  project,
  path,
  sql,
  settings,
  legacy = false,
  databases,
  editable,
  tab,
  onTabChange,
  onChange,
  onSave,
  dirty,
  readOnly,
  saving = false,
  csrfToken,
  leading,
  onTestRun,
}: NamedQueryEditorProps) {
  /**
   * An empty `editable` means "all of them", matching the script attributes
   * route's convention. A NON-empty one is an allowlist: a control not on it is
   * shown disabled rather than hidden, because the server said the setting
   * exists and hiding it would make a real capability invisible behind a stale
   * frontend.
   */
  const canEdit = useCallback(
    (key: keyof NamedQuerySettings) =>
      !readOnly && (editable.length === 0 || editable.includes(key)),
    [editable, readOnly]
  );

  const set = useCallback(
    <K extends keyof NamedQuerySettings>(key: K, value: NamedQuerySettings[K]) => {
      onChange({ ...settings, [key]: value });
    },
    [onChange, settings]
  );

  return (
    /* `is-full` when the buffer is hidden: the Settings and Testing tabs have
       the whole editor area to themselves then, and a panel that kept its
       browsing height would leave the bottom half of the window empty. */
    <div className={`nq-editor${showsBuffer(tab) ? '' : ' is-full'}`} aria-label="Named query">
      <div className="nq-tabs">
        {leading}
        <div className="nq-tablist" role="tablist" aria-label="Named query editor">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`nq-tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`nq-panel-${entry.id}`}
              className={`nq-tab${tab === entry.id ? ' is-active' : ''}`}
              onClick={() => onTabChange(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button nq-save"
          onClick={onSave}
          // One button for both halves: the contract saves SQL and settings
          // against the same signature, so there is one write to make and one
          // thing to call it.
          disabled={readOnly || saving || !dirty}
        >
          {saving ? 'Saving…' : 'Save query'}
        </button>
      </div>

      {legacy && (
        /* One line, in the settings strip's own position. A legacy query is not
           a style problem: `fromResource` returns a blank query for a version-1
           resource and `runNamedQuery` raises a NullPointerException, so the
           form above shows the platform's defaults rather than this query's
           values. Saving rewrites it through `toResource`, which stamps version
           2 — the ordinary save path IS the repair, so there is nothing else to
           offer here. */
        <p className="nq-legacy" role="status">
          This query is in the legacy format and will not run. Saving it converts it.
        </p>
      )}

      {tab === 'settings' && (
        <div className="nq-panel" role="tabpanel" id="nq-panel-settings" aria-labelledby="nq-tab-settings">
          <div className="nq-grid">
            <label className="nq-field">
              <span className="config-label">Type</span>
              <select
                value={settings.type}
                disabled={!canEdit('type')}
                onChange={(e) => set('type', e.target.value as NamedQuerySettings['type'])}
              >
                {QUERY_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {QUERY_TYPE_LABELS[option]}
                  </option>
                ))}
              </select>
            </label>

            <label className="nq-field nq-field-wide">
              <span className="config-label">Description</span>
              <input
                type="text"
                value={settings.description}
                disabled={!canEdit('description')}
                onChange={(e) => set('description', e.target.value)}
              />
            </label>

            <label className="nq-field">
              <span className="config-label">Database</span>
              {/* An empty value is the PROJECT DEFAULT, which is a real setting
                  and not "unset" — so it is an option in the list rather than a
                  placeholder. A connection the gateway no longer has is kept in
                  the list too, or opening the query would silently retarget it. */}
              <select
                value={settings.database}
                disabled={!canEdit('database')}
                onChange={(e) => set('database', e.target.value)}
              >
                <option value="">{PROJECT_DEFAULT}</option>
                {databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {settings.database && !databases.includes(settings.database) && (
                  <option value={settings.database}>{settings.database} (not on this gateway)</option>
                )}
              </select>
            </label>

            <label className="nq-check">
              <input
                type="checkbox"
                checked={settings.enabled}
                disabled={!canEdit('enabled')}
                onChange={(e) => set('enabled', e.target.checked)}
              />
              Enabled
            </label>

            <label className="nq-check">
              <input
                type="checkbox"
                checked={settings.autoBatchEnabled}
                disabled={!canEdit('autoBatchEnabled')}
                onChange={(e) => set('autoBatchEnabled', e.target.checked)}
              />
              Auto-batch
            </label>
          </div>

          <fieldset className="nq-fieldset">
            <legend>Caching</legend>
            <label className="nq-check">
              <input
                type="checkbox"
                checked={settings.cacheEnabled}
                disabled={!canEdit('cacheEnabled')}
                onChange={(e) => set('cacheEnabled', e.target.checked)}
              />
              Cache results
            </label>
            <label className="nq-field">
              <span className="config-label">Amount</span>
              <input
                type="number"
                min={0}
                value={settings.cacheAmount}
                // Disabled with caching off, not hidden: an amount that vanishes
                // when the tick comes off looks like the value was discarded.
                disabled={!canEdit('cacheAmount') || !settings.cacheEnabled}
                onChange={(e) => set('cacheAmount', Number(e.target.value))}
              />
            </label>
            <label className="nq-field">
              <span className="config-label">Unit</span>
              <select
                value={settings.cacheUnit}
                disabled={!canEdit('cacheUnit') || !settings.cacheEnabled}
                onChange={(e) => set('cacheUnit', e.target.value as NamedQuerySettings['cacheUnit'])}
              >
                {CACHE_UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {CACHE_UNIT_LABELS[unit]}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <fieldset className="nq-fieldset">
            <legend>Fallback</legend>
            <label className="nq-check">
              <input
                type="checkbox"
                checked={settings.fallbackEnabled}
                disabled={!canEdit('fallbackEnabled')}
                onChange={(e) => set('fallbackEnabled', e.target.checked)}
              />
              Use a fallback value
            </label>
            <label className="nq-field nq-field-wide">
              <span className="config-label">Value</span>
              <input
                type="text"
                value={settings.fallbackValue}
                disabled={!canEdit('fallbackValue') || !settings.fallbackEnabled}
                onChange={(e) => set('fallbackValue', e.target.value)}
              />
            </label>
          </fieldset>

          <fieldset className="nq-fieldset">
            <legend>Max return size</legend>
            <label className="nq-check">
              <input
                type="checkbox"
                checked={settings.useMaxReturnSize}
                disabled={!canEdit('useMaxReturnSize')}
                onChange={(e) => set('useMaxReturnSize', e.target.checked)}
              />
              Limit the number of rows returned
            </label>
            <label className="nq-field">
              <span className="config-label">Rows</span>
              <input
                type="number"
                min={0}
                value={settings.maxReturnSize}
                disabled={!canEdit('maxReturnSize') || !settings.useMaxReturnSize}
                onChange={(e) => set('maxReturnSize', Number(e.target.value))}
              />
            </label>
          </fieldset>

          <SecurityRows
            rows={settings.permissions}
            readOnly={!canEdit('permissions')}
            onChange={(permissions) => set('permissions', permissions)}
          />
        </div>
      )}

      {tab === 'authoring' && (
        <div className="nq-panel" role="tabpanel" id="nq-panel-authoring" aria-labelledby="nq-tab-authoring">
          <ParameterTable
            parameters={settings.parameters}
            readOnly={!canEdit('parameters')}
            onChange={(parameters) => set('parameters', parameters)}
          />
        </div>
      )}

      {tab === 'testing' && (
        <div className="nq-panel" role="tabpanel" id="nq-panel-testing" aria-labelledby="nq-tab-testing">
          <TestingPanel
            project={project}
            path={path}
            sql={sql}
            settings={settings}
            csrfToken={csrfToken}
            onTestRun={onTestRun}
          />
        </div>
      )}
    </div>
  );
}

/** True when this tab shows the SQL buffer — the workspace hides it otherwise. */
export function showsBuffer(tab: QueryTab): boolean {
  return tab === 'authoring';
}

// ==================== Authoring ====================

function ParameterTable({
  parameters,
  readOnly,
  onChange,
}: {
  parameters: NamedQueryParameter[];
  readOnly: boolean;
  onChange: (next: NamedQueryParameter[]) => void;
}) {
  function update(index: number, patch: Partial<NamedQueryParameter>) {
    onChange(parameters.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  function move(index: number, by: number) {
    const target = index + by;
    if (target < 0 || target >= parameters.length) return;
    const next = [...parameters];
    // Order is visible in the Designer's own table and in the dict a caller
    // builds from it, so reordering is a real edit rather than a display
    // preference.
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  return (
    <div className="nq-params">
      <div className="nq-params-head">
        <h3>Parameters</h3>
        {!readOnly && (
          <button
            type="button"
            className="button"
            onClick={() =>
              // `Parameter` is the enum's NAME; "Value" is only what the
              // Designer labels it. The wire takes the name.
              onChange([...parameters, { type: 'Parameter', identifier: '', sqlType: 'String' }])
            }
          >
            Add parameter
          </button>
        )}
      </div>
      {parameters.length === 0 ? (
        <p className="muted nq-empty">
          No parameters. A query with none is run with an empty dictionary.
        </p>
      ) : (
        // No pager, ever: the list scrolls. A parameter table is short and a
        // pager over four rows is chrome for a gesture nobody would make.
        <div className="nq-scroll">
          <table className="nq-table">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Identifier</th>
                <th scope="col">SQL type</th>
                <th scope="col">
                  <span className="nq-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {parameters.map((row, index) => {
                const others = parameters
                  .filter((_, i) => i !== index)
                  .map((other) => other.identifier);
                const problem = validateParameterIdentifier(row.identifier, others);
                return (
                  <tr key={index}>
                    <td>
                      <select
                        aria-label={`Parameter ${index + 1} type`}
                        value={row.type}
                        disabled={readOnly}
                        onChange={(e) =>
                          update(index, { type: e.target.value as NamedQueryParameter['type'] })
                        }
                      >
                        {PARAMETER_TYPES.map((option) => (
                          <option key={option} value={option}>
                            {PARAMETER_TYPE_LABELS[option]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        aria-label={`Parameter ${index + 1} identifier`}
                        aria-invalid={problem ? 'true' : undefined}
                        value={row.identifier}
                        spellCheck={false}
                        disabled={readOnly}
                        onChange={(e) => update(index, { identifier: e.target.value })}
                      />
                      {problem && (
                        <span className="nq-problem" role="alert">
                          {problem}
                        </span>
                      )}
                    </td>
                    <td>
                      <select
                        aria-label={`Parameter ${index + 1} SQL type`}
                        value={row.sqlType}
                        disabled={readOnly}
                        onChange={(e) => update(index, { sqlType: e.target.value as SqlType })}
                      >
                        {SQL_TYPES.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="nq-row-actions">
                      {!readOnly && (
                        <>
                          <button
                            type="button"
                            aria-label={`Move parameter ${index + 1} up`}
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move parameter ${index + 1} down`}
                            disabled={index === parameters.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove parameter ${index + 1}`}
                            onClick={() => onChange(parameters.filter((_, i) => i !== index))}
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ==================== Settings: security rows ====================

function SecurityRows({
  rows,
  readOnly,
  onChange,
}: {
  rows: Array<{ zone: string; role: string }>;
  readOnly: boolean;
  onChange: (next: Array<{ zone: string; role: string }>) => void;
}) {
  return (
    <fieldset className="nq-fieldset">
      <legend>Security</legend>
      {rows.length === 0 && <p className="muted nq-empty">No zone or role restrictions.</p>}
      {rows.map((row, index) => (
        <div className="nq-security-row" key={index}>
          <label className="nq-field">
            <span className="config-label">Zone</span>
            <input
              type="text"
              aria-label={`Security row ${index + 1} zone`}
              value={row.zone}
              disabled={readOnly}
              onChange={(e) =>
                onChange(rows.map((r, i) => (i === index ? { ...r, zone: e.target.value } : r)))
              }
            />
          </label>
          <label className="nq-field">
            <span className="config-label">Role</span>
            <input
              type="text"
              aria-label={`Security row ${index + 1} role`}
              value={row.role}
              disabled={readOnly}
              onChange={(e) =>
                onChange(rows.map((r, i) => (i === index ? { ...r, role: e.target.value } : r)))
              }
            />
          </label>
          {!readOnly && (
            <button
              type="button"
              className="button"
              aria-label={`Remove security row ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="button"
          // An empty pair is what the Designer writes, so a new row starts as
          // one rather than as a validation error.
          onClick={() => onChange([...rows, { zone: '', role: '' }])}
        >
          Add security row
        </button>
      )}
    </fieldset>
  );
}

// ==================== Testing ====================

/**
 * The input for a parameter, typed by its `sqlType`.
 *
 * Everything is carried as a string except a boolean, because the SERVER coerces
 * — it knows the column type and the driver, and a number parsed here would lose
 * a 64-bit `Int8` to a JavaScript double before it ever reached the query.
 */
function inputTypeFor(sqlType: SqlType): 'number' | 'checkbox' | 'datetime-local' | 'text' {
  if (sqlType.startsWith('Int') || sqlType.startsWith('Float')) return 'number';
  if (sqlType === 'Boolean') return 'checkbox';
  if (sqlType === 'DateTime') return 'datetime-local';
  return 'text';
}

function TestingPanel({
  project,
  path,
  sql,
  settings,
  csrfToken,
  onTestRun,
}: {
  project: string;
  path: string;
  sql: string;
  settings: NamedQuerySettings;
  csrfToken?: string;
  onTestRun?: (values: Record<string, TestRunValue>) => Promise<TestRunResult>;
}) {
  const parameters = settings.parameters;
  const [values, setValues] = useState<Record<string, TestRunValue>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestRunResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    try {
      const answer = onTestRun
        ? await onTestRun(values)
        // The DRAFT: the SQL and the settings as they are on screen, so the tab
        // tests what you are looking at. The path still identifies the
        // resource, which is what resolves inheritance, permissions and the
        // audit line.
        : await testRunNamedQuery({
          project, path, parameters: values, sql, settings, csrfToken,
        });
      setResult(answer);
    } catch (e: unknown) {
      // A THROW here is a transport or permission failure, not a SQL error —
      // the server answers a failed query with 200 and `{ok:false, error}`.
      // Saying so keeps "the database refused this" apart from "the gateway
      // refused you".
      setResult(null);
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [csrfToken, onTestRun, path, project, settings, sql, values]);

  return (
    <div className="nq-testing">
      <div className="nq-test-controls">
        {parameters.length === 0 ? (
          <p className="muted nq-empty">This query takes no parameters.</p>
        ) : (
          parameters.map((parameter) => {
            const kind = inputTypeFor(parameter.sqlType);
            const value = values[parameter.identifier];
            return (
              <label className="nq-field" key={parameter.identifier || parameter.sqlType}>
                <span className="config-label">
                  {parameter.identifier || '(unnamed)'} <em>{parameter.sqlType}</em>
                </span>
                {kind === 'checkbox' ? (
                  <input
                    type="checkbox"
                    aria-label={parameter.identifier}
                    checked={value === true}
                    onChange={(e) =>
                      setValues((current) => ({
                        ...current,
                        [parameter.identifier]: e.target.checked,
                      }))
                    }
                  />
                ) : (
                  <input
                    type={kind}
                    aria-label={parameter.identifier}
                    value={value === undefined || value === null ? '' : String(value)}
                    onChange={(e) =>
                      setValues((current) => ({
                        ...current,
                        [parameter.identifier]: e.target.value,
                      }))
                    }
                  />
                )}
              </label>
            );
          })
        )}
        <button
          type="button"
          className="button nq-run"
          onClick={() => void run()}
          // Disabled WHILE running, not just visually busy: a second run would
          // race the first and the results panel has one place to put an answer.
          disabled={running}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <p className="nq-note muted" role="status">
        Runs the draft: the SQL and settings as they are on screen, not the last saved version.
      </p>

      {failure && (
        <p className="nq-note is-error" role="alert">
          {failure}
        </p>
      )}

      {result && <TestResult result={result} />}
    </div>
  );
}

function TestResult({ result }: { result: TestRunResult }) {
  const elapsed = useMemo(() => {
    const ms = 'elapsedMs' in result ? result.elapsedMs : undefined;
    return ms === undefined ? null : `${ms} ms`;
  }, [result]);

  if (!result.ok) {
    // The console's own traceback block, verbatim — same payload, same
    // rendering. Frames from a test run point at the generated
    // `system.db.runNamedQuery` call, so there is nothing here to open.
    return (
      <div className="nq-result console-block console-error">
        <pre>{`${result.error.type}: ${result.error.message}`}</pre>
        <Traceback error={result.error} onOpenFrame={() => {}} />
      </div>
    );
  }

  if (isRowsResult(result)) {
    return (
      <div className="nq-result">
        <p className="nq-note muted" role="status">
          {result.rowCount} {result.rowCount === 1 ? 'row' : 'rows'}
          {elapsed ? ` · ${elapsed}` : ''}
          {result.truncatedAt !== undefined
            ? ` · capped at ${result.truncatedAt} — the rest was not returned`
            : ''}
        </p>
        {/* Scrolls, never pages. A pager over a result grid hides how much came
            back and makes the reader click to find out. */}
        <div className="nq-scroll">
          <table className="nq-table">
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th scope="col" key={column.name}>
                    {column.name}
                    <span className="nq-col-type muted">{column.type}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{renderCell(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (isUpdateResult(result)) {
    return (
      <p className="nq-result nq-value" role="status">
        {result.affected} {result.affected === 1 ? 'row' : 'rows'} affected
        {elapsed ? ` · ${elapsed}` : ''}
      </p>
    );
  }

  return (
    <p className="nq-result nq-value" role="status">
      {renderCell(result.value)}
      {elapsed ? ` · ${elapsed}` : ''}
    </p>
  );
}

/** A cell. `null` is a SQL value and says so — an empty cell would read as "". */
function renderCell(value: TestRunValue): string {
  if (value === null) return 'NULL';
  return String(value);
}
