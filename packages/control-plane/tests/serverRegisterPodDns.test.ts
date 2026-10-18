import { describe, expect, it } from "vitest";
import { handleServerRegister } from "../src/serverRegister.js";
import {
  ed,
  signAuthCode,
  signServerRegister,
  type AuthCode,
  type Keypair,
  type ServerRegisterRequest,
} from "@flagship/protocol";
import {
  InMemoryAuthCodeStorage,
  InMemoryRoutingStorage,
  InMemoryServerStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

interface ZoneRow {
  id: string;
  type: string;
  name: string;
  content: string;
}

/** A tiny zone: lists everything, deletes by id, and records every call. */
class FakeZone {
  rows: ZoneRow[] = [];
  deleted: string[] = [];
  failList = false;
  private n = 0;
  add(type: string, name: string, content: string): void {
    this.rows.push({ id: `r${++this.n}`, type, name, content });
  }
  async listAll(): Promise<ZoneRow[]> {
    if (this.failList) throw new Error("zone unreachable");
    return [...this.rows];
  }
  async deleteById(id: string): Promise<boolean> {
    const i = this.rows.findIndex((r) => r.id === id);
    if (i < 0) return false;
    this.deleted.push(this.rows[i]!.name);
    this.rows.splice(i, 1);
    return true;
  }
  seedRoot(): void {
    this.add("A", "*.flagship.services", "203.0.113.42");
    this.add("CAA", "flagship.services", '0 issue "letsencrypt.org"');
  }
  seedLegacy(user: string): void {
    this.add("A", `*.${user}.flagship.services`, "203.0.113.42");
    this.add("CAA", `${user}.flagship.services`, '0 issue "letsencrypt.org"');
    this.add("A", `home.${user}.flagship.services`, "203.0.113.42");
  }
}

/** Build a fully-signed register request for `username`/`server`. */
async function buildRegister(username: string, serverName: string) {
  const usernames = new InMemoryUsernameStorage();
  const irk = makeKey();
  await usernames.put({ username, irkPubHex: bytesToHex(irk.publicKey), claimedAt: 1_000 });
  const serverDomain = `${serverName}.${username}.flagship.services`;
  const issued: AuthCode = {
    version: 1,
    serial: "abcd1234",
    username,
    serverName,
    serverDomain,
    delegatedPubKey: makeKey().publicKey,
    userPubKey: irk.publicKey,
    issuedAt: 1_000,
    expiresAt: 1_000 + 60 * 60_000,
  };
  const acSig = signAuthCode(issued, irk);
  const authCodes = new InMemoryAuthCodeStorage();
  await authCodes.put({
    serial: issued.serial,
    username: issued.username,
    serverName: issued.serverName,
    serverDomain: issued.serverDomain,
    delegatedPubKeyHex: bytesToHex(issued.delegatedPubKey),
    userPubKeyHex: bytesToHex(issued.userPubKey),
    userSignatureHex: bytesToHex(acSig),
    issuedAt: issued.issuedAt,
    expiresAt: issued.expiresAt,
    status: "active",
    recordedAt: issued.issuedAt,
  });
  const identity = makeKey();
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const issuedAt = 2_000;
  const reg: ServerRegisterRequest = {
    authCode: issued,
    authCodeUserSignature: acSig,
    serverIdentityPubKey: identity.publicKey,
    issuedAt,
    nonce,
  };
  const sig = signServerRegister(reg, identity);
  return {
    authCodes,
    issuedAt,
    body: {
      request: {
        authCode: {
          ...issued,
          delegatedPubKey: bytesToHex(issued.delegatedPubKey),
          userPubKey: bytesToHex(issued.userPubKey),
        },
        authCodeUserSignature: bytesToHex(acSig),
        serverIdentityPubKey: bytesToHex(identity.publicKey),
        issuedAt,
        nonce: bytesToHex(nonce),
      },
      signature: bytesToHex(sig),
    },
  };
}

describe("serverRegister — root wildcard (docs/wildcard-dns.md)", () => {
  const relay = { servicesIpv4: "203.0.113.42" };

  it("publishes nothing: the box's names resolve through the zone's root wildcard", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const zone = new FakeZone();
    zone.seedRoot();
    const before = JSON.stringify(zone.rows);
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryServerStorage(), routing: new InMemoryRoutingStorage(), dns: { client: zone, ...relay }, now: () => issuedAt },
      body,
    );
    expect(r.status).toBe(200);
    expect(JSON.stringify(zone.rows)).toBe(before);
    const out = r.body as Record<string, unknown>;
    expect(out.legacyDnsRemoved).toBe(0);
    expect(out).not.toHaveProperty("dnsPublished");
    expect(out).not.toHaveProperty("caaPublished");
  });

  it("removes the account's legacy records (they would stop the wildcard), and only that account's", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const zone = new FakeZone();
    zone.seedRoot();
    zone.seedLegacy("alice");
    zone.seedLegacy("bob");
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryServerStorage(), dns: { client: zone, ...relay }, now: () => issuedAt },
      body,
    );
    expect(r.status).toBe(200);
    expect((r.body as { legacyDnsRemoved: number }).legacyDnsRemoved).toBe(3);
    expect(zone.rows.filter((x) => x.name.includes("alice"))).toEqual([]);
    expect(zone.rows.filter((x) => x.name.includes("bob"))).toHaveLength(3);
  });

  it("leaves them alone until the root wildcard exists", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const zone = new FakeZone();
    zone.seedLegacy("alice");
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryServerStorage(), dns: { client: zone, ...relay }, now: () => issuedAt },
      body,
    );
    expect(r.status).toBe(200);
    expect(zone.deleted).toEqual([]);
  });

  it("a zone failure does NOT fail registration (best-effort) and is reported", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const zone = new FakeZone();
    zone.failList = true;
    const r = await handleServerRegister(
      { authCodes, servers: new InMemoryServerStorage(), dns: { client: zone, ...relay }, now: () => issuedAt },
      body,
    );
    expect(r.status).toBe(200);
    expect((r.body as { dnsError?: string }).dnsError).toMatch(/zone unreachable/);
  });

  it("registers a second box of the account without touching the zone", async () => {
    const zone = new FakeZone();
    zone.seedRoot();
    const before = JSON.stringify(zone.rows);
    for (const server of ["home", "media"]) {
      const { authCodes, issuedAt, body } = await buildRegister("alice", server);
      const r = await handleServerRegister(
        { authCodes, servers: new InMemoryServerStorage(), dns: { client: zone, ...relay }, now: () => issuedAt },
        body,
      );
      expect(r.status).toBe(200);
    }
    expect(JSON.stringify(zone.rows)).toBe(before);
  });
});
