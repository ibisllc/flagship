import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import {
  ed,
  signAuthCode,
  signAccountSelfDelete,
  signDns01Delete,
  signDns01Publish,
  type Keypair,
} from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { answerFor } from "@flagship/services-zone";
import {
  accountZoneOfServerDomain,
  clearLegacyAccountDns,
  releaseChallengeShield,
  removeAccountDns,
  removeBoxDns,
} from "../src/accountDns.js";
import { handleAccountDeletionBundle } from "../src/accountDeletion.js";
import { CloudflareDnsClient } from "../src/cloudflareDns.js";
import { handleDns01Delete, handleDns01Publish } from "../src/dns01.js";
import { handleAuthCodeIssue } from "../src/authCode.js";
import { FakeCloudflare } from "./fakeCloudflare.js";

// Root-wildcard layout (docs/wildcard-dns.md): the zone holds `*.<apex>` A/AAAA
// and the apex CAA pair, nothing per account or box.

const APEX = "flagship.services";
const RELAY = { servicesIpv4: "203.0.113.7", servicesIpv6: "2001:db8::7" };
const ZONE = `alice.${APEX}`;
const BOX = `home.alice.${APEX}`;

let cf: FakeCloudflare;
let dns: CloudflareDnsClient;

beforeEach(() => {
  cf = new FakeCloudflare();
  cf.install();
  dns = new CloudflareDnsClient({ apiToken: "t", zoneId: "z" });
});
afterEach(() => vi.unstubAllGlobals());

function deps() {
  return { client: dns, ...RELAY };
}

const ROOT_SET = [
  `A *.${APEX} ${RELAY.servicesIpv4}`,
  `AAAA *.${APEX} ${RELAY.servicesIpv6}`,
  `CAA ${APEX} 0 issue "letsencrypt.org"`,
  `CAA ${APEX} 0 issuewild "letsencrypt.org"`,
].sort();

function seedRoot(): void {
  cf.seed("A", `*.${APEX}`, RELAY.servicesIpv4);
  cf.seed("AAAA", `*.${APEX}`, RELAY.servicesIpv6);
  cf.seed("CAA", APEX, '0 issue "letsencrypt.org"');
  cf.seed("CAA", APEX, '0 issuewild "letsencrypt.org"');
}

/** The 12-record layout older builds wrote for one account with one box. */
function seedTwelve(user = "alice", box = "home"): string[] {
  const zone = `${user}.${APEX}`;
  const ids: string[] = [];
  for (const t of ["issue", "issuewild", "iodef"]) {
    ids.push(cf.seed("CAA", zone, `0 ${t} "x"`).id, cf.seed("CAA", `*.${zone}`, `0 ${t} "x"`).id);
  }
  for (const name of [`*.${zone}`, `${box}.${zone}`, `*.${box}.${zone}`]) {
    ids.push(cf.seed("A", name, RELAY.servicesIpv4).id, cf.seed("AAAA", name, RELAY.servicesIpv6).id);
  }
  return ids;
}

/** The 4-record per-account layout (the previous design). */
function seedFour(user = "alice"): void {
  const zone = `${user}.${APEX}`;
  cf.seed("A", `*.${zone}`, RELAY.servicesIpv4);
  cf.seed("AAAA", `*.${zone}`, RELAY.servicesIpv6);
  cf.seed("CAA", zone, '0 issue "letsencrypt.org"');
  cf.seed("CAA", zone, '0 issuewild "letsencrypt.org"');
}

const mine = (user: string) => cf.records.filter((r) => r.name.endsWith(`${user}.${APEX}`) && !r.name.startsWith("_acme"));

describe("no address or CAA record is ever written for an account", () => {
  it("the dns-01 flow adds only the challenge TXT, with or without a relay address", async () => {
    seedRoot();
    const storage = new InMemoryStorage();
    const identity = key();
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: hexOf(identity.publicKey), registeredAt: 1_000 });
    const before = cf.dump();
    expect((await publish(storage, identity, "token-apex", BOX, BOX, false)).status).toBe(200);
    expect((await publish(storage, identity, "token-wild", BOX, BOX, false)).status).toBe(200);
    expect(cf.dump().filter((l) => !before.includes(l)).every((l) => l.startsWith("TXT _acme-challenge."))).toBe(true);
    expect(cf.records.filter((r) => r.type !== "TXT")).toHaveLength(4);
    expect(cf.requests.filter((r) => r.startsWith("PATCH"))).toEqual([]);
  });

  it("clearing an account that has nothing legacy does not write at all", async () => {
    seedRoot();
    const r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r).toEqual({ removed: 0, names: [] });
    expect(cf.requests.filter((q) => !q.startsWith("GET"))).toEqual([]);
    expect(cf.dump()).toEqual(ROOT_SET);
  });

  it("derives the account zone from a server domain without knowing the apex", () => {
    expect(accountZoneOfServerDomain(BOX)).toBe(ZONE);
    expect(accountZoneOfServerDomain("home.alice.gym.flagship.services")).toBe("alice.gym.flagship.services");
    expect(accountZoneOfServerDomain("alice.flagship.services")).toBeNull();
    expect(accountZoneOfServerDomain("flagship")).toBeNull();
  });
});

describe("clearing an account's legacy records", () => {
  it("removes the 12-record layout and the 4-record layout of one account, nothing of another", async () => {
    seedRoot();
    seedTwelve("alice");
    seedFour("bob");
    const r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.error).toBeUndefined();
    expect(r.removed).toBe(12);
    expect(mine("alice")).toEqual([]);
    expect(mine("bob")).toHaveLength(4);
    expect(cf.dump().filter((l) => l.includes(APEX) && !l.includes("bob."))).toEqual(ROOT_SET);
  });

  it("never touches the apex, hosts, the gym subtree, a challenge TXT or a stray TXT", async () => {
    seedRoot();
    seedFour("alice");
    cf.seed("A", `hub.${APEX}`, "198.51.100.1");
    cf.seed("A", `*.gym.${APEX}`, "198.51.100.2");
    cf.seed("A", `home.carol.gym.${APEX}`, "198.51.100.2");
    cf.seed("TXT", `_acme-challenge.home.alice.${APEX}`, "token");
    cf.seed("TXT", `alice.${APEX}`, "stray");
    await clearLegacyAccountDns(deps(), ZONE);
    expect(cf.dump().sort()).toEqual(
      [
        ...ROOT_SET,
        `A hub.${APEX} 198.51.100.1`,
        `A *.gym.${APEX} 198.51.100.2`,
        `A home.carol.gym.${APEX} 198.51.100.2`,
        `TXT _acme-challenge.home.alice.${APEX} token`,
        `TXT alice.${APEX} stray`,
      ].sort(),
    );
  });

  it("deletes in an order that keeps every name of the account resolving to the relay", async () => {
    for (const seed of [() => seedTwelve("alice"), () => seedFour("alice")]) {
      cf = new FakeCloudflare();
      cf.install();
      dns = new CloudflareDnsClient({ apiToken: "t", zoneId: "z" });
      seedRoot();
      seed();
      const names = [`home.alice.${APEX}`, `x.home.alice.${APEX}`, `app.alice.${APEX}`, `y.z.home.alice.${APEX}`];
      const seen: string[] = [];
      cf.afterRequest = (method) => {
        if (method !== "DELETE") return;
        for (const n of names) {
          const a = answerFor(cf.records, n, "A");
          if (a.result !== "answer") seen.push(`${n} A ${a.result}`);
          if (answerFor(cf.records, n, "AAAA").result === "nxdomain") seen.push(`${n} AAAA nxdomain`);
        }
      };
      await clearLegacyAccountDns(deps(), ZONE);
      expect(seen).toEqual([]);
      for (const n of names) expect(answerFor(cf.records, n)).toEqual({ result: "answer", values: [RELAY.servicesIpv4] });
    }
  });

  it("is idempotent", async () => {
    seedRoot();
    seedTwelve();
    expect((await clearLegacyAccountDns(deps(), ZONE)).removed).toBe(12);
    expect(await clearLegacyAccountDns(deps(), ZONE)).toEqual({ removed: 0, names: [] });
    expect(await clearLegacyAccountDns(deps(), ZONE)).toEqual({ removed: 0, names: [] });
    expect(cf.dump()).toEqual(ROOT_SET);
  });

  it("survives two callers racing over the same records (the loser finds them gone)", async () => {
    seedRoot();
    seedTwelve();
    const [a, b] = await Promise.all([clearLegacyAccountDns(deps(), ZONE), clearLegacyAccountDns(deps(), ZONE)]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    expect(a.removed + b.removed).toBe(12);
    expect(cf.dump()).toEqual(ROOT_SET);
  });

  it("survives a record vanishing between the list and the delete", async () => {
    seedRoot();
    seedFour();
    let raced = false;
    cf.afterRequest = (method) => {
      if (method === "GET" && !raced && cf.requests.length === 1) {
        raced = true;
        cf.records = cf.records.filter((r) => r.type !== "AAAA" || !r.name.startsWith("*.alice"));
      }
    };
    const r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.error).toBeUndefined();
    expect(mine("alice")).toEqual([]);
  });

  it("keeps going when one delete fails, and reports it", async () => {
    seedRoot();
    seedFour();
    const real = globalThis.fetch;
    let failed = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE" && !failed) {
        failed = true;
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1000 }] }), { status: 500 });
      }
      return real(url, init);
    });
    const r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.error).toMatch(/deleteById failed/);
    expect(r.removed).toBe(3);
    expect(mine("alice")).toHaveLength(1);
  });

  it("does nothing, and says so, until the root wildcard is in the zone and points at the relay", async () => {
    seedFour();
    // No root wildcard at all.
    let r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r).toEqual({ removed: 0, names: [], skipped: "root-wildcard-not-ready" });
    expect(mine("alice")).toHaveLength(4);
    // A wildcard at the wrong address.
    cf.seed("A", `*.${APEX}`, "198.51.100.99");
    cf.seed("AAAA", `*.${APEX}`, RELAY.servicesIpv6);
    r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.skipped).toBe("root-wildcard-not-ready");
    // Only the A, the AAAA missing.
    cf.records = cf.records.filter((x) => x.type !== "AAAA" || x.name !== `*.${APEX}`);
    cf.records.find((x) => x.name === `*.${APEX}`)!.content = RELAY.servicesIpv4;
    r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.skipped).toBe("root-wildcard-not-ready");
    // Proxied (orange cloud) is not the relay either.
    cf.seed("AAAA", `*.${APEX}`, RELAY.servicesIpv6, { proxied: true });
    r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.skipped).toBe("root-wildcard-not-ready");
    expect(mine("alice")).toHaveLength(4);
  });

  it("reports an unreachable zone without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("zone unreachable");
    });
    const r = await clearLegacyAccountDns(deps(), ZONE);
    expect(r.error).toMatch(/zone unreachable/);
    expect(r.removed).toBe(0);
  });
});

describe("removing what a gone account or box left", () => {
  it("deletes by name the account's records, the *.<user> CAA and the user-name CAA, nothing of another account", async () => {
    seedRoot();
    seedTwelve("alice");
    seedFour("bob");
    const deleted = await removeAccountDns(dns, ZONE);
    expect(deleted).toBe(8);
    expect(mine("alice").map((r) => r.name).sort()).toEqual([`home.alice.${APEX}`, `home.alice.${APEX}`, `*.home.alice.${APEX}`, `*.home.alice.${APEX}`].sort());
    expect(mine("bob")).toHaveLength(4);
  });

  it("deletes the per-box pair (and a CAA) older builds published, only for that box", async () => {
    for (const name of [BOX, `*.${BOX}`, `media.${ZONE}`]) {
      cf.seed("A", name, RELAY.servicesIpv4);
      cf.seed("AAAA", name, RELAY.servicesIpv6);
    }
    cf.seed("CAA", BOX, '0 issue "x"');
    expect(await removeBoxDns(dns, BOX)).toBe(5);
    expect(cf.names()).toEqual([`A media.${ZONE}`, `AAAA media.${ZONE}`]);
  });
});

describe("account deletion", () => {
  it("removes the account's records, per-box leftovers included, and leaves the root set and others alone", async () => {
    const storage = new InMemoryStorage();
    const priv = new Uint8Array(32).fill(5);
    const irk: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1_000 });
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: "aa".repeat(32), registeredAt: 1_000 });
    seedRoot();
    seedFour("alice");
    cf.seed("A", BOX, RELAY.servicesIpv4);
    cf.seed("A", `*.${BOX}`, RELAY.servicesIpv4);
    seedFour("bob");
    const now = 1_700_000_000_000;
    const order = { username: "alice", issuedAt: now };
    const res = await handleAccountDeletionBundle(
      {
        usernames: storage.usernames,
        servers: storage.servers,
        routing: storage.routing,
        authCodes: storage.authCodes,
        deviceCapabilityGrants: storage.deviceCapabilityGrants,
        auditEvents: storage.auditEvents,
        dns,
        now: () => now,
      },
      { accountSelfDelete: { request: order, signature: hex(signAccountSelfDelete(order, irk)) } },
    );
    expect(res.status).toBe(200);
    expect(mine("alice")).toEqual([]);
    expect(mine("bob")).toHaveLength(4);
    expect(cf.dump().filter((l) => !l.includes("bob."))).toEqual(ROOT_SET);
  });
});

// ── the challenge shield ────────────────────────────────────────────────────

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function publish(storage: InMemoryStorage, identity: Keypair, value: string, host = BOX, serverId = BOX, withShield = true) {
  const recordName = `_acme-challenge.${host}`;
  const recordValueHash = sha256(new TextEncoder().encode(value));
  const issuedAt = Date.now();
  const claim = { serverId, recordName, recordValueHash, issuedAt };
  const r = await handleDns01Publish(
    { servers: storage.servers, dns, apex: APEX, ...(withShield ? { shield: RELAY } : {}) },
    {
      request: { serverId, recordName, recordValueHash: hexOf(recordValueHash), issuedAt },
      signature: hexOf(signDns01Publish(claim, identity)),
      recordValue: value,
    },
  );
  return r;
}

async function remove(storage: InMemoryStorage, identity: Keypair, recordId: string, serverId = BOX) {
  const issuedAt = Date.now();
  return handleDns01Delete(
    { servers: storage.servers, dns, apex: APEX, shield: RELAY },
    { request: { serverId, recordId, issuedAt }, signature: hexOf(signDns01Delete({ serverId, recordId, issuedAt }, identity)) },
  );
}

describe("the challenge shield", () => {
  async function boxWithAccount() {
    const storage = new InMemoryStorage();
    const identity = key();
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: hexOf(identity.publicKey), registeredAt: 1_000 });
    seedRoot();
    return { storage, identity };
  }
  const shielded = (name: string) => [`A ${name} ${RELAY.servicesIpv4}`, `AAAA ${name} ${RELAY.servicesIpv6}`];

  it("is in place before the challenge TXT exists, and gone after the last TXT is deleted", async () => {
    const { storage, identity } = await boxWithAccount();
    const seen: string[][] = [];
    cf.afterRequest = (method, name) => {
      if (method === "POST" && name === `_acme-challenge.${BOX}`) seen.push(cf.dump());
    };
    const p1 = await publish(storage, identity, "token-apex");
    const p2 = await publish(storage, identity, "token-wild");
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    // The first TXT appeared with the shield already beside it.
    for (const line of [...shielded(BOX), ...shielded(`*.${BOX}`)]) {
      expect(seen[0]).toContain(line);
    }
    expect(cf.dump().filter((l) => l.startsWith("TXT"))).toHaveLength(2);

    // One TXT gone, one left: the shield stays.
    const ids = cf.records.filter((r) => r.type === "TXT").map((r) => r.id);
    expect((await remove(storage, identity, ids[0]!)).status).toBe(200);
    expect(cf.dump()).toContain(shielded(BOX)[0]);
    // The last one gone: the shield goes, the account set stays.
    expect((await remove(storage, identity, ids[1]!)).status).toBe(200);
    expect(cf.dump()).toEqual(ROOT_SET);
  });

  it("shields a tier-2 service name at that name only", async () => {
    seedRoot();
    // Tier-2 publish is authorised by a phone-signed grant; shield a service host directly.
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, `blog.${ZONE}`, false);
    expect(cf.dump()).toEqual([...ROOT_SET, ...shielded(`blog.${ZONE}`)].sort());
    // The release is for the whole name pair but only deletes what exists.
    expect(await releaseChallengeShield(dns, RELAY, `blog.${ZONE}`, APEX)).toBe(2);
    expect(cf.dump()).toEqual(ROOT_SET);
  });

  it("never removes a legacy per-box record while the zone has no root wildcard to take over", async () => {
    const storage = new InMemoryStorage();
    const identity = key();
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: hexOf(identity.publicKey), registeredAt: 1_000 });
    cf.seed("A", BOX, RELAY.servicesIpv4);
    cf.seed("AAAA", BOX, RELAY.servicesIpv6);
    expect(await releaseChallengeShield(dns, RELAY, BOX, APEX)).toBe(0);
    expect(cf.records).toHaveLength(2);
  });

  it("never removes records that point somewhere else (a box on its own address)", async () => {
    seedRoot();
    cf.seed("A", BOX, "192.0.2.44");
    expect(await releaseChallengeShield(dns, RELAY, BOX, APEX)).toBe(0);
    expect(cf.dump()).toContain(`A ${BOX} 192.0.2.44`);
  });

  it("leaves a shield alone while a challenge TXT remains", async () => {
    seedRoot();
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, BOX, true);
    cf.seed("TXT", `_acme-challenge.${BOX}`, "pending");
    expect(await releaseChallengeShield(dns, RELAY, BOX, APEX)).toBe(0);
    expect(cf.dump().filter((l) => l.includes(BOX) && !l.startsWith("TXT"))).toHaveLength(4);
  });

  it("puts the shield back when a new challenge arrives while it is being taken down", async () => {
    seedRoot();
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, BOX, true);
    let injected = false;
    cf.afterRequest = (method) => {
      if (method === "DELETE" && !injected) {
        injected = true;
        cf.seed("TXT", `_acme-challenge.${BOX}`, "late");
      }
    };
    await releaseChallengeShield(dns, RELAY, BOX, APEX);
    expect(cf.dump().filter((l) => l.includes(BOX) && !l.startsWith("TXT"))).toHaveLength(4);
  });

  it("is taken down by the stale-challenge sweep too", async () => {
    seedRoot();
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, BOX, true);
    cf.seed("TXT", `_acme-challenge.${BOX}`, "abandoned");
    const r = await dns.deleteStaleAcmeTxt({ apex: APEX, cutoffMs: Date.parse("2026-10-18T00:00:00Z"), relay: RELAY });
    expect(r.deleted).toBe(1);
    expect(r.shieldsReleased).toBe(4);
    expect(cf.dump()).toEqual(ROOT_SET);
  });

  it("refuses to publish the challenge when the shield cannot be made (no half-dark window)", async () => {
    const { storage, identity } = await boxWithAccount();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST" && String(init?.body).includes('"A"')) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 1004 }] }), { status: 400 });
      }
      return real(url, init);
    });
    const r = await publish(storage, identity, "token");
    expect(r.status).toBe(502);
    expect(cf.records.some((x) => x.type === "TXT")).toBe(false);
  });

  it("adds nothing when no relay address is configured (compat)", async () => {
    const storage = new InMemoryStorage();
    const identity = key();
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: hexOf(identity.publicKey), registeredAt: 1_000 });
    const recordValueHash = sha256(new TextEncoder().encode("v"));
    const issuedAt = Date.now();
    const recordName = `_acme-challenge.${BOX}`;
    const r = await handleDns01Publish(
      { servers: storage.servers, dns, apex: APEX },
      {
        request: { serverId: BOX, recordName, recordValueHash: hexOf(recordValueHash), issuedAt },
        signature: hexOf(signDns01Publish({ serverId: BOX, recordName, recordValueHash, issuedAt }, identity)),
        recordValue: "v",
      },
    );
    expect(r.status).toBe(200);
    expect(cf.records.map((x) => x.type)).toEqual(["TXT"]);
  });
});

describe("auth-code issue", () => {
  async function issueFor(withDns: boolean, serial = "order00001") {
    const storage = new InMemoryStorage();
    const irk = key();
    // A demo account keeps the IRK-only issue (a real one also needs the admin approval).
    await storage.usernames.put({ username: "alice", irkPubHex: hexOf(irk.publicKey), claimedAt: 1, isDemo: true });
    const now = 5_000_000;
    const code = {
      version: 1 as const,
      serial,
      username: "alice",
      serverName: "home",
      serverDomain: BOX,
      delegatedPubKey: key().publicKey,
      userPubKey: irk.publicKey,
      issuedAt: now,
      expiresAt: now + 60_000,
    };
    const body = {
      code: { ...code, delegatedPubKey: hexOf(code.delegatedPubKey), userPubKey: hexOf(code.userPubKey) },
      signature: hexOf(signAuthCode(code, irk)),
    };
    return handleAuthCodeIssue(
      { storage: storage.authCodes, usernames: storage.usernames, now: () => now, ...(withDns ? { dns: deps() } : {}) },
      body,
    );
  }

  it("writes no record for the new box and clears the account's legacy set, so its name resolves through the root wildcard", async () => {
    seedRoot();
    seedFour("alice");
    seedFour("bob");
    const r = await issueFor(true);
    expect(r.status).toBe(200);
    expect(mine("alice")).toEqual([]);
    expect(mine("bob")).toHaveLength(4);
    expect(answerFor(cf.records, BOX)).toEqual({ result: "answer", values: [RELAY.servicesIpv4] });
    expect(cf.requests.filter((q) => q.startsWith("POST"))).toEqual([]);
  });

  it("leaves the legacy set while the root wildcard is not in the zone yet", async () => {
    seedFour("alice");
    expect((await issueFor(true)).status).toBe(200);
    expect(mine("alice")).toHaveLength(4);
  });

  it("a refused issue (bad signature) touches nothing", async () => {
    seedRoot();
    seedFour("alice");
    const storage = new InMemoryStorage();
    const irk = key();
    await storage.usernames.put({ username: "alice", irkPubHex: hexOf(irk.publicKey), claimedAt: 1, isDemo: true });
    const now = 5_000_000;
    const code = {
      version: 1 as const, serial: "order00002", username: "alice", serverName: "home", serverDomain: BOX,
      delegatedPubKey: key().publicKey, userPubKey: irk.publicKey, issuedAt: now, expiresAt: now + 60_000,
    };
    const r = await handleAuthCodeIssue(
      { storage: storage.authCodes, usernames: storage.usernames, now: () => now, dns: deps() },
      {
        code: { ...code, delegatedPubKey: hexOf(code.delegatedPubKey), userPubKey: hexOf(code.userPubKey) },
        signature: hexOf(signAuthCode(code, key())),
      },
    );
    expect(r.status).toBe(403);
    expect(mine("alice")).toHaveLength(4);
    expect(cf.requests.filter((q) => !q.startsWith("GET"))).toEqual([]);
  });
});
