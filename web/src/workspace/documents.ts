/**
 * The open-document model.
 *
 * One document is one script body the user has opened. `baseText` is what the
 * gateway last agreed to (the last read, or the last successful save) and `text`
 * is what the editor holds, so `dirty` is a derivation rather than a flag that
 * can drift out of step with the buffer.
 */
import { languageFor, type DocLanguage } from './docLanguage';
import type { ScriptEntry, ScriptOrigin } from '../api/scripts';
import type { NamedQueryEntry, NamedQuerySettings } from '../api/namedQueries';

/**
 * Where a DOCUMENT comes from — a superset of {@link ScriptOrigin}.
 *
 * `'new'` has no equivalent on the server: it means this buffer was opened
 * without ever reading a resource, because none exists yet. Clicking an absent
 * Startup/Shutdown/Update row is the only way to reach it — see {@link
 * newUnsavedDoc}. The resource is created on the FIRST save, exactly like the
 * "New script…" dialog's own create, and {@link OpenDoc.origin} moves to
 * `'local'` the moment that succeeds (see `commitSaved` in Workspace.tsx).
 */
export type DocOrigin = ScriptOrigin | 'new';

/**
 * What a tab holds.
 *
 * A tab strip does not care what is in it (NAMED-QUERIES.md §3), so a named
 * query is an ordinary document with a different `kind` rather than a second
 * document model. The kind is what decides three things and nothing else: which
 * CodeMirror surface the buffer gets, whether the language server is attached,
 * and whether the settings half of {@link isDirty} applies.
 */
export type DocKind = 'script' | 'named-query' | 'tag' | 'console' | 'query-browser';

export interface OpenDoc {
  /**
   * `'script'` for everything this IDE edited before 1.7.0.
   *
   * Required rather than optional on purpose: every construction site states
   * it, so a new one cannot inherit a default that happens to be wrong for it.
   */
  kind: DocKind;
  /** Stable key: project + resource path. A script is per-project, not global. */
  uri: string;
  project: string;
  path: string;
  /**
   * The `.py` data key to write back to — the resource's own, from the listing.
   * Part of the document's identity: see docUri.
   */
  scriptKey: string;
  typeLabel: string;
  /** Short name for the tab strip. */
  label: string;
  /**
   * Which grammar the editor should use, and whether the Jython language
   * server applies at all.
   *
   * Absent means Python, which is what every document was before 1.9.0. Only
   * a `'python'` document gets completions, diagnostics and the problem ruler
   * — asking a Jython parser to check a 65 KB HTML file produces an error on
   * every line, which is worse than no checking.
   */
  language?: DocLanguage;
  origin: DocOrigin;
  /** Resource signature this edit is based on; the If-Match for the next save. */
  etag: string;
  /** The text as last agreed with the gateway. */
  baseText: string;
  /** The text in the editor right now. */
  text: string;
  /**
   * The user has explicitly overridden this inherited script in this tab.
   *
   * Meaningless on a local or already-overridden script; the ONLY thing it does
   * is unlock an `inherited` document. See {@link isLockedByInheritance}.
   */
  overridden: boolean;
  /**
   * Named queries only: the settings as edited, and as the gateway last agreed
   * to them.
   *
   * ONE etag covers both halves — the contract saves SQL and settings against
   * the same resource signature — so `etag` is not duplicated here. Both are
   * absent on a script document.
   */
  settings?: NamedQuerySettings;
  baseSettings?: NamedQuerySettings;
  /** The gateway's database connections, for the Settings tab's dropdown. */
  databases?: string[];
  /** Settings keys the server will accept; empty means all of them. */
  editableSettings?: string[];
  /**
   * A version-1 named query, which the PLATFORM cannot read either.
   *
   * Not cosmetic: `runNamedQuery` NPEs on one and its settings come back as the
   * defaults, so the editor must say why the form looks empty. Saving through
   * the ordinary path is the repair — the server rewrites it through
   * `toResource`, which stamps version 2.
   */
  legacy?: boolean;
  /**
   * Tags only: what the editor shows beside the buffer. `text` is the tag's OWN
   * overrides; `resolved` is the full configuration with inherited and default
   * values, which the property form needs to show what an override would hide.
   */
  tag?: TagDocInfo;
}

export interface TagDocInfo {
  /** `AtomicTag`, `Folder`, `UdtInstance`, `UdtType`. */
  tagType: string;
  /** Pretty JSON of the full configuration, as last read. */
  resolved: string;
  /**
   * What each property would be with no local override — the UDT definition's
   * value for a member or instance, empty for a standalone tag. The property
   * form shows these, dimmed, for every property the buffer does not set.
   */
  inherited: Record<string, unknown>;
}

/** The editor-side half of a tag's edit read. */
export function tagDocInfo(info: { tagType: string; resolved: string; inherited?: unknown }): TagDocInfo {
  const inherited = info.inherited;
  return {
    tagType: info.tagType,
    resolved: prettyTagJson(info.resolved),
    // Absent from a gateway that predates the field; a non-object is not trusted.
    inherited: inherited && typeof inherited === 'object' && !Array.isArray(inherited)
      ? inherited as Record<string, unknown>
      : {},
  };
}

/**
 * True when the Jython language server applies to this document.
 *
 * The gate for completions, diagnostics, the problem ruler and go-to-definition
 * — everything the server answers. It is a JYTHON server: pointed at the HTML
 * of a Web Dev text resource it parses the markup as Python and publishes a
 * syntax error on every line, which is a worse answer than none.
 *
 * Language absent means Python: that is what every document was before 1.9.0,
 * and a construction site that forgets the field must not silently lose its
 * language server.
 */
export function isPythonDoc(doc: OpenDoc): boolean {
  return doc.kind === 'script' && (doc.language ?? 'python') === 'python';
}

/**
 * True when this document must not be edited because it is inherited from a
 * parent project and the user has not asked to override it.
 *
 * **Measured off the real Designer (8.3.8, 01/09/2026), not inferred.** An
 * inherited Project Library script there cannot be opened by double-clicking at
 * all: the context menu offers `Override Resource`, `Copy Path` and
 * `Open read-only`, and the last of those opens an editor headed
 * `Chart  (Read-Only)` whose buffer discards every keystroke. Only after
 * `Override Resource` does the header lose the suffix and the buffer accept
 * typing.
 *
 * This module opened inherited scripts straight into a writable buffer until
 * 1.4.0 and created the override silently on the first save — the opposite of
 * the Designer's "you must ask for it" model, and a way to fork a parent's
 * script by leaning on the keyboard.
 */
export function isLockedByInheritance(doc: OpenDoc): boolean {
  return doc.origin === 'inherited' && !doc.overridden;
}

/**
 * Every reason a buffer refuses keystrokes.
 *
 * One reason today, asked in one place on purpose: the editor and the tab strip
 * must agree, and they only do that if a second reason has a single function to
 * be added to rather than two call sites to be remembered at.
 */
export function isReadOnlyDoc(doc: OpenDoc): boolean {
  return isLockedByInheritance(doc);
}

/**
 * Why this buffer is read-only, in the words the tab shows.
 *
 * The Designer's own suffix for an inherited script is `(Read-Only)`, measured
 * — see above — so it is not ours to reword.
 */
export function readOnlyReason(doc: OpenDoc): string | null {
  return isLockedByInheritance(doc) ? 'Read-Only' : null;
}

/**
 * Documents are keyed by project, path AND data key.
 *
 * Project, because the same `ignition/startup` exists in every project and
 * keying on the path alone would silently alias them.
 *
 * The DATA KEY, because a Web Dev endpoint is one resource path holding up to
 * eight scripts — `doGet.py`, `doPost.py` and so on. Without it, opening doPost
 * on an endpoint whose doGet is already open finds the existing tab, shows the
 * WRONG script, and the next save writes doGet's buffer over doPost. Every other
 * resource has exactly one script, so its key never varies and the third segment
 * is stable for them.
 */
export function docUri(project: string, path: string, scriptKey?: string): string {
  return scriptKey ? `${project}::${path}::${scriptKey}` : `${project}::${path}`;
}

/**
 * Normalise a resource signature for comparison.
 *
 * The same signature reaches this app by two routes — the listing's
 * `signature` field and a content read's `ETag` header — and a caching proxy is
 * entitled to add quotes or a `W/` prefix to the header one. Comparing them raw
 * makes every document look stale forever.
 */
export function sameSignature(a: string | undefined, b: string | undefined): boolean {
  const bare = (value: string | undefined) =>
    (value ?? '').trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  return bare(a) === bare(b);
}

/**
 * True when the gateway's copy has moved on from what this tab was opened at.
 *
 * The case this exists for: a script edited in the DESIGNER while it sits open
 * here (03/09/2026 — "The change did not show up"). Nothing was ever at
 * risk of being silently overwritten, because the save carries `If-Match` and
 * the gateway answers 409 — but a conflict dialog at save time is a late and
 * disruptive way to learn something you would have wanted to know before you
 * started typing.
 *
 * `signature` is whatever the listing currently reports for this resource;
 * `undefined` means the resource is not in the listing at all, which is a
 * DELETION rather than a staleness and is not this function's business. A
 * `'new'` document has no gateway copy to be stale against.
 */
export function isStale(doc: OpenDoc, signature: string | undefined): boolean {
  if (doc.origin === 'new' || signature === undefined) return false;
  return !sameSignature(doc.etag, signature);
}

/**
 * True when the buffer differs from what the gateway last agreed to.
 *
 * A `'new'` document is ALWAYS dirty, even with an empty buffer: nothing has
 * been agreed with the gateway at all — there is no resource yet for
 * `baseText` to be "the last read of" — so text-equality would say "clean" for
 * a document that, if closed right now, discards a script nobody has created.
 *
 * For a named query the SETTINGS count too. They are half the resource and they
 * are saved by the same Ctrl+S against the same signature, so a document whose
 * SQL is untouched and whose cache unit has been changed is dirty — otherwise
 * the Save button is disabled over an edit the user can see on screen.
 */
export function isDirty(doc: OpenDoc): boolean {
  if (doc.origin === 'new' || doc.text !== doc.baseText) return true;
  if (doc.kind !== 'named-query') return false;
  // A LEGACY query is always dirty, for the same reason a `'new'` draft is:
  // what the gateway holds is not what this document represents. Its settings
  // read back as the platform's defaults because the platform cannot read the
  // resource at all, and saving is the repair — so a Save button disabled by
  // text-equality would leave the editor's own "saving it converts it" notice
  // pointing at a control that does nothing.
  if (doc.legacy) return true;
  return !settingsEqual(doc.settings, doc.baseSettings);
}

/**
 * Deep equality for a settings object.
 *
 * Structural rather than a JSON.stringify compare, which is what the script
 * attributes strip can afford: those two objects come from one server response
 * and only ever have VALUES replaced, so their key order is stable. A query's
 * parameter and permission rows are rebuilt by the UI, in this file's key order
 * rather than the server's, and stringify would then report every read-back
 * document as dirty.
 */
export function settingsEqual(
  a: NamedQuerySettings | undefined,
  b: NamedQuerySettings | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type
    && a.enabled === b.enabled
    && a.database === b.database
    && a.description === b.description
    && a.fallbackEnabled === b.fallbackEnabled
    && a.fallbackValue === b.fallbackValue
    && a.useMaxReturnSize === b.useMaxReturnSize
    && a.maxReturnSize === b.maxReturnSize
    && a.cacheEnabled === b.cacheEnabled
    && a.cacheAmount === b.cacheAmount
    && a.cacheUnit === b.cacheUnit
    && a.autoBatchEnabled === b.autoBatchEnabled
    && a.permissions.length === b.permissions.length
    && a.permissions.every((row, i) => row.zone === b.permissions[i].zone
      && row.role === b.permissions[i].role)
    && a.parameters.length === b.parameters.length
    && a.parameters.every((row, i) => row.type === b.parameters[i].type
      && row.identifier === b.parameters[i].identifier
      && row.sqlType === b.parameters[i].sqlType)
  );
}

/**
 * The synthetic data key a Web Dev text resource's body is addressed by.
 *
 * Must match `WebDevResources.TEXT_DATA_KEY` on the gateway. It is not a real
 * data key — the body is a string inside `config.json` — and the read and write
 * routes translate it. See that class for why the addressing works this way.
 */
export const WEBDEV_TEXT_KEY = 'config.json#text';

/** A file extension to show a MIME type as, for a tab label. */
function extensionFor(contentType: string | undefined): string {
  switch (languageFor({ dataKey: '', contentType })) {
    case 'html': return 'html';
    case 'javascript': return 'js';
    case 'css': return 'css';
    case 'json': return 'json';
    default: return 'txt';
  }
}

/**
 * Tab label. A singleton (startup/shutdown/update) has an empty name, so its
 * type label is the only thing that identifies it.
 */
export function labelFor(entry: ScriptEntry): string {
  // A Web Dev endpoint's tabs must say WHICH file they are, or eight tabs on
  // one endpoint all read the same. Three cases now, not one: a verb handler,
  // a static file the endpoint carries, and a text resource whose body has no
  // filename at all — that last one is named after its MIME type, because
  // `cell3d/config.json#text` is the synthetic key and nobody should see it.
  if (entry.typeId === 'resources') {
    if (entry.scriptKey === WEBDEV_TEXT_KEY) {
      return `${entry.name}.${extensionFor(entry.contentType)}`;
    }
    return `${entry.name}/${entry.scriptKey.replace(/\.py$/, '')}`;
  }
  return entry.name && entry.name.length > 0 ? entry.name : entry.typeLabel;
}

/** Build a document from a tree entry and the body just read for it. */
export function newDoc(entry: ScriptEntry, project: string, text: string, etag: string): OpenDoc {
  return {
    uri: docUri(project, entry.path, entry.scriptKey),
    kind: 'script',
    project,
    path: entry.path,
    scriptKey: entry.scriptKey,
    typeLabel: entry.typeLabel,
    label: labelFor(entry),
    language: languageFor({ dataKey: entry.scriptKey, contentType: entry.contentType }),
    origin: entry.origin,
    // The listing's signature is a usable fallback, but the read's ETag is the
    // authority: the listing may have been fetched minutes ago.
    etag: etag || entry.signature,
    baseText: text,
    text,
    // Always false on open, whatever the origin. An override is a gesture, and
    // a document that starts overridden is a document nobody chose to fork.
    overridden: false,
  };
}

/**
 * Open a DRAFT for a singleton that does not exist on the gateway yet.
 *
 * The real Designer creates nothing until the user saves — clicking an absent
 * Startup/Shutdown/Update row there just opens an empty editor. Before 1.5.0
 * this module called `createScript` on the click itself, which meant browsing
 * the tree could add resources (and git diffs) to a live project with no
 * confirmation and no save. This is the fix: an ordinary buffer with no
 * gateway-agreed text and no ETag, `origin: 'new'`, that only becomes a real
 * resource on the first save (through the ordinary create path — see
 * ScriptResourceRouteHandler#write, which takes the create branch whenever the
 * resource does not already exist, base signature or none). Closing the tab
 * without saving discards it; nothing was ever written.
 */
export function newUnsavedDoc(params: {
  project: string;
  path: string;
  scriptKey: string;
  typeLabel: string;
  label: string;
}): OpenDoc {
  return {
    uri: docUri(params.project, params.path, params.scriptKey),
    kind: 'script',
    project: params.project,
    path: params.path,
    scriptKey: params.scriptKey,
    typeLabel: params.typeLabel,
    label: params.label,
    origin: 'new',
    // No ETag: there is nothing on the gateway yet to match against, and the
    // write route does not ask for one on its create branch.
    etag: '',
    baseText: '',
    text: '',
    overridden: false,
  };
}

/**
/** The single data key a named-query resource carries. */
export const QUERY_DATA_KEY = 'query.sql';

/**
 * Build a document for a named query from its listing entry and the SQL and
 * settings just read for it.
 *
 * `path` here is the query's path INSIDE the project — `Folder/Sub/Name`, the
 * string `system.db.runNamedQuery` takes — not a resource path. That is what
 * the routes take and what the tab is addressed by.
 */
export function newQueryDoc(params: {
  entry: NamedQueryEntry;
  project: string;
  sql: string;
  etag: string;
  settings: NamedQuerySettings;
  databases?: string[];
  editableSettings?: string[];
  legacy?: boolean;
}): OpenDoc {
  const { entry, project } = params;
  return {
    uri: docUri(project, entry.path, QUERY_DATA_KEY),
    kind: 'named-query',
    project,
    path: entry.path,
    // The resource's one data key, and a real one — the content route reads
    // `query.sql` rather than `NamedQuery.getQuery()`, which is what lets a
    // legacy resource still open. Keeping it in the URI also makes a collision
    // with a script impossible: no script's key is ever `query.sql`, and a query
    // path carries no `ignition/` prefix to collide on in the first place.
    scriptKey: QUERY_DATA_KEY,
    typeLabel: 'Named Query',
    label: entry.name || namedQueryLabel(entry.path),
    origin: entry.origin,
    // The read's ETag is the authority; the listing's signature may be minutes
    // old, and is only a fallback for a listing-only open.
    etag: params.etag || entry.signature,
    baseText: params.sql,
    text: params.sql,
    overridden: false,
    settings: params.settings,
    baseSettings: params.settings,
    databases: params.databases ?? [],
    editableSettings: params.editableSettings ?? [],
    legacy: params.legacy === true,
  };
}

/** The tab label for a query path — its last segment. */
export function namedQueryLabel(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * A tag document's key.
 *
 * Tags are gateway-wide, not per project, so the project segment the other
 * kinds carry would be a lie. `tag::` cannot collide with a script or a query:
 * those are `<project>::<resource path>`, and a resource path never starts with
 * `[` the way every tag path does.
 */
export function tagDocUri(tagPath: string): string {
  return `tag::${tagPath}`;
}

/** The data key a tag document is filed under — never sent anywhere. */
export const TAG_DATA_KEY = 'tag.json';

/**
 * Two-space JSON, so the buffer reads the way the Designer's own JSON view does.
 *
 * Text that does not parse is returned as it came: a reformat must never be the
 * thing that loses what the gateway sent.
 */
export function prettyTagJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** A tag's leaf name — the provider's name for a provider root. */
export function tagLabel(tagPath: string): string {
  const close = tagPath.indexOf(']');
  const rest = close >= 0 ? tagPath.slice(close + 1) : tagPath;
  if (rest === '') return close > 0 ? tagPath.slice(1, close) : tagPath;
  return rest.split('/').filter(Boolean).pop() ?? rest;
}

const TAG_TYPE_LABELS: Record<string, string> = {
  AtomicTag: 'Tag',
  Folder: 'Folder',
  UdtInstance: 'UDT Instance',
  UdtType: 'UDT Definition',
  Provider: 'Tag Provider',
};

/** The tag's object type in words, for the tab and the editor header. */
export function tagTypeLabel(tagType: string): string {
  return TAG_TYPE_LABELS[tagType] ?? tagType;
}

/**
 * True for a document that is a project resource: a script or a named query.
 *
 * The gate for everything that only means something for a file in a project —
 * presence, staleness against the listing, the CodeMirror buffer. A tag is
 * gateway-wide and a tool tab is no resource at all.
 */
export function isProjectResourceDoc(doc: OpenDoc): boolean {
  return doc.kind === 'script' || doc.kind === 'named-query';
}

/**
 * The Script Console and the Query Browser, as editor tabs.
 *
 * 16/10/2026: in the bottom panel both were "just too small to use", so they
 * open beside scripts and tags, full height, in either pane. A tool tab is a
 * document only so the tab strip and the pane rules can carry it: it has no
 * buffer of its own (`text` and `baseText` stay empty, so it is never dirty),
 * is never saved, and its state lives in the tool's component — see
 * `toolTabs.tsx` for how that survives tab switches and pane moves.
 */
export type ToolId = 'console' | 'query';

const TOOLS: Record<ToolId, { kind: DocKind; label: string; typeLabel: string }> = {
  console: { kind: 'console', label: 'Script Console', typeLabel: 'Script Console' },
  query: { kind: 'query-browser', label: 'Query', typeLabel: 'Database Query Browser' },
};

/**
 * A tool tab's key. Fixed, because each tool is a singleton: a second Script
 * Console tab would be a second REPL that looks the same and shares nothing.
 * Two segments, so it cannot collide with a script or query, whose uris carry
 * a third (the data key) — even in a project named `tool`.
 */
export function toolDocUri(tool: ToolId): string {
  return `tool::${tool}`;
}

/** True for a Script Console or Query Browser tab. */
export function isToolDoc(doc: OpenDoc): boolean {
  return doc.kind === 'console' || doc.kind === 'query-browser';
}

/** Which tool a tab is, or null for a resource. */
export function toolOf(doc: OpenDoc | null | undefined): ToolId | null {
  if (!doc) return null;
  if (doc.kind === 'console') return 'console';
  if (doc.kind === 'query-browser') return 'query';
  return null;
}

/** Build the tab for a tool. */
export function newToolDoc(tool: ToolId): OpenDoc {
  const spec = TOOLS[tool];
  return {
    uri: toolDocUri(tool),
    kind: spec.kind,
    // Not a project resource: the console picks its own project and the Query
    // Browser runs against a datasource.
    project: '',
    path: '',
    scriptKey: '',
    typeLabel: spec.typeLabel,
    label: spec.label,
    origin: 'local',
    etag: '',
    baseText: '',
    text: '',
    overridden: false,
  };
}

/**
 * Whether the outline rail is on screen.
 *
 * The outline is the Jython symbol table, so for a query, a tag or a tool it
 * is an empty column taking room the editor could use. The user's own
 * open/closed choice is only READ here, never written, so it comes back as it
 * was when a script is active again. No document at all keeps the choice too:
 * there is nothing that the room would go to.
 */
export function outlineVisible(preference: boolean, active: OpenDoc | null): boolean {
  return preference && (active === null || active.kind === 'script');
}

/** Build a document for one tag from the gateway's edit read. */
export function newTagDoc(params: {
  path: string;
  local: string;
  resolved: string;
  signature: string;
  tagType: string;
  inherited?: unknown;
}): OpenDoc {
  const text = prettyTagJson(params.local);
  return {
    uri: tagDocUri(params.path),
    kind: 'tag',
    // No project: a tag lives in a provider, which every project shares.
    project: '',
    path: params.path,
    scriptKey: TAG_DATA_KEY,
    typeLabel: tagTypeLabel(params.tagType),
    label: tagLabel(params.path),
    // Tags have no project inheritance; a UDT member's inherited values are a
    // property-level matter for the editor, not a lock on the document.
    origin: 'local',
    etag: params.signature,
    baseText: text,
    text,
    overridden: false,
    tag: tagDocInfo(params),
  };
}
