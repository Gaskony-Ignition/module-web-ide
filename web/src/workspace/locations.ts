/**
 * Turning a language-server location back into something this workspace can open.
 *
 * Navigation is the first feature where the server hands the client a place it
 * did not already have open: go-to-definition, quick-open, project search and
 * references all answer with an `ignition://…` URI, and the workspace addresses
 * scripts by tree entry. Nothing joined the two before 1.6.0, which is most of
 * why P4's server work sat unreachable for five versions.
 *
 * The join is deliberately in its own module, with no React in it, because it is
 * the part that is easy to get subtly wrong (a data key silently dropped, a
 * module name that is not a path) and easy to test exactly.
 */
import type { ScriptEntry } from '../api/scripts';

/** An LSP document URI taken apart. */
export interface ParsedLocation {
  project: string;
  /** Resource path, as `scripts.ts` uses it — slashes intact. */
  path: string;
  /**
   * The `.py` data key, when the URI carried one.
   *
   * `lspUri` appends it as a fragment and OMITS it for `code.py`, so an absent
   * fragment means "this resource's default key", not "no key". Resolving it to
   * `code.py` here would be wrong for a Web Dev endpoint, whose default is
   * whichever handler the tree row is for.
   */
  scriptKey?: string;
}

/**
 * `ignition://<project>/<resourcePath>[#<key>]` → its parts.
 *
 * Hand-parsed rather than via `new URL()`: the resource path is not
 * percent-encoded on this wire (see `lspUri`), and `URL` would encode `!Library`
 * and every space on the way back out, so a round trip through it does not
 * return the path the REST layer is keyed on.
 *
 * Returns null for anything that is not one of ours, so a caller can pass a
 * `file://` or `python://` URI from some future provider straight through
 * without a special case.
 */
export function parseLocationUri(uri: string): ParsedLocation | null {
  const prefix = 'ignition://';
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  const hash = rest.indexOf('#');
  const scriptKey = hash < 0 ? undefined : rest.slice(hash + 1);
  const body = hash < 0 ? rest : rest.slice(0, hash);
  const slash = body.indexOf('/');
  // A project with no path at all addresses nothing openable.
  if (slash <= 0 || slash === body.length - 1) return null;
  return {
    project: body.slice(0, slash),
    path: body.slice(slash + 1),
    scriptKey: scriptKey && scriptKey.length > 0 ? scriptKey : undefined,
  };
}

/**
 * The tree entry a location refers to, or null when the tree has no such script.
 *
 * Null is a real answer, not a failure to try: the server indexes the project
 * library from the resource collection, which includes INHERITED scripts, and a
 * definition can legitimately land in a module the tree is not showing. The
 * caller reports that rather than opening the wrong file.
 *
 * The data key is part of the match when the location carries one — a Web Dev
 * endpoint is one path holding up to eight scripts, and matching on path alone
 * opens whichever of them the tree happens to list first.
 */
export function entryForLocation(
  scripts: ScriptEntry[],
  location: ParsedLocation
): ScriptEntry | null {
  const onPath = scripts.filter((entry) => entry.path === location.path);
  if (onPath.length === 0) return null;
  if (!location.scriptKey) return onPath[0];
  return onPath.find((entry) => entry.scriptKey === location.scriptKey) ?? onPath[0];
}

/**
 * A dotted library module name as its resource path.
 *
 * `util.helpers` → `ignition/script-python/util/helpers`. The server already
 * sends the full URI, so this exists for the one place that has only a name: a
 * search result's heading, which is matched back to the tree to decide whether
 * the row is clickable.
 */
export function pathForModule(moduleName: string): string {
  return `ignition/script-python/${moduleName.replace(/\./g, '/')}`;
}

/**
 * `ignition/script-python/util/helpers` → `util.helpers`, or null.
 *
 * The inverse of {@link pathForModule}, and null for anything that is not a
 * library script: a timer script has a resource path and no importable name, so
 * there is nothing to rewrite at a call site.
 */
export function moduleNameFor(path: string): string | null {
  const prefix = 'ignition/script-python/';
  if (!path.startsWith(prefix)) return null;
  const tail = path.slice(prefix.length);
  return tail.length > 0 ? tail.replace(/\//g, '.') : null;
}

/**
 * The label for a hit's file, for a results heading.
 *
 * Prefers the module name the server sent, because `util.helpers` is how the
 * code refers to that file and `ignition/script-python/util/helpers` is how the
 * resource system does. Falls back to the tail of the path so a hit from some
 * other resource type still names itself.
 */
export function labelForLocation(hit: { module?: string; uri: string }): string {
  if (hit.module) return hit.module;
  const parsed = parseLocationUri(hit.uri);
  if (!parsed) return hit.uri;
  const tail = parsed.path.split('/').filter(Boolean).slice(2).join('.');
  return tail || parsed.path;
}
