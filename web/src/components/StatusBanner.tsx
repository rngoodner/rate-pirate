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

  // Failing scans outrank the cold-start notice. The judgment lives server-side
  // (it needs event scopes the status JSON doesn't expose).
  if (status.scansBroken) {
    return (
      <div className="mb-3 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800">
        <strong>Scans are failing</strong>
        {status.errorsToday > 0 &&
          ` — ${status.errorsToday} error${status.errorsToday === 1 ? '' : 's'} today`}
        . See Settings → Activity log.
      </div>
    );
  }

  if (status.baselineCoverage >= 0.9) return null;
  const pct = Math.round(status.baselineCoverage * 100);
  return (
    <div className="mb-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <strong>Building price history…</strong> {pct}% of routes have a full baseline. Early
      deals use Google’s price history (marked “est.”) while ours builds.
    </div>
  );
}
