import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAllMigrations } from "../packages/storage/tests/support/sqliteD1.js";
import { GYM, PROD, SQL, deleteCalls, getBinDir, installStub, readCalls, run } from "./wipe-all-users-harness.js";

installStub();

// ── keep list ─────────────────────────────────────────────────────────────────
// These run the script's REAL SQL (preview counts, scoped DELETEs, the verifying
// recount) against a throwaway sqlite file with every migration applied and
// foreign keys on, standing in for D1. Four accounts are seeded with one row in
// EVERY table the script wipes: the store-review account (kept by default), one
// kept by name, and two nobody keeps.

const nodeRequire = createRequire(import.meta.url);
interface Stmt {
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
  run(...p: unknown[]): unknown;
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: new (p: string) => Db };

const REVIEW = "playstore-test-0725";
const NAMED = "harry-main";
const FILE_KEPT = "qa-two";
const GONE = ["alice", "bob"];

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
function relations(x: string): Record<string, string> {
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

function insertRow(db: Db, table: string, x: string, over: Record<string, unknown> = {}) {
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

const SQL_TABLES = [...readFileSync(SQL, "utf8").matchAll(/^DELETE FROM ([a-z_]+);/gm)].map((m) => m[1]!);

/** usernames and device_identities first: the other private tables hang off them. */
function seedAccount(db: Db, x: string) {
  for (const t of ["usernames", "device_identities"]) insertRow(db, t, x);
  for (const t of SQL_TABLES) if (t !== "usernames" && t !== "device_identities") insertRow(db, t, x);
}

let fixtureDir = "";
let baseDb = "";
let workDb = "";

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "wipe-fixture-"));
  baseDb = join(fixtureDir, "base.db");
  const db = new DatabaseSync(baseDb);
  applyAllMigrations(db as never);
  for (const x of [REVIEW, NAMED, FILE_KEPT, ...GONE]) seedAccount(db, x);
  db.close();
}, 60_000);

afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

/** A fresh copy of the seeded database for one test, opened with FKs on. */
function freshDb(): Db {
  workDb = join(fixtureDir, `work-${Math.random().toString(36).slice(2)}.db`);
  copyFileSync(baseDb, workDb);
  const db = new DatabaseSync(workDb);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function runKeep(args: string[], env: Record<string, string> = {}) {
  return run(args, { ...GYM, WIPE_STUB_DB: workDb, ...env });
}

function count(db: Db, table: string): number {
  return Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
}

function allCounts(db: Db): Record<string, number> {
  return Object.fromEntries(SQL_TABLES.map((t) => [t, count(db, t)]));
}

/** The preview table the script prints: table -> {scope,total,keep,delete}. */
function parsePreview(out: string) {
  const rows: Record<string, { scope: string; total: number; keep: number; del: number }> = {};
  for (const m of out.matchAll(/^ {2}([a-z_]+) +(by account|wipe all|keep all) +(\d+) +(\d+) +(\d+)$/gm)) {
    rows[m[1]!] = { scope: m[2]!, total: Number(m[3]), keep: Number(m[4]), del: Number(m[5]) };
  }
  return rows;
}

const KEEP_WHOLE = ["boot_nonces", "meter_batches", "share_inbox", "stripe_events"];
const WIPE_WHOLE = ["nfc_rendezvous", "qr_pipe_metrics", "username_suggest_throttle"];

describe("wipe-all-users.sh — keep list", () => {
  it("refuses an empty keep file, an unreadable one, a blank WIPE_KEEP and bad names (fail closed)", () => {
    const empty = join(getBinDir(), "empty.txt");
    writeFileSync(empty, "# nobody here\n\n   \n");
    for (const args of [["--keep-file", empty], ["--keep-file", join(getBinDir(), "missing.txt")]]) {
      const r = run(args, GYM);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/keep file .* (names nobody|missing or unreadable)/);
    }
    expect(run([], { ...GYM, WIPE_KEEP: "" }).code).toBe(1);
    expect(run([], { ...GYM, WIPE_KEEP: " , " }).stderr).toContain("names nobody");
    expect(run(["--keep", ""], GYM).code).toBe(1);
    expect(run([], { ...GYM, WIPE_KEEP: "ok'; DROP TABLE usernames;--" }).stderr).toContain("not a valid username");
    // with the default switched off and nobody named there is nothing to keep
    const none = run([], { ...GYM, WIPE_KEEP_DEFAULT: "0" });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("keep list is empty");
    // none of that touched a database
    expect(readCalls()).toBe("");
  });

  it("an empty keep file refuses even with --yes and a matching WIPE_CONFIRM", () => {
    const empty = join(getBinDir(), "empty.txt");
    writeFileSync(empty, "\n");
    const r = run(["--yes", "--keep-file", empty], { ...GYM, WIPE_CONFIRM: "gym" });
    expect(r.code).toBe(1);
    expect(deleteCalls()).toHaveLength(0);
  });

  it("WIPE_LOCAL is refused for the prod env", () => {
    const r = run([], { ...PROD, WIPE_LOCAL: "1" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("WIPE_LOCAL=1");
  });

  it("--help says demo accounts stay a feature, old sample users can go, and only the keep list survives", () => {
    const r = run(["--help"]);
    expect(r.stdout).toContain("Demo / evaluation accounts remain available as a FEATURE");
    expect(r.stdout).toContain("pre-GA demo sample users CAN be wiped");
    expect(r.stdout).toContain("Only");
    expect(r.stdout).toContain("the keep list survives");
    expect(r.stdout).toContain(REVIEW);
  });

  it("dry run: default keep only, per-table keep/delete counts, and it writes NOTHING", () => {
    const db = freshDb();
    const before = allCounts(db);
    const r = runKeep([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(r.stdout).toContain(`keep     ${REVIEW}`);
    const p = parsePreview(r.stdout);
    expect(Object.keys(p).sort()).toEqual([...new Set(SQL_TABLES)].sort());
    // five accounts seeded, one kept by default
    expect(p.usernames).toEqual({ scope: "by account", total: 5, keep: 1, del: 4 });
    expect(p.servers).toMatchObject({ total: 5, keep: 1, del: 4 });
    expect(p.meter_counters).toMatchObject({ total: 5, keep: 1, del: 4 });
    for (const t of KEEP_WHOLE) expect(p[t]).toMatchObject({ scope: "keep all", del: 0 });
    for (const t of WIPE_WHOLE) expect(p[t]).toMatchObject({ scope: "wipe all", keep: 0, del: p[t]!.total });
    // read-only: no statement but SELECT ever reached the database, and nothing changed
    const log = readCalls();
    expect(log).not.toMatch(/DELETE|INSERT|UPDATE|DROP|ALTER/);
    expect(allCounts(db)).toEqual(before);
    db.close();
  }, 120_000);

  it("--list-accounts marks who stays and who goes, still read-only", () => {
    const db = freshDb();
    const r = runKeep(["--list-accounts", "--keep", NAMED]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`KEEP +${REVIEW}`));
    expect(r.stdout).toMatch(new RegExp(`KEEP +${NAMED}`));
    expect(r.stdout).toMatch(/delete +alice/);
    expect(r.stdout).toMatch(/delete +bob/);
    expect(readCalls()).not.toMatch(/DELETE|INSERT|UPDATE/);
    db.close();
  }, 120_000);

  it("a name you type that does not exist is a typo: refuses, deletes nothing; the default may be absent", () => {
    const db = freshDb();
    db.exec(`DELETE FROM usernames WHERE username = '${REVIEW}'`);
    const ok = runKeep([]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(`absent   ${REVIEW}`);
    const typo = runKeep(["--yes", "--keep", "harry-mian"], { WIPE_CONFIRM: "gym" });
    expect(typo.code).toBe(1);
    expect(typo.stdout).toContain("MISSING  harry-mian");
    expect(typo.stderr).toContain("do not exist");
    expect(deleteCalls()).toHaveLength(0);
    db.close();
  }, 120_000);

  it("real run: the default, WIPE_KEEP and the keep file all survive WHOLE in every table; everyone else is gone", () => {
    const db = freshDb();
    const before = allCounts(db);
    const file = join(getBinDir(), "keep.txt");
    writeFileSync(file, `# the QA account\n${FILE_KEPT.toUpperCase()}   # shouty on purpose\n\n`);
    const r = runKeep(["--yes", "--keep-file", file], { WIPE_CONFIRM: "gym", WIPE_KEEP: NAMED });
    expect(r.stdout).toContain("WIPE DONE");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("0 with leftovers");

    const kept = [REVIEW, NAMED, FILE_KEPT];
    const sqlText = readFileSync(SQL, "utf8");
    const preserved = sqlText.match(/^-- PRESERVED-TABLES: (.+)$/m)![1]!.trim().split(/\s+/);
    expect(preserved).not.toContain("usernames");
    for (const t of SQL_TABLES) {
      const n = count(db, t);
      if (KEEP_WHOLE.includes(t)) expect(n, t).toBe(before[t]);
      else if (WIPE_WHOLE.includes(t)) expect(n, t).toBe(0);
      else expect(n, `${t}: one row per kept account`).toBe(kept.length);
    }
    // and they are the RIGHT rows: nothing that mentions a wiped account is left
    const accounts = db.prepare("SELECT username FROM usernames ORDER BY username").all().map((r) => r.username);
    expect(accounts).toEqual([...kept].sort());
    const servers = db.prepare("SELECT username FROM servers ORDER BY username").all().map((r) => r.username);
    expect(servers).toEqual([...kept].sort());
    expect(count(db, "device_identities")).toBe(3);
    for (const g of GONE) {
      for (const t of ["daemon_status", "box_sealed_leases", "install_events", "pb_leases", "service_invites", "server_share_unlocks", "marketplace_installs"]) {
        expect(count(db, t), t).toBe(3);
      }
      expect(db.prepare("SELECT count(*) AS n FROM secret_mailbox WHERE username = ?").get(g)!.n).toBe(0);
    }
    expect(r.stdout).toContain(`keep=`);
    db.close();
  }, 240_000);

  it("rows tied to a kept account only through a secondary key survive; the same shapes for a wiped account go", () => {
    const db = freshDb();
    const k = relations(REVIEW);
    const a = relations("alice");
    // each extra row names a stranger in its username-ish column and links by the other key
    const extras: Array<[string, (r: Record<string, string>, tag: string) => Record<string, unknown>]> = [
      ["box_serials", (r, tag) => ({ serial: `X-${tag}`, stk_pub_hex: r.stk_pub_hex })],
      ["server_transfers", (r, tag) => ({ server_domain: `elsewhere-${tag}`, giver_username: "stranger", acquirer_username: r.username })],
      ["service_invites", (r, tag) => ({ invite_id: `extra-${tag}`, author_aid: "ff".repeat(32), creator_pub_hex: r.device_pub_hex, secret_hash: `sh-${tag}` })],
      ["marketplace_installs", (r, tag) => ({ creator: "stranger", puller_irk_pub_hex: r.aid_pub_hex, slug: `s-${tag}` })],
      ["pb_token_serials", (r, tag) => ({ serial_sha256: `ser-${tag}`, pik_pub_hex: r.pik_pub_hex })],
      ["pb_leases", (r, tag) => ({ lease_id: `l-${tag}`, pik_pub_hex: r.pik_pub_hex })],
      ["server_share_unlocks", (r, tag) => ({ share_id: r.share_id, server_domain: `other-${tag}` })],
      ["provision_status", (r, tag) => ({ serial: r.serial + "-b", server_domain: r.server_domain, detail: tag })],
      ["secret_mailbox", (r, tag) => ({ username: "stranger", server_domain: r.server_domain, request_nonce_hex: `n-${tag}` })],
      ["audit_events", (r) => ({ username: r.username })],
    ];
    const tables = extras.map(([t]) => t);
    const before = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
    // server_share_unlocks is unique per share_id, so the kept account's extra uses a second share
    for (const [t, make] of extras) {
      if (t === "server_share_unlocks") {
        db.exec("DELETE FROM server_share_unlocks");
        insertRow(db, "server_share_unlocks", REVIEW, make(k as never, "k") as never);
        insertRow(db, "server_share_unlocks", "alice", make(a as never, "a") as never);
        continue;
      }
      insertRow(db, t, REVIEW, make(k, "k"));
      insertRow(db, t, "alice", make(a, "a"));
    }
    // the service_invite_bindings of the extra invite hang off its invite_id
    insertRow(db, "service_invite_bindings", REVIEW, { invite_id: "extra-k", aid: "k-bound" });
    insertRow(db, "service_invite_bindings", "alice", { invite_id: "extra-a", aid: "a-bound" });

    const r = runKeep(["--yes"], { WIPE_CONFIRM: "gym" });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const left = (t: string, col: string, val: string) =>
      Number(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE ${col} = ?`).get(val)!.n);
    expect(left("box_serials", "serial", "X-k")).toBe(1);
    expect(left("box_serials", "serial", "X-a")).toBe(0);
    expect(left("server_transfers", "server_domain", "elsewhere-k")).toBe(1);
    expect(left("server_transfers", "server_domain", "elsewhere-a")).toBe(0);
    expect(left("service_invites", "invite_id", "extra-k")).toBe(1);
    expect(left("service_invites", "invite_id", "extra-a")).toBe(0);
    expect(left("service_invite_bindings", "invite_id", "extra-k")).toBe(1);
    expect(left("service_invite_bindings", "invite_id", "extra-a")).toBe(0);
    expect(left("marketplace_installs", "slug", "s-k")).toBe(1);
    expect(left("marketplace_installs", "slug", "s-a")).toBe(0);
    expect(left("pb_token_serials", "serial_sha256", "ser-k")).toBe(1);
    expect(left("pb_token_serials", "serial_sha256", "ser-a")).toBe(0);
    expect(left("pb_leases", "lease_id", "l-k")).toBe(1);
    expect(left("pb_leases", "lease_id", "l-a")).toBe(0);
    expect(left("server_share_unlocks", "server_domain", "other-k")).toBe(1);
    expect(left("server_share_unlocks", "server_domain", "other-a")).toBe(0);
    expect(left("provision_status", "serial", `${k.serial}-b`)).toBe(1);
    expect(left("provision_status", "serial", `${a.serial}-b`)).toBe(0);
    expect(left("secret_mailbox", "request_nonce_hex", "n-k")).toBe(1);
    expect(left("secret_mailbox", "request_nonce_hex", "n-a")).toBe(0);
    db.close();
  }, 240_000);

  it("a table absent in the target is skipped, not fatal; a table that cannot be scoped stops the run before any delete", () => {
    const db = freshDb();
    db.exec("DROP TABLE nfc_rendezvous");
    const dry = runKeep([]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toMatch(/nfc_rendezvous +wipe all +absent in this database/);
    db.exec("ALTER TABLE service_invites DROP COLUMN creator_pub_hex");
    const real = runKeep(["--yes"], { WIPE_CONFIRM: "gym" });
    expect(real.code).toBe(1);
    expect(real.stdout).toContain("could not scope");
    expect(real.stderr).toContain("could not be scoped to the keep list");
    expect(readCalls()).not.toMatch(/DELETE FROM/);
    expect(count(db, "usernames")).toBe(5);
    db.close();
  }, 240_000);

  it("every table in the wipe list has a scope rule (the script refuses a table it cannot scope)", () => {
    const r = run([], GYM);
    expect(r.stderr).not.toContain("has no rule");
    expect(r.code).toBe(0);
  });
});
