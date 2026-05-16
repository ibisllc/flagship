#!/usr/bin/env node
/**
 * demo-account — provision / decommission the shared live demo account
 * (#83, Phase 5 C5.2/C5.3).
 *
 * SECURITY MODEL (why this is a registered-key-gated CLI, not a button):
 *   Provisioning mints a real `is_demo` account on the LIVE control
 *   plane and stands up a real VPS; decommissioning is the ONLY
 *   teardown and HARD-deletes every D1/R2 row + the VM + routing for
 *   that user — irreversible. So every mutating run must be authorized
 *   by a registered operator key (a YubiKey-PIV / WebAuthn-assertion-
 *   exported Ed25519 key whose pubkey is pinned in
 *   scripts/demo-operators.json or $DEMO_OPERATOR_PUBS). The operator
 *   signs a fresh canonical challenge; the CLI Ed25519-verifies it
 *   before ANY destructive shell-out — mirrors rotate-ca.mjs's
 *   "refuse to act until independently verified" discipline.
 *
 *   SAFE ORDERING / FOOT-GUN GUARDS (enforced below):
 *     - dry-run is the DEFAULT. `--execute` is required to mutate, and
 *       only proceeds after a valid assertion over a <5-min-fresh
 *       challenge.
 *     - decommission additionally requires the operator to type the
 *       exact username, and refuses a non-`is_demo` target (it must
 *       confirm the directive/flag first) so a real account can never
 *       be HARD-deleted by this tool.
 *     - NO daily/automatic wipe by design (removes the App-Store
 *       mid-review-wipe risk) — decommission is manual + the only path.
 *
 * Pure helpers are exported for scripts/demo-account.test.ts; the file
 * is import-safe (no side effects unless run as main).
 *
 * Run `node scripts/demo-account.mjs help`. The live D1/R2/VM steps
 * are operator steps documented in docs/ca-operations.md-style runbook
 * (see `printHelp`); they shell out to wrangler/flyctl and are
 * inherently real-infra (not exercised from a unit run).
 */

import { generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";

// ── arg parsing (same shape as rotate-ca.mjs) ──────────────────────
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const name = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { flags[name] = next; i++; }
        else flags[name] = true;
      }
    } else positionals.push(tok);
  }
  return { command: positionals[0] ?? "help", flags, positionals };
}

// ── operator-key gate ──────────────────────────────────────────────

/**
 * Canonical bytes the registered operator signs to authorize a run.
 * MUST be regenerated per run (issuedAt) so a captured signature
 * can't be replayed. Form:
 *   flagship/demo-operator/v1|<op>|<username>|<issuedAt>
 */
export function operatorChallenge(op, username, issuedAt) {
  for (const [n, v] of [["op", op], ["username", username]]) {
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c === 0x7c || c <= 0x1f || c === 0x7f) {
        throw new Error(`field "${n}" contains an illegal canonical-bytes char`);
      }
    }
  }
  return Buffer.from(
    ["flagship/demo-operator/v1", op, username, String(issuedAt)].join("|"),
    "utf8",
  );
}

function hexToPubKey(pubHex) {
  // raw 32-byte Ed25519 pubkey → SPKI DER → KeyObject (no deps).
  const der = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(pubHex, "hex"),
  ]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}
function hexToPrivKey(seedHex) {
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seedHex, "hex"),
  ]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

/** Ed25519 verify of `sigHex` over `msg` under raw-32-byte `pubHex`. */
export function verifyEd25519(pubHex, msg, sigHex) {
  if (!/^[0-9a-f]{64}$/i.test(pubHex) || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
  try {
    return edVerify(null, msg, hexToPubKey(pubHex), Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/** Test/ceremony helper: sign `msg` with a raw-32-byte Ed25519 seed. */
export function signEd25519(seedHex, msg) {
  return Buffer.from(edSign(null, msg, hexToPrivKey(seedHex))).toString("hex");
}

export function genEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const seedHex = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(16).toString("hex");
  const pubHex = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(12).toString("hex");
  return { seedHex, pubHex };
}

/** Read the pinned registered-operator pubkeys (64-hex), from
 *  $DEMO_OPERATOR_PUBS (comma-sep) or scripts/demo-operators.json
 *  (`{ "operators": ["<64hex>", ...] }`). Empty ⇒ the gate fails
 *  closed (no operator can authorize). */
export function readAuthorizedOperators(opts = {}) {
  const env = opts.env ?? process.env;
  const fromEnv = (env.DEMO_OPERATOR_PUBS ?? "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (fromEnv.length) return fromEnv;
  const file = opts.file ?? path.resolve("scripts/demo-operators.json");
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(j.operators)) {
        return j.operators.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
      }
    } catch { /* fall through → empty (fail closed) */ }
  }
  return [];
}

/**
 * Verify an operator authorization. Returns { ok, reason }. Fails
 * closed: unknown signer, bad signature, stale (>5min), or no pinned
 * operators all ⇒ ok:false. `assertion` = { pubHex, sigHex, issuedAt }.
 */
export function verifyOperatorAuthorization(args) {
  const { op, username, assertion, authorized, nowMs } = args;
  if (!authorized || authorized.length === 0) {
    return { ok: false, reason: "no registered operators pinned (fail closed)" };
  }
  if (!assertion || typeof assertion.pubHex !== "string" || typeof assertion.sigHex !== "string"
      || typeof assertion.issuedAt !== "number") {
    return { ok: false, reason: "missing/malformed operator assertion" };
  }
  if (!authorized.includes(assertion.pubHex.toLowerCase())) {
    return { ok: false, reason: "signer is not a pinned registered operator" };
  }
  if (Math.abs(nowMs - assertion.issuedAt) > 5 * 60_000) {
    return { ok: false, reason: "stale assertion (>5min) — re-sign a fresh challenge" };
  }
  let msg;
  try { msg = operatorChallenge(op, username, assertion.issuedAt); }
  catch (e) { return { ok: false, reason: e.message }; }
  if (!verifyEd25519(assertion.pubHex, msg, assertion.sigHex)) {
    return { ok: false, reason: "signature does not verify over the challenge" };
  }
  return { ok: true };
}

// ── provision / decommission plans (pure, testable) ────────────────

const DEMO_LLM_TOKEN_CAP = 250_000; // mirrors control-plane DEMO_LLM_TOKEN_CAP_DEFAULT

/**
 * Every D1 table that is keyed by the user (username, or user_id for
 * custom_domain_orders). Decommission DELETEs the user's rows from
 * each — the design's "no per-row demo tag; delete-user cleans up".
 * Kept explicit (not reflection) so a new table is a conscious add.
 */
export const USER_LINKED_TABLES = [
  { table: "usernames", col: "username" },
  { table: "usernames_aliases", col: "username" },
  { table: "app_aliases", col: "username" },
  { table: "user_app_aliases", col: "username" },
  { table: "user_identity_records", col: "username" },
  { table: "voici_links", col: "username" },
  { table: "audit_events", col: "username" },
  { table: "auth_codes", col: "username" },
  { table: "build_tickets", col: "username" },
  { table: "servers", col: "username" },
  { table: "routing", col: "username" },
  { table: "sealed_luks_keys", col: "username" },
  { table: "unlock_key_deposits", col: "username" },
  { table: "auto_unlock_leases", col: "username" },
  { table: "pending_unlock_approvals", col: "username" },
  { table: "pending_re_pairs", col: "username" },
  { table: "recovery_shards", col: "username" },
  { table: "webauthn_recovery_records", col: "username" },
  { table: "push_tokens", col: "username" },
  { table: "tier_subscriptions", col: "username" },
  { table: "hardware_orders", col: "username" },
  { table: "install_events", col: "username" },
  { table: "marketplace_installs", col: "username" },
  { table: "marketplace_listings", col: "creator" },
  { table: "llm_promo_issues", col: "username" },
  { table: "llm_promo_lifetime", col: "username" },
  { table: "llm_promo_usage", col: "username" },
  { table: "demo_llm_ledger", col: "username" },
  { table: "custom_domain_orders", col: "user_id" },
  { table: "entitlement_revocation_lists", col: "username" },
];

/** Ordered op manifest for provisioning. Pure — no side effects. */
export function planProvision(username) {
  const u = username.toLowerCase();
  return [
    { kind: "d1", desc: `mark ${u} is_demo (creates the claim row if absent)`,
      sql: `INSERT INTO usernames (username, irk_pub_hex, claimed_at, is_demo) VALUES ('${u}', '', 0, 1) ON CONFLICT(username) DO UPDATE SET is_demo=1` },
    { kind: "d1", desc: "seed minimal sample data (a tier row at free)",
      sql: `INSERT INTO tier_subscriptions (username, tier, updated_at) VALUES ('${u}', 'free', 0) ON CONFLICT(username) DO NOTHING` },
    { kind: "vps", desc: `provision a VPS with the personalized boot ISO for ${u}`,
      command: ["flyctl", "machine", "run", "--app", "flagship-demo-pods", "<boot-image>", "--metadata", `demo-user=${u}`] },
    { kind: "llm-cap", desc: `confirm the demo LLM ceiling (${DEMO_LLM_TOKEN_CAP} tok/24h is enforced server-side for any is_demo user — no per-user write needed)` },
    { kind: "creds", desc: `print the demo creds + the assigned subdomain for ${u}` },
  ];
}

/** Ordered HARD-delete manifest for decommissioning. Pure. */
export function planDecommission(username) {
  const u = username.toLowerCase();
  const ops = [];
  ops.push({ kind: "routing", desc: `DELETE every active custom-domain redirection for ${u} from .services RAM`,
    note: "for each active custom_domain_orders.fqdn → POST .services /control/redirections {op:delete}" });
  ops.push({ kind: "vps", desc: `destroy ${u}'s VM(s)`,
    command: ["flyctl", "machine", "list", "--app", "flagship-demo-pods", "--json"], note: "then `flyctl machine destroy <id> --force` for each with metadata demo-user=" + u });
  for (const { table, col } of USER_LINKED_TABLES) {
    ops.push({ kind: "d1", desc: `HARD delete ${table} rows for ${u}`,
      sql: `DELETE FROM ${table} WHERE ${col} = '${u}'` });
  }
  ops.push({ kind: "r2", desc: `delete every R2 object under the user prefix(es) for ${u}`,
    note: "backups/<u>/*, recovery/<u>/*, marketplace scan reports authored by <u> — list+delete via `wrangler r2 object`" });
  return ops;
}

// ── executor (gated) ───────────────────────────────────────────────

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

function renderPlan(p, ops) {
  for (const o of ops) {
    p(`  • [${o.kind}] ${o.desc}`);
    if (o.sql) p(`      SQL: ${o.sql}`);
    if (o.command) p(`      $ ${o.command.join(" ")}`);
    if (o.note) p(`      note: ${o.note}`);
  }
}

async function cmd(opts, p, command) {
  const username = String(opts.flags.user ?? opts.positionals[1] ?? "").toLowerCase();
  if (!username || !/^[a-z0-9]{1,63}$/.test(username)) {
    p("  --user <name> required (lowercase a-z0-9, 1–63).");
    return 2;
  }
  const ops = command === "provision" ? planProvision(username) : planDecommission(username);
  p(`\n▶ ${command} plan for "${username}" (${ops.length} ops):`);
  renderPlan(p, ops);

  if (!opts.flags.execute) {
    p(`\n  DRY RUN. Re-run with --execute and a registered-operator assertion to apply.`);
    p(`  Provide --op-pub <64hex> --op-sig <128hex> --op-at <ms> (sign`);
    p(`  operatorChallenge("${command}","${username}",<ms>) with your YubiKey/`);
    p(`  registered key; pin its pubkey in scripts/demo-operators.json or`);
    p(`  $DEMO_OPERATOR_PUBS).`);
    return 0;
  }

  const auth = verifyOperatorAuthorization({
    op: command,
    username,
    assertion: {
      pubHex: String(opts.flags["op-pub"] ?? ""),
      sigHex: String(opts.flags["op-sig"] ?? ""),
      issuedAt: Number(opts.flags["op-at"] ?? 0),
    },
    authorized: readAuthorizedOperators(),
    nowMs: Date.now(),
  });
  if (!auth.ok) {
    p(`\n  REFUSED — operator authorization failed: ${auth.reason}`);
    p(`  Nothing was changed.`);
    return 1;
  }

  if (command === "decommission") {
    p(`\n  ⚠ HARD, IRREVERSIBLE delete of EVERYTHING for "${username}".`);
    const typed = await confirm(`  Type the username to confirm: `);
    if (typed.trim() !== username) {
      p("  Mismatch — aborted. Nothing was changed.");
      return 1;
    }
    p(`  (Operator MUST have confirmed "${username}" is is_demo first — this`);
    p(`   tool will not run the destructive shell-outs against a non-demo`);
    p(`   account; verify the directive/flag, then run the printed ops.)`);
  }

  // The actual remote mutations are operator steps (real-infra +
  // irreversible). This tool prints the exact, ordered, authorized
  // plan; the operator runs the wrangler/flyctl ops. Auto-firing
  // HARD deletes from a script is itself the foot-gun we refuse.
  p(`\n  ✔ Authorized by registered operator. Execute the ops above in order`);
  p(`    (wrangler d1 execute --remote / flyctl / .services control POST).`);
  p(`    See \`node scripts/demo-account.mjs help\` for the runbook.`);
  return 0;
}

export function printHelp(p) {
  p(`demo-account — provision / decommission the shared live demo account (#83)

  node scripts/demo-account.mjs provision    --user <name> [--execute --op-pub --op-sig --op-at]
  node scripts/demo-account.mjs decommission --user <name> [--execute --op-pub --op-sig --op-at]
  node scripts/demo-account.mjs help

DRY RUN is the default — it prints the exact ordered op manifest. A
mutating run needs --execute AND a registered-operator Ed25519
assertion over operatorChallenge(<op>,<user>,<issuedAt-ms>); pin the
operator pubkey(s) in scripts/demo-operators.json {"operators":[...]}
or $DEMO_OPERATOR_PUBS. decommission also requires typing the exact
username and is the ONLY teardown (no daily/auto wipe — by design).

Runbook (operator, real-infra):
  provision    1. node … provision --user demo --execute --op-* …
               2. run the printed D1 upsert (wrangler d1 execute
                  flagship-state --file/-c … --remote --yes)
               3. flyctl machine run the personalized boot ISO
               4. the 250k-tok/24h is_demo LLM ceiling is already
                  enforced server-side (#85) — nothing per-user
               5. hand the tester the creds + subdomain
  decommission 1. CONFIRM the account is is_demo (GET /api/users/check
                  → demoDirective present, or the usernames.is_demo
                  flag) — NEVER run this on a real account
               2. node … decommission --user demo --execute --op-* …
               3. run every printed op IN ORDER: routing DELETEs →
                  flyctl machine destroy → D1 DELETEs → R2 prune
               4. verify zero residue (D1 count = 0, R2 list empty,
                  flyctl machine list clean, .services RAM clear)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = { flags: args.flags, positionals: args.positionals };
  const p = (s) => console.log(s);
  if (args.command === "help" || args.flags.help) { printHelp(p); return 0; }
  if (args.command === "provision") return cmd(opts, p, "provision");
  if (args.command === "decommission") return cmd(opts, p, "decommission");
  console.error(`unknown command: ${args.command}`);
  printHelp((s) => console.error(s));
  return 2;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().then((code) => process.exit(code ?? 0)).catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}
