import { describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { ed, signDns01Delete, signDns01Publish, type Keypair } from "@flagship/protocol";
import { InMemoryStorage } from "@flagship/storage";
import { handleDns01Delete, handleDns01Publish } from "../src/dns01.js";
import { CloudflareDnsClient, type CloudflareDnsRecord } from "../src/cloudflareDns.js";

const APEX = "flagship.services";
const SERVER_FQDN = `home.alice.${APEX}`;
const CHALLENGE_NAME = `_acme-challenge.${SERVER_FQDN}`;

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

interface FakeRecord {
  id: string;
  name: string;
  type: string;
  content: string;
}

class FakeCfClient extends CloudflareDnsClient {
  records = new Map<string, FakeRecord>();
  private counter = 1;

  constructor() {
    super({ apiToken: "fake", zoneId: "fake" });
  }

  override async createTxt(opts: { name: string; value: string; ttl?: number }): Promise<CloudflareDnsRecord> {
    const id = `cf-${this.counter++}`;
    const rec: FakeRecord = { id, name: opts.name, type: "TXT", content: opts.value };
    this.records.set(id, rec);
    return { ...rec, proxied: false, ttl: opts.ttl ?? 60 };
  }
  override async getById(id: string): Promise<CloudflareDnsRecord | null> {
    const r = this.records.get(id);
    if (!r) return null;
    return { ...r, proxied: false, ttl: 60 };
  }
  override async deleteById(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

async function registerServer(storage: InMemoryStorage, identity: Keypair, fqdn = SERVER_FQDN) {
  const idx = fqdn.indexOf(".");
  const username = fqdn.slice(idx + 1, fqdn.indexOf(`.${APEX}`));
  await storage.servers.put({
    serverDomain: fqdn,
    username,
    identityPubKeyHex: bytesToHex(identity.publicKey),
    registeredAt: 1_000,
  });
}

function publishBody(args: {
  identity: Keypair;
  recordValue: string;
  serverId?: string;
  recordName?: string;
  issuedAt?: number;
  signatureOverride?: Uint8Array;
}) {
  const recordValueHash = sha256(new TextEncoder().encode(args.recordValue));
  const issuedAt = args.issuedAt ?? Date.now();
  const claim = {
    serverId: args.serverId ?? SERVER_FQDN,
    recordName: args.recordName ?? CHALLENGE_NAME,
    recordValueHash,
    issuedAt,
  };
  const sig = args.signatureOverride ?? signDns01Publish(claim, args.identity);
  return {
    request: {
      serverId: claim.serverId,
      recordName: claim.recordName,
      recordValueHash: bytesToHex(recordValueHash),
      issuedAt,
    },
    signature: bytesToHex(sig),
    recordValue: args.recordValue,
  };
}

describe("handleDns01Publish", () => {
  it("creates a CF TXT record on a valid signed request", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const body = publishBody({ identity, recordValue: "challenge-token-1" });
    const r = await handleDns01Publish({ servers: storage.servers, dns }, body);
    expect(r.status).toBe(200);
    const out = r.body as { recordId: string };
    expect(out.recordId).toMatch(/^cf-/);
    const rec = [...dns.records.values()][0]!;
    expect(rec.name).toBe(CHALLENGE_NAME);
    expect(rec.content).toBe("challenge-token-1");
    expect(rec.type).toBe("TXT");
  });

  it("rejects an unknown server (404)", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    const dns = new FakeCfClient();
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({ identity, recordValue: "x" }),
    );
    expect(r.status).toBe(404);
  });

  it("rejects when the recordValue does not match the signed hash", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const body = publishBody({ identity, recordValue: "challenge-token-1" });
    body.recordValue = "tampered-value"; // server re-hashes; should fail
    const r = await handleDns01Publish({ servers: storage.servers, dns }, body);
    expect(r.status).toBe(400);
    expect(dns.records.size).toBe(0);
  });

  it("rejects a signature from a different key", async () => {
    const storage = new InMemoryStorage();
    const real = makeKey();
    const attacker = makeKey();
    await registerServer(storage, real);
    const dns = new FakeCfClient();
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({ identity: attacker, recordValue: "x" }),
    );
    expect(r.status).toBe(403);
    expect(dns.records.size).toBe(0);
  });

  it("rejects recordName outside the requesting server's _acme-challenge", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({ identity, recordValue: "x", recordName: `_acme-challenge.bob.${APEX}` }),
    );
    expect(r.status).toBe(403);
  });

  it("rejects a stale request (issuedAt outside replay window)", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const ancient = Date.now() - 60 * 60_000;
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({ identity, recordValue: "x", issuedAt: ancient }),
    );
    expect(r.status).toBe(403);
  });

  it("rejects a revoked server (403)", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    await storage.servers.revoke(SERVER_FQDN, "test", Date.now());
    const dns = new FakeCfClient();
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({ identity, recordValue: "x" }),
    );
    expect(r.status).toBe(403);
  });

  it("accepts the user-zone challenge name (N0c — for *.<user>.flagship.services SAN)", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({
        identity,
        recordValue: "user-zone-token",
        recordName: `_acme-challenge.alice.${APEX}`,
      }),
    );
    expect(r.status).toBe(200);
    const rec = [...dns.records.values()][0]!;
    expect(rec.name).toBe(`_acme-challenge.alice.${APEX}`);
  });

  it("rejects challenges for a DIFFERENT user's zone", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const r = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({
        identity,
        recordValue: "x",
        recordName: `_acme-challenge.bob.${APEX}`,
      }),
    );
    expect(r.status).toBe(403);
  });
});

describe("handleDns01Delete", () => {
  it("deletes a previously-published record on a valid signed request", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const pub = await handleDns01Publish(
      { servers: storage.servers, dns },
      publishBody({ identity, recordValue: "x" }),
    );
    const recordId = (pub.body as { recordId: string }).recordId;

    const issuedAt = Date.now();
    const claim = { serverId: SERVER_FQDN, recordId, issuedAt };
    const sig = signDns01Delete(claim, identity);
    const r = await handleDns01Delete(
      { servers: storage.servers, dns },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200);
    expect(dns.records.size).toBe(0);
  });

  it("refuses to delete a record that doesn't belong to the requesting server", async () => {
    const storage = new InMemoryStorage();
    const alice = makeKey();
    const bob = makeKey();
    await registerServer(storage, alice, `home.alice.${APEX}`);
    await registerServer(storage, bob, `home.bob.${APEX}`);
    const dns = new FakeCfClient();
    // Alice publishes a TXT under her own _acme-challenge.
    const aliceBody = publishBody({ identity: alice, recordValue: "alice-token" });
    const pub = await handleDns01Publish({ servers: storage.servers, dns }, aliceBody);
    const recordId = (pub.body as { recordId: string }).recordId;

    // Bob tries to delete it.
    const issuedAt = Date.now();
    const claim = { serverId: `home.bob.${APEX}`, recordId, issuedAt };
    const sig = signDns01Delete(claim, bob);
    const r = await handleDns01Delete(
      { servers: storage.servers, dns },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
    expect(dns.records.size).toBe(1);
  });

  it("rejects an unknown recordId (404)", async () => {
    const storage = new InMemoryStorage();
    const identity = makeKey();
    await registerServer(storage, identity);
    const dns = new FakeCfClient();
    const issuedAt = Date.now();
    const claim = { serverId: SERVER_FQDN, recordId: "does-not-exist", issuedAt };
    const sig = signDns01Delete(claim, identity);
    const r = await handleDns01Delete(
      { servers: storage.servers, dns },
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(404);
  });
});
