import { describe, expect, it } from 'vitest';
import {
  NO_GIT,
  decorate,
  markLetter,
  markTitle,
  summarise,
  worseMark,
  type GitMark,
  type GitState,
} from './git';

const state = (over: Partial<GitState> = {}): GitState => ({
  ...NO_GIT,
  project: 'Demo',
  repo: true,
  branch: 'main',
  head: 'abc1234',
  ...over,
});

describe('worseMark', () => {
  it('ranks conflict above deletion above modification above addition', () => {
    expect(worseMark('modified', 'deleted')).toBe('deleted');
    expect(worseMark('added', 'modified')).toBe('modified');
    expect(worseMark('deleted', 'conflicted')).toBe('conflicted');
  });

  it('folds over an absent mark, which is how a folder takes its children', () => {
    expect(worseMark(null, 'added')).toBe('added');
    expect(worseMark('added', null)).toBe('added');
    expect(worseMark(null, null)).toBeNull();
  });
});

describe('decorate', () => {
  const nodes = [
    'ignition/script-python/Demo',
    'ignition/script-python/Demo/config',
    'ignition/script-python/Demo/sim',
  ];

  it('marks the resource that changed', () => {
    const out = decorate({ 'ignition/script-python/Demo/config': 'modified' }, nodes);
    expect(out.get('ignition/script-python/Demo/config')).toBe('modified');
  });

  it('marks every folder above it, so a collapsed package is honest', () => {
    // The failure without this: a package collapsed by default looks clean while
    // holding a changed script, which is the state most people's tree is in.
    const out = decorate({ 'ignition/script-python/Demo/config': 'modified' }, nodes);
    expect(out.get('ignition/script-python/Demo')).toBe('modified');
  });

  it('rolls a DELETED resource up to the folder that still exists', () => {
    // The node is gone from the tree, so there is nothing to decorate at its own
    // path. Dropping it would make deletion the one change this cannot show.
    const out = decorate({ 'ignition/script-python/Demo/gone': 'deleted' }, nodes);
    expect(out.has('ignition/script-python/Demo/gone')).toBe(false);
    expect(out.get('ignition/script-python/Demo')).toBe('deleted');
  });

  it('gives a folder the WORST of its children, not the last one seen', () => {
    const out = decorate(
      {
        'ignition/script-python/Demo/config': 'added',
        'ignition/script-python/Demo/sim': 'deleted',
      },
      nodes
    );
    expect(out.get('ignition/script-python/Demo')).toBe('deleted');
    expect(out.get('ignition/script-python/Demo/config')).toBe('added');
  });

  it('drops a mark with no surviving ancestor rather than inventing a node', () => {
    const out = decorate({ 'com.example.other/thing/gone': 'deleted' }, nodes);
    expect(out.size).toBe(0);
  });

  it('is empty for a clean tree', () => {
    expect(decorate({}, nodes).size).toBe(0);
  });
});

describe('summarise', () => {
  it('says nothing at all when the project is not a repository', () => {
    // Most projects are not. A line saying so on every one of them would be
    // chrome that teaches people to stop reading that part of the screen.
    expect(summarise(state({ repo: false }))).toBeNull();
  });

  it('says nothing when the tree is clean', () => {
    expect(summarise(state())).toBeNull();
  });

  it('names the failure when the repository cannot be read', () => {
    // The distinction the whole feature turns on: unreadable must never render
    // the same as clean.
    expect(summarise(state({ error: 'HEAD is unreadable' }))).toContain('HEAD is unreadable');
  });

  it('says there is no commit yet rather than claiming everything is new', () => {
    // Measured on JGit: with no commit, every tracked file reports as added.
    // True, and useless as hundreds of badges.
    expect(summarise(state({ head: null }))).toBe('main — no commit yet');
  });

  it('counts changed resources against the branch', () => {
    const marks: Record<string, GitMark> = { a: 'modified', b: 'added' };
    expect(summarise(state({ marks }))).toBe('main — 2 changed');
  });

  it('names changes that have no node, rather than omitting them silently', () => {
    // project.json cannot be decorated. A summary that ignored it would
    // disagree with `git status` and look like a bug in this module.
    expect(summarise(state({ others: 1 }))).toBe('main — 1 outside the tree');
  });

  it('falls back to the commit id when HEAD is detached and has no branch', () => {
    expect(summarise(state({ branch: null, marks: { a: 'modified' } })))
      .toBe('abc1234 — 1 changed');
  });
});

describe('mark labels', () => {
  it('has a letter and a sentence for every mark', () => {
    for (const mark of ['conflicted', 'deleted', 'modified', 'added'] as GitMark[]) {
      expect(markLetter(mark)).toHaveLength(1);
      expect(markTitle(mark).length).toBeGreaterThan(10);
    }
  });
});
