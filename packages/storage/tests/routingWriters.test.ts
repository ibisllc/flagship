import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { D1RoutingStorage, type D1Database } from "../src/index.js";
import { createSqliteD1 } from "./support/sqliteD1.js";

// A name's RCK decides who may point it at a box. Every statement that writes the routing table is
// listed here with the guard it must carry; adding another fails this test until it is reviewed.
const REPO = join(__dirname, "../../..");
const SCAN = ["packages/storage/src", "packages/control-plane/src", "apps/com/src", "apps/web/src", "packages/server-daemon/src"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === "dist") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.ts$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}

const WRITE = /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+routing\b/gi;

describe("routing-table writers", () => {
  it("are exactly the four reviewed statements, each with its guard", () => {
    const found: Array<{ file: string; kind: string; text: string }> = [];
    for (const dir of SCAN) {
      for (const f of files(join(REPO, dir))) {
        const src = readFileSync(f, "utf8");
        for (const m of src.matchAll(WRITE)) {
          const rest = src.slice(m.index!, m.index! + 700);
          const end = rest.indexOf("`");
          found.push({ file: f.slice(REPO.length + 1), kind: m[1]!.replace(/\s+/g, " ").toUpperCase(), text: rest.slice(0, end > 0 ? end : 700) });
        }
      }
    }
    expect(found.map((x) => `${x.file} ${x.kind}`).sort()).toEqual(
      [
        "packages/storage/src/d1.ts DELETE FROM",
        "packages/storage/src/d1.ts INSERT INTO",
        "packages/storage/src/d1.ts UPDATE",
        "packages/storage/src/d1.ts UPDATE",
      ].sort(),
    );
    const by = (kind: string, needle: string) => found.find((x) => x.kind === kind && x.text.includes(needle))!;
    // Register may only touch a name whose RCK is the same.
    expect(by("INSERT INTO", "ON CONFLICT").text).toMatch(/WHERE routing\.rck_pubkey_hex = excluded\.rck_pubkey_hex/);
    // Swapping the RCK is allowed only for the same account, before any target exists, and to a different key.
    const swap = by("UPDATE", "rck_pubkey_hex = ?").text;
    expect(swap).toMatch(/username = \?/);
    expect(swap).toMatch(/current_target_hex = ''/);
    expect(swap).toMatch(/rck_pubkey_hex <> \?/);
    // A target moves only forward (a newer nonce).
    expect(by("UPDATE", "current_target_hex = ?").text).toMatch(/last_target_nonce < \?/);
  });
});

describe("registering a name", () => {
  const rec = (rck: string) => ({ subdomain: "home.alice", username: "alice", rckPubKeyHex: rck, currentTargetHex: "", registeredAt: 1, lastTargetUpdate: 0, lastTargetNonce: "" });

  it("keeps the first RCK when two different ones race for a new name", async () => {
    const sqlite = createSqliteD1();
    try {
      const r = new D1RoutingStorage(sqlite as unknown as D1Database);
      const [a, b] = await Promise.all([r.register(rec("aa".repeat(32))), r.register(rec("bb".repeat(32)))]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const held = (await r.get("home.alice"))!.rckPubKeyHex;
      expect(held).toBe(a.ok ? "aa".repeat(32) : "bb".repeat(32));
    } finally {
      sqlite.close();
    }
  });

  it("lets the same RCK register again, and refuses another one for a name that exists", async () => {
    const sqlite = createSqliteD1();
    try {
      const r = new D1RoutingStorage(sqlite as unknown as D1Database);
      expect((await r.register(rec("aa".repeat(32)))).ok).toBe(true);
      expect((await r.register(rec("aa".repeat(32)))).ok).toBe(true);
      expect((await r.register(rec("bb".repeat(32)))).ok).toBe(false);
      expect((await r.get("home.alice"))!.rckPubKeyHex).toBe("aa".repeat(32));
    } finally {
      sqlite.close();
    }
  });
});
