import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import LayoutControls from './LayoutControls';

const layout = { sideBar: true, panel: false, secondary: false };

describe('LayoutControls secondary side bar', () => {
  it('is pressable and labelled plainly when the outline can show', () => {
    const onToggle = vi.fn();
    render(
      <LayoutControls layout={{ ...layout, secondary: true }} onToggle={onToggle} onReset={vi.fn()} />,
    );
    const button = screen.getByRole('button', { name: 'Toggle secondary side bar' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledWith('secondary');
  });

  it('shows not pressed, disabled and says why when the outline cannot show', () => {
    const onToggle = vi.fn();
    render(
      <LayoutControls
        layout={layout}
        onToggle={onToggle}
        onReset={vi.fn()}
        secondaryUnavailable="the outline only shows for scripts"
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Toggle secondary side bar (unavailable: the outline only shows for scripts)',
    });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toHaveAttribute('title');
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('puts the reason in the layout menu as text and ignores its click', () => {
    const onToggle = vi.fn();
    render(
      <LayoutControls
        layout={layout}
        onToggle={onToggle}
        onReset={vi.fn()}
        secondaryUnavailable="the outline only shows for scripts"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Customise layout' }));
    const item = screen.getByRole('menuitemcheckbox', { name: /Secondary side bar/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('unavailable: the outline only shows for scripts');
    fireEvent.click(item);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
