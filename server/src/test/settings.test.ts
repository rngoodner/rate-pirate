import { describe, expect, it } from 'vitest';
import { openDb } from '../db/db.js';
import { getSettings, updateSettings } from '../db/settings.js';
import { loadConfig } from '../config.js';

const config = loadConfig({ ALERT_EMAIL_TO: 'env@example.com' });

describe('settings', () => {
  it('returns defaults with env fallback on an empty DB', () => {
    const db = openDb(':memory:');
    const s = getSettings(db, config);
    expect(s).toEqual({
      homeAirport: 'ABQ',
      alertEmail: 'env@example.com',
      alertThreshold: 85,
      dailyCallBudget: 100,
      scanEnabled: true,
      monitoredCabins: ['economy', 'premium_economy'],
      alertMinDiscount: 0.2,
      dealMinDiscount: 0.05,
      alertCooldownDays: 7,
      alertMaxPriceCents: 0,
      tripTypes: ['one_week'],
      adults: 1,
      hiddenAirlines: [],
    });
  });

  it('DB values override env and defaults, and round-trip', () => {
    const db = openDb(':memory:');
    updateSettings(db, {
      homeAirport: 'den',
      alertEmail: 'me@example.com',
      alertThreshold: 90,
      scanEnabled: false,
    });
    const s = getSettings(db, config);
    expect(s.homeAirport).toBe('DEN');
    expect(s.alertEmail).toBe('me@example.com');
    expect(s.alertThreshold).toBe(90);
    expect(s.scanEnabled).toBe(false);
    expect(s.dailyCallBudget).toBe(100); // untouched key keeps default
  });

  it('advanced tunables round-trip (including the float discount)', () => {
    const db = openDb(':memory:');
    updateSettings(db, {
      alertMinDiscount: 0.15,
      dealMinDiscount: 0.1,
      alertCooldownDays: 3,
      alertMaxPriceCents: 150_000,
      tripTypes: ['weekend', 'two_weeks'],
      adults: 3,
      hiddenAirlines: ['Spirit', 'Frontier'],
    });
    const s = getSettings(db, config);
    expect(s.alertMinDiscount).toBe(0.15);
    expect(s.dealMinDiscount).toBe(0.1);
    expect(s.alertCooldownDays).toBe(3);
    expect(s.alertMaxPriceCents).toBe(150_000);
    expect(s.tripTypes).toEqual(['weekend', 'two_weeks']);
    expect(s.adults).toBe(3);
    expect(s.hiddenAirlines).toEqual(['Spirit', 'Frontier']);
  });

  it('hidden airlines can be cleared back to empty', () => {
    const db = openDb(':memory:');
    updateSettings(db, { hiddenAirlines: ['Spirit'] });
    expect(getSettings(db, config).hiddenAirlines).toEqual(['Spirit']);
    updateSettings(db, { hiddenAirlines: [] });
    expect(getSettings(db, config).hiddenAirlines).toEqual([]);
  });

  it('partial update leaves other keys alone', () => {
    const db = openDb(':memory:');
    updateSettings(db, { alertThreshold: 70 });
    updateSettings(db, { scanEnabled: false });
    const s = getSettings(db, config);
    expect(s.alertThreshold).toBe(70);
    expect(s.scanEnabled).toBe(false);
  });
});
