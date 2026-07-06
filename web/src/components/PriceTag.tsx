import { usd } from '../api/client';

export default function PriceTag({
  priceCents,
  baselineCents,
  estimated = false,
  size = 'lg',
}: {
  priceCents: number;
  baselineCents: number;
  /** Baseline bootstrapped from Google's price history, not our own scans. */
  estimated?: boolean;
  size?: 'lg' | 'md';
}) {
  return (
    <span className="whitespace-nowrap">
      <span className="mr-1.5 text-gray-400 line-through">
        {usd(baselineCents)}
        {estimated && <sup className="ml-0.5 text-[0.6em] no-underline">est.</sup>}
      </span>
      <span className={`font-extrabold ${size === 'lg' ? 'text-2xl' : 'text-xl'}`}>
        {usd(priceCents)}
      </span>
    </span>
  );
}
