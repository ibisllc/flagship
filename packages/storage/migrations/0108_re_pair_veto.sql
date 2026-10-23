-- Recovery wait/veto (SECURITY-HARDENING-PLAN.md 10.6, N04).
--
--   completing_at       set by the one atomic claim that starts the key swap. A veto that lands
--                       first wins and the claim fails; a claim that lands first wins and the
--                       veto fails. Never both.
--   vetoed_by_hex       the admin key that vetoed (NULL = self-cancel by the recoverer).
--   veto_signature_hex  that admin's signature over the veto bytes, kept as the audit proof.
--   offline_alert_ms    the offline-alert threshold frozen when the attempt began; the wait is
--                       at least twice this.
--
-- NULL on rows started before this file. Apply-once (bare ADD COLUMN): see README.md.
ALTER TABLE pending_re_pairs ADD COLUMN completing_at INTEGER;
ALTER TABLE pending_re_pairs ADD COLUMN vetoed_by_hex TEXT;
ALTER TABLE pending_re_pairs ADD COLUMN veto_signature_hex TEXT;
ALTER TABLE pending_re_pairs ADD COLUMN offline_alert_ms INTEGER;
