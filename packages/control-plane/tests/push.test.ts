/**
 * Tests for /api/push/register, /api/push/relay, /api/push/<id> revoke.
 */

import { describe, expect, it } from "vitest";
import {
  ed,
  signPushRelayRequest,
  signPushTokenRegister,
  signPushTokenRevoke,
  type Keypair,
  type PushRelayRequest,
} from "@flagship/protocol";
import {
  InMemoryAuditEventStorage,
  InMemoryPushTokenStorage,
  InMemoryStorage,
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

describe("/api/push/relay (SEC-2 STK-signed)", () => {
  const NOW = 1_700_000_000_000;

  // A box of the target user: a registered server whose identity (STK) key
  // signs the relay. This mirrors the daemon-status trust path.
  function makeBox(): Keypair {
    const priv = new Uint8Array(32);
    crypto.getRandomValues(priv);
    return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
  }

  async function setup(opts: { withToken?: boolean } = {}) {
    const storage = new InMemoryStorage();
    const box = makeBox();
    await storage.usernames.put({
      username: "alice",
      irkPubHex: bytesToHex(makeIrk().publicKey),
      claimedAt: NOW,
    });
    await storage.servers.put({
      serverDomain: "home1.alice.flagship.services",
      username: "alice",
      identityPubKeyHex: bytesToHex(box.publicKey),
      registeredAt: NOW - 50_000,
    });
    if (opts.withToken !== false) {
      await storage.pushTokens.put({
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
    }
    return { storage, box };
  }

  function signed(box: Keypair, over: Partial<PushRelayRequest> = {}) {
    const req: PushRelayRequest = {
      targetUsername: "alice",
      category: "unlock-request",
      sealedPayloadHex: "deadbeef",
      issuedAt: NOW,
      ...over,
    };
    return {
      request: req,
      signature: bytesToHex(signPushRelayRequest(req, box)),
    };
  }

  function deps(storage: InMemoryStorage, extra: Record<string, unknown> = {}) {
    return {
      pushTokens: storage.pushTokens,
      usernames: storage.usernames,
      servers: storage.servers,
      now: () => NOW,
      ...extra,
    };
  }

  it("returns simulated:true for a valid box-signed relay (no forwarder)", async () => {
    const { storage, box } = await setup();
    const r = await handlePushRelay(deps(storage), signed(box));
    expect(r.status).toBe(200);
    const body = r.body as { simulated: boolean; fanout: number };
    expect(body.simulated).toBe(true);
    expect(body.fanout).toBe(1);
  });

  it("calls forwarder when wired and returns its result", async () => {
    const { storage, box } = await setup();
    const calls: number[] = [];
    const r = await handlePushRelay(
      deps(storage, {
        forwardToProviders: async (args: { targets: unknown[] }) => {
          calls.push(args.targets.length);
          return { ok: true, sent: args.targets.length, failed: 0 };
        },
      }),
      signed(box),
    );
    expect(r.status).toBe(200);
    expect(calls).toEqual([1]);
  });

  it("403 when the signature is not from a registered box of the target", async () => {
    const { storage } = await setup();
    const stranger = makeBox();
    const r = await handlePushRelay(deps(storage), signed(stranger));
    expect(r.status).toBe(403);
  });

  it("403 (NOT 404) when the target has no tokens — no registration oracle", async () => {
    const { storage, box } = await setup({ withToken: false });
    // A valid box-signed relay to a user with zero tokens returns 200 fanout:0;
    // an UN-authorized caller to the same user returns 403 — identical 403 to
    // the has-tokens case, so token presence is not observable pre-auth.
    const valid = await handlePushRelay(deps(storage), signed(box));
    expect(valid.status).toBe(200);
    expect((valid.body as { fanout: number }).fanout).toBe(0);

    const stranger = makeBox();
    const noauth = await handlePushRelay(deps(storage), signed(stranger));
    expect(noauth.status).toBe(403);
  });

  it("rejects an unknown category", async () => {
    const { storage, box } = await setup();
    const req: PushRelayRequest = {
      targetUsername: "alice",
      category: "unlock-request",
      sealedPayloadHex: "deadbeef",
      issuedAt: NOW,
    };
    const sig = bytesToHex(signPushRelayRequest(req, box));
    // Tamper the category AFTER signing — the handler rejects on the enum
    // check (malformed) before it would even fail signature verification.
    const r = await handlePushRelay(deps(storage), {
      request: { ...req, category: "rm -rf /" },
      signature: sig,
    });
    expect(r.status).toBe(400);
  });

  it("rejects a stale request", async () => {
    const { storage, box } = await setup();
    const r = await handlePushRelay(
      deps(storage),
      signed(box, { issuedAt: NOW - 10 * 60_000 }),
    );
    expect(r.status).toBe(403);
  });

  it("rejects oversize payload", async () => {
    const { storage, box } = await setup();
    const r = await handlePushRelay(
      deps(storage),
      signed(box, { sealedPayloadHex: "a".repeat(10_000) }),
    );
    expect(r.status).toBe(400);
  });

  it("403 when a revoked box signs", async () => {
    const { storage, box } = await setup();
    await storage.servers.revoke("home1.alice.flagship.services", "test", NOW);
    const r = await handlePushRelay(deps(storage), signed(box));
    expect(r.status).toBe(403);
  });

  it("403 when no servers storage is wired", async () => {
    const { storage, box } = await setup();
    const r = await handlePushRelay(
      { pushTokens: storage.pushTokens, usernames: storage.usernames, now: () => NOW },
      signed(box),
    );
    expect(r.status).toBe(403);
  });
});

describe("/api/push/<token-id> revoke (IRK-signed)", () => {
  const NOW = 1_700_000_000_000;

  async function seedToken(
    pushTokens: InMemoryPushTokenStorage,
    tokenId: string,
    username: string,
  ) {
    await pushTokens.put({
      tokenId,
      username,
      platform: "apns",
      providerToken: "x",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "",
      registeredAt: 0,
      lastSeenAt: 0,
    });
  }

  it("rejects an unauthenticated DELETE (no envelope) and keeps the token", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    await seedToken(pushTokens, "tok1", "alice");

    const r = await handlePushRevoke({ pushTokens, usernames }, "tok1", undefined);
    expect(r.status).toBe(403);
    // The vulnerability: this MUST NOT have deleted the row.
    expect(await pushTokens.get("tok1")).toBeDefined();
  });

  it("a valid owner-signed envelope revokes the token", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    await seedToken(pushTokens, "tok1", "alice");

    const claim = { tokenId: "tok1", issuedAt: NOW };
    const sig = signPushTokenRevoke(claim, irk);
    const r = await handlePushRevoke(
      { pushTokens, usernames, now: () => NOW },
      "tok1",
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200);
    expect(await pushTokens.get("tok1")).toBeUndefined();
  });

  it("rejects a signature from a DIFFERENT user's IRK", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const alice = makeIrk(); await seed(usernames, "alice", alice);
    const mallory = makeIrk(); await seed(usernames, "mallory", mallory);
    await seedToken(pushTokens, "tok1", "alice");

    // Mallory signs a revoke for Alice's token with HER own IRK.
    const claim = { tokenId: "tok1", issuedAt: NOW };
    const sig = signPushTokenRevoke(claim, mallory);
    const r = await handlePushRevoke(
      { pushTokens, usernames, now: () => NOW },
      "tok1",
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
    expect(await pushTokens.get("tok1")).toBeDefined();
  });

  it("rejects a stale issuedAt", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    await seedToken(pushTokens, "tok1", "alice");

    const stale = { tokenId: "tok1", issuedAt: NOW - 10 * 60_000 };
    const sig = signPushTokenRevoke(stale, irk);
    const r = await handlePushRevoke(
      { pushTokens, usernames, now: () => NOW },
      "tok1",
      { request: stale, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
    expect(await pushTokens.get("tok1")).toBeDefined();
  });

  it("rejects a signature aimed at a DIFFERENT token (path mismatch)", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);
    await seedToken(pushTokens, "tok1", "alice");
    await seedToken(pushTokens, "tok2", "alice");

    // A captured valid envelope for tok2 replayed against the tok1 URL.
    const claim = { tokenId: "tok2", issuedAt: NOW };
    const sig = signPushTokenRevoke(claim, irk);
    const r = await handlePushRevoke(
      { pushTokens, usernames, now: () => NOW },
      "tok1",
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(403);
    expect(await pushTokens.get("tok1")).toBeDefined();
  });

  it("admin override removes any token without a signature", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    await seedToken(pushTokens, "tok1", "alice");

    const r = await handlePushRevoke(
      { pushTokens, usernames },
      "tok1",
      undefined,
      { isAdmin: true },
    );
    expect(r.status).toBe(200);
    expect(await pushTokens.get("tok1")).toBeUndefined();
  });

  it("an unknown token with a well-formed envelope is an idempotent no-op", async () => {
    const usernames = new InMemoryUsernameStorage();
    const pushTokens = new InMemoryPushTokenStorage();
    const irk = makeIrk(); await seed(usernames, "alice", irk);

    const claim = { tokenId: "ghost", issuedAt: NOW };
    const sig = signPushTokenRevoke(claim, irk);
    const r = await handlePushRevoke(
      { pushTokens, usernames, now: () => NOW },
      "ghost",
      { request: claim, signature: bytesToHex(sig) },
    );
    expect(r.status).toBe(200);
  });
});
