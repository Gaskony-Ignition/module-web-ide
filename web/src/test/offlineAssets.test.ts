import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Gateways run air-gapped. A CDN reference is not a slow load — it is a dead
 * request and a silently degraded UI, with no error anyone will see.
 *
 * This guard exists from the first commit deliberately: it is far cheaper to
 * never let a CDN URL in than to find one later. Ported from web-designer, where
 * it is the reason that module has no external asset dependencies at all.
 */
const FORBIDDEN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'esm.sh',
  'code.jquery.com',
  'cdn.tailwindcss.com',
];

const WEB_ROOT = resolve(__dirname, '../..');
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.css', '.html'];

// This file necessarily contains every forbidden host as a literal, so it must
// exclude itself or it is the only thing it ever flags.
const SELF = resolve(__filename);

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'build' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, acc);
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext)) && resolve(full) !== SELF) {
      acc.push(full);
    }
  }
  return acc;
}

describe('offline assets', () => {
  const files = [...collectFiles(join(WEB_ROOT, 'src')), join(WEB_ROOT, 'index.html')];

  it('scans a non-trivial number of files', () => {
    // Without this, a broken collectFiles would make every assertion below pass
    // vacuously — the failure mode that makes a guard worse than no guard.
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(FORBIDDEN_HOSTS)('references no external asset host: %s', (host) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(host));
    expect(offenders, `${host} referenced in:\n${offenders.join('\n')}`).toEqual([]);
  });
});
