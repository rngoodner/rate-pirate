import type { PricePoint } from '@rate-pirate/shared';
import { usd } from '../api/client';

/** Price-history sparkline: Google's ~60-day daily-low prices for this trip,
 *  with the typical price dashed in. Answers "is this actually low?" at a glance. */
export default function Sparkline({
  points,
  baselineCents,
}: {
  points: PricePoint[];
  baselineCents: number;
}) {
  if (points.length < 2) return null;

  const W = 320;
  const H = 72;
  const PAD = 6;
  const prices = points.map((p) => p.priceCents);
  const lo = Math.min(...prices, baselineCents);
  const hi = Math.max(...prices, baselineCents);
  const span = Math.max(hi - lo, 1);
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (cents: number) => PAD + ((hi - cents) / span) * (H - 2 * PAD);

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.priceCents)}`).join(' ');
  const last = points[points.length - 1]!;

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-bold text-gray-900">Price history</span>
        <span className="text-gray-500">
          {points.length} days • low {usd(Math.min(...prices))}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-18 w-full"
        role="img"
        aria-label={`Daily lowest price over the last ${points.length} days; currently ${usd(last.priceCents)} versus a typical ${usd(baselineCents)}`}
      >
        <line
          x1={PAD}
          x2={W - PAD}
          y1={y(baselineCents)}
          y2={y(baselineCents)}
          stroke="#9ca3af"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
        <path d={path} fill="none" stroke="#35b6ea" strokeWidth="2.5" strokeLinejoin="round" />
        <circle cx={x(points.length - 1)} cy={y(last.priceCents)} r="3.5" fill="#35b6ea" />
      </svg>
      <p className="mt-1 text-xs text-gray-400">
        Google's price history for this trip. Dashed line = typical price (
        {usd(baselineCents)}).
      </p>
    </div>
  );
}
