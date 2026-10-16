import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToolPopOutButton, ToolSlot, useToolElement } from './toolTabs';

/** Stands in for the console: its state lives in the component. */
function Counter() {
  const [count, setCount] = useState(0);
  return <button type="button" onClick={() => setCount((n) => n + 1)}>count {count}</button>;
}

/**
 * Two panes and a tab bar, the shape Workspace gives a tool: the tool is
 * portalled once into its element, and at most one pane shows a slot.
 */
function Harness() {
  const element = useToolElement();
  const [shownIn, setShownIn] = useState<'left' | 'right' | 'none'>('left');
  return (
    <>
      <button type="button" onClick={() => setShownIn('left')}>left</button>
      <button type="button" onClick={() => setShownIn('right')}>right</button>
      <button type="button" onClick={() => setShownIn('none')}>script tab</button>
      <div data-testid="left">{shownIn === 'left' && <ToolSlot element={element} />}</div>
      <div data-testid="right">{shownIn === 'right' && <ToolSlot element={element} />}</div>
      {createPortal(<Counter />, element)}
    </>
  );
}

describe('tool tabs keep their component mounted', () => {
  it('survives a switch to another tab and back', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('count 0'));
    fireEvent.click(screen.getByText('count 1'));
    fireEvent.click(screen.getByText('script tab'));
    // Off screen, not gone: the element is detached and the state is held.
    expect(screen.queryByText('count 2')).toBeNull();
    fireEvent.click(screen.getByText('left'));
    expect(screen.getByText('count 2')).toBeInTheDocument();
  });

  it('survives a move to the other pane, without a remount', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('count 0'));
    fireEvent.click(screen.getByText('right'));
    expect(screen.getByTestId('right')).toHaveTextContent('count 1');
    expect(screen.getByTestId('left')).not.toHaveTextContent('count');
    fireEvent.click(screen.getByText('count 1'));
    fireEvent.click(screen.getByText('left'));
    expect(screen.getByTestId('left')).toHaveTextContent('count 2');
  });

  it('swallows Ctrl+S inside the tool so the browser does not save the page', () => {
    render(<Harness />);
    const target = screen.getByText('count 0');
    const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const plain = new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true });
    target.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });
});

describe('ToolPopOutButton', () => {
  it('is a labelled button with visible text, not a tooltip-only icon', () => {
    const onClick = vi.fn();
    render(<ToolPopOutButton label="console" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Open the console in a new browser tab' });
    expect(button).toHaveTextContent('New browser tab');
    expect(button).not.toHaveAttribute('title');
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
