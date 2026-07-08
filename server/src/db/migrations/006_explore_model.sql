-- Re-architecture around Google Flights "Explore" (Anywhere + flexible dates).
--
-- Deals, snapshots, and insights now key on TRIP TYPE (weekend / 1 week / 2
-- weeks) instead of travel month: one Explore search per (cabin, trip_type)
-- returns a whole ranked destination list at once, each with the dates Google
-- picked. travel_month survives only as a derived display/expiry attribute.
--
-- The curated destination catalog and dormancy state are gone (we search
-- Anywhere), and city/country are denormalized onto snapshots/deals since there
-- is no catalog to join. Baselines come from Google's own price history, so the
-- default baseline_source is 'google'.
--
-- All existing fixed-date data is incompatible with the new key; purge it and
-- let one batch regenerate the feed. Settings are preserved.

DELETE FROM alerts;
DROP TABLE IF EXISTS scan_state;
DROP TABLE IF EXISTS destinations;
DROP TABLE IF EXISTS deals;
DROP TABLE IF EXISTS price_snapshots;
DROP TABLE IF EXISTS price_insights;

CREATE TABLE price_snapshots (
  id            INTEGER PRIMARY KEY,
  source        TEXT NOT NULL,
  origin        TEXT NOT NULL,
  destination   TEXT NOT NULL,
  city          TEXT NOT NULL DEFAULT '',
  country       TEXT NOT NULL DEFAULT '',
  cabin         TEXT NOT NULL DEFAULT 'economy',
  trip_type     TEXT NOT NULL DEFAULT 'one_week',
  travel_month  TEXT NOT NULL,
  depart_date   TEXT NOT NULL,
  return_date   TEXT NOT NULL,
  price_cents   INTEGER NOT NULL,
  stops         INTEGER,
  carrier       TEXT,
  captured_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_snap_combo
  ON price_snapshots(source, origin, destination, cabin, trip_type, captured_at);

CREATE TABLE price_insights (
  source        TEXT NOT NULL,
  origin        TEXT NOT NULL,
  destination   TEXT NOT NULL,
  cabin         TEXT NOT NULL DEFAULT 'economy',
  trip_type     TEXT NOT NULL DEFAULT 'one_week',
  level         TEXT,
  median_cents  INTEGER,
  series_json   TEXT,
  captured_at   TEXT NOT NULL,
  PRIMARY KEY (source, origin, destination, cabin, trip_type)
);

CREATE TABLE deals (
  id                   INTEGER PRIMARY KEY,
  source               TEXT NOT NULL,
  origin               TEXT NOT NULL,
  destination          TEXT NOT NULL,
  city                 TEXT NOT NULL DEFAULT '',
  country              TEXT NOT NULL DEFAULT '',
  cabin                TEXT NOT NULL DEFAULT 'economy',
  trip_type            TEXT NOT NULL DEFAULT 'one_week',
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
  baseline_source      TEXT NOT NULL DEFAULT 'google',
  UNIQUE(source, origin, destination, cabin, trip_type)
);
