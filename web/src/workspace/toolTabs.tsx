/**
 * Keeping a tool tab's component alive while its tab is not on screen.
 *
 * The Script Console holds REPL locals, its buffer and its run history in the
 * component; the Query Browser holds its SQL, its results and any run in
 * flight. Unmounting either to switch to a script tab would throw a working
 * session away — the bottom panel kept them mounted and hidden for exactly
 * this reason (see Panel.tsx).
 *
 * As tabs they can also MOVE, between the two editor panes, and React has no
 * way to re-parent a mounted component: rendering it under the other pane is
 * an unmount and a fresh mount. So the tool renders, through a portal, into
 * one DOM element that is created once and never changes; the pane that shows
 * the tab hands that element a place to sit (`ToolSlot`), and moving the tab
 * moves the element, not the component. Nothing remounts — not on a tab
 * switch, not on a pane move.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { IconExternal } from '../components/Icons';

/**
 * The element a tool renders into, made once per workspace.
 *
 * Ctrl+S is swallowed here: a tool tab has nothing to save, and left alone
 * the browser offers to save the whole page.
 */
export function useToolElement(): HTMLDivElement {
  return useMemo(() => {
    const element = document.createElement('div');
    element.className = 'tool-tab-body';
    element.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
      }
    });
    return element;
  }, []);
}

/**
 * Where a pane shows a tool: adopts the tool's element while mounted.
 *
 * Layout effect, so the element is in place before the browser paints — a
 * passive effect would flash an empty pane for a frame on every tab switch.
 * On unmount the element is detached rather than destroyed; the portal keeps
 * rendering into it, so the tool's state is untouched until it is shown again.
 */
export function ToolSlot({ element }: { element: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return undefined;
    host.appendChild(element);
    return () => {
      if (element.parentNode === host) host.removeChild(element);
    };
  }, [element]);
  return <div ref={ref} className="tool-tab-slot" />;
}

/**
 * "Open in a new browser tab" for the tool on screen, in its pane's tab strip.
 *
 * Visible text as well as a name: an icon-only control there would be the
 * tooltip-only affordance the split button was already rewritten to avoid.
 */
export function ToolPopOutButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="tab-strip-popout"
      aria-label={`Open the ${label} in a new browser tab`}
      onClick={onClick}
    >
      <IconExternal size={14} />
      <span className="tab-strip-popout-text">New browser tab</span>
    </button>
  );
}
