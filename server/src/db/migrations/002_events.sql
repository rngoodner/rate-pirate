-- In-app event log: errors and notable activity (batch summaries, alerts sent),
-- surfaced in Settings → Activity log. Pruned after 30 days.
CREATE TABLE app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('info', 'error')),
  scope TEXT NOT NULL, -- 'scan' | 'batch' | 'alert' | 'system'
  message TEXT NOT NULL, -- one-line, human-readable
  detail TEXT, -- stack / raw error, truncated
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_created ON app_events (created_at DESC);
