/**
 * Which language a document is written in.
 *
 * Until 1.9.0 this module had exactly two answers and neither was asked for:
 * a named query was SQL and everything else was Python. That held while every
 * editable file was a `.py`, and stopped holding the moment Web Dev's real
 * shapes went in — `cell3d` is 65 KB of HTML and `lib` ships `three.min.js`.
 * Both would have opened as Python: no useful highlighting, bracket matching
 * against the wrong pairs, and the Jython language server asked to parse HTML.
 *
 * The MIME type wins over the extension where there is one, because a text
 * resource HAS a declared content type and it is the thing the gateway actually
 * serves the file as. The extension is the answer for a data key, which has no
 * declared type at all.
 */

export type DocLanguage = 'python' | 'sql' | 'html' | 'javascript' | 'css' | 'json' | 'text';

/** MIME type → language, for the types a Web Dev text resource declares. */
const BY_CONTENT_TYPE: Record<string, DocLanguage> = {
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/xml': 'html',
  'application/xml': 'html',
  'image/svg+xml': 'html',
  'text/javascript': 'javascript',
  'application/javascript': 'javascript',
  'application/x-javascript': 'javascript',
  'text/css': 'css',
  'application/json': 'json',
  'text/json': 'json',
  'text/x-python': 'python',
};

/** File extension → language, for a data key. */
const BY_EXTENSION: Record<string, DocLanguage> = {
  py: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'javascript', tsx: 'javascript', jsx: 'javascript',
  json: 'json', map: 'json',
  css: 'css', scss: 'css', less: 'css',
  html: 'html', htm: 'html', xml: 'html', svg: 'html',
  sql: 'sql',
};

/**
 * Normalise a content type: drop the parameters and the case.
 *
 * `text/html; charset=utf-8` is one of the two spellings a real resource
 * carries, and matching the raw string finds neither reliably.
 */
export function baseContentType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * The language for a document.
 *
 * A `.py` data key is Python and nothing else gets a say — every script
 * resource type in this IDE stores its body under one, and a stray
 * `content-type` must not be able to turn a Project Library script into HTML.
 *
 * Everything else falls back to `'text'`, NOT to Python. A file this build has
 * never seen is better shown unhighlighted than shown with another language's
 * grammar confidently mis-parsing it, and `'text'` is also what gates the
 * Jython language server off.
 */
export function languageFor(params: {
  dataKey?: string;
  contentType?: string;
}): DocLanguage {
  const key = params.dataKey ?? '';
  if (key.toLowerCase().endsWith('.py')) return 'python';

  const mime = BY_CONTENT_TYPE[baseContentType(params.contentType)];
  if (mime) return mime;

  const dot = key.lastIndexOf('.');
  if (dot >= 0 && dot < key.length - 1) {
    const ext = BY_EXTENSION[key.slice(dot + 1).toLowerCase()];
    if (ext) return ext;
  }
  return 'text';
}
