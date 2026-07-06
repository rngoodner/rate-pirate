import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { recordApiCall } from '../db/repo.js';
import { SyntheticProvider } from './mock.js';
import { findChrome, GoogleFlightsProvider } from './google-flights.js';
import type { FlightPriceProvider } from './types.js';

export function createProvider(config: Config, db: Db): FlightPriceProvider {
  if (config.PROVIDER === 'google-flights') {
    return new GoogleFlightsProvider(
      findChrome(config.CHROME_PATH),
      (log) => recordApiCall(db, { provider: 'google-flights', ...log }),
      { noSandbox: config.CHROME_NO_SANDBOX },
    );
  }
  return new SyntheticProvider();
}
