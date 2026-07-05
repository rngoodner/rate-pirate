import { useEffect, useState } from 'react';
import type { ScanStatus } from '@rate-pirate/shared';
import { api } from '../api/client';

/** Cold-start / scanning-state notice above the feed. */
export default function StatusBanner() {
  const [status, setStatus] = useState<ScanStatus | null>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(() => {});
  }, []);

  if (!status || status.baselineCoverage >= 0.9) return null;

  const pct = Math.round(status.baselineCoverage * 100);
  return (
    <div className="mb-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <strong>Building price history…</strong> {pct}% of routes have a baseline. Deals appear
      once a route has ~10 days of data.
    </div>
  );
}
