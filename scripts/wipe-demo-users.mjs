#!/usr/bin/env node
/**
 * wipe-demo-users — delete ALL demo users for a clean slate.
 *
 * Lists every `demo_users` row (GET /api/dev/sample-user) and deletes
 * each (POST /api/dev/sample-user/delete). Delete is idempotent: a
 * Hetzner server that's already gone (e.g. deleted by hand in the
 * console) is a no-op, and the D1 row is removed regardless.
 *
 * Usage:
 *   FLAGSHIP_ADMIN_SECRET=... node scripts/wipe-demo-users.mjs [--dry-run]
 *
 * Env:
 *   FLAGSHIP_ADMIN_SECRET  required — must match the deployed Worker.
 *   FLAGSHIP_BASE_URL      defaults to https://flagshipserver.com.
 *
 * NOTE: this clears the demo_users rows + Hetzner servers. Leftover
 * username claims (reusable — create allows re-claiming a demo-flagged
 * name), `servers` rows (overwritten on re-register), and DNS A-records
 * (re-published on re-register) are harmless and do NOT block a fresh
 * start.
 */

const BASE = process.env.FLAGSHIP_BASE_URL || "https://flagshipserver.com";
const SECRET = process.env.FLAGSHIP_ADMIN_SECRET;
const DRY = process.argv.includes("--dry-run");

if (!SECRET) {
  console.error(
    "fail-closed: set FLAGSHIP_ADMIN_SECRET (the value matching the deployed Worker).",
  );
  process.exit(2);
}

const headers = { "content-type": "application/json", "x-admin-secret": SECRET };

async function main() {
  const listRes = await fetch(`${BASE}/api/dev/sample-user`, { headers });
  if (!listRes.ok) {
    console.error(`fail: list returned HTTP ${listRes.status} ${await listRes.text()}`);
    process.exit(listRes.status === 401 || listRes.status === 403 ? 2 : 1);
  }
  const { demoUsers = [] } = await listRes.json();
  if (demoUsers.length === 0) {
    console.log("No demo users — already clean.");
    return;
  }

  console.log(`Found ${demoUsers.length} demo user(s):`);
  for (const u of demoUsers) console.log(`  - ${u.username} (state=${u.state})`);

  if (DRY) {
    console.log("\n--dry-run: nothing deleted.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const u of demoUsers) {
    const res = await fetch(`${BASE}/api/dev/sample-user/delete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: u.username }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.deleted) {
      ok++;
      console.log(`  ✓ deleted ${u.username}`);
    } else {
      failed++;
      console.log(`  ✗ ${u.username}: HTTP ${res.status} ${JSON.stringify(body)}`);
    }
  }

  console.log(`\nDone: ${ok} deleted, ${failed} failed of ${demoUsers.length}.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
