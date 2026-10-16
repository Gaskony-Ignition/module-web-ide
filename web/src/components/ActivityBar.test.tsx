import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ActivityBar, { type ActivityBarProps } from './ActivityBar';

function renderBar(overrides: Partial<ActivityBarProps> = {}) {
  const props: ActivityBarProps = {
    active: 'scripts',
    expanded: true,
    onSelect: vi.fn(),
    activePanel: null,
    onSelectPanel: vi.fn(),
    activeTool: null,
    onSelectTool: vi.fn(),
    ...overrides,
  };
  render(<ActivityBar {...props} />);
  return props;
}

describe('ActivityBar lower group', () => {
  it('keeps the five buttons in their old order', () => {
    renderBar();
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.slice(-5)).toEqual(['Problems', 'Script Console', 'Query', 'Terminal', 'Tests']);
  });

  it('opens a tool tab for Script Console and Query, not the panel', () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Script Console' }));
    fireEvent.click(screen.getByRole('button', { name: 'Query' }));
    expect(props.onSelectTool).toHaveBeenNthCalledWith(1, 'console');
    expect(props.onSelectTool).toHaveBeenNthCalledWith(2, 'query');
    expect(props.onSelectPanel).not.toHaveBeenCalled();
  });

  it('still toggles the panel for Problems, Terminal and Tests', () => {
    const props = renderBar();
    for (const name of ['Problems', 'Terminal', 'Tests']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    expect(props.onSelectPanel).toHaveBeenCalledTimes(3);
    expect(props.onSelectTool).not.toHaveBeenCalled();
  });

  it('shows a tool as pressed only while its tab is the active one', () => {
    renderBar({ activeTool: 'query', activePanel: 'terminal' });
    expect(screen.getByRole('button', { name: 'Query' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Script Console' })).toHaveAttribute('aria-pressed', 'false');
    // A panel open beneath an active tool tab is still shown as open.
    expect(screen.getByRole('button', { name: 'Terminal' })).toHaveAttribute('aria-pressed', 'true');
  });
});
