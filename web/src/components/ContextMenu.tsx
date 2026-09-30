/**
 * A right-click menu, positioned at the pointer.
 *
 * Added at 1.20.0 for export/import, which the Designer puts on the Project
 * Browser's context menu and which this tree had nowhere to go — every action
 * here until now was a hover button on the row, and a hover button that appears
 * only for a package would have been a fourth thing competing for the same
 * eighteen pixels.
 *
 * Rendered by the OWNER, not by each row: one menu exists at a time, it knows
 * where the pointer was, and closing it is one piece of state rather than one
 * per row. That is also what makes Escape and click-away work without every row
 * subscribing to a document listener.
 */
import { useEffect, useRef } from 'react';
import './ContextMenu.css';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** Absent or false renders the item greyed and unclickable, with `title` saying why. */
  enabled?: boolean;
  title?: string;
}

export interface ContextMenuProps {
  x: number;
  y: number;
  /** What the menu is about, shown as a heading so a mis-aimed right-click is obvious. */
  heading?: string;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, heading, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Escape and any click outside. `pointerdown` rather than `click`: a menu that
  // closes on click-up stays open under the pointer for the whole press, and on
  // a slow click that reads as the menu having ignored you.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    function onPointer(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose]);

  // Keep it on screen. A menu opened near the right or bottom edge would
  // otherwise extend past it, and the last item — which is usually the
  // destructive one — is the part that goes missing.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const overflowX = box.right - window.innerWidth + 4;
    const overflowY = box.bottom - window.innerHeight + 4;
    if (overflowX > 0) node.style.left = `${Math.max(4, x - overflowX)}px`;
    if (overflowY > 0) node.style.top = `${Math.max(4, y - overflowY)}px`;
  }, [x, y]);

  return (
    <div
      className="context-menu"
      role="menu"
      ref={ref}
      style={{ left: x, top: y }}
      // The menu is not itself a right-click target: a second right-click
      // inside it should not open the browser's own menu on top of ours.
      onContextMenu={(event) => event.preventDefault()}
    >
      {heading && <div className="context-menu-heading">{heading}</div>}
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="context-menu-item"
          disabled={item.enabled === false}
          title={item.title}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
