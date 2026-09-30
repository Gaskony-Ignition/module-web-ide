import { ChangeSet, Text } from '@codemirror/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket } from '../test/fakeSocket';
import {
  LspClient,
  contentChangesFor,
  lspUri,
  offsetToPosition,
  positionToOffset,
  type Position,
} from './lspClient';
import { LspTransport, type Envelope } from './lspTransport';

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A client on an open socket, plus the socket, cleared of the connect traffic. */
function connectedClient() {
  const transport = new LspTransport({
    url: () => 'ws://gateway.test/system/scriptide',
    createSocket: FakeSocket.factory,
    requestTimeoutMs: 1_000,
    initialBackoffMs: 100,
  });
  const client = new LspClient(transport);
  transport.connect();
  FakeSocket.latest().open();
  FakeSocket.latest().clear();
  return { client, transport };
}

function frames(): Envelope[] {
  return FakeSocket.latest().frames();
}

function methods(): string[] {
  return FakeSocket.latest().methods();
}

function paramsOf(method: string): Record<string, unknown> {
  const frame = frames().find((f) => (f.msg as { method?: string }).method === method);
  if (!frame) throw new Error(`no ${method} frame was sent; saw ${methods().join(', ')}`);
  return (frame.msg as { params: Record<string, unknown> }).params;
}

// ============================ positions ============================

describe('offset ↔ position', () => {
  const doc = Text.of(['def f():', '\treturn 1', '']);

  it('converts a CodeMirror offset to a zero-based LSP position', () => {
    expect(offsetToPosition(doc, 0)).toEqual({ line: 0, character: 0 });
    // Start of line 2 — CodeMirror numbers lines from 1, LSP from 0.
    expect(offsetToPosition(doc, 9)).toEqual({ line: 1, character: 0 });
    expect(offsetToPosition(doc, 12)).toEqual({ line: 1, character: 3 });
  });

  it('counts a tab as one character, because it is one code unit', () => {
    // The editor indents with literal tabs, so every position on an indented
    // line would be wrong if this counted display columns instead.
    expect(offsetToPosition(doc, 10)).toEqual({ line: 1, character: 1 });
  });

  it('round-trips through positionToOffset', () => {
    for (let offset = 0; offset <= doc.length; offset++) {
      expect(positionToOffset(doc, offsetToPosition(doc, offset))).toBe(offset);
    }
  });

  it('clamps rather than throwing on an offset outside the document', () => {
    expect(offsetToPosition(doc, -5)).toEqual({ line: 0, character: 0 });
    expect(offsetToPosition(doc, doc.length + 100)).toEqual({ line: 2, character: 0 });
    expect(positionToOffset(doc, { line: 99, character: 99 })).toBe(doc.length);
    expect(positionToOffset(doc, { line: 0, character: -3 })).toBe(0);
  });

  it('measures an astral character as TWO units, per LSP UTF-16 semantics', () => {
    // The classic silent-drift bug: count code POINTS (Array.from, spread, a
    // for..of loop) and every column after an emoji is one short, so completion
    // and hover quietly answer about the wrong identifier. JavaScript strings,
    // CodeMirror offsets and the Java server's String are all UTF-16, and this
    // asserts the client agrees with all three.
    const line = 'x = "😀" + tail';
    expect(line.length).toBe(15); // 13 visible characters, 15 code units
    expect(Array.from(line)).toHaveLength(14); // what counting code points gives

    const astral = Text.of([line, 'y = 2']);
    const tailOffset = line.indexOf('tail');
    expect(offsetToPosition(astral, tailOffset)).toEqual({ line: 0, character: 11 });
    // End of the line, i.e. its whole length in code units.
    expect(offsetToPosition(astral, line.length)).toEqual({ line: 0, character: 15 });
    // And the second line still starts at 0 — the surrogate pair does not leak
    // into the line arithmetic.
    expect(offsetToPosition(astral, line.length + 1)).toEqual({ line: 1, character: 0 });
    expect(positionToOffset(astral, { line: 0, character: 11 })).toBe(tailOffset);
  });

  it('places a position between the halves of a surrogate pair predictably', () => {
    // Not a position any editor generates, but a stale offset can land here and
    // it must produce a number rather than an exception.
    const astral = Text.of(['😀ok']);
    expect(offsetToPosition(astral, 1)).toEqual({ line: 0, character: 1 });
  });
});

// ============================ incremental sync ============================

describe('contentChangesFor', () => {
  const before = Text.of(['alpha', 'beta', 'gamma']);

  it('expresses one edit as a range in the pre-change document', () => {
    const changes = ChangeSet.of({ from: 6, to: 10, insert: 'B' }, before.length);
    expect(contentChangesFor(before, changes)).toEqual([
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, text: 'B' },
    ]);
  });

  it('sends multiple edits in reverse document order', () => {
    // One transaction, two edits — multi-cursor typing, or a single Backspace
    // across two selection ranges. LSP applies content changes in ARRAY order,
    // each against the document the previous one produced, while CodeMirror's
    // are all against the original. Applying the last edit first is what keeps
    // the earlier ranges valid.
    const changes = ChangeSet.of(
      [
        { from: 0, to: 5, insert: 'A' },
        { from: 6, to: 10, insert: 'BB' },
      ],
      before.length
    );
    const sent = contentChangesFor(before, changes);
    expect(sent.map((change) => change.text)).toEqual(['BB', 'A']);
    // Assert the array length first so the indexed reads below are sound; without
    // it a regression that returned fewer changes would fail confusingly on an
    // undefined property rather than on the count.
    expect(sent).toHaveLength(2);
    const [first, second] = sent as [
      { range: { start: Position; end: Position }; text: string },
      { range: { start: Position; end: Position }; text: string },
    ];
    expect(first.range.start).toEqual({ line: 1, character: 0 });
    expect(second.range.start).toEqual({ line: 0, character: 0 });

    // Applying them in order to the original text must reproduce the new
    // document — the property the reversal exists to preserve.
    let text = before.toString();
    for (const change of [first, second]) {
      const from = positionToOffset(Text.of(text.split('\n')), change.range.start);
      const to = positionToOffset(Text.of(text.split('\n')), change.range.end);
      text = text.slice(0, from) + change.text + text.slice(to);
    }
    expect(text).toBe(changes.apply(before).toString());
  });

  it('expresses an insertion as an empty range', () => {
    const changes = ChangeSet.of({ from: 5, insert: '!' }, before.length);
    const sent = contentChangesFor(before, changes);
    expect(sent).toHaveLength(1);
    const change = sent[0] as { range: { start: Position; end: Position }; text: string };
    // An insertion is a zero-width range at the insertion point, not a replacement.
    expect(change.range.start).toEqual(change.range.end);
    expect(change.text).toBe('!');
  });
});

// ============================ URIs ============================

describe('lspUri', () => {
  it('keeps the resource path intact, slashes and all', () => {
    // Unlike the REST routes, which must percent-encode it — the route matches
    // a single path segment and the socket does not.
    expect(lspUri('Toolbox_Home', 'ignition/script-python/util/helpers')).toBe(
      'ignition://Toolbox_Home/ignition/script-python/util/helpers'
    );
  });
});

// ============================ synchronisation ============================

describe('document synchronisation', () => {
  const uri = lspUri('P', 'ignition/script-python/util/helpers');

  it('initialises the project before opening the first document', () => {
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'x = 1');
    expect(methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);

    const open = paramsOf('textDocument/didOpen') as {
      textDocument: { uri: string; languageId: string; text: string; version: number };
    };
    expect(open.textDocument).toMatchObject({ uri, languageId: 'python', text: 'x = 1' });
  });

  it('carries the project on the envelope, never inside the JSON-RPC message', () => {
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'x = 1');
    for (const frame of frames()) {
      expect(frame.ch).toBe('lsp');
      expect(frame.project).toBe('P');
      expect(frame.msg).not.toHaveProperty('project');
    }
  });

  it('sends an incremental didChange with an increasing version', () => {
    const { client } = connectedClient();
    const before = Text.of(['alpha', 'beta']);
    client.didOpen(uri, 'P', before.toString());
    FakeSocket.latest().clear();

    const changes = ChangeSet.of({ from: 6, to: 10, insert: 'B' }, before.length);
    client.didChange(uri, changes, before, changes.apply(before));

    const params = paramsOf('textDocument/didChange') as {
      textDocument: { version: number };
      contentChanges: { range: unknown; text: string }[];
    };
    expect(params.textDocument.version).toBe(2);
    expect(params.contentChanges).toHaveLength(1);
    // Incremental, not full: a ranged change, not the whole document.
    expect(params.contentChanges[0]).toHaveProperty('range');
    expect(params.contentChanges[0]?.text).toBe('B');
  });

  it('forgets a closed document and tells the server', () => {
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'x = 1');
    FakeSocket.latest().clear();
    client.didClose(uri);
    expect(methods()).toEqual(['textDocument/didClose']);
    expect(client.openDocumentCount()).toBe(0);
  });

  it('re-initialises and re-opens when the editor switches project', () => {
    // The server rebuilds its LanguageServer whenever the envelope's project
    // changes, so the documents of the project it was serving are gone.
    const { client } = connectedClient();
    const other = lspUri('Q', 'ignition/timer/Poller');
    client.didOpen(uri, 'P', 'x = 1');
    client.didOpen(other, 'Q', 'poll()');
    FakeSocket.latest().clear();

    // Back to P: everything P had must be re-established.
    client.didOpen(uri, 'P', 'x = 2');
    expect(methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
    expect(frames()[0]?.project).toBe('P');
    const open = paramsOf('textDocument/didOpen') as { textDocument: { text: string } };
    expect(open.textDocument.text).toBe('x = 2');
  });
});

describe('after a reconnect', () => {
  it('re-initialises and re-opens EVERY open document', () => {
    const { client } = connectedClient();
    const first = lspUri('P', 'ignition/script-python/util/helpers');
    const second = lspUri('P', 'ignition/timer/Poller');
    client.didOpen(first, 'P', 'x = 1');
    client.didOpen(second, 'P', 'poll()');

    // The connection goes away — a gateway restart, a proxy timeout, a laptop
    // lid. Whatever the cause, the new server has never heard of these files,
    // and every position sent against them would answer about nothing.
    FakeSocket.latest().drop();
    vi.advanceTimersByTime(100);
    const reconnected = FakeSocket.latest();
    expect(reconnected).not.toBe(FakeSocket.instances[0]);
    reconnected.open();

    expect(reconnected.methods()).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/didOpen',
    ]);
    const opened = reconnected
      .frames()
      .filter((frame) => (frame.msg as { method: string }).method === 'textDocument/didOpen')
      .map((frame) => (frame.msg as { params: { textDocument: { uri: string } } }).params.textDocument.uri);
    expect(opened).toEqual([first, second]);
    expect(reconnected.frames().every((frame) => frame.project === 'P')).toBe(true);
  });

  it('re-sends the CURRENT text, not the text the document was opened with', () => {
    const { client } = connectedClient();
    const uri = lspUri('P', 'ignition/script-python/util/helpers');
    const before = Text.of(['x = 1']);
    client.didOpen(uri, 'P', before.toString());
    const changes = ChangeSet.of({ from: 4, to: 5, insert: '2' }, before.length);
    client.didChange(uri, changes, before, changes.apply(before));

    FakeSocket.latest().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.latest().open();

    const open = paramsOf('textDocument/didOpen') as { textDocument: { text: string } };
    expect(open.textDocument.text).toBe('x = 2');
  });

  it('re-opens documents from every project, not just the last one', () => {
    const { client } = connectedClient();
    client.didOpen(lspUri('P', 'a'), 'P', 'a = 1');
    client.didOpen(lspUri('Q', 'b'), 'Q', 'b = 1');

    FakeSocket.latest().drop();
    vi.advanceTimersByTime(100);
    FakeSocket.latest().open();

    const projects = frames()
      .filter((frame) => (frame.msg as { method: string }).method === 'textDocument/didOpen')
      .map((frame) => frame.project);
    expect(projects.sort()).toEqual(['P', 'Q']);
  });
});

// ============================ features ============================

describe('language features', () => {
  const uri = lspUri('P', 'ignition/script-python/util/helpers');
  const position: Position = { line: 0, character: 7 };

  /** Answer the most recent request of `method` with `result`. */
  function reply(method: string, result: unknown): void {
    const frame = frames().find((f) => (f.msg as { method?: string }).method === method);
    if (!frame) throw new Error(`no ${method} request was sent`);
    FakeSocket.latest().deliver({
      ch: 'lsp',
      msg: { jsonrpc: '2.0', id: (frame.msg as { id: number }).id, result },
    });
  }

  it('unwraps a CompletionList into its items', async () => {
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'system.');
    const pending = client.completion(uri, position);
    reply('textDocument/completion', {
      isIncomplete: false,
      items: [{ label: 'tag', kind: 9, data: { dottedPath: 'system.tag' } }],
    });
    await expect(pending).resolves.toEqual([
      { label: 'tag', kind: 9, data: { dottedPath: 'system.tag' } },
    ]);
  });

  it('answers [] for a document the server was never told about', async () => {
    const { client } = connectedClient();
    await expect(client.completion('ignition://P/never-opened', position)).resolves.toEqual([]);
    // And sends nothing: a request against an unknown document can only ever
    // produce an answer about the wrong file.
    expect(FakeSocket.latest().sent).toHaveLength(0);
  });

  it('sends the item back verbatim on resolve, so data.dottedPath survives', async () => {
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'system.');
    const item = { label: 'readBlocking', kind: 3, data: { dottedPath: 'system.tag.readBlocking' } };
    const pending = client.resolveCompletion(item, 'P');
    const sent = frames().find((f) => (f.msg as { method?: string }).method === 'completionItem/resolve');
    expect((sent?.msg as { params: unknown }).params).toEqual(item);

    reply('completionItem/resolve', {
      ...item,
      documentation: { kind: 'markdown', value: 'Reads tags.' },
    });
    await expect(pending).resolves.toMatchObject({ documentation: { value: 'Reads tags.' } });
  });

  // ---- navigation (1.6.0) ----
  //
  // Every one of these was answered by the gateway from 1.0.0 and called by
  // nothing; the UI that calls them is new, so the WIRE is what is worth
  // pinning down here.

  it('normalises a single definition Location into an array', async () => {
    // LSP allows one Location or an array, and the server sends one. A caller
    // that branched on the shape would work until the day the server sent two.
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'helpers.compute()');
    const pending = client.definition(uri, position);
    const range = { start: { line: 4, character: 0 }, end: { line: 4, character: 0 } };
    reply('textDocument/definition', { uri: 'ignition://P/ignition/script-python/util', range });
    await expect(pending).resolves.toEqual([
      { uri: 'ignition://P/ignition/script-python/util', range },
    ]);
  });

  it('answers [] for a definition the server does not have', async () => {
    // The COMMON case: system.tag.readBlocking has no source file on this
    // gateway. It must be an empty list, not an error — F12 over a platform call
    // has to be silent.
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'system.tag.readBlocking()');
    const pending = client.definition(uri, position);
    reply('textDocument/definition', null);
    await expect(pending).resolves.toEqual([]);
  });

  it('sends caseSensitive with a text search', async () => {
    // The server has read this flag since 1.0.0 and the client never sent it, so
    // "Match case" could not have worked whatever the UI showed.
    const { client } = connectedClient();
    void client.searchText('P', 'Compute', true);
    expect(paramsOf('scriptide/searchText')).toEqual({ query: 'Compute', caseSensitive: true });
  });

  it('defaults a text search to case-insensitive', async () => {
    const { client } = connectedClient();
    void client.searchText('P', 'compute');
    expect(paramsOf('scriptide/searchText')).toEqual({ query: 'compute', caseSensitive: false });
  });

  it('asks for references by NAME, on the module\'s own method', async () => {
    // Not textDocument/references: that method promises a type-aware answer this
    // server cannot give, and answering it would be lying in the protocol.
    const { client } = connectedClient();
    const pending = client.references('P', 'compute');
    expect(methods()).toContain('scriptide/references');
    expect(paramsOf('scriptide/references')).toEqual({ name: 'compute' });
    reply('scriptide/references', [
      { uri: 'ignition://P/ignition/script-python/util', module: 'util', line: 3,
        character: 8, text: '\treturn compute(x)' },
    ]);
    await expect(pending).resolves.toHaveLength(1);
  });

  it('answers [] when references comes back null', async () => {
    const { client } = connectedClient();
    const pending = client.references('P', 'nothing');
    reply('scriptide/references', null);
    await expect(pending).resolves.toEqual([]);
  });

  it('returns null hover and signature help rather than throwing', async () => {
    const { client } = connectedClient();
    client.didOpen(uri, 'P', 'system.tag.readBlocking(');
    const hover = client.hover(uri, position);
    reply('textDocument/hover', null);
    await expect(hover).resolves.toBeNull();

    FakeSocket.latest().clear();
    const help = client.signatureHelp(uri, position);
    reply('textDocument/signatureHelp', null);
    await expect(help).resolves.toBeNull();
  });
});

/**
 * Document identity for a resource that holds more than one script.
 *
 * Found in the browser on 01/09/2026: the doPost tab of a Web Dev endpoint
 * displayed doGet's OUTLINE, because both scripts live at one resource path and
 * the URI was built from the path alone. The same collision would have put
 * diagnostics on the wrong buffer.
 */
describe('lspUri', () => {
  it('keys a multi-script resource by its data key', () => {
    const get = lspUri('P', 'com.inductiveautomation.webdev/resources/admin', 'doGet.py');
    const post = lspUri('P', 'com.inductiveautomation.webdev/resources/admin', 'doPost.py');
    expect(get).not.toEqual(post);
  });

  it('leaves an ordinary script URI unchanged', () => {
    // Every other resource has exactly one script, always `code.py` or its
    // per-type equivalent, so its URI must stay byte-identical to before —
    // otherwise every open document changes identity on upgrade.
    expect(lspUri('P', 'ignition/script-python/util/helpers')).toBe(
      'ignition://P/ignition/script-python/util/helpers'
    );
    expect(lspUri('P', 'ignition/script-python/util/helpers', 'code.py')).toBe(
      'ignition://P/ignition/script-python/util/helpers'
    );
  });

  it('is stable for the same document', () => {
    const a = lspUri('P', 'x/y/z', 'doPut.py');
    const b = lspUri('P', 'x/y/z', 'doPut.py');
    expect(a).toBe(b);
  });
});
