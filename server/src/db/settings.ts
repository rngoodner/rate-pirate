import {
  CABINS,
  isCabin,
  isTripType,
  TRIP_TYPES,
  type Cabin,
  type Settings,
  type TripType,
} from '@rate-pirate/shared';
import type { Config } from '../config.js';
import type { Db } from './db.js';

const DEFAULT_CABINS: Cabin[] = ['economy', 'premium_economy'];
const DEFAULT_TRIP_TYPES: TripType[] = ['one_week'];

/** Precedence: DB value → env-derived default → hardcoded default. */
export function getSettings(db: Db, config: Config): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return {
    homeAirport: stored.get('home_airport') ?? 'ABQ',
    alertEmail: stored.get('alert_email') ?? config.ALERT_EMAIL_TO ?? '',
    alertThreshold: intOr(stored.get('alert_threshold'), 85),
    // Modest default: with google-flights each call is a headless page load
    dailyCallBudget: intOr(stored.get('daily_call_budget'), 100),
    scanEnabled: (stored.get('scan_enabled') ?? 'true') === 'true',
    monitoredCabins: parseCabins(stored.get('monitored_cabins')),
    alertMinDiscount: floatOr(stored.get('alert_min_discount'), 0.2),
    dealMinDiscount: floatOr(stored.get('deal_min_discount'), 0.05),
    alertCooldownDays: intOr(stored.get('alert_cooldown_days'), 7),
    tripTypes: parseTripTypes(stored.get('trip_types')),
    adults: intOr(stored.get('adults'), 1),
  };
}

/** Parse the stored CSV; fall back to the default if empty/invalid. Order
 *  follows CABINS so the UI and scans are deterministic. */
function parseCabins(csv: string | undefined): Cabin[] {
  if (!csv) return [...DEFAULT_CABINS];
  const chosen = new Set(csv.split(',').map((s) => s.trim()).filter(isCabin));
  const ordered = CABINS.filter((c) => chosen.has(c));
  return ordered.length > 0 ? ordered : [...DEFAULT_CABINS];
}

/** Parse the stored CSV; fall back to the default if empty/invalid. Order
 *  follows TRIP_TYPES so the UI and scans are deterministic. */
function parseTripTypes(csv: string | undefined): TripType[] {
  if (!csv) return [...DEFAULT_TRIP_TYPES];
  const chosen = new Set(csv.split(',').map((s) => s.trim()).filter(isTripType));
  const ordered = TRIP_TYPES.filter((t) => chosen.has(t));
  return ordered.length > 0 ? ordered : [...DEFAULT_TRIP_TYPES];
}

export function updateSettings(db: Db, patch: Partial<Settings>): void {
  const kv: Record<string, string | undefined> = {
    home_airport: patch.homeAirport?.toUpperCase(),
    alert_email: patch.alertEmail,
    alert_threshold: patch.alertThreshold?.toString(),
    daily_call_budget: patch.dailyCallBudget?.toString(),
    scan_enabled: patch.scanEnabled === undefined ? undefined : String(patch.scanEnabled),
    monitored_cabins: patch.monitoredCabins
      ? CABINS.filter((c) => patch.monitoredCabins!.includes(c)).join(',')
      : undefined,
    alert_min_discount: patch.alertMinDiscount?.toString(),
    deal_min_discount: patch.dealMinDiscount?.toString(),
    alert_cooldown_days: patch.alertCooldownDays?.toString(),
    trip_types: patch.tripTypes
      ? TRIP_TYPES.filter((t) => patch.tripTypes!.includes(t)).join(',')
      : undefined,
    adults: patch.adults?.toString(),
  };
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(kv)) {
      if (value !== undefined) upsert.run(key, value);
    }
  });
  tx();
}

function intOr(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatOr(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}
