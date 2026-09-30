/**
 * The per-type attribute editor — a timer's delay and threading, a message
 * handler's thread type, a library script's hint scope.
 *
 * The fields shown are driven ENTIRELY by the `editable` array the attributes
 * endpoint returns; nothing here decides what a type supports. That array is the
 * server's measured allowlist, and a type whose Designer workspace was never
 * measured returns an empty one — for those this strip renders nothing at all
 * rather than offering a control whose write the server will refuse.
 *
 * The value types are not interchangeable and are not coerced here:
 * `sharedThread` is a boolean (timer), `threadType` is a case-sensitive string
 * (message handler). Sending the wrong one is accepted by the resource layer and
 * then behaves wrongly, with nothing in any log to say so.
 */
import type { ReactNode } from 'react';
import type { AttributeValue } from '../api/scripts';
import './ConfigStrip.css';

export interface ConfigStripProps {
  /** Attribute names the server will accept for this resource type. */
  editable: string[];
  attributes: Record<string, AttributeValue>;
  onChange: (name: string, value: AttributeValue) => void;
  onSave: () => void;
  dirty: boolean;
  readOnly: boolean;
  saving?: boolean;
  /** Resource type, so the strip can show that type's Designer documentation. */
  typeId?: string;
  /**
   * Why this type has no editable settings, when it has none. Rendered instead
   * of nothing: a Tag Change script with no visible controls otherwise looks
   * like a bug in this IDE rather than a deliberate refusal.
   */
  unconfigurableReason?: string;
  /**
   * Rendered first, on the same row as the controls.
   *
   * The inheritance state goes here (Nigel, 02/09/2026). It used to be its own
   * bar below this one, and two chrome rows stacked above the code cost the
   * editor ~70px for two short sentences that never appear at the same time as
   * each other. One row, notice on the left, settings on the right.
   */
  leading?: ReactNode;
}

/**
 * Attributes rendered as a checkbox.
 *
 * `fixedDelay` is NOT one of them: the Designer shows it as a radio pair,
 * ● Fixed Delay / ○ Fixed Rate, and those are two named modes rather than one
 * on/off setting. A checkbox called "Fixed delay" leaves the user to work out
 * what unticking it does, and the answer — "fixed rate" — is a word that never
 * appears on screen.
 */
const BOOLEAN_FIELDS = new Set(['enabled', 'sharedThread']);

const LABELS: Record<string, string> = {
  enabled: 'Enabled',
  delay: 'Delay (ms)',
  fixedDelay: 'Delay type',
  sharedThread: 'Shared thread',
  threadType: 'Thread type',
  hintScope: 'Script Hint Scope',
  cronExpression: 'Cron expression',
};

/**
 * Fields that belong at the far RIGHT of the strip, small and out of the way.
 *
 * `Script Hint Scope` is the only one, and its placement is the Designer's:
 * a small grey label and a combo at the top-right of the editor header, well
 * away from the code. It is a setting almost nobody touches — Nigel had used the
 * Designer for years without noticing it (01/09/2026) — and 1.4.0's first
 * attempt gave it a paragraph of explanation, which made the rarest control on
 * the strip the loudest thing on it.
 *
 * What that paragraph said is kept HERE, where it costs the reader nothing:
 * the combo filters which scope's API the autocomplete offers in this script and
 * persists to `attributes.hintScope`, so the Designer honours it too. Measured
 * (web-designer `SCRIPTING.md` §4.4): with `Designer` chosen, `system.`
 * completes `alarm, dataset, date, db, device, dnp3, file…`; with `Gateway` or
 * `All` the list also carries the gateway-only `bacnet` and `config`. And
 * `None` does NOT switch hints off — measured twice, it shows the widest list.
 */
const TRAILING_FIELDS = new Set(['hintScope']);


/**
 * The Designer's own explanatory text for each event type, and the parameters
 * its handler is called with.
 *
 * Both are STATIC in the Designer — they describe what the event type is and
 * what its handler receives. Neither is stored in `resource.json` and neither is
 * editable there, so neither is editable here: inventing a `description`
 * attribute would write a key the platform does not read and the Designer would
 * never show, which is the opposite of the two tools lining up.
 *
 * Wording is verbatim from the real Designer where it was measured
 * (web-designer `docs/design-handoff/real-designer/SCRIPTING.md` §5.1–5.4).
 */
const TYPE_DOCS: Record<
  string,
  { description: string; parameters?: Array<{ name: string; type: string; text: string }> }
> = {
  timer: {
    // Verbatim from the Designer, SCRIPTING.md §5.1. The 1.2.0 wording was a
    // paraphrase, which is the one thing a "parity" string must not be.
    description: 'Timer scripts that are always running on the Gateway',
  },
  message: {
    description:
      'Message handler scripts that run whenever the Gateway receives a script message',
    parameters: [
      {
        name: 'payload',
        type: 'dict',
        text: 'A dictionary that holds the objects passed to this message handler. '
          + "Retrieve them with a subscript, e.g. myObject = payload['argumentName']",
      },
    ],
  },
  startup: { description: 'Project startup script that runs in the Gateway' },
  shutdown: { description: 'Project shutdown script that runs in the Gateway' },
  update: { description: 'Project update script that runs in the Gateway' },
  scheduled: {
    description:
      'Scheduled scripts run on the Gateway according to a cron expression.',
  },
  'tag-change': {
    description:
      'Tag change scripts run on the Gateway when one of their configured tags changes.',
  },
};

/**
 * ApplicationScope bitmask. These four values are the only ones the server
 * accepts; anything else is written silently and then behaves unpredictably in
 * the Designer, which is why the control is a select and not a number box.
 */
/**
 * The Designer's own combo, in the Designer's own order.
 *
 * ORDER IS MEASURED, not sorted by value: the real 8.3.8 Designer lists
 * `None · Designer · Gateway · All` (screenshotted 01/09/2026 on a Project
 * Library script). Ours listed Gateway before Designer until 1.4.0, which is
 * the numeric order and nobody's muscle memory. The values are ApplicationScope
 * bits — gateway 1, designer 2, client 4, all 7.
 */
const HINT_SCOPES: Array<{ value: number; label: string }> = [
  { value: 0, label: 'None' },
  { value: 2, label: 'Designer' },
  { value: 1, label: 'Gateway' },
  { value: 7, label: 'All' },
];

/** Exactly as the Designer writes them. Case-sensitive — do not title-case. */
const THREAD_TYPES = ['Shared', 'Dedicated'];

export default function ConfigStrip({
  editable,
  attributes,
  onChange,
  onSave,
  dirty,
  readOnly,
  saving = false,
  typeId,
  unconfigurableReason,
  leading,
}: ConfigStripProps) {
  const docs = typeId ? TYPE_DOCS[typeId] : undefined;

  // Body-only type: still say what the script IS and why there is nothing to
  // configure, rather than rendering an empty bar or nothing at all.
  if (editable.length === 0) {
    if (!docs && !unconfigurableReason && !leading) return null;
    return (
      <div
        className={`config-strip${docs || unconfigurableReason ? ' config-strip-docs' : ''}`}
        aria-label="Script settings"
      >
        {leading}
        <TypeDocs docs={docs} />
        {unconfigurableReason && (
          <p className="config-note muted">{unconfigurableReason}</p>
        )}
      </div>
    );
  }

  return (
    <div className="config-strip" aria-label="Script settings">
      {leading}
      <TypeDocs docs={docs} />
      {editable.map((name) => (
        <label
          className={`config-field${TRAILING_FIELDS.has(name) ? ' config-field-trailing' : ''}`}
          key={name}
        >
          <span className="config-label">{LABELS[name] ?? name}</span>
          {renderField(name, attributes[name], onChange, readOnly)}
        </label>
      ))}
      <button
        type="button"
        className="button config-save"
        onClick={onSave}
        // Attributes are a separate resource write from the body, so they get
        // their own button — saving the script must not silently push settings
        // the user only clicked through.
        disabled={readOnly || saving || !dirty}
      >
        {saving ? 'Saving settings…' : 'Save settings'}
      </button>
    </div>
  );
}

/**
 * The Designer's description and handler parameters for this event type.
 *
 * Read-only by construction — see TYPE_DOCS. Rendered above the controls so the
 * page reads in the same order as the Designer's workspace.
 */
function TypeDocs({ docs }: { docs?: (typeof TYPE_DOCS)[string] }) {
  if (!docs) return null;
  return (
    <div className="config-docs">
      <p className="config-description">{docs.description}</p>
      {docs.parameters && docs.parameters.length > 0 && (
        <dl className="config-params">
          {docs.parameters.map((param) => (
            <div className="config-param" key={param.name}>
              <dt>
                <code>{param.name}</code>
                <span className="config-param-type muted">({param.type})</span>
              </dt>
              <dd className="muted">{param.text}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * The change types, as the Designer LABELS them and as the resource STORES them.
 *
 * They are not the same string, which is exactly the kind of thing that only
 * turns up by driving the real thing: the resource holds `ValueChange`, and the
 * Designer's Change Triggers row says `Value`. Measured on 8.3.8, 06/09/2026, on
 * `_wd_scratch_`'s WDTagChangeProbe. Showing the stored value would have been a
 * vocabulary this IDE invented for a control that already has names people know.
 */
const CHANGE_TYPES: Array<{ stored: string; label: string }> = [
  { stored: 'ValueChange', label: 'Value' },
  { stored: 'QualityChange', label: 'Quality' },
  { stored: 'TimestampChange', label: 'Timestamp' },
];

function renderField(
  name: string,
  value: AttributeValue | undefined,
  onChange: ConfigStripProps['onChange'],
  readOnly: boolean
) {
  if (BOOLEAN_FIELDS.has(name)) {
    return (
      <input
        type="checkbox"
        checked={value === true}
        disabled={readOnly}
        onChange={(e) => onChange(name, e.target.checked)}
      />
    );
  }
  // Tag Change's two arrays. One per line is the shape a tag path list actually
  // has — a comma-separated box invites a comma inside a tag path, which is
  // legal — and it is what the Designer's own list looks like.
  if (name === 'paths' || name === 'changeTypes') {
    const lines = Array.isArray(value) ? value : [];
    if (name === 'changeTypes') {
      return (
        <span className="config-changetypes">
          {CHANGE_TYPES.map((type) => (
            <label key={type.stored}>
              <input
                type="checkbox"
                checked={lines.includes(type.stored)}
                disabled={readOnly}
                onChange={(e) => {
                  const next = e.target.checked
                    ? [...lines, type.stored]
                    : lines.filter((t) => t !== type.stored);
                  // Kept in the platform's own order, not click order: the
                  // resource is diffed against the Designer's copy.
                  onChange(name, CHANGE_TYPES
                    .map((t) => t.stored)
                    .filter((t) => next.includes(t)));
                }}
              />
              {type.label}
            </label>
          ))}
        </span>
      );
    }
    return (
      <textarea
        className="config-paths"
        rows={Math.min(6, Math.max(2, lines.length + 1))}
        spellCheck={false}
        placeholder="[default]Path/To/Tag&#10;One path per line"
        title={'One tag path per line. Wildcards work at the FOLDER level only — '
          + '[default]folder/* runs for every tag in the folder, and '
          + '[default]folder/ramp* does not work. (Measured off the Designer, '
          + '8.3.8.)'}
        value={lines.join('\n')}
        disabled={readOnly}
        onChange={(e) =>
          onChange(name, e.target.value.split('\n').map((l) => l.trim()).filter(Boolean))
        }
      />
    );
  }
  if (name === 'delay') {
    return (
      <input
        type="number"
        min={0}
        // 24 hours, matching ScriptResourceTypes.MAX_TIMER_DELAY_MS. A larger
        // value is a 400 from the server, so the input stops it here.
        max={86400000}
        step={100}
        value={typeof value === 'number' ? value : ''}
        disabled={readOnly}
        onChange={(e) => onChange(name, Number(e.target.value))}
      />
    );
  }
  if (name === 'threadType') {
    return (
      <select
        value={typeof value === 'string' ? value : THREAD_TYPES[0]}
        disabled={readOnly}
        onChange={(e) => onChange(name, e.target.value)}
      >
        {THREAD_TYPES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (name === 'hintScope') {
    return (
      <select
        value={typeof value === 'number' ? String(value) : '0'}
        disabled={readOnly}
        onChange={(e) => onChange(name, Number(e.target.value))}
      >
        {HINT_SCOPES.map((option) => (
          <option key={option.value} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (name === 'fixedDelay') {
    // The Designer's radio pair. `true` is Fixed Delay and is the default it
    // writes on create.
    return (
      <span className="config-radio-pair">
        {[
          { value: true, label: 'Fixed Delay' },
          { value: false, label: 'Fixed Rate' },
        ].map((option) => (
          <label className="config-radio" key={String(option.value)}>
            <input
              type="radio"
              name="fixedDelay"
              checked={(value ?? true) === option.value}
              disabled={readOnly}
              onChange={() => onChange(name, option.value)}
            />
            {option.label}
          </label>
        ))}
      </span>
    );
  }
  if (name === 'cronExpression') {
    return (
      <input
        type="text"
        className="config-cron"
        value={String(value ?? '')}
        placeholder="*/30 * * * *"
        spellCheck={false}
        // Free text, not a builder. The gateway's scheduler is the arbiter of
        // what a valid expression is, and a builder here would quietly refuse
        // expressions the platform accepts.
        onChange={(e) => onChange(name, e.target.value)}
        disabled={readOnly}
      />
    );
  }
  // An attribute this build does not know how to render. Shown read-only rather
  // than hidden: the server said it is editable, so silently dropping it would
  // hide a real capability behind a stale frontend.
  return <input type="text" value={String(value ?? '')} readOnly disabled />;
}
