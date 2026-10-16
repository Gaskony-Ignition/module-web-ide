import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportTags, fetchTagEdit, moveTags, parseTagInput, qualityCode, renameTag, saveTagConfig, tagPath,
} from './tags';
import { ApiError } from './scripts';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('parseTagInput', () => {
  it('reads booleans, accepting 1/0', () => {
    expect(parseTagInput('true', 'Boolean')).toBe(true);
    expect(parseTagInput('0', 'Boolean')).toBe(false);
    expect(parseTagInput('yes', 'Boolean')).toBeUndefined();
  });

  it('refuses text for a numeric tag instead of sending a string', () => {
    expect(parseTagInput('42', 'Int4')).toBe(42);
    expect(parseTagInput('4.5', 'Float8')).toBe(4.5);
    expect(parseTagInput('abc', 'Int4')).toBeUndefined();
    expect(parseTagInput('', 'Float4')).toBeUndefined();
  });

  it('passes a string tag through untouched, spaces included', () => {
    expect(parseTagInput(' hello ', 'String')).toBe(' hello ');
  });
});

describe('tagPath', () => {
  it('brackets the provider', () => {
    expect(tagPath('default', 'A/B')).toBe('[default]A/B');
  });
});

describe('qualityCode', () => {
  it('drops the diagnostic text so a bad quality fits on its row', () => {
    expect(qualityCode('Bad_NodeIdUnknown("CreateMonitoredItems failed")')).toBe('Bad_NodeIdUnknown');
    expect(qualityCode('Good')).toBe('Good');
  });
});

describe('tag editing clients', () => {
  it('reads a tag for editing by its full path', async () => {
    const fetchMock = stubFetch(200, { local: '{}', resolved: '{}', signature: 's1', tagType: 'AtomicTag' });
    const info = await fetchTagEdit('[default]A/B');
    expect(info.signature).toBe('s1');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/tags/edit?path=%5Bdefault%5DA%2FB');
  });

  it('saves with the signature and the CSRF header', async () => {
    const fetchMock = stubFetch(200, { ok: true, results: ['Good'], signature: 's2' });
    const result = await saveTagConfig('[default]T', '{"name":"T"}', 's1', 'tok');
    expect(result.signature).toBe('s2');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ path: '[default]T', json: '{"name":"T"}', signature: 's1' });
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('tok');
  });

  it('turns a stale-signature save into a conflict', async () => {
    stubFetch(409, { error: 'changed', signature: 's9' });
    const error = await saveTagConfig('[default]T', '{}', 's1', 'tok').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isConflict).toBe(true);
  });

  it('sends rename and move bodies in the contract shape', async () => {
    const fetchMock = stubFetch(200, { ok: true, results: ['Good'] });
    await renameTag('[default]A', 'B', 't');
    await moveTags(['[default]A'], '[default]F', true, 'Rename', 't');
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[0]).toEqual({ path: '[default]A', newName: 'B' });
    expect(bodies[1]).toEqual({ paths: ['[default]A'], destination: '[default]F', copy: true, collision: 'Rename' });
  });

  it('exports several paths as repeated query parameters', async () => {
    const fetchMock = stubFetch(200, { json: '{"tags":[]}' });
    expect(await exportTags(['[default]A', '[default]B'])).toBe('{"tags":[]}');
    expect(String(fetchMock.mock.calls[0][0]))
      .toContain('/api/tags/export?path=%5Bdefault%5DA&path=%5Bdefault%5DB');
  });
});
