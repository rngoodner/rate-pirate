import type { AppEvent, Deal, DealDetail, ScanStatus, Settings } from '@rate-pirate/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  deals: () => request<Deal[]>('/api/deals'),
  deal: (id: number | string) => request<DealDetail>(`/api/deals/${id}`),
  settings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  status: () => request<ScanStatus>('/api/status'),
  events: () => request<AppEvent[]>('/api/events'),
  testEmail: () =>
    request<{ sent: boolean; via: string; to: string }>('/api/test-email', { method: 'POST' }),
};

export function usd(cents: number): string {
  return `$${Math.round(cents / 100)}`;
}

export function monthLabel(month: string): string {
  return new Date(`${month}-15T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** "5m ago" / "3h ago" / "Jul 4 21:10" for a SQLite UTC timestamp. */
export function timeAgo(sqliteUtc: string): string {
  const t = Date.parse(sqliteUtc.replace(' ', 'T') + 'Z');
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ago`;
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
