/**
 * Tests for /api/push/register, /api/push/relay, /api/push/<id> revoke.
 */

import { describe, expect, it } from "vitest";
import { ed, signPushTokenRegister, type Keypair } from "@flagship/protocol";
import {
  InMemoryAuditEventStorage,
  InMemoryPushTokenStorage,
  InMemoryUsernameStorage,
} from "@flagship/storage";
import { handlePushRegister, handlePushRelay, handlePushRevoke, QUARANTINE_MS } from "../src/push.js";

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
      label: "Harry's iPhone",
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
          label: claim.label,
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
      label: "Harry's iPhone",
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
          label: claim.label,
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
      label: "Harry's iPhone",
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
          label: claim.label,
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
          label: "Test",
          issuedAt: Date.now(),
        },
        signature: "00".repeat(64),
      },
    );
    expect(r.status).toBe(400);
  });

  it("persists the user-facing label", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const claim = {
      username: "alice",
      platform: "apns" as const,
      providerToken: "apns-device-abc",
      pushX25519Pub: samplePushPub,
      label: "Harry's iPhone (kitchen)",
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
          label: claim.label,
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(200);
    const all = await pushTokens.listByUser("alice");
    expect(all[0]?.label).toBe("Harry's iPhone (kitchen)");
  });

  it("rejects a label longer than 64 bytes", async () => {
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
          pushX25519Pub: bytesToHex(samplePushPub),
          label: "x".repeat(65),
          issuedAt: Date.now(),
        },
        signature: "00".repeat(64),
      },
    );
    expect(r.status).toBe(400);
  });

  it("rejects a label containing control characters", async () => {
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
          pushX25519Pub: bytesToHex(samplePushPub),
          label: "BadLabel",       // BEL char
          issuedAt: Date.now(),
        },
        signature: "00".repeat(64),
      },
    );
    expect(r.status).toBe(400);
  });

  it("rejects a request missing the label field outright", async () => {
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
          pushX25519Pub: bytesToHex(samplePushPub),
          // label intentionally omitted
          issuedAt: Date.now(),
        } as unknown as { username: string; platform: string },
        signature: "00".repeat(64),
      },
    );
    expect(r.status).toBe(400);
  });

  it("re-registering the same token-id updates the label", async () => {
    // The handler always mints a fresh tokenId, but at storage layer
    // an idempotent `put` should respect ON CONFLICT semantics — confirm
    // direct re-put updates label.
    const pushTokens = new InMemoryPushTokenStorage();
    await pushTokens.put({
      tokenId: "tok1",
      username: "alice",
      platform: "apns",
      providerToken: "p1",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "First",
      registeredAt: 1,
      lastSeenAt: 1,
    });
    await pushTokens.put({
      tokenId: "tok1",
      username: "alice",
      platform: "apns",
      providerToken: "p1",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "Renamed",
      registeredAt: 1,
      lastSeenAt: 99,
    });
    const rec = await pushTokens.get("tok1");
    expect(rec?.label).toBe("Renamed");
  });

  it("label is part of the IRK-signed canonical bytes — tampering with it post-sign is rejected", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    const claim = {
      username: "alice",
      platform: "apns" as const,
      providerToken: "apns-device-abc",
      pushX25519Pub: samplePushPub,
      label: "Original",
      issuedAt: Date.now(),
    };
    const sig = signPushTokenRegister(claim, irk);
    // Submit a tampered label with the original signature — signature
    // verification must fail because label is in the canonical bytes.
    const r = await handlePushRegister(
      { pushTokens, usernames },
      {
        request: {
          username: claim.username,
          platform: claim.platform,
          providerToken: claim.providerToken,
          pushX25519Pub: bytesToHex(claim.pushX25519Pub),
          label: "Tampered",
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
    );
    expect(r.status).toBe(403);
  });
});

describe("/api/push/register — Phase 3b vouched-admit quarantine", () => {
  const FIXED_NOW = 1_700_000_000_000;

  async function admit(opts: {
    quarantine?: boolean;
    auditEvents?: InMemoryAuditEventStorage;
  }) {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk();
    await seed(usernames, "alice", irk);
    const claim = {
      username: "alice",
      platform: "apns" as const,
      providerToken: "apns-collab",
      pushX25519Pub: samplePushPub,
      label: "Collaborator's Pixel",
      issuedAt: FIXED_NOW,
    };
    const sig = signPushTokenRegister(claim, irk);
    const r = await handlePushRegister(
      {
        pushTokens,
        usernames,
        now: () => FIXED_NOW,
        ...(opts.auditEvents ? { auditEvents: opts.auditEvents } : {}),
      },
      {
        request: {
          username: claim.username,
          platform: claim.platform,
          providerToken: claim.providerToken,
          pushX25519Pub: bytesToHex(claim.pushX25519Pub),
          label: claim.label,
          issuedAt: claim.issuedAt,
        },
        signature: bytesToHex(sig),
      },
      opts.quarantine === undefined ? undefined : { quarantine: opts.quarantine },
    );
    return { r, pushTokens };
  }

  it("stamps quarantineUntil = now + 14d when quarantine:true", async () => {
    const { r, pushTokens } = await admit({ quarantine: true });
    expect(r.status).toBe(200);
    expect((r.body as { quarantineUntil: number }).quarantineUntil).toBe(
      FIXED_NOW + QUARANTINE_MS,
    );
    const all = await pushTokens.listByUser("alice");
    expect(all[0]?.quarantineUntil).toBe(FIXED_NOW + QUARANTINE_MS);
    // The alert bitmap starts clear; the cron OR-s in T+0 later.
    expect(all[0]?.quarantineAlertsFiredBitmap).toBe(0);
  });

  it("emits a device-added audit event on a vouched admit", async () => {
    const auditEvents = new InMemoryAuditEventStorage();
    await admit({ quarantine: true, auditEvents });
    const events = await auditEvents.list("alice", 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("device-added");
    expect(events[0]?.quarantineUntil).toBe(FIXED_NOW + QUARANTINE_MS);
    expect(events[0]?.detail).toMatch(/joined/i);
  });

  it("default path (no options) is unchanged — no quarantine, no audit", async () => {
    const auditEvents = new InMemoryAuditEventStorage();
    const { r, pushTokens } = await admit({ auditEvents });
    expect(r.status).toBe(200);
    expect((r.body as { quarantineUntil?: number }).quarantineUntil).toBeUndefined();
    const all = await pushTokens.listByUser("alice");
    expect(all[0]?.quarantineUntil).toBe(0);
    expect(await auditEvents.list("alice", 0, 10)).toHaveLength(0);
  });

  it("quarantine:false is also a no-op (explicit default-off)", async () => {
    const auditEvents = new InMemoryAuditEventStorage();
    const { pushTokens } = await admit({ quarantine: false, auditEvents });
    const all = await pushTokens.listByUser("alice");
    expect(all[0]?.quarantineUntil).toBe(0);
    expect(await auditEvents.list("alice", 0, 10)).toHaveLength(0);
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
      label: "",
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
      label: "",
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
      label: "",
      registeredAt: 0,
      lastSeenAt: 0,
    });
    await handlePushRevoke({ pushTokens, usernames }, "tok1", undefined);
    expect(await pushTokens.get("tok1")).toBeUndefined();
  });
});
