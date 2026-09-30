import { describe, expect, it } from 'vitest';
import { baseContentType, languageFor } from './docLanguage';

describe('baseContentType', () => {
  it('drops the parameters and the case', () => {
    // Both spellings appear on real resources; matching the raw string finds
    // neither reliably.
    expect(baseContentType('text/HTML; charset=utf-8')).toBe('text/html');
    expect(baseContentType('text/html')).toBe('text/html');
    expect(baseContentType(undefined)).toBe('');
  });
});

describe('languageFor', () => {
  it('calls a .py key Python whatever the content type claims', () => {
    // The rule that matters most: a stray content-type must never be able to
    // turn a Project Library script into HTML and switch its language server off.
    expect(languageFor({ dataKey: 'code.py' })).toBe('python');
    expect(languageFor({ dataKey: 'doGet.py', contentType: 'text/html' })).toBe('python');
  });

  it('reads a text resource from its declared MIME type', () => {
    // cell3d, measured on the rig: the body has no filename at all, so the
    // content type is the only thing that says what it is.
    expect(languageFor({ dataKey: 'config.json#text', contentType: 'text/html' }))
      .toBe('html');
    expect(languageFor({ dataKey: 'config.json#text', contentType: 'text/css' }))
      .toBe('css');
    expect(languageFor({ dataKey: 'config.json#text', contentType: 'application/json' }))
      .toBe('json');
  });

  it('reads a static asset from its extension', () => {
    // lib/three.min.js — a data key, which carries no declared type.
    expect(languageFor({ dataKey: 'three.min.js' })).toBe('javascript');
    expect(languageFor({ dataKey: 'site.css' })).toBe('css');
    expect(languageFor({ dataKey: 'index.html' })).toBe('html');
  });

  it('falls back to plain text, NOT to Python', () => {
    // The failure this guards: an unrecognised file opened as Python gets the
    // wrong grammar AND the Jython language server, which then publishes an
    // error per line. No highlighting is the better wrong answer.
    expect(languageFor({ dataKey: 'notes.rst' })).toBe('text');
    expect(languageFor({ dataKey: 'config.json#text', contentType: 'font/woff2' }))
      .toBe('text');
    expect(languageFor({ dataKey: 'LICENCE' })).toBe('text');
  });

  it('is not vacuous — the three branches give three different answers', () => {
    // A predicate that returned one value would pass several checks above.
    const answers = new Set([
      languageFor({ dataKey: 'code.py' }),
      languageFor({ dataKey: 'config.json#text', contentType: 'text/html' }),
      languageFor({ dataKey: 'three.min.js' }),
      languageFor({ dataKey: 'LICENCE' }),
    ]);
    expect(answers).toEqual(new Set(['python', 'html', 'javascript', 'text']));
  });
});
