/**
 * The right-click menu: closing it, and not offering what it cannot do.
 *
 * The positioning is geometry and is measured on the rig by
 * `validate_v27_transfer.py`; what is asserted here is the behaviour a headless
 * DOM can actually answer.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';

function open(items: ContextMenuItem[] = [{ label: 'Export…', onSelect: vi.fn() }]) {
  const onClose = vi.fn();
  render(
    <ContextMenu x={10} y={20} heading="util.helpers" items={items} onClose={onClose} />
  );
  return { onClose, items };
}

describe('ContextMenu', () => {
  it('names what it is about, so a mis-aimed right-click is obvious', () => {
    open();
    expect(screen.getByText('util.helpers')).toBeInTheDocument();
  });

  it('runs the item and closes, in that order', () => {
    const onSelect = vi.fn();
    const { onClose } = open([{ label: 'Export…', onSelect }]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    expect(onSelect).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on a pointer press OUTSIDE it', () => {
    // pointerdown, not click: a menu that closes on click-up stays open under
    // the pointer for the whole press, which reads as having ignored you.
    const { onClose } = open();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open on a press inside it', () => {
    const { onClose } = open();
    fireEvent.pointerDown(screen.getByRole('menu'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders a disabled item with the reason, rather than hiding it', () => {
    // Hiding it teaches nothing; a greyed item with a title says what is
    // missing — which for import is the Administrator role.
    const onSelect = vi.fn();
    open([{ label: 'Import…', onSelect, enabled: false, title: 'needs Administrator' }]);
    const item = screen.getByRole('menuitem', { name: 'Import…' });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'needs Administrator');
    fireEvent.click(item);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
