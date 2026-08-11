-- ============================================================================
-- 007 — Synthetic data source
--
-- Generated market data is a first-class source, not a test fixture smuggled in
-- through the back door. It gets its own `sources` row for the same reason
-- every other fact does: so that any bar, feature, or backtest result can be
-- traced to where it came from, and so a synthetic bar can never be mistaken
-- for something that actually traded.
--
-- Tiered tier4_social deliberately — it is the least authoritative source in the
-- system. Nothing generated should ever outrank a real print.
-- ============================================================================

INSERT INTO sources (slug, name, tier, base_url, notes) VALUES
  ('synthetic',
   'Synthetic generator',
   'tier4_social',
   NULL,
   'Deterministic seeded price series with known ground truth. Never real market data.')
ON CONFLICT (slug) DO NOTHING;
