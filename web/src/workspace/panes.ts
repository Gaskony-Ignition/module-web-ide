/**
 * Which editor pane each document is in, and which one each pane is showing.
 *
 * Nigel, 03/09/2026: *"I'm not seeing a way to split the screen between 2 or
 * more scripts so that I can do comparisons or copy and paste between."*
 *
 * The rules live here, as pure functions over a small state, because they are
 * the part of the split that is easy to get subtly wrong and impossible to see
 * going wrong: a pane showing a tab strip and no buffer, or a document that
 * appears in both panes at once, or a second pane left open with nothing in it.
 *
 * Three decisions this encodes, all deliberate:
 *
 * 1. **A document is in exactly ONE pane, and splitting MOVES it.** `CodeEditor`
 *    keeps one `EditorView` per document — so scroll position and undo history
 *    survive a tab switch — and two views over one buffer would need
 *    synchronising on every keystroke. That is an editing model, not a layout.
 * 2. **`activeUri` keeps its old meaning**: the document you are working in, and
 *    the one the outline, Problems, the config strip and "Run file" describe.
 *    Which PANE that is falls out of the split set, so the two cannot disagree.
 *    `otherActive` is only the tab the unfocused pane is parked on.
 * 3. **There is no "is split" flag.** An empty set is one pane. A flag and the
 *    set behind it drift apart, and the state where they disagree is a second
 *    pane with no documents in it.
 */

export interface PaneState {
  /** The focused document — the one every other panel describes. */
  activeUri: string | null;
  /** What the OTHER pane is parked on. Validated on read, never trusted. */
  otherActive: string | null;
  /** Documents in the second pane. Empty means one pane. */
  split: ReadonlySet<string>;
}

/** True when the focused document is in the second pane. */
export function focusIsRight(state: PaneState): boolean {
  return state.activeUri != null && state.split.has(state.activeUri);
}

/**
 * The tab each pane should show.
 *
 * `otherActive` is checked against the pane it would appear in rather than
 * trusted: a document leaves a pane by being closed OR by being moved across,
 * and a stale uri renders a pane with a tab strip and an empty buffer. Falling
 * back to the pane's first document is what every editor does when the tab you
 * were on goes away.
 */
export function paneActives(
  state: PaneState,
  leftUris: readonly string[],
  rightUris: readonly string[]
): { left: string | null; right: string | null } {
  const right = focusIsRight(state);
  const pick = (uris: readonly string[], preferred: string | null) =>
    (preferred && uris.includes(preferred) ? preferred : uris[0] ?? null);
  return {
    left: pick(leftUris, right ? state.otherActive : state.activeUri),
    right: pick(rightUris, right ? state.activeUri : state.otherActive),
  };
}

/**
 * Select a tab, in either pane.
 *
 * Crossing between panes moves the focus AND parks the document you left, so
 * the pane you came from keeps showing what it was showing. Selecting within a
 * pane leaves the other one entirely alone — which is the whole point of having
 * two.
 */
export function selectInPanes(state: PaneState, uri: string): PaneState {
  const previous = state.activeUri;
  if (previous === uri) return state;
  const crossing = previous != null && state.split.has(uri) !== state.split.has(previous);
  return {
    ...state,
    activeUri: uri,
    otherActive: crossing ? previous : state.otherActive,
  };
}

/**
 * Move a document to the other pane — the split gesture, both ways.
 *
 * The moved document keeps the focus, so the gesture reads as "put this over
 * there and carry on in it", and the pane it LEFT is given its next document to
 * show. When that pane had nothing else, the split collapses: half the width
 * spent on an empty pane is worse than no split at all.
 *
 * @param order every open document's uri, in tab order — the source pane's next
 *     document is chosen from it, so the pane lands on a neighbour rather than
 *     on whatever the set happened to iterate first.
 */
export function moveAcross(state: PaneState, uri: string, order: readonly string[]): PaneState {
  const wasRight = state.split.has(uri);
  const split = new Set(state.split);
  if (wasRight) split.delete(uri);
  else split.add(uri);

  // What is left where it came from, in tab order.
  const source = order.filter((u) => u !== uri && state.split.has(u) === wasRight);
  return { activeUri: uri, otherActive: source[0] ?? null, split };
}

/**
 * Forget a document that has been closed.
 *
 * The pane assignment must go with it. Left behind, the set grows without bound
 * and — worse — reopening the same script later would silently put it in the
 * second pane, because a document's uri is its identity and the old entry still
 * matches.
 */
export function forgetInPanes(state: PaneState, uri: string): PaneState {
  if (!state.split.has(uri) && state.otherActive !== uri) return state;
  const split = new Set(state.split);
  split.delete(uri);
  return {
    ...state,
    split,
    otherActive: state.otherActive === uri ? null : state.otherActive,
  };
}
