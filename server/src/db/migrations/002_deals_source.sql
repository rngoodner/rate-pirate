-- Scope deals by provider source so mock/demo data and live data never mix.
-- deals and alerts are derived data (regenerated from price_snapshots by the
-- next scans), so rebuilding them empty is safe.
DELETE FROM alerts;
DROP TABLE deals;
CREATE TABLE deals (
  id                   INTEGER PRIMARY KEY,
  source               TEXT NOT NULL,
  origin               TEXT NOT NULL,
  destination          TEXT NOT NULL,
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
  UNIQUE(source, origin, destination, travel_month)
);
