/**
 * V01 adversarial integration: app-name certificates (`*.<user>.<apex>`) and the admin's
 * once-per-server `flagship/server-wildcard-grant/v1` (SECURITY-0.3-PROGRESS "App names get a
 * certificate on every server"). Two independent gates check the grant before a challenge record is
 * written: `.com` (packages/control-plane/src/dns01.ts) and the DNS broker (apps/dns-broker). They are
 * run here side by side on the same hostile inputs: any case where one accepts and the other refuses is
 * a finding, and every case must be refused by both unless it is the one legitimate shape.
 *
 *   AT-CRT-01  differential: .com and the broker agree on every hostile grant/record combination
 *   AT-CRT-02  a revoked server's grant is dead at .com
 *   AT-CRT-03  the grant cannot even be built for a server outside the named account
 *   AT-CRT-04  the box keeps only a grant the account's sensitive key signed for THIS server and key
 *   AT-CRT-05  keyd makes certificate keys only for the box's own names and its account's app names
 *   AT-CRT-06  keyd's allowed names never widen past *.<user>.<apex>, whatever FQDN it is given (FINDING)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { describe, expect, it } from "vitest";
import { ed, signDns01Publish, signServerWildcardGrant, canonicalServerWildcardGrant, type Dns01PublishRequest } from "../../../packages/protocol/src/index.js";
import { InMemoryStorage } from "../../../packages/storage/src/index.js";
import { handleDns01Publish } from "../../../packages/control-plane/src/dns01.js";
import { CloudflareDnsClient, type CloudflareDnsRecord } from "../../../packages/control-plane/src/cloudflareDns.js";
import { verifyRpc, type PolicyEnv, type PublishTxtChallengeBody } from "../../../apps/dns-broker/src/policy.js";
import { ServerWildcardGrantStore } from "../../../packages/server-daemon/src/serverWildcardGrant.js";
import { TlsKeys } from "../../../packages/keyd/src/tls.js";
import { namesFor } from "../../../packages/keyd/src/migrate.js";

const APEX = "flagship.services";
const NOW = Date.now();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (n: number) => {
  const privateKey = new Uint8Array(32).fill(n);
  return { privateKey, publicKey: ed.getPublicKey(privateKey) };
};

const POD = kp(1); // home.alice's registered key
const BOBPOD = kp(2); // home.bob's
const ADMIN = kp(3); // alice's admin root
const IRK = kp(4); // alice's IRK
const BOBADMIN = kp(5);
const SERVER = `home.alice.${APEX}`;

class FakeDns extends CloudflareDnsClient {
  made: string[] = [];
  constructor() {
    super({ apiToken: "x", zoneId: "x" });
  }
  override async createTxt(o: { name: string; value: string }): Promise<CloudflareDnsRecord> {
    this.made.push(o.name);
    return { id: `r${this.made.length}`, name: o.name, type: "TXT", content: o.value, proxied: false, ttl: 60 } as CloudflareDnsRecord;
  }
}

interface Case {
  name: string;
  recordName: string;
  serverId?: string;
  pod?: { privateKey: Uint8Array; publicKey: Uint8Array };
  grant?: { signer: { privateKey: Uint8Array }; username?: string; serverDomain?: string; stk?: Uint8Array } | null;
  expect: boolean;
}

function grantWire(g: NonNullable<Case["grant"]>, fallbackStk: Uint8Array) {
  const issuedAt = 1_760_000_000_000;
  const sig = signServerWildcardGrant(
    { username: g.username ?? "alice", serverDomain: g.serverDomain ?? SERVER, stkPubHex: hex(g.stk ?? fallbackStk), issuedAt },
    (m) => ed.sign(m, g.signer.privateKey),
  );
  return { issuedAt, signature: hex(sig) };
}

async function viaCom(c: Case, revoked = false): Promise<boolean> {
  const storage = new InMemoryStorage();
  await storage.servers.put({ serverDomain: SERVER, username: "alice", identityPubKeyHex: hex(POD.publicKey), registeredAt: 1, ...(revoked ? { revokedAt: 2 } : {}) } as never);
  await storage.servers.put({ serverDomain: `home.bob.${APEX}`, username: "bob", identityPubKeyHex: hex(BOBPOD.publicKey), registeredAt: 1 } as never);
  await storage.usernames.put({ username: "alice", irkPubHex: hex(IRK.publicKey), adminRootPubHex: hex(ADMIN.publicKey), claimedAt: 1 } as never);
  await storage.usernames.put({ username: "bob", irkPubHex: hex(kp(6).publicKey), adminRootPubHex: hex(BOBADMIN.publicKey), claimedAt: 1 } as never);
  const dns = new FakeDns();
  const serverId = c.serverId ?? SERVER;
  const pod = c.pod ?? POD;
  const value = "tok";
  const recordValueHash = sha256(new TextEncoder().encode(value));
  const claim: Dns01PublishRequest = { serverId, recordName: c.recordName, recordValueHash, issuedAt: NOW };
  const body = {
    request: { serverId, recordName: c.recordName, recordValueHash: hex(recordValueHash), issuedAt: NOW },
    signature: hex(signDns01Publish(claim, pod)),
    recordValue: value,
    ...(c.grant ? { serverWildcardGrant: grantWire(c.grant, pod.publicKey) } : {}),
  };
  const r = await handleDns01Publish({ servers: storage.servers, usernames: storage.usernames, dns, apex: APEX, now: () => NOW }, body);
  return r.status === 200 && dns.made.length === 1;
}

async function viaBroker(c: Case): Promise<boolean> {
  const serverId = c.serverId ?? SERVER;
  const pod = c.pod ?? POD;
  const value = "tok";
  const recordValueHash = sha256(new TextEncoder().encode(value));
  const claim: Dns01PublishRequest = { serverId, recordName: c.recordName, recordValueHash, issuedAt: NOW };
  const g = c.grant ? grantWire(c.grant, pod.publicKey) : undefined;
  const body = {
    kind: "publishTxtChallenge",
    recordName: c.recordName,
    recordValue: value,
    authority: { type: "server-wildcard", serverId, recordValueHashHex: hex(recordValueHash), issuedAt: NOW, signatureHex: hex(signDns01Publish(claim, pod)), ...(g ? { grant: { issuedAt: g.issuedAt, signatureHex: g.signature } } : {}) },
  } as unknown as PublishTxtChallengeBody;
  const env: PolicyEnv = {
    apex: APEX,
    servicesIpv4: "149.248.216.86",
    servicesIpv6: "2a09:8280:1::110:d2b6:0",
    replayWindowMs: 5 * 60_000,
    now: NOW,
    resolvePodIdentity: async (s: string) => (s === SERVER ? POD.publicKey : s === `home.bob.${APEX}` ? BOBPOD.publicKey : null),
    resolveUserIrk: async () => null,
    resolveUserSensitiveKey: async (u: string) => (u === "alice" ? ADMIN.publicKey : u === "bob" ? BOBADMIN.publicKey : null),
  } as PolicyEnv;
  const r = await verifyRpc(body, env);
  return r.ok === true;
}

const ACCOUNT = `_acme-challenge.alice.${APEX}`;
const CASES: Case[] = [
  { name: "the legitimate grant", recordName: ACCOUNT, grant: { signer: ADMIN }, expect: true },
  { name: "no grant", recordName: ACCOUNT, grant: null, expect: false },
  { name: "IRK-signed while an admin root is pinned", recordName: ACCOUNT, grant: { signer: IRK }, expect: false },
  { name: "another account's admin signs for alice's server", recordName: ACCOUNT, grant: { signer: BOBADMIN }, expect: false },
  { name: "grant for another server of the account", recordName: ACCOUNT, grant: { signer: ADMIN, serverDomain: `home2.alice.${APEX}` }, expect: false },
  { name: "grant for another key (a server re-registered under the name)", recordName: ACCOUNT, grant: { signer: ADMIN, stk: kp(9).publicKey }, expect: false },
  { name: "valid grant, another account's name", recordName: `_acme-challenge.bob.${APEX}`, grant: { signer: ADMIN }, expect: false },
  { name: "valid grant, upper-case account name (same DNS name)", recordName: `_acme-challenge.ALICE.${APEX}`, grant: { signer: ADMIN }, expect: false },
  { name: "valid grant, trailing dot", recordName: `${ACCOUNT}.`, grant: { signer: ADMIN }, expect: false },
  { name: "valid grant, the apex itself", recordName: `_acme-challenge.${APEX}`, grant: { signer: ADMIN }, expect: false },
  { name: "valid grant, a sibling app name", recordName: `_acme-challenge.chess.alice.${APEX}`, grant: { signer: ADMIN }, expect: false },
  { name: "bob's box replays alice's grant for alice's name", recordName: ACCOUNT, serverId: `home.bob.${APEX}`, pod: BOBPOD, grant: { signer: ADMIN }, expect: false },
  { name: "bob's box with a grant bob's admin signed, alice's name", recordName: ACCOUNT, serverId: `home.bob.${APEX}`, pod: BOBPOD, grant: { signer: BOBADMIN, username: "bob", serverDomain: `home.bob.${APEX}` }, expect: false },
  { name: "the request signed by another key than the server's", recordName: ACCOUNT, pod: kp(10), grant: { signer: ADMIN, stk: POD.publicKey }, expect: false },
];

describe("app-name certificate grant", () => {
  it("AT-CRT-01 .com and the DNS broker agree on every hostile grant and record, and accept only the legitimate shape (catches: one gate looser than the other, or a grant usable for another name, server, key or account)", async () => {
    const out: string[] = [];
    for (const c of CASES) {
      const [com, broker] = [await viaCom(c), await viaBroker(c)];
      out.push(`${c.name}: com=${com} broker=${broker}`);
      expect(com, `.com: ${c.name}`).toBe(c.expect);
      expect(broker, `broker: ${c.name}`).toBe(c.expect);
    }
    expect(out).toHaveLength(CASES.length);
  });

  it("AT-CRT-02 a revoked server's still-valid grant writes nothing at .com (catches: a grant outliving the server it names)", async () => {
    expect(await viaCom({ name: "revoked", recordName: ACCOUNT, grant: { signer: ADMIN }, expect: false }, true)).toBe(false);
  });

  it("AT-CRT-03 a grant cannot be built for a server outside the named account, nor with a separator in a field (catches: `*.<other>` grants)", () => {
    const base = { username: "alice", serverDomain: SERVER, stkPubHex: hex(POD.publicKey), issuedAt: 1 };
    expect(() => canonicalServerWildcardGrant({ ...base, serverDomain: `home.bob.${APEX}` })).toThrow();
    expect(() => canonicalServerWildcardGrant({ ...base, username: "bob" })).toThrow();
    expect(() => canonicalServerWildcardGrant({ ...base, username: "alice|x" })).toThrow();
    expect(() => canonicalServerWildcardGrant({ ...base, stkPubHex: hex(POD.publicKey).toUpperCase() })).toThrow();
    expect(() => canonicalServerWildcardGrant({ ...base, issuedAt: -1 })).toThrow();
  });

  it("AT-CRT-04 the box keeps only a grant the account's sensitive key signed for this server and its own key (catches: a box accepting a grant made for another box or by a non-admin key)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crt-"));
    const store = new ServerWildcardGrantStore({
      path: join(dir, "grant.json"),
      serverDomain: SERVER,
      stkPubHex: hex(POD.publicKey),
      authority: () => ({ username: "alice", ownerIrkPub: IRK.publicKey, adminRootPub: ADMIN.publicKey }) as never,
    });
    const make = (signer: { privateKey: Uint8Array }, over: Partial<{ serverDomain: string; stk: Uint8Array }> = {}) => {
      const w = grantWire({ signer, ...(over.serverDomain ? { serverDomain: over.serverDomain } : {}), ...(over.stk ? { stk: over.stk } : {}) }, POD.publicKey);
      return { issuedAt: w.issuedAt, signatureHex: w.signature };
    };
    expect(store.verifies(make(ADMIN))).toBe(true);
    expect(store.verifies(make(IRK))).toBe(false);
    expect(store.verifies(make(BOBADMIN))).toBe(false);
    expect(store.verifies(make(ADMIN, { serverDomain: `home2.alice.${APEX}` }))).toBe(false);
    expect(store.verifies(make(ADMIN, { stk: kp(9).publicKey }))).toBe(false);
    await expect(store.accept(make(BOBADMIN))).rejects.toThrow();
    expect(await store.accept(make(ADMIN))).toBe(true);
  });

  it("AT-CRT-05 keyd creates a certificate key only for the box's own name, its subtree and its account's app names (catches: a compromised daemon asking keyd for another account's or the apex's certificate)", () => {
    const tls = new TlsKeys(new Set(namesFor(SERVER)), null);
    expect(() => tls.createKey([SERVER, `*.${SERVER}`, `*.alice.${APEX}`])).not.toThrow();
    for (const bad of [[`*.bob.${APEX}`], [`*.${APEX}`], [`alice.${APEX}`], [`home.bob.${APEX}`], [`*.alice.${APEX}`, `*.bob.${APEX}`], [`${SERVER}.`], ["*.*.alice.flagship.services"]]) {
      expect(() => tls.createKey(bad), bad.join(",")).toThrow();
    }
  });

  // FIXED (was a finding) AT-CRT-06: keyd's `namesFor` (packages/keyd/src/migrate.ts) derives the account wildcard by
  // dropping the first label of whatever FQDN its policy holds, and `writePolicyFromEnv` checks only that
  // FLAGSHIP_SUBDOMAIN is a DNS name. A policy FQDN of `alice.flagship.services` (or any 3-label name)
  // makes keyd willing to create a key for `*.flagship.services`, the whole apex. `.com` and Let's
  // Encrypt still refuse that challenge, so this is defence in depth (low), but keyd is the boundary
  // that should refuse it on its own.
  it("AT-CRT-06 keyd's allowed names never include a wildcard wider than *.<user>.<apex> (catches: a shape-unchecked FQDN widening keyd's certificate authority)", () => {
    expect(namesFor(SERVER).filter((n) => n.startsWith("*.") && n.split(".").length < 4)).toEqual([]);
    // A policy FQDN one label short: the account wildcard becomes the apex wildcard.
    expect(namesFor(`alice.${APEX}`).filter((n) => n.startsWith("*.") && n.split(".").length < 4)).toEqual([]);
    for (const bad of [APEX, `alice.${APEX}`, `a.home.alice.${APEX}`, `home.alice.example.com`, `home.a--b.${APEX}`, `home.alice.${APEX}.evil.com`]) expect(namesFor(bad), bad).toEqual([]);
    expect(namesFor(`home.alice.gym.${APEX}`)).toContain(`*.alice.gym.${APEX}`);
  });
});
