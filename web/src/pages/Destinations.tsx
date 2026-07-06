import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Destination } from '@rate-pirate/shared';
import { api } from '../api/client';
import { useAutoRefresh } from '../useAutoRefresh';

const TIER_LABEL: Record<number, string> = { 1: 'favorite', 2: 'regular', 3: 'long-tail' };

export default function Destinations() {
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api.destinations().then(setDestinations).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useAutoRefresh(load);

  async function toggle(d: Destination) {
    // Optimistic — the list is long and a round-trip per tap feels laggy.
    setDestinations(
      (prev) =>
        prev?.map((x) => (x.iata === d.iata ? { ...x, active: !d.active } : x)) ?? prev,
    );
    try {
      await api.setDestinationActive(d.iata, !d.active);
      setNotice(null);
    } catch (e) {
      setDestinations((prev) =>
        prev?.map((x) => (x.iata === d.iata ? { ...x, active: d.active } : x)) ?? prev,
      );
      setNotice((e as Error).message);
    }
  }

  const shown = useMemo(() => {
    if (!destinations) return null;
    const q = query.trim().toLowerCase();
    if (!q) return destinations;
    return destinations.filter(
      (d) =>
        d.city.toLowerCase().includes(q) ||
        d.country.toLowerCase().includes(q) ||
        d.iata.toLowerCase().includes(q),
    );
  }, [destinations, query]);

  const activeCount = destinations?.filter((d) => d.active).length ?? 0;

  return (
    <div>
      <header className="bg-brand-pale px-4 pb-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <Link to="/settings" aria-label="Back to settings" className="-m-2 p-2 text-2xl leading-none text-gray-800">
          ←
        </Link>
        <h1 className="mt-2 text-xl font-black tracking-tight">Destinations</h1>
        <p className="text-sm text-gray-600">
          {destinations ? `${activeCount} of ${destinations.length} scanned` : '…'} — fewer
          destinations = each one checked more often.
        </p>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <input
          className="rounded-2xl bg-white px-4 py-3 shadow-sm outline-none focus:ring-2 focus:ring-brand"
          type="search"
          placeholder="Search city, country, or code"
          aria-label="Search destinations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <p className="px-1 text-xs text-gray-400">
          The tag on each row sets how often it’s scanned: <b>favorite</b> most often, then{' '}
          <b>regular</b>, then <b>long-tail</b>.
        </p>

        {notice && <p className="text-center text-sm text-red-600">{notice}</p>}
        {shown === null && <p className="mt-8 text-center text-gray-400">Loading…</p>}
        {shown?.length === 0 && (
          <p className="mt-8 text-center text-gray-500">No matches for “{query}”.</p>
        )}

        <ul className="overflow-hidden rounded-2xl bg-white shadow-sm">
          {shown?.map((d) => (
            <li key={d.iata} className="border-b border-gray-50 last:border-b-0">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className={`font-semibold ${d.active ? '' : 'text-gray-400'}`}>
                    {d.city} <span className="font-normal text-gray-400">{d.iata}</span>
                  </span>
                  <span className="block text-xs text-gray-500">
                    {d.country} • {TIER_LABEL[d.tier] ?? `tier ${d.tier}`}
                  </span>
                </span>
                <input
                  type="checkbox"
                  aria-label={`Scan ${d.city}`}
                  className="h-6 w-11 shrink-0 appearance-none rounded-full bg-gray-300 transition-colors checked:bg-brand
                             before:block before:h-6 before:w-6 before:scale-90 before:rounded-full before:bg-white
                             before:transition-transform checked:before:translate-x-5"
                  checked={d.active}
                  onChange={() => toggle(d)}
                />
              </label>
            </li>
          ))}
        </ul>

        <p className="text-center text-xs text-gray-400">
          Deactivating stops future scans and removes its deals; price history is kept.
        </p>
      </div>
    </div>
  );
}
