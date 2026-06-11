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
import type { CloudflareDnsClient, CloudflareDnsRecord } from "../src/cloudflareDns.js";

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

class FakeDns implements Pick<CloudflareDnsClient, "upsert"> {
  upserted: Array<{ name: string; type: string; content: string }> = [];
  async upsert(args: { name: string; type: string; content: string }): Promise<CloudflareDnsRecord> {
    this.upserted.push({ name: args.name, type: args.type, content: args.content });
    return {
      id: `rec-${this.upserted.length}`,
      name: args.name,
      type: args.type as "A" | "AAAA" | "TXT" | "CNAME",
      content: args.content,
    };
  }
}

/** CAA-capable client that dedupes by (name, rdata) like the real CF client. */
class FakeCaaDns {
  caa = new Map<string, { id: string; name: string; content: string }>();
  calls = 0;
  created = 0;
  async upsert(opts: {
    name: string;
    type: "CAA";
    content: string;
    data?: { flags: number; tag: string; value: string };
  }): Promise<{ id: string; name: string; content: string }> {
    this.calls += 1;
    const key = `${opts.name}|${opts.content}`;
    const hit = this.caa.get(key);
    if (hit) return hit;
    this.created += 1;
    const rec = { id: `caa-${this.created}`, name: opts.name, content: opts.content };
    this.caa.set(key, rec);
    return rec;
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

describe("serverRegister — per-box DNS publishing (cert model A′)", () => {
  it("publishes ONLY the box apex + box wildcard A records", async () => {
    const usernames = new InMemoryUsernameStorage();
    const irk = makeKey();
    await usernames.put({
      username: "alice",
      irkPubHex: bytesToHex(irk.publicKey),
      claimedAt: 1_000,
    });

    const authCodes = new InMemoryAuthCodeStorage();
    const issued: AuthCode = {
      version: 1,
      serial: "abcd1234",
      username: "alice",
      serverName: "home",
      serverDomain: "home.alice.flagship.services",
      delegatedPubKey: makeKey().publicKey,
      userPubKey: irk.publicKey,
      issuedAt: 1_000,
      // 1h after issue — within the 24h server-side cap.
      expiresAt: 1_000 + 60 * 60_000,
    };
    const acSig = signAuthCode(issued, irk);
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

    const fakeDns = new FakeDns();
    const r = await handleServerRegister(
      {
        authCodes,
        servers: new InMemoryServerStorage(),
        routing: new InMemoryRoutingStorage(),
        dns: {
          client: fakeDns as unknown as CloudflareDnsClient,
          servicesIpv4: "203.0.113.42",
        },
        now: () => issuedAt,
      },
      {
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
    );
    expect(r.status).toBe(200);
    // PER-BOX DNS (cert model A′): TWO records, both scoped to this box —
    // the apex `home.alice` and the wildcard `*.home.alice` (which resolves
    // every `<service>.home.alice` name). The model-C user-zone pair is gone.
    const names = fakeDns.upserted.map((u) => u.name).sort();
    expect(names).toEqual([
      "*.home.alice.flagship.services",
      "home.alice.flagship.services",
    ]);
    expect(names).not.toContain("alice.flagship.services");
    expect(names).not.toContain("*.alice.flagship.services");
    for (const u of fakeDns.upserted) {
      expect(u.type).toBe("A");
      expect(u.content).toBe("203.0.113.42");
    }
  });

  it("publishes the CA-restriction CAA record set when a caa client is wired", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const fakeDns = new FakeDns();
    const caaDns = new FakeCaaDns();
    const r = await handleServerRegister(
      {
        authCodes,
        servers: new InMemoryServerStorage(),
        dns: {
          client: fakeDns as unknown as CloudflareDnsClient,
          servicesIpv4: "203.0.113.42",
          caa: { client: caaDns },
        },
        now: () => issuedAt,
      },
      body,
    );
    expect(r.status).toBe(200);
    // CAA stays at the USER zone even though A/AAAA + certs are per-box (A′):
    // RFC 8659 tree-climbing makes the user-zone records cover every per-box
    // and service name below them.
    const caaSet = [...caaDns.caa.values()].map((v) => `${v.name} :: ${v.content}`).sort();
    expect(caaSet).toEqual(
      [
        'alice.flagship.services :: 0 issue "letsencrypt.org"',
        'alice.flagship.services :: 0 issuewild "letsencrypt.org"',
        'alice.flagship.services :: 0 iodef "mailto:security@flagshipserver.com"',
        '*.alice.flagship.services :: 0 issue "letsencrypt.org"',
        '*.alice.flagship.services :: 0 issuewild "letsencrypt.org"',
        '*.alice.flagship.services :: 0 iodef "mailto:security@flagshipserver.com"',
      ].sort(),
    );
    expect((r.body as { caaPublished: unknown[] }).caaPublished).toHaveLength(6);
  });

  it("does NOT duplicate CAA across a re-register of a second pod under the same user", async () => {
    const caaDns = new FakeCaaDns();
    for (const server of ["home", "media"]) {
      const { authCodes, issuedAt, body } = await buildRegister("alice", server);
      const r = await handleServerRegister(
        {
          authCodes,
          servers: new InMemoryServerStorage(),
          dns: {
            client: new FakeDns() as unknown as CloudflareDnsClient,
            servicesIpv4: "203.0.113.42",
            caa: { client: caaDns },
          },
          now: () => issuedAt,
        },
        body,
      );
      expect(r.status).toBe(200);
    }
    // Two registrations, but only ONE user zone → 6 distinct CAA records, no dupes.
    expect(caaDns.created).toBe(6);
    expect(caaDns.caa.size).toBe(6);
    expect(caaDns.calls).toBe(12); // 6 per register × 2, half no-ops
  });

  it("skips CAA (no throw) when no caa client is configured", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const r = await handleServerRegister(
      {
        authCodes,
        servers: new InMemoryServerStorage(),
        dns: { client: new FakeDns() as unknown as CloudflareDnsClient, servicesIpv4: "203.0.113.42" },
        now: () => issuedAt,
      },
      body,
    );
    expect(r.status).toBe(200);
    expect((r.body as { caaPublished: unknown[] }).caaPublished).toEqual([]);
  });

  it("a CAA failure does NOT fail registration (best-effort)", async () => {
    const { authCodes, issuedAt, body } = await buildRegister("alice", "home");
    const throwingCaa = {
      async upsert(): Promise<never> {
        throw new Error("CAA write refused");
      },
    };
    const r = await handleServerRegister(
      {
        authCodes,
        servers: new InMemoryServerStorage(),
        dns: {
          client: new FakeDns() as unknown as CloudflareDnsClient,
          servicesIpv4: "203.0.113.42",
          caa: { client: throwingCaa },
        },
        now: () => issuedAt,
      },
      body,
    );
    expect(r.status).toBe(200);
    expect((r.body as { caaError?: string }).caaError).toMatch(/CAA write refused/);
  });
});
