import { scoreHeatColors } from '@rate-pirate/shared';

/** Heat-scale the badge to the score so a mediocre deal doesn't read as green /
 *  great: hue runs red (weak) → green (strong) across 0–100, with a pale tinted
 *  background and a darker same-hue text for contrast. */
export default function ScoreBadge({ score }: { score: number }) {
  const { background, text } = scoreHeatColors(score);
  return (
    <span
      className="inline-block rounded-lg px-2.5 py-1 text-sm font-bold"
      style={{ backgroundColor: background, color: text }}
    >
      {score}% deal score
    </span>
  );
}
