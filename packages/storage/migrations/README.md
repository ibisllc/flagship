# `.com` D1 migrations — apply-once hazard + idempotency policy

These `.sql` files are the schema source-of-truth for the `flagship-state`
D1 database. Per the repo convention (see root `CLAUDE.md`), they are applied
**manually**, one file at a time, with raw:

```sh
cd apps/com && npx wrangler d1 execute flagship-state \
  --file=../../packages/storage/migrations/NNNN_name.sql --remote
```

There is **no migration ledger** in this path (no `wrangler d1 migrations
apply`, no `schema_version` table) — the operator tracks "what's applied"
out-of-band. That makes re-running a file by mistake a real footgun.

## The hazard (finding OPS-B)

Most files are written with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF
NOT EXISTS`, which re-run cleanly. But **SQLite has no `ALTER TABLE ... ADD
COLUMN IF NOT EXISTS`** (and no `RENAME COLUMN IF EXISTS`). So any file whose
body is a bare `ALTER TABLE ... ADD COLUMN` is **apply-once**: a second run
aborts the whole file on the first statement with

```
duplicate column name: <col>
```

and a `RENAME COLUMN` re-run aborts with `no such column: <old>`. Because a
`--file` run executes as one unit, that error stops the file — and if the
file mixes a (re-runnable) `CREATE INDEX IF NOT EXISTS` after the ALTER, the
index never gets (re)created on the aborted retry.

### Non-idempotent migrations (audited 0001..0048)

Bare `ALTER TABLE ... ADD COLUMN` (apply-once; re-run ⇒ `duplicate column name`):

| File | Column(s) added |
|------|-----------------|
| `0013_recovery_passphrase.sql`     | `fetch_token_hash`, `prf_salt_hash` |
| `0017_push_token_label.sql`        | `label` |
| `0021_is_demo.sql`                 | `is_demo` |
| `0023_custom_domain_pod_canonical.sql` | `pod_canonical` |
| `0028_account_type.sql`            | `account_type`, `totp_secret_encrypted`, `recovery_codes_hashes_json`, `totp_enrolled_at`, `grace_seconds`, `totp_required`, `totp_proof_consumed`, `quarantine_until` |
| `0029_re_pair_alerts.sql`          | `alerts_fired_bitmap` |
| `0030_audit_events_v12.sql`        | `account_type_at_event`, `quarantine_until`, `recovery_method` |
| `0032_recovery_wipe_policy.sql`    | `recovery_wipe_policy` |
| `0034_quarantine_alerts.sql`       | `quarantine_alerts_fired_bitmap` |
| `0035_demo_provision_phase.sql`    | `provision_phase`, `provision_phase_at`, `provision_last_error` |
| `0036_demo_server_identity.sql`    | `active_server_ip`, `image` |
| `0045_recovery_acme_account_key.sql` | `wrapped_acme_account_key_b64` |
| `0048_daemon_status_signed.sql`    | `report_json`, `signature_hex` |

Apply-once `RENAME COLUMN` (re-run ⇒ `no such column`):

| File | Rename |
|------|--------|
| `0026_rename_app_to_service.sql` | `custom_domain_orders.app_id` → `service_id` |

`0026` is additionally a **prod-only fixup** whose `RENAME` no-ops against a
fresh dev DB (the table's source-of-truth `CREATE` in `0022` was edited
in-place pre-launch to already use `service_id`). The parity harness'
SQLite applier (`tests/support/sqliteD1.ts`) tolerates exactly that one
no-op — see below.

## Policy decision (OPS-B)

**We do NOT rewrite the already-applied files.** They may already be applied
in prod D1; an in-place rewrite (e.g. splitting the multi-ALTER `0028` so each
column can be re-tried) would diverge the repo from the deployed schema and
buys nothing for files that have already run successfully exactly once.

Instead:

1. **Re-running an applied migration is a known no-op-or-error, not a
   corruption.** The errors above (`duplicate column name`, `no such column`)
   are *safe*: the column already exists / the rename already happened. The
   operator runbook is: if a re-run aborts with one of those, the file was
   already applied — move on. Don't "fix" it by editing the column away.

2. **The parity harness encodes that policy as code.** `applyAllMigrations`
   in `tests/support/sqliteD1.ts` applies every file statement-by-statement
   and treats *only* `duplicate column name` / `no such column` as tolerated
   no-ops (anything else throws). That doubles as a regression guard: a NEW
   migration that fails to apply to a fresh schema breaks the parity suite.

3. **NEW migrations MUST follow the idempotent template below**, so this
   hazard class stops growing. Once the separate migration-ledger feature
   lands (tracked elsewhere — out of scope for this package), the manual
   `--file` path and this note can be retired.

## Idempotent template for NEW migrations

Tables and indexes — always guarded, re-runnable as-is:

```sql
CREATE TABLE IF NOT EXISTS my_table ( ... );
CREATE INDEX IF NOT EXISTS idx_my_table_x ON my_table(x);
CREATE UNIQUE INDEX IF NOT EXISTS uq_my_table_y ON my_table(y) WHERE active = 1;
```

Adding a column to an EXISTING table — SQLite has no `ADD COLUMN IF NOT
EXISTS`, so prefer ONE of:

- **(Preferred) Recreate-with-guard for a brand-new table.** If the column
  belongs to a table you're introducing in the same migration, just put it in
  the `CREATE TABLE IF NOT EXISTS`.

- **Table-rebuild for a column on an existing table**, fully re-runnable:

  ```sql
  -- only when the column genuinely must be added to an existing table
  CREATE TABLE IF NOT EXISTS my_table_v2 (
    ...existing columns...,
    new_col TEXT            -- the addition
  );
  INSERT INTO my_table_v2 (...existing columns...)
    SELECT ...existing columns... FROM my_table
    WHERE NOT EXISTS (SELECT 1 FROM my_table_v2);  -- guard re-runs
  DROP TABLE IF EXISTS my_table;
  ALTER TABLE my_table_v2 RENAME TO my_table;      -- one-shot, but the
                                                   -- guarded CREATE above
                                                   -- makes the file replayable
  ```

- **Bare `ALTER TABLE ADD COLUMN` is acceptable ONLY if you accept it is
  apply-once** — and then you MUST add the file to the audit table above and
  note "apply-once" in the migration's header comment, so the next operator
  knows a re-run abort is expected, not a failure.
