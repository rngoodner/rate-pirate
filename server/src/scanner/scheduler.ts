import cron from 'node-cron';
import { lastApiCallAt, logEvent, pruneApiCalls, pruneEvents, pruneSnapshots } from '../db/repo.js';
import { runScanBatch, type ScanDeps } from './scan.js';

const TIMEZONE = 'America/Denver';
/** Four batches spread over the waking day. */
const BATCH_CRON = '10 6,11,17,22 * * *';
const BATCH_HOURS_LOCAL = [6, 11, 17, 22];

/** Wall-clock parts of `instant` in TIMEZONE, machine-timezone independent. */
function tzParts(instant: Date): { y: number; mo: number; d: number; h: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour') % 24, min: get('minute') };
}

/** UTC instant of the next scheduled batch (BATCH_CRON, local timezone). */
export function nextBatchAt(now: Date = new Date()): Date {
  const { y, mo, d, h, min } = tzParts(now);
  const todayHour = BATCH_HOURS_LOCAL.find((bh) => bh > h || (bh === h && min < 10));
  const target =
    todayHour !== undefined ? { d, hour: todayHour } : { d: d + 1, hour: BATCH_HOURS_LOCAL[0]! };
  // Wall time → UTC via the zone offset at a nearby instant (batch hours sit
  // far from DST transitions, so one pass is exact; Date.UTC normalizes d+1
  // across month ends).
  const wallAsUtc = Date.UTC(y, mo - 1, target.d, target.hour, 10);
  const p = tzParts(new Date(wallAsUtc));
  const offsetMs = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.min) - wallAsUtc;
  return new Date(wallAsUtc - offsetMs);
}
const PRUNE_CRON = '15 3 * * *';
const CATCHUP_AFTER_HOURS = 12;

export function startScheduler(deps: ScanDeps): void {
  cron.schedule(BATCH_CRON, () => void runBatchLogged(deps), { timezone: TIMEZONE });

  cron.schedule(
    PRUNE_CRON,
    () => {
      const snaps = pruneSnapshots(deps.db, 180);
      const calls = pruneApiCalls(deps.db, 60);
      const events = pruneEvents(deps.db, 30);
      if (snaps || calls || events)
        console.log(`pruned ${snaps} snapshots, ${calls} api_calls, ${events} events`);
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
    logEvent(deps.db, {
      level: 'error',
      scope: 'batch',
      message: `batch crashed: ${err instanceof Error ? err.message : String(err)}`,
      detail: err instanceof Error ? (err.stack ?? String(err)) : String(err),
    });
  }
}
