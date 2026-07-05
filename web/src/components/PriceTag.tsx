import { usd } from '../api/client';

export default function PriceTag({
  priceCents,
  baselineCents,
  size = 'lg',
}: {
  priceCents: number;
  baselineCents: number;
  size?: 'lg' | 'md';
}) {
  return (
    <span className="whitespace-nowrap">
      <span className="mr-1.5 text-gray-400 line-through">{usd(baselineCents)}</span>
      <span className={`font-extrabold ${size === 'lg' ? 'text-2xl' : 'text-xl'}`}>
        {usd(priceCents)}
      </span>
    </span>
  );
}
