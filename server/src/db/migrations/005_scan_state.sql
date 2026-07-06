-- Per route-month-cabin scan bookkeeping, so pairs that reliably return no
-- fares (e.g. no business/first cabin on a leisure route) can be put to sleep
-- instead of rescanned every batch. Without this, an always-empty pair has no
-- price_snapshots row, so the planner treats it as never-scanned and gives it
-- TOP priority forever — the opposite of what we want.
CREATE TABLE scan_state (
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  cabin TEXT NOT NULL,
  travel_month TEXT NOT NULL,
  last_scan_at TEXT NOT NULL,        -- every scan attempt, empty or not
  consecutive_empty INTEGER NOT NULL, -- 0 once fares are seen; grows while empty
  PRIMARY KEY (source, origin, destination, cabin, travel_month)
);
