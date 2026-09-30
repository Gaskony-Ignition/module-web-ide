/**
 * Unsaved buffers, kept so a closed tab is not lost work.
 *
 * This module writes into a running gateway and holds everything else in a
 * browser tab. A crash, an accidental Ctrl+W, a laptop that slept and came back
 * to a reloaded page — all of them threw away whatever had not been saved, with
 * no trace anywhere. `SaveHistory` cannot help: it only ever sees text that was
 * successfully written, which is precisely the text that was not at risk.
 *
 * ## Why `localStorage`, and what that costs
 *
 * A draft is per-viewer, per-browser and never shared — the same properties the
 * layout store already relies on. It survives the browser being closed, which
 * `sessionStorage` does not, and that is the whole point: the case this exists
 * for is the session that ended without asking.
 *
 * It also means a draft is invisible to the gateway and to every other machine.
 * That is the honest boundary, and the recovery notice says so rather than
 * implying the work was ever anywhere but here.
 *
 * Every read and write is wrapped. `localStorage` THROWS outright in a private
 * window, under a thumbnail capture, and in a browser set to block site data;
 * losing the page because a draft could not be written would be a worse failure
 * than the one this prevents.
 *
 * ## What is kept, and what is deliberately not
 *
 * A draft carries the buffer AND the `baseText` it diverged from, so recovery
 * can tell two very different situations apart: the gateway's copy is still what
 * you started from, or somebody has changed it underneath you. Without
 * `baseText` the second case is indistinguishable from the first, and restoring
 * blindly is how you overwrite a colleague's fix with an hour-old buffer.
 *
 * A CLEAN buffer is never kept. It is already on the gateway, byte for byte, and
 * a store full of unmodified copies would push the genuinely unsaved ones out
 * against the quota.
 */

const PREFIX = 'scriptide.draft.';

/**
 * Total bytes of drafts to keep.
 *
 * `localStorage` is around 5 MB per origin and is shared with everything else
 * this app remembers. Oldest drafts are dropped first when the budget is
 * exceeded — the newest edit is the one somebody is still thinking about.
 */
export const MAX_TOTAL_CHARS = 2_000_000;

/** A single buffer above this is not kept; see {@link MAX_TOTAL_CHARS}. */
export const MAX_DRAFT_CHARS = 512_000;

export interface Draft {
  /** The document's uri — project, path and data key, as `docUri` builds it. */
  uri: string;
  project: string;
  path: string;
  scriptKey: string;
  /** The tab's label, so the recovery notice can name it without a round trip. */
  label: string;
  /** The unsaved text. */
  text: string;
  /** What the gateway had agreed to when this diverged. */
  baseText: string;
  /** That agreement's signature, to detect the gateway moving on. */
  etag: string;
  /** When this draft was written, epoch millis. */
  at: number;
}

function keyFor(uri: string): string {
  return PREFIX + uri;
}

/** Every draft currently held, newest first. */
export function allDrafts(): Draft[] {
  const out: Draft[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      try {
        const draft = JSON.parse(raw) as Draft;
        // Written by a build that may no longer exist: check the shape rather
        // than trusting it, or a renamed field reaches the editor as undefined
        // and the tab opens empty.
        if (typeof draft?.uri === 'string' && typeof draft?.text === 'string') {
          out.push(draft);
        }
      } catch {
        /* not ours, or half-written — skip it rather than fail the whole read */
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}

/** Forget one draft — it was saved, restored, or explicitly discarded. */
export function dropDraft(uri: string): void {
  try {
    window.localStorage.removeItem(keyFor(uri));
  } catch {
    /* nothing kept; nothing to remove */
  }
}

/**
 * Record one unsaved buffer.
 *
 * A no-op for a buffer that matches the gateway: see the note above about not
 * spending the quota on text that is not at risk.
 */
export function putDraft(draft: Draft): void {
  if (draft.text === draft.baseText) {
    dropDraft(draft.uri);
    return;
  }
  if (draft.text.length > MAX_DRAFT_CHARS) {
    // Too big to keep. Dropping any previous draft matters: a stale, smaller
    // one left behind would be offered later as though it were current.
    dropDraft(draft.uri);
    return;
  }
  try {
    window.localStorage.setItem(keyFor(draft.uri), JSON.stringify(draft));
  } catch {
    // Quota, most likely. Make room and try once more; a draft that silently
    // failed to save is the exact failure this feature exists to prevent.
    prune(draft.uri);
    try {
      window.localStorage.setItem(keyFor(draft.uri), JSON.stringify(draft));
    } catch {
      /* still no room; the buffer is still on screen and still saveable */
    }
  }
}

/**
 * Drop oldest drafts until the store is under budget.
 *
 * `keep` is never dropped — it is the draft being written right now, and
 * evicting it to make room for itself would be a loop that always fails.
 */
export function prune(keep?: string): void {
  const drafts = allDrafts();
  let total = drafts.reduce((sum, draft) => sum + draft.text.length, 0);
  // Oldest first: allDrafts is newest-first, so walk it backwards.
  for (let i = drafts.length - 1; i >= 0 && total > MAX_TOTAL_CHARS; i -= 1) {
    const draft = drafts[i];
    if (draft.uri === keep) continue;
    dropDraft(draft.uri);
    total -= draft.text.length;
  }
}

/**
 * How a recovered draft relates to what the gateway holds now.
 *
 * `moved` is the case that has to be visible: somebody saved that resource
 * while this draft was sitting in a closed browser, so restoring gives you a
 * buffer built on a version that no longer exists. It is still worth offering —
 * it is the user's own work — but it must not be presented as though nothing
 * had changed.
 */
export type DraftState = 'current' | 'moved' | 'identical';

export function draftState(draft: Draft, serverEtag: string, serverText: string): DraftState {
  if (draft.text === serverText) return 'identical';
  return draft.etag === serverEtag ? 'current' : 'moved';
}
