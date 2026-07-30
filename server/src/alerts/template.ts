import {
  CABIN_LABELS,
  googleFlightsUrl,
  scoreHeatColors,
  TRIP_TYPE_LABELS,
  type Cabin,
  type TripType,
} from '@rate-pirate/shared';

export interface AlertContent {
  origin: string;
  destination: string;
  city: string;
  country: string;
  cabin: Cabin;
  tripType: TripType;
  adults: number;
  /** Primary marketing airline of the fare (e.g. 'United'); null when unknown. */
  airline: string | null;
  travelMonth: string; // 'YYYY-MM'
  priceCents: number;
  baselineCents: number;
  discountPct: number;
  score: number;
  departDate: string;
  returnDate: string;
  /** When the fare was observed — SQLite UTC stamp 'YYYY-MM-DD HH:MM:SS'. */
  seenAt: string;
}

export function alertSubject(a: AlertContent): string {
  const cabin = a.cabin === 'economy' ? '' : ` ${CABIN_LABELS[a.cabin]}`;
  const airline = a.airline ? ` on ${a.airline}` : '';
  const saved = usd(a.baselineCents - a.priceCents);
  return `✈ ${a.origin} → ${a.city}${cabin} ${usd(a.priceCents)}${airline} for ${partyLabel(a.adults)} — save ${saved} (score ${a.score}) — ${TRIP_TYPE_LABELS[a.tripType]}, ${monthLabel(a.travelMonth)}`;
}

export function alertHtml(a: AlertContent): string {
  const url = googleFlightsUrl(a.origin, a.destination, a.departDate, a.returnDate, a.cabin, a.adults);
  const scoreColors = scoreHeatColors(a.score);
  return `<!doctype html>
<body style="margin:0;padding:24px;background:#f2f3f5;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
    <p style="margin:0 0 16px;font-weight:800;font-size:18px">🏴‍☠️ Rate Pirate</p>
    <p style="margin:0;font-size:22px;font-weight:800">${esc(a.city)}</p>
    <p style="margin:4px 0 12px;color:#6b7280">${esc(a.country)} • ${TRIP_TYPE_LABELS[a.tripType]} • ${monthLabel(a.travelMonth)} • ${CABIN_LABELS[a.cabin]}${a.airline ? ` • ${esc(a.airline)}` : ''}</p>
    <p style="margin:0 0 4px">
      <span style="background:${scoreColors.background};color:${scoreColors.text};font-weight:700;border-radius:8px;padding:4px 10px;font-size:14px">
        ${a.score}% deal score
      </span>
    </p>
    <p style="margin:12px 0 0;color:#6b7280;font-size:13px;font-weight:700">👤 ${a.adults}</p>
    <p style="margin:2px 0 2px;font-size:26px">
      <span style="color:#9ca3af;text-decoration:line-through;font-size:18px">${usd(a.baselineCents)}</span>
      <strong> ${usd(a.priceCents)}</strong>
    </p>
    <p style="margin:0 0 12px;color:#16a34a;font-size:16px;font-weight:700">
      You save ${usd(a.baselineCents - a.priceCents)} vs the route's typical fare
    </p>
    <p style="margin:0 0 20px;color:#374151">${a.departDate} → ${a.returnDate} • round trip${a.airline ? ` • ${esc(a.airline)}` : ''}</p>
    <a href="${url}"
       style="display:block;text-align:center;background:#35b6ea;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;padding:14px">
      Book on Google Flights
    </a>
    <p style="margin:20px 0 8px;font-size:13px;color:#374151">
      Spotted at ${seenAtLabel(a.seenAt)}. Great fares — especially in premium cabins — can
      move within hours, so book fast. If it's already gone, at least you've seen what's possible.
    </p>
    <p style="margin:0;font-size:12px;color:#9ca3af">
      Prices are indicative, based on recently observed fares — the exact fare is confirmed at booking.
      You're getting this because the price is well below the route's recent norm.
    </p>
  </div>
</body>`;
}

function usd(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

/** How many travelers the quoted price covers (fares are quoted per party). */
function partyLabel(adults: number): string {
  return `${adults} ${adults === 1 ? 'adult' : 'adults'}`;
}

/** Friendly local time for a SQLite UTC stamp, e.g. "Jul 6, 5:16 PM MDT". */
function seenAtLabel(sqliteUtc: string): string {
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: 'America/Denver',
  });
}

function monthLabel(month: string): string {
  return new Date(`${month}-15T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
