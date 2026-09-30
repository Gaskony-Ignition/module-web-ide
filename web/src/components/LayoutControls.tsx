/**
 * The four layout glyphs at the right of the title bar.
 *
 * VS Code's own set, in its order: a customise-layout menu, then one toggle each
 * for the primary side bar (left), the panel (bottom) and the secondary side bar
 * (right). Copied rather than invented because anyone who has used VS Code
 * already knows what the filled edge on each glyph means, and a bespoke set of
 * three toggles would have to be learned.
 *
 * `aria-pressed` carries the state as well as the fill does — the glyphs differ
 * only in which edge is shaded, which is not something a screen reader can see.
 */
import { useEffect, useRef, useState } from 'react';
import {
  IconCheck,
  IconLayout,
  IconPanelBottom,
  IconSideBarLeft,
  IconSideBarRight,
} from './Icons';
import './LayoutControls.css';

export interface LayoutState {
  sideBar: boolean;
  panel: boolean;
  secondary: boolean;
}

export interface LayoutControlsProps {
  layout: LayoutState;
  onToggle: (region: keyof LayoutState) => void;
  onReset: () => void;
}

const REGIONS: { key: keyof LayoutState; label: string }[] = [
  { key: 'sideBar', label: 'Primary side bar' },
  { key: 'panel', label: 'Panel' },
  { key: 'secondary', label: 'Secondary side bar' },
];

export default function LayoutControls({ layout, onToggle, onReset }: LayoutControlsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on an outside click or Escape. Both, not one: a menu that only
  // closes on Escape strands mouse users, and one that only closes on click
  // strands keyboard users.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <div className="layout-controls" ref={wrapRef}>
      <button
        type="button"
        className="layout-button"
        aria-label="Customise layout"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Customise layout"
        onClick={() => setMenuOpen((open) => !open)}
      >
        <IconLayout size={16} />
      </button>

      <button
        type="button"
        className="layout-button"
        aria-pressed={layout.sideBar}
        aria-label="Toggle primary side bar"
        title="Toggle primary side bar"
        onClick={() => onToggle('sideBar')}
      >
        <IconSideBarLeft size={16} />
      </button>
      <button
        type="button"
        className="layout-button"
        aria-pressed={layout.panel}
        aria-label="Toggle panel"
        title="Toggle panel"
        onClick={() => onToggle('panel')}
      >
        <IconPanelBottom size={16} />
      </button>
      <button
        type="button"
        className="layout-button"
        aria-pressed={layout.secondary}
        aria-label="Toggle secondary side bar"
        title="Toggle secondary side bar"
        onClick={() => onToggle('secondary')}
      >
        <IconSideBarRight size={16} />
      </button>

      {menuOpen && (
        <div className="layout-menu" role="menu">
          <p className="layout-menu-title chrome-heading">Visible areas</p>
          {REGIONS.map((region) => (
            <button
              key={region.key}
              type="button"
              role="menuitemcheckbox"
              aria-checked={layout[region.key]}
              className="layout-menu-item"
              onClick={() => onToggle(region.key)}
            >
              <span className="layout-menu-tick">
                {layout[region.key] && <IconCheck size={13} />}
              </span>
              {region.label}
            </button>
          ))}
          <div className="layout-menu-rule" />
          <button
            type="button"
            role="menuitem"
            className="layout-menu-item"
            onClick={() => {
              onReset();
              setMenuOpen(false);
            }}
          >
            <span className="layout-menu-tick" />
            Reset layout
          </button>
        </div>
      )}
    </div>
  );
}
