/**
 * The CodeMirror side of the language client: completion, hover and signature
 * help, plus the document-synchronisation plugin that keeps the server's copy of
 * the buffer in step with this view's.
 *
 * The completion sources are composed explicitly rather than left to
 * `languageData`, and that is a decision worth keeping. lang-python's own
 * sources are genuinely useful for a bare word — they know the local variables
 * and the Python built-ins, and the gateway does not. They are actively wrong
 * after a dot: the server answers `system.` with the real members of that
 * module, and CodeMirror would merge `memoryview` and `MemoryError` in beside
 * them, which reads as the IDE not knowing what `system` is. So they are kept
 * and gated, instead of either being dropped or left to fire everywhere.
 *
 * Nothing in this file may touch the document. The editor's byte-fidelity rules
 * (tabs, no trailing newline) hold because nothing else writes to the buffer,
 * and a completion `apply` that inserted anything but the label the user picked
 * would be the first thing to break them.
 */
import {
  autocompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { globalCompletion, localCompletionSource } from '@codemirror/lang-python';
import { StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  hoverTooltip,
  keymap,
  showTooltip,
  type Tooltip,
  type ViewUpdate,
} from '@codemirror/view';
import {
  lspUri,
  offsetToPosition,
  type CompletionItem,
  type Documentation,
  type Hover,
  type LspClient,
  type SignatureHelp,
} from '../api/lspClient';

/** Identifies the document this view is editing to the language server. */
export interface LspDocumentRef {
  project: string;
  /** Resource path, as `scripts.ts` uses it. */
  path: string;
  /**
   * The resource's data key, when the resource holds more than one script.
   *
   * Part of the LSP document identity — a Web Dev endpoint is one path with up
   * to eight scripts, and without this they share a server-side document.
   */
  scriptKey?: string;
}

/**
 * LSP `CompletionItemKind` → CodeMirror completion `type`.
 *
 * The type string is what picks the icon and its colour class
 * (`cm-completionIcon-<type>`), so an unmapped kind is not cosmetic: it renders
 * a blank gutter beside the label. The four this server emits today are 9, 3,
 * 10 and 15; the rest are mapped anyway because the kind is the server's to
 * widen and this is the file that would otherwise need finding again.
 */
const COMPLETION_TYPES: Record<number, string> = {
  1: 'text',
  2: 'method',
  3: 'function',
  4: 'class', // Constructor
  5: 'property', // Field
  6: 'variable',
  7: 'class',
  8: 'interface',
  9: 'namespace', // Module
  10: 'property',
  11: 'constant', // Unit
  12: 'constant', // Value
  13: 'enum',
  14: 'keyword',
  15: 'text', // Snippet — CodeMirror has no dedicated icon style for one
  21: 'constant',
  22: 'type', // Struct
  25: 'type', // TypeParameter
};

export function completionType(kind: number | undefined): string | undefined {
  return kind === undefined ? undefined : COMPLETION_TYPES[kind];
}

/** True when the server tagged the item CompletionItemTag.Deprecated. */
export function isDeprecated(item: CompletionItem): boolean {
  return Array.isArray(item.tags) && item.tags.includes(1);
}

/**
 * Markdown as plain text.
 *
 * Deliberately hand-rolled and deliberately small: a markdown library is tens of
 * kilobytes for content that is a code fence, a paragraph and a bullet list, and
 * the bundle has a size gate. This strips the syntax rather than rendering it —
 * fences and inline backticks go, emphasis markers go, bullets become a real
 * bullet character — which reads correctly in a monospace tooltip and cannot
 * inject markup, because nothing here is ever assigned to innerHTML.
 */
export function markdownToText(input: string): string {
  return input
    .replace(/```[a-zA-Z0-9]*\n?/g, '') // fence openers and closers
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1$2') // italics, but not a bare *
    .replace(/^\s*[-*]\s+/gm, '• ') // list bullets
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text of an LSP `MarkupContent | string`, flattened for display. */
export function documentationText(documentation: Documentation | undefined): string {
  if (!documentation) return '';
  const raw = typeof documentation === 'string' ? documentation : documentation.value;
  const plain = typeof documentation === 'object' && documentation.kind === 'plaintext';
  return plain ? raw.trim() : markdownToText(raw);
}

/**
 * A numbered LSP tab stop, with or without default text: `${1:name}`, `${1}`,
 * `$1`, and the final-cursor form `$0`.
 *
 * The `text` group is `undefined` for the bare forms so the caller can tell
 * "no default text" apart from an intentionally empty one (`${1:}`, which this
 * server uses for an empty dict literal like `runNamedQuery(path, {${2:}})`).
 */
const LSP_TAB_STOP = /\$\{(\d+)(?::([^{}]*))?\}|\$(\d+)/g;

/**
 * LSP snippet syntax → CodeMirror's.
 *
 * The two look alike and are not: LSP writes a NUMBERED stop, braced or bare —
 * `${1:name}`, `${1}`, `$1`, and `$0` for where the cursor ends up last.
 * CodeMirror's own `snippet()` (`@codemirror/autocomplete`) only ever
 * recognises the braced form, groups stops by NAME rather than number, and has
 * no bare `$1` syntax at all — passed through unconverted, a bare stop is just
 * literal text in the inserted code, and `$0` fares no better since `0` is not
 * a name.
 *
 * Every stop here becomes a plain `${text}` (or `${}` for one with no text),
 * so the field's identity becomes its default text rather than its number.
 * That is deliberately safe for every snippet this module ships: each one's
 * numbered stops appear in ascending textual order already, which is exactly
 * the order CodeMirror gives unnumbered fields, and two default stops sharing
 * the same text is how this module writes a MIRRORED field on purpose (`tx`
 * repeats `${1:datasource}` so typing the datasource once fills both). A
 * snippet whose numbering runs out of textual order, or reuses text between
 * two stops that are not meant to mirror, would need a real numbered
 * conversion instead of this one.
 *
 * The one character LSP treats specially that this must still respect is a
 * literal `$` the author escaped with a backslash — CodeMirror has no escape
 * syntax for `$` at all (only `\{` and `\}`), so left alone the backslash
 * would show up in the inserted text. It is stripped last, once every real
 * tab stop has already been matched, so it can never be mistaken for one.
 */
export function lspSnippetToCodeMirror(body: string): string {
  const converted = body.replace(
    LSP_TAB_STOP,
    (match: string, _bracedNumber: string, bracedText: string | undefined, _bareNumber: string, offset: number) => {
      // An escaped `$` (`\$`) is not a tab stop at all — leave it untouched here
      // and let the final pass below turn it into a literal `$`.
      if (offset > 0 && body[offset - 1] === '\\') return match;
      return `\${${bracedText ?? ''}}`;
    }
  );
  return converted.replace(/\\\$/g, '$');
}

/**
 * Map server completion items to CodeMirror completions.
 *
 * `info` is a function, not a string: documentation is deliberately absent from
 * the completion response and only arrives from `completionItem/resolve`, so it
 * must be fetched when the info panel opens for one item — not for the hundred
 * that came back.
 */
export function toCompletions(
  items: CompletionItem[],
  resolve: (item: CompletionItem) => Promise<CompletionItem>
): Completion[] {
  return items.map((item) => {
    const deprecated = isDeprecated(item);
    const completion: Completion = {
      label: item.label,
      type: completionType(item.kind),
      detail: item.detail,
      // Deprecated names still belong in the list — the gateway really does have
      // them — but sorted below everything current.
      boost: deprecated ? -50 : 0,
      info: () => infoDom(item, resolve, deprecated),
    };
    // insertTextFormat 2 = Snippet. A snippet's `info` panel still works exactly
    // as an API entry's does above — only `apply` changes, to expand the body
    // with real tab stops instead of dropping the label in verbatim.
    if (item.insertTextFormat === 2 && item.insertText) {
      return snippetCompletion(lspSnippetToCodeMirror(item.insertText), completion);
    }
    return completion;
  });
}

async function infoDom(
  item: CompletionItem,
  resolve: (item: CompletionItem) => Promise<CompletionItem>,
  deprecated: boolean
): Promise<Node | null> {
  let resolved = item;
  try {
    resolved = await resolve(item);
  } catch {
    /* an unresolvable item still shows its detail line */
  }
  const body = documentationText(resolved.documentation);
  const detail = detailToShow(resolved.detail, body);
  if (!body && !detail && !deprecated) return null;
  return textPanel([deprecated ? 'Deprecated.' : '', detail, body]);
}

/**
 * The `detail` line to render ABOVE the documentation body, or `''` for none.
 *
 * The server's resolved `documentation` markdown already OPENS with the
 * signature as a fenced snippet (`LanguageServer#markdownFor` puts
 * `entry.detail()` in a ```python fence before anything else), and that is the
 * exact same string as `resolved.detail`. Rendering both blocks put the
 * signature on screen twice — once as its own line, once as the first line of
 * the body. So `detail` is shown on its own only when the body does not already
 * start with it (a bare `detail` with no documentation at all, say).
 *
 * Pulled out of {@link infoDom} in 1.6.0 purely so the rule is testable: it was
 * fixed in 1.5.0 and had nothing asserting it, which is how it regresses.
 */
export function detailToShow(detail: string | undefined, body: string): string {
  if (!detail) return '';
  return body.startsWith(detail) ? '' : detail;
}

/** A plain-text tooltip body. textContent only — never innerHTML. */
function textPanel(parts: string[]): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-lsp-doc';
  for (const part of parts) {
    if (!part) continue;
    const block = document.createElement('div');
    block.className = 'cm-lsp-doc-block';
    block.textContent = part;
    dom.appendChild(block);
  }
  return dom;
}

/** True when the cursor sits immediately after the server's trigger character. */
function isAfterDot(context: CompletionContext): boolean {
  return context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos) === '.';
}

/**
 * lang-python's own source, silenced after a dot.
 *
 * A local variable or a built-in is never a member of the module to the left of
 * the dot, so offering one there is noise at exactly the moment the gateway has
 * an authoritative answer.
 */
function bareWordOnly(source: CompletionSource): CompletionSource {
  return (context) => (isAfterDot(context) ? null : source(context));
}

/**
 * Completion source.
 *
 * Fires on an explicit request (Ctrl+Space), immediately after a `.` — the
 * server's declared trigger character — and while a word is being typed. It
 * returns null in every other case so that merely typing a space does not open a
 * popup, and `validFor` lets CodeMirror filter locally as the word grows instead
 * of round-tripping per keystroke (the server sets `isIncomplete:false`, which
 * is what makes that sound).
 */
function completionSource(client: LspClient, uri: string, project: string): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const word = context.matchBefore(/[\w$]*/);
    const afterDot = isAfterDot(context);
    if (!context.explicit && !afterDot && (!word || word.from === word.to)) {
      return null;
    }
    let items: CompletionItem[];
    try {
      items = await client.completion(uri, offsetToPosition(context.state.doc, context.pos));
    } catch {
      // A dropped socket must not raise inside the popup. No completions is the
      // honest answer, and the transport is already reconnecting.
      return null;
    }
    if (context.aborted || items.length === 0) return null;
    return {
      // Right after a dot there is no word to replace, so the insertion starts
      // at the cursor; mid-word it replaces the word, because the server has
      // already filtered by that prefix and returns bare names.
      from: afterDot ? context.pos : (word?.from ?? context.pos),
      options: toCompletions(items, (item) => client.resolveCompletion(item, project)),
      validFor: /^[\w$]*$/,
    };
  };
}

/** Hover documentation for the identifier under the pointer. */
function lspHover(client: LspClient, uri: string) {
  return hoverTooltip(async (view, pos) => {
    // Only over a word. Without this every hover over whitespace is a round trip
    // that can only ever answer null.
    const word = view.state.wordAt(pos);
    if (!word) return null;
    let hover: Hover | null = null;
    try {
      hover = await client.hover(uri, offsetToPosition(view.state.doc, pos));
    } catch {
      return null;
    }
    const text = documentationText(hover?.contents);
    if (!text) return null;
    return {
      pos: word.from,
      end: word.to,
      above: true,
      create: () => ({ dom: textPanel([text]) }),
    };
  });
}

// ---- signature help ----

interface SignatureState {
  pos: number;
  help: SignatureHelp;
}

const setSignature = StateEffect.define<SignatureState | null>();

const signatureField = StateField.define<SignatureState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSignature)) return effect.value;
    }
    if (!value) return null;
    // Keep the tooltip anchored to the call it belongs to as the argument list
    // grows underneath it.
    return tr.docChanged ? { ...value, pos: tr.changes.mapPos(value.pos) } : value;
  },
  provide: (field) =>
    showTooltip.from(field, (value): Tooltip | null =>
      value
        ? {
            pos: value.pos,
            above: true,
            create: () => ({ dom: signatureDom(value.help) }),
          }
        : null
    ),
});

/**
 * The signature line, with the parameter the cursor is on emphasised.
 *
 * The emphasis is found by matching the parameter's label inside the signature
 * label, which is what the server sends (an offset pair is the other legal LSP
 * form and this server does not use it). A parameter that cannot be located is
 * simply not emphasised rather than mis-emphasised.
 */
function signatureDom(help: SignatureHelp): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'cm-lsp-signature';
  const signature = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  if (!signature) return dom;

  const line = document.createElement('div');
  line.className = 'cm-lsp-signature-label';
  const active = signature.parameters?.[help.activeParameter ?? 0];
  const at = active ? signature.label.indexOf(active.label) : -1;
  if (active && at >= 0) {
    line.appendChild(document.createTextNode(signature.label.slice(0, at)));
    const strong = document.createElement('span');
    strong.className = 'cm-lsp-signature-active';
    strong.textContent = active.label;
    line.appendChild(strong);
    line.appendChild(document.createTextNode(signature.label.slice(at + active.label.length)));
  } else {
    line.textContent = signature.label;
  }
  dom.appendChild(line);

  const detail = documentationText(active?.documentation) || documentationText(signature.documentation);
  if (detail) {
    const block = document.createElement('div');
    block.className = 'cm-lsp-doc-block';
    block.textContent = detail;
    dom.appendChild(block);
  }
  return dom;
}

/**
 * Document synchronisation, plus the signature-help trigger.
 *
 * didOpen/didClose live on the view's own lifecycle rather than in React,
 * because CodeEditor keeps one view per document and destroys it exactly when
 * the tab closes — which is precisely when the server should forget the file.
 */
function syncPlugin(client: LspClient, uri: string, project: string) {
  return ViewPlugin.define((view) => {
    client.didOpen(uri, project, view.state.doc.toString());
    return {
      update(update: ViewUpdate) {
        if (update.docChanged) {
          // startState.doc, not state.doc: every range in the change set is in
          // the coordinates of the document the change set was built against.
          client.didChange(uri, update.changes, update.startState.doc, update.state.doc);
        }
        maybeSignature(client, uri, update);
      },
      destroy() {
        client.didClose(uri);
      },
    };
  });
}

/**
 * Open, move or close the signature tooltip in response to typing.
 *
 * The server's declared triggers are `(` and `,`. A `)` closes the call, and so
 * closes the tooltip; anything else leaves it where it is, so the tooltip
 * survives typing an argument.
 */
function maybeSignature(client: LspClient, uri: string, update: ViewUpdate): void {
  if (!update.docChanged) return;
  const head = update.state.selection.main.head;
  const typed = update.state.sliceDoc(Math.max(0, head - 1), head);
  const view = update.view;
  if (typed === ')' || typed === '\n') {
    if (update.state.field(signatureField, false)) {
      // Deferred: CodeMirror forbids dispatching from inside a view update, and
      // does so by throwing — this is not a style point.
      queueMicrotask(() => view.dispatch({ effects: setSignature.of(null) }));
    }
    return;
  }
  if (typed !== '(' && typed !== ',') return;
  void client
    .signatureHelp(uri, offsetToPosition(update.state.doc, head))
    .then((help) => {
      if (!help || help.signatures.length === 0) {
        view.dispatch({ effects: setSignature.of(null) });
        return;
      }
      // The document may have moved on during the round trip; anchoring to the
      // live head keeps the tooltip under the cursor rather than where it was.
      view.dispatch({ effects: setSignature.of({ pos: view.state.selection.main.head, help }) });
    })
    .catch(() => {
      /* no signature is a normal answer, and a dead socket is the transport's problem */
    });
}

/**
 * Tooltip and popup chrome.
 *
 * Colours come from the design tokens — the suite rule is no hex outside
 * index.css, and that applies to CodeMirror themes as much as to CSS files.
 */
const lspTheme = EditorView.theme({
  '.cm-tooltip': {
    // `--glass-panel`, NOT `--surface`. A tooltip floats OVER CODE, and on the
    // two glass packs `--surface` is the pack's own film,
    // `rgba(255,255,255,0.10)` — so the hover card was 10% opaque and the
    // lines underneath read straight through the documentation on top of them
    // (Nigel, 04/09/2026: "the hover over information display here needs to be
    // more solid as its not readable right now").
    //
    // `--glass-panel` is that same film ALREADY COMPOSITED over the page and
    // re-emitted at 94%: dense enough to hide what is behind it, and on a
    // solid pack it is simply the surface colour. It is what the command
    // palette and the dialogs already use, for exactly this reason — the
    // tooltip was the one floating layer that never got it.
    backgroundColor: 'var(--glass-panel)',
    backdropFilter: 'var(--blur-panel)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-light)',
    borderRadius: 'var(--radius)',
    // A shadow as well as a fill: over code, an edge alone does not separate
    // the card from the text it covers.
    boxShadow: 'var(--shadow-popup)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-mono)',
    maxHeight: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-primary-bg)',
    color: 'var(--text-primary)',
  },
  '.cm-completionDetail': {
    color: 'var(--text-muted)',
    fontStyle: 'normal',
    marginLeft: 'var(--space-2)',
  },
  '.cm-lsp-doc, .cm-lsp-signature': {
    padding: 'var(--space-2)',
    maxWidth: '46em',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    lineHeight: '1.5',
    whiteSpace: 'pre-wrap',
  },
  '.cm-lsp-doc-block + .cm-lsp-doc-block': {
    marginTop: 'var(--space-2)',
    color: 'var(--text-secondary)',
  },
  '.cm-lsp-signature-active': {
    color: 'var(--accent-primary)',
    fontWeight: '600',
  },
});

// ---- navigation ----

/**
 * The workspace's request to open a place the server named.
 *
 * A window event, for the same reason the reveal event is one: the editor owns
 * its CodeMirror views and the thing that can open a script is five components
 * away, so the alternative is threading an imperative handle through everything
 * in between. See `Workspace#openLocation`, which is the only listener.
 */
export interface OpenLocationDetail {
  /** `ignition://<project>/<path>[#key]`, straight from the server. */
  uri: string;
  line: number;
  character: number;
}

/** The workspace's request to list every place a name is written. */
export interface FindReferencesDetail {
  name: string;
}

export const OPEN_LOCATION_EVENT = 'scriptide:open-location';
export const FIND_REFERENCES_EVENT = 'scriptide:find-references';

/**
 * Go to the definition of the name at `pos`.
 *
 * Answering nothing is the COMMON case and must stay silent: a platform call
 * like `system.tag.readBlocking` has no source file on this gateway, and a
 * dialog saying so on every F12 over a `system.` call would train people out of
 * pressing it. Hover already carries that documentation.
 */
async function goToDefinition(view: EditorView, client: LspClient, uri: string, pos: number) {
  let targets: Array<{ uri: string; range: { start: { line: number; character: number } } }> = [];
  try {
    targets = await client.definition(uri, offsetToPosition(view.state.doc, pos));
  } catch {
    return;
  }
  const target = targets[0];
  if (!target) return;
  window.dispatchEvent(
    new CustomEvent<OpenLocationDetail>(OPEN_LOCATION_EVENT, {
      detail: {
        uri: target.uri,
        line: target.range.start.line,
        character: target.range.start.character,
      },
    })
  );
}

/**
 * Go-to-definition and find-references on one view.
 *
 * **Ctrl/Cmd-click is bound on `mousedown`, not `click`.** By the time a click
 * fires CodeMirror has already moved the selection to the pointer, so the
 * position is still right — but the browser has also begun a drag-select, and
 * releasing over another line leaves a stray selection behind on a gesture the
 * user meant as a jump. Handling mousedown and returning true suppresses that.
 *
 * The word under the cursor is taken from `wordAt`, not from a dotted name:
 * references are name-based (see `LspClient#references`) and the name is the
 * last segment. `util.compute` and `self.compute` are both a reference to
 * `compute`, and the server is not being asked to pretend otherwise.
 */
function lspNavigation(client: LspClient, uri: string): Extension {
  return [
    keymap.of([
      {
        key: 'F12',
        preventDefault: true,
        run: (view) => {
          void goToDefinition(view, client, uri, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: 'Shift-F12',
        preventDefault: true,
        run: (view) => {
          const word = view.state.wordAt(view.state.selection.main.head);
          if (!word) return true;
          window.dispatchEvent(
            new CustomEvent<FindReferencesDetail>(FIND_REFERENCES_EVENT, {
              detail: { name: view.state.sliceDoc(word.from, word.to) },
            })
          );
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        // Only over a word: a Ctrl-click on whitespace is someone placing a
        // multi-cursor, which is what the default handler would have done.
        if (!view.state.wordAt(pos)) return false;
        void goToDefinition(view, client, uri, pos);
        return true;
      },
    }),
  ];
}

/**
 * Everything the language client contributes to one editor view.
 *
 * @param client the shared client — one per app, not one per view
 * @param ref which script this view holds
 */
export function lspExtension(client: LspClient, ref: LspDocumentRef): Extension {
  const uri = lspUri(ref.project, ref.path, ref.scriptKey);
  return [
    lspNavigation(client, uri),
    autocompletion({
      activateOnTyping: true,
      closeOnBlur: true,
      icons: true,
      // Explicit list, so the gateway's answer is the only one after a dot —
      // see the file comment.
      override: [
        completionSource(client, uri, ref.project),
        bareWordOnly(localCompletionSource),
        bareWordOnly(globalCompletion),
      ],
    }),
    lspHover(client, uri),
    signatureField,
    keymap.of([
      {
        key: 'Escape',
        run: (view) => {
          if (!view.state.field(signatureField, false)) return false;
          view.dispatch({ effects: setSignature.of(null) });
          return true;
        },
      },
    ]),
    syncPlugin(client, uri, ref.project),
    lspTheme,
  ];
}
