import { fireEvent, render, screen } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/tags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/tags')>()),
  fetchTagModel: vi.fn(async () => [
    { name: 'name', type: 'String', default: '', allowedValues: null, category: 'core', label: null },
  ]),
}));

import { isDirty, newTagDoc, type OpenDoc } from '../workspace/documents';
import TagEditor, { jsonProblem, type TagEditorProps } from './TagEditor';

function tagDoc(): OpenDoc {
  return newTagDoc({
    path: '[default]Line/Motor',
    local: '{"name":"Motor","valueSource":"memory"}',
    resolved: '{"name":"Motor","valueSource":"memory","enabled":true}',
    signature: 's1',
    tagType: 'AtomicTag',
  });
}

function props(overrides: Partial<TagEditorProps> = {}): TagEditorProps {
  const doc = overrides.doc ?? tagDoc();
  return {
    doc,
    onChange: vi.fn(),
    onSave: vi.fn(),
    onReload: vi.fn(),
    saving: false,
    dirty: isDirty(doc),
    readOnly: false,
    csrfToken: 't',
    ...overrides,
  };
}

function editorView(container: HTMLElement): EditorView {
  const dom = container.querySelector('.cm-editor') as HTMLElement;
  const view = EditorView.findFromDOM(dom);
  if (!view) throw new Error('no CodeMirror view');
  return view;
}

describe('TagEditor', () => {
  it('opens on the Properties tab by default', async () => {
    render(<TagEditor {...props()} />);
    expect(screen.getByRole('tab', { name: 'Properties' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('button', { name: /Basic/ })).toBeVisible();
  });

  it('opens on the JSON tab when asked, with the path, type and buffer', () => {
    const { container } = render(<TagEditor {...props({ initialTab: 'json' })} />);
    expect(screen.getByText('[default]Line/Motor')).toBeTruthy();
    expect(screen.getByText('Tag')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');
    expect(editorView(container).state.doc.toString()).toContain('"valueSource": "memory"');
    expect(screen.queryByLabelText('Unsaved changes')).toBeNull();
    expect(screen.getByRole('button', { name: 'Save tag' })).toBeDisabled();
  });

  it('reports every edit, and a dirty document shows its marker and enables Save', () => {
    const p = props();
    const { container, rerender } = render(<TagEditor {...p} />);
    const view = editorView(container);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{"name":"Motor2"}' } });
    expect(p.onChange).toHaveBeenLastCalledWith('{"name":"Motor2"}');

    const edited = { ...p.doc, text: '{"name":"Motor2"}' };
    rerender(<TagEditor {...p} doc={edited} dirty={isDirty(edited)} />);
    expect(screen.getByLabelText('Unsaved changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save tag' })).toBeEnabled();
  });

  it('saves on Ctrl+S from inside the buffer', () => {
    const doc = { ...tagDoc(), text: '{"name":"Motor2"}' };
    const p = props({ doc, dirty: true });
    const { container } = render(<TagEditor {...p} />);
    const content = container.querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(content, { key: 's', ctrlKey: true });
    expect(p.onSave).toHaveBeenCalledTimes(1);
  });

  it('shows why invalid JSON cannot be saved, and refuses Ctrl+S', () => {
    const doc = { ...tagDoc(), text: '{"name": ' };
    const p = props({ doc, dirty: true });
    const { container } = render(<TagEditor {...p} />);
    expect(screen.getByRole('alert')).toHaveTextContent('does not parse');
    expect(screen.getByRole('button', { name: 'Save tag' })).toBeDisabled();
    fireEvent.keyDown(container.querySelector('.cm-content') as HTMLElement, { key: 's', ctrlKey: true });
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('takes a reloaded text into the open buffer without rebuilding it', () => {
    const p = props();
    const { container, rerender } = render(<TagEditor {...p} />);
    const view = editorView(container);
    rerender(<TagEditor {...p} doc={{ ...p.doc, text: '{"name":"Theirs"}', baseText: '{"name":"Theirs"}' }} />);
    expect(editorView(container)).toBe(view);
    expect(view.state.doc.toString()).toBe('{"name":"Theirs"}');
  });

  it('says it is read-only and will not save', () => {
    const doc = { ...tagDoc(), text: '{"name":"Motor2"}' };
    render(<TagEditor {...props({ doc, dirty: true, readOnly: true })} />);
    expect(screen.getByText(/Read-only/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save tag' })).toBeDisabled();
  });

  it('switches between the tabs', () => {
    render(<TagEditor {...props()} />);
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));
    expect(screen.getByRole('tab', { name: 'JSON' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(screen.getByRole('tab', { name: 'Properties' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('jsonProblem', () => {
  it('accepts one object and nothing else', () => {
    expect(jsonProblem('{"a":1}')).toBeNull();
    expect(jsonProblem('[1]')).toMatch(/one JSON object/);
    expect(jsonProblem('{')).not.toBeNull();
  });
});
