import type { Config } from '../config.js';
import type { Db } from '../db/db.js';
import { recordApiCall } from '../db/repo.js';
import { SyntheticProvider } from './mock.js';
import { TravelpayoutsProvider } from './travelpayouts.js';
import type { FlightPriceProvider } from './types.js';

export function createProvider(config: Config, db: Db): FlightPriceProvider {
  if (config.PROVIDER === 'travelpayouts') {
    if (!config.TRAVELPAYOUTS_TOKEN) {
      throw new Error('PROVIDER=travelpayouts requires TRAVELPAYOUTS_TOKEN');
    }
    return new TravelpayoutsProvider(config.TRAVELPAYOUTS_TOKEN, (log) =>
      recordApiCall(db, { provider: 'travelpayouts', ...log }),
    );
  }
  return new SyntheticProvider();
}
