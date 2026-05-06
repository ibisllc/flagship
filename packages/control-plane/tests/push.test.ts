/**
 * Tests for /api/push/register, /api/push/relay, /api/push/<id> revoke.
 */

import { describe, expect, it } from "vitest";
import { ed, signPushTokenRegister, type Keypair } from "@flagship/protocol";
import { InMemoryPushTokenStorage, InMemoryUsernameStorage } from "@flagship/storage";
import { handlePushRegister, handlePushRelay, handlePushRevoke } from "../src/push.js";

function makeIrk(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}
function bytesToHex(b: Uint8Array): string {
  let s = ""; for (const x of b) s += x.toString(16).padStart(2, "0"); return s;
}

async function seed(usernames: InMemoryUsernameStorage, name: string, irk: Keypair) {
  await usernames.put({ username: name, irkPubHex: bytesToHex(irk.publicKey), claimedAt: Date.now() });
}

const samplePushPub = (() => {
  const b = new Uint8Array(32); for (let i = 0; i < 32; i++) b[i] = i; return b;
})();

describe("/api/push/register", () => {
  it("registers an APNs token signed by IRK", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const claim = {
      username: "alice",
      platform: "apns" as const,
      providerToken: "apns-device-abc",
      pushX25519Pub: samplePushPub,
      issuedAt: Date.now(),
    };
    const sig = signPushTokenRegister(claim, irk);
    const r = await handlePushRegister(
      { pushTokens, usernames },
      {
        request: {
          username: claim.username,
          platform: claim.platform,
          providerToken: claim.providerToken,
          pushX25519Pub: bytesToHex(claim.pushX25519Pub),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(200);
    const body = r.body as { tokenId: string };
    expect(body.tokenId).toMatch(/^[0-9a-f]{32}$/);
    const all = await pushTokens.listByUser("alice");
    expect(all.length).toBe(1);
    expect(all[0]?.platform).toBe("apns");
  });

  it("rejects with wrong IRK signature", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const real = makeIrk(); const evil = makeIrk();
    await seed(usernames, "alice", real);
    const claim = {
      username: "alice",
      platform: "apns" as const,
      providerToken: "apns-device-abc",
      pushX25519Pub: samplePushPub,
      issuedAt: Date.now(),
    };
    const sig = signPushTokenRegister(claim, evil); // wrong key
    const r = await handlePushRegister(
      { pushTokens, usernames },
      {
        request: {
          username: claim.username,
          platform: claim.platform,
          providerToken: claim.providerToken,
          pushX25519Pub: bytesToHex(claim.pushX25519Pub),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(403);
  });

  it("rejects unknown username", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk();
    const claim = {
      username: "ghost",
      platform: "apns" as const,
      providerToken: "x",
      pushX25519Pub: samplePushPub,
      issuedAt: Date.now(),
    };
    const sig = signPushTokenRegister(claim, irk);
    const r = await handlePushRegister(
      { pushTokens, usernames },
      {
        request: {
          username: claim.username,
          platform: claim.platform,
          providerToken: claim.providerToken,
          pushX25519Pub: bytesToHex(claim.pushX25519Pub),
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(404);
  });

  it("rejects bad pushX25519Pub length", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const r = await handlePushRegister(
      { pushTokens, usernames },
      {
        request: {
          username: "alice",
          platform: "apns",
          providerToken: "x",
          pushX25519Pub: "deadbeef", // not 32 bytes
          issuedAt: Date.now(),
        },
        signature: "00".repeat(64),
      },
    );
    expect(r.status).toBe(400);
  });
});

describe("/api/push/relay", () => {
  it("returns simulated:true when no forwarder is wired", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    // Pre-register a token directly
    await pushTokens.put({
      tokenId: "abcd",
      username: "alice",
      platform: "apns",
      providerToken: "apns-x",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 0,
      lastSeenAt: 0,
    });
    const r = await handlePushRelay(
      { pushTokens, usernames },
      { targetUsername: "alice", category: "unlock-request", sealedPayloadHex: "deadbeef" },
    );
    expect(r.status).toBe(200);
    const body = r.body as { simulated: boolean; fanout: number };
    expect(body.simulated).toBe(true);
    expect(body.fanout).toBe(1);
  });

  it("404 when target has no tokens", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const r = await handlePushRelay(
      { pushTokens, usernames },
      { targetUsername: "nobody", category: "x", sealedPayloadHex: "00" },
    );
    expect(r.status).toBe(404);
  });

  it("rejects oversize payload", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const r = await handlePushRelay(
      { pushTokens, usernames },
      { targetUsername: "x", category: "y", sealedPayloadHex: "a".repeat(10_000) },
    );
    expect(r.status).toBe(400);
  });

  it("calls forwarder when wired and returns its result", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    await pushTokens.put({
      tokenId: "abcd",
      username: "alice",
      platform: "apns",
      providerToken: "apns-x",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 0,
      lastSeenAt: 0,
    });
    const calls: number[] = [];
    const r = await handlePushRelay(
      {
        pushTokens, usernames,
        forwardToProviders: async (args) => {
          calls.push(args.targets.length);
          return { ok: true, sent: args.targets.length, failed: 0 };
        },
      },
      { targetUsername: "alice", category: "unlock-request", sealedPayloadHex: "ab" },
    );
    expect(r.status).toBe(200);
    expect(calls).toEqual([1]);
  });
});

describe("/api/push/<token-id>", () => {
  it("DELETE removes the token", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    await pushTokens.put({
      tokenId: "tok1",
      username: "alice",
      platform: "apns",
      providerToken: "x",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      registeredAt: 0,
      lastSeenAt: 0,
    });
    await handlePushRevoke({ pushTokens, usernames }, "tok1", undefined);
    expect(await pushTokens.get("tok1")).toBeUndefined();
  });
});
