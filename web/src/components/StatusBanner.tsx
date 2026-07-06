import { useCallback, useEffect, useState } from 'react';
import type { ScanStatus } from '@rate-pirate/shared';
import { api } from '../api/client';
import { useAutoRefresh } from '../useAutoRefresh';

/** Cold-start / scanning-state notice above the feed. */
export default function StatusBanner() {
  const [status, setStatus] = useState<ScanStatus | null>(null);

  const load = useCallback(() => {
    api.status().then(setStatus).catch(() => {});
  }, []);
  useEffect(load, [load]);
  useAutoRefresh(load, 60_000);

  if (!status) return null;

  // Failing scans outrank the cold-start notice: ≥5 errors today AND errors
  // are a meaningful share of the day's calls (occasional transients stay quiet).
  const failing =
    status.errorsToday >= 5 && status.errorsToday >= 0.3 * Math.max(status.callsToday, 1);
  if (failing) {
    return (
      <div className="mb-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
        <strong>Scans are failing</strong> — {status.errorsToday} errors today. See Settings →
        Activity log.
      </div>
    );
  }

  if (status.baselineCoverage >= 0.9) return null;
  const pct = Math.round(status.baselineCoverage * 100);
  return (
    <div className="mb-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <strong>Building price history…</strong> {pct}% of routes have a baseline. Deals appear
      once a route has ~10 days of data.
    </div>
  );
}
