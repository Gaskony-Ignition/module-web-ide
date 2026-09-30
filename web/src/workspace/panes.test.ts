import { describe, expect, it } from 'vitest';
import {
  focusIsRight, forgetInPanes, moveAcross, paneActives, selectInPanes,
  type PaneState,
} from './panes';

const ONE_PANE: PaneState = { activeUri: 'a', otherActive: null, split: new Set() };
/** a and b on the left, c on the right, focused on a. */
const SPLIT: PaneState = { activeUri: 'a', otherActive: 'c', split: new Set(['c']) };

describe('which pane has the focus', () => {
  it('is the left one until a document is moved across', () => {
    expect(focusIsRight(ONE_PANE)).toBe(false);
    expect(focusIsRight(SPLIT)).toBe(false);
    expect(focusIsRight({ ...SPLIT, activeUri: 'c' })).toBe(true);
  });
});

describe('what each pane shows', () => {
  it('gives the focused document to its own pane and the parked one to the other', () => {
    expect(paneActives(SPLIT, ['a', 'b'], ['c'])).toEqual({ left: 'a', right: 'c' });
    expect(paneActives({ ...SPLIT, activeUri: 'c', otherActive: 'b' }, ['a', 'b'], ['c']))
      .toEqual({ left: 'b', right: 'c' });
  });

  it('falls back when the parked document is no longer in that pane', () => {
    // The failure this prevents: a pane rendering a tab strip and an empty
    // buffer, because it was parked on a document that has since been closed
    // or moved across.
    expect(paneActives({ ...SPLIT, otherActive: 'gone' }, ['a', 'b'], ['c']).right).toBe('c');
    expect(paneActives({ activeUri: null, otherActive: null, split: new Set(['c']) },
      ['a'], ['c'])).toEqual({ left: 'a', right: 'c' });
  });

  it('gives an empty pane nothing rather than someone else’s document', () => {
    expect(paneActives(ONE_PANE, ['a'], [])).toEqual({ left: 'a', right: null });
  });
});

describe('selecting a tab', () => {
  it('parks the document you left when you CROSS panes', () => {
    const next = selectInPanes(SPLIT, 'c');
    expect(next.activeUri).toBe('c');
    expect(next.otherActive).toBe('a');
  });

  it('leaves the other pane alone when you do NOT cross', () => {
    // The pairing is the point: a rule that always parked would make the other
    // pane follow every tab click in this one, which is the opposite of what a
    // split is for.
    const next = selectInPanes(SPLIT, 'b');
    expect(next.activeUri).toBe('b');
    expect(next.otherActive).toBe('c');
  });

  it('is a no-op on the document already focused', () => {
    expect(selectInPanes(SPLIT, 'a')).toBe(SPLIT);
  });
});

describe('moving a document across', () => {
  it('splits, keeps the focus on what moved, and parks the pane it left', () => {
    const next = moveAcross(ONE_PANE, 'a', ['a', 'b']);
    expect([...next.split]).toEqual(['a']);
    expect(next.activeUri).toBe('a');
    expect(next.otherActive).toBe('b');
    expect(paneActives(next, ['b'], ['a'])).toEqual({ left: 'b', right: 'a' });
  });

  it('moves BACK, which is the same gesture', () => {
    const next = moveAcross(SPLIT, 'c', ['a', 'b', 'c']);
    expect([...next.split]).toEqual([]);
    expect(next.activeUri).toBe('c');
  });

  it('collapses the split when the last document leaves the second pane', () => {
    // Half the width spent on an empty pane is worse than no split at all.
    const next = moveAcross(SPLIT, 'c', ['a', 'b', 'c']);
    expect(next.split.size).toBe(0);
    expect(paneActives(next, ['a', 'b', 'c'], []).right).toBeNull();
  });

  it('parks the source pane on a NEIGHBOUR, in tab order', () => {
    const three: PaneState = { activeUri: 'b', otherActive: null, split: new Set() };
    expect(moveAcross(three, 'b', ['a', 'b', 'c']).otherActive).toBe('a');
  });

  it('leaves the source pane empty-handed when it had only the one', () => {
    expect(moveAcross(ONE_PANE, 'a', ['a']).otherActive).toBeNull();
  });
});

describe('closing a document', () => {
  it('releases its pane assignment', () => {
    // Left behind, the set grows without bound — and reopening the same script
    // later would silently put it back in the second pane, because a uri is a
    // document's identity and the stale entry still matches.
    const next = forgetInPanes({ ...SPLIT, activeUri: 'c' }, 'c');
    expect(next.split.has('c')).toBe(false);
  });

  it('clears the parked tab when that is what was closed', () => {
    expect(forgetInPanes(SPLIT, 'c').otherActive).toBeNull();
  });

  it('is a no-op for a document neither pane was holding', () => {
    expect(forgetInPanes(SPLIT, 'b')).toBe(SPLIT);
  });
});

describe('the invariant', () => {
  it('never puts one document in both panes', () => {
    let state: PaneState = { activeUri: 'a', otherActive: null, split: new Set() };
    const order = ['a', 'b', 'c'];
    for (const uri of ['a', 'b', 'a', 'c', 'b']) {
      state = moveAcross(state, uri, order);
      const left = order.filter((u) => !state.split.has(u));
      const right = order.filter((u) => state.split.has(u));
      expect(left.filter((u) => right.includes(u))).toEqual([]);
      const { left: la, right: ra } = paneActives(state, left, right);
      // Whatever the sequence, each pane shows one of its OWN documents.
      if (la) expect(left).toContain(la);
      if (ra) expect(right).toContain(ra);
    }
  });
});
