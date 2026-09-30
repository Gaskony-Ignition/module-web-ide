import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { configure } from '@testing-library/react';
import { clearStickyState } from '../workspace/viewState';

/**
 * The sidebar trees remember which folders are open ACROSS an unmount, in
 * sessionStorage with a module-level fallback — so by design that state
 * outlives a component, and in a test file it would outlive the test. Two
 * FileTree cases failed the moment stickiness landed, asserting a collapsed
 * tree and getting one an earlier test had opened.
 *
 * Cleared here rather than in those two files: the leak is a property of the
 * store, so the next test to use a sticky view should not have to rediscover it.
 */
beforeEach(() => {
  clearStickyState();
});

// MUST stay strictly BELOW vite.config.ts's testTimeout (30 s). When the two are
// equal, the query timeout and the vitest watchdog expire together and the
// generic one wins the race: the failure reports only "Test timed out", with no
// DOM dump and no indication of which await hung. web-designer lost a real
// intermittent failure that way. Keeping this lower means Testing Library always
// gives up first and says what it was looking for.
configure({ asyncUtilTimeout: 10_000 });

/**
 * jsdom implements Range but not `Range.getClientRects`, and CodeMirror calls it
 * whenever it has to position something in the viewport — a completion popup, a
 * hover tooltip, the signature-help panel. The failure is caught internally, so
 * nothing breaks; it just prints a stack trace per measurement and buries the
 * real output of the run.
 *
 * Stubbed to "no geometry", which is the truthful answer in a headless DOM: the
 * tooltips still mount and can still be asserted on, they simply have no
 * position. A test that depends on WHERE something is drawn cannot be written
 * against jsdom in the first place, so nothing is being papered over here.
 */
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  const empty = Object.assign([] as unknown as DOMRectList, {
    item: () => null,
  }) as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

/**
 * jsdom has no canvas at all, and xterm.js asks for a 2D context at IMPORT time
 * to measure colour contrast for its DOM renderer. The call is caught internally
 * so nothing fails, but jsdom prints "Not implemented" with a full stack for
 * every test file that transitively imports the terminal — which is most of
 * them, since the workspace does.
 *
 * Stubbed rather than depending on the `canvas` package: the tests here never
 * assert on anything drawn, so a real canvas would be a native build in CI for
 * output nothing reads. The one method xterm actually calls back into is
 * `getImageData`, and returning opaque black is a truthful answer for a surface
 * nothing has painted.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
    clearRect: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h) * 4),
    }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => {},
    measureText: () => ({ width: 0 }),
    scale: () => {},
    rotate: () => {},
    translate: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

/**
 * jsdom has no ResizeObserver, and the editor uses one to re-measure the problem
 * ruler when its pane changes size. Unstubbed it throws during commit, which
 * React reports as an uncaught error and 29 unrelated tests fail with it.
 *
 * A no-op that records the callback: nothing in jsdom has a size to observe, so
 * firing it would be inventing a layout that does not exist.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
