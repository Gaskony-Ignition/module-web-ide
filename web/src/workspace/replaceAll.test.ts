import { describe, expect, it, vi } from 'vitest';
import {
  replaceOccurrences,
  runReplaceAll,
  summarise,
  type ReplaceTarget,
} from './replaceAll';

function target(overrides: Partial<ReplaceTarget> = {}): ReplaceTarget {
  return {
    uri: 'ignition://P/ignition/script-python/util/helpers',
    project: 'P',
    path: 'ignition/script-python/util/helpers',
    key: 'code.py',
    label: 'util.helpers',
    ...overrides,
  };
}

describe('replaceOccurrences', () => {
  it('replaces every occurrence and counts them', () => {
    expect(replaceOccurrences('a b a b a', 'a', 'X', true))
      .toEqual({ text: 'X b X b X', count: 3 });
  });

  it('leaves text alone when the term is absent', () => {
    expect(replaceOccurrences('hello', 'zzz', 'X', true))
      .toEqual({ text: 'hello', count: 0 });
  });

  it('an empty term replaces nothing — it would otherwise match everywhere', () => {
    expect(replaceOccurrences('hello', '', 'X', true))
      .toEqual({ text: 'hello', count: 0 });
  });

  it('is case sensitive when asked', () => {
    expect(replaceOccurrences('Tag tag TAG', 'tag', 'x', true).count).toBe(1);
  });

  it('matches any case when not, and keeps the case of everything AROUND the match', () => {
    // The bug this guards: lower-casing the document to find matches, then
    // writing the lower-cased document back, silently renames every identifier.
    const result = replaceOccurrences('SystemTag = readTAG(Tag)', 'tag', 'x', false);
    expect(result.count).toBe(3);
    expect(result.text).toBe('Systemx = readx(x)');
  });

  it('an empty replacement deletes', () => {
    expect(replaceOccurrences('a-b-a', 'a', '', true))
      .toEqual({ text: '-b-', count: 2 });
  });

  it('does not rescan its own replacement', () => {
    // 'aa' -> 'a' over 'aaaa' is two replacements, not three.
    expect(replaceOccurrences('aaaa', 'aa', 'a', true))
      .toEqual({ text: 'aa', count: 2 });
  });
});

describe('runReplaceAll', () => {
  const io = (text: string) => ({
    read: vi.fn(async () => ({ text, etag: 'sig-1' })),
    write: vi.fn(async () => ({ ok: true as const, signature: 'sig-2' })),
  });

  it('reads, replaces and writes each target with the etag from its own read', async () => {
    const fns = io('x = old\ny = old\n');
    const report = await runReplaceAll([target()], 'old', 'new', true, fns);
    expect(report.filesChanged).toBe(1);
    expect(report.occurrences).toBe(2);
    expect(report.wrote).toBe(true);
    expect(fns.write).toHaveBeenCalledWith(expect.anything(), 'x = new\ny = new\n', 'sig-1');
  });

  it('skips an inherited script without reading it', async () => {
    const fns = io('old');
    const report = await runReplaceAll([target({ skip: 'read-only' })], 'old', 'new', true, fns);
    expect(fns.read).not.toHaveBeenCalled();
    expect(fns.write).not.toHaveBeenCalled();
    expect(report.outcomes[0]).toMatchObject({ status: 'skipped' });
    expect(report.outcomes[0].reason).toContain('inherited');
  });

  it('skips a file with unsaved changes — the write would be silently undone', async () => {
    const fns = io('old');
    const report = await runReplaceAll(
      [target({ skip: 'unsaved-changes' })], 'old', 'new', true, fns);
    expect(fns.write).not.toHaveBeenCalled();
    expect(report.outcomes[0].reason).toContain('unsaved changes');
  });

  it('writes nothing for a file that no longer contains the term', async () => {
    const fns = io('nothing here');
    const report = await runReplaceAll([target()], 'old', 'new', true, fns);
    expect(fns.write).not.toHaveBeenCalled();
    expect(report.outcomes[0].status).toBe('unchanged');
    expect(report.wrote).toBe(false);
  });

  it('one failure does not stop the rest, and is named in the report', async () => {
    const read = vi.fn(async () => ({ text: 'old', etag: 'sig-1' }));
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('changed on the gateway'))
      .mockResolvedValueOnce({ ok: true as const, signature: 'sig-2' });
    const report = await runReplaceAll(
      [target({ uri: 'a', label: 'one' }), target({ uri: 'b', label: 'two' })],
      'old', 'new', true, { read, write }
    );
    expect(report.outcomes.map((o) => o.status)).toEqual(['failed', 'changed']);
    expect(report.outcomes[0].reason).toContain('changed on the gateway');
    expect(report.filesChanged).toBe(1);
  });

  it('runs one file at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { text: 'old', etag: 's' };
    });
    await runReplaceAll(
      [target({ uri: 'a' }), target({ uri: 'b' }), target({ uri: 'c' })],
      'old', 'new', true,
      { read, write: vi.fn(async () => ({ ok: true as const, signature: 's2' })) }
    );
    expect(peak).toBe(1);
  });
});

describe('summarise', () => {
  it('says nothing was changed when nothing was', () => {
    expect(summarise({ outcomes: [], filesChanged: 0, occurrences: 0, wrote: false }))
      .toBe('Nothing was changed.');
  });

  it('counts files, occurrences, skips and failures', () => {
    const text = summarise({
      outcomes: [
        { uri: 'a', label: 'a', status: 'changed', count: 2 },
        { uri: 'b', label: 'b', status: 'skipped', count: 0, reason: 'inherited' },
        { uri: 'c', label: 'c', status: 'failed', count: 0, reason: 'boom' },
      ],
      filesChanged: 1,
      occurrences: 2,
      wrote: true,
    });
    expect(text).toContain('2 occurrences');
    expect(text).toContain('1 file.');
    expect(text).toContain('1 skipped.');
    expect(text).toContain('1 failed.');
  });
});
