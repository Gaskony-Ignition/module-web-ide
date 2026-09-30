import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allDrafts,
  draftState,
  dropDraft,
  MAX_DRAFT_CHARS,
  MAX_TOTAL_CHARS,
  prune,
  putDraft,
  type Draft,
} from './drafts';

function draft(over: Partial<Draft> = {}): Draft {
  return {
    uri: 'P|ignition/script-python/util|code.py',
    project: 'P',
    path: 'ignition/script-python/util',
    scriptKey: 'code.py',
    label: 'util',
    text: 'x = 2',
    baseText: 'x = 1',
    etag: 'sig-1',
    at: 1000,
    ...over,
  };
}

describe('drafts', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('keeps an unsaved buffer and reads it back', () => {
    putDraft(draft());
    expect(allDrafts()).toHaveLength(1);
    expect(allDrafts()[0].text).toBe('x = 2');
  });

  it('never keeps a buffer that matches the gateway', () => {
    // It is already on the gateway byte for byte. A store full of unmodified
    // copies pushes the genuinely unsaved ones out against the quota.
    putDraft(draft({ text: 'x = 1', baseText: 'x = 1' }));
    expect(allDrafts()).toHaveLength(0);
  });

  it('drops a previous draft when the buffer becomes clean again', () => {
    // Undoing back to the saved text must remove the draft, or a stale one is
    // offered later as though it were current work.
    putDraft(draft());
    putDraft(draft({ text: 'x = 1' }));
    expect(allDrafts()).toHaveLength(0);
  });

  it('refuses a single buffer that is too large, and drops any older one', () => {
    putDraft(draft());
    putDraft(draft({ text: 'y'.repeat(MAX_DRAFT_CHARS + 1) }));
    expect(allDrafts()).toHaveLength(0);
  });

  it('returns drafts newest first', () => {
    putDraft(draft({ uri: 'a', at: 1 }));
    putDraft(draft({ uri: 'b', at: 9 }));
    expect(allDrafts().map((d) => d.uri)).toEqual(['b', 'a']);
  });

  it('survives a storage that throws outright', () => {
    // localStorage THROWS in a private window and under a thumbnail capture.
    // Losing the page over a draft would be worse than losing the draft.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => putDraft(draft())).not.toThrow();
    spy.mockRestore();
    const read = vi.spyOn(Storage.prototype, 'length', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(allDrafts()).toEqual([]);
    read.mockRestore();
  });

  it('ignores a stored value written by a build that no longer exists', () => {
    // A renamed field must read as "no draft", not reach the editor as
    // undefined and open the tab empty.
    window.localStorage.setItem('scriptide.draft.x', JSON.stringify({ uri: 'x' }));
    window.localStorage.setItem('scriptide.draft.y', 'not json at all');
    expect(allDrafts()).toEqual([]);
  });

  it('leaves other keys in the same storage alone', () => {
    window.localStorage.setItem('scriptide.choice.console.orientation', 'columns');
    putDraft(draft());
    expect(allDrafts()).toHaveLength(1);
    expect(window.localStorage.getItem('scriptide.choice.console.orientation'))
      .toBe('columns');
  });

  it('prunes oldest first and never evicts the draft being written', () => {
    const big = 'z'.repeat(MAX_DRAFT_CHARS);
    for (let i = 0; i < Math.ceil(MAX_TOTAL_CHARS / MAX_DRAFT_CHARS) + 2; i += 1) {
      putDraft(draft({ uri: `u${i}`, at: i, text: big }));
    }
    prune('u0');
    const kept = allDrafts().map((d) => d.uri);
    expect(kept).toContain('u0');
    expect(kept.length * MAX_DRAFT_CHARS).toBeLessThanOrEqual(
      MAX_TOTAL_CHARS + MAX_DRAFT_CHARS
    );
  });

  it('forgets a draft on request', () => {
    putDraft(draft());
    dropDraft(draft().uri);
    expect(allDrafts()).toHaveLength(0);
  });
});

describe('draftState', () => {
  it('is current when the gateway still holds what the draft diverged from', () => {
    expect(draftState(draft(), 'sig-1', 'x = 1')).toBe('current');
  });

  it('is moved when somebody saved that resource in the meantime', () => {
    // The case that must be visible: restoring gives a buffer built on a
    // version that no longer exists, and presenting it as ordinary is how a
    // colleague's fix gets overwritten by an hour-old buffer.
    expect(draftState(draft(), 'sig-2', 'x = 99')).toBe('moved');
  });

  it('is identical when the gateway already has exactly this text', () => {
    // Somebody saved the same change from elsewhere. Offering to "recover" it
    // would be offering work that is not missing.
    expect(draftState(draft(), 'sig-2', 'x = 2')).toBe('identical');
  });
});
