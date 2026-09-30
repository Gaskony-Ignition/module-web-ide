/**
 * A draggable divider between two panes.
 *
 * Pointer events rather than mouse events, so a trackpad, a pen and a touch
 * screen all work from one code path, with pointer capture so a fast drag that
 * leaves the 4px hit area does not drop the gesture — which is the usual reason
 * a hand-rolled splitter feels broken.
 *
 * It is also a `separator` with arrow-key support. A resizable panel that can
 * only be sized with a mouse is not resizable for everyone, and the keyboard
 * path costs six lines.
 */
import { useCallback, useRef } from 'react';
import './Resizer.css';

export interface ResizerProps {
  /** Current width in px, for the accessible value and keyboard steps. */
  value: number;
  min: number;
  max: number;
  /**
   * Which side of this divider the pane being sized is on.
   *
   * All four name THE PANE, never the divider or the drag: `left` and `above`
   * grow with the pointer, `right` and `below` shrink with it. `above`/`below`
   * make the divider horizontal.
   *
   * Renamed at 1.19.0. It used to be `left | right | top`, where `left` and
   * `right` named the pane but `top` named the divider's own edge — the bottom
   * dock is sized from the edge above it. Two conventions in one union is how a
   * second horizontal divider gets the sign backwards, which is exactly what
   * the console needed.
   */
  side: 'left' | 'right' | 'above' | 'below';
  label: string;
  onChange: (width: number) => void;
}

const KEY_STEP = 16;

export default function Resizer({ value, min, max, side, label, onChange }: ResizerProps) {
  const startRef = useRef({ x: 0, width: 0 });
  const vertical = side === 'above' || side === 'below';
  /** True when dragging towards larger x/y GROWS the pane. */
  const growsWithPointer = side === 'left' || side === 'above';

  const clamp = useCallback(
    (width: number) => Math.min(max, Math.max(min, width)),
    [max, min]
  );

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    // Ignore anything but the primary button; a right-click drag would
    // otherwise start a resize the user cannot see they began.
    if (event.button !== 0) return;
    startRef.current = {
      x: vertical ? event.clientY : event.clientX,
      width: value,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const delta = (vertical ? event.clientY : event.clientX) - startRef.current.x;
    // Dragging right grows a left-hand pane and shrinks a right-hand one, and
    // dragging down does the same for a pane above and a pane below.
    const next = growsWithPointer
      ? startRef.current.width + delta
      : startRef.current.width - delta;
    onChange(clamp(next));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const [grow, shrink] = vertical
      ? (growsWithPointer ? ['ArrowDown', 'ArrowUp'] : ['ArrowUp', 'ArrowDown'])
      : (growsWithPointer ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight']);
    if (event.key === grow) {
      event.preventDefault();
      onChange(clamp(value + KEY_STEP));
    } else if (event.key === shrink) {
      event.preventDefault();
      onChange(clamp(value - KEY_STEP));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(min);
    } else if (event.key === 'End') {
      event.preventDefault();
      onChange(max);
    }
  }

  return (
    <div
      className={vertical ? 'resizer resizer-horizontal' : 'resizer'}
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
    />
  );
}
