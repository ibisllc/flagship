/**
 * The names registry (docs/voici-namespace-spec.md, migration 0127): every claim path — account names, custom link
 * names, codes, reserved words — goes through one table whose partial UNIQUE index on the safety key is the only
 * collision check. Each case runs against the D1 adapter (node:sqlite with every migration applied) and the in-memory
 * store, which must agree. The spec's acceptance tests that live at this level carry their number (T2 ...).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1, type SqliteD1 } from "./support/sqliteD1.js";
import {
  D1Storage,
  InMemoryStorage,
  NAME_HOLD_MS,
  type NameRegistryStorage,
  type Storage,
  type UsernameRecord,
} from "../src/index.js";

const DAY = 86_400_000;
const IRK_A = "aa".repeat(32);
const IRK_B = "bb".repeat(32);
const user = (username: string, irkPubHex = IRK_A, claimedAt = 1000): UsernameRecord => ({ username, irkPubHex, claimedAt });
const link = (name: string, username = "plucky-avocet", serviceId = `${username}--party`, at = 2000) => ({
  key: name, display: name, username, serviceId, state: "live" as const, setAt: at, lastActiveAt: at, warned: 0,
});
const code = (c: string, username = "plucky-avocet", serviceId?: string) => ({
  code: c, username, ...(serviceId ? { serviceId } : {}), targetUrl: `https://x.${username}.flagship.services`, createdAt: 3000,
});

let open: SqliteD1[] = [];
afterEach(() => {
  for (const d of open) d.close();
  open = [];
});

const RESERVED = ["admin", "support", "api"];

function adapters(): Array<[string, () => Promise<Storage & { names: NameRegistryStorage }>]> {
  return [
    ["D1", async () => {
      const db = createSqliteD1();
      open.push(db);
      const s = new D1Storage(db);
      return s;
    }],
    ["in memory", async () => {
      const s = new InMemoryStorage();
      await s.names.addReserved(RESERVED, 0);
      return s;
    }],
  ];
}

for (const [label, make] of adapters()) {
  describe(`names registry (${label})`, () => {
    it("T2/T3: a username blocks its look-alikes as usernames (hyphens, 1→l)", async () => {
      const s = await make();
      expect(await s.usernames.put(user("plucky-avocet"))).toEqual({ ok: true });
      expect(await s.usernames.put(user("pluckyavocet", IRK_B))).toEqual({ ok: false, reason: "taken" });
      expect(await s.usernames.put(user("p1ucky-avocet", IRK_B))).toEqual({ ok: false, reason: "taken" });
      expect(await s.usernames.get("pluckyavocet")).toBeUndefined();
    });

    it("a re-claim by the same IRK succeeds; another IRK on the same name is refused", async () => {
      const s = await make();
      expect(await s.usernames.put(user("plucky-avocet"))).toEqual({ ok: true });
      expect(await s.usernames.put(user("plucky-avocet", IRK_A, 5000))).toEqual({ ok: true });
      expect(await s.usernames.put(user("plucky-avocet", IRK_B, 6000))).toEqual({ ok: false, reason: "taken" });
      expect((await s.usernames.get("plucky-avocet"))?.irkPubHex).toBe(IRK_A);
      expect((await s.names.lookup("plucky-avocet"))?.kind).toBe("username");
    });

    it("T4: a username blocks the same link name", async () => {
      const s = await make();
      await s.usernames.put(user("plucky-avocet"));
      expect(await s.voiciNames.claim(link("plucky-avocet", "rapid-bison"))).toEqual({ ok: false, reason: "taken" });
      expect(await s.voiciNames.claim(link("pluckyavocet", "rapid-bison"))).toEqual({ ok: false, reason: "taken" });
    });

    it("T5/T6: 50cent is a username; the link name 5ocent is refused (0→o)", async () => {
      const s = await make();
      expect(await s.usernames.put(user("50cent"))).toEqual({ ok: true });
      expect(await s.voiciNames.claim(link("5ocent", "rapid-bison"))).toEqual({ ok: false, reason: "taken" });
      expect((await s.names.lookup("50cent"))?.kind).toBe("username");
    });

    it("a link name blocks usernames and codes with its safety key (chess-club, chessclub, chess-c1ub)", async () => {
      const s = await make();
      expect(await s.voiciNames.claim(link("chess-club"))).toEqual({ ok: true });
      expect(await s.usernames.put(user("chessclub", IRK_B))).toEqual({ ok: false, reason: "taken" });
      expect(await s.voiciNames.claim(link("chess-c1ub", "rapid-bison"))).toEqual({ ok: false, reason: "taken" });
      expect((await s.voiciLinks.insert(code("chessclub"))).ok).toBe(false);
    });

    it("T11: a retired code blocks it as a link name or a username, for good", async () => {
      const s = await make();
      expect(await s.voiciLinks.insert(code("3k9x2q", "plucky-avocet", "plucky-avocet--party"))).toEqual({ ok: true });
      expect(await s.voiciLinks.retireByService("plucky-avocet", "plucky-avocet--party", 4000)).toBe(1);
      expect((await s.voiciLinks.get("3k9x2q"))?.retiredAt).toBe(4000);
      expect(await s.voiciNames.claim(link("3k9x2q", "rapid-bison"))).toEqual({ ok: false, reason: "taken" });
      expect(await s.usernames.put(user("3k9x2q", IRK_B))).toEqual({ ok: false, reason: "taken" });
      expect((await s.voiciLinks.insert(code("3k9x2q", "rapid-bison"))).ok).toBe(false);
      expect(await s.names.releaseExpiredHolds(4000 + 1000 * DAY)).toBe(0);
      expect(await s.names.isTaken("3k9x2q")).toBe(true);
    });

    it("T14 (registry level): a rename holds the old name; nobody else can claim it", async () => {
      const s = await make();
      await s.usernames.put(user("alice"));
      expect(await s.names.renameUsername("alice", "alice-smith", 10_000)).toEqual({ ok: true });
      const old = await s.names.lookup("alice");
      expect(old).toMatchObject({ kind: "username", status: "held", owner: "alice", heldUntil: 10_000 + NAME_HOLD_MS });
      expect((await s.names.activeUsername("alice"))?.name).toBe("alice-smith");
      expect(await s.usernames.put(user("alice", IRK_B, 11_000))).toEqual({ ok: false, reason: "taken" });
      expect(await s.voiciNames.claim(link("a1ice", "rapid-bison"))).toEqual({ ok: false, reason: "taken" });
    });

    it("a rename to a taken name changes nothing", async () => {
      const s = await make();
      await s.usernames.put(user("alice"));
      await s.usernames.put(user("bobby", IRK_B));
      expect(await s.names.renameUsername("alice", "b0bby", 10_000)).toEqual({ ok: false, reason: "taken" });
      expect((await s.names.activeUsername("alice"))?.name).toBe("alice");
      expect((await s.names.lookup("alice"))?.status).toBe("active");
      expect(await s.names.renameUsername("nobody-here", "fresh", 10_000)).toEqual({ ok: false, reason: "no-account" });
    });

    it("T17 + T15: a deleted account's name is held 30 days (nobody may claim it), then released to anyone", async () => {
      const s = await make();
      await s.usernames.put(user("alice"));
      await s.voiciNames.claim(link("alices-party", "alice", "alice--party"));
      await s.voiciLinks.insert(code("7abcde", "alice", "alice--party"));
      const at = 50_000;
      expect(await s.usernames.delete("alice", at)).toBe(true);
      expect(await s.usernames.get("alice")).toBeUndefined();
      expect(await s.names.lookup("alice")).toMatchObject({ status: "held", heldUntil: at + 30 * DAY });
      expect(await s.names.activeUsername("alice")).toBeUndefined();
      expect((await s.voiciNames.get("alices-party"))?.state).toBe("retired");
      expect((await s.voiciLinks.get("7abcde"))?.retiredAt).toBe(at);
      // During the hold: refused for everyone, the previous owner's key included (no priority, clarification 1).
      expect(await s.usernames.put(user("alice", IRK_B, at + DAY))).toEqual({ ok: false, reason: "taken" });
      expect(await s.usernames.put(user("alice", IRK_A, at + DAY))).toEqual({ ok: false, reason: "taken" });
      expect(await s.names.releaseExpiredHolds(at + 30 * DAY - 1)).toBe(0);
      expect(await s.names.releaseExpiredHolds(at + 30 * DAY)).toBe(1);
      expect(await s.names.lookup("alice")).toBeUndefined();
      // After the job: a brand-new row for whoever claims it first.
      expect(await s.usernames.put(user("alice", IRK_B, at + 31 * DAY))).toEqual({ ok: true });
      const fresh = await s.names.lookup("alice");
      expect(fresh).toMatchObject({ status: "active", owner: "alice", createdAt: at + 31 * DAY });
      // The link name and the code stay blocked for good (D7).
      expect(await s.voiciNames.claim(link("alices-party", "alice", "alice--party", at + 31 * DAY))).toEqual({ ok: false, reason: "taken" });
      expect((await s.voiciLinks.insert(code("7abcde", "alice"))).ok).toBe(false);
    });

    it("T18: two concurrent claims of one name (or two look-alikes, across kinds): exactly one succeeds", async () => {
      const s = await make();
      const same = await Promise.all([s.usernames.put(user("chess-club", IRK_A)), s.usernames.put(user("chess-club", IRK_B))]);
      expect(same.filter((r) => r.ok)).toHaveLength(1);
      const alike = await Promise.all([
        s.usernames.put(user("night-owl", IRK_A)),
        s.usernames.put(user("nightowl", IRK_B)),
        s.voiciNames.claim(link("night-0wl", "rapid-bison")),
        s.voiciLinks.insert(code("nightowl", "rapid-bison")),
      ]);
      expect(alike.filter((r) => r.ok)).toHaveLength(1);
    });

    it("T19: reserved words and their look-alikes are refused as usernames and link names", async () => {
      const s = await make();
      for (const n of ["admin", "ad-min", "supp0rt"]) {
        expect(await s.usernames.put(user(n, IRK_B)), n).toEqual({ ok: false, reason: "taken" });
        expect(await s.voiciNames.claim(link(n, "rapid-bison")), n).toEqual({ ok: false, reason: "taken" });
      }
      expect((await s.names.lookup("admin"))?.kind).toBe("reserved");
    });

    it("addReserved() inserts new words and reports one already held (the holder keeps it)", async () => {
      const s = await make();
      await s.usernames.put(user("official-news"));
      const r = await s.names.addReserved(["admin", "officialnews", "brand-new-word"], 7);
      expect(r).toEqual({ added: ["brand-new-word"], conflicts: ["officialnews"] });
      expect((await s.names.lookup("official-news"))?.kind).toBe("username");
      expect(await s.usernames.put(user("brandnewword", IRK_B))).toEqual({ ok: false, reason: "taken" });
    });

    it("isTaken() answers on the safety key; lookup() matches the exact name only", async () => {
      const s = await make();
      await s.usernames.put(user("plucky-avocet"));
      expect(await s.names.isTaken("pluckyavocet")).toBe(true);
      expect(await s.names.isTaken("Pluckyavocet")).toBe(true);
      expect(await s.names.isTaken("plucky-badger")).toBe(false);
      expect(await s.names.lookup("pluckyavocet")).toBeUndefined();
    });

    it("account provisioning claims the name in the same transaction", async () => {
      const s = await make();
      await s.voiciNames.claim(link("taken-elsewhere", "rapid-bison"));
      const init = await s.accountProvisioning.initialize({
        username: { username: "takenelsewhere", irkPubHex: IRK_A, claimedAt: 1, adminRootPubHex: "cc".repeat(32) },
        primaryDevice: { accountId: "takenelsewhere", deviceId: "d1", devicePubHex: "dd".repeat(32), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null },
        primaryGrant: { grantId: "g1", username: "takenelsewhere", deviceId: "d1", devicePubHex: "dd".repeat(32), scopesJson: "[]", issuedAt: 1, expiresAt: 2, signatureHex: "ee".repeat(64), revokedAt: null, signerRoot: "admin-root" },
        accountProfile: { accountId: "takenelsewhere", revision: 1, keyVersion: 1, nonceHex: "00", ciphertextHex: "00", signerPubHex: "00", signatureHex: "00", issuedAt: 1, updatedAt: 1 },
        primaryDeviceProfile: { accountId: "takenelsewhere", deviceId: "d1", revision: 1, keyVersion: 1, nonceHex: "00", ciphertextHex: "00", signerPubHex: "00", signatureHex: "00", issuedAt: 1, updatedAt: 1 },
      } as never);
      expect(init.ok).toBe(false);
      expect(await s.usernames.get("takenelsewhere")).toBeUndefined();
    });
  });
}

// ── migration 0127 against data shaped like production and the gym ─────────

describe("migration 0127", () => {
  const before = (f: string) => f < "0127";
  const after = (f: string) => f >= "0127";
  const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

  function seeded(): SqliteD1 {
    const db = createSqliteD1(undefined, before);
    open.push(db);
    const ins = (u: string, at: number) =>
      db.raw.prepare("INSERT INTO usernames (username, irk_pub_hex, claimed_at) VALUES (?, ?, ?)").run(u, IRK_A, at);
    ins("plucky-avocet", 10);
    ins("playstore-test-0725", 20);
    ins("openai-build", 30);
    ins("openaibuild", 40); // the gym's one safety-key duplicate: the older claim keeps the row
    ins("official", 50); // an existing user on a reserved word keeps it
    db.raw.prepare("INSERT INTO voici_links (code, username, service_id, target_url, created_at) VALUES ('hllo0x', 'plucky-avocet', 'plucky-avocet--a', 'https://a', 60)").run();
    db.raw.prepare("INSERT INTO voici_links (code, username, service_id, target_url, created_at, retired_at) VALUES ('9z9z9z', 'plucky-avocet', 'plucky-avocet--b', 'https://b', 61, 70)").run();
    db.raw.prepare("INSERT INTO voici_names (key, display, username, service_id, state, set_at, last_active_at) VALUES ('halloweenparty', 'halloween-party', 'plucky-avocet', 'plucky-avocet--a', 'live', 80, 90)").run();
    db.raw.prepare("INSERT INTO voici_names (key, display, username, service_id, state, set_at, last_active_at, released_at, release_reason) VALUES ('oldparty', 'old-party', 'plucky-avocet', 'plucky-avocet--b', 'waiting', 81, 81, 85, 'cleared')").run();
    return db;
  }

  function migrate(db: SqliteD1) {
    for (const f of ["0127_names_registry.sql"]) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n");
      for (const stmt of sql.split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) db.raw.exec(stmt);
    }
  }

  const rows = (db: SqliteD1) =>
    db.raw.prepare("SELECT name, kind, status, owner FROM names WHERE kind <> 'reserved' ORDER BY id").all() as Array<{ name: string; kind: string; status: string; owner: string }>;

  it("copies usernames (oldest first), codes and link names, never renames, and reserves last", async () => {
    const db = seeded();
    migrate(db);
    expect(rows(db)).toEqual([
      { name: "plucky-avocet", kind: "username", status: "active", owner: "plucky-avocet" },
      { name: "playstore-test-0725", kind: "username", status: "active", owner: "playstore-test-0725" },
      { name: "openai-build", kind: "username", status: "active", owner: "openai-build" },
      { name: "official", kind: "username", status: "active", owner: "official" },
      { name: "hllo0x", kind: "code", status: "active", owner: "plucky-avocet" },
      { name: "9z9z9z", kind: "code", status: "retired", owner: "plucky-avocet" },
      { name: "halloween-party", kind: "link", status: "active", owner: "plucky-avocet" },
      { name: "old-party", kind: "link", status: "retired", owner: "plucky-avocet" },
    ]);
    // Nobody is renamed: both gym accounts keep their usernames rows.
    const accounts = db.raw.prepare("SELECT username FROM usernames ORDER BY username").all() as Array<{ username: string }>;
    expect(accounts.map((a) => a.username)).toContain("openaibuild");
    // "official" stays the user's; the other reserved words are in.
    const reserved = db.raw.prepare("SELECT name FROM names WHERE kind = 'reserved'").all() as Array<{ name: string }>;
    expect(reserved.map((r) => r.name)).not.toContain("official");
    expect(reserved.map((r) => r.name)).toContain("admin");
    const s = new D1Storage(db);
    expect((await s.voiciLinks.get("hllo0x"))?.serviceId).toBe("plucky-avocet--a");
    expect((await s.voiciNames.get("halloween-party"))?.lastActiveAt).toBe(90);
    expect((await s.voiciNames.get("old-party"))?.state).toBe("retired");
    expect((await s.voiciLinks.get("9z9z9z"))?.retiredAt).toBe(70);
  });

  it("is re-runnable: a second run adds nothing", () => {
    const db = seeded();
    migrate(db);
    const n = (db.raw.prepare("SELECT COUNT(*) AS n FROM names").get() as { n: number }).n;
    migrate(db);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM names").get() as { n: number }).n).toBe(n);
  });

  it("seeds exactly the reserved words of the config file", () => {
    const cfg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "control-plane", "src", "reservedNames.json"), "utf8"),
    ) as { words: string[] };
    const db = createSqliteD1(undefined, (f) => before(f) || after(f));
    open.push(db);
    const reserved = (db.raw.prepare("SELECT name FROM names WHERE kind = 'reserved' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(reserved).toEqual([...cfg.words].sort());
  });
});
