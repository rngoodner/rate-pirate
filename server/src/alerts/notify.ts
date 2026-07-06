import { parseRecipients, type Settings } from '@rate-pirate/shared';
import type { Db } from '../db/db.js';
import { getDestination, lastAlertForDeal, recordAlert, type DealRow } from '../db/repo.js';
import type { EmailSender } from './email.js';
import { alertHtml, alertSubject } from './template.js';

/** Cooldown ends early only when the price drops this far below the last
 *  alerted price. The discount floor and cooldown length live in Settings
 *  (alertMinDiscount, alertCooldownDays). */
const DEEPENING_FACTOR = 0.9;

export type SkipReason =
  | 'below_threshold'
  | 'below_min_discount'
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
  const recipients = parseRecipients(settings.alertEmail);
  if (recipients.length === 0) return { sent: false, reason: 'no_recipient' };

  const last = lastAlertForDeal(db, deal.id);
  if (last) {
    const ageMs = Date.parse(asOf.replace(' ', 'T') + 'Z') - Date.parse(last.sentAt.replace(' ', 'T') + 'Z');
    const inCooldown = ageMs < settings.alertCooldownDays * 86_400_000;
    const deepened = deal.bestPriceCents <= last.priceCents * DEEPENING_FACTOR;
    if (inCooldown && !deepened) return { sent: false, reason: 'cooldown' };
  }

  const dest = getDestination(db, deal.destination);
  const content = {
    origin: deal.origin,
    destination: deal.destination,
    city: dest?.city ?? deal.destination,
    country: dest?.country ?? '',
    cabin: deal.cabin,
    travelMonth: deal.travelMonth,
    priceCents: deal.bestPriceCents,
    baselineCents: deal.baselinePriceCents,
    discountPct: deal.discountPct,
    score: deal.score,
    departDate: deal.departDate,
    returnDate: deal.returnDate,
  };

  try {
    await sender.send({
      to: recipients,
      subject: alertSubject(content),
      html: alertHtml(content),
    });
  } catch (err) {
    console.error(`alert send failed for deal ${deal.id}:`, err);
    return { sent: false, reason: 'send_failed' };
  }

  recordAlert(db, {
    dealId: deal.id,
    sentTo: recipients.join(', '),
    priceCents: deal.bestPriceCents,
    score: deal.score,
    sentAt: asOf,
  });
  return { sent: true };
}
