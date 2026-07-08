/** Heat-map colors for a 0–100 deal score, shared by the web badge and the alert
 *  email so both read the same. Hue runs red (weak) → green (strong); the badge
 *  uses a pale tinted background with darker same-hue text for contrast. Returns
 *  hex (not hsl) so it also renders in email clients — Outlook ignores hsl(). */
export function scoreHeatColors(score: number): { background: string; text: string } {
  const hue = Math.round((Math.max(0, Math.min(100, score)) / 100) * 140);
  return { background: hslToHex(hue, 85, 92), text: hslToHex(hue, 70, 30) };
}

/** HSL (h in degrees, s/l in percent) → #rrggbb. */
function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100;
  const lf = l / 100;
  const a = sf * Math.min(lf, 1 - lf);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const v = lf - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
