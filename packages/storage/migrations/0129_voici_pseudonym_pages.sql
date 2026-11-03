-- voi.ci: the one page each Messages pseudonym writes to (security review; code in packages/storage/src/voici.ts,
-- packages/control-plane/src/voiciMailbox.ts handleVoiciSend).
--
-- A Messages key attestation vouches for one pseudonym key P and is counted once against its account's daily
-- new-recipient allowance (renewals of the same P are free). Nothing tied it to a page, so one attestation could open
-- conversations on any number of pages. The first accepted send records P -> page here; a send of P to any other page
-- is refused. Keyed by P, so a renewal (same P, new attestation) meets the same row. No account is named: P already
-- appears in every message it sent. Rows go with the page (account deletion).
--
-- Re-runnable: CREATE ... IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS voici_pseudonym_pages (
  pseudonym_pub TEXT PRIMARY KEY,
  page_id       TEXT NOT NULL,
  bound_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voici_pseudonym_pages_page ON voici_pseudonym_pages(page_id);
