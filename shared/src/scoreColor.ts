/** Heat-map colors for a 0–100 deal score, shared by the web badge and the alert
 *  email so both read the same. Hue runs red (weak) → green (strong); the badge
 *  uses a pale tinted background with darker same-hue text for contrast. */
export function scoreHeatColors(score: number): { background: string; text: string } {
  const hue = Math.round((Math.max(0, Math.min(100, score)) / 100) * 140);
  return { background: `hsl(${hue} 85% 92%)`, text: `hsl(${hue} 70% 30%)` };
}
