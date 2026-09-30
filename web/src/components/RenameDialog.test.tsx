import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ScriptEntry } from '../api/scripts';
import RenameDialog, { leafOf } from './RenameDialog';

function entry(overrides: Partial<ScriptEntry> = {}): ScriptEntry {
  return {
    path: 'ignition/script-python/util/helpers',
    name: 'helpers',
    typeId: 'script-python',
    typeLabel: 'Project Library',
    scriptKey: 'code.py',
    origin: 'local',
    owner: 'P',
    signature: 'sig-1',
    singleton: false,
    ...overrides,
  } as ScriptEntry;
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof RenameDialog>> = {}) {
  const props = {
    entry: entry(),
    moduleName: 'util.helpers',
    onCancel: vi.fn(),
    onRename: vi.fn(),
    ...overrides,
  };
  render(<RenameDialog {...props} />);
  return props;
}

describe('RenameDialog', () => {
  it('starts on the current name, and will not rename to it', () => {
    renderDialog();
    expect(screen.getByLabelText(/New name/i)).toHaveValue('helpers');
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
    expect(screen.getByText('That is the current name.')).toBeInTheDocument();
  });

  it('shows what the import becomes, so the consequence is visible before the click', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/New name/i), { target: { value: 'tools' } });
    expect(screen.getByText('util.tools')).toBeInTheDocument();
  });

  it('refuses a name the create path would refuse', () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/New name/i), { target: { value: 'not valid!' } });
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });

  it('renames, and passes on whether to update call sites', () => {
    const props = renderDialog();
    fireEvent.change(screen.getByLabelText(/New name/i), { target: { value: 'tools' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(props.onRename).toHaveBeenCalledWith('tools', true);
  });

  it('the call-site update can be declined', () => {
    const props = renderDialog();
    fireEvent.change(screen.getByLabelText(/New name/i), { target: { value: 'tools' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(props.onRename).toHaveBeenCalledWith('tools', false);
  });

  it('offers no call-site update for a script nothing imports by name', () => {
    // A timer script has a resource path and no importable name, so there is
    // nothing at a call site to rewrite.
    renderDialog({
      moduleName: undefined,
      entry: entry({ path: 'ignition/timer/Hourly', name: 'Hourly' }),
    });
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    // The note appears once there is a valid new name — before that the field's
    // own problem ("that is the current name") is the more useful thing to say.
    fireEvent.change(screen.getByLabelText(/New name/i), { target: { value: 'Nightly' } });
    expect(screen.getByText(/not imported by name/)).toBeInTheDocument();
  });

  it('says plainly that a folder has to be moved a script at a time', () => {
    renderDialog();
    expect(screen.getByText(/folder has to be moved a script at a time/)).toBeInTheDocument();
  });

  it('leafOf takes the last segment', () => {
    expect(leafOf('ignition/script-python/util/helpers')).toBe('helpers');
    expect(leafOf('ignition/startup')).toBe('startup');
  });
});
