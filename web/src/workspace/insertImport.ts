/**
 * Insert one suggested import statement into a buffer, as a plain text edit.
 *
 * Deliberately simple, and deliberately NOT the same algorithm as the
 * gateway's `ImportOrganiser`: this runs on every click with no round trip, so
 * it looks only for where the leading import block visibly starts — the first
 * column-0 line that already reads `import`/`from`, skipping blank and `#`
 * comment lines ahead of it. Landing the new line at line 0 when no such block
 * exists (an empty file, or one that opens straight into code) is the same
 * "no leading block" case `ImportOrganiser` treats as untouched — there is
 * nothing to slot into, so the statement becomes the start of one. "Organise
 * imports" is one click away to sort and de-duplicate afterwards, which is why
 * this does not also try to do that.
 */
export function insertImportAtTopOfBlock(text: string, statement: string): string {
  const lines = text.split('\n');
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) {
      continue;
    }
    insertAt = line.startsWith('import ') || line.startsWith('from ') ? i : 0;
    break;
  }
  lines.splice(insertAt, 0, statement);
  return lines.join('\n');
}
