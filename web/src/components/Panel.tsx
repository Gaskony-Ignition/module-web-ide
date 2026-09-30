/**
 * The bottom panel: VS Code's dock for things that are not the editor.
 *
 * Two tabs today, Script Console and Terminal, laid out the way VS Code lays out
 * its own — 11px uppercase labels along the top, actions for the ACTIVE tab
 * right-aligned, then maximise and close. Both were floating panes before 1.3.0,
 * and Nigel's note is the reason they are not any more: a console that opens
 * beside the editor competes with it for width, when the thing a console
 * actually needs is a wide, short strip under the code it is about.
 *
 * Every tab stays MOUNTED and is hidden with `hidden` rather than unmounted.
 * That is not an optimisation: a terminal's scrollback and a console's REPL
 * locals live in the component, and unmounting a tab to switch away from it
 * would silently discard a working session.
 */
import type { ReactNode } from 'react';
import { IconChevronDown, IconChevronUp, IconClose } from './Icons';
import './Panel.css';

export interface PanelTab {
  id: string;
  label: string;
  /** Rendered right of the tab strip while this tab is active. */
  actions?: ReactNode;
  content: ReactNode;
}

export interface PanelProps {
  tabs: PanelTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  maximised: boolean;
  onToggleMaximise: () => void;
}

export default function Panel({
  tabs, activeId, onSelect, onClose, maximised, onToggleMaximise,
}: PanelProps) {
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <section className="panel" aria-label="Panel">
      <div className="panel-head">
        <div className="panel-tabs" role="tablist" aria-label="Panel views">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`panel-tab-${tab.id}`}
              aria-selected={tab.id === active?.id}
              aria-controls={`panel-body-${tab.id}`}
              className={`panel-tab${tab.id === active?.id ? ' is-active' : ''}`}
              onClick={() => onSelect(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          {active?.actions}
          <button
            type="button"
            className="panel-icon-button"
            aria-pressed={maximised}
            aria-label={maximised ? 'Restore panel size' : 'Maximise panel'}
            title={maximised ? 'Restore panel size' : 'Maximise panel'}
            onClick={onToggleMaximise}
          >
            {maximised ? <IconChevronDown size={14} /> : <IconChevronUp size={14} />}
          </button>
          <button
            type="button"
            className="panel-icon-button"
            aria-label="Close panel"
            title="Close panel"
            onClick={onClose}
          >
            <IconClose size={14} />
          </button>
        </div>
      </div>

      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`panel-body-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`panel-tab-${tab.id}`}
          className="panel-body"
          hidden={tab.id !== active?.id}
        >
          {tab.content}
        </div>
      ))}
    </section>
  );
}
