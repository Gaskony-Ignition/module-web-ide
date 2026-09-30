import { describe, expect, it } from 'vitest';
import { defaultPanelHeight } from './Workspace';

/**
 * The bottom panel's opening height.
 *
 * A fixed 260px was measured CRAMPED on a 1000px viewport in the 02/09/2026
 * review, and the number understates it: the panel gets what is left after the
 * toolbar (34px), the tab strip, the settings row (69px on an inherited script)
 * and the panel's own 30px head, so a console showed about eight lines.
 */
describe('defaultPanelHeight', () => {
  it('gives the 1000px viewport from the review noticeably more than the old 260px', () => {
    expect(defaultPanelHeight(1000)).toBe(340);
  });

  it('still leaves usable code above the panel on a short laptop screen', () => {
    // 34% of 700 is 238; the floor keeps a terminal at a workable number of rows
    // without taking the editor below about half the window.
    expect(defaultPanelHeight(700)).toBe(240);
    expect(defaultPanelHeight(400)).toBe(240);
  });

  it('does not hand a third of a tall monitor to a console nobody asked to grow', () => {
    expect(defaultPanelHeight(2160)).toBe(460);
  });

  it('scales between the two clamps', () => {
    expect(defaultPanelHeight(1200)).toBe(408);
    expect(defaultPanelHeight(1300)).toBe(442);
  });

  it('never returns a fractional pixel', () => {
    for (const height of [733, 901, 1017, 1333]) {
      expect(Number.isInteger(defaultPanelHeight(height))).toBe(true);
    }
  });
});
