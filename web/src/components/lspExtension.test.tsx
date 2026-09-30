import { startCompletion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LspClient, lspUri, type CompletionItem } from '../api/lspClient';
import { LspTransport } from '../api/lspTransport';
import { FakeSocket } from '../test/fakeSocket';
import type { OpenDoc } from '../workspace/documents';
import CodeEditor from './CodeEditor';
import {
  FIND_REFERENCES_EVENT,
  OPEN_LOCATION_EVENT,
  completionType,
  detailToShow,
  documentationText,
  isDeprecated,
  lspSnippetToCodeMirror,
  markdownToText,
  toCompletions,
} from './lspExtension';

const neverResolves = () => new Promise<CompletionItem>(() => undefined);

describe('LSP kind → CodeMirror completion type', () => {
  // The type string picks the icon and its colour class; an unmapped kind
  // renders a blank gutter beside the label, which reads as a broken popup
  // rather than as a missing mapping.
  it.each([
    [9, 'namespace', 'Module — system, system.tag'],
    [3, 'function', 'Function — readBlocking'],
    [10, 'property', 'Property — a constant on a module'],
    [2, 'method', 'Method'],
    [6, 'variable', 'Variable'],
    [7, 'class', 'Class'],
    [14, 'keyword', 'Keyword'],
    [15, 'text', 'Snippet — a built-in like logger or readtag'],
  ])('maps kind %i to %s (%s)', (kind, expected) => {
    expect(completionType(kind as number)).toBe(expected);
  });

  it('leaves the type undefined for a kind it does not know', () => {
    expect(completionType(undefined)).toBeUndefined();
    expect(completionType(9999)).toBeUndefined();
  });
});

describe('completion mapping', () => {
  const items: CompletionItem[] = [
    { label: 'tag', kind: 9, data: { dottedPath: 'system.tag' } },
    {
      label: 'readBlocking',
      kind: 3,
      detail: 'readBlocking(tagPaths, [timeout])',
      data: { dottedPath: 'system.tag.readBlocking' },
    },
    { label: 'read', kind: 3, tags: [1], data: { dottedPath: 'system.tag.read' } },
    { label: 'VERSION', kind: 10, data: { dottedPath: 'system.VERSION' } },
  ];

  it('maps every item to a CodeMirror completion with the right type', () => {
    const options = toCompletions(items, neverResolves);
    expect(options.map((option) => [option.label, option.type])).toEqual([
      ['tag', 'namespace'],
      ['readBlocking', 'function'],
      ['read', 'function'],
      ['VERSION', 'property'],
    ]);
  });

  it('keeps the server’s signature as the detail line', () => {
    const [, readBlocking] = toCompletions(items, neverResolves);
    expect(readBlocking?.detail).toBe('readBlocking(tagPaths, [timeout])');
  });

  it('sorts a deprecated item below the rest without hiding it', () => {
    // The gateway really does have these names, so removing them would be a lie;
    // ranking them last is the honest treatment.
    const options = toCompletions(items, neverResolves);
    expect(isDeprecated(items[2] as CompletionItem)).toBe(true);
    expect(options[2]?.boost).toBeLessThan(0);
    expect(options[1]?.boost).toBe(0);
  });

  it('does not fetch documentation until the info panel asks for it', async () => {
    // Documentation is deliberately absent from the completion response, to keep
    // the popup fast. Resolving all hundred items up front would undo exactly
    // that, so resolve must be called per item, on demand.
    const resolve = vi.fn(async (item: CompletionItem) => ({
      ...item,
      documentation: { kind: 'markdown' as const, value: '**Reads** a `tag`.' },
    }));
    const options = toCompletions(items, resolve);
    expect(resolve).not.toHaveBeenCalled();

    const info = await (options[1]?.info as (c: unknown) => Promise<Node | null>)(options[1]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(items[1]);
    // Rendered as plain text — no markdown library, and nothing goes near
    // innerHTML.
    expect((info as HTMLElement).textContent).toContain('Reads a tag.');
    expect((info as HTMLElement).innerHTML).not.toContain('<b');
  });

  it('still shows the detail line when resolve fails', async () => {
    const options = toCompletions(items, () => Promise.reject(new Error('socket dropped')));
    const info = await (options[1]?.info as (c: unknown) => Promise<Node | null>)(options[1]);
    expect((info as HTMLElement).textContent).toContain('readBlocking(tagPaths, [timeout])');
  });
});

describe('lspSnippetToCodeMirror', () => {
  it('turns a numbered stop with default text into a plain named field', () => {
    expect(lspSnippetToCodeMirror('logger = system.util.getLogger("${1:Name}")')).toBe(
      'logger = system.util.getLogger("${Name}")'
    );
  });

  it('turns a bare braced stop with no text into an empty field', () => {
    expect(lspSnippetToCodeMirror('rows = system.db.runNamedQuery("Path/Name", {${2}})')).toBe(
      'rows = system.db.runNamedQuery("Path/Name", {${}})'
    );
  });

  it('turns an unbraced tab stop into an empty field', () => {
    expect(lspSnippetToCodeMirror('system.tag.writeBlocking([$1], [$2])')).toBe(
      'system.tag.writeBlocking([${}], [${}])'
    );
  });

  it('turns the final-cursor $0 into an empty field, same as a bare numbered stop', () => {
    expect(lspSnippetToCodeMirror('${1:pass}\n$0')).toBe('${pass}\n${}');
  });

  it('converts every stop independently, even when the numbers run out of textual order', () => {
    // LSP orders tab stops by NUMBER, not by where they sit in the text, so a
    // template is free to write ${2:...} before ${1:...}. The conversion must
    // not assume ascending order — each match is rewritten where it stands.
    expect(lspSnippetToCodeMirror('${2:second} then ${1:first}, finally $0')).toBe(
      '${second} then ${first}, finally ${}'
    );
  });

  it('leaves a body with no tab stops completely unchanged', () => {
    const body = 'path = event.getTagPath()';
    expect(lspSnippetToCodeMirror(body)).toBe(body);
  });

  it('keeps an empty default (${2:}) as an empty field, not the literal text "undefined"', () => {
    // A colon with nothing after it is how this server writes an empty dict
    // literal — `runNamedQuery(path, {${2:}})` — and it must round-trip to an
    // empty field, not swallow the braces or print the word "undefined".
    expect(lspSnippetToCodeMirror('{${2:}}')).toBe('{${}}');
  });

  it('un-escapes a literal dollar sign the author escaped, without treating it as a stop', () => {
    expect(lspSnippetToCodeMirror('price is \\$5, not a ${1:field}')).toBe(
      'price is $5, not a ${field}'
    );
  });

  it('mirrors two stops that share the same number and default text', () => {
    // Two occurrences of ${1:datasource} name the SAME field once numbers are
    // dropped, because CodeMirror groups unnumbered fields by their text — so
    // typing the datasource once fills in both. This is how `tx` uses the
    // datasource name twice on purpose.
    const body = 'tx = system.db.beginTransaction("${1:datasource}") # ... "${1:datasource}"';
    const converted = lspSnippetToCodeMirror(body);
    expect(converted).toBe('tx = system.db.beginTransaction("${datasource}") # ... "${datasource}"');
  });
});

describe('a snippet completion item, end to end', () => {
  const snippetItem: CompletionItem = {
    label: 'logger',
    detail: 'Get a named logger',
    insertText: 'logger = system.util.getLogger("${1:Name}")',
    insertTextFormat: 2,
  };
  const apiItem: CompletionItem = {
    label: 'readBlocking',
    kind: 3,
    detail: 'readBlocking(tagPaths, [timeout])',
  };

  it('gives a snippet item an apply function; leaves an ordinary item on the default insert', () => {
    const [snippet, api] = toCompletions([snippetItem, apiItem], neverResolves);
    expect(typeof snippet?.apply).toBe('function');
    expect(api?.apply).toBeUndefined();
  });

  it('expanding the snippet inserts the CodeMirror form of the body, tab stops and all', () => {
    const [snippet] = toCompletions([snippetItem], neverResolves);
    const view = new EditorView({ state: EditorState.create({ doc: '' }) });
    try {
      (snippet?.apply as (view: EditorView, completion: unknown, from: number, to: number) => void)(
        view,
        snippet,
        0,
        0
      );
      // Accepting the default (never tabbing to rename it) leaves the field's
      // default text in the document — exactly what a plain-text insert of the
      // LSP body would NOT have given, since that body still had `${1:Name}`
      // literally in it.
      expect(view.state.doc.toString()).toBe('logger = system.util.getLogger("Name")');
    } finally {
      view.destroy();
    }
  });

  it('still carries detail and the info panel like an ordinary item', async () => {
    const resolve = vi.fn(async (item: CompletionItem) => ({
      ...item,
      documentation: { kind: 'markdown' as const, value: 'Creates a logger.' },
    }));
    const [snippet] = toCompletions([snippetItem], resolve);
    expect(snippet?.detail).toBe('Get a named logger');
    const info = await (snippet?.info as (c: unknown) => Promise<Node | null>)(snippet);
    expect((info as HTMLElement).textContent).toContain('Creates a logger.');
  });
});

describe('markdown as plain text', () => {
  it('strips the syntax the server sends rather than rendering it', () => {
    const markdown = [
      '```python',
      'readBlocking(tagPaths, [timeout])',
      '```',
      '',
      '**Deprecated.**',
      '',
      'Reads the value of `tagPaths`.',
      '',
      '**Parameters**',
      '',
      '- `tagPaths` *(optional, default `None`)* — the tags to read',
    ].join('\n');
    const text = markdownToText(markdown);
    expect(text).toContain('readBlocking(tagPaths, [timeout])');
    expect(text).toContain('Reads the value of tagPaths.');
    expect(text).toContain('• tagPaths (optional, default None) — the tags to read');
    expect(text).not.toContain('```');
    expect(text).not.toContain('**');
    expect(text).not.toContain('`');
  });

  it('leaves plaintext MarkupContent alone', () => {
    expect(documentationText({ kind: 'plaintext', value: '  a * b  ' })).toBe('a * b');
  });

  it('accepts the bare-string form of documentation', () => {
    expect(documentationText('`plain`')).toBe('plain');
    expect(documentationText(undefined)).toBe('');
  });
});

// ============================ wiring ============================

const SOURCE = 'def compute(values):\n\treturn sum(values)';

function doc(overrides: Partial<OpenDoc> = {}): OpenDoc {
  return {
    kind: 'script',
    uri: 'P::ignition/script-python/util/helpers',
    project: 'P',
    path: 'ignition/script-python/util/helpers',
    scriptKey: 'code.py',
    overridden: false,
    typeLabel: 'Project Library',
    label: 'helpers',
    origin: 'local',
    etag: 'sig-1',
    baseText: SOURCE,
    text: SOURCE,
    ...overrides,
  };
}

describe('CodeEditor with a language client', () => {
  beforeEach(() => {
    FakeSocket.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function client() {
    const transport = new LspTransport({
      url: () => 'ws://gateway.test/system/scriptide',
      createSocket: FakeSocket.factory,
    });
    const lsp = new LspClient(transport);
    transport.connect();
    FakeSocket.latest().open();
    FakeSocket.latest().clear();
    return lsp;
  }

  it('opens the document on the server when a view is created, and closes it with the view', () => {
    const lsp = client();
    const { rerender } = render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    expect(FakeSocket.latest().methods()).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
    ]);
    const open = FakeSocket.latest().frames()[2];
    expect(open?.project).toBe('P');
    expect(open?.msg).toMatchObject({
      params: {
        textDocument: { uri: lspUri('P', 'ignition/script-python/util/helpers'), text: SOURCE },
      },
    });

    FakeSocket.latest().clear();
    rerender(
      <CodeEditor
        docs={[]}
        activeUri={null}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    // Closing the tab destroys the view, and the server must forget the file —
    // otherwise its document set drifts from the editor's for the life of the
    // connection.
    expect(FakeSocket.latest().methods()).toEqual(['textDocument/didClose']);
  });

  it('sends an incremental didChange as the user types, and never rewrites the buffer', () => {
    const lsp = client();
    const onChange = vi.fn();
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={onChange}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    FakeSocket.latest().clear();

    const host = document.querySelector<HTMLElement>('.code-editor-host .cm-editor');
    const view = host ? EditorView.findFromDOM(host) : null;
    if (!view) throw new Error('no EditorView mounted');
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\t# tail' } });

    const change = FakeSocket.latest().frames()[0];
    expect((change?.msg as { method: string }).method).toBe('textDocument/didChange');
    const params = (change?.msg as { params: { contentChanges: { range?: unknown; text: string }[] } })
      .params;
    expect(params.contentChanges).toHaveLength(1);
    expect(params.contentChanges[0]?.range).toBeDefined();
    expect(params.contentChanges[0]?.text).toBe('\n\t# tail');

    // The byte-fidelity guarantee still holds with the LSP extensions loaded:
    // nothing in them touches the document.
    const [, saved] = onChange.mock.calls[0] as [string, string];
    expect(saved).toBe(SOURCE + '\n\t# tail');
    expect(saved).not.toContain('    ');
  });

  /** The mounted view for the visible document. */
  function activeView(): EditorView {
    const host = document.querySelector<HTMLElement>('.code-editor-host .cm-editor');
    const view = host ? EditorView.findFromDOM(host) : null;
    if (!view) throw new Error('no EditorView mounted');
    return view;
  }

  /** Answer the pending request for `method`, then let the promises settle. */
  async function reply(method: string, result: unknown): Promise<void> {
    const frame = FakeSocket.latest()
      .frames()
      .find((f) => (f.msg as { method?: string }).method === method);
    if (!frame) {
      throw new Error(`no ${method} request was sent; saw ${FakeSocket.latest().methods().join(', ')}`);
    }
    await act(async () => {
      FakeSocket.latest().deliver({
        ch: 'lsp',
        msg: { jsonrpc: '2.0', id: (frame.msg as { id: number }).id, result },
      });
    });
  }

  it('asks the gateway for completions on an explicit request, and shows them', async () => {
    const lsp = client();
    render(
      <CodeEditor
        docs={[doc({ baseText: 'system.', text: 'system.' })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    const view = activeView();
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      FakeSocket.latest().clear();
      startCompletion(view);
      // CodeMirror runs completion sources on a debounce even for an explicit
      // request, so the frame is not on the wire until that fires.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const request = FakeSocket.latest()
      .frames()
      .find((f) => (f.msg as { method?: string }).method === 'textDocument/completion');
    expect(request).toBeDefined();
    // Position is where the cursor is, in LSP's zero-based, UTF-16 coordinates.
    expect((request?.msg as { params: { position: unknown } }).params.position).toEqual({
      line: 0,
      character: 7,
    });

    await reply('textDocument/completion', {
      isIncomplete: false,
      items: [
        { label: 'tag', kind: 9, data: { dottedPath: 'system.tag' } },
        { label: 'db', kind: 9, data: { dottedPath: 'system.db' } },
      ],
    });

    const labels = Array.from(document.querySelectorAll('.cm-completionLabel')).map(
      (node) => node.textContent
    );
    // Exactly the gateway's answer. lang-python's own sources are silenced after
    // a dot: `memoryview` is not a member of `system`, and offering it there
    // reads as the IDE not knowing what `system` is.
    // Sorted, because the popup's ordering is CodeMirror's business — what
    // matters is that the set is exactly the gateway's.
    expect(labels.sort()).toEqual(['db', 'tag']);
  });

  it('still offers Python built-ins and locals for a bare word', async () => {
    const lsp = client();
    render(
      <CodeEditor
        docs={[doc({ baseText: 'mem', text: 'mem' })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    const view = activeView();
    await act(async () => {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      FakeSocket.latest().clear();
      startCompletion(view);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    await reply('textDocument/completion', { isIncomplete: false, items: [] });

    const labels = Array.from(document.querySelectorAll('.cm-completionLabel')).map(
      (node) => node.textContent
    );
    // The gateway's hint tree has no local variables and no Python built-ins, so
    // dropping lang-python's sources outright would lose them for good.
    expect(labels).toContain('memoryview');
  });

  it('asks for signature help when a call is opened, and drops it when the call closes', async () => {
    const lsp = client();
    render(
      <CodeEditor
        docs={[doc({ baseText: 'system.tag.readBlocking', text: 'system.tag.readBlocking' })]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    const view = activeView();
    FakeSocket.latest().clear();
    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: '(' },
        selection: { anchor: view.state.doc.length + 1 },
      });
    });

    await reply('textDocument/signatureHelp', {
      signatures: [
        {
          label: 'readBlocking(tagPaths, [timeout])',
          parameters: [{ label: 'tagPaths' }, { label: '[timeout]' }],
        },
      ],
      activeSignature: 0,
      activeParameter: 0,
    });

    const tooltip = document.querySelector('.cm-lsp-signature');
    expect(tooltip?.textContent).toContain('readBlocking(tagPaths, [timeout])');
    // The parameter the cursor is on is the one emphasised.
    expect(document.querySelector('.cm-lsp-signature-active')?.textContent).toBe('tagPaths');

    await act(async () => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: ')' },
        selection: { anchor: view.state.doc.length + 1 },
      });
    });
    expect(document.querySelector('.cm-lsp-signature')).toBeNull();
  });

  it('runs with no client at all, so a dead socket is not a dead editor', () => {
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={null}
      />
    );
    expect(document.querySelectorAll('.code-editor-host')).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

/**
 * The signature-twice rule.
 *
 * Fixed in 1.5.0 with nothing asserting it, which is how it comes back: the
 * resolved documentation markdown ALREADY opens with the signature in a
 * ```python fence, and that fenced line is the same string as `detail`. Render
 * both and the completion panel shows the signature on its own line and again as
 * the first line of the body.
 */
describe('detailToShow', () => {
  const signature = 'readBlocking(tagPaths, [timeout])';

  it('drops the detail when the body already starts with it', () => {
    expect(detailToShow(signature, `${signature}\n\nReads tags.`)).toBe('');
  });

  it('keeps the detail when there is no body at all', () => {
    expect(detailToShow(signature, '')).toBe(signature);
  });

  it('keeps the detail when the body starts with something else', () => {
    expect(detailToShow(signature, 'Reads tags.')).toBe(signature);
  });

  it('is empty for an item with no detail', () => {
    expect(detailToShow(undefined, 'Reads tags.')).toBe('');
    expect(detailToShow('', 'Reads tags.')).toBe('');
  });

  it('does not treat a PREFIX of the detail as a repeat', () => {
    // `read` is not `readBlocking(...)`; dropping the detail here would lose the
    // signature entirely.
    expect(detailToShow(signature, 'read')).toBe(signature);
  });
});

describe('go-to-definition and find-references', () => {
  beforeEach(() => {
    FakeSocket.reset();
  });

  function client() {
    const transport = new LspTransport({
      url: () => 'ws://gateway.test/system/scriptide',
      createSocket: FakeSocket.factory,
    });
    const lsp = new LspClient(transport);
    transport.connect();
    FakeSocket.latest().open();
    FakeSocket.latest().clear();
    return lsp;
  }

  function mount(lsp: LspClient) {
    render(
      <CodeEditor
        docs={[doc()]}
        activeUri={doc().uri}
        readOnly={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
        lsp={lsp}
      />
    );
    const host = document.querySelector<HTMLElement>('.code-editor-host .cm-editor');
    const view = host ? EditorView.findFromDOM(host) : null;
    if (!view) throw new Error('no EditorView mounted');
    return view;
  }

  it('asks the server for a definition on F12', async () => {
    const lsp = client();
    const view = mount(lsp);
    await act(async () => {
      view.dispatch({ selection: { anchor: 5 } });
    });
    FakeSocket.latest().clear();
    await act(async () => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F12', bubbles: true })
      );
    });
    expect(FakeSocket.latest().methods()).toContain('textDocument/definition');
  });

  it('publishes the server\'s answer as an open-location event', async () => {
    const lsp = client();
    const view = mount(lsp);
    const seen: Array<{ uri: string; line: number; character: number }> = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ uri: string; line: number; character: number }>).detail);
    };
    window.addEventListener(OPEN_LOCATION_EVENT, listener);
    try {
      await act(async () => {
        view.dispatch({ selection: { anchor: 5 } });
      });
      await act(async () => {
        view.contentDOM.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'F12', bubbles: true })
        );
      });
      const frame = FakeSocket.latest()
        .frames()
        .find((f) => (f.msg as { method?: string }).method === 'textDocument/definition');
      await act(async () => {
        FakeSocket.latest().deliver({
          ch: 'lsp',
          msg: {
            jsonrpc: '2.0',
            id: (frame?.msg as { id: number }).id,
            result: {
              uri: 'ignition://P/ignition/script-python/util/other',
              range: { start: { line: 12, character: 4 }, end: { line: 12, character: 4 } },
            },
          },
        });
      });
      expect(seen).toEqual([
        { uri: 'ignition://P/ignition/script-python/util/other', line: 12, character: 4 },
      ]);
    } finally {
      window.removeEventListener(OPEN_LOCATION_EVENT, listener);
    }
  });

  it('raises a references request for the WORD under the cursor on Shift+F12', async () => {
    // The bare name, not a dotted path: references are name-based, and
    // `util.compute` and `self.compute` are both a reference to `compute`.
    const lsp = client();
    const view = mount(lsp);
    const names: string[] = [];
    const listener = (event: Event) => {
      names.push((event as CustomEvent<{ name: string }>).detail.name);
    };
    window.addEventListener(FIND_REFERENCES_EVENT, listener);
    try {
      await act(async () => {
        view.dispatch({ selection: { anchor: 6 } });   // inside `compute`
      });
      await act(async () => {
        view.contentDOM.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'F12', shiftKey: true, bubbles: true })
        );
      });
      expect(names).toEqual(['compute']);
    } finally {
      window.removeEventListener(FIND_REFERENCES_EVENT, listener);
    }
  });
});
