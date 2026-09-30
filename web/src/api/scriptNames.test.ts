import { describe, expect, it } from 'vitest';
import { validateScriptName } from './scripts';

/**
 * Library script names.
 *
 * This is a real constraint, not input hygiene: the resource name IS the Python
 * module path, so an illegal name creates a module that no `import` statement
 * can ever name. The Designer refuses those names and so must this — otherwise
 * the IDE writes a resource to the gateway that its own completions cannot see.
 */
describe('validateScriptName', () => {
  it('accepts a plain name and a package path', () => {
    expect(validateScriptName('helpers')).toBeNull();
    expect(validateScriptName('util/helpers')).toBeNull();
    expect(validateScriptName('a/b/c/deep')).toBeNull();
    expect(validateScriptName('_private')).toBeNull();
    expect(validateScriptName('mixedCase99')).toBeNull();
  });

  it('rejects characters that cannot appear in a Python module name', () => {
    // `import project.my-utils` is a parse error, not a lookup failure.
    expect(validateScriptName('my-utils')).toMatch(/not a valid Python name/);
    expect(validateScriptName('has space')).toMatch(/not a valid Python name/);
    expect(validateScriptName('has.dot')).toMatch(/not a valid Python name/);
    expect(validateScriptName('9leading')).toMatch(/not a valid Python name/);
  });

  it('rejects PYTHON 2 keywords, which is not the same list as Python 3', () => {
    // Jython 2.7 runs these scripts. `print` and `exec` ARE keywords here.
    expect(validateScriptName('print')).toMatch(/keyword/);
    expect(validateScriptName('exec')).toMatch(/keyword/);
    expect(validateScriptName('class')).toMatch(/keyword/);
    // And a keyword anywhere in the package path is just as fatal.
    expect(validateScriptName('util/import/thing')).toMatch(/keyword/);
    // True/False/None are NOT py2 keywords — they are ordinary names, so a
    // module may legitimately be called that.
    expect(validateScriptName('True')).toBeNull();
    expect(validateScriptName('None')).toBeNull();
  });

  it('rejects malformed package paths', () => {
    expect(validateScriptName('')).toBe('Enter a name');
    expect(validateScriptName('   ')).toBe('Enter a name');
    expect(validateScriptName('/leading')).toMatch(/cannot start or end/);
    expect(validateScriptName('trailing/')).toMatch(/cannot start or end/);
    expect(validateScriptName('a//b')).toMatch(/empty folder segment/);
    expect(validateScriptName(' padded')).toMatch(/cannot start or end with a space/);
  });
});
