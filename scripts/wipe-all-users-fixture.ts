import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyAllMigrations } from "../packages/storage/tests/support/sqliteD1.js";

// Seeds a throwaway sqlite/D1 file with one row in EVERY table the pre-GA wipe
// script deletes from, for several accounts, so the keep list can be rehearsed
// (scripts/wipe-all-users-keep.test.ts) or tried against a local wrangler D1:
//   npx tsx scripts/wipe-all-users-fixture.ts <file.sqlite> [--migrate]
// It only ever opens the file you name. Never point it at anything but a copy.

const nodeRequire = createRequire(import.meta.url);
export interface Stmt {
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
  run(...p: unknown[]): unknown;
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
export const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (p: string) => Db };

export const REVIEW = "playstore-test-0725";
export const NAMED = "harry-main";
export const FILE_KEPT = "qa-two";
export const GONE = ["alice", "bob"];

const ENUMS: Record<string, Record<string, string | number>> = {
  auth_codes: { status: "active" },
  custom_domain_orders: { status: "pending" },
  hardware_orders: { tier: "tiny", status: "placed" },
  tier_subscriptions: { tier: "free" },
  demo_users: { state: "ready" },
  push_tokens: { platform: "apns" },
  account_directory_key_grants: { key_kind: "account-profile" },
  device_capability_grants: { signer_root: "membership" },
  device_managed_profiles: { locked: 0 },
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The identity an account's rows carry, by the column names the tables use. */
export function relations(x: string): Record<string, string> {
  const hx = (s: string) => sha(`${x}|${s}`);
  const server = `box.${x}.flagship.services`;
  const devid = hx("devid").slice(0, 32);
  return {
    username: x, account_id: x, owner_username: x, giver_username: x,
    acquirer_username: `${x}-peer`, user_id: x, creator: x, account: x,
    redeemed_by: x, name: x, old_username: x, new_username: `${x}-renamed`,
    server_domain: server, pod_canonical: server, subdomain: server,
    active_server_fqdn: server, new_server_domain: server,
    serial: `SER-${x}`,
    irk_pub_hex: hx("irk"), aid_pub_hex: hx("aid"), admin_root_pub_hex: hx("admin"),
    identity_pubkey_hex: hx("stk"), stk_pub_hex: hx("stk"),
    device_pub_hex: hx("dev"), device_id: devid, recipient_device_id: devid,
    author_aid: hx("aid"), creator_pub_hex: hx("aid"), puller_irk_pub_hex: hx("aid"),
    pik_pub_hex: hx("pik"), share_id: `share-${x}`, invite_id: `inv-${x}`,
    username_hash: sha(`flagship/userIdHash/v1|${x}|flagship.v1`),
  };
}

export function insertRow(db: Db, table: string, x: string, over: Record<string, unknown> = {}) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; pk: number }>;
  const pkCount = cols.filter((c) => c.pk > 0).length;
  const rel: Record<string, unknown> = { ...relations(x), ...(ENUMS[table] ?? {}), ...over };
  const names: string[] = [];
  const vals: unknown[] = [];
  for (const c of cols) {
    if (c.pk === 1 && pkCount === 1 && /INT/i.test(c.type)) continue;
    names.push(c.name);
    let v: unknown;
    if (c.name in rel) v = rel[c.name];
    else if (c.name === "signature_hex") v = sha(`${x}${table}1`) + sha(`${x}${table}2`);
    else if (c.name === "nonce_hex") v = sha(`${x}${table}n`).slice(0, 24);
    else if (c.name === "signer_pub_hex") v = sha(`${x}${table}s`);
    else if (/INT/i.test(c.type) || /REAL/i.test(c.type)) v = 1;
    else if (/BLOB/i.test(c.type)) v = new Uint8Array([1]);
    else v = `${x}:${table}:${c.name}`;
    vals.push(v);
  }
  db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...vals);
}

export const SQL_TABLES = [...readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "wipe-all-users-prerelease-2026-06-02.sql"), "utf8").matchAll(/^DELETE FROM ([a-z_]+);/gm)].map((m) => m[1]!);

/** usernames and device_identities first: the other private tables hang off them. */
export function seedAccount(db: Db, x: string) {
  for (const t of ["usernames", "device_identities"]) insertRow(db, t, x);
  for (const t of SQL_TABLES) if (t !== "usernames" && t !== "device_identities") insertRow(db, t, x);
}


/** Seed the five fixture accounts (the review login, three more and two nobody keeps). */
export function seedFixture(db: Db) {
  for (const x of [REVIEW, NAMED, FILE_KEPT, ...GONE]) seedAccount(db, x);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: npx tsx scripts/wipe-all-users-fixture.ts <file.sqlite> [--migrate]");
    process.exit(2);
  }
  const db = new DatabaseSync(file);
  if (process.argv.includes("--migrate")) applyAllMigrations(db as never);
  seedFixture(db);
  db.close();
  console.log(`seeded ${[REVIEW, NAMED, FILE_KEPT, ...GONE].join(", ")} into ${file}`);
}
