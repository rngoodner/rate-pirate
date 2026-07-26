import { Link } from 'react-router-dom';
import type { Deal } from '@rate-pirate/shared';
import { TRIP_TYPE_LABELS } from '@rate-pirate/shared';
import { monthLabel } from '../api/client';
import ScoreBadge from './ScoreBadge';
import PriceTag from './PriceTag';
import CabinBadge from './CabinBadge';
import PartyBadge from './PartyBadge';
import AirlineLabel from './AirlineLabel';

export default function DealCard({ deal }: { deal: Deal }) {
  return (
    <Link
      to={`/deals/${deal.id}`}
      // Alert-eligible deals get a tasteful amber ring + soft glow so they stand
      // out in the feed (they'd trigger an email).
      className={`block rounded-2xl bg-white p-4 active:bg-gray-50 ${
        deal.alertEligible
          ? 'shadow-[0_0_0_4px_rgba(245,158,11,0.12)] ring-2 ring-amber-400'
          : 'shadow-sm'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-2 text-lg font-extrabold">
          {deal.city}
          {deal.isNew && (
            <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              New
            </span>
          )}
        </p>
        <CabinBadge cabin={deal.cabin} />
      </div>
      <p className="text-sm text-gray-500">
        {deal.country} • {TRIP_TYPE_LABELS[deal.tripType]} • {monthLabel(deal.travelMonth)}
      </p>
      {deal.airline && (
        <div className="mt-1">
          <AirlineLabel airline={deal.airline} />
        </div>
      )}
      <div className="mt-3 flex items-end justify-between">
        <ScoreBadge score={deal.score} />
        <span className="flex items-center gap-1">
          <span className="flex flex-col items-end">
            <PartyBadge adults={deal.adults} />
            <PriceTag priceCents={deal.bestPriceCents} baselineCents={deal.baselinePriceCents} />
          </span>
          <span className="text-gray-400">›</span>
        </span>
      </div>
    </Link>
  );
}
