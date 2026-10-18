import { describe, expect, it } from "vitest";
import type { D1Database } from "@flagship/storage";
import { answerFor } from "@flagship/services-zone";
import {
  buildPlan,
  classifyDnsRecord,
  classifyServer,
  deleteOne,
  handleReapRoute,
  loadKnownAccounts,
  type KnownAccounts,
  type ReapCloudClient,
  type ReapDeps,
  type ReapDnsClient,
  type ReapDnsRecord,
  type ReapServer,
} from "../src/prodReap.js";

const APEX = "flagship.services";
const PROTECTED = ["playstore-test-0725"];
const SECRET = "admin-secret-for-test";

const S_ORPHAN = "00000000-0000-4000-8000-0000000000a1";
const S_KEPT = "00000000-0000-4000-8000-0000000000a2";
const S_PROTECTED = "00000000-0000-4000-8000-0000000000a3";
const S_GYM = "00000000-0000-4000-8000-0000000000a4";
const S_POINTED = "00000000-0000-4000-8000-0000000000a5";
const S_FOREIGN = "00000000-0000-4000-8000-0000000000a6";

interface World {
  usernames: string[];
  aliases: [string, string][];
  servers: string[];
  demoUsers: { username: string; active_server_id: string | null }[];
  authCodes: string[];
  /** Usernames with an unrevoked server; defaults to `servers`. */
  liveServers?: string[];
  /** Usernames with an unexpired active order; defaults to `authCodes`. */
  activeAuthCodes?: string[];
  /** Tables whose live-ness column is missing (an older schema). */
  missingColumns?: Set<string>;
  missingTables: Set<string>;
  failQuery: boolean;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    usernames: ["playstore-test-0725", "alice"],
    aliases: [],
    servers: ["alice"],
    demoUsers: [],
    authCodes: [],
    missingTables: new Set(),
    failQuery: false,
    ...over,
  };
}

function fakeDb(w: World): D1Database {
  const rowsFor = (sql: string): { v: string | null }[] => {
    const table = /FROM (\w+)/.exec(sql)![1]!;
    if (w.missingTables.has(table)) throw new Error(`D1_ERROR: no such table: ${table}`);
    if (w.failQuery) throw new Error("D1_ERROR: network connection lost");
    if (table === "usernames") return w.usernames.map((v) => ({ v }));
    if (table === "usernames_aliases") return w.aliases.map(([o, n]) => ({ v: sql.includes("old_username") ? o : n }));
    if (sql.includes("revoked_at IS NULL") || sql.includes("status = 'active'")) {
      if (w.missingColumns?.has(table)) throw new Error(`D1_ERROR: no such column: ${table}`);
      if (table === "servers") return (w.liveServers ?? w.servers).map((v) => ({ v }));
      if (table === "auth_codes") return (w.activeAuthCodes ?? w.authCodes).map((v) => ({ v }));
    }
    if (table === "servers") return w.servers.map((v) => ({ v }));
    if (table === "auth_codes") return w.authCodes.map((v) => ({ v }));
    if (table === "demo_users") {
      return sql.includes("active_server_id")
        ? w.demoUsers.filter((d) => d.active_server_id).map((d) => ({ v: d.active_server_id }))
        : w.demoUsers.map((d) => ({ v: d.username }));
    }
    throw new Error(`unexpected table ${table}`);
  };
  return {
    prepare: (sql: string) => {
      const st = {
        bind: () => st,
        first: async () => null,
        run: async () => {
          throw new Error("the reap must never write to D1");
        },
        all: async () => ({ results: rowsFor(sql), success: true, meta: {} }),
      };
      return st;
    },
    batch: async () => {
      throw new Error("the reap must never write to D1");
    },
  } as unknown as D1Database;
}

const rec = (id: string, name: string, type = "A", content = "1.2.3.4"): ReapDnsRecord => ({ id, name, type, content });
const hex = (n: number) => n.toString(16).padStart(32, "0");

function zone(): ReapDnsRecord[] {
  return [
    rec(hex(1), APEX, "A"),
    rec(hex(2), `*.${APEX}`, "A"),
    rec(hex(3), APEX, "MX", "mail.example.com"),
    rec(hex(4), `_dmarc.${APEX}`, "TXT", "v=DMARC1"),
    rec(hex(5), `hub.${APEX}`, "A"),
    rec(hex(6), `gym.${APEX}`, "A"),
    rec(hex(7), `x.gym.${APEX}`, "A"),
    rec(hex(8), APEX, "CAA", '0 issue "letsencrypt.org"'),
    rec(hex(9), APEX, "CAA", '0 issuewild "letsencrypt.org"'),
    // account alice is serving: every record at her names blocks the root wildcard
    rec(hex(10), `alice.${APEX}`, "CAA", '0 issue "letsencrypt.org"'),
    rec(hex(11), `*.alice.${APEX}`, "A"),
    rec(hex(12), `home.alice.${APEX}`, "A", "198.51.100.5"),
    rec(hex(13), `*.home.alice.${APEX}`, "AAAA"),
    // protected review account
    rec(hex(20), `playstore-test-0725.${APEX}`, "CAA"),
    rec(hex(21), `home.playstore-test-0725.${APEX}`, "A"),
    // orphan account bob
    rec(hex(30), `bob.${APEX}`, "CAA"),
    rec(hex(31), `*.bob.${APEX}`, "CAA"),
    rec(hex(32), `*.bob.${APEX}`, "A"),
    rec(hex(33), `*.bob.${APEX}`, "AAAA"),
    rec(hex(34), `home.bob.${APEX}`, "A"),
    rec(hex(35), `*.home.bob.${APEX}`, "A"),
    rec(hex(36), `_acme-challenge.home.bob.${APEX}`, "TXT", "token"),
    // orphan account carol-2 (dash)
    rec(hex(40), `carol-2.${APEX}`, "CAA"),
    rec(hex(41), `box.carol-2.${APEX}`, "A"),
    // shapes the rules do not know: kept even though bob is an orphan
    rec(hex(50), `bob.${APEX}`, "A"), // a host record at a label that is not an account
    rec(hex(51), `svc.home.bob.${APEX}`, "A"),
    rec(hex(52), `broadcast--bob.${APEX}`, "A"),
    rec(hex(53), `home.bob.${APEX}`, "TXT", "something"),
    rec(hex(54), `foo.example.org`, "A"),
  ];
}

/** The ids of `zone()` the plan trims: alice's four (they block), bob's seven and carol-2's two (gone), bob's TXT. */
const ORPHAN_IDS = [10, 11, 12, 13, 30, 31, 32, 33, 34, 35, 36, 40, 41, 53];
const RELAY = { servicesIpv4: "1.2.3.4" };

function fakeDns(records: ReapDnsRecord[]): ReapDnsClient & { deleted: string[]; failures: Map<string, number>; reads: number } {
  const live = new Map(records.map((r) => [r.id, r]));
  const c = {
    deleted: [] as string[],
    failures: new Map<string, number>(),
    reads: 0,
    async listAll() {
      c.reads += 1;
      return [...live.values()];
    },
    async getById(id: string) {
      return live.get(id) ?? null;
    },
    async deleteById(id: string) {
      const left = c.failures.get(id) ?? 0;
      if (left > 0) {
        c.failures.set(id, left - 1);
        throw new Error("Cloudflare DNS deleteById failed: rate limited");
      }
      c.deleted.push(id);
      return live.delete(id);
    },
  };
  return c;
}

function fakeCloud(servers: ReapServer[]): ReapCloudClient & { destroyed: string[] } {
  const c = {
    destroyed: [] as string[],
    async listServersByLabelKey(key: string) {
      return servers.filter((s) => s.labels[key] !== undefined);
    },
    async getServerLabels(id: string) {
      return servers.find((s) => s.serverId === id)?.labels ?? null;
    },
    async destroyServer(id: string) {
      c.destroyed.push(id);
    },
  };
  return c;
}

const srv = (serverId: string, labels: Record<string, string>): ReapServer => ({ serverId, title: `t-${serverId.slice(-2)}`, state: "started", labels });

function servers(): ReapServer[] {
  return [
    srv(S_ORPHAN, { "flagship-demo": "bob" }),
    srv(S_KEPT, { "flagship-demo": "alice" }),
    srv(S_PROTECTED, { "flagship-demo": "playstore-test-0725" }),
    srv(S_GYM, { "flagship-demo": "gymuser", "flagship-env": "gym" }),
    srv(S_POINTED, { "flagship-demo": "dave" }),
    srv(S_FOREIGN, { "flagship-demo": "UPPER_bad!" }),
  ];
}

function known(over: Partial<World> = {}): Promise<KnownAccounts> {
  return loadKnownAccounts(fakeDb(newWorld(over)), PROTECTED);
}

function deps(over: Partial<ReapDeps> = {}, world: Partial<World> = {}): ReapDeps & { dnsC: ReturnType<typeof fakeDns>; cloudC: ReturnType<typeof fakeCloud>; lines: string[] } {
  const dnsC = fakeDns(zone());
  const cloudC = fakeCloud(servers());
  const lines: string[] = [];
  return {
    db: fakeDb(newWorld({ demoUsers: [{ username: "dave", active_server_id: S_POINTED }], ...world })),
    dns: dnsC,
    cloud: cloudC,
    apex: APEX,
    protectedAccounts: PROTECTED,
    relay: RELAY,
    log: (l) => lines.push(l),
    ...over,
    dnsC,
    cloudC,
    lines,
  };
}

describe("loadKnownAccounts", () => {
  it("reads every table that can name an account, lowercased", async () => {
    const k = await known({
      usernames: ["playstore-test-0725", "Alice"],
      aliases: [["old-name", "new-name"]],
      servers: ["srvowner"],
      demoUsers: [{ username: "demo1", active_server_id: S_POINTED }],
      authCodes: ["codeowner"],
    });
    for (const n of ["alice", "old-name", "new-name", "srvowner", "demo1", "codeowner"]) expect(k.names.has(n)).toBe(true);
    expect(k.serverIds.has(S_POINTED)).toBe(true);
  });

  it("skips a table that does not exist but fails closed on any other error", async () => {
    const k = await known({ missingTables: new Set(["usernames_aliases", "auth_codes"]) });
    expect(k.names.has("alice")).toBe(true);
    await expect(known({ failQuery: true })).rejects.toMatchObject({ status: 502, code: "d1-unavailable" });
  });

  it("refuses an empty database and one missing a protected account", async () => {
    await expect(known({ usernames: [] })).rejects.toMatchObject({ status: 409, code: "d1-has-no-accounts" });
    await expect(known({ usernames: ["alice"] })).rejects.toMatchObject({ status: 409, code: "protected-account-missing" });
  });
});

describe("classifyDnsRecord", () => {
  const verdict = async (name: string, type: string, world: Partial<World> = {}, ctx = { rootReady: true }, extra = {}) =>
    classifyDnsRecord({ name, type, ...extra }, APEX, await known(world), PROTECTED, ctx);

  it("keeps the apex, its CAA, the root wildcard and system records", async () => {
    for (const [n, t] of [
      [APEX, "A"], [APEX, "CAA"], [`*.${APEX}`, "A"], [`*.${APEX}`, "AAAA"], [APEX, "MX"], [`_dmarc.${APEX}`, "TXT"],
      [`hub.${APEX}`, "A"], ["foo.example.org", "A"],
    ] as const) {
      expect((await verdict(n, t)).action, `${t} ${n}`).toBe("keep");
    }
  });

  it("keeps the gym subtree and every reserved label", async () => {
    for (const n of [`gym.${APEX}`, `x.gym.${APEX}`, `*.gym.${APEX}`, `home.x.gym.${APEX}`, `api.${APEX}`, `broadcast.${APEX}`]) {
      expect((await verdict(n, "A")).action, n).toBe("keep");
    }
  });

  it("trims every A, AAAA, CAA and TXT at a live account's or box's name once the root wildcard is in place", async () => {
    for (const t of ["A", "AAAA", "CAA", "TXT"]) {
      for (const n of [`alice.${APEX}`, `*.alice.${APEX}`, `home.alice.${APEX}`, `*.home.alice.${APEX}`, `HOME.Alice.${APEX}.`]) {
        const v = await verdict(n, t);
        expect(v, `${t} ${n}`).toMatchObject({ action: "orphan", owner: "alice", trim: "block" });
        expect(v.reason).toMatch(/blocks the root wildcard/);
      }
    }
  });

  it("keeps a live account's records until the root wildcard is in place (they are what resolves it)", async () => {
    for (const ctx of [{ rootReady: false }, {}]) {
      const v = await verdict(`*.alice.${APEX}`, "A", {}, ctx);
      expect(v).toMatchObject({ action: "keep", owner: "alice" });
      expect(v.reason).toMatch(/root wildcard is not in place yet/);
    }
  });

  it("trims a gone or idle account's records whether or not the wildcard is in place", async () => {
    for (const ctx of [{ rootReady: false }, { rootReady: true }]) {
      expect(await verdict(`*.bob.${APEX}`, "A", {}, ctx)).toMatchObject({ action: "orphan", trim: "gone", reason: "no account of this name in D1" });
      const idle = await verdict(`home.alice.${APEX}`, "A", { servers: ["alice"], liveServers: [] }, ctx);
      expect(idle).toMatchObject({ action: "orphan", trim: "gone" });
      expect(idle.reason).toMatch(/no live server or install in flight/);
    }
  });

  it("an account known through an alias, a server row, a demo row or an auth code still counts as an account", async () => {
    const live = ["oldie"];
    for (const world of [
      { aliases: [["oldie", "alice"]] as [string, string][], liveServers: live },
      { servers: ["oldie"] },
      { demoUsers: [{ username: "oldie", active_server_id: null }], liveServers: live },
      { authCodes: ["oldie"] },
    ] as Partial<World>[]) {
      const v = await verdict(`oldie.${APEX}`, "CAA", world);
      expect(v.reason, JSON.stringify(world)).not.toMatch(/no account of this name/);
    }
  });

  it("keeps the store-review account even if D1 forgot the name", async () => {
    const k: KnownAccounts = { names: new Set(["alice"]), serverIds: new Set() };
    const v = classifyDnsRecord({ name: `home.playstore-test-0725.${APEX}`, type: "A" }, APEX, k, PROTECTED, { rootReady: true });
    expect(v).toMatchObject({ action: "keep" });
    expect(v.reason).toMatch(/protected account/);
  });

  it("trims every record shape of a missing account", async () => {
    for (const [n, t] of [
      [`bob.${APEX}`, "CAA"], [`*.bob.${APEX}`, "CAA"], [`*.bob.${APEX}`, "A"], [`*.bob.${APEX}`, "AAAA"], [`*.bob.${APEX}`, "TXT"],
      [`home.bob.${APEX}`, "A"], [`home.bob.${APEX}`, "AAAA"], [`home.bob.${APEX}`, "TXT"], [`home.bob.${APEX}`, "CAA"], [`*.home.bob.${APEX}`, "A"],
      [`_acme-challenge.home.bob.${APEX}`, "TXT"], [`_acme-challenge.bob.${APEX}`, "TXT"], [`box.carol-2.${APEX}`, "A"],
    ] as const) {
      const v = await verdict(n, t);
      expect(v.action, `${t} ${n}`).toBe("orphan");
    }
  });

  it("keeps a host record at a single label that is not an account, but trims it when it is", async () => {
    for (const t of ["A", "AAAA", "TXT"]) {
      expect(await verdict(`bob.${APEX}`, t)).toMatchObject({ action: "keep", reason: "a host record, not an account's" });
    }
    expect((await verdict(`alice.${APEX}`, "A")).action).toBe("orphan");
    // a CAA there is always the old per-account record
    expect((await verdict(`bob.${APEX}`, "CAA")).action).toBe("orphan");
  });

  it("keeps shapes and types it does not recognise, even under a missing account", async () => {
    for (const [n, t] of [
      [`svc.home.bob.${APEX}`, "A"], [`broadcast--bob.${APEX}`, "A"], [`_acme-challenge.*.bob.${APEX}`, "TXT"],
      [`*.*.bob.${APEX}`, "A"], [`bad_name.bob.${APEX}`, "A"], [`-x.bob.${APEX}`, "A"], [`.bob.${APEX}`, "A"],
      [`home.bob.${APEX}`, "CNAME"], [`home.bob.${APEX}`, "MX"], [`_acme-challenge.home.bob.${APEX}`, "A"],
    ] as const) {
      expect((await verdict(n, t)).action, `${t} ${n}`).toBe("keep");
    }
  });

  it("keeps a name that merely ends like the apex", async () => {
    expect((await verdict(`bob.not${APEX}`, "CAA")).action).toBe("keep");
    expect((await verdict(`bob.${APEX}.evil.com`, "CAA")).action).toBe("keep");
  });

  it("keeps a challenge TXT of a live account while it is young, trims it when stale", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const name = `_acme-challenge.home.alice.${APEX}`;
    const young = await verdict(name, "TXT", {}, { rootReady: true, now } as never, { modified_on: "2026-10-18T11:30:00Z" });
    expect(young).toMatchObject({ action: "keep", owner: "alice" });
    const stale = await verdict(name, "TXT", {}, { rootReady: true, now } as never, { modified_on: "2026-10-18T09:00:00Z" });
    expect(stale).toMatchObject({ action: "orphan", trim: "stale-challenge" });
    // no timestamp: never guessed stale
    expect((await verdict(name, "TXT", {}, { rootReady: true, now } as never)).action).toBe("keep");
    // a gone account's challenge goes whatever its age
    expect(await verdict(`_acme-challenge.home.bob.${APEX}`, "TXT")).toMatchObject({ action: "orphan", trim: "gone" });
  });

  it("orders the deletes so the user-name CAA goes first and the account wildcard last", async () => {
    const o = async (n: string, t: string) => (await verdict(n, t)).order!;
    expect(await o(`alice.${APEX}`, "CAA")).toBeLessThan(await o(`home.alice.${APEX}`, "A"));
    expect(await o(`home.alice.${APEX}`, "A")).toBeLessThan(await o(`*.home.alice.${APEX}`, "A"));
    expect(await o(`*.home.alice.${APEX}`, "A")).toBeLessThan(await o(`*.alice.${APEX}`, "A"));
    expect(await o(`*.alice.${APEX}`, "AAAA")).toBeLessThan(await o(`*.alice.${APEX}`, "A"));
  });

  it("orphans every record of an account that exists but has no live server or install", async () => {
    const live = { servers: ["alice"], liveServers: [] as string[] };
    for (const [n, t] of [[`*.alice.${APEX}`, "A"], [`alice.${APEX}`, "CAA"], [`home.alice.${APEX}`, "A"], [`_acme-challenge.home.alice.${APEX}`, "TXT"]] as const) {
      const v = await verdict(n, t, live);
      expect(v, `${t} ${n}`).toMatchObject({ action: "orphan", owner: "alice" });
      expect(v.reason).toMatch(/no live server or install in flight/);
    }
  });

  it("keeps an idle account's records while an install order is in flight", async () => {
    const v = await verdict(`*.alice.${APEX}`, "A", { servers: ["alice"], liveServers: [], authCodes: ["alice"], activeAuthCodes: ["alice"] }, { rootReady: false });
    expect(v.action).toBe("keep");
  });

  it("does not apply the no-live-server rule when D1 cannot say, or to the protected account", async () => {
    const unknownLive = await verdict(`*.alice.${APEX}`, "A", { servers: ["alice"], liveServers: [], missingColumns: new Set(["servers"]) });
    expect(unknownLive.reason).toMatch(/blocks the root wildcard/);
    const prot = classifyDnsRecord({ name: `*.playstore-test-0725.${APEX}`, type: "A" }, APEX, { names: new Set(["alice"]), serverIds: new Set(), liveAccounts: new Set() }, PROTECTED, { rootReady: true });
    expect(prot.action).toBe("keep");
  });
});

describe("loadKnownAccounts: who is still serving", () => {
  it("reads unrevoked servers and unexpired orders", async () => {
    const k = await known({ servers: ["alice", "gone"], liveServers: ["alice"], authCodes: ["buyer", "stale"], activeAuthCodes: ["buyer"] });
    expect([...k.liveAccounts!].sort()).toEqual(["alice", "buyer"]);
    expect(k.names.has("gone")).toBe(true);
  });

  it("leaves it unknown when the columns are missing and fails closed on any other error", async () => {
    expect((await known({ missingColumns: new Set(["servers"]) })).liveAccounts).toBeUndefined();
    expect((await known({ missingColumns: new Set(["auth_codes"]) })).liveAccounts).toBeUndefined();
    await expect(known({ failQuery: true })).rejects.toMatchObject({ code: "d1-unavailable" });
  });
});

describe("buildPlan and deleteOne with the root-wildcard layout", () => {
  const records = [
    rec(hex(1), APEX, "A"),
    rec(hex(2), `*.${APEX}`, "A", RELAY.servicesIpv4),
    rec(hex(8), APEX, "CAA", '0 issue "letsencrypt.org"'),
    rec(hex(100), `*.alice.${APEX}`, "A", RELAY.servicesIpv4),
    rec(hex(101), `*.alice.${APEX}`, "AAAA", "2001:db8::7"),
    rec(hex(102), `alice.${APEX}`, "CAA", '0 issue "letsencrypt.org"'),
    rec(hex(110), `home.alice.${APEX}`, "A", RELAY.servicesIpv4),
    rec(hex(112), `*.home.alice.${APEX}`, "A", RELAY.servicesIpv4),
    rec(hex(120), `_acme-challenge.home.alice.${APEX}`, "TXT", "token", ),
  ];
  const mk = (recs = records, over: Partial<ReapDeps> = {}) => {
    const dnsC = fakeDns(recs);
    return { dnsC, d: { db: fakeDb(newWorld()), dns: dnsC, cloud: undefined, apex: APEX, protectedAccounts: PROTECTED, relay: RELAY, ...over } as ReapDeps };
  };

  it("plans a trim for an account that stays: every record at her names goes, the root set and the challenge stay", async () => {
    const { d } = mk();
    const plan = await buildPlan(d);
    expect(plan.rootWildcardReady).toBe(true);
    expect(plan.summary.dnsOrphan).toBe(5);
    expect(plan.accounts.find((a) => a.owner === "alice")).toMatchObject({ status: "trim", dnsOrphans: 5, dnsKept: 1 });
    expect(plan.summary.zoneRecordsAfter).toBe(4);
    expect(plan.dns.filter((x) => x.action === "orphan").every((x) => x.trim === "block")).toBe(true);
  });

  it("keeps everything of a live account while the root wildcard is missing, and says so in the plan", async () => {
    const { d } = mk(records.filter((r) => r.id !== hex(2)));
    const plan = await buildPlan(d);
    expect(plan.rootWildcardReady).toBe(false);
    expect(plan.summary.dnsOrphan).toBe(0);
  });

  it("does not see a wildcard at the wrong address or without a configured relay as ready", async () => {
    const wrong = mk(records.map((r) => (r.id === hex(2) ? { ...r, content: "198.51.100.9" } : r)));
    expect((await buildPlan(wrong.d)).rootWildcardReady).toBe(false);
    const noRelay = mk(records, { relay: undefined });
    expect((await buildPlan(noRelay.d)).rootWildcardReady).toBe(false);
  });

  it("applied in plan order, no name of the account ever stops answering the relay", async () => {
    const { d, dnsC } = mk();
    const plan = await buildPlan(d);
    const trims = plan.dns.filter((x) => x.action === "orphan").sort((a, b) => a.order! - b.order!);
    const live = new Map(records.map((r) => [r.id, r]));
    const names = [`home.alice.${APEX}`, `x.home.alice.${APEX}`, `app.alice.${APEX}`];
    for (const t of trims) {
      const r = await deleteOne(d, { kind: "dns", id: t.id, name: t.name, type: t.type });
      expect(r.status, `${t.type} ${t.name}`).toBe(200);
      live.delete(t.id);
      for (const n of names) expect(answerFor([...live.values()], n).result, `${n} after ${t.type} ${t.name}`).toBe("answer");
    }
    expect(dnsC.deleted).toHaveLength(5);
  });

  it("refuses to delete a blocking record once the root wildcard that replaces it is gone", async () => {
    const { d, dnsC } = mk();
    await dnsC.deleteById(hex(2));
    dnsC.deleted.length = 0;
    const r = await deleteOne(d, { kind: "dns", id: hex(110), name: `home.alice.${APEX}`, type: "A" });
    expect(r).toMatchObject({ status: 409, body: { code: "not-orphan" } });
    expect(dnsC.deleted).toEqual([]);
  });

  it("never offers the apex, its CAA, or the root wildcard for deletion", async () => {
    const { d, dnsC } = mk();
    for (const id of [hex(1), hex(2), hex(8)]) {
      const live = (await dnsC.getById(id))!;
      expect((await deleteOne(d, { kind: "dns", id, name: live.name, type: live.type })).status, id).toBe(409);
    }
    expect(dnsC.deleted).toEqual([]);
  });

  it("deletes a stale challenge TXT and keeps a young one", async () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const old = rec(hex(130), `_acme-challenge.home.alice.${APEX}`, "TXT", "old");
    old.modified_on = "2026-10-18T08:00:00Z";
    const young = rec(hex(131), `_acme-challenge.media.alice.${APEX}`, "TXT", "young");
    young.modified_on = "2026-10-18T11:50:00Z";
    const { d, dnsC } = mk([...records.slice(0, 3), old, young], { now: () => now });
    expect((await deleteOne(d, { kind: "dns", id: hex(130), name: old.name, type: "TXT" })).status).toBe(200);
    expect((await deleteOne(d, { kind: "dns", id: hex(131), name: young.name, type: "TXT" })).status).toBe(409);
    expect(dnsC.deleted).toEqual([hex(130)]);
  });
});

describe("classifyServer", () => {
  it("orphans only an unlabelled-for-env demo server whose account is gone", async () => {
    const k = await known({ demoUsers: [{ username: "dave", active_server_id: S_POINTED }] });
    const by = Object.fromEntries(servers().map((s) => [s.serverId, classifyServer(s, k, PROTECTED)]));
    expect(by[S_ORPHAN]).toMatchObject({ action: "orphan", owner: "bob" });
    expect(by[S_KEPT]!.action).toBe("keep");
    expect(by[S_PROTECTED]).toMatchObject({ action: "keep", reason: "protected account" });
    expect(by[S_GYM]!.action).toBe("keep");
    expect(by[S_POINTED]!.action).toBe("keep");
    expect(by[S_FOREIGN]!.action).toBe("keep");
  });

  it("keeps a server without the demo label", async () => {
    const k = await known();
    expect(classifyServer({ serverId: S_ORPHAN, labels: { team: "x" } }, k, PROTECTED).action).toBe("keep");
  });

  it("keeps a server a demo row in D1 still points at, even under another name", async () => {
    const k = await known({ demoUsers: [{ username: "someone", active_server_id: S_ORPHAN }] });
    expect(classifyServer({ serverId: S_ORPHAN, labels: { "flagship-demo": "bob" } }, k, PROTECTED).action).toBe("keep");
  });
});

describe("buildPlan", () => {
  it("lists and classifies without writing, with per-account counts", async () => {
    const d = deps();
    const plan = await buildPlan(d);
    expect(plan.zoneRecords).toBe(zone().length);
    expect(plan.summary.dnsOrphan).toBe(ORPHAN_IDS.length);
    expect(plan.summary.zoneRecordsAfter).toBe(zone().length - ORPHAN_IDS.length);
    expect(plan.summary.serversOrphan).toBe(1);
    expect(plan.serversChecked).toBe(true);
    const bob = plan.accounts.find((a) => a.owner === "bob")!;
    expect(bob).toMatchObject({ status: "orphan", dnsOrphans: 8, serverOrphans: 1 });
    expect(plan.accounts.find((a) => a.owner === "carol-2")).toMatchObject({ status: "orphan", dnsOrphans: 2 });
    expect(plan.accounts.find((a) => a.owner === "alice")).toMatchObject({ status: "trim", dnsOrphans: 4 });
    expect(plan.accounts.find((a) => a.owner === "playstore-test-0725")).toMatchObject({ status: "kept", dnsOrphans: 0, dnsKept: 2 });
    const order = { orphan: 0, trim: 1, kept: 2 } as const;
    expect(plan.accounts.map((a) => order[a.status])).toEqual([...plan.accounts.map((a) => order[a.status])].sort());
    // building a plan is read-only
    expect(d.dnsC.deleted).toEqual([]);
    expect(d.cloudC.destroyed).toEqual([]);
  });

  it("works without an UpCloud token and says servers were not checked", async () => {
    const plan = await buildPlan(deps({ cloud: undefined }));
    expect(plan.serversChecked).toBe(false);
    expect(plan.servers).toEqual([]);
  });

  it("needs DNS", async () => {
    await expect(buildPlan(deps({ dns: undefined }))).rejects.toMatchObject({ status: 503 });
  });

  it("refuses to classify against the wrong database", async () => {
    await expect(buildPlan(deps({}, { usernames: ["alice"] }))).rejects.toMatchObject({ code: "protected-account-missing" });
  });
});

describe("deleteOne", () => {
  it("deletes an orphan record and logs it", async () => {
    const d = deps();
    const r = await deleteOne(d, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "CAA" });
    expect(r).toMatchObject({ status: 200, body: { result: "deleted", owner: "bob" } });
    expect(d.dnsC.deleted).toEqual([hex(30)]);
    expect(d.lines.join("\n")).toContain(`reap deleted dns CAA bob.${APEX}`);
  });

  it("re-verifies against D1 right now: an account that came back keeps its records until the root wildcard is verified", async () => {
    const back = { usernames: ["playstore-test-0725", "alice", "bob"], servers: ["alice", "bob"] };
    const d = deps({ relay: undefined }, back);
    const r = await deleteOne(d, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "CAA" });
    expect(r).toMatchObject({ status: 409, body: { code: "not-orphan" } });
    expect(d.dnsC.deleted).toEqual([]);
    // with the wildcard in place the same record blocks it, so it is trimmed even though bob is live again
    const d2 = deps({}, back);
    expect((await deleteOne(d2, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "CAA" })).status).toBe(200);
  });

  it("refuses every keep record by id, even if the caller names it", async () => {
    const d = deps();
    for (const r of zone().filter((x) => !ORPHAN_IDS.includes(parseInt(x.id, 16)))) {
      const res = await deleteOne(d, { kind: "dns", id: r.id, name: r.name, type: r.type });
      expect(res.status, `${r.type} ${r.name}`).toBe(409);
    }
    expect(d.dnsC.deleted).toEqual([]);
  });

  it("refuses a record whose name or type differs from the plan", async () => {
    const d = deps();
    expect((await deleteOne(d, { kind: "dns", id: hex(30), name: `alice.${APEX}`, type: "CAA" })).body.code).toBe("mismatch");
    expect((await deleteOne(d, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "A" })).body.code).toBe("mismatch");
    expect(d.dnsC.deleted).toEqual([]);
  });

  it("answers gone for a record that is already deleted", async () => {
    const d = deps();
    const r = await deleteOne(d, { kind: "dns", id: hex(999), name: `bob.${APEX}`, type: "CAA" });
    expect(r).toMatchObject({ status: 200, body: { result: "gone" } });
  });

  it("reports a Cloudflare failure as retryable and deletes nothing", async () => {
    const d = deps();
    d.dnsC.failures.set(hex(30), 1);
    const first = await deleteOne(d, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "CAA" });
    expect(first).toMatchObject({ status: 502, body: { retryable: true } });
    expect(d.dnsC.deleted).toEqual([]);
    const second = await deleteOne(d, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "CAA" });
    expect(second.status).toBe(200);
  });

  it("validates its input", async () => {
    const d = deps();
    expect((await deleteOne(d, undefined)).status).toBe(400);
    expect((await deleteOne(d, { kind: "zone", id: "x" })).status).toBe(400);
    expect((await deleteOne(d, { kind: "dns", id: "not-hex", name: "a", type: "A" })).status).toBe(400);
    expect((await deleteOne(d, { kind: "dns", id: hex(30) })).status).toBe(400);
    expect((await deleteOne(d, { kind: "server", id: "nope" })).status).toBe(400);
    expect(d.dnsC.deleted).toEqual([]);
  });

  it("destroys only an orphan demo server, re-checked", async () => {
    const d = deps();
    expect(await deleteOne(d, { kind: "server", id: S_ORPHAN, owner: "bob" })).toMatchObject({ status: 200, body: { result: "deleted" } });
    expect(d.cloudC.destroyed).toEqual([S_ORPHAN]);
    for (const id of [S_KEPT, S_PROTECTED, S_GYM, S_POINTED, S_FOREIGN]) {
      expect((await deleteOne(d, { kind: "server", id })).status, id).toBe(409);
    }
    expect(d.cloudC.destroyed).toEqual([S_ORPHAN]);
  });

  it("refuses a server whose owner differs from the plan's", async () => {
    const d = deps();
    expect((await deleteOne(d, { kind: "server", id: S_ORPHAN, owner: "alice" })).body.code).toBe("mismatch");
    expect(d.cloudC.destroyed).toEqual([]);
  });

  it("answers gone for a server that no longer exists, and 503 without a token", async () => {
    const d = deps();
    expect((await deleteOne(d, { kind: "server", id: "00000000-0000-4000-8000-0000000000ff" })).body.result).toBe("gone");
    expect((await deleteOne(deps({ cloud: undefined }), { kind: "server", id: S_ORPHAN })).status).toBe(503);
  });

  it("deletes nothing when D1 cannot be read", async () => {
    const d = deps({}, { failQuery: true });
    expect((await deleteOne(d, { kind: "dns", id: hex(30), name: `bob.${APEX}`, type: "CAA" })).status).toBe(502);
    expect(d.dnsC.deleted).toEqual([]);
  });
});

describe("handleReapRoute", () => {
  const dnsC = fakeDns(zone());
  const cloudC = fakeCloud(servers());
  const world = newWorld({ demoUsers: [{ username: "dave", active_server_id: S_POINTED }] });
  const env = { DB: fakeDb(world), FLAGSHIP_ADMIN_SECRET: SECRET, CLOUDFLARE_DNS_API_TOKEN: "t", CLOUDFLARE_SERVICES_ZONE_ID: "z", UPCLOUD_TOKEN: "u", SERVICES_PASSTHROUGH_IPV4: "1.2.3.4" };
  const opts = { makeDns: () => dnsC, makeCloud: () => cloudC };
  const call = (path: string, init: RequestInit = {}, secret: string | null = SECRET, e = env) =>
    handleReapRoute(
      new Request(`https://flagshipserver.com/api/admin/reap/${path}`, {
        ...init,
        headers: { ...(secret ? { "x-admin-secret": secret } : {}), "content-type": "application/json" },
      }),
      e,
      opts,
    );

  it("needs the admin secret on every route", async () => {
    expect((await call("list", {}, null)).status).toBe(401);
    expect((await call("classify", {}, "wrong")).status).toBe(403);
    expect((await call("delete-one", { method: "POST", body: "{}" }, null)).status).toBe(401);
    expect((await call("list", {}, SECRET, { ...env, FLAGSHIP_ADMIN_SECRET: undefined as unknown as string })).status).toBe(503);
    expect(dnsC.deleted).toEqual([]);
  });

  it("dry run: list and classify only read", async () => {
    const list = await call("list");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { zoneRecords: number }).zoneRecords).toBe(zone().length);
    const plan = await call("classify");
    expect(plan.status).toBe(200);
    expect(((await plan.json()) as { summary: { dnsOrphan: number } }).summary.dnsOrphan).toBe(ORPHAN_IDS.length);
    expect(dnsC.deleted).toEqual([]);
    expect(cloudC.destroyed).toEqual([]);
  });

  it("checks method and path", async () => {
    expect((await call("list", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call("delete-one", { method: "GET" })).status).toBe(405);
    expect((await call("everything")).status).toBe(404);
    expect((await call("delete-one", { method: "POST", body: "not json" })).status).toBe(400);
  });

  it("delete-one deletes one orphan and refuses a kept record", async () => {
    const ok = await call("delete-one", { method: "POST", body: JSON.stringify({ kind: "dns", id: hex(34), name: `home.bob.${APEX}`, type: "A" }) });
    expect(ok.status).toBe(200);
    const no = await call("delete-one", { method: "POST", body: JSON.stringify({ kind: "dns", id: hex(20), name: `playstore-test-0725.${APEX}`, type: "CAA" }) });
    expect(no.status).toBe(409);
    expect(dnsC.deleted).toEqual([hex(34)]);
  });

  it("answers 503 when DNS is not configured", async () => {
    const r = await handleReapRoute(
      new Request("https://flagshipserver.com/api/admin/reap/classify", { headers: { "x-admin-secret": SECRET } }),
      env,
      { makeDns: () => undefined, makeCloud: () => cloudC },
    );
    expect(r.status).toBe(503);
  });

  it("turns an unexpected upstream failure into a retryable 502", async () => {
    const broken: ReapDnsClient = {
      listAll: async () => {
        throw new Error("Cloudflare DNS listAll failed: boom");
      },
      getById: async () => null,
      deleteById: async () => false,
    };
    const r = await handleReapRoute(
      new Request("https://flagshipserver.com/api/admin/reap/classify", { headers: { "x-admin-secret": SECRET } }),
      env,
      { makeDns: () => broken, makeCloud: () => cloudC },
    );
    expect(r.status).toBe(502);
    expect(((await r.json()) as { retryable: boolean }).retryable).toBe(true);
  });
});
