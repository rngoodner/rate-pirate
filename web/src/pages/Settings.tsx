import { useEffect, useState } from 'react';
import {
  CABINS,
  CABIN_LABELS,
  type Cabin,
  type ScanStatus,
  type Settings as SettingsType,
} from '@rate-pirate/shared';
import { api } from '../api/client';
import { CABIN_CHIP_SELECTED_CLASS } from '../cabinStyle';
import EmailRecipients from '../components/EmailRecipients';

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    api.status().then(setStatus).catch(() => {});
  }, []);

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
            Higher = fewer, better deals. Emails also require the price to be ≥20% below normal.
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

        <button
          className="rounded-2xl bg-brand py-3.5 font-bold text-white active:opacity-80"
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
