-- PRE-RELEASE FULL USER WIPE (2026-06-02) — owner-authorized clean slate for
-- end-to-end testing of BOTH the demo path and the real-hardware/human path
-- under the new per-user-cert SSL system (#23/#28).
--
-- Clears every user / server / demo / install / billing / audit row.
-- PRESERVES: marketplace_listings (app catalog, not user data), _cf_KV and
-- sqlite_sequence (Cloudflare/SQLite internals). No CA material lives in D1.

-- Identity + naming
DELETE FROM usernames;
DELETE FROM usernames_aliases;
DELETE FROM user_identity_records;
DELETE FROM name_claims;
DELETE FROM service_aliases;
DELETE FROM user_service_aliases;
DELETE FROM voici_links;

-- Servers + routing + registration
DELETE FROM servers;
DELETE FROM auth_codes;
DELETE FROM routing;
DELETE FROM box_serials;
DELETE FROM daemon_status;
DELETE FROM provision_status;
DELETE FROM build_tickets;
DELETE FROM install_events;
DELETE FROM install_policy_fanout;
DELETE FROM custom_domain_orders;

-- Cert authority + mint
DELETE FROM acme_account_key_grants;
DELETE FROM mint_reservations;
DELETE FROM entitlement_revocation_lists;

-- Boot-unlock + sealed key material
DELETE FROM box_sealed_leases;
DELETE FROM auto_unlock_leases;
DELETE FROM unlock_key_deposits;
DELETE FROM pending_unlock_approvals;
DELETE FROM sealed_luks_keys;
DELETE FROM secret_mailbox;

-- Recovery + re-pair + peer backup
DELETE FROM webauthn_recovery_records;
DELETE FROM recovery_shards;
DELETE FROM pending_re_pairs;

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

-- Audit + telemetry
DELETE FROM audit_events;
DELETE FROM qr_pipe_metrics;
