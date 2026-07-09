import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CABIN_LABELS, type Deal, type ScanStatus, type Settings } from '@rate-pirate/shared';
import { api, timeAgo, timeUntil } from '../api/client';
import { useAutoRefresh } from '../useAutoRefresh';
import DealCard from '../components/DealCard';
import StatusBanner from '../components/StatusBanner';

function cabinSummary(settings: Settings | null): string {
  const cabins = settings?.monitoredCabins ?? [];
  if (cabins.length === 0) return '…';
  if (cabins.length <= 2) return cabins.map((c) => CABIN_LABELS[c]).join(', ');
  return `${cabins.length} cabins`;
}

/** Freshness line under the title: when prices were last checked and when the
 *  next scan runs. Recomputed on every render (a 1s ticker drives it), so it
 *  counts down live. `scanning` (a batch running now) takes precedence — while
 *  it runs, lastScanAt keeps advancing to ~now, which would misread "Checked
 *  now". */
export function freshness(status: ScanStatus | null): string {
  if (!status) return '';
  if (status.scanning) return 'Checking prices…';
  if (!status.nextBatchAt) return 'Scanning paused';
  const next = `next scan ${timeUntil(status.nextBatchAt)}`;
  return status.lastScanAt ? `Checked ${timeAgo(status.lastScanAt)} · ${next}` : next;
}

export default function DealsFeed() {
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .deals()
      .then((d) => {
        setDeals(d);
        setError(null); // a later successful refresh clears a transient failure
      })
      .catch((e: Error) => setError(e.message));
    api.settings().then(setSettings).catch(() => {});
    api.status().then(setStatus).catch(() => {});
  }, []);
  useEffect(load, [load]);
  // Poll while open, too — a feed left on screen must not go stale forever.
  useAutoRefresh(load, 60_000);

  // Tick every second so the "next scan in …" countdown advances on its own,
  // independent of the network poll (and even if a poll is slow or fails).
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div>
      <header className="bg-brand-pale px-4 pb-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <h1 className="text-xl font-black tracking-tight">🏴‍☠️ Rate Pirate</h1>
        {status && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
            {status.scanning && (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" />
            )}
            {freshness(status)}
          </p>
        )}
        <Link
          to="/settings"
          className="mt-3 flex items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm active:bg-gray-50"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">
              {settings?.homeAirport ?? '…'} <span className="font-normal text-gray-400">⇄</span>{' '}
              Anywhere
            </p>
            <p className="truncate text-sm text-gray-500">
              Anytime • {cabinSummary(settings)}
            </p>
          </div>
          <span aria-hidden className="text-lg text-gray-400">
            ⚙︎
          </span>
        </Link>
      </header>

      <div className="p-4">
        <StatusBanner />
        {error && (
          <div className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}
        {deals === null && !error && <p className="mt-8 text-center text-gray-400">Loading…</p>}
        {deals?.length === 0 && (
          <p className="mt-8 text-center text-gray-500">
            No deals right now — the scanner keeps watching.
          </p>
        )}
        <div className="flex flex-col gap-3">
          {deals?.map((deal) => <DealCard key={deal.id} deal={deal} />)}
        </div>
      </div>
    </div>
  );
}
