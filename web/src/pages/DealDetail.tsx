import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DealDetail as DealDetailType, Layover } from '@rate-pirate/shared';
import { TRIP_TYPE_LABELS } from '@rate-pirate/shared';
import { api, monthLabel, shortDate, timeAgo, usd } from '../api/client';
import { useAutoRefresh } from '../useAutoRefresh';
import ScoreBadge from '../components/ScoreBadge';
import PriceTag from '../components/PriceTag';
import CabinBadge from '../components/CabinBadge';
import Sparkline from '../components/Sparkline';

export default function DealDetail() {
  const { id } = useParams();
  const [deal, setDeal] = useState<DealDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (id)
      api
        .deal(id)
        .then((d) => {
          setDeal(d);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useAutoRefresh(load);

  // A failed background refresh must not replace an already-loaded deal.
  if (error && !deal) {
    return (
      <div className="p-4">
        <BackLink />
        <p className="mt-8 text-center text-gray-500">{error}</p>
      </div>
    );
  }
  if (!deal) return <p className="mt-12 text-center text-gray-400">Loading…</p>;

  const savedCents = deal.baselinePriceCents - deal.bestPriceCents;
  const detail = flightDetail(deal);

  return (
    <div>
      <header className="bg-brand-pale px-4 pb-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <BackLink />
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight">
            {deal.origin} <span className="font-normal text-gray-400">⇄</span> {deal.city}
          </h1>
          <CabinBadge cabin={deal.cabin} />
        </div>
        <p className="text-sm text-gray-600">
          {deal.country} • {TRIP_TYPE_LABELS[deal.tripType]} • {monthLabel(deal.travelMonth)} •{' '}
          <ScoreBadge score={deal.score} />
        </p>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <Sparkline
          points={deal.priceHistory}
          baselineCents={deal.baselinePriceCents}
          verdict={deal.googleLevel}
        />

        <a
          href={deal.googleFlightsUrl}
          target="_blank"
          rel="noreferrer"
          className="block rounded-2xl border border-green-200 bg-green-50 p-4 active:bg-green-100"
        >
          {savedCents > 0 && (
            <p className="mb-3 rounded-xl bg-green-600 px-3 py-2 text-sm font-bold text-white">
              💰 Save {usd(savedCents)} vs the typical fare
            </p>
          )}
          <div className="flex items-center justify-between">
            <span>
              <span className="font-bold">
                {shortDate(deal.departDate)} – {shortDate(deal.returnDate)}
              </span>
              <span className="block text-sm text-gray-500">Round trip • {deal.nights} nights</span>
              {detail && <span className="block text-xs text-gray-400">{detail}</span>}
              <span className="block text-xs text-gray-400">
                for {deal.adults} {deal.adults === 1 ? 'adult' : 'adults'}
              </span>
            </span>
            <PriceTag priceCents={deal.bestPriceCents} baselineCents={deal.baselinePriceCents} />
          </div>
          <p className="mt-2 text-sm font-semibold text-brand">Book on Google Flights →</p>
        </a>

        <p className="mt-1 text-center text-xs text-gray-400">
          First spotted {timeAgo(deal.firstSeenAt)} • last seen {timeAgo(deal.lastSeenAt)}
        </p>

        <p className="mt-1 text-center text-xs text-gray-400">
          Typical price is the median of Google’s price history for this trip. Tapping “Book” opens
          Google Flights for this exact itinerary.
        </p>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/"
      aria-label="Back to deals"
      className="-m-2 inline-block p-2 text-2xl leading-none text-gray-800"
    >
      ←
    </Link>
  );
}

/** "1h 30m" / "16h 5m" from minutes. */
function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

/** "16h 5m • 1 stop via Atlanta (3h 31m) · Delta" — omits parts we didn't capture. */
function flightDetail(props: {
  stops: number | null;
  carrier: string | null;
  durationMinutes: number | null;
  layovers: Layover[];
}): string {
  const parts: string[] = [];
  if (props.durationMinutes != null) parts.push(fmtDuration(props.durationMinutes));
  if (props.stops != null) {
    if (props.stops === 0) parts.push('Nonstop');
    else {
      const via = props.layovers
        .map((l) => `${l.airport}${l.minutes != null ? ` (${fmtDuration(l.minutes)})` : ''}`)
        .join(', ');
      parts.push(`${props.stops} stop${props.stops === 1 ? '' : 's'}${via ? ` via ${via}` : ''}`);
    }
  }
  const main = parts.join(' • ');
  return props.carrier ? `${main}${main ? ' · ' : ''}${props.carrier}` : main;
}
