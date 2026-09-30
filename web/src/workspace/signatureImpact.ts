/**
 * What a save is about to break.
 *
 * The Designer cannot answer this at all: change a function's arguments, or
 * delete it, and every caller keeps compiling and fails at run time — in a timer
 * script, in a Perspective binding, in whatever imported it. The index and the
 * references provider needed to answer it have been in this module since 1.6.0
 * and nothing ever asked them at the one moment it matters.
 *
 * ## Why a text scan and not the AST
 *
 * The server holds a real Jython parser and could return an argument list. But
 * the question here is about TWO versions of a buffer — the one on the gateway
 * and the one about to replace it — and only one of them is a document the
 * server knows. Sending it the old text to parse would be a second round trip in
 * the save path, on every save, to answer a question that a `def` line already
 * answers exactly.
 *
 * It is a line scan, and it is deliberately conservative in one direction: it
 * looks only at TOP-LEVEL definitions, because an indented `def` is a method or
 * a closure whose name is not what a caller imports. A method signature change
 * is a real risk this does not report, and that is the honest limit — reporting
 * every nested `def` would fire on refactors that break nothing.
 *
 * ## And why over-reporting is the safe direction
 *
 * The call sites come from `scriptide/references`, which matches whole
 * identifiers rather than resolving receivers, so an unrelated `compute` is
 * listed too. For "here are the places to check" that is the right way to be
 * wrong — a list with an extra row costs a glance, a list missing a row costs an
 * outage. It is the same argument the Search view already makes on screen.
 */

/** A top-level `def` or `class`, and the line that declares it. */
export interface TopLevelDef {
  name: string;
  /** The declaration as written, normalised for whitespace only. */
  declaration: string;
}

/**
 * Every top-level `def` and `class` in a module.
 *
 * Top-level means column zero: an indented one belongs to a class or a closure.
 * A decorator above the line is ignored, which is correct — decorating a
 * function does not change what a caller passes it.
 */
export function topLevelDefs(source: string): Map<string, TopLevelDef> {
  const out = new Map<string, TopLevelDef>();
  if (!source) return out;
  for (const raw of source.split('\n')) {
    // Column zero only, and `def`/`class` followed by a name.
    const match = /^(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\(.*)?$/.exec(raw);
    if (!match) continue;
    const name = match[2];
    // Whitespace inside the parameter list is not a signature change: `f(a, b)`
    // and `f(a,b)` take the same call. Collapsing it stops a reformat looking
    // like a breaking change.
    const declaration = `${match[1]} ${name}${(match[3] ?? '').replace(/\s+/g, '')}`;
    out.set(name, { name, declaration });
  }
  return out;
}

/** Names whose callers may need changing, split by why. */
export interface SignatureImpact {
  /** Present before, absent now. Every caller breaks. */
  removed: string[];
  /** Still present, declared differently. Callers may break. */
  changed: string[];
}

/** True when there is anything at all to report. */
export function hasImpact(impact: SignatureImpact): boolean {
  return impact.removed.length > 0 || impact.changed.length > 0;
}

/** Every top-level name a save removes or re-declares. */
export function signatureImpact(before: string, after: string): SignatureImpact {
  const was = topLevelDefs(before);
  const now = topLevelDefs(after);
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, def] of was) {
    const current = now.get(name);
    if (!current) {
      removed.push(name);
    } else if (current.declaration !== def.declaration) {
      changed.push(name);
    }
  }
  return { removed, changed };
}

/** The sentence the save bar shows, given what was found and how many callers. */
export function describeImpact(impact: SignatureImpact, callSites: number): string {
  const parts: string[] = [];
  if (impact.removed.length > 0) {
    parts.push(
      `${impact.removed.length === 1 ? 'Removes' : 'Removes'} `
      + `${impact.removed.map((n) => `“${n}”`).join(', ')}`
    );
  }
  if (impact.changed.length > 0) {
    parts.push(
      `Re-declares ${impact.changed.map((n) => `“${n}”`).join(', ')}`
    );
  }
  const what = parts.join('; ');
  return callSites === 1
    ? `${what}. 1 place in this project writes that name.`
    : `${what}. ${callSites} places in this project write those names.`;
}
