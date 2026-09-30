/**
 * Replace across the project.
 *
 * Search has been able to find a string in every Project Library script on the
 * gateway since 1.0.0, and there has never been a way to change it. The Designer
 * has no project-wide replace either, so today a rename means opening each hit
 * and retyping it — which is how one gets missed.
 *
 * ## Literal, never a pattern
 *
 * The server's search is a literal substring match with a case flag, so the
 * replacement is too. A regex box would find things search cannot, which reads
 * as the results list being wrong, and a half-understood pattern is a very fast
 * way to rewrite a project into something that does not parse.
 *
 * ## What it refuses, and why each refusal is not a limitation
 *
 * - **A dirty buffer is skipped.** The write goes to the gateway; a tab with
 *   unsaved edits would silently disagree with what was written, and the next
 *   Ctrl+S in it would put the old text back over the replacement. Skipping and
 *   saying so is the only version of this that cannot lose work.
 * - **A read-only (inherited) script is skipped.** It is read-only for the same
 *   reason it is in the Designer, and creating an override for every hit would
 *   fork half a project on one button.
 * - **A named query is skipped.** Its SQL is searched (1.16.0) but written
 *   through a different route, against a signature it shares with its settings.
 *   Writing it here would need the settings half too — see the lost-update
 *   `validate_v17_nq` found — so it is reported rather than half-done.
 * - **A file whose signature moved is skipped.** Each write carries the
 *   If-Match from its own read, so a concurrent edit fails that one file's write
 *   rather than overwriting it. The report names it.
 *
 * Nothing here is transactional, because the platform's write path is not: each
 * file is its own push. So the report is per file and always says what actually
 * happened, rather than a single "done".
 */
import type { SaveResult } from '../api/scripts';

/** One script the replace may touch. */
export interface ReplaceTarget {
  /** `ignition://<project>/<path>` — the identity used in the report. */
  uri: string;
  project: string;
  path: string;
  /** The resource's script data key, when it has one. */
  key?: string;
  /** A human label for the report — the dotted module name where known. */
  label: string;
  /** Why this one cannot be written, or undefined when it can. */
  skip?: 'read-only' | 'unsaved-changes' | 'named-query';
}

/** What happened to one script. */
export interface ReplaceOutcome {
  uri: string;
  label: string;
  status: 'changed' | 'skipped' | 'failed' | 'unchanged';
  /** Occurrences replaced, for a `changed` outcome. */
  count: number;
  /** Why, for `skipped` and `failed`. */
  reason?: string;
}

export interface ReplaceReport {
  outcomes: ReplaceOutcome[];
  filesChanged: number;
  occurrences: number;
  /** True when anything at all was written — the caller refreshes on this. */
  wrote: boolean;
}

/**
 * Replace every occurrence of a literal term.
 *
 * Case-insensitive mode scans rather than lower-casing the document, so the text
 * AROUND each match keeps its own case — lower-casing to find, then writing the
 * lower-cased document back, would quietly rewrite every identifier in the file.
 */
export function replaceOccurrences(
  text: string,
  term: string,
  replacement: string,
  caseSensitive: boolean
): { text: string; count: number } {
  if (!term) return { text, count: 0 };
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();
  let out = '';
  let from = 0;
  let count = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    out += text.slice(from, at) + replacement;
    from = at + needle.length;
    count += 1;
  }
  if (count === 0) return { text, count: 0 };
  return { text: out + text.slice(from), count };
}

/** The IO the run needs, injected so the logic is testable without a gateway. */
export interface ReplaceIo {
  read: (target: ReplaceTarget) => Promise<{ text: string; etag: string }>;
  write: (target: ReplaceTarget, source: string, baseSignature: string) => Promise<SaveResult>;
}

/**
 * Run the replace over every target, in order, one file at a time.
 *
 * Sequential rather than parallel on purpose: each write is a `ProjectManager`
 * push, and firing twenty at once at a gateway that is also serving the editor
 * is a self-inflicted load spike for no gain on a job this size.
 */
export async function runReplaceAll(
  targets: ReplaceTarget[],
  term: string,
  replacement: string,
  caseSensitive: boolean,
  io: ReplaceIo
): Promise<ReplaceReport> {
  const outcomes: ReplaceOutcome[] = [];
  let filesChanged = 0;
  let occurrences = 0;

  for (const target of targets) {
    if (target.skip) {
      outcomes.push({
        uri: target.uri,
        label: target.label,
        status: 'skipped',
        count: 0,
        reason:
          target.skip === 'read-only'
            ? 'inherited, and read-only until you override it'
            : target.skip === 'named-query'
              ? 'a named query — searched, but SQL is edited through its own tab'
              : 'has unsaved changes in an open tab',
      });
      continue;
    }
    try {
      const current = await io.read(target);
      const next = replaceOccurrences(current.text, term, replacement, caseSensitive);
      if (next.count === 0) {
        // The search hit is older than the file. Not an error, and not a write.
        outcomes.push({
          uri: target.uri,
          label: target.label,
          status: 'unchanged',
          count: 0,
          reason: 'no longer contains the search text',
        });
        continue;
      }
      await io.write(target, next.text, current.etag);
      outcomes.push({ uri: target.uri, label: target.label, status: 'changed', count: next.count });
      filesChanged += 1;
      occurrences += next.count;
    } catch (e: unknown) {
      outcomes.push({
        uri: target.uri,
        label: target.label,
        status: 'failed',
        count: 0,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { outcomes, filesChanged, occurrences, wrote: filesChanged > 0 };
}

/** A one-line summary for the status strip. */
export function summarise(report: ReplaceReport): string {
  const parts: string[] = [];
  parts.push(
    report.filesChanged === 0
      ? 'Nothing was changed.'
      : `Replaced ${report.occurrences} ${report.occurrences === 1 ? 'occurrence' : 'occurrences'}`
        + ` in ${report.filesChanged} ${report.filesChanged === 1 ? 'file' : 'files'}.`
  );
  const skipped = report.outcomes.filter((o) => o.status === 'skipped').length;
  const failed = report.outcomes.filter((o) => o.status === 'failed').length;
  if (skipped > 0) parts.push(`${skipped} skipped.`);
  if (failed > 0) parts.push(`${failed} failed.`);
  return parts.join(' ');
}
