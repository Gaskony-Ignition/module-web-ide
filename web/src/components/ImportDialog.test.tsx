/**
 * The import dialog: the two things the Designer's own does not say.
 *
 * Which resources will be REPLACED, and which will not be written at all. Both
 * are the reason this dialog exists rather than a straight "import everything"
 * button, so both are asserted here rather than left to the live suite.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ImportDialog, { displayName } from './ImportDialog';
import type { ImportInspection } from '../api/transfer';

function inspection(overrides: Partial<ImportInspection> = {}): ImportInspection {
  return {
    project: 'Demo',
    source: { title: 'ACME Mining Demo 1.7.0' },
    entries: [
      { path: 'ignition/script-python/util/helpers', importable: true, exists: true,
        files: ['code.py'], bytes: 120 },
      { path: 'ignition/script-python/util/fresh', importable: true, exists: false,
        files: ['code.py'], bytes: 80 },
      { path: 'com.inductiveautomation.perspective/views/Home', importable: false,
        exists: false, files: ['view.json'], bytes: 900 },
    ],
    ...overrides,
  };
}

function open(props: Partial<React.ComponentProps<typeof ImportDialog>> = {}) {
  const onImport = vi.fn();
  const onClose = vi.fn();
  render(
    <ImportDialog
      project="Demo"
      fileName="Mining_Demo_2026-09-07_0330.zip"
      inspection={inspection()}
      onImport={onImport}
      onClose={onClose}
      {...props}
    />
  );
  return { onImport, onClose };
}

describe('displayName', () => {
  it('reads a library path as the module name people import by', () => {
    expect(displayName('ignition/script-python/util/helpers')).toBe('util.helpers');
  });

  it('falls back to the last segment for anything else', () => {
    expect(displayName('ignition/script-timer/PlantSim')).toBe('PlantSim');
    expect(displayName('bare')).toBe('bare');
  });
});

describe('ImportDialog', () => {
  it('ticks every importable resource and none of the others', () => {
    const { onImport } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Import 2' }));
    expect(onImport).toHaveBeenCalledWith([
      'ignition/script-python/util/helpers',
      'ignition/script-python/util/fresh',
    ]);
  });

  it('says which ones it will REPLACE, which the Designer never does', () => {
    open();
    expect(screen.getByText('replaces')).toBeInTheDocument();
    expect(screen.getByText('new')).toBeInTheDocument();
    expect(screen.getByRole('status'))
      .toHaveTextContent('1 of these already exist in Demo and will be replaced');
  });

  it('drops the warning when the replacing ones are unticked', () => {
    open();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Import 1' })).toBeInTheDocument();
  });

  it('lists what it will NOT import, rather than silently dropping it', () => {
    // A script editor that quietly discarded the views out of a Designer export
    // would look like it had lost them.
    open();
    expect(screen.getByText(/1 other resource in this file will not be imported/))
      .toBeInTheDocument();
    expect(screen.getByText('com.inductiveautomation.perspective/views/Home'))
      .toBeInTheDocument();
    // And it is not selectable: two checkboxes for three entries.
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('cannot import nothing', () => {
    open();
    screen.getAllByRole('checkbox').forEach((box) => fireEvent.click(box));
    expect(screen.getByRole('button', { name: 'Import 0' })).toBeDisabled();
  });

  it('says so when the file holds nothing this tool can write', () => {
    open({
      inspection: inspection({
        entries: [{ path: 'com.inductiveautomation.perspective/views/Home',
          importable: false, exists: false, files: ['view.json'], bytes: 1 }],
      }),
    });
    expect(screen.getByText('Nothing in this file can be imported here.'))
      .toBeInTheDocument();
  });

  it('reports every path once the write has happened, including the ones that did not', () => {
    // An import that writes eight of ten and says "done" is how somebody finds
    // the other two a week later.
    open({
      outcome: {
        ok: true,
        written: 1,
        results: [
          { path: 'ignition/script-python/util/helpers', status: 'replaced' },
          { path: 'ignition/script-python/util/fresh', status: 'failed',
            detail: 'project is not mutable' },
        ],
      },
    });
    expect(screen.getByText('1 written, 1 failed.')).toBeInTheDocument();
    expect(screen.getByText('replaced')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('project is not mutable')).toBeInTheDocument();
    // The choice is over; there is nothing left to import.
    expect(screen.queryByRole('button', { name: /^Import/ })).toBeNull();
  });
});
