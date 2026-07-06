-- Add cabin/fare-class dimension. Existing snapshots were all economy scrapes,
-- so backfill them as such. Deals are derived data (rebuilt by the next scans),
-- so the table is rebuilt with cabin folded into its uniqueness key.
ALTER TABLE price_snapshots ADD COLUMN cabin TEXT NOT NULL DEFAULT 'economy';
CREATE INDEX idx_snap_cabin ON price_snapshots(source, origin, destination, travel_month, cabin, captured_at);

DELETE FROM alerts;
DROP TABLE deals;
CREATE TABLE deals (
  id                   INTEGER PRIMARY KEY,
  source               TEXT NOT NULL,
  origin               TEXT NOT NULL,
  destination          TEXT NOT NULL,
  cabin                TEXT NOT NULL DEFAULT 'economy',
  travel_month         TEXT NOT NULL,
  best_price_cents     INTEGER NOT NULL,
  baseline_price_cents INTEGER NOT NULL,
  discount_pct         REAL NOT NULL,
  score                INTEGER NOT NULL,
  depart_date          TEXT NOT NULL,
  return_date          TEXT NOT NULL,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  UNIQUE(source, origin, destination, cabin, travel_month)
);
