/**
 * Open documents, one tab each.
 *
 * The dirty marker is derived from the document (text vs baseText), never stored
 * separately — a dirty flag and a buffer drift apart, and the one place that
 * shows up is a tab that says "saved" over unsaved work.
 */
import type { ReactNode } from 'react';
import { IconSplit } from './Icons';
import { PresenceBadge } from './Presence';
import type { Peer } from '../api/presence';
import { isDirty, readOnlyReason, type OpenDoc } from '../workspace/documents';
import './TabStrip.css';

export interface TabStripProps {
  docs: OpenDoc[];
  activeUri: string | null;
  /**
   * Documents whose gateway copy has moved on since this tab was opened —
   * typically an edit made in the Designer. Derived in the workspace from the
   * listing's signature, not stored on the document.
   */
  staleUris?: ReadonlySet<string>;
  onSelect: (uri: string) => void;
  onClose: (uri: string) => void;
  /** Re-read one document from the gateway. Absent hides the affordance. */
  onPull?: (uri: string) => void;
  /**
   * Move the active document to the other editor pane. Absent hides the button.
   *
   * A pane-level action rather than a per-tab one, and placed at the END of the
   * strip for that reason: it is about where this pane's current document
   * lives, not about any of the tabs beside it.
   */
  onSplit?: (uri: string) => void;
  /** What the split button will do — it moves BOTH ways, so it must say which. */
  splitLabel?: string;
  /**
   * The word ON the button, as distinct from the sentence in its tooltip.
   *
   * It carries a visible label rather than a glyph alone because it did not:
   * until 1.18.0 this was a bare `⇹` in muted grey at the far end of the strip,
   * and Nigel found it only by going looking for it (07/09/2026). An action
   * nobody can see is not discoverable by being present.
   */
  splitText?: string;
  /**
   * Who else has each document open, keyed by uri.
   *
   * On the TAB rather than only above the editor because the case that costs
   * you an hour is the file you have open in a background tab and have not
   * looked at — by the time you switch to it and read a bar, you have already
   * typed into it.
   */
  presence?: ReadonlyMap<string, Peer[]>;
  /** Rendered when this pane has no documents, in place of nothing at all. */
  empty?: ReactNode;
}

export default function TabStrip({
  docs, activeUri, staleUris, onSelect, onClose, onPull, onSplit, splitLabel, splitText,
  presence, empty,
}: TabStripProps) {
  if (docs.length === 0) return empty ? <>{empty}</> : null;

  return (
    <div className="tab-strip-row">
      {/* Not role="tablist"/"tab": those require every direct (or, through a
          role="presentation" wrapper, logical) child to be a tab, and each
          tab here also carries a close button and, sometimes, a stale-pull
          button — neither is a tab, so there is no legal way to keep both
          roles and both buttons. It was never a conformant tablist anyway
          (no roving tabindex, no arrow-key navigation between tabs — every
          tab sits in the normal Tab sequence, VS Code style), so this names
          the group instead and marks the open tab with aria-current, the
          same convention FileTree uses for the selected row. */}
      <div className="tab-strip" aria-label="Open scripts">
      {docs.map((doc) => {
        const dirty = isDirty(doc);
        const stale = staleUris?.has(doc.uri) ?? false;
        const active = doc.uri === activeUri;
        // Measured off the real Designer (see documents.ts): an inherited,
        // not-yet-overridden script opens headed "<name>  (Read-Only)". The
        // editor already refuses every keystroke — see CodeEditor — but until
        // now nothing on the TAB said so, and a tab strip with six scripts
        // open gave no way to tell which one that was without clicking each.
        const locked = readOnlyReason(doc);
        return (
          <div key={doc.uri} className={`tab${active ? ' is-active' : ''}`}>
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              className="tab-label"
              title={`${doc.project} · ${doc.path}`}
              onClick={() => onSelect(doc.uri)}
            >
              <span className="tab-name">
                {doc.label}
                {locked && <span className="tab-readonly"> ({locked})</span>}
              </span>
              {/* Rendered as a marker with a text alternative: a bare bullet is
                  invisible to a screen reader and to a test query alike. */}
              {dirty && (
                <span className="tab-dirty" aria-label="unsaved changes" title="Unsaved changes">
                  •
                </span>
              )}
              <PresenceBadge peers={presence?.get(doc.uri) ?? []} />
            </button>
            {/* Stale is a DIFFERENT state from dirty and gets its own marker:
                dirty is "you have edits the gateway has not seen", stale is
                "the gateway has edits you have not seen". Both at once is the
                interesting case — that is a conflict waiting at the next save,
                and it is worth being able to see it before then. */}
            {stale && (
              <button
                type="button"
                className="tab-stale"
                aria-label={`${doc.label} changed on the gateway — pull`}
                title={dirty
                  ? 'Changed on the gateway, and you have unsaved edits. Pull to compare.'
                  : 'Changed on the gateway. Pull to load the current copy.'}
                onClick={(event) => {
                  event.stopPropagation();
                  onPull?.(doc.uri);
                }}
              >
                ↓
              </button>
            )}
            <button
              type="button"
              className="tab-close"
              aria-label={`Close ${doc.label}`}
              onClick={() => onClose(doc.uri)}
            >
              ×
            </button>
          </div>
        );
      })}
      </div>
      {/* Outside the tablist on purpose — see the role="presentation" note
          above; this one is never a tab at all, presentational or otherwise. */}
      {onSplit && activeUri && (
        <button
          type="button"
          className="tab-strip-action"
          aria-label={splitLabel ?? 'Move to the other editor'}
          title={splitLabel ?? 'Move to the other editor'}
          onClick={() => onSplit(activeUri)}
        >
          <IconSplit size={14} />
          <span className="tab-strip-action-text">{splitText ?? 'Split'}</span>
        </button>
      )}
    </div>
  );
}
