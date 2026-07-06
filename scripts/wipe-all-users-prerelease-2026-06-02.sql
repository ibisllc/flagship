-- PRE-RELEASE FULL USER WIPE (2026-06-02) — owner-authorized clean slate for
-- end-to-end testing of BOTH the demo path and the real-hardware/human path
-- under the new per-user-cert SSL system (#23/#28).
--
-- Clears every user / server / demo / install / billing / audit row.
-- PRESERVES: marketplace_listings (app catalog, not user data), _cf_KV and
-- sqlite_sequence (Cloudflare/SQLite internals). No CA material lives in D1.
--
-- Re-audited 2026-06-08 against every migration through 0046 (created-minus-
-- dropped table set diffed vs this DELETE list): added acme_account_key_delivery
-- (0046) + nfc_rendezvous (0040); removed build_tickets (dropped in 0033 — the
-- stale DELETE would error).
-- Re-audited 2026-06-15 through 0054 (boot_nonces/0050 was already listed):
-- added the monetization tables usage_counters (0051), vouchers (0052),
-- stripe_events (0053), app_purchases (0054). Keep this list in sync as
-- migrations land, until the mass-wipe is disarmed before real users (see
-- CLAUDE.md open-work #11).
-- Re-audited 2026-06-19 through 0057: added trust_exceptions (0055),
-- service_invites + service_invite_bindings (0056/0057). build_tickets stays
-- OUT (dropped in 0033). The runner now requires WIPE_CONFIRM=<env> + --yes and
-- prints a row-count preview (scripts/wipe-all-users.sh) — see CLAUDE.md GA
-- close-out TODO item 1.
-- Re-audited 2026-07-05 through 0082: added username_offer (0062) +
-- username_suggest_throttle (0061), server_transfers (0059), server_evictions
-- (0063), admin_root_rotations (0066), peer_backup_manifests (0080),
-- server_migrations (0081). username_suggestion_queue (0061) is PRESERVED —
-- it's a .com-generated pre-validated name pool (infrastructure, expensive to
-- refill via DoH), not user data. schema_version is PRESERVED (the migration
-- ledger the predeploy drift gate reads). 0082 only adds columns to
-- server_transfers (already listed).
--
-- ⚠️ DO NOT run this file via `wrangler d1 execute --file`. Prod D1's schema
-- DRIFTS from the repo (migrations are applied by hand; e.g. nfc_rendezvous/0040
-- is in the repo but not in prod). A --file run is ONE transaction, so the first
-- DELETE on a table that prod lacks aborts the WHOLE wipe (rolls back, nothing
-- deleted). Run `bash scripts/wipe-all-users.sh` instead — it deletes each table
-- independently and skips the ones prod doesn't have. This file is the canonical
-- TABLE LIST that runner reads.

-- Identity + naming
DELETE FROM usernames;
DELETE FROM usernames_aliases;
DELETE FROM user_identity_records;
DELETE FROM name_claims;
DELETE FROM service_aliases;
DELETE FROM user_service_aliases;
DELETE FROM voici_links;
DELETE FROM username_offer;
DELETE FROM username_suggest_throttle;

-- Servers + routing + registration
DELETE FROM servers;
DELETE FROM auth_codes;
DELETE FROM routing;
DELETE FROM box_serials;
DELETE FROM daemon_status;
DELETE FROM provision_status;
DELETE FROM install_events;
DELETE FROM install_policy_fanout;
DELETE FROM custom_domain_orders;
DELETE FROM nfc_rendezvous;
DELETE FROM service_invites;
DELETE FROM service_invite_bindings;
DELETE FROM server_transfers;
DELETE FROM server_evictions;
DELETE FROM server_migrations;
DELETE FROM peer_backup_manifests;

-- Cert authority + mint
DELETE FROM acme_account_key_grants;
DELETE FROM acme_account_key_delivery;
DELETE FROM mint_reservations;
DELETE FROM entitlement_revocation_lists;

-- Boot-unlock + sealed key material
DELETE FROM box_sealed_leases;
DELETE FROM auto_unlock_leases;
DELETE FROM unlock_key_deposits;
DELETE FROM pending_unlock_approvals;
DELETE FROM sealed_luks_keys;
DELETE FROM secret_mailbox;
DELETE FROM boot_nonces;

-- Recovery + re-pair + peer backup
DELETE FROM webauthn_recovery_records;
DELETE FROM recovery_shards;
DELETE FROM pending_re_pairs;
DELETE FROM trust_exceptions;
DELETE FROM admin_root_rotations;

-- Devices + delegation + push
DELETE FROM device_capability_grants;
DELETE FROM watch_delegates;
DELETE FROM push_tokens;

-- Demo sandbox
DELETE FROM demo_users;
DELETE FROM demo_llm_ledger;

-- Marketplace installs (per-user; catalog listings preserved)
DELETE FROM marketplace_installs;

-- Billing / tiers / promos
DELETE FROM tier_subscriptions;
DELETE FROM hardware_orders;
DELETE FROM llm_promo_issues;
DELETE FROM llm_promo_lifetime;
DELETE FROM llm_promo_usage;
DELETE FROM usage_counters;
DELETE FROM vouchers;
DELETE FROM stripe_events;
DELETE FROM app_purchases;

-- Audit + telemetry
DELETE FROM audit_events;
DELETE FROM qr_pipe_metrics;
DELETE FROM ct_alerts;
