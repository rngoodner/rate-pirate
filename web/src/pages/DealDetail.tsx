import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CABIN_LABELS, type DealDetail as DealDetailType } from '@rate-pirate/shared';
import { api, monthLabel, shortDate } from '../api/client';
import ScoreBadge from '../components/ScoreBadge';
import PriceTag from '../components/PriceTag';
import CabinBadge from '../components/CabinBadge';

export default function DealDetail() {
  const { id } = useParams();
  const [deal, setDeal] = useState<DealDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id) api.deal(id).then(setDeal).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="p-4">
        <BackLink />
        <p className="mt-8 text-center text-gray-500">{error}</p>
      </div>
    );
  }
  if (!deal) return <p className="mt-12 text-center text-gray-400">Loading…</p>;

  const [best, ...rest] = deal.dateOptions;

  return (
    <div>
      <header className="bg-brand-pale px-4 pb-4 pt-6">
        <BackLink />
        <div className="mt-2 flex items-center gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight">
            {deal.origin} <span className="font-normal text-gray-400">⇄</span> {deal.city}
          </h1>
          <CabinBadge cabin={deal.cabin} />
        </div>
        <p className="text-sm text-gray-600">
          {deal.country} • {monthLabel(deal.travelMonth)} • {CABIN_LABELS[deal.cabin]} •{' '}
          <ScoreBadge score={deal.score} />
        </p>
      </header>

      <div className="flex flex-col gap-3 p-4">
        {best ? (
          <a
            href={best.googleFlightsUrl}
            target="_blank"
            rel="noreferrer"
            className="block rounded-2xl border border-green-200 bg-green-50 p-4 active:bg-green-100"
          >
            <div className="mb-2 flex gap-2">
              <Badge>Best</Badge>
              <Badge>Cheapest</Badge>
            </div>
            <OptionRow
              departDate={best.departDate}
              returnDate={best.returnDate}
              nights={best.nights}
              priceCents={best.priceCents}
              baselineCents={best.baselinePriceCents ?? deal.baselinePriceCents}
            />
            <p className="mt-2 text-sm font-semibold text-brand">Book on Google Flights →</p>
          </a>
        ) : (
          <p className="mt-4 text-center text-gray-500">
            No recent date options — check back after the next scan.
          </p>
        )}

        {rest.map((o) => (
          <a
            key={`${o.departDate}-${o.returnDate}`}
            href={o.googleFlightsUrl}
            target="_blank"
            rel="noreferrer"
            className="block rounded-2xl bg-white p-4 shadow-sm active:bg-gray-50"
          >
            <OptionRow
              departDate={o.departDate}
              returnDate={o.returnDate}
              nights={o.nights}
              priceCents={o.priceCents}
              baselineCents={o.baselinePriceCents ?? deal.baselinePriceCents}
            />
          </a>
        ))}

        <p className="mt-2 text-center text-xs text-gray-400">
          Prices are indicative, from recently observed fares. Tapping an option opens Google
          Flights to book.
        </p>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/" className="text-2xl leading-none text-gray-800">
      ←
    </Link>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-lg bg-green-600 px-2.5 py-0.5 text-sm font-bold text-white">
      {children}
    </span>
  );
}

function OptionRow(props: {
  departDate: string;
  returnDate: string;
  nights: number;
  priceCents: number;
  baselineCents: number;
}) {
  return (
    <div className="flex items-center justify-between">
      <span>
        <span className="font-bold">
          {shortDate(props.departDate)} – {shortDate(props.returnDate)}
        </span>
        <span className="block text-sm text-gray-500">
          Round trip • {props.nights} nights
        </span>
      </span>
      <span className="flex items-center gap-1">
        <PriceTag priceCents={props.priceCents} baselineCents={props.baselineCents} size="md" />
        <span className="text-gray-400">›</span>
      </span>
    </div>
  );
}
