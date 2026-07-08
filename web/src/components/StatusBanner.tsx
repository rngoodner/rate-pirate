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

  // Only surface a genuine problem: failing scans. The cold-start "N% of
  // searches have data" notice was noise (coarse, and self-resolving), so it's
  // gone. The judgment lives server-side (it needs event scopes the status JSON
  // doesn't expose).
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

  return null;
}
