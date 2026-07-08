-- Capture flight-level detail the result aria-label already carries but we were
-- dropping: total outbound duration and layovers (airport + minutes, JSON). Both
-- nullable — older snapshots and any label we can't parse simply lack them.
ALTER TABLE price_snapshots ADD COLUMN duration_minutes INTEGER;
ALTER TABLE price_snapshots ADD COLUMN layovers TEXT;
