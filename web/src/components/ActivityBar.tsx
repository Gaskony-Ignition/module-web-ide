/**
 * The far-left activity bar, VS Code style.
 *
 * Its job is to make the side bar COLLAPSIBLE without hiding navigation:
 * clicking the active view collapses it to just this strip, and clicking any
 * view reopens it on that view. A toolbar above the tree could not do that — it
 * would disappear along with the thing it controls.
 *
 * It is also where a new top-level area is added, which is why Web Dev is a view
 * here rather than another section inside the script tree: named queries ARE the
 * third, since 1.7.0, and three unrelated resource trees stacked in one
 * scrolling column stops being navigable.
 *
 * The lower group is different in kind and is separated by the gap between them:
 * those two open the bottom PANEL rather than the side bar. Script Console used
 * to be a row in the script tree, where it read as a script among scripts;
 * Nigel asked for it out of the tree once it had an icon of its own.
 *
 * Search arrived in 1.6.0 and the view behind it is real: it searches every
 * Project Library script on the gateway through `scriptide/searchText`, and it
 * is where a references lookup puts its results. Until then this file said there
 * was deliberately no Search icon, because an icon that reopened the script tree
 * under a different heading is a promise of a view that does not exist — which
 * is still the rule, now met rather than avoided. Find and replace within the
 * open buffer stay where they were, on Ctrl+F and Ctrl+H in the editor.
 */
import type { ReactNode } from 'react';
import {
  IconAlert, IconDatabase, IconFiles, IconFlask, IconGlobe, IconPlay, IconSearch,
  IconTerminal,
} from './Icons';
import './ActivityBar.css';

/** Side-bar views. */
export type ViewId = 'scripts' | 'search' | 'webdev' | 'named-queries';

/** Bottom-panel views. */
export type PanelId = 'console' | 'query' | 'problems' | 'terminal' | 'tests';

export interface ActivityBarProps {
  /** The side-bar view, whether or not the side bar is showing. */
  active: ViewId;
  /** False when the side bar is collapsed to the strip. */
  expanded: boolean;
  onSelect: (view: ViewId) => void;
  /** The panel tab, or null when the panel is closed. */
  activePanel: PanelId | null;
  onSelectPanel: (panel: PanelId) => void;
}

const VIEWS: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
  { id: 'scripts', label: 'Scripting', icon: <IconFiles size={22} /> },
  { id: 'search', label: 'Search', icon: <IconSearch size={20} /> },
  { id: 'webdev', label: 'Web Dev', icon: <IconGlobe size={22} /> },
  { id: 'named-queries', label: 'Named Queries', icon: <IconDatabase size={20} /> },
];

const PANELS: Array<{ id: PanelId; label: string; icon: ReactNode }> = [
  { id: 'problems', label: 'Problems', icon: <IconAlert size={19} /> },
  { id: 'console', label: 'Script Console', icon: <IconPlay size={18} /> },
  // Next to the console: the same "run something on the gateway" kind of
  // panel, just SQL instead of Jython. Reuses IconDatabase from the side-bar
  // view list above — a different UI context, so reusing it here is not the
  // shared-CSS-class trap; two icon lists showing the same glyph is fine.
  { id: 'query', label: 'Query', icon: <IconDatabase size={19} /> },
  { id: 'terminal', label: 'Terminal', icon: <IconTerminal size={22} /> },
  // Next to the console rather than in the side bar: a test result is OUTPUT,
  // read after asking for something, with the editor still on screen.
  { id: 'tests', label: 'Tests', icon: <IconFlask size={20} /> },
];

export default function ActivityBar({
  active, expanded, onSelect, activePanel, onSelectPanel,
}: ActivityBarProps) {
  return (
    <nav className="activity-bar" aria-label="Views">
      {VIEWS.map((view) => {
        const isActive = view.id === active && expanded;
        return (
          <button
            key={view.id}
            type="button"
            className={`activity-item${isActive ? ' is-active' : ''}`}
            // aria-pressed rather than aria-current: this is a toggle, and the
            // active view can be pressed again to collapse the side bar.
            aria-pressed={isActive}
            // The label is the only name this control has — there is no visible
            // text — so it carries both the accessible name and the tooltip.
            aria-label={view.label}
            title={view.label}
            onClick={() => onSelect(view.id)}
          >
            {view.icon}
          </button>
        );
      })}

      <span className="activity-spacer" />

      {PANELS.map((panel) => {
        const isActive = panel.id === activePanel;
        return (
          <button
            key={panel.id}
            type="button"
            className={`activity-item${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            aria-label={panel.label}
            title={panel.label}
            onClick={() => onSelectPanel(panel.id)}
          >
            {panel.icon}
          </button>
        );
      })}
    </nav>
  );
}
