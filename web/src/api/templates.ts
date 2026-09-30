/**
 * "New from…" — a starting point for a new Project Library script.
 *
 * ## Why these are not snippets
 *
 * `Snippets.java` already offers eighteen tab-stop templates INSIDE a buffer,
 * through ordinary completion. These are different in one way that changes what
 * they can be: a template is the WHOLE file, chosen before there is a buffer to
 * complete in, so it can carry a module docstring, an import block and a shape
 * — the things a snippet cannot, because it is inserted into a file that already
 * has them.
 *
 * The overlap is deliberate and small. `funcdoc` gives you one documented
 * function; `Library module` gives you the file that holds them.
 *
 * ## Client-side, unlike the snippets
 *
 * Snippets are gateway-side because completion is: the language server has to
 * offer them, and offering them means being the server. A template is chosen in
 * a dialog and written by the ordinary create path, so it needs nothing from the
 * gateway, and a round trip to fetch static text would only add a way for the
 * dialog to fail.
 *
 * ## House rules these obey
 *
 * **Tabs, never spaces** — the byte-fidelity rule in `CodeEditor`. This estate
 * writes Jython with tabs and this module never converts one to the other, so a
 * template that seeded spaces would quietly start every new file on the wrong
 * side of a rule the linter then reports.
 *
 * **`java.lang.Throwable`, not `Exception`**, wherever a template catches around
 * something that calls the platform — a Stop and the execution timeout arrive as
 * a Java `Error`, which is a `Throwable` and not an `Exception`. Getting this
 * wrong in a template would seed the estate's most-repeated bug into every file
 * anyone started from it.
 */

export interface ScriptTemplate {
  id: string;
  /** What the picker shows. */
  label: string;
  /** One line under the label, saying when to reach for it. */
  hint: string;
  /** The whole file. */
  source: string;
}

/** The empty file, which is what the Designer's own "new script" gives you. */
export const EMPTY_TEMPLATE: ScriptTemplate = {
  id: 'empty',
  label: 'Empty',
  hint: 'A blank file, exactly as the Designer creates one.',
  source: '',
};

export const TEMPLATES: ScriptTemplate[] = [
  EMPTY_TEMPLATE,
  {
    id: 'module',
    label: 'Library module',
    hint: 'A documented module with a public function — the ordinary starting point.',
    source: [
      '"""',
      'What this module is for, in one line.',
      '',
      'Then the thing a reader needs that the code cannot tell them: why it works',
      'this way, or what it must not be used for.',
      '"""',
      '',
      '',
      'def run(argument):',
      '\t"""What it does, and what it hands back."""',
      '\treturn argument',
      '',
    ].join('\n'),
  },
  {
    id: 'db',
    label: 'Database read',
    hint: 'A parameterised query returning rows, with the connection named once.',
    source: [
      '"""Reads from the database. One place that names the connection."""',
      '',
      'DATABASE = "ChangeMe"',
      '',
      '',
      'def rows(since):',
      '\t"""Rows since the given timestamp, newest first.',
      '',
      '\tThe value is passed as an ARGUMENT, never formatted into the SQL: a name',
      "\twith an apostrophe in it is enough to break a formatted query, and the",
      '\tsame gap is how injection gets in.',
      '\t"""',
      '\tquery = "SELECT id, name, stamp FROM my_table WHERE stamp > ? ORDER BY stamp DESC"',
      '\treturn system.db.runPrepQuery(query, [since], DATABASE)',
      '',
    ].join('\n'),
  },
  {
    id: 'transaction',
    label: 'Database write in one transaction',
    hint: 'Begin, commit, and a rollback that also runs when the platform throws.',
    source: [
      '"""Writes several rows as one unit: all of them, or none."""',
      '',
      'from java.lang import Throwable',
      '',
      'DATABASE = "ChangeMe"',
      '',
      '',
      'def save(rows):',
      '\t"""Insert every row, or leave the table exactly as it was."""',
      '\t# beginTransaction, NOT beginNamedQueryTransaction — that one is for',
      '\t# system.db.runNamedQuery. Verified on 8.3.8: this id is what every',
      '\t# runPrep* call below takes as tx=.',
      '\ttransaction = system.db.beginTransaction(database=DATABASE, timeout=5000)',
      '\ttry:',
      '\t\tfor row in rows:',
      '\t\t\tsystem.db.runPrepUpdate(',
      '\t\t\t\t"INSERT INTO my_table (name, stamp) VALUES (?, ?)",',
      '\t\t\t\t[row["name"], row["stamp"]],',
      '\t\t\t\ttx=transaction)',
      '\t\tsystem.db.commitTransaction(transaction)',
      '\t# Throwable, not Exception: a Stop and the execution timeout arrive as a',
      '\t# Java Error, and an `except Exception` here would commit nothing and',
      '\t# roll back nothing, leaving the transaction open.',
      '\texcept Throwable:',
      '\t\tsystem.db.rollbackTransaction(transaction)',
      '\t\traise',
      '\tfinally:',
      '\t\tsystem.db.closeTransaction(transaction)',
      '',
    ].join('\n'),
  },
  {
    id: 'tags',
    label: 'Tag read and write',
    hint: 'Blocking reads with their quality checked, and a batched write.',
    source: [
      '"""Reads and writes tags. Quality is checked, not assumed."""',
      '',
      'BASE = "[default]MyFolder"',
      '',
      '',
      'def values(names):',
      '\t"""A dict of name to value, leaving out anything not good quality.',
      '',
      '\tA bad-quality read still returns a QualifiedValue with a value in it —',
      '\tusually the last good one, or zero — so code that ignores the quality',
      '\tcarries on with a number that means nothing.',
      '\t"""',
      '\tpaths = ["%s/%s" % (BASE, name) for name in names]',
      '\tresults = system.tag.readBlocking(paths)',
      '\treturn dict(',
      '\t\t(name, result.value)',
      '\t\tfor name, result in zip(names, results)',
      '\t\tif result.quality.isGood())',
      '',
      '',
      'def write(updates):',
      '\t"""Write a dict of name to value in ONE call, not one call per tag."""',
      '\tpaths = ["%s/%s" % (BASE, name) for name in updates]',
      '\treturn system.tag.writeBlocking(paths, [updates[name] for name in updates])',
      '',
    ].join('\n'),
  },
  {
    id: 'tests',
    label: 'Test module',
    hint: 'For the built-in runner — remember the module name must start with test.',
    source: [
      '"""Tests for <the module under test>.',
      '',
      'Discovery is NARROW on purpose: this module is only found if its last name',
      'starts with "test", or it lives under a "tests" package. That is what stops',
      'a function called test_connection, whose job is to open a socket to a PLC,',
      'appearing under a Run All button.',
      '"""',
      '',
      '',
      'def setUp():',
      '\t"""Runs before each test. Delete if there is nothing to set up."""',
      '\tpass',
      '',
      '',
      'def test_it_does_the_thing():',
      '\t# The helpers are seeded into the run, so import them INSIDE the function',
      '\t# if this module must also stay importable outside a test run.',
      '\tfrom scriptide import assertEquals',
      '\tassertEquals(2, 1 + 1, "arithmetic still works")',
      '',
    ].join('\n'),
  },
  {
    id: 'logged',
    label: 'Module with a logger',
    hint: 'A named logger and the catch that does not swallow a Stop.',
    source: [
      '"""Does the work and says what happened."""',
      '',
      'from java.lang import Throwable',
      '',
      'LOG = system.util.getLogger("MyProject.MyModule")',
      '',
      '',
      'def run(argument):',
      '\t"""Do the work, log the failure, and let the caller decide."""',
      '\ttry:',
      '\t\tLOG.debugf("starting with %s", argument)',
      '\t\treturn argument',
      '\t# Throwable rather than Exception — see CLAUDE.md. Catching Exception',
      '\t# here would swallow a Stop and carry on as though nothing happened.',
      '\texcept Throwable:',
      '\t\tLOG.error("failed for %s" % (argument,))',
      '\t\t# Logged, then re-raised: swallowing it here hides the failure from',
      '\t\t# whatever called this, which then behaves as if it succeeded.',
      '\t\traise',
      '',
    ].join('\n'),
  },
];

export function templateById(id: string): ScriptTemplate {
  return TEMPLATES.find((template) => template.id === id) ?? EMPTY_TEMPLATE;
}
