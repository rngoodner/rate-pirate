-- Google's price insights, captured from the same page loads as snapshots:
-- a level verdict ('low'|'typical'|'high') and, while a route-month lacks its
-- own baseline, the ~60-day price-history series behind "View price history".
-- Latest capture wins (upsert). Bootstraps baselines so deals can exist from
-- day one; superseded automatically once our own history matures.
CREATE TABLE price_insights (
  source TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  cabin TEXT NOT NULL,
  travel_month TEXT NOT NULL,
  level TEXT, -- 'low' | 'typical' | 'high' | NULL
  median_cents INTEGER, -- median of the series; NULL when no series
  series_json TEXT, -- [["YYYY-MM-DD", cents], ...] oldest first
  captured_at TEXT NOT NULL,
  PRIMARY KEY (source, origin, destination, cabin, travel_month)
);

-- Where a deal's baseline came from: our own history or Google's.
ALTER TABLE deals ADD COLUMN baseline_source TEXT NOT NULL DEFAULT 'observed';
