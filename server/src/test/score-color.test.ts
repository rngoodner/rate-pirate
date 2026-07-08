import { describe, expect, it } from 'vitest';
import { scoreHeatColors } from '@rate-pirate/shared';

describe('scoreHeatColors', () => {
  it('returns hex (not hsl) so email clients like Outlook render it', () => {
    for (const score of [0, 42, 55, 80, 100]) {
      const c = scoreHeatColors(score);
      expect(c.background).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.text).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('clamps out-of-range scores and is deterministic', () => {
    expect(scoreHeatColors(-10)).toEqual(scoreHeatColors(0));
    expect(scoreHeatColors(150)).toEqual(scoreHeatColors(100));
    expect(scoreHeatColors(85)).toEqual(scoreHeatColors(85));
  });

  it('shifts hue from red (low) to green (high)', () => {
    // Low score is reddish (R > G), high score is greenish (G > R).
    const low = scoreHeatColors(10).text;
    const high = scoreHeatColors(95).text;
    const r = (hex: string) => parseInt(hex.slice(1, 3), 16);
    const g = (hex: string) => parseInt(hex.slice(3, 5), 16);
    expect(r(low)).toBeGreaterThan(g(low));
    expect(g(high)).toBeGreaterThan(r(high));
  });
});
