/**
 * What has changed since the last commit, for the tree to decorate.
 *
 * The gateway reads `.git` with JGit and pushes a snapshot whenever it changes —
 * see `GitProbe`. Nothing here writes: staging, committing and remotes belong to
 * `module-git`, and this module is deliberately not becoming a second one.
 *
 * ## Marks are per RESOURCE, decorations are per NODE
 *
 * A script is two files on disk (`code.py` and `resource.json`) in one directory,
 * so the gateway folds file changes into resource changes before sending them.
 * The client then does the other half: a deleted resource has no node left in the
 * tree, so its mark rolls UP to the nearest folder that still exists. Without
 * that, a deletion — the change most worth noticing — would be the one change the
 * tree could not show.
 *
 * ## An undecorated tree claims something
 *
 * It claims "nothing has changed", so every way of failing has to look different
 * from it. `repo: false` means this project is not version-controlled and the
 * whole feature stays hidden. `error` means the repository is there and could not
 * be read, and that is said out loud. `head: null` means there is no commit to
 * compare against yet, where "everything is new" is true but useless as hundreds
 * of badges.
 */
import { sharedTransport } from './lspTransport';

/** Ordered by severity, worst first — a folder takes the worst of its children. */
export const GIT_MARKS = ['conflicted', 'deleted', 'modified', 'added'] as const;

export type GitMark = (typeof GIT_MARKS)[number];

export interface GitState {
  project: string;
  /** Whether this project is a git working tree at all. */
  repo: boolean;
  /** Branch name, or a short commit id when HEAD is detached. */
  branch: string | null;
  /** Short HEAD commit id. Null on an unborn branch — see the module note. */
  head: string | null;
  /** Why the repository could not be read, or null. */
  error: string | null;
  /** Resource path to its mark. */
  marks: Record<string, GitMark>;
  /** Changed files with no node in the tree, such as `project.json`. A count. */
  others: number;
  version: number;
}

export const NO_GIT: GitState = {
  project: '',
  repo: false,
  branch: null,
  head: null,
  error: null,
  marks: {},
  others: 0,
  version: -1,
};

type Subscriber = (state: GitState) => void;

function isMark(value: unknown): value is GitMark {
  return typeof value === 'string' && (GIT_MARKS as readonly string[]).includes(value);
}

/** One client for the tab, for the same reason presence has one. */
class GitClient {
  private state: GitState = NO_GIT;

  private readonly subscribers = new Set<Subscriber>();

  /** The project last asked for, replayed on reconnect. */
  private asked: string | null = null;

  private started = false;

  private start() {
    if (this.started) return;
    this.started = true;
    const transport = sharedTransport();
    transport.on('git', (msg) => {
      const payload = msg as Record<string, unknown> | undefined;
      if (!payload || typeof payload.project !== 'string') return;
      const marks: Record<string, GitMark> = {};
      const raw = payload.marks;
      if (raw && typeof raw === 'object') {
        for (const [path, mark] of Object.entries(raw as Record<string, unknown>)) {
          // Validated rather than cast: an unknown mark from a newer gateway
          // must be dropped, not rendered as a class name that styles nothing.
          if (isMark(mark)) marks[path] = mark;
        }
      }
      this.state = {
        project: payload.project,
        repo: payload.repo === true,
        branch: typeof payload.branch === 'string' ? payload.branch : null,
        head: typeof payload.head === 'string' ? payload.head : null,
        error: typeof payload.error === 'string' ? payload.error : null,
        marks,
        others: typeof payload.others === 'number' ? payload.others : 0,
        version: typeof payload.version === 'number' ? payload.version : 0,
      };
      for (const subscriber of [...this.subscribers]) subscriber(this.state);
    });
    // The server does not know which project this socket wants after a
    // reconnect — the field lives on the connection — so it is re-sent.
    transport.onOpen(() => {
      if (this.asked) transport.send('git', { project: this.asked });
    });
  }

  subscribe(subscriber: Subscriber): () => void {
    this.start();
    this.subscribers.add(subscriber);
    subscriber(this.state);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Ask for a project's status. Idempotent; re-asking the same project is free. */
  watch(project: string) {
    this.start();
    if (!project || this.asked === project) return;
    this.asked = project;
    // Drop the previous project's marks immediately. Carrying them until the
    // reply arrives would decorate the NEW project's tree with the OLD
    // project's changes, which is worse than a moment with no decoration.
    this.state = { ...NO_GIT, project };
    for (const subscriber of [...this.subscribers]) subscriber(this.state);
    sharedTransport().send('git', { project });
  }
}

let client: GitClient | null = null;

export function gitClient(): GitClient {
  if (!client) client = new GitClient();
  return client;
}

/** The more severe of two marks. Null-tolerant, so it folds over children. */
export function worseMark(a: GitMark | null, b: GitMark | null): GitMark | null {
  if (!a) return b;
  if (!b) return a;
  return GIT_MARKS.indexOf(a) <= GIT_MARKS.indexOf(b) ? a : b;
}

/**
 * Marks placed on nodes that actually exist, with the rest rolled up.
 *
 * `nodePaths` is every path the tree can render. A mark whose resource is still
 * there lands on it; a mark for something deleted walks up its own path until it
 * finds a node that exists, and the worst mark wins at each stop. Folders always
 * take the worst of everything below them, so a collapsed package still shows
 * that something inside it changed.
 */
export function decorate(
  marks: Record<string, GitMark>,
  nodePaths: Iterable<string>
): Map<string, GitMark> {
  const nodes = nodePaths instanceof Set ? nodePaths : new Set(nodePaths);
  const out = new Map<string, GitMark>();

  const place = (path: string, mark: GitMark) => {
    out.set(path, worseMark(out.get(path) ?? null, mark) as GitMark);
  };

  for (const [path, mark] of Object.entries(marks)) {
    let anchor: string | null = null;
    if (nodes.has(path)) {
      anchor = path;
    } else {
      // Deleted: walk up to the nearest ancestor the tree still holds.
      let candidate = path;
      while (candidate.includes('/')) {
        candidate = candidate.slice(0, candidate.lastIndexOf('/'));
        if (nodes.has(candidate)) {
          anchor = candidate;
          break;
        }
      }
    }
    if (!anchor) continue;
    place(anchor, mark);
    // And every ancestor of wherever it landed, so a collapsed folder is honest
    // about its contents.
    let parent = anchor;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      if (nodes.has(parent)) place(parent, mark);
    }
  }
  return out;
}

/** The single letter shown on a node. */
export function markLetter(mark: GitMark): string {
  return { conflicted: '!', deleted: 'D', modified: 'M', added: 'A' }[mark];
}

/** What a mark means, for the node's tooltip. */
export function markTitle(mark: GitMark): string {
  return {
    conflicted: 'Conflicted — both sides changed this',
    deleted: 'Deleted since the last commit',
    modified: 'Changed since the last commit',
    added: 'New since the last commit',
  }[mark];
}

/**
 * The one-line summary above the tree.
 *
 * Returns null when there is nothing honest to say — no repository, or a clean
 * tree with a commit behind it — because a permanent "0 changes" line is chrome
 * that teaches people to stop reading the area it sits in.
 */
export function summarise(state: GitState): string | null {
  if (!state.repo) return null;
  if (state.error) return `Cannot read git: ${state.error}`;
  if (state.head === null) return `${state.branch ?? 'git'} — no commit yet`;
  const changed = Object.keys(state.marks).length;
  const branch = state.branch ?? state.head;
  if (changed === 0 && state.others === 0) return null;
  const parts: string[] = [];
  if (changed > 0) parts.push(`${changed} changed`);
  // Named separately because they cannot be shown in the tree, and a count that
  // silently omitted them would disagree with `git status` for no visible reason.
  if (state.others > 0) parts.push(`${state.others} outside the tree`);
  return `${branch} — ${parts.join(', ')}`;
}
