import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TagPropertyDescriptor } from '../api/tags';
import { fetchTagModel } from '../api/tags';
import { newTagDoc, type OpenDoc } from '../workspace/documents';
import TagPropertyForm from './TagPropertyForm';

vi.mock('../api/tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/tags')>()),
  fetchTagModel: vi.fn(),
}));

const mockModel = vi.mocked(fetchTagModel);

function prop(name: string, type: string, category: string, extra: Partial<TagPropertyDescriptor> = {}): TagPropertyDescriptor {
  return { name, type, default: null, allowedValues: null, category, label: null, ...extra };
}

const MEMORY_MODEL: TagPropertyDescriptor[] = [
  prop('name', 'String', 'core'),
  prop('enabled', 'Boolean', 'core', { default: true }),
  prop('tagGroup', 'String', 'core', { default: 'Default', allowedValues: ['Default', 'Fast'] }),
  prop('valueSource', 'String', 'value', { default: 'memory', allowedValues: ['opc', 'memory', 'expr', 'db', 'reference', 'derived'] }),
  prop('dataType', 'DataType', 'value', { default: 'Int4', allowedValues: ['Int4', 'Float8', 'String', 'Boolean'] }),
  prop('value', 'QualifiedValue', 'value'),
  prop('engUnit', 'String', 'numeric', { default: '', allowedValues: ['kPa', 'degC'] }),
  prop('deadband', 'Double', 'numeric', { default: 0 }),
  prop('tooltip', 'String', 'meta', { default: '' }),
  prop('documentation', 'String', 'meta', { default: '' }),
  prop('readOnly', 'Boolean', 'security', { default: false }),
  prop('eventScripts', 'TagEventScripts', 'scripting'),
  prop('alarms', 'AlarmConfiguration', 'alarms'),
  prop('historyEnabled', 'Boolean', 'history', { default: false }),
  prop('alm_extp_res', 'String', 'other'),
];

const OPC_MODEL: TagPropertyDescriptor[] = [
  ...MEMORY_MODEL.filter((p) => p.name !== 'value'),
  prop('opcServer', 'String', 'value', { allowedValues: ['Ignition OPC UA Server'] }),
  prop('opcItemPath', 'String', 'value', { default: '' }),
];

function doc(local: object, inherited: Record<string, unknown> = {}, tagType = 'AtomicTag'): OpenDoc {
  return newTagDoc({
    path: '[default]Line/Motor',
    local: JSON.stringify(local),
    resolved: JSON.stringify({ ...inherited, ...local }),
    signature: 's1',
    tagType,
    inherited,
  });
}

/** Renders the form and re-renders with every text it reports, as the workspace does. */
function harness(start: OpenDoc, readOnly = false) {
  let current = start;
  const onChange = vi.fn((text: string) => {
    current = { ...current, text };
    view.rerender(<TagPropertyForm doc={current} onChange={onChange} readOnly={readOnly} csrfToken="t" />);
  });
  const view = render(<TagPropertyForm doc={current} onChange={onChange} readOnly={readOnly} csrfToken="t" />);
  return { onChange, last: () => JSON.parse(current.text) as Record<string, unknown>, lastText: () => current.text, view };
}

beforeEach(() => {
  mockModel.mockReset();
  mockModel.mockImplementation(async (_path, json) => (
    (JSON.parse(json) as { valueSource?: string }).valueSource === 'opc' ? OPC_MODEL : MEMORY_MODEL
  ));
});

describe('TagPropertyForm', () => {
  it('asks the model about the configuration and renders its sections in Designer order', async () => {
    harness(doc({ name: 'Motor', tagType: 'AtomicTag', valueSource: 'memory' }));
    await screen.findByRole('button', { name: /Basic/ });
    expect(mockModel).toHaveBeenCalledWith('[default]Line/Motor', expect.stringContaining('"valueSource":"memory"'), 't');
    const titles = screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent?.replace(/^[▾▸]/, ''));
    expect(titles).toEqual(['Basic', 'Value', 'Numeric', 'Metadata', 'Security', 'Scripting', 'Alarms', 'History']);
    expect(screen.getByLabelText('Value Source')).toHaveValue('memory');
    expect(screen.getByLabelText('Name')).toHaveAttribute('readonly');
    // Platform bookkeeping never shows.
    expect(screen.queryByText('alm_extp_res')).toBeNull();
  });

  it('collapses a section from its heading button', async () => {
    harness(doc({ name: 'Motor' }));
    const basic = await screen.findByRole('button', { name: /Basic/ });
    fireEvent.click(basic);
    expect(basic).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByLabelText('Enabled')).not.toBeVisible();
  });

  it('shows an override with a reset, and an inherited value dimmed without one', async () => {
    harness(doc({ name: 'M', tooltip: 'mine' }, { tooltip: 'theirs', documentation: 'from the UDT' }));
    const tooltip = await screen.findByLabelText('Tooltip');
    expect(tooltip).toHaveValue('mine');
    expect(tooltip.closest('.tag-form-row')).toHaveClass('is-overridden');
    expect(screen.getByRole('button', { name: 'Reset Tooltip to inherited/default' })).toBeTruthy();

    const docs = screen.getByLabelText('Documentation');
    expect(docs).toHaveValue('from the UDT');
    expect(docs.closest('.tag-form-row')).toHaveClass('is-inherited');
    expect(screen.queryByRole('button', { name: 'Reset Documentation to inherited/default' })).toBeNull();
    // Neither inherited nor local: the model default.
    expect(screen.getByLabelText('Enabled')).toBeChecked();
  });

  it('editing an inherited field adds the key at the end, keeping the others in place', async () => {
    const h = harness(doc({ name: 'M', tagType: 'AtomicTag', valueSource: 'memory' }));
    fireEvent.change(await screen.findByLabelText('Tooltip'), { target: { value: 'hello' } });
    expect(Object.keys(h.last())).toEqual(['name', 'tagType', 'valueSource', 'tooltip']);
    expect(h.last().tooltip).toBe('hello');
    expect(h.lastText()).toContain('\n  "tooltip": "hello"');
    expect(screen.getByRole('button', { name: 'Reset Tooltip to inherited/default' })).toBeTruthy();
  });

  it('reset removes the key from the local JSON', async () => {
    const h = harness(doc({ name: 'M', tooltip: 'mine', enabled: false }, { tooltip: 'theirs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset Tooltip to inherited/default' }));
    expect(h.last()).toEqual({ name: 'M', enabled: false });
    expect(screen.getByLabelText('Tooltip')).toHaveValue('theirs');
  });

  it('types widgets: checkbox, select, number, engineering units with suggestions, typed value', async () => {
    const h = harness(doc({ name: 'M', dataType: 'Float8', value: 1.5 }));
    expect(await screen.findByLabelText('Read Only')).toHaveAttribute('type', 'checkbox');
    expect(screen.getByLabelText('Data Type').tagName).toBe('SELECT');
    const units = screen.getByLabelText('Engineering Units');
    expect(units).toHaveAttribute('list');
    fireEvent.change(units, { target: { value: 'bar' } });
    expect(h.last().engUnit).toBe('bar');

    const deadband = screen.getByLabelText('Deadband');
    fireEvent.change(deadband, { target: { value: '1e' } });
    expect(deadband).toHaveAttribute('aria-invalid', 'true');
    expect(h.last().deadband).toBeUndefined();
    fireEvent.change(deadband, { target: { value: '0.5' } });
    expect(h.last().deadband).toBe(0.5);

    const value = screen.getByLabelText('Value', { selector: 'input' });
    fireEvent.change(value, { target: { value: 'abc' } });
    expect(h.last().value).toBe(1.5);
    fireEvent.change(value, { target: { value: '7.25' } });
    expect(h.last().value).toBe(7.25);
  });

  it('re-asks the model when the value source changes, and shows the new fields', async () => {
    const h = harness(doc({ name: 'M', valueSource: 'memory' }));
    fireEvent.change(await screen.findByLabelText('Value Source'), { target: { value: 'opc' } });
    expect(h.last().valueSource).toBe('opc');
    expect(await screen.findByLabelText('OPC Item Path')).toBeTruthy();
    expect(mockModel).toHaveBeenCalledTimes(2);
    expect(mockModel.mock.calls[1][1]).toContain('"valueSource":"opc"');
  });

  it('does not re-ask the model for an edit that cannot change what applies', async () => {
    harness(doc({ name: 'M', valueSource: 'memory' }));
    fireEvent.change(await screen.findByLabelText('Tooltip'), { target: { value: 'x' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(mockModel).toHaveBeenCalledTimes(1);
  });

  it('lists a stale local key the model no longer describes under Other, resettable', async () => {
    const h = harness(doc({ name: 'M', valueSource: 'memory', opcItemPath: 'ns=1;s=x' }));
    expect(await screen.findByRole('button', { name: /Other/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset OPC Item Path to inherited/default' }));
    expect(h.last()).toEqual({ name: 'M', valueSource: 'memory' });
  });

  it('adds, edits, duplicates and deletes alarms', async () => {
    const h = harness(doc({ name: 'M' }));
    await screen.findByRole('button', { name: /Alarms/ });
    fireEvent.click(screen.getByRole('button', { name: 'Add alarm' }));
    expect(h.last().alarms).toEqual([{ name: 'New Alarm', mode: 'AboveValue', setpointA: 0 }]);

    const editor = screen.getByRole('group', { name: 'Alarm New Alarm' });
    fireEvent.change(within(editor).getByLabelText('Setpoint'), { target: { value: '80' } });
    fireEvent.change(within(editor).getByLabelText('Priority'), { target: { value: 'High' } });
    expect(h.last().alarms).toEqual([{ name: 'New Alarm', mode: 'AboveValue', setpointA: 80, priority: 'High' }]);

    // Between shows the second setpoint; Bit shows only the bit fields.
    fireEvent.change(within(editor).getByLabelText('Mode'), { target: { value: 'BetweenValues' } });
    expect(within(screen.getByRole('group', { name: 'Alarm New Alarm' })).getByLabelText('High Setpoint')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'Bit' } });
    expect(screen.queryByLabelText('Setpoint')).toBeNull();
    expect(screen.getByLabelText('Bit Position')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    const alarms = h.last().alarms as { name: string }[];
    expect(alarms.map((a) => a.name)).toEqual(['New Alarm', 'New Alarm copy']);
    expect(screen.getByRole('button', { name: /New Alarm copy/ })).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect((h.last().alarms as { name: string }[]).map((a) => a.name)).toEqual(['New Alarm']);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(h.last().alarms).toEqual([]);
  });

  it('copies inherited alarms into the local JSON on the first edit, and Reset drops them', async () => {
    const inheritedAlarms = [{ name: 'Hi', mode: 'AboveValue', setpointA: 10 }];
    const h = harness(doc({ name: 'M' }, { alarms: inheritedAlarms }));
    expect(await screen.findByText('Above Setpoint · Low')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Setpoint'), { target: { value: '12' } });
    expect(h.last().alarms).toEqual([{ name: 'Hi', mode: 'AboveValue', setpointA: 12 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Alarms to inherited/default' }));
    expect(h.last()).toEqual({ name: 'M' });
  });

  it('edits, adds and removes event scripts', async () => {
    const h = harness(doc({ name: 'M', eventScripts: [{ eventid: 'valueChanged', script: '\tprint 1' }] }));
    await screen.findByText('Value Changed');
    const host = document.querySelector('.tag-form-code .cm-editor') as HTMLElement;
    const view = EditorView.findFromDOM(host);
    if (!view) throw new Error('no script editor');
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\tprint 2' } });
    expect(h.last().eventScripts).toEqual([{ eventid: 'valueChanged', script: '\tprint 1\n\tprint 2' }]);

    fireEvent.change(screen.getByLabelText('Add event script'), { target: { value: 'alarmActive' } });
    expect((h.last().eventScripts as { eventid: string }[]).map((s) => s.eventid)).toEqual(['valueChanged', 'alarmActive']);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Value Changed script' }));
    expect(h.last().eventScripts).toEqual([{ eventid: 'alarmActive', script: '\tpass' }]);
  });

  it('edits UDT parameters', async () => {
    mockModel.mockImplementation(async () => [prop('name', 'String', 'core'), prop('parameters', 'BoundPropertySet', 'parameters')]);
    const h = harness(doc({ name: 'T', tagType: 'UdtType', parameters: { P1: { dataType: 'String', value: 'abc' } } }, {}, 'UdtType'));
    fireEvent.change(await screen.findByLabelText('P1 value'), { target: { value: 'xyz' } });
    expect(h.last().parameters).toEqual({ P1: { dataType: 'String', value: 'xyz' } });
    fireEvent.change(screen.getByLabelText('New parameter'), { target: { value: 'Rate' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add parameter' }));
    expect(Object.keys(h.last().parameters as object)).toEqual(['P1', 'Rate']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove parameter P1' }));
    expect(h.last().parameters).toEqual({ Rate: { dataType: 'String', value: '' } });
  });

  it('points to the JSON tab when the buffer does not parse', () => {
    const broken = { ...doc({ name: 'M' }), text: '{"name": ' };
    render(<TagPropertyForm doc={broken} onChange={vi.fn()} readOnly={false} csrfToken="t" />);
    expect(screen.getByText(/JSON tab/)).toBeTruthy();
    expect(mockModel).not.toHaveBeenCalled();
  });

  it('falls back to the configuration’s own keys when the model cannot be read', async () => {
    mockModel.mockRejectedValue(new Error('403 Forbidden'));
    harness(doc({ name: 'M', tooltip: 'x', enabled: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('403 Forbidden');
    expect(screen.getByLabelText('Tooltip')).toHaveValue('x');
  });

  it('disables everything when read-only', async () => {
    harness(doc({ name: 'M', tooltip: 'x', alarms: [{ name: 'A', mode: 'Bit' }] }), true);
    await screen.findByLabelText('Tooltip');
    expect(screen.getByLabelText('Tooltip')).toBeDisabled();
    expect(within(screen.getByRole('region', { name: 'Basic' })).getByLabelText('Enabled')).toBeDisabled();
    expect(within(screen.getByRole('group', { name: 'Alarm A' })).getByLabelText('Bit Position')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add alarm' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset Tooltip to inherited/default' })).toBeDisabled();
    // Section headings stay usable, so a reader can still fold the form.
    expect(screen.getByRole('button', { name: /Basic/ })).toBeEnabled();
  });

  it('re-asks the model only after a pause when several triggers change together', async () => {
    const h = harness(doc({ name: 'M', valueSource: 'memory' }));
    await screen.findByLabelText('Value Source');
    fireEvent.change(screen.getByLabelText('Value Source'), { target: { value: 'expr' } });
    fireEvent.change(screen.getByLabelText('Value Source'), { target: { value: 'opc' } });
    await waitFor(() => expect(mockModel).toHaveBeenCalledTimes(2));
    expect(mockModel.mock.calls[1][1]).toContain('"valueSource":"opc"');
    expect(h.last().valueSource).toBe('opc');
  });
});
