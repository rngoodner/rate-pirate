import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CABINS,
  CABIN_LABELS,
  type AppEvent,
  type Cabin,
  type ScanStatus,
  type Settings as SettingsType,
} from '@rate-pirate/shared';
import { api, timeAgo, timeUntil } from '../api/client';
import { useAutoRefresh } from '../useAutoRefresh';
import { CABIN_CHIP_SELECTED_CLASS } from '../cabinStyle';
import EmailRecipients from '../components/EmailRecipients';

// Shared so every card's title and helper text look identical.
const CARD_TITLE = 'text-base font-bold text-gray-900';
const CARD_DESC = 'text-xs text-gray-500';

export default function Settings() {
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [destCounts, setDestCounts] = useState<{ active: number; total: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatus = useCallback(() => {
    api.status().then(setStatus).catch(() => {});
    api.events().then(setEvents).catch(() => {});
    api
      .destinations()
      .then((d) => setDestCounts({ active: d.filter((x) => x.active).length, total: d.length }))
      .catch(() => {});
  }, []);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
    loadStatus();
  }, [loadStatus]);
  // Keep the status panel live (scan progress), but never re-pull settings on a
  // timer — the settings state doubles as form state and a poll could clobber
  // an in-flight edit.
  useAutoRefresh(loadStatus, 60_000);

  // An earlier "Saved" flash's clear-timer must not wipe a later message.
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function flashNotice(text: string, sticky = false) {
    clearTimeout(noticeTimer.current);
    setNotice(text);
    if (!sticky) noticeTimer.current = setTimeout(() => setNotice(null), 1500);
  }

  // Sequence saves so an out-of-order PUT response can't clobber newer local
  // state (e.g. a response landing mid-slider-drag snapping the thumb back).
  const saveSeq = useRef(0);
  async function save(patch: Partial<SettingsType>) {
    const seq = ++saveSeq.current;
    try {
      const result = await api.updateSettings(patch);
      if (seq === saveSeq.current) setSettings(result);
      flashNotice('Saved');
    } catch (e) {
      flashNotice((e as Error).message, true);
      // The optimistic local value was rejected — re-sync with the server so
      // the form doesn't keep displaying a value that was never accepted.
      if (seq === saveSeq.current) api.settings().then(setSettings).catch(() => {});
    }
  }

  function toggleCabin(cabin: Cabin) {
    if (!settings) return;
    const has = settings.monitoredCabins.includes(cabin);
    const next = has
      ? settings.monitoredCabins.filter((c) => c !== cabin)
      : CABINS.filter((c) => c === cabin || settings.monitoredCabins.includes(c));
    if (next.length === 0) {
      flashNotice('Keep at least one cabin selected');
      return;
    }
    // Optimistic: a second quick tap must see the first one applied, or the
    // two PUTs (each carrying the full cabin array) would drop one change.
    setSettings({ ...settings, monitoredCabins: next });
    save({ monitoredCabins: next });
  }

  if (!settings) return <p className="mt-12 text-center text-gray-400">Loading…</p>;

  return (
    <div>
      <header className="bg-brand-pale px-4 pb-4 pt-[max(1.5rem,env(safe-area-inset-top))]">
        <h1 className="text-xl font-black tracking-tight">Settings</h1>
      </header>

      <div className="flex flex-col gap-3 p-4">
        <Field label="Home airport">
          <input
            className="w-full bg-transparent text-lg font-bold outline-none"
            aria-label="Home airport IATA code"
            defaultValue={settings.homeAirport}
            maxLength={3}
            onBlur={(e) => {
              const v = e.target.value.trim().toUpperCase();
              if (/^[A-Z]{3}$/.test(v) && v !== settings.homeAirport) save({ homeAirport: v });
            }}
          />
        </Field>

        <Link
          to="/settings/destinations"
          className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm active:bg-gray-50"
        >
          <span>
            <span className={`block ${CARD_TITLE}`}>Destinations</span>
            <span className={CARD_DESC}>
              {destCounts ? `${destCounts.active} of ${destCounts.total} scanned` : '…'}
            </span>
          </span>
          <span aria-hidden className="text-lg text-gray-400">
            ›
          </span>
        </Link>

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
          <p className={`mt-2 ${CARD_DESC}`}>
            Each cabin is scanned separately, so monitoring more cabins means each one refreshes
            less often. At least one is required.
          </p>
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
                flashNotice(`Test email sent via ${r.via} to ${r.to}`, true);
              } catch (e) {
                flashNotice((e as Error).message, true);
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
            aria-label="Alert threshold score"
            min={50}
            max={100}
            value={settings.alertThreshold}
            onChange={(e) =>
              setSettings({ ...settings, alertThreshold: Number(e.target.value) })
            }
            onPointerUp={() => save({ alertThreshold: settings.alertThreshold })}
            onBlur={() => save({ alertThreshold: settings.alertThreshold })}
          />
          <p className={`mt-2 ${CARD_DESC}`}>
            The 0–100 score blends how rare a price is for the route with how far below typical
            it sits. 85 ≈ top-10% prices, a few emails a month; 95+ = only exceptional fares.
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
          <p className={`mt-2 ${CARD_DESC}`}>
            Checks prices 4× a day and emails when a deal scores above your threshold and is ≥
            {Math.round(settings.alertMinDiscount * 100)}% below normal (set under Advanced).
            Turning off pauses checks and alerts; price history is kept.
          </p>
        </Field>

        {status && (
          <div className="rounded-2xl bg-white p-4 text-sm text-gray-600 shadow-sm">
            <p className={`mb-1.5 ${CARD_TITLE}`}>Status</p>
            <p>Provider: {status.provider}</p>
            <p>Last scan: {status.lastScanAt ? timeAgo(status.lastScanAt) : 'never'}</p>
            <p>Next scan: {status.nextBatchAt ? timeUntil(status.nextBatchAt) : 'paused'}</p>
            <p>
              Calls today: {status.callsToday} / {status.dailyCallBudget}
            </p>
            <p>Baseline coverage: {Math.round(status.baselineCoverage * 100)}%</p>
            <p>Active deals: {status.activeDeals}</p>
          </div>
        )}

        <ActivityLog events={events} onCleared={loadStatus} notify={flashNotice} />

        <Advanced
          settings={settings}
          setSettings={setSettings}
          save={save}
          notify={flashNotice}
          onScanDone={loadStatus}
        />

        {notice && (
          <p aria-live="polite" className="text-center text-sm text-gray-500">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className={`mb-1.5 ${CARD_TITLE}`}>{label}</p>
      {children}
    </div>
  );
}

/** Collapsed-by-default log of recent scanner/alert activity and errors —
 *  the first stop when something looks wrong, before reaching for ssh. */
function ActivityLog({
  events,
  onCleared,
  notify,
}: {
  events: AppEvent[];
  onCleared: () => void;
  notify: (text: string, sticky?: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const errorCount = events.filter((e) => e.level === 'error').length;

  async function clearLog() {
    try {
      await api.clearEvents();
      notify('Activity log cleared');
      onCleared(); // refetch events + status — also clears the feed's red banner
    } catch (e) {
      notify((e as Error).message, true);
    }
  }

  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between p-4"
        onClick={() => setOpen(!open)}
      >
        <span className={`flex items-center gap-2 ${CARD_TITLE}`}>
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
          {events.length > 0 && (
            <li className="border-b border-gray-50 py-2">
              <button
                type="button"
                onClick={clearLog}
                className="w-full rounded-xl border border-gray-300 py-1.5 text-sm font-semibold text-gray-500 active:bg-gray-100"
              >
                Clear log
              </button>
            </li>
          )}
          {events.map((e) => (
            <li key={e.id} className="border-b border-gray-50 py-2 last:border-b-0">
              <button
                type="button"
                aria-expanded={expandedId === e.id}
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
  notify,
  onScanDone,
}: {
  settings: SettingsType;
  setSettings: (s: SettingsType) => void;
  save: (patch: Partial<SettingsType>) => void;
  notify: (text: string, sticky?: boolean) => void;
  onScanDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);

  const SKIP_REASONS: Record<string, string> = {
    already_running: 'A scan is already running — see the Activity log.',
    budget_exhausted: 'Daily call budget is spent; scans resume tomorrow.',
    scan_disabled: 'Scanning is turned off (toggle above).',
  };

  async function runScan() {
    setScanBusy(true);
    notify('Scan batch requested…');
    try {
      const r = await api.scan();
      notify(
        r.skippedReason
          ? (SKIP_REASONS[r.skippedReason] ?? `Skipped: ${r.skippedReason}`)
          : `Batch done: ${r.scanned}/${r.planned} scanned, ${r.snapshots} prices${r.failures ? `, ${r.failures} failed` : ''}`,
        true,
      );
      onScanDone();
    } catch {
      // A real batch outlives the request timeout — that's expected.
      notify('Batch running in the background — progress appears in the Activity log.', true);
    } finally {
      setScanBusy(false);
    }
  }
  return (
    <div className="rounded-2xl bg-white shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center justify-between p-4"
        onClick={() => setOpen(!open)}
      >
        <span className={CARD_TITLE}>Advanced</span>
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
              label="Daily call budget"
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
              aria-label="Alert minimum discount percent"
              min={5}
              max={50}
              value={Math.round(settings.alertMinDiscount * 100)}
              onChange={(e) =>
                setSettings({ ...settings, alertMinDiscount: Number(e.target.value) / 100 })
              }
              onPointerUp={() => save({ alertMinDiscount: settings.alertMinDiscount })}
              onBlur={() => save({ alertMinDiscount: settings.alertMinDiscount })}
            />
          </AdvField>

          <AdvField
            label={`Deal feed floor — ${Math.round(settings.dealMinDiscount * 100)}%`}
            hint="Prices at least this far below typical show as deals on the home page (emails have their own bar above). Changes apply to the whole feed immediately."
          >
            <input
              className="w-full accent-brand"
              type="range"
              aria-label="Deal feed floor percent"
              min={1}
              max={30}
              value={Math.round(settings.dealMinDiscount * 100)}
              onChange={(e) =>
                setSettings({ ...settings, dealMinDiscount: Number(e.target.value) / 100 })
              }
              onPointerUp={() => save({ dealMinDiscount: settings.dealMinDiscount })}
              onBlur={() => save({ dealMinDiscount: settings.dealMinDiscount })}
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
              label="Re-alert cooldown in days"
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
              label="Scan horizon in months"
              onCommit={(n) => save({ scanHorizonMonths: n })}
            />
          </AdvField>

          <div>
            <button
              type="button"
              disabled={scanBusy}
              onClick={runScan}
              className="w-full rounded-xl border border-brand py-2 text-sm font-semibold text-brand active:bg-brand-pale disabled:opacity-50"
            >
              {scanBusy ? 'Requesting…' : 'Run scan batch now'}
            </button>
            <p className={`mt-2 ${CARD_DESC}`}>
              Runs one batch (a quarter of the daily budget) immediately instead of waiting for
              the next scheduled scan. Progress and results appear in the Activity log.
            </p>
          </div>
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
      <p className={`mb-1.5 ${CARD_TITLE}`}>{label}</p>
      {children}
      <p className={`mt-2 ${CARD_DESC}`}>{hint}</p>
    </div>
  );
}

/** Commit-on-blur integer input; clamps to [min, max] and snaps the field
 *  back to the clamped value so what you see is what was saved. */
function NumberInput({
  value,
  min,
  max,
  label,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (n: number) => void;
}) {
  return (
    <input
      // Keyed by value: uncontrolled input remounts when the server-side value
      // changes (a concurrent save response), so display can't go stale.
      key={value}
      className="w-full bg-transparent text-lg font-bold outline-none"
      type="number"
      inputMode="numeric"
      aria-label={label}
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
