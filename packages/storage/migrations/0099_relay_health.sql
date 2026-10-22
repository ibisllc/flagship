-- Private relay health (docs/outbound-proxy.md, OHTTP): how setup calls from
-- boxes with an outbound proxy reached .com, counted per UTC day with no box
-- identity or address, and the latest daily relay probe. Re-runnable.
CREATE TABLE IF NOT EXISTS relay_arrivals (
  day TEXT NOT NULL,
  path TEXT NOT NULL CHECK (path IN ('ohttp', 'direct-fallback')),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
CREATE TABLE IF NOT EXISTS relay_probes (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ok INTEGER NOT NULL,
  at INTEGER NOT NULL,
  detail TEXT NOT NULL
);
