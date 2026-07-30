import {
  CABIN_LABELS,
  isAirlineHidden,
  parseRecipients,
  primaryAirline,
  type Settings,
} from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import { lastAlertForDeal, logEvent, recordAlert, type DealRow } from '../db/repo.js';
import type { EmailSender } from './email.js';
import { alertHtml, alertSubject } from './template.js';

/** Cooldown ends early only when the price drops this far below the last
 *  alerted price. The discount floor and cooldown length live in Settings
 *  (alertMinDiscount, alertCooldownDays). */
const DEEPENING_FACTOR = 0.9;

export type SkipReason =
  | 'below_threshold'
  | 'below_min_discount'
  | 'above_max_price'
  | 'airline_hidden'
  | 'no_recipient'
  | 'cooldown'
  | 'send_failed';

export interface NotifyResult {
  sent: boolean;
  reason?: SkipReason;
}

/** Decide whether `deal` warrants an email right now, and send it. */
export async function maybeAlert(
  db: Db,
  deal: DealRow,
  settings: Settings,
  sender: EmailSender,
  asOf: string,
): Promise<NotifyResult> {
  if (deal.score < settings.alertThreshold) return { sent: false, reason: 'below_threshold' };
  if (deal.discountPct < settings.alertMinDiscount)
    return { sent: false, reason: 'below_min_discount' };
  // Cap on the party-size total the user would actually pay (what the feed and
  // email show). 0 = no cap. Prices are stored at 1 adult, so scale first.
  if (
    settings.alertMaxPriceCents > 0 &&
    deal.bestPriceCents * settings.adults > settings.alertMaxPriceCents
  )
    return { sent: false, reason: 'above_max_price' };
  // Respect the per-airline filter: never email a deal on a hidden carrier.
  if (isAirlineHidden(primaryAirline(deal.carrier), settings.hiddenAirlines))
    return { sent: false, reason: 'airline_hidden' };
  const recipients = parseRecipients(settings.alertEmail);
  if (recipients.length === 0) return { sent: false, reason: 'no_recipient' };

  const last = lastAlertForDeal(db, deal.id);
  if (last) {
    const ageMs = Date.parse(asOf.replace(' ', 'T') + 'Z') - Date.parse(last.sentAt.replace(' ', 'T') + 'Z');
    const inCooldown = ageMs < settings.alertCooldownDays * 86_400_000;
    const deepened = deal.bestPriceCents <= last.priceCents * DEEPENING_FACTOR;
    if (inCooldown && !deepened) return { sent: false, reason: 'cooldown' };
  }

  // Prices are stored at 1 adult; scale to the party size for display + the
  // booking link (fares scale linearly). Score/discount are scale-invariant.
  const content = {
    origin: deal.origin,
    destination: deal.destination,
    city: deal.city || deal.destination,
    country: deal.country,
    cabin: deal.cabin,
    tripType: deal.tripType,
    adults: settings.adults,
    airline: primaryAirline(deal.carrier),
    travelMonth: deal.travelMonth,
    priceCents: deal.bestPriceCents * settings.adults,
    baselineCents: deal.baselinePriceCents * settings.adults,
    discountPct: deal.discountPct,
    score: deal.score,
    departDate: deal.departDate,
    returnDate: deal.returnDate,
    seenAt: asOf,
  };

  const summary =
    `${content.city} ${new Date(`${deal.travelMonth}-15T00:00:00Z`).toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    })} ${CABIN_LABELS[deal.cabin]} $${Math.round(content.priceCents / 100)}`;
  try {
    await sender.send({
      to: recipients,
      subject: alertSubject(content),
      html: alertHtml(content),
    });
  } catch (err) {
    console.error(`alert send failed for deal ${deal.id}:`, err);
    logEvent(db, {
      level: 'error',
      scope: 'alert',
      message: `alert send failed: ${summary} — ${err instanceof Error ? err.message : String(err)}`,
      detail: err instanceof Error ? (err.stack ?? String(err)) : String(err),
      at: asOf,
    });
    return { sent: false, reason: 'send_failed' };
  }

  recordAlert(db, {
    dealId: deal.id,
    sentTo: recipients.join(', '),
    priceCents: deal.bestPriceCents,
    score: deal.score,
    sentAt: asOf,
  });
  logEvent(db, {
    level: 'info',
    scope: 'alert',
    message: `alert emailed: ${summary} → ${recipients.join(', ')}`,
    at: asOf,
  });
  return { sent: true };
}
