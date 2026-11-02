#!/usr/bin/env -S npx tsx
/**
 * Relay-mesh rollout step 1 (docs/architecture-v2/relay-mesh.md §13.2): append one `account-authority` per account,
 * one `box-register` per live server and one `policy-head` per stored serving policy to the relay log, then every
 * revocation already made (servers, renewal keys, device grants, certs, retired relays and what only the old
 * revocation log records), and sign them. Idempotent: it appends only what the log does not already say, so running
 * it twice appends nothing the second time. The work is apps/com/src/relayFeed.ts `backfillRelayLog`, run by `.com`
 * as one D1 batch (one transaction) behind POST /api/admin/relays {op:"backfill"}.
 *
 *   FLAGSHIP_ADMIN_SECRET=... npx tsx scripts/relay-log-backfill.ts            prod
 *   FLAGSHIP_BASE_URL=https://gym.flagshipserver.com ... scripts/relay-log-backfill.ts   the gym
 *
 * Needs migration 0122 applied and SERVING_REVOCATION_SEED set on the Worker. Publishing follows only when
 * RELAY_MESH is "on" (otherwise the entries wait, signed, in D1).
 */

interface BackfillAnswer {
  ok?: boolean;
  appended?: number;
  sequence?: number;
  error?: string;
}

async function post(base: string, secret: string, body: unknown): Promise<{ status: number; answer: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/admin/relays`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-secret": secret },
    body: JSON.stringify(body),
  });
  const answer = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as Record<string, unknown>;
  return { status: res.status, answer };
}

async function main(): Promise<void> {
  const secret = process.env.FLAGSHIP_ADMIN_SECRET;
  if (!secret) {
    console.error("FLAGSHIP_ADMIN_SECRET is not set.");
    process.exit(2);
  }
  const base = (process.env.FLAGSHIP_BASE_URL ?? "https://flagshipserver.com").replace(/\/+$/, "");
  const { status, answer } = await post(base, secret, { op: "backfill" });
  const a = answer as BackfillAnswer;
  if (status !== 200 || !a.ok) {
    console.error(`Backfill refused (${status}): ${a.error ?? JSON.stringify(answer)}`);
    process.exit(1);
  }
  console.log(`Appended ${a.appended} entries; the log is signed through sequence ${a.sequence}.`);
  const again = await post(base, secret, { op: "backfill" });
  const b = again.answer as BackfillAnswer;
  if (again.status === 200 && b.appended === 0) console.log("Second pass appended nothing: the log matches D1.");
  else console.log(`Second pass appended ${b.appended ?? "?"} (writes landed in between; run it again to settle).`);
}

main().catch((e) => {
  console.error((e as Error)?.message ?? e);
  process.exit(1);
});
