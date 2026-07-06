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
      scanHorizonMonths: 6,
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
      scanHorizonMonths: 4,
    });
    const s = getSettings(db, config);
    expect(s.alertMinDiscount).toBe(0.15);
    expect(s.dealMinDiscount).toBe(0.1);
    expect(s.alertCooldownDays).toBe(3);
    expect(s.scanHorizonMonths).toBe(4);
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
