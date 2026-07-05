import cron from 'node-cron';
import { lastApiCallAt, pruneApiCalls, pruneSnapshots } from '../db/repo.js';
import { runScanBatch, type ScanDeps } from './scan.js';

const TIMEZONE = 'America/Denver';
/** Four batches spread over the waking day. */
const BATCH_CRON = '10 6,11,17,22 * * *';
const PRUNE_CRON = '15 3 * * *';
const CATCHUP_AFTER_HOURS = 12;

export function startScheduler(deps: ScanDeps): void {
  cron.schedule(BATCH_CRON, () => void runBatchLogged(deps), { timezone: TIMEZONE });

  cron.schedule(
    PRUNE_CRON,
    () => {
      const snaps = pruneSnapshots(deps.db, 180);
      const calls = pruneApiCalls(deps.db, 60);
      if (snaps || calls) console.log(`pruned ${snaps} snapshots, ${calls} api_calls`);
    },
    { timezone: TIMEZONE },
  );

  // Catch-up: if the process was down across scheduled batches, scan shortly after boot.
  const last = lastApiCallAt(deps.db, deps.provider.name);
  const staleMs = last ? Date.now() - Date.parse(last.replace(' ', 'T') + 'Z') : Infinity;
  if (staleMs > CATCHUP_AFTER_HOURS * 3_600_000) {
    console.log('scanner catch-up: no recent scan, running a batch in 10s');
    setTimeout(() => void runBatchLogged(deps), 10_000);
  }
}

async function runBatchLogged(deps: ScanDeps): Promise<void> {
  try {
    const result = await runScanBatch(deps);
    console.log(
      `scan batch: planned=${result.planned} scanned=${result.scanned} ` +
        `snapshots=${result.snapshots} failures=${result.failures}` +
        (result.skippedReason ? ` skipped=${result.skippedReason}` : ''),
    );
  } catch (err) {
    console.error('scan batch crashed:', err);
  }
}
