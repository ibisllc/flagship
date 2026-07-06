#!/usr/bin/env node
// Deploy-time migration-drift gate (OPS-2 enforcement).
//
// A `wrangler deploy` bundles the BUILT control-plane/storage dist, which can
// run AHEAD of the prod D1 schema: a handler that INSERTs a column added by an
// unapplied migration throws at runtime (Cloudflare 1101 → HTTP 500). This
// burned prod once — every `POST /api/username/claim` 500'd because migrations
// 0052–0057 were never applied (the `aid_pub_hex` column was missing).
//
// This script compares the repo's migration files against the prod
// `schema_version` ledger and FAILS the deploy when prod is missing any
// migration the repo knows about. Apply the migration AND stamp the ledger
// (POST /api/admin/schema-version/:v, or INSERT into schema_version) before
// re-deploying.
//
// Behavior:
//   - missing migration(s) in prod  → exit 1 (refuse the deploy)
//   - in sync                        → exit 0
//   - prod unreachable / wrangler not authed → WARN + exit 0 (never block a
//       deploy on an infra/auth hiccup; the operator still sees the warning)
//   - FLAGSHIP_SKIP_MIGRATION_CHECK=1 → skip entirely
//
// Only runs when FLAGSHIP_CHECK_PROD_MIGRATIONS=1 (the predeploy npm script
// sets it); unit tests that invoke predeploy-com.sh directly never trigger it.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "storage", "migrations");
const COM_DIR = join(REPO_ROOT, "apps", "com");
const DB = "flagship-state";

function warn(msg) {
  process.stderr.write(`⚠ migration-check: ${msg}\n`);
}

if (process.env.FLAGSHIP_SKIP_MIGRATION_CHECK === "1") {
  process.exit(0);
}

// Repo's migration versions (4-digit prefixes of *.sql).
const repoVersions = readdirSync(MIGRATIONS_DIR)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .map((f) => f.slice(0, 4))
  .sort();

if (repoVersions.length === 0) {
  warn("no migration files found — skipping");
  process.exit(0);
}

// Query the prod ledger. Tolerate any failure (no auth / offline / cold) by
// warning and passing — drift detection is best-effort, never a deploy blocker
// on infra trouble.
const res = spawnSync(
  "npx",
  [
    "wrangler",
    "d1",
    "execute",
    DB,
    "--remote",
    "--json",
    "--command",
    "SELECT version FROM schema_version",
  ],
  { cwd: COM_DIR, encoding: "utf8", timeout: 60_000 },
);

if (res.status !== 0 || !res.stdout) {
  warn(
    "could not read the prod schema_version ledger (wrangler not authed / offline?) — skipping the drift check",
  );
  process.exit(0);
}

let applied;
try {
  // wrangler --json emits an array of result objects; find the one with rows.
  const parsed = JSON.parse(res.stdout);
  const rows = (Array.isArray(parsed) ? parsed : [parsed])
    .flatMap((r) => r?.results ?? [])
    .map((row) => String(row.version));
  applied = new Set(rows);
} catch {
  warn("could not parse the ledger query output — skipping the drift check");
  process.exit(0);
}

const missing = repoVersions.filter((v) => !applied.has(v));

if (missing.length > 0) {
  process.stderr.write(`
================================================================
REFUSING TO DEPLOY: prod D1 is missing migration(s)
================================================================

Missing from the prod schema_version ledger: ${missing.join(", ")}

Why this is blocked:
  The deployed Worker bundles the BUILT control-plane/storage dist, which can
  run AHEAD of the prod schema. A handler touching an unapplied migration's
  table/column throws at runtime (Cloudflare 1101 → HTTP 500). This exact gap
  500'd every account creation once.

What to do (per missing version, in order):
  1. Apply it:
     cd apps/com && npx wrangler d1 execute ${DB} --remote \\
       --file=../../packages/storage/migrations/<version>_*.sql
  2. Stamp the ledger so this gate passes:
     cd apps/com && npx wrangler d1 execute ${DB} --remote \\
       --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES ('<version>', <now-ms>)"
  Then re-deploy.

  (Set FLAGSHIP_SKIP_MIGRATION_CHECK=1 to bypass only this check.)

================================================================
`);
  process.exit(1);
}

process.stdout.write(
  `✓ migration-check: prod ledger in sync (${repoVersions.length} migrations)\n`,
);
process.exit(0);
