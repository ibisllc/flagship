// Which rows move when an account changes its name
// (docs/naming-recovery-and-name-change.md §5).
//
// Account state is keyed by the username string in many tables. A rename moves
// every row that belongs to the ACCOUNT; it deliberately leaves rows that
// encode the name somewhere it can't simply be rewritten (a box's FQDN, an
// app's immutable id) or that are history. Every username-like column in the
// schema must appear in exactly one of the two lists below — the storage test
// `accountRename.test.ts` fails on a column that is in neither, so a new table
// can't silently be left behind by a rename.

/** (table, column) pairs rewritten old → new, inside the rename transaction. */
export const RENAMED_ACCOUNT_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["acme_account_key_grants", "username"],
  ["admin_root_rotations", "username"],
  ["app_purchases", "username"],
  ["app_sales", "buyer_account"],
  ["audit_events", "username"],
  ["ct_alerts", "username"],
  ["custom_domain_orders", "user_id"],
  ["device_identities", "account_id"],
  ["device_capability_grants", "username"],
  ["account_profiles", "account_id"],
  ["device_self_profiles", "account_id"],
  ["device_managed_profiles", "account_id"],
  ["account_directory_key_grants", "account_id"],
  ["entitlement_revocation_lists", "username"],
  ["hardware_orders", "username"],
  ["llm_promo_issues", "username"],
  ["llm_promo_lifetime", "username"],
  ["llm_promo_usage", "username"],
  ["mint_reservations", "username"],
  ["name_claims", "username"],
  ["name_dibs_claims", "username"],
  ["name_dibs_starts", "username"],
  ["pending_re_pairs", "username"],
  ["push_tokens", "username"],
  ["recovery_shards", "username"],
  ["tier_subscriptions", "username"],
  ["trust_exceptions", "username"],
  ["usage_counters", "username"],
  ["user_service_aliases", "username"],
  ["voici_links", "username"],
  ["vouchers", "redeemed_by"],
  ["watch_delegates", "username"],
  ["webauthn_recovery_records", "username"],
];

/** Username-like columns a rename leaves alone, and why. */
export const NOT_RENAMED_ACCOUNT_COLUMNS: ReadonlyArray<readonly [table: string, column: string, reason: string]> = [
  ["usernames", "username", "the row itself — moved by insert-then-delete, not an UPDATE"],
  ["usernames_aliases", "old_username", "history of the removed #93 rename route"],
  ["usernames_aliases", "new_username", "history of the removed #93 rename route"],
  ["name_changes", "old_username", "the rename history this transaction appends to"],
  ["name_changes", "new_username", "the rename history this transaction appends to"],
  ["username_offer", "name", "suggestion roster entries, not an account"],
  ["server_transfers", "giver_username", "transfer history"],
  ["server_transfers", "acquirer_username", "transfer history"],
  // Server-scoped rows encode the owner in the box's FQDN (`<server>.<user>`).
  // Renaming an account that has servers is refused until the box re-home
  // (transfer-a-box's namespace migration, same owner) is built and validated,
  // so these only ever hold revoked servers' history at rename time.
  ["servers", "username", "server-scoped — rename refused while servers exist"],
  ["routing", "username", "server-scoped — rename refused while servers exist"],
  ["auth_codes", "username", "server-scoped — rename refused while servers exist"],
  ["secret_mailbox", "username", "server-scoped — rename refused while servers exist"],
  ["install_policy_fanout", "username", "server-scoped — rename refused while servers exist"],
  ["peer_backup_manifests", "username", "server-scoped — rename refused while servers exist"],
  ["server_migrations", "username", "server-scoped — rename refused while servers exist"],
  ["service_aliases", "username", "server-scoped — rename refused while servers exist"],
  // Demo accounts are operator-managed and can't rename.
  ["demo_users", "username", "demo accounts can't rename"],
  ["demo_llm_ledger", "username", "demo accounts can't rename"],
  // An app's id is `<creator>--<slug>` and immutable; payouts follow it.
  ["marketplace_listings", "creator", "app ids embed the creator and are immutable"],
  ["marketplace_installs", "creator", "app ids embed the creator and are immutable"],
  ["app_purchases", "creator", "app ids embed the creator and are immutable"],
  ["app_sales", "creator_account", "app ids embed the creator and are immutable"],
  // A salted hash of the username, computed by the client that owns the record.
  ["user_identity_records", "username_hash", "salted hash — the owning client must re-key it"],
];
