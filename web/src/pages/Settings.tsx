import { useCallback, useEffect, useState } from 'react';
import {
  CABINS,
  CABIN_LABELS,
  type AppEvent,
  type Cabin,
  type ScanStatus,
  type Settings as SettingsType,
} from '@rate-pirate/shared';
import { api, timeAgo } from '../api/client';
import { useAutoRefresh } from '../useAutoRefresh';
import { CABIN_CHIP_SELECTED_CLASS } from '../cabinStyle';
import EmailRecipients from '../components/EmailRecipients';

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    api.status().then(setStatus).catch(() => {});
    api.events().then(setEvents).catch(() => {});
  }, []);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    loadStatus();
  }, [loadStatus]);
  // Keep the status panel live (scan progress), but never re-pull settings on a
  // timer — the settings state doubles as form state and a poll could clobber
  // an in-flight edit.
  useAutoRefresh(loadStatus, 60_000);

  async function save(patch: Partial<SettingsType>) {
    try {
      setSettings(await api.updateSettings(patch));
      setNotice('Saved');
      setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      setNotice((e as Error).message);
    }
  }

  function toggleCabin(cabin: Cabin) {
    if (!settings) return;
    const has = settings.monitoredCabins.includes(cabin);
    const next = has
      ? settings.monitoredCabins.filter((c) => c !== cabin)
      : CABINS.filter((c) => c === cabin || settings.monitoredCabins.includes(c));
    if (next.length === 0) {
      setNotice('Keep at least one cabin selected');
      setTimeout(() => setNotice(null), 1500);
      return;
    }
    save({ monitoredCabins: next });
  }

  if (!settings) return <p className="mt-12 text-center text-gray-400">Loading…</p>;

  return (
    <div>
      <header className="bg-brand-pale px-4 pb-4 pt-6">
        <h1 className="text-xl font-black tracking-tight">Settings</h1>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <Field label="Home airport">
          <input
            className="w-full bg-transparent text-lg font-bold outline-none"
            defaultValue={settings.homeAirport}
            maxLength={3}
            onBlur={(e) => {
              const v = e.target.value.trim().toUpperCase();
              if (/^[A-Z]{3}$/.test(v) && v !== settings.homeAirport) save({ homeAirport: v });
            }}
          />
        </Field>

        <Field label="Alert recipients">
          <EmailRecipients
            value={settings.alertEmail}
            onChange={(emails) => save({ alertEmail: emails.join(', ') })}
          />
          <button
            type="button"
            className="mt-3 w-full rounded-xl border border-brand py-2 text-sm font-semibold text-brand active:bg-brand-pale"
            onClick={async () => {
              try {
                const r = await api.testEmail();
                setNotice(`Test email sent via ${r.via} to ${r.to}`);
              } catch (e) {
                setNotice((e as Error).message);
              }
            }}
          >
            Send test email
          </button>
        </Field>

        <Field label={`Alert threshold — score ${settings.alertThreshold}+`}>
          <input
            className="w-full accent-brand"
            type="range"
            min={50}
            max={100}
            value={settings.alertThreshold}
            onChange={(e) =>
              setSettings({ ...settings, alertThreshold: Number(e.target.value) })
            }
            onPointerUp={() => save({ alertThreshold: settings.alertThreshold })}
            onKeyUp={() => save({ alertThreshold: settings.alertThreshold })}
          />
          <p className="text-xs text-gray-500">
            Higher = fewer, better deals. Emails also require the price to be ≥
            {Math.round(settings.alertMinDiscount * 100)}% below normal (set under Advanced).
          </p>
        </Field>

        <Field label="Cabins to monitor">
          <div className="flex flex-wrap gap-2">
            {CABINS.map((cabin) => {
              const selected = settings.monitoredCabins.includes(cabin);
              return (
                <button
                  key={cabin}
                  type="button"
                  aria-pressed={selected}
                  className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${
                    selected
                      ? CABIN_CHIP_SELECTED_CLASS[cabin]
                      : 'border-gray-300 bg-white text-gray-600'
                  }`}
                  onClick={() => toggleCabin(cabin)}
                >
                  {CABIN_LABELS[cabin]}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-gray-500">
            Each cabin is scanned separately, so monitoring more cabins means each one refreshes
            less often. At least one is required.
          </p>
        </Field>

        <Field label="Scanning">
          <label className="flex items-center justify-between">
            <span className="text-lg font-bold">{settings.scanEnabled ? 'On' : 'Off'}</span>
            <input
              type="checkbox"
              className="h-6 w-11 appearance-none rounded-full bg-gray-300 transition-colors checked:bg-brand
                         before:block before:h-6 before:w-6 before:scale-90 before:rounded-full before:bg-white
                         before:transition-transform checked:before:translate-x-5"
              checked={settings.scanEnabled}
              onChange={(e) => save({ scanEnabled: e.target.checked })}
            />
          </label>
          <p className="mt-2 text-xs text-gray-500">
            When on, Rate Pirate checks flight prices on a schedule and emails you when a great
            deal appears. Turn off to pause all price checks and alerts without losing your saved
            price history.
          </p>
        </Field>

        {status && (
          <div className="rounded-2xl bg-white p-4 text-sm text-gray-600 shadow-sm">
            <p className="mb-1 font-bold text-gray-900">Status</p>
            <p>Provider: {status.provider}</p>
            <p>Last scan: {status.lastScanAt ?? 'never'}</p>
            <p>
              Calls today: {status.callsToday} / {status.dailyCallBudget}
            </p>
            <p>Baseline coverage: {Math.round(status.baselineCoverage * 100)}%</p>
            <p>Active deals: {status.activeDeals}</p>
          </div>
        )}

        <ActivityLog events={events} />

        <Advanced settings={settings} setSettings={setSettings} save={save} />

        {notice && <p className="text-center text-sm text-gray-500">{notice}</p>}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="mb-1 text-sm text-gray-500">{label}</p>
      {children}
    </div>
  );
}

/** Collapsed-by-default log of recent scanner/alert activity and errors —
 *  the first stop when something looks wrong, before reaching for ssh. */
function ActivityLog({ events }: { events: AppEvent[] }) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const errorCount = events.filter((e) => e.level === 'error').length;

  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between p-4"
        onClick={() => setOpen(!open)}
      >
        <span className="flex items-center gap-2 font-bold">
          Activity log
          {errorCount > 0 && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-700">
              {errorCount} {errorCount === 1 ? 'error' : 'errors'}
            </span>
          )}
        </span>
        <span
          aria-hidden
          className={`text-lg text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ›
        </span>
      </button>

      {open && (
        <ul className="border-t border-gray-100 px-4 py-2">
          {events.length === 0 && (
            <li className="py-2 text-sm text-gray-400">Nothing logged yet.</li>
          )}
          {events.map((e) => (
            <li key={e.id} className="border-b border-gray-50 py-2 last:border-b-0">
              <button
                type="button"
                className="w-full text-left"
                onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
              >
                <span className="flex items-baseline gap-2">
                  <span className="shrink-0 text-xs text-gray-400">{timeAgo(e.createdAt)}</span>
                  <span
                    className={`shrink-0 rounded px-1.5 text-xs font-semibold ${
                      e.level === 'error' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {e.scope}
                  </span>
                </span>
                <span
                  className={`mt-0.5 block text-sm ${
                    e.level === 'error' ? 'text-red-700' : 'text-gray-700'
                  }`}
                >
                  {e.message}
                </span>
              </button>
              {expandedId === e.id && e.detail && (
                <pre className="mt-1 overflow-x-auto rounded-lg bg-gray-50 p-2 text-xs text-gray-500">
                  {e.detail}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Collapsed-by-default disclosure for tunables most users never touch.
 *  Defaults match the server's built-ins, so nothing here needs changing
 *  for normal operation. */
function Advanced({
  settings,
  setSettings,
  save,
}: {
  settings: SettingsType;
  setSettings: (s: SettingsType) => void;
  save: (patch: Partial<SettingsType>) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between p-4"
        onClick={() => setOpen(!open)}
      >
        <span className="font-bold">Advanced</span>
        <span
          aria-hidden
          className={`text-lg text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          ›
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-4 border-t border-gray-100 p-4">
          <AdvField
            label="Daily call budget"
            hint="One call = one Google Flights page load. Rule of thumb: at least (destinations × horizon months × cabins) ÷ 5, so every route gets enough captures to form a baseline. Stay under ~500/day to keep scraping friendly."
          >
            <NumberInput
              value={settings.dailyCallBudget}
              min={4}
              max={5000}
              onCommit={(n) => save({ dailyCallBudget: n })}
            />
          </AdvField>

          <AdvField
            label={`Alert minimum discount — ${Math.round(settings.alertMinDiscount * 100)}%`}
            hint={`Emails require BOTH a score of at least ${settings.alertThreshold} (the alert threshold above) AND a discount this far below the baseline.`}
          >
            <input
              className="w-full accent-brand"
              type="range"
              min={5}
              max={50}
              value={Math.round(settings.alertMinDiscount * 100)}
              onChange={(e) =>
                setSettings({ ...settings, alertMinDiscount: Number(e.target.value) / 100 })
              }
              onPointerUp={() => save({ alertMinDiscount: settings.alertMinDiscount })}
              onKeyUp={() => save({ alertMinDiscount: settings.alertMinDiscount })}
            />
          </AdvField>

          <AdvField
            label="Re-alert cooldown (days)"
            hint="Days before the same route-month can alert again. A drop ≥10% below the last alerted price re-alerts sooner."
          >
            <NumberInput
              value={settings.alertCooldownDays}
              min={1}
              max={30}
              onCommit={(n) => save({ alertCooldownDays: n })}
            />
          </AdvField>

          <AdvField
            label="Scan horizon (months)"
            hint="How many months ahead to watch. A longer horizon finds deals further out but grows the scan universe, so each route refreshes less often at the same budget."
          >
            <NumberInput
              value={settings.scanHorizonMonths}
              min={2}
              max={9}
              onCommit={(n) => save({ scanHorizonMonths: n })}
            />
          </AdvField>
        </div>
      )}
    </div>
  );
}

function AdvField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1 text-sm text-gray-500">{label}</p>
      {children}
      <p className="mt-1 text-xs text-gray-400">{hint}</p>
    </div>
  );
}

/** Commit-on-blur integer input; clamps to [min, max] and snaps the field
 *  back to the clamped value so what you see is what was saved. */
function NumberInput({
  value,
  min,
  max,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
}) {
  return (
    <input
      className="w-full bg-transparent text-lg font-bold outline-none"
      type="number"
      inputMode="numeric"
      defaultValue={value}
      min={min}
      max={max}
      onBlur={(e) => {
        const n = Math.round(Number(e.target.value));
        if (!Number.isFinite(n)) {
          e.target.value = String(value);
          return;
        }
        const clamped = Math.min(max, Math.max(min, n));
        e.target.value = String(clamped);
        if (clamped !== value) onCommit(clamped);
      }}
    />
  );
}
