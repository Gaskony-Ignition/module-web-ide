/**
 * The P1 editor workspace: project picker, script tree, tabs, editor, attribute
 * strip, and the conflict path.
 *
 * All mutable state for an open script lives in one place — the `docs` array —
 * because the alternative (state inside CodeMirror, a dirty flag beside it, an
 * ETag somewhere else) has three copies of the truth and no way to tell which is
 * right after a failed save. `dirty` is derived, and a save updates `baseText`
 * and `etag` together or not at all.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  createScript,
  deleteScript,
  fetchProjects,
  fetchScriptTree,
  renameScript,
  readScriptAttributes,
  readScriptContent,
  saveScriptAttributes,
  saveScriptContent,
  type AttributeValue,
  type ProjectSummary,
  type ScriptEntry,
  type ScriptTree,
  type ScriptTypeId,
} from '../api/scripts';
import {
  createNamedQuery,
  deleteNamedQuery,
  fetchNamedQueries,
  isNamedQueryResourcePath,
  stripResourcePrefix,
  readNamedQuerySettings,
  readNamedQuerySql,
  renameNamedQuery,
  saveNamedQuerySettings,
  saveNamedQuerySql,
  type NamedQueryEntry,
  type NamedQueryList,
  type NamedQuerySettings,
} from '../api/namedQueries';
import { organiseImports, type ImportSuggestion } from '../api/imports';
import { lspUri, sharedLspClient } from '../api/lspClient';
import { sharedTransport } from '../api/lspTransport';
import type { SessionInfo } from '../api/session';
import CodeEditor from '../components/CodeEditor';
import ConfigStrip from '../components/ConfigStrip';
import ConflictDialog from '../components/ConflictDialog';
import TestsPanel from '../components/TestsPanel';
import ActivityBar, { type PanelId, type ViewId } from '../components/ActivityBar';
import FileTree from '../components/FileTree';
import { IconAlert, IconExternal, IconPlus } from '../components/Icons';
import LayoutControls, { type LayoutState } from '../components/LayoutControls';
import Panel from '../components/Panel';
import Resizer from '../components/Resizer';
import ContextMenu from '../components/ContextMenu';
import ImportDialog from '../components/ImportDialog';
import {
  applyImport,
  exportScripts,
  inspectImport,
  saveBlob,
  type ImportInspection,
  type ImportOutcome,
} from '../api/transfer';
import { insertImportAtTopOfBlock } from './insertImport';
import { rememberWidth, storedHeight, storedWidth } from './layoutStore';
import TerminalView from '../components/Terminal';
import WebDevConfigDialog from '../components/WebDevConfigDialog';
import WebDevTree from '../components/WebDevTree';
import NamedQueryDialog from '../components/NamedQueryDialog';
import NamedQueryEditor, { showsBuffer, type QueryTab } from '../components/NamedQueryEditor';
import NamedQueryTree from '../components/NamedQueryTree';
import NewScriptDialog from '../components/NewScriptDialog';
import OutlinePanel from '../components/OutlinePanel';
import ProblemsPanel from '../components/ProblemsPanel';
import QuickOpen from '../components/QuickOpen';
import HistoryDialog from '../components/HistoryDialog';
import ParentDiffDialog from '../components/ParentDiffDialog';
import RenameDialog from '../components/RenameDialog';
import SearchPanel from '../components/SearchPanel';
import ScriptConsole from '../components/ScriptConsole';
import type { ActiveSource } from '../components/ScriptConsole';
import QueryBrowser from '../components/QueryBrowser';
import StatusFooter from '../components/StatusFooter';
import TabStrip from '../components/TabStrip';
import { PresenceBar } from '../components/Presence';
import { allDrafts, dropDraft, putDraft, type Draft } from './drafts';
import {
  EMPTY_PRESENCE,
  peersOn,
  presenceClient,
  type Peer,
  type PresenceState,
} from '../api/presence';
import { NO_GIT, decorate, gitClient, summarise, type GitState } from '../api/git';
import {
  FIND_REFERENCES_EVENT,
  OPEN_LOCATION_EVENT,
  type FindReferencesDetail,
  type OpenLocationDetail,
} from '../components/lspExtension';
import {
  QUERY_DATA_KEY,
  docUri,
  isDirty,
  isLockedByInheritance,
  isPythonDoc,
  isReadOnlyDoc,
  isStale,
  newDoc,
  newQueryDoc,
  newUnsavedDoc,
  settingsEqual,
  type OpenDoc,
} from './documents';
import {
  entryForLocation,
  labelForLocation,
  moduleNameFor,
  parseLocationUri,
} from './locations';
import {
  describeImpact,
  hasImpact,
  signatureImpact,
} from './signatureImpact';
import {
  runReplaceAll,
  summarise as summariseReplace,
  type ReplaceReport,
  type ReplaceTarget,
} from './replaceAll';
import {
  focusIsRight, forgetInPanes, moveAcross, paneActives, selectInPanes, type PaneState,
} from './panes';
import './Workspace.css';

/**
 * How often to ask the gateway whether anything an open tab is based on has
 * changed underneath it.
 *
 * 20 s is chosen against the cost, not against a guess at how fast people work:
 * it is ONE listing request per interval however many tabs are open, and the
 * focus and visibility listeners beside it already cover the case that actually
 * matters — coming back from the Designer. The timer is only there for a window
 * left on screen beside one.
 */
const WATCH_INTERVAL_MS = 20_000;

export interface WorkspaceProps {
  session: SessionInfo;
}

/** Attribute editing state for one open document. */
interface AttrState {
  /** Names the server will accept. Empty means the strip renders nothing. */
  editable: string[];
  attributes: Record<string, AttributeValue>;
  /** What the gateway last agreed to, so "dirty" is derived here too. */
  base: Record<string, AttributeValue>;
}

interface Conflict {
  uri: string;
  label: string;
  mine: string;
  theirs: string;
  /** The signature the gateway's current copy carries — the base for a force. */
  theirsEtag: string;
  /**
   * The settings half of the gateway's copy, for a named query.
   *
   * Carried on the conflict rather than re-read when "take theirs" is chosen,
   * so what lands in the tab is the same revision the diff was shown against.
   * Without it, taking theirs replaced the SQL and kept the settings the tab
   * opened with — see readCurrent.
   */
  theirsQuery?: Partial<OpenDoc>;
}

type Notice = { kind: 'error' | 'info'; text: string } | null;

/**
 * A remembered panel width.
 *
 * localStorage throws outright in a private window or with site data blocked,
 * so every access is wrapped — a layout preference must never be the thing that
 * stops the IDE loading.
 */
/**
 * How tall the bottom panel opens when nobody has resized it.
 *
 * A fixed 260px was measured CRAMPED on a 1000px viewport in the 02/09/2026
 * review, and it is worse than the number suggests: the panel is what is left
 * after the toolbar (34px), the tab strip, the settings row (69px on an
 * inherited script) and the panel's own 30px head, so a console showed about
 * eight lines and a terminal eleven rows. A share of the viewport keeps roughly
 * the same amount of code and the same amount of output visible whatever the
 * window is, which is what the constant was trying to approximate for one
 * screen size.
 *
 * Clamped at both ends: a laptop must still show usable code above the panel,
 * and a tall monitor should not hand a third of itself to a console nobody has
 * asked to grow. 34% of 1000px is 340px, up from 260.
 */
export function defaultPanelHeight(viewportHeight: number): number {
  return Math.round(Math.min(460, Math.max(240, viewportHeight * 0.34)));
}

export default function Workspace({ session }: WorkspaceProps) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<string>('');
  useEffect(() => {
    document.title = project ? `${project} — Web IDE` : 'Web IDE';
  }, [project]);
  const [tree, setTree] = useState<ScriptTree | null>(null);
  const [treeError, setTreeError] = useState<string>('');
  /**
   * The project's named queries.
   *
   * A SECOND listing rather than a filter over the first: they are a different
   * resource type behind their own routes, and the script listing does not
   * carry them. Fetched with the tree so the Named Queries view and quick open
   * both have them before anyone asks.
   */
  const [queries, setQueries] = useState<NamedQueryList | null>(null);
  const [queriesError, setQueriesError] = useState<string>('');
  /**
   * Which of the three query tabs is showing.
   *
   * One value for the workspace rather than one per document: switching tabs is
   * a mode you are in, and a per-document memory means the same click lands in a
   * different place depending on which query you opened last.
   */
  const [queryTab, setQueryTab] = useState<QueryTab>('authoring');
  const [creatingQuery, setCreatingQuery] = useState(false);
  const [renamingQuery, setRenamingQuery] = useState<NamedQueryEntry | null>(null);
  /**
   * A folder being moved: its path, and the folder RESOURCE if the gateway has
   * one. Most folders are implied by the paths under them and are not resources
   * at all, which is why the rename carries no precondition for those.
   */
  const [renamingFolder, setRenamingFolder] =
    useState<{ folder: string; entry?: NamedQueryEntry } | null>(null);
  const [queryDialogBusy, setQueryDialogBusy] = useState(false);
  const [queryDialogError, setQueryDialogError] = useState<string | null>(null);
  const [pendingQueryDelete, setPendingQueryDelete] = useState<NamedQueryEntry | null>(null);
  const [docs, setDocs] = useState<OpenDoc[]>([]);
  const [activeUri, setActiveUri] = useState<string | null>(null);
  /**
   * Documents shown in the SECOND editor pane.
   *
   * 03/09/2026: *"I'm not seeing a way to split the screen between 2 or
   * more scripts so that I can do comparisons or copy and paste between."*
   *
   * A document lives in exactly ONE pane, and splitting MOVES it rather than
   * duplicating it. That is a smaller feature than VS Code's and it is the
   * honest one here: `CodeEditor` keeps one `EditorView` per document —
   * deliberately, so scroll and undo survive a tab switch — and two views over
   * one document would need the buffer synchronised between them on every
   * keystroke, which is a whole editing model rather than a layout.
   *
   * An empty set means one pane. There is no separate "is split" flag, because
   * a flag and the set behind it drift apart.
   */
  const [splitUris, setSplitUris] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The active document in whichever pane is NOT focused.
   *
   * `activeUri` stays what it always was — the document you are working in, and
   * the one the outline, Problems, the config strip and "Run file" all describe.
   * Which pane that is falls out of `splitUris`, so the two can never disagree.
   */
  const [otherActive, setOtherActive] = useState<string | null>(null);

  /**
   * Select a tab, in either pane.
   *
   * Crossing between panes moves the focus AND parks the document you left, so
   * the pane you came from keeps showing what it was showing. Selecting within
   * a pane leaves the other one entirely alone — which is the point of having
   * two.
   */
  // Through refs, and STABLE: every open path calls this, so a callback whose
  // identity changed with `activeUri` would change `openScript`'s identity on
  // every tab switch and re-run everything that depends on it. Assigned during
  // render, exactly as `docsRef` is above.
  const paneStateRef = useRef<PaneState>({ activeUri: null, otherActive: null, split: new Set() });
  paneStateRef.current = { activeUri, otherActive, split: splitUris };

  /** Apply one of the pure pane rules and publish the three pieces it returns. */
  const applyPanes = useCallback((next: PaneState) => {
    // Written through before the state lands, so two calls in one tick — an
    // open followed by a reveal — see each other rather than both acting on the
    // render's value.
    paneStateRef.current = next;
    setActiveUri(next.activeUri);
    setOtherActive(next.otherActive);
    setSplitUris(next.split);
  }, []);

  const selectDoc = useCallback((uri: string) => {
    applyPanes(selectInPanes(paneStateRef.current, uri));
  }, [applyPanes]);

  const [attrs, setAttrs] = useState<Record<string, AttrState>>({});
  const [saving, setSaving] = useState(false);
  /**
   * Documents with a write in flight, keyed by uri.
   *
   * The boolean above drives the Save button's own label; this drives
   * STALENESS, and the two are not the same question. A save writes the
   * resource on the gateway before the client has the new signature back, so
   * for the length of that round trip the background listing legitimately
   * reports a signature the open document does not carry — and every check that
   * asks "has this moved on?" answered yes about the user's own keystroke.
   * 07/09/2026: *"when I click save while it is saving to the gateway a
   * pull request pops up on the script which could be confusing for people. They
   * might think that there is a conflict."*
   */
  const [savingUris, setSavingUris] = useState<ReadonlySet<string>>(() => new Set());

  /** The tree's right-click menu: where it is, and what it acts on. */
  const [treeMenu, setTreeMenu] = useState<
    { x: number; y: number; label: string; paths: string[] } | null
  >(null);
  /**
   * An import in progress, from the file chosen to the report.
   *
   * The FILE is kept, not just what was read out of it: the server holds nothing
   * between inspect and apply, so the second call needs the same bytes. Holding
   * the browser's own File object costs nothing and means the two calls cannot
   * disagree about what was inspected.
   */
  const [importing, setImporting] = useState<
    { file: File; inspection: ImportInspection } | null
  >(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | undefined>(undefined);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const beginSaving = useCallback((uri: string) => {
    setSavingUris((current) => new Set(current).add(uri));
  }, []);

  const endSaving = useCallback((uri: string) => {
    setSavingUris((current) => {
      if (!current.has(uri)) return current;
      const next = new Set(current);
      next.delete(uri);
      return next;
    });
  }, []);
  const [savingAttrs, setSavingAttrs] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /**
   * Suggestions from the last "Organise imports" run, for the document that
   * produced them. Keyed to a URI rather than just "the current suggestions"
   * so switching tabs does not carry one document's offers onto another's
   * buffer, and so closing or organising the same document again drops the
   * stale set rather than leaving an insert button that no longer applies.
   */
  const [importSuggestions, setImportSuggestions] =
    useState<{ uri: string; items: ImportSuggestion[] } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /**
   * The session has ended — a gateway restart, or a timeout.
   *
   * 04/09/2026: *"I was working on some code and tried to save but it
   * came up with an authentication error. This is tricky because i was logged
   * in but something happened in the backend... now I could potentially lose
   * work. how are we managing this?"* Until 1.13.0 the answer was: badly. The
   * 401 fell through to the generic save-failed notice, which printed the
   * servlet container's JSON body verbatim in a one-line strip, and nothing
   * said the work was safe or how to get back.
   *
   * Nothing is ever discarded on a 401 — the buffer is in memory and stays
   * there — so what this state exists to do is SAY so, and give the two things
   * that actually help: a way to sign in again, and the save button back.
   */
  const [signedOut, setSignedOut] = useState<string | null>(null);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [view, setView] = useState<ViewId>('scripts');
  /**
   * The bottom panel.
   *
   * Console and Terminal live here rather than beside the editor
   * (01/09/2026). A console needs to be wide and short — it prints lines — and
   * putting it beside the code halves the width of both. `panelTab` survives the
   * panel being closed so reopening returns to what you were using.
   */
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelId>('console');
  const [panelMaximised, setPanelMaximised] = useState(false);
  const [panelHeight, setPanelHeight] = useState(
    () => storedHeight('panel', defaultPanelHeight(window.innerHeight))
  );
  /**
   * Terminals are mounted lazily and then never unmounted.
   *
   * A shell is a process on the gateway and its scrollback is the session, so
   * unmounting the tab to switch away from it would kill both. The flag only
   * ever goes false→true, and the panel hides the tab rather than removing it.
   */
  const [terminalStarted, setTerminalStarted] = useState(false);
  /** Bumped to restart the shell — see the Terminal tab's ✚ action. */
  const [terminalKey, setTerminalKey] = useState(0);
  // The side bar collapses to the activity strip, VS Code style. Its width and
  // the outline's are remembered per viewer; a pane you have to re-drag every
  // visit is worse than one that is not resizable.
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState(() => storedWidth('rail', 260));
  /**
   * Width of the LEFT editor pane when split, in pixels.
   *
   * Pixels rather than a fraction because that is what `Resizer` speaks and
   * what the other two dividers here store, and because a fraction re-derived
   * on every window resize moves a divider the user placed deliberately.
   */
  const [splitWidth, setSplitWidth] = useState(() => storedWidth('split', 640));
  const [outlineWidth, setOutlineWidth] = useState(() => storedWidth('outline', 240));
  const [creating, setCreating] = useState<ScriptTypeId | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScriptEntry | null>(null);
  // A tab whose close would discard unsaved work, awaiting an answer.
  const [pendingClose, setPendingClose] = useState<OpenDoc | null>(null);
  const [configEntry, setConfigEntry] = useState<ScriptEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Bumped on every edit so the outline re-requests. A counter rather than the
  // text itself: the effect only needs to know THAT it changed.
  const [docRevision, setDocRevision] = useState(0);

  // Saves are fired from a CodeMirror keybinding as well as from the button, and
  // both read the CURRENT docs array. Keeping it in a ref avoids handing the
  // editor a callback that closes over a stale render.
  const docsRef = useRef(docs);
  docsRef.current = docs;

  // One client for the whole workspace, and through it one socket for the whole
  // tab. Built lazily on first use, so nothing connects until a script is
  // actually opened.
  const lsp = useMemo(() => sharedLspClient(), []);

  // The same instance the client above is built on — `sharedTransport()` is a
  // singleton, so the footer reports the state of the very socket the editor is
  // using, not a second one opened to watch it.
  const transport = useMemo(() => sharedTransport(), []);

  const activeDoc = useMemo(
    () => docs.find((d) => d.uri === activeUri) ?? null,
    [docs, activeUri]
  );

  /**
   * Who else has these files open — other browsers, and Ignition Designers.
   *
   * The gateway pushes this whenever it changes, so nothing here polls. See
   * `api/presence.ts` for why it is a warning rather than a lock.
   */
  const [presence, setPresence] = useState<PresenceState>(EMPTY_PRESENCE);

  useEffect(() => presenceClient().subscribe(setPresence), []);

  /**
   * What git says has changed in this project since the last commit.
   *
   * Read-only. `module-git` does the staging and committing; this is the half a
   * person wants while editing — which of these files have I touched — and it
   * stops there (01/09/2026).
   */
  const [git, setGit] = useState<GitState>(NO_GIT);

  useEffect(() => gitClient().subscribe(setGit), []);

  useEffect(() => {
    if (project) gitClient().watch(project);
  }, [project]);

  /**
   * Tell the gateway what this browser has open.
   *
   * Keyed on the resource PATH, not the tab uri: a Web Dev endpoint is one
   * resource holding up to eight scripts, so two tabs on `doGet` and `doPost`
   * are one file as far as anybody else is concerned — and as far as the
   * Designer, which has no concept of our data keys, can possibly report.
   */
  useEffect(() => {
    const open = [...new Set(docs.map((doc) => doc.path))];
    presenceClient().report(project, open);
  }, [docs, project]);

  /** Peers per open tab, so the strip can badge each one. */
  const presenceByUri = useMemo(() => {
    const map = new Map<string, Peer[]>();
    for (const doc of docs) {
      const others = peersOn(presence, doc.project, doc.path);
      if (others.length > 0) {
        map.set(doc.uri, others);
      }
    }
    return map;
  }, [docs, presence]);

  /**
   * Git marks placed on paths this tree can actually render.
   *
   * The node set includes every ANCESTOR of every script, so a collapsed package
   * carries the worst mark of what is inside it, and a mark for a resource that
   * no longer exists — a deletion — lands on the nearest folder that does. See
   * `decorate` for why the roll-up cannot happen in the tree component.
   */
  const gitMarks = useMemo(() => {
    if (!git.repo || git.error || git.head === null) {
      // No repo, unreadable, or nothing committed yet. In the last case every
      // file genuinely IS new, and marking all of them says less than the one
      // line `summarise` puts above the tree.
      return undefined;
    }
    const nodes = new Set<string>();
    for (const entry of tree?.scripts ?? []) {
      nodes.add(entry.path);
      let parent = entry.path;
      while (parent.includes('/')) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        nodes.add(parent);
      }
    }
    return decorate(git.marks, nodes);
  }, [git, tree]);

  /** The one line above the tree, or null when there is nothing honest to say. */
  const gitSummary = useMemo(() => summarise(git), [git]);

  /** Peers on the document actually on screen, for the bar above it. */
  const activePresence = useMemo(
    () => (activeDoc ? peersOn(presence, activeDoc.project, activeDoc.path) : []),
    [activeDoc, presence]
  );

  /**
   * Unsaved buffers left behind by a previous session.
   *
   * Read ONCE, on mount, and deliberately not refreshed: this is a list of what
   * was already lost when the page loaded. Re-reading it would fold in the
   * drafts this session is writing as you type, and the notice would never go
   * away.
   */
  const [recoverable, setRecoverable] = useState<Draft[]>([]);

  useEffect(() => {
    setRecoverable(allDrafts());
  }, []);

  /**
   * Keep every dirty script buffer, so a closed tab is not lost work.
   *
   * Debounced rather than written per keystroke: this is `localStorage`, which
   * is synchronous and on the main thread, and a write per character in a
   * 60 KB file is felt.
   *
   * Scripts only. A named query's dirtiness includes its SETTINGS, which a
   * draft does not carry, so a recovered query would come back with its SQL and
   * somebody else's connection — a half-restore that looks whole.
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const doc of docsRef.current) {
        if (doc.kind !== 'script') continue;
        if (isDirty(doc)) {
          putDraft({
            uri: doc.uri,
            project: doc.project,
            path: doc.path,
            scriptKey: doc.scriptKey,
            label: doc.label,
            text: doc.text,
            baseText: doc.baseText,
            etag: doc.etag,
            at: Date.now(),
          });
        } else {
          // Saved, or edited back to what the gateway holds. Either way it is
          // no longer at risk and must not be offered as recovered work.
          dropDraft(doc.uri);
        }
      }
    }, 800);
    return () => window.clearTimeout(timer);
  }, [docs]);

  /** Drafts for the project on screen — the only ones that can be opened here. */
  const myDrafts = useMemo(
    () => recoverable.filter((draft) => draft.project === project
      && !docs.some((doc) => doc.uri === draft.uri)),
    [recoverable, project, docs]
  );

  const forgetDrafts = useCallback(() => {
    for (const draft of myDrafts) dropDraft(draft.uri);
    setRecoverable((current) => current.filter((d) => !myDrafts.includes(d)));
  }, [myDrafts]);

  /**
   * Open documents whose gateway copy has moved on since they were opened.
   *
   * Derived from the listing rather than stored, for the reason `isDirty` is:
   * a flag and the thing it describes drift apart, and the listing is already
   * being refreshed in the background. A document missing from the listing is
   * NOT stale — it has been deleted, which is a different state and not one
   * this set claims to report.
   */
  const staleUris = useMemo(() => {
    // Keyed by RESOURCE, not by document. A signature covers the whole resource,
    // and one resource can be open in several tabs: a Web Dev endpoint has up to
    // eight handlers plus its static files, all sharing one signature. Keying by
    // the document uri only ever matched the tab opened at the listing's own
    // default key, so every other tab on that endpoint could never go stale.
    const signatures = new Map<string, string>();
    for (const entry of tree?.scripts ?? []) {
      signatures.set(docUri(project, entry.path), entry.signature);
    }
    for (const entry of queries?.queries ?? []) {
      signatures.set(docUri(project, entry.path), entry.signature);
    }
    const out = new Set<string>();
    for (const doc of docs) {
      // A save of our OWN is not someone else's change. The write lands on the
      // gateway before its signature comes back, so mid-save the listing and the
      // document disagree for a reason that resolves itself — and offering to
      // pull then is worse than saying nothing, because it names the user's own
      // work as a conflict. Suppressed for the round trip only: a save that
      // fails or 409s takes its uri out of the set and the bar returns, which is
      // the one case where it is telling the truth.
      if (savingUris.has(doc.uri)) continue;
      if (isStale(doc, signatures.get(docUri(doc.project, doc.path)))) out.add(doc.uri);
    }
    return out;
  }, [docs, project, queries, savingUris, tree]);


  /**
   * Mark this tab as overridden, so its buffer and its settings unlock.
   *
   * Nothing is written here. The Designer's `Override Resource` is a STAGED
   * change too — measured 01/09/2026: after choosing it, the gateway's own
   * `data/projects/<p>/ignition/script-python/` still held no copy of the
   * script, and the tree row went italic (this Designer's mark for "unsaved").
   * The local resource appears on save, which for us is the existing write
   * path: the resource route already does an own-project lookup, so a save
   * against an inherited script creates the override rather than modifying the
   * parent.
   */
  const overrideDoc = useCallback((uri: string) => {
    setDocs((current) =>
      current.map((d) => (d.uri === uri ? { ...d, overridden: true } : d))
    );
    setDocRevision((n) => n + 1);
  }, []);

  /**
   * Writes are refused for two independent reasons and the UI must say which:
   * the user lacks the role, or the project itself is immutable (inherited or
   * locked). Reporting a single "read-only" sends people to the wrong fix.
   */
  const readOnlyReason = !session.writable
    ? 'You are signed in without script-edit permission, so the editor is read-only.'
    : tree && !tree.mutable
      ? `Project "${tree.project}" is not mutable on this gateway, so the editor is read-only.`
      : '';
  const readOnly = readOnlyReason.length > 0;

  /**
   * The active tab is read-only on its OWN account: inherited, not overridden.
   *
   * Kept separate from `readOnly` because the remedy is completely different —
   * that one needs an administrator, this one needs one click — and a single
   * "read-only" message would send people to the wrong one.
   */
  const activeLocked = activeDoc ? isLockedByInheritance(activeDoc) : false;

  /**
   * What "Run file" runs: the ACTIVE tab, read at click time through docsRef
   * so an unsaved edit runs as typed. Only documents in the console's own
   * project qualify — a script from another project would execute against the
   * wrong library.
   */
  const activeSource = useMemo<ActiveSource | undefined>(() => {
    // Python only. "Run file" hands the buffer to the Jython interpreter, so a
    // named query would arrive as SQL and a Web Dev text resource as HTML.
    // Testing a query is its own tab, against the database; a static file is
    // tested by requesting the endpoint.
    if (!activeDoc || !isPythonDoc(activeDoc) || activeDoc.project !== project) {
      return undefined;
    }
    const uri = activeDoc.uri;
    return {
      path: activeDoc.path,
      label: activeDoc.label,
      getSource: () => docsRef.current.find((d) => d.uri === uri)?.text ?? '',
    };
  }, [activeDoc, project]);
  /** Writes are refused for either reason. */
  const activeWritable = !readOnly && !activeLocked;

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        // Prefer a project that can actually be written to; falling back to the
        // first one still shows something useful in read-only mode.
        const preferred = list.find((p) => p.mutable) ?? list[0];
        if (preferred) setProject(preferred.name);
      })
      .catch((e: unknown) => {
        if (!cancelled) setTreeError(describe(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Bumped to make the watch below look NOW rather than on its next tick. */
  const [watchNonce, setWatchNonce] = useState(0);

  /** A save held back because the buffer does not parse. Null when there is none. */
  const [saveWarning, setSaveWarning] =
    useState<{ uri: string; detail: string; label: string } | null>(null);

  /**
   * A save held back because it changes something other files call.
   *
   * Separate from `saveWarning`: one is about whether the code RUNS, the other
   * about what it breaks elsewhere, and a single bar carrying both would have to
   * generalise its wording until it said nothing.
   */
  const [impactWarning, setImpactWarning] = useState<
    { uri: string; label: string; detail: string; names: string[] } | null>(null);

  /**
   * The first ERROR-severity diagnostic per open document, if any.
   *
   * Kept so a save can refuse to go through silently on code that does not
   * parse. Before 1.16.0 nothing stopped writing a broken script straight into a
   * running gateway — and on a timer script that starts failing on the next
   * tick, in a log nobody has open.
   *
   * A ref as well as state: `saveDoc` reads it from a callback that must not be
   * rebuilt on every diagnostic push, and a stale closure there would let
   * exactly the save this exists to catch go through.
   */
  const [syntaxErrors, setSyntaxErrors] = useState<Record<string, string>>({});
  const syntaxErrorsRef = useRef<Record<string, string>>({});
  useEffect(() => {
    syntaxErrorsRef.current = syntaxErrors;
  }, [syntaxErrors]);

  /**
   * Subscribe every open Python document to its diagnostics.
   *
   * Only to learn whether it PARSES — the Problems panel renders the full list
   * and does its own subscribing. Keyed on the set of open documents rather than
   * on `docs`, which is a new array on every keystroke.
   */
  const openPythonKey = docs
    .filter((doc) => isPythonDoc(doc))
    .map((doc) => `${doc.uri}\u0000${doc.project}\u0000${doc.path}\u0000${doc.scriptKey}`)
    .join('\n');

  useEffect(() => {
    if (!lsp || openPythonKey.length === 0) return;
    const entries = openPythonKey.split('\n').map((row) => {
      const [uri, proj, path, key] = row.split('\u0000');
      return { uri, serverUri: lspUri(proj, path, key) };
    });
    const offs = entries.map(({ uri, serverUri }) =>
      lsp.onDiagnostics(serverUri, (diagnostics) => {
        // Severity 1 is Error, and the only source that reports one for Python is
        // the gateway's real Jython parser. A WARNING — an undefined name, a
        // deprecated call — must never block a save: those are advisory by
        // design, and a guard that fired on them would be trained away.
        const fatal = diagnostics.find((d) => (d.severity ?? 1) === 1);
        setSyntaxErrors((current) => {
          const next = { ...current };
          if (fatal) {
            next[uri] = `${fatal.message} (line ${fatal.range.start.line + 1})`;
          } else {
            delete next[uri];
          }
          return next;
        });
      })
    );
    return () => {
      for (const off of offs) off();
    };
  }, [lsp, openPythonKey]);

  /**
   * Notice that the gateway has moved on, without being asked.
   *
   * Until 1.8.5 nothing here ever re-read anything: the listing was refetched
   * only after this app's OWN mutations, so a script edited in the Designer
   * stayed invisible until a save 409'd (03/09/2026 — "The change did
   * not show up"). Reopening the same script from the tree did not help either;
   * `openScript` just refocuses the existing tab.
   *
   * Refetching the LISTING rather than each open document: one request whatever
   * is open, and the listing already carries the signature that answers the
   * question. The document bodies are only re-read when a pull actually happens.
   *
   * On focus as well as on a timer, because the realistic sequence is edit in
   * the Designer, alt-tab back — and that should be immediate, not up to
   * `WATCH_INTERVAL_MS` later.
   *
   * `watchNonce` is the third trigger: something in THIS app has written to a
   * file it may also have open — a project-wide replace, since 1.15.0. Waiting
   * up to 20 s to notice our own write would show the pull bar long after the
   * report that explains it.
   */
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const look = () => {
      if (cancelled || document.hidden) return;
      fetchScriptTree(project)
        .then((next) => {
          // Never clobber a load error or an in-flight first load with a
          // background result; this is a refresh, not the source of truth for
          // whether the listing works at all.
          if (!cancelled) setTree((current) => (current ? next : current));
        })
        .catch((e: unknown) => {
          /* A background poll that fails is not worth a notice: the next one
             may well succeed, and the save path still has If-Match behind it.
             A 401 is the exception — it is not a blip, it is the session gone,
             and finding out at save time is what caused a scare on
             04/09/2026. The poll runs every 20 s, so this surfaces within one
             interval instead of at the next Ctrl+S. */
          if (e instanceof ApiError && e.isUnauthenticated) setSignedOut('');
        });
      // BOTH listings, because `staleUris` reads both. This watch shipped in
      // 1.8.5 refetching only the scripts, so a named query changed on the
      // gateway — in the Designer, or in another tab of this IDE — was never
      // reported stale and the open tab kept an old copy until a save 409'd.
      // That is precisely the defect the watch was added to fix, left in place
      // for the other half of the tree; `validate_v17_nq` found it on the
      // first live run, with 261 unit tests green either side of it.
      fetchNamedQueries(project)
        .then((next) => {
          if (!cancelled) setQueries((current) => (current ? next : current));
        })
        .catch(() => { /* as above */ });
    };
    const timer = window.setInterval(look, WATCH_INTERVAL_MS);
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    // Only on a bump, never on the first run: the initial listing load is its
    // own effect below, and looking here as well would fetch both listings
    // twice on every project switch.
    if (watchNonce > 0) look();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
    };
  }, [project, watchNonce]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setTree(null);
    setTreeError('');
    fetchScriptTree(project)
      .then((next) => {
        if (!cancelled) setTree(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setTreeError(describe(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  // Its own effect, and its own error: a gateway whose named-query routes are
  // missing (an older build of this module's server half) must still give a
  // working script IDE rather than an empty one.
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setQueries(null);
    setQueriesError('');
    fetchNamedQueries(project)
      .then((next) => {
        if (!cancelled) setQueries(next);
      })
      .catch((e: unknown) => {
        if (!cancelled) setQueriesError(describe(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project]);

  /** Re-read the query listing after a create, rename or delete. */
  const refreshQueries = useCallback(async () => {
    try {
      setQueries(await fetchNamedQueries(project));
    } catch (e: unknown) {
      setQueriesError(describe(e));
    }
  }, [project]);

  const openScript = useCallback(
    async (entry: ScriptEntry) => {
      const uri = docUri(project, entry.path, entry.scriptKey);
      if (docsRef.current.some((d) => d.uri === uri)) {
        selectDoc(uri);
        return;
      }
      try {
        const content = await readScriptContent(project, entry.path, entry.scriptKey);
        setDocs((current) =>
          current.some((d) => d.uri === uri)
            ? current
            : [...current, newDoc(entry, project, content.text, content.etag)]
        );
        selectDoc(uri);
        setNotice(null);
      } catch (e: unknown) {
        setNotice({ kind: 'error', text: `Could not open ${entry.path}: ${describe(e)}` });
        return;
      }
      // Attributes are a second request and a second concern: a script whose
      // body opened fine is still usable if its settings could not be read.
      try {
        const read = await readScriptAttributes(project, entry.path);
        setAttrs((current) => ({
          ...current,
          [uri]: { editable: read.editable, attributes: read.attributes, base: read.attributes },
        }));
      } catch {
        setAttrs((current) => ({ ...current, [uri]: { editable: [], attributes: {}, base: {} } }));
      }
    },
    [project]
  );

  /**
   * Open a named query in a tab.
   *
   * TWO reads, and both are needed before the document exists: the SQL is the
   * buffer and the settings are the other half of the same resource, saved
   * against the same signature. Unlike a script — whose attributes can fail
   * without costing the user the body — a query with no settings has no type,
   * no parameters and nothing for the Testing tab to ask for, so a failed
   * settings read leaves the tab unopened and says why.
   */
  const openQuery = useCallback(
    async (entry: NamedQueryEntry) => {
      const uri = docUri(project, entry.path, QUERY_DATA_KEY);
      if (docsRef.current.some((d) => d.uri === uri)) {
        selectDoc(uri);
        return;
      }
      try {
        const [sql, settings] = await Promise.all([
          readNamedQuerySql(project, entry.path),
          readNamedQuerySettings(project, entry.path),
        ]);
        setDocs((current) =>
          current.some((d) => d.uri === uri)
            ? current
            : [
                ...current,
                newQueryDoc({
                  entry,
                  project,
                  sql: sql.sql,
                  // The CONTENT read's ETag: both halves carry the same resource
                  // signature, and the SQL read is the one the buffer came from.
                  // The settings route calls the same value `signature`.
                  etag: sql.etag || settings.signature,
                  settings: settings.settings,
                  databases: settings.databases,
                  editableSettings: settings.editable,
                  legacy: settings.legacy,
                }),
              ]
        );
        selectDoc(uri);
        setNotice(null);
      } catch (e: unknown) {
        setNotice({ kind: 'error', text: `Could not open ${entry.path}: ${describe(e)}` });
      }
    },
    [project]
  );


  // ---- export / import ---------------------------------------------------

  /** Download the selection as a Designer-compatible resource zip. */
  const doExport = useCallback(
    async (paths: string[], label: string) => {
      if (paths.length === 0) {
        setNotice({ kind: 'info', text: `${label} holds no scripts to export.` });
        return;
      }
      try {
        const { blob, filename } = await exportScripts(project, paths);
        saveBlob(blob, filename);
        setNotice({
          kind: 'info',
          text: `Exported ${paths.length} script${paths.length === 1 ? '' : 's'} `
            + `as ${filename}.`,
        });
      } catch (e: unknown) {
        setNotice({ kind: 'error', text: `Could not export ${label}: ${describe(e)}` });
      }
    },
    [project]
  );

  /**
   * Read a chosen file and open the import dialog on what it holds.
   *
   * Nothing is written here. The user has not yet seen what is in the file, and
   * an import that acted on the file chooser's OK button would be a write with
   * no confirmation step at all.
   */
  const beginImport = useCallback(
    async (file: File) => {
      setImportOutcome(undefined);
      setImportError(undefined);
      try {
        const inspection = await inspectImport(project, file, session.csrfToken);
        setImporting({ file, inspection });
      } catch (e: unknown) {
        setNotice({ kind: 'error', text: `Could not read ${file.name}: ${describe(e)}` });
      }
    },
    [project, session.csrfToken]
  );

  const doImport = useCallback(
    async (paths: string[]) => {
      if (!importing) return;
      setImportBusy(true);
      setImportError(undefined);
      try {
        const outcome = await applyImport(project, paths, importing.file, session.csrfToken);
        setImportOutcome(outcome);
        // The tree has new rows in it now, and an import that left the tree
        // showing the state from before would read as having done nothing.
        try {
          setTree(await fetchScriptTree(project));
        } catch {
          /* the import succeeded; a stale tree is cosmetic */
        }
      } catch (e: unknown) {
        setImportError(describe(e));
      } finally {
        setImportBusy(false);
      }
    },
    [importing, project, session.csrfToken]
  );

  const handleChange = useCallback((uri: string, text: string) => {
    setDocs((current) => current.map((d) => (d.uri === uri ? { ...d, text } : d)));
    setDocRevision((n) => n + 1);
    // Typing is the answer to "are you sure": the question was about the buffer
    // as it stood, and it no longer stands.
    setSaveWarning((current) => (current && current.uri === uri ? null : current));
    setImpactWarning((current) => (current && current.uri === uri ? null : current));
  }, []);

  /**
   * Close a tab, discarding its buffer.
   *
   * Private on purpose — every caller goes through `closeDoc`, which refuses to
   * discard unsaved work without asking. See there.
   */
  const forceCloseDoc = useCallback((uri: string) => {
    // Computed from the ref rather than inside a setState updater: an updater
    // must be pure, and React runs it twice under StrictMode.
    const current = docsRef.current;
    const index = current.findIndex((d) => d.uri === uri);
    if (index < 0) return;
    const next = current.filter((d) => d.uri !== uri);
    setDocs(next);
    // Closing the active tab moves to its right-hand neighbour, or its left one
    // if it was last — the same rule every editor uses.
    const nextActive = uri === paneStateRef.current.activeUri
      ? (next[index] ?? next[index - 1])?.uri ?? null
      : paneStateRef.current.activeUri;
    setActiveUri(nextActive);
    setAttrs((attributes) => {
      const remaining = { ...attributes };
      delete remaining[uri];
      return remaining;
    });
    // A closed document's offers apply to a buffer that no longer exists.
    setImportSuggestions((current) => (current?.uri === uri ? null : current));
    // Release the pane assignment with the document — see forgetInPanes.
    const panes = forgetInPanes(paneStateRef.current, uri);
    paneStateRef.current = { ...panes, activeUri: nextActive };
    setSplitUris(panes.split);
    setOtherActive(panes.otherActive);
  }, []);

  const focusedPaneIsRight = focusIsRight({ activeUri, otherActive, split: splitUris });

  /**
   * The documents in each pane, and which of them each pane is showing.
   *
   * Both derived, never stored: a pane's contents are "the documents assigned
   * to it", and its active tab is either the focused document or the one the
   * other pane remembered. `otherActive` is validated against the pane it would
   * be shown in rather than trusted — a document can leave a pane by being
   * closed, or by being moved across, and a stale uri would render a pane with
   * a tab strip and no buffer.
   */
  const leftDocs = useMemo(
    () => docs.filter((d) => !splitUris.has(d.uri)),
    [docs, splitUris]
  );
  const rightDocs = useMemo(
    () => docs.filter((d) => splitUris.has(d.uri)),
    [docs, splitUris]
  );

  const { left: leftActive, right: rightActive } = paneActives(
    { activeUri, otherActive, split: splitUris },
    leftDocs.map((d) => d.uri),
    rightDocs.map((d) => d.uri)
  );

  /**
   * Move a document to the other pane — the split gesture, both ways.
   *
   * The rule is in `panes.ts`; this supplies the tab ORDER, so the pane the
   * document left lands on a neighbour rather than on whatever a Set happened
   * to iterate first.
   */
  const moveToOtherPane = useCallback((uri: string) => {
    applyPanes(moveAcross(paneStateRef.current, uri, docsRef.current.map((d) => d.uri)));
  }, [applyPanes]);

  /**
   * Close a tab — asking first when that would throw work away.
   *
   * Until 1.8.8 this discarded an unsaved buffer silently (04/09/2026:
   * "I can close a tab that has unsaved changes without any notice or
   * anything"). Nothing else in this app destroys user input without a prompt,
   * and a close button is the easiest thing on screen to hit by accident —
   * it sits a few pixels from the tab you meant to select.
   *
   * A 'new' document counts as unsaved even when its buffer is empty: closing
   * it discards a script the gateway has never seen. That falls out of
   * `isDirty` and is not special-cased here.
   */
  // Escape cancels the close question, as it does every other modal here.
  useEffect(() => {
    if (!pendingClose) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPendingClose(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingClose]);

  /**
   * Put recovered buffers back into tabs.
   *
   * Through `openScript`, not by constructing a document from the draft: the
   * draft holds text, and a document also needs its type, its data key, its
   * inheritance state and the CURRENT signature. Building one from the draft
   * would hand the next save an etag from a previous session, which is exactly
   * the stale-write this module's If-Match exists to refuse.
   *
   * So the gateway's copy is opened first and the draft text applied over it.
   * The tab is then dirty against what the gateway holds NOW, which is the
   * truthful state — and if somebody saved that resource in the meantime, the
   * ordinary conflict machinery is already pointed at the right version.
   */
  const restoreDrafts = useCallback(async () => {
    const missing: string[] = [];
    for (const draft of myDrafts) {
      const entry = tree?.scripts.find(
        (candidate) => candidate.path === draft.path
          && (candidate.scriptKey ?? '') === (draft.scriptKey ?? '')
      );
      if (!entry) {
        // The script was deleted while the draft sat in a closed browser. Say
        // so by name: silently skipping it looks like the recovery failed.
        missing.push(draft.label);
        continue;
      }
      await openScript(entry);
      setDocs((current) => current.map(
        (doc) => (doc.uri === draft.uri ? { ...doc, text: draft.text } : doc)
      ));
    }
    setRecoverable((current) => current.filter((d) => !myDrafts.includes(d)));
    if (missing.length > 0) {
      setNotice({
        kind: 'error',
        text: `Could not restore ${missing.join(', ')} — no longer on the gateway.`,
      });
    }
  }, [myDrafts, openScript, tree]);

  const closeDoc = useCallback((uri: string) => {
    const doc = docsRef.current.find((d) => d.uri === uri);
    if (doc && isDirty(doc)) {
      setPendingClose(doc);
      return;
    }
    forceCloseDoc(uri);
  }, [forceCloseDoc]);

  /**
   * Apply a successful write: base text, base settings and signature move
   * together.
   *
   * `savedSettings` is what was actually POSTed, not what the editor holds now:
   * the user can keep editing during the round trip, and `baseSettings` must
   * become the version the gateway agreed to or the document reads as clean
   * over an unsaved change.
   */
  const commitSaved = useCallback((
    uri: string,
    saved: string,
    signature: string | undefined,
    savedSettings?: NamedQuerySettings
  ) => {
    setDocs((current) =>
      current.map((d) =>
        d.uri === uri
          ? {
              ...d,
              baseText: saved,
              // A save that returns no signature leaves the old one in place;
              // the next write then 409s rather than overwriting blindly.
              etag: signature ?? d.etag,
              baseSettings: savedSettings ?? d.baseSettings,
              // A settings write goes through `toResource`, which stamps the
              // resource version 2 — so a query that WAS legacy is not any
              // more, and the editor's notice must go with it.
              legacy: savedSettings ? false : d.legacy,
              // A first save against an inherited script created a local
              // override, and a first save of a 'new' draft created the
              // resource itself — the tree is stale for this entry either way.
              origin: d.origin === 'inherited' ? 'override' : d.origin === 'new' ? 'local' : d.origin,
            }
          : d
      )
    );
  }, []);

  /**
   * The gateway's current copy of a document, whichever kind it is.
   *
   * One helper because three call sites need it — the conflict dialog, the
   * keep-mine re-read and the post-conflict refresh — and each of them getting
   * the branch right independently is three chances to read a query through the
   * script route and report a 404 as "somebody deleted your file".
   */
  const readCurrent = useCallback(async (doc: OpenDoc): Promise<{
    text: string;
    etag: string;
    /** The settings half, for a named query. Absent for a script. */
    query?: Partial<OpenDoc>;
  }> => {
    if (doc.kind === 'named-query') {
      // BOTH halves, as `openQuery` does. Until 1.12.0 this read only the SQL,
      // so pulling a query that had changed on the gateway replaced its buffer
      // and left its settings at the version the tab was opened with — a tab
      // holding half of one revision and half of another, whose next save
      // wrote the stale half back over whatever had changed. A display bug
      // would have been the good outcome; this was a lost update.
      const [sql, settings] = await Promise.all([
        readNamedQuerySql(doc.project, doc.path),
        readNamedQuerySettings(doc.project, doc.path),
      ]);
      return {
        text: sql.sql,
        etag: sql.etag || settings.signature,
        query: {
          settings: settings.settings,
          baseSettings: settings.settings,
          databases: settings.databases,
          editableSettings: settings.editable,
          legacy: settings.legacy,
        },
      };
    }
    const current = await readScriptContent(doc.project, doc.path, doc.scriptKey);
    return { text: current.text, etag: current.etag };
  }, []);

  /** Read the gateway's current copy and raise the conflict dialog against it. */
  const raiseConflict = useCallback(async (doc: OpenDoc) => {
    try {
      const current = await readCurrent(doc);
      setConflict({
        uri: doc.uri,
        label: doc.label,
        mine: doc.text,
        theirs: current.text,
        theirsEtag: current.etag,
        theirsQuery: current.query,
      });
    } catch (e: unknown) {
      setNotice({
        kind: 'error',
        text: `This script changed on the gateway, and re-reading it also failed: ${describe(e)}`,
      });
    }
  }, [readCurrent]);

  /**
   * Re-read one document from the gateway.
   *
   * Clean buffer: replace it and say so. Dirty buffer: this is exactly the
   * situation the conflict dialog exists for, so it is raised here rather than
   * being reinvented — the difference is only that the user asked for it
   * instead of discovering it at save time.
   */
  const pullDoc = useCallback(async (uri: string) => {
    const doc = docsRef.current.find((d) => d.uri === uri);
    if (!doc || doc.origin === 'new') return;
    if (isDirty(doc)) {
      await raiseConflict(doc);
      return;
    }
    try {
      const current = await readCurrent(doc);
      setDocs((all) => all.map((d) => (
        d.uri === uri
          ? { ...d, text: current.text, baseText: current.text, etag: current.etag,
              ...(current.query ?? {}) }
          : d
      )));
      setNotice({ kind: 'info', text: `Pulled the gateway copy of ${doc.label}.` });
    } catch (e: unknown) {
      setNotice({ kind: 'error', text: `Could not pull ${doc.label}: ${describe(e)}` });
    }
  }, [raiseConflict, readCurrent]);

  /**
   * A signature that moved without the CONTENT moving is not a change.
   *
   * 04/09/2026: *"I know for a fact that no changes were made via the
   * designer because I am the only one with access and I don't even have the
   * designer open. when i click on the compare I couldn't see any
   * differences"* — and then, after reloading the page, *"it stopped showing
   * me any need to pull"*. Both observations say the same thing: the resource
   * signature had moved and the bytes had not.
   *
   * It happens for real reasons — a gateway restart re-stamps resources, and
   * this session had just lost its login to one. The listing carries only the
   * signature, so the watch cannot tell that case from a genuine edit, and
   * until 1.13.0 it announced both. A bar that says a file changed, over a
   * diff with nothing in it, is worse than no bar: it trains the reader to
   * dismiss the one that matters.
   *
   * So every newly-stale document is VERIFIED once, by reading it. Identical
   * to what this tab is based on: adopt the new signature and say nothing —
   * there is nothing to tell anyone, and adopting it is also what stops the
   * next save 409'ing on a signature that describes the same bytes. Different:
   * leave the bar up, it has something to show.
   *
   * One read per document per signature change, not per poll — `verified`
   * remembers, and forgets a document as soon as it is no longer stale so a
   * later, real change is checked again.
   */
  const verifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const uri of [...verifiedRef.current]) {
      if (!staleUris.has(uri)) verifiedRef.current.delete(uri);
    }
    for (const uri of staleUris) {
      if (verifiedRef.current.has(uri)) continue;
      verifiedRef.current.add(uri);
      const doc = docsRef.current.find((d) => d.uri === uri);
      if (!doc || doc.origin === 'new') continue;
      void readCurrent(doc)
        .then((current) => {
          if (current.text !== doc.baseText) return;   // a real change
          setDocs((all) => all.map((d) => (
            d.uri === uri
              ? { ...d, etag: current.etag, ...(current.query ?? {}) }
              : d
          )));
        })
        .catch(() => {
          /* Unreadable: leave the bar up. A read that fails is not evidence
             that the file is unchanged, and the save path still has If-Match
             behind it. */
        });
    }
  }, [staleUris, readCurrent]);

  /**
   * Pull every open document that has moved on.
   *
   * Clean ones are replaced silently — there is nothing to decide. Dirty ones
   * are NOT touched and are named instead: the conflict dialog handles one
   * document at a time, and quietly resolving several on the user's behalf is
   * the one thing a pull-all must never do.
   */
  const pullAll = useCallback(async () => {
    const candidates = docsRef.current.filter((d) => staleUris.has(d.uri));
    if (candidates.length === 0) {
      setNotice({ kind: 'info', text: 'Every open document is up to date.' });
      return;
    }
    const clean = candidates.filter((d) => !isDirty(d));
    const dirty = candidates.filter((d) => isDirty(d));
    const failed: string[] = [];
    for (const doc of clean) {
      try {
        const current = await readCurrent(doc);
        setDocs((all) => all.map((d) => (
          d.uri === doc.uri
            ? { ...d, text: current.text, baseText: current.text, etag: current.etag,
                ...(current.query ?? {}) }
            : d
        )));
      } catch {
        failed.push(doc.label);
      }
    }
    const parts: string[] = [];
    if (clean.length - failed.length > 0) {
      parts.push(`Pulled ${clean.length - failed.length} document(s).`);
    }
    if (dirty.length > 0) {
      parts.push(`Left ${dirty.map((d) => d.label).join(', ')} alone — `
        + 'unsaved edits. Pull each from its tab to compare.');
    }
    if (failed.length > 0) parts.push(`Failed: ${failed.join(', ')}.`);
    setNotice({
      kind: dirty.length > 0 || failed.length > 0 ? 'error' : 'info',
      text: parts.join(' '),
    });
  }, [readCurrent, staleUris]);

  /**
   * Write a named query: SQL first, then settings against the signature that
   * write returned.
   *
   * ONE resource, one signature, and therefore one order — the settings write
   * must carry the signature the SQL write produced or it 409s against a
   * version it made itself. Each half is skipped when it is unchanged: posting
   * settings nobody touched is a write to a live gateway (and a git diff) for
   * nothing.
   *
   * Ctrl+S and the button both come through here, so both halves save together
   * whichever way the user asks.
   */
  const saveQueryDoc = useCallback(
    async (doc: OpenDoc, source: string, baseSignature?: string) => {
      let signature: string | undefined = baseSignature ?? doc.etag;
      if (doc.text !== doc.baseText) {
        const written = await saveNamedQuerySql({
          project: doc.project,
          path: doc.path,
          sql: source,
          baseSignature: signature ?? '',
          csrfToken: session.csrfToken,
        });
        signature = written.signature ?? signature;
      }
      let savedSettings: NamedQuerySettings | undefined;
      // A LEGACY resource is written even when nothing was edited: the settings
      // write is what puts it back through `toResource`, which stamps version 2
      // and makes the query runnable again. Skipping it because the form was
      // untouched would leave the repair undone with a save reported as done.
      if (doc.settings && (doc.legacy || !settingsEqual(doc.settings, doc.baseSettings))) {
        const written = await saveNamedQuerySettings({
          project: doc.project,
          path: doc.path,
          settings: doc.settings,
          baseSignature: signature ?? '',
          csrfToken: session.csrfToken,
        });
        signature = written.signature ?? signature;
        savedSettings = doc.settings;
      }
      commitSaved(doc.uri, source, signature, savedSettings);
      setConflict(null);
      setNotice({ kind: 'info', text: `Saved ${doc.label}.` });
      // A first save against an inherited query created the local override, so
      // the listing's origin and signature for this row are both stale.
      await refreshQueries();
    },
    [commitSaved, refreshQueries, session.csrfToken]
  );

  const saveDoc = useCallback(
    async (uri: string, baseSignature?: string, force = false) => {
      const doc = docsRef.current.find((d) => d.uri === uri);
      // Locked as well as read-only: without this, Ctrl+S on an inherited tab
      // would fork the parent's script even though the buffer refused to be
      // typed into — the keybinding does not go through the disabled button.
      if (!doc || readOnly || isReadOnlyDoc(doc)) return;

      // Code that does not PARSE gets one question before it reaches a running
      // gateway. Not a refusal: saving broken code deliberately is legitimate —
      // stopping halfway through a refactor is the ordinary case — so this asks
      // once and remembers nothing. Only an ERROR stops here; warnings never do.
      const fatal = syntaxErrorsRef.current[uri];
      if (!force && fatal) {
        setSaveWarning({ uri, detail: fatal, label: doc.label });
        return;
      }
      setSaveWarning(null);

      // What this save is about to break elsewhere. Library modules only: a
      // gateway event script is called by the platform, not by name, so there
      // are no call sites to warn about.
      if (!force && lsp && isPythonDoc(doc) && moduleNameFor(doc.path)) {
        const impact = signatureImpact(doc.baseText, doc.text);
        if (hasImpact(impact)) {
          const names = [...impact.removed, ...impact.changed];
          let callSites = 0;
          try {
            for (const name of names) {
              const found = await lsp.references(doc.project, name);
              // The definition's own line is a hit. One hit means nothing else
              // in the project writes the name, which is not worth stopping for.
              callSites += Math.max(0, found.length - 1);
            }
          } catch {
            // A references lookup that fails must not block a save. Better to
            // write the file than to refuse it over a question nobody asked.
            callSites = 0;
          }
          if (callSites > 0) {
            setImpactWarning({
              uri,
              label: doc.label,
              names,
              detail: describeImpact(impact, callSites),
            });
            return;
          }
        }
      }
      setImpactWarning(null);
      setSaving(true);
      beginSaving(uri);
      setNotice(null);
      // Capture the text being written: the user can keep typing during the
      // round trip, and baseText must become what the gateway actually stored.
      const source = doc.text;
      // The resource does not exist on the gateway yet — this save IS the
      // create. Remembered up front because commitSaved below already moves
      // doc.origin off 'new'.
      const wasNew = doc.origin === 'new';
      try {
        if (doc.kind === 'named-query') {
          await saveQueryDoc(doc, source, baseSignature);
          return;
        }
        const result = await saveScriptContent({
          project: doc.project,
          path: doc.path,
          source,
          key: doc.scriptKey,
          baseSignature: baseSignature ?? doc.etag,
          csrfToken: session.csrfToken,
        });
        commitSaved(uri, source, result.signature);
        // The server does nothing with didSave today, but it is the notification
        // a future diagnostics pass will hang off, and sending it is free. Note
        // the LSP document URI is NOT this workspace `uri`: documents are keyed
        // `ignition://<project>/<path>` on the wire and `project::path` here.
        lsp.didSave(lspUri(doc.project, doc.path, doc.scriptKey));
        setConflict(null);
        setNotice({ kind: 'info', text: `Saved ${doc.label}.` });
        // ALWAYS re-read the tree, and always BEFORE this document leaves
        // `savingUris` — which is why it is awaited here rather than left to the
        // background poll.
        //
        // Two windows would otherwise show the pull affordance over the user's
        // own save. The first is the round trip, which `savingUris` covers. The
        // second is after it: the document now carries the signature the write
        // returned while the listing still holds the one from before, and
        // `isStale` compares for DIFFERENCE, so a listing that is merely behind
        // reads exactly like someone else's edit. There is no way to tell those
        // apart from two opaque signatures, so the fix is to not be in that
        // state: refresh, then stop suppressing.
        //
        // For a 'new' draft this is load-bearing for a second reason that
        // predates the staleness one — nothing in `tree` knows the resource
        // exists until now, so the row stays a click-to-create placeholder with
        // no signature for the settings strip or a later delete.
        try {
          setTree(await fetchScriptTree(project));
        } catch {
          /* the save itself succeeded; a stale tree is cosmetic, not lost work */
        }
      } catch (e: unknown) {
        // A 'new' draft has no base signature to send, so a create raced by
        // someone else does not come back as this route's usual 409 — the
        // write route reads it as a MODIFY with no If-Match, which is 428. It
        // means the same thing here: read the gateway's copy and let the user
        // choose, exactly like an ordinary conflict.
        if (e instanceof ApiError && e.isUnauthenticated) {
          // NOT a notice. A notice is a line of text in a strip that the next
          // one replaces, and this is the one failure where the user has
          // unsaved work and no way to write it.
          setSignedOut(doc.label);
        } else if (e instanceof ApiError && (e.isConflict || (wasNew && e.isMissingBaseSignature))) {
          await raiseConflict(doc);
        } else {
          setNotice({ kind: 'error', text: `Could not save ${doc.label}: ${describe(e)}` });
        }
      } finally {
        setSaving(false);
        endSaving(uri);
      }
    },
    [beginSaving, commitSaved, endSaving, lsp, project, raiseConflict, readOnly,
      saveQueryDoc, session.csrfToken]
  );

  /**
   * Sort/dedupe the open buffer's leading import block and offer suggestions
   * for names it reads but never binds.
   *
   * An ordinary edit, not a save: the result replaces `doc.text` through the
   * same `handleChange` a keystroke goes through, so Ctrl+Z undoes it and
   * nothing reaches the gateway. Mirrors the History dialog's own "load a
   * different body into this buffer" pattern rather than Save's — a locked,
   * inherited buffer can still be organised in the tab; it just cannot be
   * written back until it is overridden, exactly as typing into one already
   * behaves.
   */
  const organiseImportsDoc = useCallback(async () => {
    const doc = activeDoc;
    if (!doc || !isPythonDoc(doc)) return;
    setNotice(null);
    try {
      const result = await organiseImports(doc.project, doc.text, session.csrfToken);
      const changed = result.source !== doc.text;
      if (changed) {
        handleChange(doc.uri, result.source);
      }

      const parts: string[] = [];
      if (result.removed.length > 0) {
        parts.push(
          `Removed ${result.removed.length} unused import${result.removed.length === 1 ? '' : 's'}.`
        );
      }
      if (result.notes.length > 0) {
        parts.push(...result.notes);
      }
      if (parts.length > 0) {
        setNotice({ kind: 'info', text: parts.join(' ') });
      } else if (changed) {
        setNotice({ kind: 'info', text: 'Imports reorganised.' });
      } else {
        setNotice({ kind: 'info', text: 'Imports are already organised — nothing to change.' });
      }

      setImportSuggestions(
        result.suggestions.length > 0 ? { uri: doc.uri, items: result.suggestions } : null
      );
    } catch (e: unknown) {
      setNotice({ kind: 'error', text: `Could not organise imports: ${describe(e)}` });
    }
  }, [activeDoc, handleChange, session.csrfToken]);

  /** Removes one offer from the list — the whole bar goes once none are left. */
  const dropSuggestion = useCallback((statement: string) => {
    setImportSuggestions((current) => {
      if (!current) return current;
      const items = current.items.filter((s) => s.statement !== statement);
      return items.length > 0 ? { ...current, items } : null;
    });
  }, []);

  /**
   * Insert one suggested import at the top of the buffer's leading import
   * block — the first column-0 line that is already `import`/`from`, or line
   * 0 when the file has no leading block yet. A simple insertion, not a full
   * reorganise: the user can press "Organise imports" straight after to sort
   * and de-duplicate, and that button stays one click away because this one
   * does not try to be it.
   */
  const insertSuggestedImport = useCallback(
    (statement: string) => {
      if (!importSuggestions) return;
      const doc = docsRef.current.find((d) => d.uri === importSuggestions.uri);
      if (!doc) return;
      handleChange(doc.uri, insertImportAtTopOfBlock(doc.text, statement));
      dropSuggestion(statement);
    },
    [dropSuggestion, handleChange, importSuggestions]
  );

  const resolveReloadTheirs = useCallback(() => {
    if (!conflict) return;
    const { uri, theirs, theirsEtag, theirsQuery } = conflict;
    setDocs((current) =>
      current.map((d) =>
        d.uri === uri
          ? {
              ...d,
              text: theirs,
              baseText: theirs,
              etag: theirsEtag,
              ...(theirsQuery ?? {}),
              // A 'new' draft that raised this dialog lost the race to create
              // the resource — someone else's copy is what is on the gateway
              // now, so this document is exactly as 'local' as any other
              // script this project owns, not still a draft of nothing.
              origin: d.origin === 'new' ? 'local' : d.origin,
            }
          : d
      )
    );
    setConflict(null);
    setNotice({ kind: 'info', text: 'Reloaded the gateway copy. Your edits were discarded.' });
    void fetchScriptTree(project).then(setTree).catch(() => {});
  }, [conflict, project]);

  /** Edit one query's settings. Same derivation as the buffer: no dirty flag. */
  const changeQuerySettings = useCallback((uri: string, settings: NamedQuerySettings) => {
    setDocs((current) => current.map((d) => (d.uri === uri ? { ...d, settings } : d)));
  }, []);

  const resolveKeepMine = useCallback(async () => {
    if (!conflict) return;
    const doc = docsRef.current.find((d) => d.uri === conflict.uri);
    if (!doc) return;
    // Re-read rather than reusing the signature captured when the dialog opened:
    // the gateway may have been written again while the user read the diff, and
    // saving against a stale signature just 409s a second time.
    try {
      const current = await readCurrent(doc);
      if (current.text !== conflict.theirs) {
        setConflict({ ...conflict, theirs: current.text, theirsEtag: current.etag,
                      theirsQuery: current.query });
        setNotice({
          kind: 'error',
          text: 'The gateway copy changed again while this dialog was open. Review the new diff.',
        });
        return;
      }
      await saveDoc(conflict.uri, current.etag);
    } catch (e: unknown) {
      setNotice({ kind: 'error', text: `Could not overwrite: ${describe(e)}` });
    }
  }, [conflict, readCurrent, saveDoc]);

  const changeAttribute = useCallback((uri: string, name: string, value: AttributeValue) => {
    setAttrs((current) => {
      const state = current[uri];
      if (!state) return current;
      return { ...current, [uri]: { ...state, attributes: { ...state.attributes, [name]: value } } };
    });
  }, []);

  const saveAttributes = useCallback(
    async (uri: string) => {
      const doc = docsRef.current.find((d) => d.uri === uri);
      const state = attrs[uri];
      // Same rule as the body. The attributes route refuses an inherited
      // resource outright ("cannot write attributes on an inherited resource
      // without first overriding it"), so sending one is a guaranteed 4xx the
      // user reads as a bug in this IDE.
      if (!doc || !state || readOnly || isReadOnlyDoc(doc)) return;
      setSavingAttrs(true);
      setNotice(null);
      try {
        const result = await saveScriptAttributes({
          project: doc.project,
          path: doc.path,
          attributes: state.attributes,
          // The resource signature is one value covering body AND attributes, so
          // an attribute write uses the document's ETag and updates it in turn.
          baseSignature: doc.etag,
          csrfToken: session.csrfToken,
        });
        setDocs((current) =>
          current.map((d) => (d.uri === uri ? { ...d, etag: result.signature ?? d.etag } : d))
        );
        setAttrs((current) => ({ ...current, [uri]: { ...state, base: state.attributes } }));
        setNotice({ kind: 'info', text: 'Saved settings.' });
      } catch (e: unknown) {
        // A conflict on the settings is not shown in the diff dialog — there is
        // no text to diff. Say what happened and re-read, so the next attempt
        // starts from the gateway's current values.
        setNotice({ kind: 'error', text: `Could not save settings: ${describe(e)}` });
        if (e instanceof ApiError && e.isConflict) {
          try {
            const read = await readScriptAttributes(doc.project, doc.path);
            setAttrs((current) => ({
              ...current,
              [uri]: { editable: read.editable, attributes: read.attributes, base: read.attributes },
            }));
            const content = await readScriptContent(doc.project, doc.path, doc.scriptKey);
            setDocs((current) =>
              current.map((d) => (d.uri === uri ? { ...d, etag: content.etag } : d))
            );
          } catch {
            /* leave the stale values on screen — the notice already says why */
          }
        }
      } finally {
        setSavingAttrs(false);
      }
    },
    [attrs, readOnly, session.csrfToken]
  );

  const activeAttrs = activeUri ? attrs[activeUri] : undefined;
  /** The active tab when it holds a named query; null for a script or none. */
  const activeQueryDoc = activeDoc?.kind === 'named-query' ? activeDoc : null;
  /**
   * Documents the language server actually holds.
   *
   * The Problems panel and the outline are both Python-only: a query's buffer is
   * SQL, the server is a Jython server, and asking it about either would answer
   * with a syntax error per line. Filtering here rather than inside each panel
   * keeps the reason in one place.
   */
  const scriptDocs = useMemo(() => docs.filter((d) => d.kind === 'script'), [docs]);
  // The tree entry behind the open tab, for its resource type. Looked up rather
  // than stored on the doc: the tree is re-read after every create and delete,
  // and a copy on the doc would go stale the first time that happened.
  /**
   * Web Dev endpoints, from the SAME listing as the scripts.
   *
   * They arrive together because the tree endpoint filters on "is this a script
   * resource this IDE edits", and Web Dev now is one. Splitting them client-side
   * costs a filter and saves a second round trip and a second cache to
   * invalidate after every create and delete.
   */
  const webDevEndpoints = useMemo(
    () => (tree?.scripts ?? []).filter((entry) => entry.typeId === 'resources'),
    [tree]
  );

  /** Create one more handler script on an existing endpoint. */
  const addWebDevMethod = useCallback(
    async (entry: ScriptEntry, method: string) => {
      try {
        await saveScriptContent({
          project,
          path: entry.path,
          key: `${method}.py`,
          source: WEBDEV_STUBS[method] ?? 'def ' + method + '(request, session):\n\t',
          baseSignature: entry.signature,
          csrfToken: session.csrfToken,
        });
        const refreshed = await fetchScriptTree(project);
        setTree(refreshed);
        const updated = refreshed.scripts.find((e) => e.path === entry.path);
        if (updated) {
          await openScript({ ...updated, scriptKey: `${method}.py` });
        }
      } catch (e) {
        setNotice({ kind: 'error', text: describe(e) });
      }
    },
    [openScript, project, session.csrfToken]
  );

  const activeEntry = useMemo(
    () => tree?.scripts.find((entry) => entry.path === activeDoc?.path),
    [tree, activeDoc]
  );
  /**
   * Which project the open document actually comes from.
   *
   * Looked up in whichever listing owns it: a query is not in `tree.scripts`,
   * and reading the owner from there would name "a parent project" for a
   * resource whose parent this workspace knows perfectly well.
   */
  const activeOwner = activeDoc?.kind === 'named-query'
    ? queries?.queries.find((entry) => entry.path === activeDoc.path)?.owner
    : activeEntry?.owner;
  /**
   * The inheritance state, as one line for the settings row.
   *
   * The Designer says this with a `(Read-Only)` suffix on the editor header and
   * puts the remedy in a context menu you have to know is there. Said here
   * instead: the state, where the script actually comes from, and the one
   * button that changes it — but on a row that already exists, not a new one.
   */
  const inheritanceNotice = activeDoc && activeLocked ? (
    <span className="inherited-note" role="status">
      <span className="inherited-note-text">
        Read-only — inherited from <strong>{activeOwner ?? 'a parent project'}</strong>
      </span>
      {!readOnly && (
        <button
          type="button"
          className="inherited-note-action"
          onClick={() => overrideDoc(activeDoc.uri)}
        >
          Override in {project}
        </button>
      )}
    </span>
  ) : activeDoc?.overridden && activeDoc.origin === 'inherited' ? (
    // Overridden but not yet saved. The local copy does not exist on the
    // gateway until the save, so saying "overridden" alone would claim a
    // resource that is not there.
    <span className="inherited-note is-override" role="status">
      <span className="inherited-note-text">
        Overriding <strong>{activeOwner ?? 'the parent'}</strong>&rsquo;s copy — the local
        copy is created when you save
      </span>
    </span>
  ) : undefined;

  const attrsDirty = activeAttrs
    ? // Both objects are built from the same server response and only ever have
      // their values replaced, so key order is stable and a JSON compare is a
      // sound equality test here.
      JSON.stringify(activeAttrs.attributes) !== JSON.stringify(activeAttrs.base)
    : false;

  // ---- create ----------------------------------------------------------

  const doCreate = useCallback(
    async (name: string, template?: string) => {
      const typeId = creating ?? 'script-python';
      setCreateBusy(true);
      setCreateError(null);
      // Web Dev lives under a DIFFERENT module id, so the path cannot be built
      // from the type alone. Getting this wrong creates `ignition/resources/x`,
      // which the platform accepts as a resource nothing will ever serve.
      const moduleId = typeId === 'resources' ? 'com.inductiveautomation.webdev' : 'ignition';
      const path = `${moduleId}/${typeId}/${name}`;
      try {
        await createScript({
          project,
          path,
          // A chosen template wins; without one it is the measured stub, which
          // for a library script is the empty file the Designer writes.
          source: template ?? handlerStub(typeId),
          csrfToken: session.csrfToken,
        });
        setCreating(null);
        // Re-read the tree rather than splicing the new entry in: the server
        // decides the signature and the data key, and inventing either here
        // would give the first save a base it never agreed to.
        const refreshed = await fetchScriptTree(project);
        setTree(refreshed);
        const entry = refreshed.scripts.find((candidate) => candidate.path === path);
        if (entry) {
          await openScript(entry);
        }
        setNotice({ kind: 'info', text: `Created ${name}.` });
      } catch (e) {
        setCreateError(describe(e));
      } finally {
        setCreateBusy(false);
      }
    },
    [creating, openScript, project, session.csrfToken]
  );

  // ---- delete ----------------------------------------------------------

  const doDelete = useCallback(async () => {
    const entry = pendingDelete;
    if (!entry) return;
    setDeleteBusy(true);
    try {
      await deleteScript({
        project,
        path: entry.path,
        baseSignature: entry.signature,
        csrfToken: session.csrfToken,
      });
      setPendingDelete(null);
      // Close the tab too — leaving an editor open on a resource that no longer
      // exists means the next Ctrl+S recreates it, silently undoing the delete.
      // Close every tab on this resource, not just one: a Web Dev endpoint has
      // up to eight, and leaving the others open means the next Ctrl+S recreates
      // the resource we just deleted.
      docsRef.current
        .filter((doc) => doc.project === project && doc.path === entry.path)
        .forEach((doc) => closeDoc(doc.uri));
      setTree(await fetchScriptTree(project));
      setNotice({ kind: 'info', text: `Deleted ${entry.name || entry.typeLabel}.` });
    } catch (e) {
      const message =
        e instanceof ApiError && e.isConflict
          ? 'That script changed on the gateway since this list was loaded. '
            + 'Nothing was deleted — reopen it to see the current version.'
          : describe(e);
      setNotice({ kind: 'error', text: message });
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  }, [closeDoc, pendingDelete, project, session.csrfToken]);

  // ---- named queries: create, rename, delete ---------------------------

  const doCreateQuery = useCallback(
    async (name: string) => {
      setQueryDialogBusy(true);
      setQueryDialogError(null);
      // The name IS the path: these routes take the query's path inside the
      // project, with no `ignition/named-query/` prefix.
      const path = name;
      try {
        // Created with empty SQL and the SERVER's own measured defaults — type
        // Query, enabled, maxReturnSize 100, cacheAmount 1 — rather than a
        // settings body invented here. The Settings tab is where they are then
        // chosen, and a create that named a type would be this client guessing
        // at a value the platform already has an answer for.
        await createNamedQuery({ project, path, csrfToken: session.csrfToken });
        setCreatingQuery(false);
        // Re-read rather than splicing the new entry in: the server decides the
        // signature, and inventing one would give the first save a base it
        // never agreed to.
        const refreshed = await fetchNamedQueries(project);
        setQueries(refreshed);
        const entry = refreshed.queries.find((candidate) => candidate.path === path);
        if (entry) {
          await openQuery(entry);
        }
        setNotice({ kind: 'info', text: `Created ${name}.` });
      } catch (e) {
        setQueryDialogError(describe(e));
      } finally {
        setQueryDialogBusy(false);
      }
    },
    [openQuery, project, session.csrfToken]
  );

  const doRenameQuery = useCallback(
    async (name: string) => {
      const entry = renamingQuery;
      if (!entry) return;
      setQueryDialogBusy(true);
      setQueryDialogError(null);
      const newPath = name;
      try {
        await renameNamedQuery({
          project,
          path: entry.path,
          newPath,
          // A QUERY carries its precondition: the move destroys the old path,
          // so a caller who has not read it must not move one that changed
          // underneath them.
          baseSignature: entry.signature,
          csrfToken: session.csrfToken,
        });
        setRenamingQuery(null);
        // Close any tab on the OLD path: the resource behind it no longer
        // exists, and the next Ctrl+S there would recreate it under the name
        // the user has just moved away from.
        docsRef.current
          .filter((doc) => doc.project === project && doc.path === entry.path)
          .forEach((doc) => closeDoc(doc.uri));
        const refreshed = await fetchNamedQueries(project);
        setQueries(refreshed);
        const moved = refreshed.queries.find((candidate) => candidate.path === newPath);
        if (moved) {
          await openQuery(moved);
        }
        setNotice({ kind: 'info', text: `Renamed to ${name}.` });
      } catch (e) {
        setQueryDialogError(describe(e));
      } finally {
        setQueryDialogBusy(false);
      }
    },
    [closeDoc, openQuery, project, renamingQuery, session.csrfToken]
  );

  /**
   * Move a folder, and every query the project owns under it.
   *
   * No precondition unless the gateway holds a folder RESOURCE for it: a folder
   * is usually implied by the paths beneath it, and there is no signature to
   * assert for something that is not a resource. The server moves the children
   * with it, so this re-lists rather than trying to track where each one went.
   */
  const doRenameFolder = useCallback(
    async (name: string) => {
      const target = renamingFolder;
      if (!target) return;
      setQueryDialogBusy(true);
      setQueryDialogError(null);
      try {
        await renameNamedQuery({
          project,
          path: target.folder,
          newPath: name,
          baseSignature: target.entry?.signature,
          csrfToken: session.csrfToken,
        });
        setRenamingFolder(null);
        // Close every tab under the OLD folder: those resources no longer exist
        // at those paths, and the next Ctrl+S in one of them would recreate the
        // query at the path the user has just moved it away from.
        const prefix = `${target.folder}/`;
        docsRef.current
          .filter((doc) => doc.kind === 'named-query'
            && doc.project === project
            && doc.path.startsWith(prefix))
          .forEach((doc) => closeDoc(doc.uri));
        await refreshQueries();
        setNotice({ kind: 'info', text: `Moved ${target.folder} to ${name}.` });
      } catch (e) {
        setQueryDialogError(describe(e));
      } finally {
        setQueryDialogBusy(false);
      }
    },
    [closeDoc, project, refreshQueries, renamingFolder, session.csrfToken]
  );

  const doDeleteQuery = useCallback(async () => {
    const entry = pendingQueryDelete;
    if (!entry) return;
    setDeleteBusy(true);
    try {
      await deleteNamedQuery({
        project,
        path: entry.path,
        baseSignature: entry.signature,
        csrfToken: session.csrfToken,
      });
      setPendingQueryDelete(null);
      // Close the tab too — an editor left open on a resource that no longer
      // exists means the next Ctrl+S recreates it, silently undoing the delete.
      docsRef.current
        .filter((doc) => doc.project === project && doc.path === entry.path)
        .forEach((doc) => closeDoc(doc.uri));
      await refreshQueries();
      setNotice({ kind: 'info', text: `Deleted ${entry.name}.` });
    } catch (e) {
      const message =
        e instanceof ApiError && e.isConflict
          ? 'That query changed on the gateway since this list was loaded. '
            + 'Nothing was deleted — reopen it to see the current version.'
          : describe(e);
      setNotice({ kind: 'error', text: message });
      setPendingQueryDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  }, [closeDoc, pendingQueryDelete, project, refreshQueries, session.csrfToken]);

  // ---- navigation ------------------------------------------------------

  /**
   * Move the caret to a zero-based line — in the active editor, or in the
   * document named by `uri`.
   *
   * The editor owns its CodeMirror views, so the jump is published as a DOM
   * event rather than plumbed through five components. `uri` is the WORKSPACE
   * document key, and passing one matters for every cross-file jump: the tab is
   * opened by React state, so the view may not exist yet when this runs. The
   * editor holds a reveal it cannot apply and applies it when the view appears
   * (see CodeEditor's pending-reveal effect), which is why nothing here waits or
   * retries.
   */
  const jumpToLine = useCallback((line: number, character: number, uri?: string) => {
    window.dispatchEvent(
      new CustomEvent('scriptide:reveal', { detail: { line, character, uri } })
    );
  }, []);

  /**
   * Open the place a language-server result points at.
   *
   * This is the join the server has been waiting for since P4: go-to-definition,
   * quick-open, search and references all answer with an `ignition://…` URI, and
   * nothing turned one back into an open tab before 1.6.0.
   *
   * Three answers, all of them real:
   *
   * - **A script this tree has** — open it and reveal the line.
   * - **A script it does not** — the AST index covers INHERITED library modules,
   *   and the definition of a helper can legitimately live in a parent project's
   *   module that the tree is not listing. Say which module, rather than opening
   *   the wrong file or doing nothing.
   * - **Another project entirely** — refuse, and say so. Switching the project
   *   selector under someone mid-edit is not a navigation.
   */
  const openLocation = useCallback(
    async (uri: string, line: number, character: number) => {
      const location = parseLocationUri(uri);
      if (!location) {
        setNotice({ kind: 'error', text: `Cannot open ${uri} — not a script on this gateway.` });
        return;
      }
      if (location.project !== project) {
        setNotice({
          kind: 'info',
          text: `That result is in project "${location.project}". Switch to it to open the file.`,
        });
        return;
      }
      // A named query addresses itself with the same `ignition://` scheme and
      // is resolved against its OWN listing — the script tree does not carry
      // one, so falling through would report a query as "not in this project's
      // script list", which is true and useless.
      //
      // BOTH path forms are accepted. The routes and the listing use the path
      // inside the project (`Orders/Totals`); a caller holding a resource-shaped
      // `ignition/named-query/Orders/Totals` — an older link, an LSP location —
      // means the same query, and refusing it would be pedantry with a dead
      // link on the end of it.
      const queryPath = stripResourcePrefix(location.path);
      const query = (queries?.queries ?? []).find(
        (candidate) => !candidate.isFolder && candidate.path === queryPath
      );
      if (query) {
        await openQuery(query);
        jumpToLine(line, character, docUri(project, query.path, QUERY_DATA_KEY));
        return;
      }
      if (isNamedQueryResourcePath(location.path)) {
        setNotice({
          kind: 'info',
          text: `${queryPath} is not a named query in this project.`,
        });
        return;
      }
      const entry = entryForLocation(tree?.scripts ?? [], location);
      if (!entry) {
        setNotice({
          kind: 'info',
          text: `${location.path} is indexed on the gateway but is not in this project's `
            + 'script list — it is most likely inherited from a parent project. '
            + 'Open it there to edit it.',
        });
        return;
      }
      await openScript(entry);
      jumpToLine(line, character, docUri(project, entry.path, entry.scriptKey));
    },
    [jumpToLine, openQuery, openScript, project, queries, tree]
  );

  /**
   * Replace across the project, from the Search view.
   *
   * The orchestration lives here rather than in `SearchPanel` because this is
   * where every other write lives: the CSRF token, the tree that says which
   * scripts are inherited, and the open documents that say which have unsaved
   * changes are all state of this component. The panel decides nothing — it
   * hands over the URIs it is showing and renders the report.
   *
   * Each file is written through the ORDINARY save route, with the If-Match
   * from its own read. Nothing here is a bulk path with its own rules: a
   * replace obeys inheritance, CSRF, byte fidelity and optimistic concurrency
   * because it is the same write, done several times.
   */
  const replaceAcrossProject = useCallback(
    async (
      uris: string[],
      term: string,
      replacement: string,
      caseSensitive: boolean
    ): Promise<ReplaceReport> => {
      const targets: ReplaceTarget[] = [];
      for (const uri of uris) {
        const location = parseLocationUri(uri);
        if (!location || location.project !== project) continue;
        const label = labelForLocation({ uri });

        // A named query's SQL is searched (1.16.0) and cannot be written through
        // the script route — it has its own, with settings against the same
        // signature. Skipping it LOUDLY rather than dropping it: a replace that
        // silently ignored half its own results would be the worst kind of
        // half-feature.
        if (isNamedQueryResourcePath(location.path)) {
          targets.push({
            uri, project, path: location.path, label, skip: 'named-query',
          });
          continue;
        }

        // Resolved from the URI, not from the script tree. The tree does not list
        // Web Dev endpoints at all — they have their own view — so a tree lookup
        // dropped every Web Dev hit without a word. The tree is still consulted,
        // but only for what it alone knows: whether a resource is inherited.
        const entry = entryForLocation(tree?.scripts ?? [], location);
        const path = entry?.path ?? location.path;
        const scriptKey = entry?.scriptKey ?? location.scriptKey;
        const key = docUri(project, path, scriptKey);
        const open = docs.find((doc) => doc.uri === key);
        targets.push({
          uri,
          project,
          path,
          key: scriptKey,
          label,
          skip:
            entry?.origin === 'inherited'
              ? 'read-only'
              : open && open.text !== open.baseText
                ? 'unsaved-changes'
                : undefined,
        });
      }
      const report = await runReplaceAll(targets, term, replacement, caseSensitive, {
        read: (target) => readScriptContent(target.project, target.path, target.key),
        write: (target, source, baseSignature) =>
          saveScriptContent({
            project: target.project,
            path: target.path,
            source,
            key: target.key,
            baseSignature,
            csrfToken: session.csrfToken,
          }),
      });
      if (report.wrote) {
        // Every open tab of a changed file now holds the OLD text against a
        // signature that has moved. The 20 s watch would find that on its own
        // within the minute; nudging it means the pull bar appears while the
        // user is still looking at the report that caused it.
        setWatchNonce((n) => n + 1);
        setNotice({ kind: 'info', text: summariseReplace(report) });
      }
      return report;
    },
    [docs, project, session.csrfToken, tree]
  );

  /**
   * Rename the active script, then OFFER to update its call sites.
   *
   * Two writes, never one: the move is a single resource push, and updating
   * imports is the ordinary project-wide replace with its preview, its skipping
   * of inherited and dirty documents, and its per-file report. A rename that
   * silently rewrote every file that mentioned the old name would be a bulk
   * write with none of those guards behind a button that says "Rename".
   */
  const doRename = useCallback(
    async (entry: ScriptEntry, newName: string, updateCallSites: boolean) => {
      const parts = entry.path.split('/');
      parts[parts.length - 1] = newName;
      const newPath = parts.join('/');
      const oldModule = moduleNameFor(entry.path);
      setRenameBusy(true);
      try {
        const result = await renameScript({
          project,
          path: entry.path,
          newPath,
          baseSignature: entry.signature,
          csrfToken: session.csrfToken,
        });
        setRenaming(null);
        // The open tab still points at a path that no longer exists. Closing it
        // is honest — its buffer was written to the NEW path a moment ago — and
        // the tree refresh below makes the new one openable.
        const oldUri = docUri(project, entry.path, entry.scriptKey);
        setDocs((current) => current.filter((doc) => doc.uri !== oldUri));
        setActiveUri((current) => (current === oldUri ? null : current));
        setTree(await fetchScriptTree(project));
        setNotice({ kind: 'info', text: `Renamed to ${newName}.` });

        if (updateCallSites && oldModule && result.newModule) {
          // Straight into the Search view with the old name in the box: the user
          // sees every call site and confirms the replace, exactly as if they
          // had searched for it themselves.
          setView('search');
          setReferencesRequest(null);
          setPendingReplace({ from: oldModule, to: result.newModule });
        }
      } catch (e: unknown) {
        setNotice({ kind: 'error', text: `Could not rename: ${describe(e)}` });
      } finally {
        setRenameBusy(false);
      }
    },
    [project, session.csrfToken]
  );

  /**
   * A references request, raised from the editor's Shift+F12.
   *
   * The nonce is what makes a second Shift+F12 on the same identifier re-run the
   * search: the name alone compares equal and the panel would ignore it.
   */
  const [referencesRequest, setReferencesRequest] =
    useState<{ name: string; nonce: number } | null>(null);

  /** Ctrl+P / Ctrl+T. Null when closed; the string is the palette's initial query. */
  const [quickOpen, setQuickOpen] = useState<string | null>(null);

  /** True while the local-history dialog is open for the ACTIVE document. */
  const [historyOpen, setHistoryOpen] = useState(false);

  /** True while the parent-comparison dialog is open for the ACTIVE document. */
  const [parentDiffOpen, setParentDiffOpen] = useState(false);

  /**
   * A replace the Search view should offer, set by a rename.
   *
   * The rename does not perform it — it hands the two names over and the user
   * confirms in the panel, seeing every file first.
   */
  const [pendingReplace, setPendingReplace] =
    useState<{ from: string; to: string } | null>(null);

  /** The tree entry being renamed, or null. */
  const [renaming, setRenaming] = useState<ScriptEntry | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  // A history dialog belongs to the document it was opened on. Switching tabs
  // with it open would leave it showing one file's versions above another
  // file's editor, and "Load into editor" would then put the wrong text in.
  useEffect(() => {
    setHistoryOpen(false);
    setParentDiffOpen(false);
  }, [activeUri]);

  useEffect(() => {
    function onOpenLocationEvent(event: Event) {
      const detail = (event as CustomEvent<OpenLocationDetail>).detail;
      if (detail) void openLocation(detail.uri, detail.line, detail.character);
    }
    function onFindReferences(event: Event) {
      const detail = (event as CustomEvent<FindReferencesDetail>).detail;
      if (!detail?.name) return;
      // Show the results before they arrive: the panel renders its own busy
      // state, and a keystroke that appears to do nothing for a second reads as
      // a keystroke that did nothing.
      setView('search');
      setRailOpen(true);
      setReferencesRequest({ name: detail.name, nonce: Date.now() });
    }
    window.addEventListener(OPEN_LOCATION_EVENT, onOpenLocationEvent);
    window.addEventListener(FIND_REFERENCES_EVENT, onFindReferences);
    return () => {
      window.removeEventListener(OPEN_LOCATION_EVENT, onOpenLocationEvent);
      window.removeEventListener(FIND_REFERENCES_EVENT, onFindReferences);
    };
  }, [openLocation]);

  /**
   * The three navigation shortcuts that are not the editor's.
   *
   * Bound on the window rather than in CodeMirror because they must work from
   * the tree, the console and the search box as well as from a buffer — and
   * because with no script open there is no CodeMirror view to have bound them.
   *
   * Ctrl+P and Ctrl+T are both browser bindings (print, new tab), so both
   * preventDefault. Ctrl+T is refused by Chrome and cannot be intercepted at
   * all, which is exactly why `#` in the Ctrl+P palette does the same job: the
   * shortcut is a convenience, the prefix is the guarantee.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p' && !event.shiftKey) {
        event.preventDefault();
        setQuickOpen('');
      } else if (key === 't' && !event.shiftKey) {
        event.preventDefault();
        setQuickOpen('#');
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        setView('search');
        setRailOpen(true);
      } else if (key === '\\') {
        // VS Code's split binding, and it toggles: pressing it again on the
        // document you just moved brings it back. Nothing in the browser claims
        // Ctrl+\, so the preventDefault is only for a host that might.
        event.preventDefault();
        const focused = paneStateRef.current.activeUri;
        if (focused) moveToOtherPane(focused);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [moveToOtherPane]);

  /**
   * Activity-bar click on a side-bar view.
   *
   * Clicking the ACTIVE view collapses the side bar; clicking any other opens it
   * on that view. That is VS Code's behaviour, and it is the only way one strip
   * both switches views and toggles the panel it sits beside.
   */
  const selectView = useCallback((next: ViewId) => {
    setView((current) => {
      if (current === next) {
        setRailOpen((open) => !open);
        return current;
      }
      setRailOpen(true);
      return next;
    });
  }, []);

  /**
   * Activity-bar click on a panel view.
   *
   * Same rule one level down: the tab you are already on closes the panel, any
   * other switches to it and opens the panel if it was shut.
   */
  const selectPanel = useCallback((next: PanelId) => {
    if (next === 'terminal') {
      // Mount the terminal the first time it is asked for, not on page load —
      // opening the IDE should not start a shell on the gateway.
      setTerminalStarted(true);
    }
    setPanelOpen((open) => {
      if (open && panelTab === next) {
        return false;
      }
      setPanelTab(next);
      return true;
    });
  }, [panelTab]);

  /** Open the panel on a given tab, without the toggle-off behaviour. */
  const showPanel = useCallback((tab: PanelId) => {
    if (tab === 'terminal') setTerminalStarted(true);
    setPanelTab(tab);
    setPanelOpen(true);
  }, []);

  const layout: LayoutState = {
    sideBar: railOpen,
    panel: panelOpen,
    secondary: outlineOpen,
  };

  const toggleRegion = useCallback((region: keyof LayoutState) => {
    if (region === 'sideBar') setRailOpen((open) => !open);
    else if (region === 'panel') setPanelOpen((open) => !open);
    else setOutlineOpen((open) => !open);
  }, []);

  const resetLayout = useCallback(() => {
    setRailOpen(true);
    setOutlineOpen(true);
    setPanelOpen(false);
    setPanelMaximised(false);
    setRailWidth(260);
    setOutlineWidth(240);
    // Reset means "the height this viewport would have opened at", not the
    // height some other viewport once did.
    const panel = defaultPanelHeight(window.innerHeight);
    setPanelHeight(panel);
    rememberWidth('rail', 260);
    rememberWidth('outline', 240);
    rememberWidth('panel', panel);
  }, []);

  /** Open the console in its own browser tab, on the current project. */
  const popOutConsole = useCallback(() => {
    const url = `${window.location.pathname}?view=console&project=${encodeURIComponent(project)}`;
    const handle = window.open(url, '_blank');
    if (handle) {
      try {
        handle.opener = null;
      } catch {
        /* same-origin, so this is hygiene rather than an exposure */
      }
      // Popped out means popped out — leaving a second console in this tab
      // would give two REPLs that look alike and do not share locals.
      setPanelOpen(false);
    } else {
      setNotice({
        kind: 'error',
        text: 'The browser blocked the pop-out. Allow popups for this gateway, '
          + 'or keep using the console in this tab.',
      });
    }
  }, [project]);

  /** Open the Query Browser in its own browser tab, on the current project. */
  const popOutQuery = useCallback(() => {
    const url = `${window.location.pathname}?view=query&project=${encodeURIComponent(project)}`;
    const handle = window.open(url, '_blank');
    if (handle) {
      try {
        handle.opener = null;
      } catch {
        /* same-origin, so this is hygiene rather than an exposure */
      }
      setPanelOpen(false);
    } else {
      setNotice({
        kind: 'error',
        text: 'The browser blocked the pop-out. Allow popups for this gateway, '
          + 'or keep using the Query Browser in this tab.',
      });
    }
  }, [project]);

  /**
   * Open a DRAFT for a gateway-event singleton that does not exist yet.
   *
   * Until 1.5.0 this called `createScript` on the click itself — the real
   * Designer creates nothing until you save, and a click here was writing to
   * the live project with no confirmation (02/09/2026: browsing the
   * tree should not add resources, or git diffs, to a project). Separate from
   * `doCreate` because a singleton has no name to ask for — its resource path
   * is `<module>/<type>` with no third segment — and unlike a NAMED create
   * from the "New script…" dialog, a bare click on a tree row is not an
   * explicit "make this now".
   */
  const openSingletonDraft = useCallback(
    (typeId: ScriptTypeId) => {
      const path = `ignition/${typeId}`;
      const scriptKey = SINGLETON_KEYS[typeId] ?? 'code.py';
      const uri = docUri(project, path, scriptKey);
      if (docsRef.current.some((d) => d.uri === uri)) {
        selectDoc(uri);
        return;
      }
      const typeLabel = TYPE_LABELS[typeId] ?? typeId;
      setDocs((current) => [
        ...current,
        newUnsavedDoc({ project, path, scriptKey, typeLabel, label: typeLabel }),
      ]);
      selectDoc(uri);
      setNotice(null);
    },
    [project]
  );

  /** The open query in one pane, or null — see the per-pane `hidden` above. */
  function queryDocIn(uri: string | null) {
    const doc = uri ? docs.find((d) => d.uri === uri) : null;
    return doc && doc.kind === 'named-query' ? doc : null;
  }

  /**
   * Everything above the buffer that describes the FOCUSED document.
   *
   * Built once and rendered into whichever pane holds that document. It is not
   * a component: it closes over a dozen derivations that would otherwise all
   * become props, and it is rendered in exactly one place at a time.
   */
  const paneChrome = (
    <>
              {/* First of all the bars, and the only one about something that
                  has ALREADY happened. Everything below it is about what is
                  about to happen. */}
              {myDrafts.length > 0 && (
                <div className="workspace-recover" role="status">
                  <IconAlert size={16} />
                  <div className="workspace-signedout-text">
                    <strong>
                      {myDrafts.length === 1
                        ? `Unsaved work in ${myDrafts[0].label} from a previous session.`
                        : `Unsaved work in ${myDrafts.length} scripts from a previous session.`}
                    </strong>{' '}
                    {/* Says where it was kept, because that is the limit of the
                        promise: this browser, on this machine. None of it was
                        ever sent to the gateway. */}
                    Kept in this browser only — {myDrafts.map((d) => d.label).join(', ')}.
                  </div>
                  <button type="button" className="button" onClick={() => void restoreDrafts()}>
                    Restore
                  </button>
                  <button type="button" className="button button-quiet" onClick={forgetDrafts}>
                    Discard
                  </button>
                </div>
              )}
              {/* Above every other bar here: the others are about what YOU are
                  about to do, this one is about somebody else already doing it. */}
              <PresenceBar peers={activePresence} designerFeed={presence.designerFeed} />
              {/* A bar on the document itself, not only a marker in the strip.
                  The tab's arrow and the toolbar count were both missable
                  (04/09/2026: "a bit to easy to miss"), and neither is
                  where you are looking — which is at the code. This sits between
                  the tab and the buffer it is about, and only for the document
                  actually on screen. */}
              {impactWarning !== null && impactWarning.uri === activeUri && (
                /* The one thing the Designer cannot tell you, at the one moment
                   it matters. Not a refusal — changing a signature on purpose is
                   ordinary — but the call sites are named BEFORE the write, not
                   discovered at run time by whatever imported it. */
                <div className="workspace-savewarn" role="alert">
                  <IconAlert size={16} />
                  <div className="workspace-signedout-text">
                    <strong>Other files call into {impactWarning.label}.</strong>{' '}
                    {impactWarning.detail} Matched by NAME, so an unrelated
                    member spelled the same is included — read the list, do not
                    trust the count.
                  </div>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      // Straight to the list, with the save still pending. The
                      // bar stays up behind it, so the decision is still there
                      // to take when they come back.
                      setView('search');
                      setReferencesRequest({
                        name: impactWarning.names[0],
                        nonce: Date.now(),
                      });
                    }}
                  >
                    Show the call sites
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const uri = impactWarning.uri;
                      setImpactWarning(null);
                      void saveDoc(uri, undefined, true);
                    }}
                  >
                    Save anyway
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setImpactWarning(null)}
                  >
                    Keep editing
                  </button>
                </div>
              )}
              {saveWarning !== null && saveWarning.uri === activeUri && (
                /* One question, in the same place as the session bar and with the
                   same shape: what is wrong, what happens next, and both answers
                   as buttons. It does NOT refuse — stopping halfway through a
                   refactor and saving is ordinary — it just makes writing code
                   that cannot run a deliberate act rather than an accident. */
                <div className="workspace-savewarn" role="alert">
                  <IconAlert size={16} />
                  <div className="workspace-signedout-text">
                    <strong>{saveWarning.label} does not parse.</strong>{' '}
                    {saveWarning.detail}. Saving it puts it on the gateway as it
                    is — a gateway event script would start failing on its next
                    run.
                  </div>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      const uri = saveWarning.uri;
                      setSaveWarning(null);
                      void saveDoc(uri, undefined, true);
                    }}
                  >
                    Save anyway
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setSaveWarning(null)}
                  >
                    Keep editing
                  </button>
                </div>
              )}
              {signedOut !== null && (
                /* Above the stale bar and above the editor, and it does not go
                   away on its own. Everything the user needs is here: that the
                   work is safe, a way back in, and the retry. */
                <div className="workspace-signedout" role="alert">
                  <IconAlert size={16} />
                  <div className="workspace-signedout-text">
                    <strong>Your gateway session has ended.</strong>{' '}
                    {signedOut
                      ? `${signedOut} was not saved — nothing has been lost, the text is still in this tab.`
                      : 'Anything unsaved is still here. Nothing has been lost.'}{' '}
                    The gateway most likely restarted. Sign in again in the new
                    tab, come back, and save.
                  </div>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => window.open(window.location.href, '_blank', 'noopener')}
                  >
                    Sign in again
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => {
                      // Dismiss and let them try. If the session is still gone
                      // the save puts this straight back, which is the honest
                      // outcome — nothing here pretends to know the answer.
                      setSignedOut(null);
                      if (activeUri) void saveDoc(activeUri);
                    }}
                    disabled={!activeUri}
                  >
                    Retry the save
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => setSignedOut(null)}
                    aria-label="Dismiss"
                  >
                    ✕
                  </button>
                </div>
              )}
              {activeDoc && staleUris.has(activeDoc.uri) && (
                <div className="workspace-stale-bar" role="status">
                  <IconAlert size={14} />
                  <span>
                    <strong>{activeDoc.label}</strong> has changed on the gateway
                    {isDirty(activeDoc)
                      ? ' — and you have unsaved edits here.'
                      : '. You are looking at an older copy.'}
                  </span>
                  <button type="button" className="button" onClick={() => void pullDoc(activeDoc.uri)}>
                    {isDirty(activeDoc) ? 'Compare…' : 'Pull the current copy'}
                  </button>
                </div>
              )}
              {activeDoc && importSuggestions && importSuggestions.uri === activeDoc.uri && (
                <div className="import-suggestions-bar" role="status">
                  <span className="import-suggestions-label">Suggested imports:</span>
                  <ul className="import-suggestions-list">
                    {importSuggestions.items.map((suggestion) => (
                      <li key={suggestion.statement} className="import-suggestion">
                        <button
                          type="button"
                          className="import-suggestion-insert"
                          onClick={() => insertSuggestedImport(suggestion.statement)}
                          title={`Insert "${suggestion.statement}" at the top of the import block`}
                        >
                          <span className="import-suggestion-origin">{suggestion.origin}</span>
                          {suggestion.statement}
                        </button>
                        <button
                          type="button"
                          className="import-suggestion-dismiss"
                          onClick={() => dropSuggestion(suggestion.statement)}
                          aria-label={`Dismiss the suggestion for ${suggestion.name}`}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="import-suggestions-close"
                    onClick={() => setImportSuggestions(null)}
                    aria-label="Dismiss all suggestions"
                  >
                    ✕
                  </button>
                </div>
              )}
              {activeUri && activeQueryDoc && activeQueryDoc.settings && (
                /* Keyed on the document so each query opens its own editor state
                   — a parameter table left mid-edit must not follow you to the
                   next tab. */
                <NamedQueryEditor
                  key={activeUri}
                  project={activeQueryDoc.project}
                  path={activeQueryDoc.path}
                  sql={activeQueryDoc.text}
                  settings={activeQueryDoc.settings}
                  legacy={activeQueryDoc.legacy}
                  databases={activeQueryDoc.databases ?? []}
                  editable={activeQueryDoc.editableSettings ?? []}
                  tab={queryTab}
                  onTabChange={setQueryTab}
                  onChange={(next) => changeQuerySettings(activeUri, next)}
                  onSave={() => void saveDoc(activeUri)}
                  dirty={isDirty(activeQueryDoc)}
                  readOnly={!activeWritable}
                  saving={saving}
                  csrfToken={session.csrfToken}
                  leading={inheritanceNotice}
                />
              )}
              {activeUri && !activeQueryDoc && activeAttrs && (
                <ConfigStrip
                  // The inheritance state shares the settings row rather than
                  // taking one of its own. Two chrome rows above the code cost
                  // ~70px for two short sentences that are never both true
                  // (02/09/2026).
                  leading={inheritanceNotice}
                  editable={activeAttrs.editable}
                  attributes={activeAttrs.attributes}
                  onChange={(name, value) => changeAttribute(activeUri, name, value)}
                  onSave={() => void saveAttributes(activeUri)}
                  dirty={attrsDirty}
                  readOnly={!activeWritable}
                  saving={savingAttrs}
                  typeId={activeEntry?.typeId}
                  unconfigurableReason={
                    activeEntry?.typeId === 'tag-change'
                      ? 'Tag Change settings are not editable here yet — the Designer\'s tag-path '
                        + 'list has not been measured, and writing a guessed key would put a value '
                        + 'on the gateway that the Designer never reads. Configure it in the '
                        + 'Designer; the script body is fully editable here.'
                      : undefined
                  }
                />
              )}
    </>
  );

  return (
    <main className="workspace">
      {renaming && (
        <RenameDialog
          entry={renaming}
          moduleName={moduleNameFor(renaming.path) ?? undefined}
          busy={renameBusy}
          onCancel={() => setRenaming(null)}
          onRename={(newName, updateCallSites) =>
            void doRename(renaming, newName, updateCallSites)
          }
        />
      )}

      {parentDiffOpen && activeDoc && !activeQueryDoc && (
        <ParentDiffDialog
          project={activeDoc.project}
          path={activeDoc.path}
          scriptKey={activeDoc.scriptKey}
          label={activeDoc.label}
          mine={activeDoc.text}
          onClose={() => setParentDiffOpen(false)}
        />
      )}

      {historyOpen && activeDoc && !activeQueryDoc && (
        <HistoryDialog
          project={activeDoc.project}
          path={activeDoc.path}
          scriptKey={activeDoc.scriptKey}
          label={activeDoc.label}
          currentText={activeDoc.text}
          onClose={() => setHistoryOpen(false)}
          onLoad={(text) => handleChange(activeDoc.uri, text)}
        />
      )}

      <div className="workspace-toolbar">
        <label className="workspace-project">
          <span className="config-label">Project</span>
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            disabled={projects.length === 0}
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
                {p.mutable ? '' : ' (read-only)'}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="button"
          onClick={() => activeUri && void saveDoc(activeUri)}
          disabled={!activeDoc || !activeWritable || saving || !isDirty(activeDoc)}
        >
          {saving ? 'Saving…' : activeQueryDoc ? 'Save query' : 'Save script'}
        </button>

        {/* Only for a script document. A named query is two halves against one
            signature and the history store keeps one body per document, so
            offering it there would restore the SQL and silently leave the
            settings — the same lost-update shape validate_v17_nq found. */}
        {activeDoc && !activeQueryDoc && (
          <button
            type="button"
            className="button"
            onClick={() => setHistoryOpen(true)}
            title="Versions this IDE has saved of this file"
          >
            History
          </button>
        )}

        {/* Python documents only — a named query is SQL and a Web Dev text
            resource is HTML, and organising either as Jython imports would be
            nonsense. See isPythonDoc. */}
        {activeDoc && isPythonDoc(activeDoc) && (
          <button
            type="button"
            className="button"
            onClick={() => void organiseImportsDoc()}
            title="Sort and de-duplicate the leading import block, and suggest imports for unknown names"
          >
            Organise imports
          </button>
        )}

        {/* Only where there is something to compare against. `override` means
            this project owns a copy of a resource a parent also has; anything
            else has no parent copy and the dialog would only ever say so. */}
        {activeDoc && !activeQueryDoc && activeDoc.origin === 'override' && (
          <button
            type="button"
            className="button"
            onClick={() => setParentDiffOpen(true)}
            title="What this override changes, compared with the project it inherits from"
          >
            Compare with parent
          </button>
        )}

        {/* Not a singleton (the platform names those) and not inherited (not this
            project's to move) — the same two the server refuses, so the button is
            absent rather than present and failing. */}
        {activeEntry && !readOnly && !activeEntry.singleton
          && activeEntry.origin !== 'inherited' && (
          <button
            type="button"
            className="button"
            onClick={() => setRenaming(activeEntry)}
            title={`Rename ${activeEntry.name}`}
          >
            Rename
          </button>
        )}

        {/* Pull is offered ONLY when there is something to pull. A permanently
            visible "Pull" button trains people to press it on a schedule; a
            button that appears with a count is the notification. */}
        {staleUris.size > 0 && (
          <button
            type="button"
            className="button workspace-stale"
            onClick={() => void pullAll()}
            title="These open documents changed on the gateway — most likely edited in the Designer."
          >
            {`Pull ${staleUris.size} change${staleUris.size === 1 ? '' : 's'}`}
          </button>
        )}

        {readOnly && (
          <span className="workspace-readonly" role="status">
            {readOnlyReason}
          </span>
        )}
        {notice && (
          <span className={`workspace-notice is-${notice.kind}`} role="status">
            {notice.text}
          </span>
        )}

        <span className="workspace-toolbar-gap" />

        {/* The four VS Code layout glyphs replace the 1.2.0 "Console" and
            "Outline" text buttons: one control set for all three regions,
            in the place a VS Code user already looks for them. */}
        <LayoutControls layout={layout} onToggle={toggleRegion} onReset={resetLayout} />
      </div>

      <div className="workspace-body">
        <ActivityBar
          active={view}
          expanded={railOpen}
          onSelect={selectView}
          activePanel={panelOpen ? panelTab : null}
          onSelectPanel={selectPanel}
        />

        {/* The rail is a column, not just the tree: the tree scrolls inside it
            and the footer stays pinned to the bottom edge, so a project with
            eight scripts no longer leaves half the rail as bare background. */}
        {railOpen && (
          <>
            <div className="workspace-rail" style={{ width: railWidth, flex: `0 0 ${railWidth}px` }}>
              <div className="rail-title">{RAIL_TITLES[view]}</div>
              {view === 'named-queries' ? (
                queries ? (
                  <NamedQueryTree
                    queries={queries.queries}
                    selectedPath={activeQueryDoc?.path ?? null}
                    onSelect={(entry) => void openQuery(entry)}
                    // Create, rename and delete are offered only when the
                    // session can actually perform them. A visible button that
                    // always 403s teaches people the tool is broken rather than
                    // that they lack a role.
                    onCreate={readOnly ? undefined : () => {
                      setQueryDialogError(null);
                      setCreatingQuery(true);
                    }}
                    onRename={readOnly ? undefined : (entry) => {
                      setQueryDialogError(null);
                      setRenamingQuery(entry);
                    }}
                    onRenameFolder={readOnly ? undefined : (folder, entry) => {
                      setQueryDialogError(null);
                      setRenamingFolder({ folder, entry });
                    }}
                    onDelete={readOnly ? undefined : (entry) => setPendingQueryDelete(entry)}
                  />
                ) : (
                  <nav className="file-tree" aria-label="Named Queries">
                    <p className="file-tree-empty muted">
                      {queriesError ? queriesError : 'Loading named queries…'}
                    </p>
                  </nav>
                )
              ) : view === 'search' ? (
                <SearchPanel
                  project={project}
                  lsp={lsp}
                  referencesRequest={referencesRequest}
                  onOpenLocation={(uri, line, character) =>
                    void openLocation(uri, line, character)
                  }
                  // Undefined for a reader who cannot write, so the replace row
                  // is absent rather than a button that 403s. `readOnly` is the
                  // same gate the save path uses.
                  onReplaceAll={readOnly ? undefined : replaceAcrossProject}
                  pendingReplace={pendingReplace}
                  onPendingReplaceHandled={() => setPendingReplace(null)}
                />
              ) : view === 'webdev' ? (
                <WebDevTree
                  endpoints={webDevEndpoints}
                  selectedPath={activeDoc?.path ?? null}
                  selectedKey={activeDoc?.scriptKey ?? null}
                  // A Web Dev row opens ONE file, so the data key is chosen by
                  // the row rather than by the resource's default — a verb
                  // handler here, and any other file below.
                  onOpen={(entry, method) =>
                    void openScript({ ...entry, scriptKey: `${method}.py` })
                  }
                  onOpenFile={(entry, dataKey) =>
                    void openScript({ ...entry, scriptKey: dataKey })
                  }
                  onCreate={readOnly ? undefined : () => {
                    setCreateError(null);
                    setCreating('resources');
                  }}
                  onDelete={readOnly ? undefined : (entry) => setPendingDelete(entry)}
                  onAddMethod={readOnly ? undefined : (entry, method) => {
                    void addWebDevMethod(entry, method);
                  }}
                  onEditConfig={(entry) => setConfigEntry(entry)}
                />
              ) : tree ? (
                <FileTree
                  scripts={tree.scripts}
                  gitMarks={gitMarks}
                  selectedPath={activeDoc?.path ?? null}
                  onSelect={(entry) => void openScript(entry)}
                  // Create and delete are offered only when the session can
                  // actually perform them. A visible button that always 403s
                  // teaches people the tool is broken rather than that they
                  // lack a role.
                  onCreate={
                    readOnly
                      ? undefined
                      : (typeId) => { setCreateError(null); setCreating(typeId); }
                  }
                  onDelete={readOnly ? undefined : (entry) => setPendingDelete(entry)}
                  onContext={(event) => setTreeMenu(event)}
                  onCreateSingleton={
                    readOnly ? undefined : (typeId) => openSingletonDraft(typeId)
                  }
                />
              ) : (
                <nav className="file-tree" aria-label="Scripts">
                  <p className="file-tree-empty muted">
                    {treeError ? treeError : 'Loading scripts…'}
                  </p>
                </nav>
              )}
              {/* Only when there is something to say. A permanent "0 changes"
                  line is chrome, and chrome in this spot is what teaches people
                  to stop reading it. */}
              {gitSummary && (
                <p
                  className={`git-summary${git.error ? ' is-error' : ''}`}
                  title={
                    git.error
                      ? 'The project has a .git directory that could not be read.'
                      : 'Changes since the last commit. Read-only — commit from the command line.'
                  }
                >
                  {gitSummary}
                </p>
              )}
              <StatusFooter scripts={tree?.scripts ?? []} transport={transport} />
            </div>
            <Resizer
              value={railWidth}
              min={170}
              max={520}
              side="left"
              label="Resize the side bar"
              onChange={(width) => {
                setRailWidth(width);
                rememberWidth('rail', width);
              }}
            />
          </>
        )}

        {/* Editor above, panel below — the panel spans the editor's width and
            stops at the side bars, exactly as VS Code's does. Maximising hides
            the editor rather than resizing it to nothing, so restoring returns
            to the height the user had chosen. */}
        <div className="workspace-center">
          <section className="workspace-editor" hidden={panelOpen && panelMaximised}>
            {/* The chrome — stale bar, settings, the named-query editor —
                belongs to the FOCUSED document and is rendered into whichever
                pane is holding it, never duplicated. Two settings rows side by
                side would halve the width of a row nobody edits often, for the
                same reason the inheritance note shares that row rather than
                taking one of its own; and what was asked to compare is the
                CODE. */}
            <div className={`workspace-panes${splitUris.size > 0 ? ' is-split' : ''}`}>
              <div
                className="workspace-pane"
                style={splitUris.size > 0
                  ? { flex: `0 0 ${splitWidth}px`, width: splitWidth }
                  : undefined}
              >
                <TabStrip
                  docs={leftDocs}
                  activeUri={leftActive}
                  staleUris={staleUris}
                  presence={presenceByUri}
                  onSelect={selectDoc}
                  onClose={closeDoc}
                  onPull={(uri) => void pullDoc(uri)}
                  onSplit={leftDocs.length > 0 ? moveToOtherPane : undefined}
                  splitLabel={splitUris.size > 0
                    ? 'Move this document to the right-hand editor'
                    : 'Open this document in a second editor beside this one'}
                  splitText={splitUris.size > 0 ? 'Move right' : 'Split'}
                />
                {!focusedPaneIsRight && paneChrome}
                {docs.length === 0 && (
                  <p className="code-editor-empty">
                    Choose a script or a named query on the left to start editing.
                  </p>
                )}
                <CodeEditor
                  docs={leftDocs}
                  activeUri={leftActive}
                  readOnly={readOnly}
                  onChange={handleChange}
                  onSave={(uri) => void saveDoc(uri)}
                  lsp={lsp}
                  // A ruler mark: put the caret on the problem AND open Problems
                  // on it, so the message is readable and copyable in one click —
                  // the Designer stops at the hover (03/09/2026).
                  onRevealProblem={(line, character) => {
                    jumpToLine(line, character);
                    showPanel('problems');
                  }}
                  // Hidden, never unmounted, while a query's Settings or Testing
                  // tab has the area: unmounting would destroy every open
                  // document's view along with its undo history. Per PANE, so a
                  // query's Settings tab does not blank the script beside it.
                  hidden={queryDocIn(leftActive) ? !showsBuffer(queryTab) : false}
                />
              </div>

              {splitUris.size > 0 && (
                <Resizer
                  value={splitWidth}
                  min={240}
                  max={2000}
                  // The pane it sizes is on its LEFT, so dragging right grows
                  // it. `side` names where the panel is, not where the drag is.
                  side="left"
                  label="Resize the editors"
                  onChange={(width) => {
                    setSplitWidth(width);
                    rememberWidth('split', width);
                  }}
                />
              )}

              {splitUris.size > 0 && (
                <div className="workspace-pane">
                  <TabStrip
                    docs={rightDocs}
                    activeUri={rightActive}
                    staleUris={staleUris}
                    presence={presenceByUri}
                    onSelect={selectDoc}
                    onClose={closeDoc}
                    onPull={(uri) => void pullDoc(uri)}
                    onSplit={moveToOtherPane}
                    splitLabel="Move this document back to the left-hand editor"
                    splitText="Move left"
                  />
                  {focusedPaneIsRight && paneChrome}
                  <CodeEditor
                    docs={rightDocs}
                    activeUri={rightActive}
                    readOnly={readOnly}
                    onChange={handleChange}
                    onSave={(uri) => void saveDoc(uri)}
                    lsp={lsp}
                    onRevealProblem={(line, character) => {
                      jumpToLine(line, character);
                      showPanel('problems');
                    }}
                    hidden={queryDocIn(rightActive) ? !showsBuffer(queryTab) : false}
                  />
                </div>
              )}
            </div>
          </section>

          {panelOpen && !panelMaximised && (
            <Resizer
              value={panelHeight}
              min={90}
              max={900}
              side="below"
              label="Resize the panel"
              onChange={(height) => {
                setPanelHeight(height);
                rememberWidth('panel', height);
              }}
            />
          )}

          {panelOpen && (
            <div
              className="workspace-panel-slot"
              style={
                panelMaximised
                  ? { flex: '1 1 auto', minHeight: 0 }
                  : { flex: `0 0 ${panelHeight}px`, height: panelHeight }
              }
            >
              <Panel
                activeId={panelTab}
                onSelect={(id) => showPanel(id as PanelId)}
                onClose={() => setPanelOpen(false)}
                maximised={panelMaximised}
                onToggleMaximise={() => setPanelMaximised((on) => !on)}
                tabs={[
                  {
                    id: 'problems',
                    label: 'Problems',
                    content: (
                      <ProblemsPanel
                        docs={scriptDocs}
                        lsp={lsp}
                        project={project}
                        // Already-open documents only, so this is a reveal in a
                        // view that exists — no location parsing needed.
                        onOpen={(uri, line, character) => {
                          selectDoc(uri);
                          jumpToLine(line, character, uri);
                        }}
                      />
                    ),
                  },
                  {
                    id: 'console',
                    label: 'Script Console',
                    actions: (
                      <button
                        type="button"
                        className="panel-icon-button"
                        onClick={popOutConsole}
                        aria-label="Open the console in a new browser tab"
                        title="Open in a new browser tab"
                      >
                        <IconExternal size={14} />
                      </button>
                    ),
                    content: (
                      /* NOT keyed on the project (unlike QueryBrowser below): the
                         console owns its own project picker (1.29.0), so a switch
                         of the IDE's own project must not remount it — that would
                         drop the picker's choice and the buffer along with it.
                         `project` only ever seeds the picker's initial default. */
                      <ScriptConsole
                        project={project}
                        csrfToken={session.csrfToken}
                        canExecute={session.canExecute !== false && !readOnly}
                        activeSource={activeSource}
                        onOpenFrame={(path, line) => {
                          const entry = tree?.scripts.find((c) => c.path === path);
                          if (entry) {
                            void openScript(entry).then(() => jumpToLine(line - 1, 0));
                          }
                        }}
                      />
                    ),
                  },
                  {
                    id: 'query',
                    label: 'Query',
                    actions: (
                      <button
                        type="button"
                        className="panel-icon-button"
                        onClick={popOutQuery}
                        aria-label="Open the Query Browser in a new browser tab"
                        title="Open in a new browser tab"
                      >
                        <IconExternal size={14} />
                      </button>
                    ),
                    content: (
                      /* Keyed on the project, like the console: the remembered
                         datasource and buffer are per viewer, not per project,
                         but a fresh mount on switching projects still avoids a
                         run in flight outliving the project it was sent to. */
                      <QueryBrowser
                        key={project}
                        project={project}
                        csrfToken={session.csrfToken}
                        // Role only, not `readOnly` — that flag also covers an
                        // immutable PROJECT, which has no bearing on running raw
                        // SQL against a datasource; folding it in here would
                        // attribute a denial to the wrong reason.
                        isAdmin={session.writable}
                        executionEnabled={session.executionEnabled !== false}
                      />
                    ),
                  },
                  {
                    id: 'terminal',
                    label: 'Terminal',
                    actions: (
                      <button
                        type="button"
                        className="panel-icon-button"
                        onClick={() => {
                          setTerminalStarted(true);
                          setTerminalKey((n) => n + 1);
                        }}
                        aria-label="New terminal"
                        title="New terminal"
                      >
                        <IconPlus size={14} />
                      </button>
                    ),
                    content: terminalStarted ? (
                      /* The key is what restarts a shell: the component owns the
                         emulator and the connection, so a remount is the only
                         honest way to end one and begin another. */
                      <TerminalView
                        key={terminalKey}
                        csrfToken={session.csrfToken}
                        canOpen={session.canExecute !== false}
                      />
                    ) : (
                      <p className="terminal-notice">Starting a shell…</p>
                    ),
                  },
                  {
                    id: 'tests',
                    label: 'Tests',
                    content: (
                      /* Keyed on the project, like the console: a listing and a
                         set of results both belong to one project, and carrying
                         either across a switch shows the old project's answer
                         under the new project's name. */
                      <TestsPanel
                        key={project}
                        project={project}
                        csrfToken={session.csrfToken}
                        // The same gate the console uses. A Run button that
                        // always 403s teaches people the tool is broken rather
                        // than that they lack a role.
                        canRun={session.canExecute !== false && !readOnly}
                        onOpenTest={(moduleName, line) => {
                          const path = `ignition/script-python/${moduleName.replace(/\./g, '/')}`;
                          const entry = tree?.scripts.find((c) => c.path === path);
                          if (entry) {
                            void openScript(entry).then(() => jumpToLine(line, 0));
                          }
                        }}
                      />
                    ),
                  },
                ]}
              />
            </div>
          )}
        </div>

        {outlineOpen && (
          <>
            <Resizer
              value={outlineWidth}
              min={160}
              max={520}
              side="right"
              label="Resize the outline"
              onChange={(width) => {
                setOutlineWidth(width);
                rememberWidth('outline', width);
              }}
            />
            <OutlinePanel
              // Null for a named query: the outline is the Jython symbol table
              // and SQL has none. An outline that stayed on the last script
              // would describe a file nobody is looking at.
              uri={activeUri && !activeQueryDoc
                ? lspUri(activeDoc?.project ?? project, activeDoc?.path ?? '', activeDoc?.scriptKey)
                : null}
              revision={docRevision}
              lsp={lsp}
              onJump={jumpToLine}
              width={outlineWidth}
              onClose={() => setOutlineOpen(false)}
            />
          </>
        )}
      </div>

      {quickOpen !== null && (
        <QuickOpen
          project={project}
          scripts={tree?.scripts ?? []}
          queries={queries?.queries ?? []}
          lsp={lsp}
          initialQuery={quickOpen}
          onOpenEntry={(entry) => void openScript(entry)}
          onOpenQuery={(entry) => void openQuery(entry)}
          onOpenLocation={(uri, line, character) => void openLocation(uri, line, character)}
          onClose={() => setQuickOpen(null)}
        />
      )}

      {creating && (
        <NewScriptDialog
          typeId={creating}
          typeLabel={
            tree?.scripts.find((entry) => entry.typeId === creating)?.typeLabel
              ?? TYPE_LABELS[creating]
              ?? creating
          }
          existingNames={
            tree?.scripts
              .filter((entry) => entry.typeId === creating)
              .map((entry) => entry.name) ?? []
          }
          busy={createBusy}
          error={createError}
          onCreate={(name, source) => void doCreate(name, source)}
          onCancel={() => setCreating(null)}
        />
      )}

      {treeMenu && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          heading={treeMenu.label}
          onClose={() => setTreeMenu(null)}
          items={[
            {
              label: treeMenu.paths.length === 1
                ? 'Export…'
                : `Export ${treeMenu.paths.length} scripts…`,
              // A package with nothing in it has nothing to export. Disabled
              // and saying so beats a download of an empty zip.
              enabled: treeMenu.paths.length > 0,
              title: treeMenu.paths.length > 0
                ? 'Download as a Designer-compatible resource zip'
                : 'This package holds no scripts',
              onSelect: () => void doExport(treeMenu.paths, treeMenu.label),
            },
            {
              label: 'Import…',
              // The Designer keeps Import on the File menu and not on the tree.
              // It is here as well because a first import needs something to
              // click, and the tree is where somebody looks for it.
              enabled: !readOnly,
              title: readOnly
                ? 'Importing writes resources, which needs the Administrator role'
                : 'Read a resource zip and choose what to write',
              onSelect: () => importInputRef.current?.click(),
            },
          ]}
        />
      )}

      {/* Off-screen rather than hidden: a `display:none` input cannot be
          clicked programmatically in every browser, and `.click()` on it is the
          only way to open a file chooser from a menu item. */}
      <input
        ref={importInputRef}
        type="file"
        accept=".zip,application/zip"
        aria-label="Choose a resource zip to import"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Cleared so choosing the SAME file twice fires change again —-
          // otherwise a failed import cannot be retried without picking a
          // different file first.
          event.target.value = '';
          if (file) void beginImport(file);
        }}
      />

      {importing && (
        <ImportDialog
          project={project}
          fileName={importing.file.name}
          inspection={importing.inspection}
          busy={importBusy}
          outcome={importOutcome}
          error={importError}
          onImport={(paths) => void doImport(paths)}
          onClose={() => {
            setImporting(null);
            setImportOutcome(undefined);
            setImportError(undefined);
          }}
        />
      )}

      {pendingDelete && (
        <div className="newscript-backdrop" role="presentation">
          <div
            className="newscript-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            {/* Two different actions behind one route.
                DELETE on an overridden resource removes only THIS project's
                copy, and the script keeps working — inherited from the parent
                again. The Designer does not call that Delete; its menu on an
                overridden resource has no Delete at all, only `Discard
                Overrides`, and its dialog says "return to its inherited state".
                Wording a reversible action as a permanent one is how people
                learn to click past confirmations. */}
            {pendingDelete.origin === 'override' ? (
              <>
                <h2 id="delete-title">
                  Discard overrides on {pendingDelete.name || pendingDelete.typeLabel}?
                </h2>
                <p className="muted">
                  This removes <strong>{project}</strong>&rsquo;s copy and returns the script
                  to the version inherited from <strong>{pendingDelete.owner}</strong>. The
                  script keeps working; the local changes are lost.
                </p>
              </>
            ) : (
              <>
                <h2 id="delete-title">Delete {pendingDelete.name || pendingDelete.typeLabel}?</h2>
                <p className="muted">
                  This removes the script from <strong>{project}</strong> on the gateway.
                  It cannot be undone from here.
                </p>
              </>
            )}
            <div className="newscript-actions">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={deleteBusy}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void doDelete()} disabled={deleteBusy}>
                {pendingDelete.origin === 'override'
                  ? deleteBusy ? 'Discarding…' : 'Discard overrides'
                  : deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingClose && (
        <div className="newscript-backdrop" role="presentation">
          <div
            className="newscript-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="close-title"
          >
            <h2 id="close-title">
              Save {pendingClose.label} before closing?
            </h2>
            <p className="muted">
              {pendingClose.origin === 'new'
                ? 'This script has never been saved to the gateway. Closing it '
                  + 'discards it entirely.'
                : 'It has unsaved changes. Closing it discards them; the copy on '
                  + 'the gateway is unaffected.'}
            </p>
            {/* Three buttons, not two. "Cancel or lose it" is a false choice —
                the answer someone almost always wants is to save and then
                close, and making them cancel, save, and close again is how a
                confirmation becomes something people click past. */}
            <div className="newscript-actions">
              <button type="button" onClick={() => setPendingClose(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  // An explicit discard is a decision, so the draft goes too.
                  // Keeping it would offer the work back at the next reload,
                  // having just been told to throw it away.
                  dropDraft(pendingClose.uri);
                  forceCloseDoc(pendingClose.uri);
                  setPendingClose(null);
                }}
              >
                Discard changes
              </button>
              <button
                type="button"
                className="primary"
                disabled={!activeWritable && pendingClose.uri === activeUri}
                onClick={() => {
                  const uri = pendingClose.uri;
                  setPendingClose(null);
                  void saveDoc(uri).then(() => {
                    // Only close if the save actually landed. A 409 leaves the
                    // conflict dialog up, and closing the tab under it would
                    // throw away the very buffer being compared.
                    const after = docsRef.current.find((d) => d.uri === uri);
                    if (after && !isDirty(after)) forceCloseDoc(uri);
                  });
                }}
              >
                Save and close
              </button>
            </div>
          </div>
        </div>
      )}

      {configEntry && (
        <WebDevConfigDialog
          project={project}
          path={configEntry.path}
          name={configEntry.name}
          csrfToken={session.csrfToken}
          readOnly={readOnly}
          onClose={() => setConfigEntry(null)}
        />
      )}

      {(creatingQuery || renamingQuery || renamingFolder) && (
        <NamedQueryDialog
          mode={renamingFolder ? 'rename-folder' : renamingQuery ? 'rename' : 'create'}
          initialName={renamingFolder?.folder ?? renamingQuery?.path ?? ''}
          // Only a QUERY name can collide with a query name. A folder path may
          // legitimately match nothing in this list, so the check is skipped
          // rather than made up.
          existingNames={
            renamingFolder
              ? []
              : queries?.queries.filter((entry) => !entry.isFolder).map((entry) => entry.path) ?? []
          }
          busy={queryDialogBusy}
          error={queryDialogError}
          onSubmit={(name) => {
            if (renamingFolder) void doRenameFolder(name);
            else if (renamingQuery) void doRenameQuery(name);
            else void doCreateQuery(name);
          }}
          onCancel={() => {
            setCreatingQuery(false);
            setRenamingQuery(null);
            setRenamingFolder(null);
          }}
        />
      )}

      {pendingQueryDelete && (
        <div className="newscript-backdrop" role="presentation">
          <div
            className="newscript-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-query-title"
          >
            {/* The same two-actions-one-route distinction the script tree draws:
                deleting an OVERRIDE removes only this project's copy and the
                query keeps working, inherited from the parent. */}
            {pendingQueryDelete.origin === 'override' ? (
              <>
                <h2 id="delete-query-title">
                  Discard overrides on {pendingQueryDelete.name}?
                </h2>
                <p className="muted">
                  This removes <strong>{project}</strong>&rsquo;s copy and returns the query to
                  the version inherited from <strong>{pendingQueryDelete.owner}</strong>. The
                  query keeps working; the local changes are lost.
                </p>
              </>
            ) : (
              <>
                <h2 id="delete-query-title">Delete {pendingQueryDelete.name}?</h2>
                <p className="muted">
                  This removes the named query from <strong>{project}</strong> on the gateway.
                  Anything calling <code>{pendingQueryDelete.path}</code> stops
                  working. It cannot be undone from here.
                </p>
              </>
            )}
            <div className="newscript-actions">
              <button
                type="button"
                onClick={() => setPendingQueryDelete(null)}
                disabled={deleteBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void doDeleteQuery()}
                disabled={deleteBusy}
              >
                {pendingQueryDelete.origin === 'override'
                  ? deleteBusy ? 'Discarding…' : 'Discard overrides'
                  : deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {conflict && (
        <ConflictDialog
          label={conflict.label}
          mine={conflict.mine}
          theirs={conflict.theirs}
          busy={saving}
          onReloadTheirs={resolveReloadTheirs}
          onKeepMine={() => void resolveKeepMine()}
          onCancel={() => setConflict(null)}
        />
      )}
    </main>
  );
}

/**
 * The handler stub a new event script starts with.
 *
 * The Designer names the FILE after the handler function — `handleTimerEvent.py`
 * holds `def handleTimerEvent():` — and seeds a single tab-indented body line.
 * Measured for timer, message and startup (web-designer SCRIPTING.md §5.1–5.3);
 * scheduled and tag-change follow the same naming rule rather than a
 * measurement, which is safe because it is the BODY, not a resource attribute:
 * a wrong stub is visible and editable, where a wrong attribute is silent.
 *
 * A tab, never spaces — see the byte-fidelity rule in CodeEditor.
 */
const HANDLER_STUBS: Record<string, string> = {
  timer: 'def handleTimerEvent():\n\t',
  message: 'def handleMessage(payload):\n\t',
  scheduled: 'def handleScheduleEvent():\n\t',
  'tag-change': 'def onTagChange(tagPath, previousValue, currentValue, initialChange, missedEvents):\n\t',
  startup: 'def onStartup():\n\t',
  shutdown: 'def onShutdown():\n\t',
  update: 'def onUpdate():\n\t',
};

/**
 * The stub a new Web Dev handler starts with.
 *
 * `def doGet(request, session):` is the signature every Ignition Web Dev example
 * uses, and the file is named after the function exactly as the gateway event
 * scripts are. As with those stubs this is the BODY, not a resource attribute:
 * a wrong stub is visible and editable where a wrong attribute is silent.
 */
const WEBDEV_STUBS: Record<string, string> = Object.fromEntries(
  ['doGet', 'doPost', 'doPut', 'doDelete', 'doHead', 'doOptions', 'doTrace', 'doPatch'].map(
    (method) => [method, `def ${method}(request, session):\n\treturn {'json': {'ok': True}}`]
  )
);

/**
 * The `.py` data key a fresh singleton is created with — the type's own
 * `createKey`, mirrored from `ScriptResourceTypes` because the client has
 * nothing to read one off until the resource exists.
 */
/** The heading above the rail, per side-bar view. */
const RAIL_TITLES: Record<ViewId, string> = {
  scripts: 'Scripting',
  search: 'Search',
  webdev: 'Web Dev',
  'named-queries': 'Named Queries',
};

const SINGLETON_KEYS: Record<string, string> = {
  startup: 'onStartup.py',
  shutdown: 'onShutdown.py',
  update: 'onUpdate.py',
};

/** Fallback labels, for a type the current tree happens to hold none of. */
const TYPE_LABELS: Record<string, string> = {
  'script-python': 'Library',
  timer: 'Timer',
  message: 'Message Handler',
  scheduled: 'Scheduled',
  'tag-change': 'Tag Change',
  startup: 'Startup',
  shutdown: 'Shutdown',
  update: 'Update',
  resources: 'Web Dev',
};

function handlerStub(typeId: string): string {
  // The project library starts EMPTY, matching the zero-byte code.py the
  // Designer writes — a stub there would be this module inventing house style
  // for somebody else's codebase.
  if (typeId === 'script-python') {
    return '';
  }
  if (typeId === 'resources') {
    return WEBDEV_STUBS.doGet;
  }
  return HANDLER_STUBS[typeId] ?? '';
}

/** Human-readable text for anything thrown by the client. */
function describe(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
