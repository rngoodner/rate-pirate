-- Premium economy has no Google 60-day price *history* — the "View price history"
-- graph literally isn't rendered for that cabin (economy and business both get a
-- full 62-point series on the same route; premium economy gets none). But premium
-- economy DOES have a "Price graph" (fare across departure dates), whose median is
-- a valid baseline. Record which source a combo's series came from so the UI can
-- label it and we can measure premium-economy coverage separately.
--   'history'     — Google's 60-day price-history series (economy / business)
--   'price_graph' — Google's Price graph, fare across departure dates (premium economy)
--   NULL          — no series captured yet
ALTER TABLE price_insights ADD COLUMN series_kind TEXT;
