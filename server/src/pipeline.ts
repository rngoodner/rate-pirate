import type { Config } from './config.js';
import type { Db } from './db/db.js';
import { getSettings } from './db/settings.js';
import { processRouteMonth } from './deals/detect.js';
import { maybeAlert } from './alerts/notify.js';
import type { EmailSender } from './alerts/email.js';
import type { ScanDeps } from './scanner/scan.js';
import { sqliteStamp } from './scanner/scan.js';

/** Glue: after each scanned route-month, run deal detection and maybe email. */
export function createOnQuotes(
  db: Db,
  config: Config,
  sender: EmailSender,
  source: string,
  now: () => Date = () => new Date(),
): NonNullable<ScanDeps['onQuotes']> {
  return async (task) => {
    const settings = getSettings(db, config);
    const asOf = sqliteStamp(now());
    const deal = processRouteMonth(
      db,
      {
        source,
        origin: settings.homeAirport,
        destination: task.destination,
        cabin: task.cabin,
        month: task.month,
      },
      asOf,
      { minDiscount: settings.dealMinDiscount },
    );
    if (deal) await maybeAlert(db, deal, settings, sender, asOf);
  };
}
