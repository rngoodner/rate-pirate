CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE destinations (
  iata    TEXT PRIMARY KEY,
  city    TEXT NOT NULL,
  country TEXT NOT NULL,
  region  TEXT NOT NULL,
  tier    INTEGER NOT NULL DEFAULT 2,
  active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE price_snapshots (
  id           INTEGER PRIMARY KEY,
  origin       TEXT NOT NULL,
  destination  TEXT NOT NULL,
  travel_month TEXT NOT NULL,
  depart_date  TEXT NOT NULL,
  return_date  TEXT NOT NULL,
  price_cents  INTEGER NOT NULL,
  stops        INTEGER,
  carrier      TEXT,
  source       TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_snap_route_month ON price_snapshots(origin, destination, travel_month, captured_at);
CREATE INDEX idx_snap_captured ON price_snapshots(captured_at);

CREATE TABLE deals (
  id                   INTEGER PRIMARY KEY,
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
  UNIQUE(origin, destination, travel_month)
);

CREATE TABLE alerts (
  id          INTEGER PRIMARY KEY,
  deal_id     INTEGER NOT NULL REFERENCES deals(id),
  sent_to     TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  score       INTEGER NOT NULL,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE api_calls (
  id        INTEGER PRIMARY KEY,
  provider  TEXT NOT NULL,
  endpoint  TEXT NOT NULL,
  route     TEXT,
  status    INTEGER,
  ok        INTEGER NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_api_calls_time ON api_calls(called_at);
