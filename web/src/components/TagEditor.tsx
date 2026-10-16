/**
 * The editor area for one tag: a header (path, type, Save), and two tabs —
 * Properties and JSON.
 *
 * The buffer is the tag's OWN configuration (its local overrides) as JSON,
 * which is exactly what the save route writes back, so `doc.text` is the single
 * source of truth and dirtiness falls out of `isDirty` like any other document.
 * The Properties tab (the default, as in the Designer) is a second view onto
 * that same text; see `TagPropertyForm`.
 *
 * Its own CodeMirror rather than `CodeEditor`: that component attaches the
 * Jython language server to every document it is handed, and a tag's JSON
 * there would be parsed as Python. Ctrl+S is handled on this component's root
 * for the same reason — the shared editor's keybinding never sees it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands';
import type { OpenDoc } from '../workspace/documents';
import { tagTypeLabel } from '../workspace/documents';
import { editorTheme, escapeFocusOut, findAndReplace, folding, jsonSurface } from './editorCore';
import TagPropertyForm from './TagPropertyForm';
import './TagEditor.css';

export type TagEditorTab = 'properties' | 'json';

export interface TagEditorProps {
  /** A `kind: 'tag'` document. */
  doc: OpenDoc;
  /** The buffer's new text — every edit, from either tab, comes through here. */
  onChange: (text: string) => void;
  onSave: () => void;
  /** Re-read the gateway's copy (raises the conflict dialog over unsaved edits). */
  onReload: () => void;
  saving: boolean;
  dirty: boolean;
  readOnly: boolean;
  csrfToken: string | undefined;
  /** Which tab opens first. Properties unless told otherwise. */
  initialTab?: TagEditorTab;
}

/** Why the buffer will not parse, or null when it does. */
export function jsonProblem(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'A tag configuration is one JSON object';
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export default function TagEditor({
  doc, onChange, onSave, onReload, saving, dirty, readOnly, csrfToken, initialTab = 'properties',
}: TagEditorProps) {
  const [tab, setTab] = useState<TagEditorTab>(initialTab);
  const problem = useMemo(() => jsonProblem(doc.text), [doc.text]);
  const tagType = doc.tag?.tagType ?? '';

  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const canSave = !readOnly && dirty && !saving && problem === null;
  const canSaveRef = useRef(canSave);
  canSaveRef.current = canSave;

  return (
    <section
      className="tag-doc"
      aria-label={`Tag ${doc.path}`}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
          // Always swallowed, even when there is nothing to save: the browser's
          // own Save Page dialog is never what Ctrl+S means here.
          event.preventDefault();
          event.stopPropagation();
          if (canSaveRef.current) onSaveRef.current();
        }
      }}
    >
      <header className="tag-doc-header">
        <div className="tag-doc-title">
          <span className="tag-doc-path" title={doc.path}>{doc.path}</span>
          <span className="tag-doc-type">{tagTypeLabel(tagType)}</span>
          {dirty && <span className="tag-doc-dirty" aria-label="Unsaved changes" title="Unsaved changes">●</span>}
        </div>
        <div className="tag-doc-tablist" role="tablist" aria-label="Tag editor">
          {(['properties', 'json'] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tag-doc-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`tag-doc-panel-${id}`}
              className={`tag-doc-tab${tab === id ? ' is-active' : ''}`}
              onClick={() => setTab(id)}
            >
              {id === 'json' ? 'JSON' : 'Properties'}
            </button>
          ))}
        </div>
        <button type="button" className="tag-doc-reload" onClick={onReload} disabled={saving}>
          Reload
        </button>
        <button type="button" className="primary tag-doc-save" onClick={onSave} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save tag'}
        </button>
      </header>
      {readOnly && (
        <p className="tag-doc-note" role="status">
          Read-only — changing tags needs the Administrator role with execution switched on.
        </p>
      )}
      {problem && (
        <p className="tag-doc-error" role="alert">
          The JSON does not parse, so it cannot be saved: {problem}
        </p>
      )}
      <div
        className="tag-doc-panel"
        role="tabpanel"
        id="tag-doc-panel-properties"
        aria-labelledby="tag-doc-tab-properties"
        hidden={tab !== 'properties'}
      >
        <TagPropertyForm doc={doc} onChange={onChange} readOnly={readOnly} csrfToken={csrfToken} />
      </div>
      <div
        className="tag-doc-panel"
        role="tabpanel"
        id="tag-doc-panel-json"
        aria-labelledby="tag-doc-tab-json"
        hidden={tab !== 'json'}
      >
        <JsonBuffer text={doc.text} readOnly={readOnly} onChange={onChange} label={`${doc.path} JSON`} />
      </div>
    </section>
  );
}

/**
 * CodeMirror over the document text.
 *
 * Built once and fed from the outside: a Reload or a conflict resolution
 * replaces `text`, and the view is brought into line rather than rebuilt, so
 * its undo history and scroll position survive. The echo of our own edit
 * compares equal and does nothing.
 */
function JsonBuffer({ text, readOnly, onChange, label }: {
  text: string;
  readOnly: boolean;
  onChange: (text: string) => void;
  label: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlySwitch = useMemo(() => new Compartment(), []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          ...jsonSurface,
          editorTheme,
          ...findAndReplace,
          ...folding,
          readOnlySwitch.of(EditorState.readOnly.of(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          // Tab indents here — JSON has no byte-fidelity rule — and Escape
          // leaves, so Tab is not a keyboard trap (WCAG 2.1.2).
          keymap.of([...escapeFocusOut, indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Built once per mount; `text` and `readOnly` are synced by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== text) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: text } });
    }
  }, [text]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlySwitch.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, readOnlySwitch]);

  return <div className="tag-doc-buffer" ref={hostRef} />;
}
