import { describe, expect, it } from 'vitest';
import { isAirlineHidden, primaryAirline } from '@rate-pirate/shared';

describe('primaryAirline', () => {
  it('returns the sole carrier of a single-airline itinerary', () => {
    expect(primaryAirline('United')).toBe('United');
    expect(primaryAirline('Air Canada')).toBe('Air Canada');
  });

  it('collapses a multi-carrier string to the first (marketing) airline', () => {
    expect(primaryAirline('American and British Airways')).toBe('American');
    expect(primaryAirline('Delta and LATAM')).toBe('Delta');
    expect(primaryAirline('United, SWISS and Edelweiss Air')).toBe('United');
    expect(primaryAirline('United, Lufthansa and Discover Airlines')).toBe('United');
  });

  it('returns null for a missing or empty carrier', () => {
    expect(primaryAirline(null)).toBeNull();
    expect(primaryAirline(undefined)).toBeNull();
    expect(primaryAirline('')).toBeNull();
    expect(primaryAirline('   ')).toBeNull();
  });
});

describe('isAirlineHidden', () => {
  it('is true only when the airline is in the deny-list', () => {
    expect(isAirlineHidden('United', ['United', 'Spirit'])).toBe(true);
    expect(isAirlineHidden('Delta', ['United', 'Spirit'])).toBe(false);
  });

  it('never hides an unknown (null) airline or when the list is empty', () => {
    expect(isAirlineHidden(null, ['United'])).toBe(false);
    expect(isAirlineHidden('United', [])).toBe(false);
  });
});
