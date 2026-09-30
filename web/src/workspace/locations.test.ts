import { describe, expect, it } from 'vitest';
import { lspUri } from '../api/lspClient';
import type { ScriptEntry } from '../api/scripts';
import {
  entryForLocation,
  labelForLocation,
  parseLocationUri,
  pathForModule,
} from './locations';

/** A tree entry with only the fields the location join reads. */
function entry(partial: Partial<ScriptEntry>): ScriptEntry {
  return {
    path: 'ignition/script-python/util/helpers',
    typeId: 'script-python',
    name: 'helpers',
    signature: 'sig',
    dataKeys: ['code.py'],
    scriptKey: 'code.py',
    typeLabel: 'Project Library',
    singleton: false,
    origin: 'local',
    owner: 'P',
    ...partial,
  };
}

describe('parseLocationUri', () => {
  it('takes a plain script URI apart', () => {
    expect(parseLocationUri('ignition://P/ignition/script-python/util/helpers')).toEqual({
      project: 'P',
      path: 'ignition/script-python/util/helpers',
      scriptKey: undefined,
    });
  });

  it('round-trips whatever lspUri builds, data key and all', () => {
    // The two functions are inverses and nothing else enforces that: lspUri is
    // in the API layer and this is in the workspace, so a change to the URI
    // shape on one side would otherwise be found by a user clicking a search
    // result and getting the wrong file.
    const cases: Array<[string, string, string | undefined]> = [
      ['P', 'ignition/script-python/util/helpers', undefined],
      ['P', 'ignition/script-python/util/helpers', 'code.py'],
      ['Site_Redgum', 'com.inductiveautomation.webdev/resources/admin', 'doPost.py'],
      ['P', 'ignition/startup', 'startup.py'],
    ];
    for (const [project, path, key] of cases) {
      const parsed = parseLocationUri(lspUri(project, path, key));
      expect(parsed?.project).toBe(project);
      expect(parsed?.path).toBe(path);
    }
  });

  it('keeps a data key that lspUri actually encoded', () => {
    const uri = lspUri('P', 'com.inductiveautomation.webdev/resources/admin', 'doPost.py');
    expect(parseLocationUri(uri)?.scriptKey).toBe('doPost.py');
  });

  it('reports no key for code.py, which lspUri deliberately omits', () => {
    // Omitting it is what keeps every single-script resource's URI byte-identical
    // to the pre-1.4 shape. So "absent" means "this resource's default key", and
    // resolving it to code.py here would pick the wrong handler on a Web Dev
    // endpoint.
    const uri = lspUri('P', 'ignition/script-python/util/helpers', 'code.py');
    expect(parseLocationUri(uri)?.scriptKey).toBeUndefined();
  });

  it('does not percent-encode a path a URL parser would mangle', () => {
    // `!Library` is a real, conventional folder name — shared libraries are named
    // that way so they sort first — and a round trip through `new URL()` would
    // not return the path the REST layer is keyed on.
    const parsed = parseLocationUri('ignition://P/ignition/script-python/!Library/util');
    expect(parsed?.path).toBe('ignition/script-python/!Library/util');
  });

  it.each([
    'file:///tmp/x.py',
    'python://stdlib/os',
    'ignition://P',
    'ignition://P/',
    'ignition:///path',
    '',
  ])('answers null for a URI that is not one of ours: %s', (uri) => {
    expect(parseLocationUri(uri)).toBeNull();
  });
});

describe('entryForLocation', () => {
  const helpers = entry({});
  const doGet = entry({
    path: 'com.inductiveautomation.webdev/resources/admin',
    typeId: 'resources',
    scriptKey: 'doGet.py',
    typeLabel: 'Web Dev',
  });
  const doPost = entry({
    path: 'com.inductiveautomation.webdev/resources/admin',
    typeId: 'resources',
    scriptKey: 'doPost.py',
    typeLabel: 'Web Dev',
  });

  it('finds the script at a path', () => {
    expect(entryForLocation([helpers], { project: 'P', path: helpers.path })).toBe(helpers);
  });

  it('picks the right handler when the location names a data key', () => {
    // One resource path holds up to eight scripts. Matching on the path alone
    // opens whichever the listing happened to put first, which is the same class
    // of bug that put doGet's outline on the doPost tab in 1.4.
    const found = entryForLocation([doGet, doPost], {
      project: 'P',
      path: doGet.path,
      scriptKey: 'doPost.py',
    });
    expect(found).toBe(doPost);
  });

  it('falls back to the first script on the path when the key is not listed', () => {
    expect(
      entryForLocation([doGet], { project: 'P', path: doGet.path, scriptKey: 'doDelete.py' })
    ).toBe(doGet);
  });

  it('answers null when the tree has no such script', () => {
    // A real answer, not a failure to try: the AST index covers INHERITED
    // library modules, so a definition can legitimately land in a module this
    // project's tree is not showing.
    expect(
      entryForLocation([helpers], { project: 'P', path: 'ignition/script-python/absent' })
    ).toBeNull();
  });
});

describe('pathForModule', () => {
  it('turns a dotted module name into its resource path', () => {
    expect(pathForModule('util.helpers')).toBe('ignition/script-python/util/helpers');
  });

  it('handles a top-level module', () => {
    expect(pathForModule('util')).toBe('ignition/script-python/util');
  });
});

describe('labelForLocation', () => {
  it('prefers the module name the server sent', () => {
    // `util.helpers` is how the code refers to that file;
    // `ignition/script-python/util/helpers` is how the resource system does.
    expect(labelForLocation({ module: 'util.helpers', uri: 'ignition://P/x' }))
      .toBe('util.helpers');
  });

  it('derives a dotted name from the path when the server sent none', () => {
    expect(labelForLocation({ uri: 'ignition://P/ignition/script-python/util/helpers' }))
      .toBe('util.helpers');
  });

  it('falls back to the raw URI rather than rendering an empty row', () => {
    expect(labelForLocation({ uri: 'file:///tmp/x.py' })).toBe('file:///tmp/x.py');
  });
});
