/**
 * The Properties tab of the tag editor: the Designer's Tag Editor as a form.
 *
 * The buffer (`doc.text`) is the tag's LOCAL configuration — only the
 * properties it overrides. A property present there is shown normally with a
 * Reset button that deletes the key; a property absent there shows what the
 * tag would get without it (the UDT definition's value, else the model's
 * default), dimmed, and editing it adds the key. That is the whole override
 * model: it is what makes a UDT member override and reset behave as they do
 * in the Designer, and it means the form never writes a value the user did
 * not touch.
 *
 * Which properties exist is the gateway's call (`/api/tags/model`), re-asked
 * when a property that changes applicability changes. Every edit rebuilds the
 * local object and hands the JSON back through `onChange`, keeping existing
 * keys where they were so the JSON tab and a diff stay calm.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { fetchTagModel, parseTagInput, type TagPropertyDescriptor } from '../api/tags';
import type { OpenDoc } from '../workspace/documents';
import { byteFidelity, editorTheme, pythonKeymap, pythonSurface } from './editorCore';
import './TagPropertyForm.css';

type Json = Record<string, unknown>;

export interface TagPropertyFormProps {
  doc: OpenDoc;
  onChange: (text: string) => void;
  readOnly: boolean;
  csrfToken: string | undefined;
}

// ==================== labels, sections, order ====================

/**
 * Designer wording. The gateway's own display names are mostly unresolved
 * i18n keys, so these are the default; a non-null model label wins. The order
 * here is also the order inside each section.
 */
export const PROPERTY_LABELS: Record<string, string> = {
  name: 'Name',
  enabled: 'Enabled',
  tagGroup: 'Tag Group',
  typeId: 'UDT Type',
  valueSource: 'Value Source',
  opcServer: 'OPC Server',
  opcItemPath: 'OPC Item Path',
  sourceTagPath: 'Source Tag Path',
  expression: 'Expression',
  executionMode: 'Execution Mode',
  executionRate: 'Execution Rate',
  datasource: 'Data Source',
  queryType: 'Query Type',
  query: 'Query',
  deriveExpressionGetter: 'Read Expression',
  deriveExpressionSetter: 'Write Expression',
  preserveSourceTimestamp: 'Preserve Source Timestamp',
  dataType: 'Data Type',
  value: 'Value',
  defaultValue: 'Default Value',
  valuePersistence: 'Value Persistence',
  includeMetadata: 'Include Metadata',
  scaleMode: 'Scale Mode',
  rawLow: 'Raw Low',
  rawHigh: 'Raw High',
  scaledLow: 'Scaled Low',
  scaledHigh: 'Scaled High',
  scaleFactor: 'Scale Factor',
  clampMode: 'Clamp Mode',
  engUnit: 'Engineering Units',
  engLow: 'Engineering Low Limit',
  engHigh: 'Engineering High Limit',
  engLimitMode: 'Engineering Limit Mode',
  deadbandMode: 'Deadband Mode',
  deadband: 'Deadband',
  formatString: 'Format String',
  tooltip: 'Tooltip',
  documentation: 'Documentation',
  typeColor: 'Type Colour',
  readOnly: 'Read Only',
  readPermissions: 'Read Permissions',
  writePermissions: 'Write Permissions',
  eventScripts: 'Event Scripts',
  alarmEvalEnabled: 'Alarm Evaluation Enabled',
  alarms: 'Alarms',
  historyEnabled: 'History Enabled',
  historyProvider: 'Storage Provider',
  sampleMode: 'Sample Mode',
  historySampleRate: 'Sample Rate',
  historySampleRateUnits: 'Sample Rate Units',
  historyTagGroup: 'Historical Tag Group',
  historicalDeadbandStyle: 'Deadband Style',
  historicalDeadbandMode: 'Historical Deadband Mode',
  historicalDeadband: 'Historical Deadband',
  historyTimeDeadband: 'Min Time Between Samples',
  historyTimeDeadbandUnits: 'Min Time Units',
  historyMaxAge: 'Max Time Between Samples',
  historyMaxAgeUnits: 'Max Time Units',
  parameters: 'Parameters',
  tagType: 'Tag Type',
};

const ORDER = Object.keys(PROPERTY_LABELS);

/** Sections, in the Designer's order. */
const SECTIONS = [
  ['core', 'Basic'],
  ['value', 'Value'],
  ['numeric', 'Numeric'],
  ['meta', 'Metadata'],
  ['security', 'Security'],
  ['scripting', 'Scripting'],
  ['alarms', 'Alarms'],
  ['history', 'History'],
  ['parameters', 'Parameters'],
  ['other', 'Other'],
] as const;
type SectionId = typeof SECTIONS[number][0];
const SECTION_IDS = new Set<string>(SECTIONS.map(([id]) => id));

/** Where a property goes when the model's category is missing or unknown. */
const FALLBACK_SECTION: Record<string, SectionId> = {
  name: 'core', enabled: 'core', tagGroup: 'core', typeId: 'core',
  eventScripts: 'scripting', alarms: 'alarms', alarmEvalEnabled: 'alarms', parameters: 'parameters',
  readOnly: 'security', readPermissions: 'security', writePermissions: 'security',
  tooltip: 'meta', documentation: 'meta', typeColor: 'meta',
};

/** Never shown: platform bookkeeping, the header's tag type, and children. */
const HIDDEN = new Set(['alm_extp_res', 'resAlarmPipeline', 'tagType', 'tags', 'path']);

const MULTILINE = new Set(['expression', 'query', 'documentation', 'deriveExpressionGetter', 'deriveExpressionSetter']);

/** Properties whose change can add or drop others, so the model is re-asked. */
const MODEL_TRIGGERS = ['valueSource', 'dataType', 'historyEnabled', 'scaleMode', 'tagType', 'sampleMode', 'deadbandMode'];

const NUMBER_TYPES = new Set(['Double', 'Float', 'Integer', 'Long', 'Short', 'Number']);
const INTEGER_TYPES = new Set(['Integer', 'Long', 'Short']);

export function propertyLabel(name: string, model?: string | null): string {
  return model ?? PROPERTY_LABELS[name] ?? name;
}

function sectionOf(p: TagPropertyDescriptor): SectionId {
  if (p.category !== 'other' && SECTION_IDS.has(p.category)) return p.category as SectionId;
  return FALLBACK_SECTION[p.name] ?? 'other';
}

function orderOf(name: string): number {
  const at = ORDER.indexOf(name);
  return at < 0 ? ORDER.length : at;
}

// ==================== local-object helpers ====================

function parseObject(text: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Json : null;
  } catch {
    return null;
  }
}

function has(obj: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** A copy with `key` set; an existing key keeps its place, a new one goes last. */
export function withKey(obj: Json, key: string, value: unknown): Json {
  const next = { ...obj };
  next[key] = value;
  return next;
}

export function withoutKey(obj: Json, key: string): Json {
  const next = { ...obj };
  delete next[key];
  return next;
}

/** A type guess for a key the model did not describe, so it can still be edited. */
function guessed(name: string, value: unknown): TagPropertyDescriptor {
  const type = typeof value === 'boolean' ? 'Boolean'
    : typeof value === 'number' ? 'Double'
      : typeof value === 'string' ? 'String'
        : 'Object';
  return { name, type, default: null, allowedValues: null, category: FALLBACK_SECTION[name] ?? 'other', label: null };
}

// ==================== the form ====================

export default function TagPropertyForm({ doc, onChange, readOnly, csrfToken }: TagPropertyFormProps) {
  const local = useMemo(() => parseObject(doc.text), [doc.text]);
  const inherited = doc.tag?.inherited ?? {};
  const resolved = useMemo(() => parseObject(doc.tag?.resolved ?? '') ?? {}, [doc.tag?.resolved]);
  const idBase = useId();

  // The model is asked about the configuration as it stands — inherited
  // values under the local ones — so a member whose valueSource comes from
  // its definition still gets that source's properties.
  const effective = useMemo<Json>(() => {
    const merged: Json = { ...resolved, ...inherited, ...(local ?? {}) };
    delete merged.tags;
    return merged;
  }, [resolved, inherited, local]);
  const triggerKey = JSON.stringify(MODEL_TRIGGERS.map((k) => effective[k] ?? null));
  const effectiveRef = useRef(effective);
  effectiveRef.current = effective;

  const [model, setModel] = useState<TagPropertyDescriptor[] | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const askedOnce = useRef(false);
  const parses = local !== null;

  useEffect(() => {
    if (!parses) return undefined;
    let live = true;
    // First ask at once; after that, wait for a pause so a run of selects in a
    // row costs one round trip.
    const timer = setTimeout(() => {
      fetchTagModel(doc.path, JSON.stringify(effectiveRef.current), csrfToken)
        .then((props) => {
          if (!live) return;
          setModel(props);
          setModelError(null);
        })
        .catch((e: unknown) => {
          if (live) setModelError(e instanceof Error ? e.message : String(e));
        });
    }, askedOnce.current ? 300 : 0);
    askedOnce.current = true;
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [doc.path, triggerKey, csrfToken, parses]);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Textareas take the height of their content, wrapped lines included, so a
  // long Documentation never becomes a scroll box inside the form. Re-measured
  // on every render and whenever the form's width changes the wrapping.
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const fit = () => {
      for (const area of root.querySelectorAll<HTMLTextAreaElement>('textarea.tag-form-textarea')) {
        area.style.height = 'auto';
        area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`;
      }
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    return () => observer.disconnect();
  });

  if (local === null) {
    return (
      <div className="tag-form">
        <p className="tag-form-message" role="status">
          The configuration on the JSON tab does not parse, so the form cannot show it.
          Fix it on the JSON tab first.
        </p>
      </div>
    );
  }

  // Without a model (gateway refused) fall back to what the config itself
  // holds, so a working buffer is never locked out of the form.
  const described = model ?? (modelError
    ? Object.keys(effective).filter((k) => !HIDDEN.has(k)).map((k) => guessed(k, effective[k]))
    : null);
  if (!described) {
    return (
      <div className="tag-form">
        <p className="tag-form-message" role="status">Loading properties…</p>
      </div>
    );
  }

  const names = new Set(described.map((p) => p.name));
  // A local key the model no longer lists (say opcItemPath after switching to
  // memory) still goes to Other, so it can be seen and reset rather than
  // silently saved.
  const stray = Object.keys(local)
    .filter((k) => !names.has(k) && !HIDDEN.has(k))
    .map((k) => ({ ...guessed(k, local[k]), category: 'other' }));
  const all = [...described.filter((p) => !HIDDEN.has(p.name)), ...stray];

  const commit = (next: Json) => onChange(JSON.stringify(next, null, 2));
  const set = (name: string, value: unknown) => commit(withKey(local, name, value));
  const reset = (name: string) => commit(withoutKey(local, name));
  /** What the property is without a local override. */
  const baseOf = (p: TagPropertyDescriptor): unknown => (has(inherited, p.name) ? inherited[p.name] : p.default);
  const valueOf = (p: TagPropertyDescriptor): unknown => (has(local, p.name) ? local[p.name] : baseOf(p));
  const dataType = typeof effective.dataType === 'string' ? effective.dataType : null;

  const bySection = new Map<SectionId, TagPropertyDescriptor[]>();
  for (const p of all) {
    const id = sectionOf(p);
    bySection.set(id, [...(bySection.get(id) ?? []), p]);
  }
  for (const list of bySection.values()) list.sort((a, b) => orderOf(a.name) - orderOf(b.name));

  const fieldFor = (p: TagPropertyDescriptor) => {
    const label = propertyLabel(p.name, p.label);
    const id = `${idBase}-${p.name}`;
    const overridden = has(local, p.name);
    const value = valueOf(p);
    const common = {
      id, label, overridden, readOnly,
      onReset: () => reset(p.name),
    };
    if (p.name === 'name') {
      return (
        <FieldRow key={p.name} {...common} readOnly onReset={undefined}
          hint="Rename from the tag tree.">
          <input id={id} type="text" value={String(effective.name ?? '')} readOnly />
        </FieldRow>
      );
    }
    if (p.name === 'eventScripts') {
      return (
        <EventScripts key={p.name} idBase={id} label={label} overridden={overridden} readOnly={readOnly}
          scripts={asArray(value)} onSet={(v) => set(p.name, v)} onReset={() => reset(p.name)} />
      );
    }
    if (p.name === 'alarms') {
      return (
        <AlarmList key={p.name} idBase={id} label={label} overridden={overridden} readOnly={readOnly}
          alarms={asArray(value)} onSet={(v) => set(p.name, v)} onReset={() => reset(p.name)} />
      );
    }
    if (p.name === 'parameters') {
      return (
        <Parameters key={p.name} idBase={id} label={label} overridden={overridden} readOnly={readOnly}
          params={asObject(value)} onSet={(v) => set(p.name, v)} onReset={() => reset(p.name)} />
      );
    }
    return (
      <FieldRow key={p.name} {...common}>
        <Widget id={id} name={p.name} descriptor={p} value={value} dataType={dataType}
          readOnly={readOnly} onSet={(v) => set(p.name, v)} />
      </FieldRow>
    );
  };

  return (
    <div className="tag-form" ref={rootRef}>
      {modelError && (
        <p className="tag-form-message tag-form-error" role="alert">
          Could not read the property list from the gateway ({modelError}); showing the properties this
          configuration already holds.
        </p>
      )}
      {SECTIONS.map(([id, title]) => {
        const list = bySection.get(id);
        if (!list || list.length === 0) return null;
        const open = !collapsed.has(id);
        const bodyId = `${idBase}-section-${id}`;
        return (
          <section key={id} className="tag-form-section" aria-label={title}>
            <h3 className="tag-form-section-title">
              <button
                type="button"
                className="tag-form-section-toggle"
                aria-expanded={open}
                aria-controls={bodyId}
                onClick={() => setCollapsed((c) => {
                  const next = new Set(c);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return next;
                })}
              >
                <span className="tag-form-section-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
                {title}
              </button>
            </h3>
            <fieldset id={bodyId} className="tag-form-section-body" disabled={readOnly} hidden={!open}>
              {list.map(fieldFor)}
            </fieldset>
          </section>
        );
      })}
    </div>
  );
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((v): v is Json => !!v && typeof v === 'object') : [];
}

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

// ==================== one row ====================

function FieldRow({ id, label, overridden, readOnly, onReset, hint, children }: {
  id: string;
  label: string;
  overridden: boolean;
  readOnly: boolean;
  onReset?: () => void;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={`tag-form-row${overridden ? ' is-overridden' : ' is-inherited'}`}>
      <label className="tag-form-label" htmlFor={id}>{label}</label>
      <div className="tag-form-field">
        {children}
        {overridden && onReset && (
          <button
            type="button"
            className="tag-form-reset"
            aria-label={`Reset ${label} to inherited/default`}
            title="Remove this override"
            onClick={onReset}
            disabled={readOnly}
          >
            Reset
          </button>
        )}
      </div>
      {hint && <p className="tag-form-hint">{hint}</p>}
    </div>
  );
}

// ==================== widgets ====================

/** The input for one simple property, picked by its type. */
function Widget({ id, name, descriptor, value, dataType, readOnly, onSet }: {
  id: string;
  name: string;
  descriptor: TagPropertyDescriptor;
  value: unknown;
  dataType: string | null;
  readOnly: boolean;
  onSet: (value: unknown) => void;
}) {
  const { type, allowedValues } = descriptor;
  // A bound value (`{"bindType": ...}`) or anything structured is edited as JSON.
  if (value !== null && typeof value === 'object') {
    return <JsonField id={id} value={value} readOnly={readOnly} onSet={onSet} />;
  }
  if (type === 'Boolean' || (typeof value === 'boolean' && !allowedValues)) {
    return <input id={id} type="checkbox" checked={value === true} disabled={readOnly}
      onChange={(e) => onSet(e.target.checked)} />;
  }
  if (name === 'engUnit') {
    // The gateway's list is suggestions; any unit may be typed.
    const listId = `${id}-units`;
    return (
      <>
        <input id={id} type="text" list={listId} value={value == null ? '' : String(value)}
          readOnly={readOnly} onChange={(e) => onSet(e.target.value)} />
        <datalist id={listId}>
          {(allowedValues ?? []).map((v) => <option key={String(v)} value={String(v)} />)}
        </datalist>
      </>
    );
  }
  if (allowedValues && allowedValues.length > 0) {
    return <SelectField id={id} value={value} options={allowedValues} readOnly={readOnly} onSet={onSet} />;
  }
  if (type === 'QualifiedValue' || name === 'value' || name === 'defaultValue') {
    return <TypedValueField id={id} value={value} dataType={dataType} readOnly={readOnly} onSet={onSet} />;
  }
  if (NUMBER_TYPES.has(type)) {
    return <NumberField id={id} value={value} integer={INTEGER_TYPES.has(type)} readOnly={readOnly} onSet={onSet} />;
  }
  if (type === 'String' || typeof value === 'string' || (value == null && type !== 'Object' && !looksComplex(type))) {
    if (MULTILINE.has(name)) {
      const text = value == null ? '' : String(value);
      return <textarea id={id} className="tag-form-textarea" rows={rowsFor(text)} value={text}
        readOnly={readOnly} onChange={(e) => onSet(e.target.value)} />;
    }
    return <input id={id} type="text" value={value == null ? '' : String(value)} readOnly={readOnly}
      onChange={(e) => onSet(e.target.value)} />;
  }
  return <JsonField id={id} value={value} readOnly={readOnly} onSet={onSet} />;
}

/** Types the platform describes that are not simple text. */
function looksComplex(type: string): boolean {
  return /Config|Set|Scripts|Permissions|Dataset|Array|Map|List/.test(type);
}

function rowsFor(text: string): number {
  // Grows with the content instead of scrolling inside the section.
  return Math.max(3, text.split('\n').length + 1);
}

function SelectField({ id, value, options, readOnly, onSet }: {
  id: string;
  value: unknown;
  options: unknown[];
  readOnly: boolean;
  onSet: (value: unknown) => void;
}) {
  const current = value == null ? '' : String(value);
  const known = options.map((o) => String(o));
  // A value the gateway does not list (a deleted tag group, say) stays visible
  // rather than the select silently showing the first option.
  const shown = known.includes(current) ? options : [value ?? '', ...options];
  return (
    <select id={id} value={current} disabled={readOnly}
      onChange={(e) => {
        const at = shown.findIndex((o) => String(o ?? '') === e.target.value);
        onSet(at >= 0 ? shown[at] : e.target.value);
      }}>
      {shown.map((o, i) => <option key={`${i}-${String(o)}`} value={String(o ?? '')}>{String(o ?? '')}</option>)}
    </select>
  );
}

/**
 * A number held as typed text, committed only when it parses — an empty box or
 * a half-typed "1e" is not written to the tag.
 */
function NumberField({ id, value, integer, readOnly, onSet }: {
  id: string;
  value: unknown;
  integer: boolean;
  readOnly: boolean;
  onSet: (value: unknown) => void;
}) {
  const shown = value == null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setDraft((d) => (Number(d) === value && d.trim() !== '' ? d : shown));
    setBad(false);
  }, [shown, value]);
  return (
    <input id={id} type="text" inputMode={integer ? 'numeric' : 'decimal'} value={draft}
      readOnly={readOnly} aria-invalid={bad || undefined}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const n = Number(text.trim());
        const ok = text.trim() !== '' && Number.isFinite(n) && (!integer || Number.isInteger(n));
        setBad(!ok);
        if (ok) onSet(n);
      }} />
  );
}

/** A tag value, coerced to the tag's data type before it is written. */
function TypedValueField({ id, value, dataType, readOnly, onSet }: {
  id: string;
  value: unknown;
  dataType: string | null;
  readOnly: boolean;
  onSet: (value: unknown) => void;
}) {
  const shown = value == null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setDraft((d) => (parseTagInput(d, dataType) === value ? d : shown));
    setBad(false);
  }, [shown, value, dataType]);
  if ((dataType ?? '').toLowerCase() === 'boolean') {
    return <input id={id} type="checkbox" checked={value === true} disabled={readOnly}
      onChange={(e) => onSet(e.target.checked)} />;
  }
  return (
    <input id={id} type="text" value={draft} readOnly={readOnly} aria-invalid={bad || undefined}
      onChange={(e) => {
        setDraft(e.target.value);
        const parsed = parseTagInput(e.target.value, dataType);
        setBad(parsed === undefined);
        if (parsed !== undefined) onSet(parsed);
      }} />
  );
}

/** Compact JSON, committed only when it parses. */
function JsonField({ id, value, readOnly, onSet }: {
  id: string;
  value: unknown;
  readOnly: boolean;
  onSet: (value: unknown) => void;
}) {
  const shown = value === undefined ? '' : JSON.stringify(value, null, 1).replace(/\n\s*/g, ' ');
  const [draft, setDraft] = useState(shown);
  const [bad, setBad] = useState(false);
  const lastSet = useRef<string | null>(null);
  useEffect(() => {
    // Our own commit echoes back reformatted; keep what was typed.
    if (lastSet.current !== null && JSON.stringify(value) === lastSet.current) return;
    setDraft(shown);
    setBad(false);
  }, [shown, value]);
  return (
    <textarea id={id} className="tag-form-textarea tag-form-json" rows={rowsFor(draft)} value={draft}
      readOnly={readOnly} aria-invalid={bad || undefined} spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        try {
          const parsed: unknown = JSON.parse(e.target.value);
          setBad(false);
          lastSet.current = JSON.stringify(parsed);
          onSet(parsed);
        } catch {
          setBad(true);
        }
      }} />
  );
}

/** The heading row of a structured property (alarms, scripts, parameters). */
function GroupHead({ title, overridden, readOnly, onReset, children }: {
  title: string;
  overridden: boolean;
  readOnly: boolean;
  onReset: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={`tag-form-group-head${overridden ? ' is-overridden' : ' is-inherited'}`}>
      <span className="tag-form-group-title">{title}{overridden ? '' : ' (inherited/default)'}</span>
      <div className="tag-form-group-actions">
        {children}
        {overridden && (
          <button type="button" className="tag-form-reset" onClick={onReset} disabled={readOnly}
            aria-label={`Reset ${title} to inherited/default`} title="Remove this override">
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ==================== event scripts ====================

/** The five tag events, with the signature the gateway wraps each body in. */
export const TAG_EVENTS: [id: string, label: string, signature: string][] = [
  ['valueChanged', 'Value Changed', 'valueChanged(tag, tagPath, previousValue, currentValue, initialChange, missedEvents)'],
  ['qualityChanged', 'Quality Changed', 'qualityChanged(tag, tagPath, previousValue, currentValue, initialChange, missedEvents)'],
  ['alarmActive', 'Alarm Active', 'alarmActive(tag, tagPath, alarmName, alarmEvent, alarmPath, missedEvents)'],
  ['alarmCleared', 'Alarm Cleared', 'alarmCleared(tag, tagPath, alarmName, alarmEvent, alarmPath, missedEvents)'],
  ['alarmAcknowledged', 'Alarm Acknowledged', 'alarmAcknowledged(tag, tagPath, alarmName, alarmEvent, alarmPath, missedEvents)'],
];

function EventScripts({ idBase, label, scripts, overridden, readOnly, onSet, onReset }: {
  idBase: string;
  label: string;
  scripts: Json[];
  overridden: boolean;
  readOnly: boolean;
  onSet: (value: Json[]) => void;
  onReset: () => void;
}) {
  const present = new Set(scripts.map((s) => String(s.eventid)));
  const missing = TAG_EVENTS.filter(([id]) => !present.has(id));
  const addId = `${idBase}-add`;
  return (
    <div className="tag-form-group">
      <GroupHead title={label} overridden={overridden} readOnly={readOnly} onReset={onReset}>
        {missing.length > 0 && (
          <>
            <label className="tag-form-sr" htmlFor={addId}>Add event script</label>
            <select id={addId} value="" disabled={readOnly}
              onChange={(e) => {
                if (!e.target.value) return;
                // A body of only whitespace does not compile once wrapped in its def.
                onSet([...scripts, { eventid: e.target.value, script: '\tpass' }]);
              }}>
              <option value="">Add event script…</option>
              {missing.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
            </select>
          </>
        )}
      </GroupHead>
      {scripts.length === 0 && <p className="tag-form-hint">No event scripts.</p>}
      {scripts.map((entry, index) => {
        const id = String(entry.eventid);
        const known = TAG_EVENTS.find(([e]) => e === id);
        const title = known ? known[1] : id;
        return (
          <div key={id} className="tag-form-script">
            <div className="tag-form-script-head">
              <span className="tag-form-script-title" id={`${idBase}-${id}-title`}>{title}</span>
              <code className="tag-form-script-sig">def {known ? known[2] : `${id}(...)`}:</code>
              <button type="button" className="tag-form-small" disabled={readOnly}
                aria-label={`Remove ${title} script`}
                onClick={() => onSet(scripts.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
            <ScriptEditor
              text={typeof entry.script === 'string' ? entry.script : ''}
              readOnly={readOnly}
              label={`${title} script`}
              onChange={(text) => onSet(scripts.map((s, i) => (i === index ? { ...s, script: text } : s)))}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * One event script body in CodeMirror: Python, a literal tab for indent (the
 * Designer's bytes), wrapped lines so it never scrolls sideways, and growing
 * with its content so the section has no inner scroll box.
 */
function ScriptEditor({ text, readOnly, label, onChange }: {
  text: string;
  readOnly: boolean;
  label: string;
  onChange: (text: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlySwitch = useMemo(() => new Compartment(), []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          ...pythonSurface,
          editorTheme,
          EditorView.lineWrapping,
          readOnlySwitch.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          pythonKeymap,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          ...byteFidelity,
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once; text and readOnly are synced below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== text) view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
  }, [text]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: readOnlySwitch.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly, readOnlySwitch]);

  return <div className="tag-form-code" ref={hostRef} />;
}

// ==================== alarms ====================

/** `AlarmMode` enum names as the tag JSON stores them (verified live, 8.3.8). */
export const ALARM_MODES: [string, string][] = [
  ['Equality', 'Equal'],
  ['Inequality', 'Not Equal'],
  ['AboveValue', 'Above Setpoint'],
  ['BelowValue', 'Below Setpoint'],
  ['BetweenValues', 'Between Setpoints'],
  ['OutsideValues', 'Outside Setpoints'],
  ['OutOfEngRange', 'Out of Range'],
  ['BadQuality', 'Bad Quality'],
  ['AnyChange', 'Any Change'],
  ['Bit', 'Bit State'],
  ['OnCondition', 'On Condition'],
  ['WhenTrue', 'When True'],
  ['WhenFalse', 'When False'],
];

interface AlarmField {
  key: string;
  label: string;
  type: 'String' | 'Boolean' | 'Double' | 'Integer' | 'Text';
  default: unknown;
  options?: string[];
  /** Shown only for these modes. */
  modes?: string[];
}

const SETPOINT_MODES = ['Equality', 'Inequality', 'AboveValue', 'BelowValue', 'BetweenValues', 'OutsideValues'];
const RANGE_MODES = ['BetweenValues', 'OutsideValues'];

/** The configurable alarm properties, defaults from the live `CommonAlarmProperties` / `AlarmModeProperties`. */
export const ALARM_FIELDS: AlarmField[] = [
  { key: 'name', label: 'Name', type: 'String', default: '' },
  { key: 'enabled', label: 'Enabled', type: 'Boolean', default: true },
  { key: 'priority', label: 'Priority', type: 'String', default: 'Low',
    options: ['Diagnostic', 'Low', 'Medium', 'High', 'Critical'] },
  { key: 'mode', label: 'Mode', type: 'String', default: 'Equality', options: ALARM_MODES.map(([m]) => m) },
  { key: 'setpointA', label: 'Setpoint', type: 'Double', default: 0, modes: SETPOINT_MODES },
  { key: 'inclusiveA', label: 'Inclusive', type: 'Boolean', default: true,
    modes: ['AboveValue', 'BelowValue', ...RANGE_MODES] },
  { key: 'setpointB', label: 'High Setpoint', type: 'Double', default: 0, modes: RANGE_MODES },
  { key: 'inclusiveB', label: 'High Inclusive', type: 'Boolean', default: true, modes: RANGE_MODES },
  { key: 'anyChange', label: 'Any Change', type: 'Boolean', default: false, modes: RANGE_MODES },
  { key: 'bitPosition', label: 'Bit Position', type: 'Integer', default: 0, modes: ['Bit'] },
  { key: 'bitOnZero', label: 'On Zero', type: 'Boolean', default: false, modes: ['Bit'] },
  { key: 'activeCondition', label: 'Is Active', type: 'Boolean', default: false, modes: ['OnCondition'] },
  { key: 'onEachEvaluation', label: 'Alarm on Each Evaluation', type: 'Boolean', default: false,
    modes: ['AnyChange'] },
  { key: 'label', label: 'Label', type: 'String', default: '' },
  { key: 'displayPath', label: 'Display Path', type: 'String', default: '' },
  { key: 'deadband', label: 'Deadband', type: 'Double', default: 0 },
  { key: 'deadbandMode', label: 'Deadband Mode', type: 'String', default: 'Absolute', options: ['Absolute', 'Percent'] },
  { key: 'timeOnDelaySeconds', label: 'Active Delay (s)', type: 'Double', default: 0 },
  { key: 'timeOffDelaySeconds', label: 'Clear Delay (s)', type: 'Double', default: 0 },
  { key: 'timestampSource', label: 'Timestamp Source', type: 'String', default: 'System', options: ['System', 'Value'] },
  { key: 'ackMode', label: 'Ack Mode', type: 'String', default: 'Manual', options: ['Manual', 'Auto', 'Unused'] },
  { key: 'ackNotesReqd', label: 'Ack Notes Required', type: 'Boolean', default: false },
  { key: 'shelvingAllowed', label: 'Shelving Allowed', type: 'Boolean', default: true },
  { key: 'notifyInitialEvent', label: 'Notify Initial Event', type: 'Boolean', default: false },
  { key: 'activePipeline', label: 'Active Pipeline', type: 'String', default: '' },
  { key: 'clearPipeline', label: 'Clear Pipeline', type: 'String', default: '' },
  { key: 'ackPipeline', label: 'Ack Pipeline', type: 'String', default: '' },
  { key: 'notes', label: 'Notes', type: 'Text', default: '' },
];
const ALARM_KEYS = new Set(ALARM_FIELDS.map((f) => f.key));

function modeLabel(mode: unknown): string {
  return ALARM_MODES.find(([m]) => m === mode)?.[1] ?? String(mode ?? 'Equal');
}

function freeName(alarms: Json[], base: string): string {
  const taken = new Set(alarms.map((a) => String(a.name)));
  if (!taken.has(base)) return base;
  for (let n = 1; ; n += 1) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

function AlarmList({ idBase, label, alarms, overridden, readOnly, onSet, onReset }: {
  idBase: string;
  label: string;
  alarms: Json[];
  overridden: boolean;
  readOnly: boolean;
  onSet: (value: Json[]) => void;
  onReset: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const index = alarms.length === 0 ? -1 : Math.min(selected, alarms.length - 1);
  const alarm = index >= 0 ? alarms[index] : null;

  const put = (next: Json[], select: number) => {
    setSelected(select);
    onSet(next);
  };
  const extras = alarm ? Object.fromEntries(Object.entries(alarm).filter(([k]) => !ALARM_KEYS.has(k))) : {};
  const mode = alarm ? String(alarm.mode ?? 'Equality') : '';

  return (
    <div className="tag-form-group">
      <GroupHead title={label} overridden={overridden} readOnly={readOnly} onReset={onReset}>
        <button type="button" className="tag-form-small" disabled={readOnly}
          onClick={() => put([...alarms, { name: freeName(alarms, 'New Alarm'), mode: 'AboveValue', setpointA: 0 }], alarms.length)}>
          Add alarm
        </button>
        <button type="button" className="tag-form-small" disabled={readOnly || !alarm}
          onClick={() => alarm && put([...alarms, { ...alarm, name: freeName(alarms, `${String(alarm.name)} copy`) }], alarms.length)}>
          Duplicate
        </button>
        <button type="button" className="tag-form-small" disabled={readOnly || !alarm}
          onClick={() => put(alarms.filter((_, i) => i !== index), Math.max(0, index - 1))}>
          Delete
        </button>
      </GroupHead>
      {alarms.length === 0 && <p className="tag-form-hint">No alarms.</p>}
      {alarms.length > 0 && (
        <ul className="tag-form-alarm-list" aria-label="Alarms">
          {alarms.map((a, i) => (
            <li key={i}>
              <button type="button" className={`tag-form-alarm-item${i === index ? ' is-selected' : ''}`}
                aria-current={i === index ? 'true' : undefined} onClick={() => setSelected(i)}>
                <span className="tag-form-alarm-name">{String(a.name ?? '(unnamed)')}</span>
                <span className="tag-form-alarm-meta">{modeLabel(a.mode)} · {String(a.priority ?? 'Low')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {alarm && (
        <div className="tag-form-alarm-edit" role="group" aria-label={`Alarm ${String(alarm.name)}`}>
          {ALARM_FIELDS.filter((f) => !f.modes || f.modes.includes(mode)).map((f) => {
            const id = `${idBase}-${index}-${f.key}`;
            const set = has(alarm, f.key);
            const value = set ? alarm[f.key] : f.default;
            const update = (v: unknown) => onSet(alarms.map((a, i) => (i === index ? withKey(a, f.key, v) : a)));
            const descriptor: TagPropertyDescriptor = {
              name: f.key, type: f.type === 'Text' ? 'String' : f.type, default: f.default,
              allowedValues: f.options ?? null, category: 'alarms', label: f.label,
            };
            return (
              <FieldRow key={f.key} id={id} label={f.label} overridden={set} readOnly={readOnly}
                onReset={f.key === 'name' ? undefined
                  : () => onSet(alarms.map((a, i) => (i === index ? withoutKey(a, f.key) : a)))}>
                {f.key === 'mode'
                  ? (
                    <select id={id} value={String(value)} disabled={readOnly} onChange={(e) => update(e.target.value)}>
                      {ALARM_MODES.map(([m, text]) => <option key={m} value={m}>{text}</option>)}
                    </select>
                  )
                  : f.type === 'Text'
                    ? <textarea id={id} className="tag-form-textarea" rows={rowsFor(String(value ?? ''))}
                        value={String(value ?? '')} readOnly={readOnly} onChange={(e) => update(e.target.value)} />
                    : <Widget id={id} name={f.key} descriptor={descriptor} value={value} dataType={null}
                        readOnly={readOnly} onSet={update} />}
              </FieldRow>
            );
          })}
          <FieldRow id={`${idBase}-${index}-extra`} label="Associated Data" overridden={false} readOnly={readOnly}
            hint="Extra alarm properties as a JSON object.">
            <JsonField id={`${idBase}-${index}-extra`} value={extras} readOnly={readOnly}
              onSet={(v) => {
                const own = Object.fromEntries(Object.entries(alarm).filter(([k]) => ALARM_KEYS.has(k)));
                onSet(alarms.map((a, i) => (i === index ? { ...own, ...asObject(v) } : a)));
              }} />
          </FieldRow>
        </div>
      )}
    </div>
  );
}

// ==================== UDT parameters ====================

const PARAM_TYPES = ['String', 'Integer', 'Long', 'Float', 'Double', 'Boolean'];

function Parameters({ idBase, label, params, overridden, readOnly, onSet, onReset }: {
  idBase: string;
  label: string;
  params: Json;
  overridden: boolean;
  readOnly: boolean;
  onSet: (value: Json) => void;
  onReset: () => void;
}) {
  const [newName, setNewName] = useState('');
  const names = Object.keys(params);
  const newId = `${idBase}-new`;
  const trimmed = newName.trim();
  const add = () => {
    if (!trimmed || has(params, trimmed)) return;
    onSet(withKey(params, trimmed, { dataType: 'String', value: '' }));
    setNewName('');
  };
  return (
    <div className="tag-form-group">
      <GroupHead title={label} overridden={overridden} readOnly={readOnly} onReset={onReset} />
      {names.length === 0 && <p className="tag-form-hint">No parameters.</p>}
      {names.length > 0 && (
        <table className="tag-form-params">
          <thead>
            <tr><th scope="col">Name</th><th scope="col">Data Type</th><th scope="col">Value</th><th scope="col"><span className="tag-form-sr">Actions</span></th></tr>
          </thead>
          <tbody>
            {names.map((name) => {
              const entry = asObject(params[name]);
              const typeId = `${idBase}-${name}-type`;
              const valueId = `${idBase}-${name}-value`;
              const type = String(entry.dataType ?? 'String');
              const put = (key: string, v: unknown) => onSet(withKey(params, name, withKey(entry, key, v)));
              return (
                <tr key={name}>
                  <th scope="row" className="tag-form-param-name">{name}</th>
                  <td>
                    <label className="tag-form-sr" htmlFor={typeId}>{`${name} data type`}</label>
                    <SelectField id={typeId} value={type} options={PARAM_TYPES} readOnly={readOnly}
                      onSet={(v) => put('dataType', v)} />
                  </td>
                  <td>
                    <label className="tag-form-sr" htmlFor={valueId}>{`${name} value`}</label>
                    {entry.value !== null && typeof entry.value === 'object'
                      ? <JsonField id={valueId} value={entry.value} readOnly={readOnly} onSet={(v) => put('value', v)} />
                      : <TypedValueField id={valueId} value={entry.value ?? ''} readOnly={readOnly}
                          dataType={type === 'Integer' || type === 'Long' ? 'Int8'
                            : type === 'Float' || type === 'Double' ? 'Float8' : type}
                          onSet={(v) => put('value', v)} />}
                  </td>
                  <td>
                    <button type="button" className="tag-form-small" disabled={readOnly}
                      aria-label={`Remove parameter ${name}`} onClick={() => onSet(withoutKey(params, name))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="tag-form-param-add">
        <label htmlFor={newId}>New parameter</label>
        <input id={newId} type="text" value={newName} readOnly={readOnly}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="tag-form-small" disabled={readOnly || !trimmed || has(params, trimmed)}
          onClick={add}>
          Add parameter
        </button>
      </div>
    </div>
  );
}
