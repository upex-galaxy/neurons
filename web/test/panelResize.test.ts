import { describe, expect, it } from 'vitest';
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, clampPanelWidth } from '../src/panelResize.ts';

describe('clampPanelWidth', () => {
  it('keeps the width between 280 px and min(720 px, 60% of the viewport)', () => {
    expect(clampPanelWidth(100, 1600)).toBe(PANEL_MIN);
    expect(clampPanelWidth(500, 1600)).toBe(500);
    expect(clampPanelWidth(5000, 1600)).toBe(PANEL_MAX);
    expect(clampPanelWidth(700, 1000)).toBe(600);
    expect(clampPanelWidth(399.6, 1280)).toBe(400);
  });

  it('lets the minimum win on tiny viewports and survives garbage', () => {
    expect(clampPanelWidth(600, 300)).toBe(PANEL_MIN);
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(PANEL_DEFAULT);
  });
});
