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

describe("serverRegister — user-zone DNS publishing (N0c)", () => {
  it("publishes A records for the pod zone AND user zone", async () => {
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
    const names = fakeDns.upserted.map((u) => u.name).sort();
    expect(names).toEqual(
      [
        "*.alice.flagship.services",
        "*.home.alice.flagship.services",
        "alice.flagship.services",
        "home.alice.flagship.services",
      ].sort(),
    );
    for (const u of fakeDns.upserted) {
      expect(u.type).toBe("A");
      expect(u.content).toBe("203.0.113.42");
    }
  });
});
