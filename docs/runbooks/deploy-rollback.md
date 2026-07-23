# Deploy & rollback

How to revert a bad deploy of either plane, and what to do when the
revert is blocked by a migration that can't go backwards.

There are two independently deployed surfaces:

- **`.com`** — the Cloudflare Worker `flagship-com` (identity + state; D1 +
  R2). Deployed with `wrangler`.
- **`.services`** — the Fly app `flagship-services` (stateless data plane).
  Deployed with `flyctl`.

Both are deployed forward; both runtimes keep a release history you can roll
back to. The hazard is **D1 schema migrations**, which are *not* part of the
Worker release and do *not* roll back with it (see "Migrations" below).

## `.com` (Cloudflare Worker)

### Deploy

```sh
# tsc -b FIRST — wrangler bundles the BUILT control-plane dist/, so a deploy
# without a rebuild silently ships stale handler logic.
npx tsc -b && (cd apps/com && npx wrangler deploy)
```

### Roll back

`wrangler` keeps an immutable history of uploaded versions. To revert the
*code* to the previous version:

```sh
cd apps/com

# See recent deployments (each line is a version id + timestamp + trigger).
npx wrangler deployments list

# Roll back to the immediately-previous version (interactive confirm).
npx wrangler rollback

# Or pin a specific version id from the list:
npx wrangler rollback <version-id>
```

`wrangler rollback` re-points the active deployment at an already-uploaded
version — it does **not** rebuild from the working tree, so it is safe and
fast even if the tree is mid-fix. It rolls back **only the Worker script +
its bindings config**, never D1 rows or schema.

For a graduated cutover instead of an all-at-once flip, use version upload +
`wrangler versions deploy` to split traffic between two versions; `wrangler
versions list` shows what's deployable.

> Custom domains (`boot.flagshipserver.com`, `webapp.flagshipserver.com`) are
> attached to the Worker, not to a version — a rollback does not move them.

## `.services` (Fly app)

### Deploy

```sh
export PATH="$HOME/.fly/bin:$PATH"
flyctl deploy --remote-only --strategy=immediate --yes -a flagship-services
```

### Roll back

Fly keeps a numbered release history per app:

```sh
# List releases (version number, status, image, timestamp).
flyctl releases -a flagship-services

# Roll back to the previous release (re-deploys its image).
flyctl releases rollback -a flagship-services

# Or target a specific version from the list:
flyctl releases rollback <version> -a flagship-services
```

A rollback redeploys the prior **image**, so it reverts code + the baked
runtime config. `.services` is stateless (SNI passthrough on :443 +
tunnel-hub WebSocket on :8443), so there is no data migration to unwind on
this plane — a rollback is clean. In a hurry you can also
`flyctl deploy --image <prior-image-ref>` directly.

## Migrations — the irreversibility caveat

**D1 migrations are forward-only and applied out-of-band.** They are *not*
bundled with the Worker and do *not* roll back when you `wrangler rollback`.
Each migration is one `wrangler d1 execute --file=... --remote` run against
`flagship-state`, tracked manually (the `schema_version` ledger added in
0049 records *that* a file was applied, not how to undo it). There are **no
down-migrations** in this repo.

Consequences when a deploy must revert:

1. **Code-only revert (no new migration in the bad deploy).** Just
   `wrangler rollback` / `flyctl releases rollback`. The schema is unchanged,
   so the prior code runs fine against it.

2. **The bad deploy also added a migration.** Roll the *code* back first
   (above) to stop the bleeding. Then handle the schema:
   - Many migrations are **additive and idempotent**
     (`CREATE TABLE/INDEX IF NOT EXISTS`) — a new, unused table or column is
     harmless to the rolled-back code, so usually **leave it in place** and
     re-fix forward. This is the preferred path: forward-fix, don't unwind.
   - Some migrations are **apply-once / non-idempotent** — a bare
     `ALTER TABLE ... ADD COLUMN` or `RENAME COLUMN` cannot be re-run and has
     no automatic reverse (SQLite has no `ADD COLUMN IF NOT EXISTS`). See the
     audited list in `packages/storage/migrations/README.md`. If such a
     change is genuinely incompatible with the rolled-back code, you must
     write and apply a **new compensating migration by hand** (e.g. a
     `RENAME COLUMN` back, or a 12-step rebuild table for a column drop) —
     there is no button for this.
   - If the schema change corrupted or lost data, restore from the 6-hourly
     R2 dump per `docs/runbooks/d1-restore.md` rather than trying to unwind
     the migration.

3. **Design migrations to be roll-safe.** Prefer additive,
   `IF NOT EXISTS`-guarded changes that the *previous* code can tolerate, so
   a code rollback never strands the schema. New migrations MUST follow the
   idempotent template in `packages/storage/migrations/README.md`.

### Confirm schema state after any deploy/rollback

```sh
# Diff the ledger against the repo's known migration set.
curl -s -H "x-admin-secret: $FLAGSHIP_ADMIN_SECRET" \
  https://flagshipserver.com/api/admin/schema-status | jq
```

`missing` = known migrations not yet recorded as applied; `unknown` = ledger
rows ahead of the repo. Both should be empty when in sync.

## Order of operations

- **Forward deploy with a migration:** apply the migration to prod D1
  **before** the Worker deploy when the new code *reads* the new
  column/table (the code must not run ahead of its schema). CLAUDE.md flags
  this per-migration (e.g. "0048 BEFORE the Worker deploy").
- **Rollback:** revert the **code** first (fast, reversible), then decide on
  the schema (usually: leave additive changes, forward-fix). Never assume a
  `wrangler rollback` also reverted the schema — it did not.
