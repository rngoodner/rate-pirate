import { googleFlightsUrl } from '@rate-pirate/shared';

export interface AlertContent {
  origin: string;
  destination: string;
  city: string;
  country: string;
  travelMonth: string; // 'YYYY-MM'
  priceCents: number;
  baselineCents: number;
  discountPct: number;
  score: number;
  departDate: string;
  returnDate: string;
}

export function alertSubject(a: AlertContent): string {
  return `✈ ${a.origin} → ${a.city} ${usd(a.priceCents)} (${pct(a.discountPct)} off, score ${a.score}) — ${monthLabel(a.travelMonth)}`;
}

export function alertHtml(a: AlertContent): string {
  const url = googleFlightsUrl(a.origin, a.destination, a.departDate, a.returnDate);
  return `<!doctype html>
<body style="margin:0;padding:24px;background:#f2f3f5;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
    <p style="margin:0 0 16px;font-weight:800;font-size:18px">🏴‍☠️ Rate Pirate</p>
    <p style="margin:0;font-size:22px;font-weight:800">${esc(a.city)}</p>
    <p style="margin:4px 0 12px;color:#6b7280">${esc(a.country)} • ${monthLabel(a.travelMonth)}</p>
    <p style="margin:0 0 4px">
      <span style="background:#e7f8ee;color:#16a34a;font-weight:700;border-radius:8px;padding:4px 10px;font-size:14px">
        ${a.score}% deal score
      </span>
    </p>
    <p style="margin:12px 0;font-size:26px">
      <span style="color:#9ca3af;text-decoration:line-through;font-size:18px">${usd(a.baselineCents)}</span>
      <strong> ${usd(a.priceCents)}</strong>
      <span style="color:#16a34a;font-size:15px;font-weight:700">${pct(a.discountPct)} below normal</span>
    </p>
    <p style="margin:0 0 20px;color:#374151">${a.departDate} → ${a.returnDate} • round trip</p>
    <a href="${url}"
       style="display:block;text-align:center;background:#35b6ea;color:#fff;font-weight:700;text-decoration:none;border-radius:12px;padding:14px">
      Book on Google Flights
    </a>
    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af">
      Prices are indicative, based on recently observed fares — the exact fare is confirmed at booking.
      You're getting this because the price is well below the route's recent norm.
    </p>
  </div>
</body>`;
}

function usd(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
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
