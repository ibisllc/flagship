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
import {
  accountInUse,
  accountZoneOfServerDomain,
  ensureAccountDns,
  reconcileAccountDns,
  releaseChallengeShield,
  removeAccountDns,
  removeBoxDns,
} from "../src/accountDns.js";
import { handleAccountDeletionBundle } from "../src/accountDeletion.js";
import { CloudflareDnsClient } from "../src/cloudflareDns.js";
import { handleDns01Delete, handleDns01Publish } from "../src/dns01.js";
import { handleAuthCodeIssue } from "../src/authCode.js";
import { FakeCloudflare } from "./fakeCloudflare.js";

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
  return { client: dns, ...RELAY, caa: { client: dns } };
}

const ACCOUNT_SET = [
  `A *.${ZONE} ${RELAY.servicesIpv4}`,
  `AAAA *.${ZONE} ${RELAY.servicesIpv6}`,
  `CAA ${ZONE} 0 issue "letsencrypt.org"`,
  `CAA ${ZONE} 0 issuewild "letsencrypt.org"`,
].sort();

describe("the account record set", () => {
  it("is four records: the wildcard A + AAAA and two CAA at the user zone, nothing per box", async () => {
    const r = await ensureAccountDns(deps(), ZONE);
    expect(r.dnsError).toBeUndefined();
    expect(r.caaError).toBeUndefined();
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("is idempotent: a second server of the account adds nothing", async () => {
    await ensureAccountDns(deps(), ZONE);
    await ensureAccountDns(deps(), ZONE);
    await ensureAccountDns(deps(), ZONE);
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("survives two registrations racing to create it (Cloudflare 81058 on the loser)", async () => {
    const [a, b] = await Promise.all([ensureAccountDns(deps(), ZONE), ensureAccountDns(deps(), ZONE)]);
    expect(a.dnsError).toBeUndefined();
    expect(b.dnsError).toBeUndefined();
    expect(a.caaError).toBeUndefined();
    expect(b.caaError).toBeUndefined();
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("repoints the wildcard when the relay moves", async () => {
    await ensureAccountDns(deps(), ZONE);
    await ensureAccountDns({ ...deps(), servicesIpv4: "198.51.100.9" }, ZONE);
    expect(cf.dump()).toContain(`A *.${ZONE} 198.51.100.9`);
    expect(cf.dump().filter((l) => l.startsWith("A "))).toHaveLength(1);
  });

  it("answers a v4-only relay with A and no AAAA", async () => {
    await ensureAccountDns({ client: dns, servicesIpv4: RELAY.servicesIpv4, caa: { client: dns } }, ZONE);
    expect(cf.names()).toEqual([`A *.${ZONE}`, `CAA ${ZONE}`, `CAA ${ZONE}`].sort());
  });

  it("reports a failure without throwing and still tries CAA", async () => {
    const failing = {
      async upsert(): Promise<never> {
        throw new Error("zone unreachable");
      },
    };
    const r = await ensureAccountDns({ ...deps(), client: failing }, ZONE);
    expect(r.dnsError).toMatch(/zone unreachable/);
    expect(r.caaPublished).toHaveLength(2);
  });

  it("derives the account zone from a server domain without knowing the apex", () => {
    expect(accountZoneOfServerDomain(BOX)).toBe(ZONE);
    expect(accountZoneOfServerDomain("home.alice.gym.flagship.services")).toBe("alice.gym.flagship.services");
    expect(accountZoneOfServerDomain("alice.flagship.services")).toBeNull(); // no server label ahead of the user
    expect(accountZoneOfServerDomain("flagship")).toBeNull();
  });
});

describe("removing it", () => {
  it("deletes the account set and the older *.<user> CAA, and nothing of another account", async () => {
    await ensureAccountDns(deps(), ZONE);
    await ensureAccountDns(deps(), `bob.${APEX}`);
    // What older builds also wrote for alice.
    cf.seed("CAA", `*.${ZONE}`, '0 issue "letsencrypt.org"');
    cf.seed("CAA", `*.${ZONE}`, '0 iodef "mailto:security@flagshipserver.com"');
    cf.seed("CAA", ZONE, '0 iodef "mailto:security@flagshipserver.com"');
    const deleted = await removeAccountDns(dns, ZONE);
    expect(deleted).toBe(4 + 3);
    expect(cf.records.every((r) => r.name.endsWith(`bob.${APEX}`))).toBe(true);
    expect(cf.records).toHaveLength(4);
  });

  it("deletes the per-box pair older builds published, only for that box", async () => {
    for (const name of [BOX, `*.${BOX}`, `media.${ZONE}`]) {
      cf.seed("A", name, RELAY.servicesIpv4);
      cf.seed("AAAA", name, RELAY.servicesIpv6);
    }
    expect(await removeBoxDns(dns, BOX)).toBe(4);
    expect(cf.names()).toEqual([`A media.${ZONE}`, `AAAA media.${ZONE}`]);
  });
});

describe("keeping it while the account has anything to serve", () => {
  async function storageWith(domains: string[], revoked: string[] = []) {
    const storage = new InMemoryStorage();
    for (const d of domains) {
      await storage.servers.put({ serverDomain: d, username: "alice", identityPubKeyHex: "aa".repeat(32), registeredAt: 1 });
    }
    for (const d of revoked) await storage.servers.revoke(d, "test", 5);
    return storage;
  }

  it("removes the set when the last server is gone", async () => {
    await ensureAccountDns(deps(), ZONE);
    const storage = await storageWith([BOX], [BOX]);
    const r = await reconcileAccountDns({ use: { servers: storage.servers }, username: "alice", userZone: ZONE, remover: dns, publish: deps() });
    expect(r).toEqual({ state: "removed", deleted: 4 });
    expect(cf.records).toHaveLength(0);
  });

  it("keeps it (and re-asserts it) while another server is live", async () => {
    await ensureAccountDns(deps(), ZONE);
    const storage = await storageWith([BOX, `media.${ZONE}`], [BOX]);
    const r = await reconcileAccountDns({ use: { servers: storage.servers }, username: "alice", userZone: ZONE, remover: dns, publish: deps() });
    expect(r.state).toBe("kept");
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("keeps it while an install is in flight, and stops once the order expired", async () => {
    await ensureAccountDns(deps(), ZONE);
    const storage = await storageWith([BOX], [BOX]);
    await storage.authCodes.put({
      serial: "order1234",
      username: "alice",
      serverName: "media",
      serverDomain: `media.${ZONE}`,
      delegatedPubKeyHex: "aa".repeat(32),
      userPubKeyHex: "bb".repeat(32),
      userSignatureHex: "cc".repeat(64),
      issuedAt: 1_000,
      expiresAt: 2_000,
      status: "active",
      recordedAt: 1_000,
    });
    const use = (now: number) => ({ servers: storage.servers, authCodes: storage.authCodes, now: () => now });
    expect(await accountInUse(use(1_500), "alice")).toBe(true);
    expect(await accountInUse(use(2_500), "alice")).toBe(false);
    const r = await reconcileAccountDns({ use: use(1_500), username: "alice", userZone: ZONE, remover: dns });
    expect(r.state).toBe("kept");
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("puts the set back when a registration lands while it is being deleted", async () => {
    await ensureAccountDns(deps(), ZONE);
    const storage = await storageWith([BOX], [BOX]);
    let raced = false;
    cf.afterRequest = (method) => {
      if (method === "DELETE" && !raced) {
        raced = true;
        void storage.servers.put({ serverDomain: `media.${ZONE}`, username: "alice", identityPubKeyHex: "dd".repeat(32), registeredAt: 9 });
      }
    };
    const r = await reconcileAccountDns({ use: { servers: storage.servers }, username: "alice", userZone: ZONE, remover: dns, publish: deps() });
    expect(r.state).toBe("healed");
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });
});

describe("account deletion", () => {
  it("removes the account's records with its last server, per-box leftovers included", async () => {
    const storage = new InMemoryStorage();
    const priv = new Uint8Array(32).fill(5);
    const irk: Keypair = { privateKey: priv, publicKey: ed.getPublicKey(priv) };
    const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    await storage.usernames.put({ username: "alice", irkPubHex: hex(irk.publicKey), claimedAt: 1_000 });
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: "aa".repeat(32), registeredAt: 1_000 });
    await ensureAccountDns(deps(), ZONE);
    cf.seed("A", BOX, RELAY.servicesIpv4);
    cf.seed("A", `*.${BOX}`, RELAY.servicesIpv4);
    await ensureAccountDns(deps(), `bob.${APEX}`);
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
    expect(cf.records.every((r) => r.name.endsWith(`bob.${APEX}`))).toBe(true);
    expect(cf.records).toHaveLength(4);
  });
});

// ── the challenge shield ────────────────────────────────────────────────────

function key(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
const hexOf = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function publish(storage: InMemoryStorage, identity: Keypair, value: string, host = BOX, serverId = BOX) {
  const recordName = `_acme-challenge.${host}`;
  const recordValueHash = sha256(new TextEncoder().encode(value));
  const issuedAt = Date.now();
  const claim = { serverId, recordName, recordValueHash, issuedAt };
  const r = await handleDns01Publish(
    { servers: storage.servers, dns, apex: APEX, shield: RELAY },
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
    await ensureAccountDns(deps(), ZONE);
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
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("shields a tier-2 service name at that name only", async () => {
    await ensureAccountDns(deps(), ZONE);
    // Tier-2 publish is authorised by a phone-signed grant; shield a service host directly.
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, `blog.${ZONE}`, false);
    expect(cf.dump()).toEqual([...ACCOUNT_SET, ...shielded(`blog.${ZONE}`)].sort());
    // The release is for the whole name pair but only deletes what exists.
    expect(await releaseChallengeShield(dns, RELAY, `blog.${ZONE}`, APEX)).toBe(2);
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("never removes a legacy per-box record while the account has no wildcard to take over", async () => {
    const storage = new InMemoryStorage();
    const identity = key();
    await storage.servers.put({ serverDomain: BOX, username: "alice", identityPubKeyHex: hexOf(identity.publicKey), registeredAt: 1_000 });
    cf.seed("A", BOX, RELAY.servicesIpv4);
    cf.seed("AAAA", BOX, RELAY.servicesIpv6);
    expect(await releaseChallengeShield(dns, RELAY, BOX, APEX)).toBe(0);
    expect(cf.records).toHaveLength(2);
  });

  it("never removes records that point somewhere else (a box on its own address)", async () => {
    await ensureAccountDns(deps(), ZONE);
    cf.seed("A", BOX, "192.0.2.44");
    expect(await releaseChallengeShield(dns, RELAY, BOX, APEX)).toBe(0);
    expect(cf.dump()).toContain(`A ${BOX} 192.0.2.44`);
  });

  it("leaves a shield alone while a challenge TXT remains", async () => {
    await ensureAccountDns(deps(), ZONE);
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, BOX, true);
    cf.seed("TXT", `_acme-challenge.${BOX}`, "pending");
    expect(await releaseChallengeShield(dns, RELAY, BOX, APEX)).toBe(0);
    expect(cf.dump().filter((l) => l.includes(BOX) && !l.startsWith("TXT"))).toHaveLength(4);
  });

  it("puts the shield back when a new challenge arrives while it is being taken down", async () => {
    await ensureAccountDns(deps(), ZONE);
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
    await ensureAccountDns(deps(), ZONE);
    const { ensureChallengeShield } = await import("../src/accountDns.js");
    await ensureChallengeShield(dns, RELAY, BOX, true);
    cf.seed("TXT", `_acme-challenge.${BOX}`, "abandoned");
    const r = await dns.deleteStaleAcmeTxt({ apex: APEX, cutoffMs: Date.parse("2026-10-18T00:00:00Z"), relay: RELAY });
    expect(r.deleted).toBe(1);
    expect(r.shieldsReleased).toBe(4);
    expect(cf.dump()).toEqual(ACCOUNT_SET);
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
  it("creates the account set before the box registers, so its name never caches as missing", async () => {
    const storage = new InMemoryStorage();
    const irk = key();
    // A demo account keeps the IRK-only issue (a real one also needs the admin approval).
    await storage.usernames.put({ username: "alice", irkPubHex: hexOf(irk.publicKey), claimedAt: 1, isDemo: true });
    const now = 5_000_000;
    const code = {
      version: 1 as const,
      serial: "order00001",
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
    const issue = (dnsDeps?: ReturnType<typeof deps>) =>
      handleAuthCodeIssue(
        { storage: storage.authCodes, usernames: storage.usernames, now: () => now, ...(dnsDeps ? { dns: dnsDeps } : {}) },
        body,
      );
    const r = await issue(deps());
    expect(r.status).toBe(200);
    expect(cf.dump()).toEqual(ACCOUNT_SET);
    // A repeat (a retried order) is refused as before and adds nothing.
    expect((await issue(deps())).status).not.toBe(200);
    expect(cf.dump()).toEqual(ACCOUNT_SET);
  });

  it("a refused issue (bad signature) publishes nothing", async () => {
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
    expect(cf.records).toHaveLength(0);
  });
});
