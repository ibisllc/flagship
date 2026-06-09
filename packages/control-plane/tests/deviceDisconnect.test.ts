/**
 * POST /api/users/:u/devices/:id/disconnect tests.
 *
 * Covers the real ed25519 IRK-proof gate (task #39 — closing the
 * earlier fail-open hole), the quarantine gate, the audit-event
 * emission, and the happy-path remove. Every request body is signed
 * with the account's CURRENT IRK; the negative tests exercise a
 * rotated-out IRK, garbage hex, and an empty signature.
 */

import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { deriveIRK, signDeviceDisconnect } from "@flagship/protocol";
import { handleDeviceDisconnect } from "../src/deviceDisconnect.js";
import { bytesToHex } from "../src/hex.js";
import { RE_PAIR_QUARANTINE_MS } from "../src/rePair.js";

const USERNAME = "alice";

// The account's current IRK. Every legitimate request is signed with this.
const ACCOUNT_IRK = deriveIRK({ seed: new Uint8Array(32).fill(0x11) });
// A rotated-out / foreign key that no longer matches userRec.irkPubHex.
const OTHER_IRK = deriveIRK({ seed: new Uint8Array(32).fill(0x22) });

async function setup(): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: bytesToHex(ACCOUNT_IRK.publicKey),
    claimedAt: 1,
  });
  return s;
}

async function seedDevice(
  s: InMemoryStorage,
  args: { tokenId: string; label?: string; quarantineUntil?: number },
): Promise<void> {
  await s.pushTokens.put({
    tokenId: args.tokenId,
    username: USERNAME,
    platform: "apns",
    providerToken: "p",
    pushX25519PubHex: "01".repeat(32),
    registrationSignatureHex: "00".repeat(64),
    label: args.label ?? "device",
    registeredAt: 1,
    lastSeenAt: 1,
    quarantineUntil: args.quarantineUntil ?? 0,
  });
}

function disconnectBody(args: {
  targetTokenId: string;
  callerTokenId: string;
  issuedAt?: number;
  /** Override the signature hex (negative tests). */
  signature?: string;
  /** Sign with a non-account key to simulate a rotated-out device. */
  signWith?: typeof ACCOUNT_IRK;
  /** Username embedded in the signed envelope (defaults to USERNAME). */
  username?: string;
}) {
  const request = {
    username: args.username ?? USERNAME,
    targetTokenId: args.targetTokenId,
    callerTokenId: args.callerTokenId,
    issuedAt: args.issuedAt ?? Date.now(),
  };
  const signature =
    args.signature ??
    bytesToHex(signDeviceDisconnect(request, args.signWith ?? ACCOUNT_IRK));
  return { request, signature };
}

describe("handleDeviceDisconnect — quarantine + happy path", () => {
  it("removes the target push_token row + appends an audit event", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller", label: "Trusted iPhone" });
    await seedDevice(s, { tokenId: "target", label: "Old iPad" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(200);
    expect(await s.pushTokens.get("target")).toBeUndefined();
    const audit = await s.auditEvents.list(USERNAME, 0, 10);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.eventKind).toBe("device-disconnected");
    expect(audit[0]?.devicePrefix).toBe("target".slice(0, 8));
    expect(audit[0]?.detail).toMatch(/Old iPad/);
  });

  it("rejects the caller with 403 when the caller is quarantined", async () => {
    const s = await setup();
    const future = Date.now() + RE_PAIR_QUARANTINE_MS;
    await seedDevice(s, { tokenId: "caller", quarantineUntil: future });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { reason: string }).reason).toBe("quarantine");
    expect((res.body as { until: string }).until).toBe(new Date(future).toISOString());
    // Target row preserved (caller blocked from removing it).
    expect(await s.pushTokens.get("target")).not.toBeUndefined();
    // v1.2 Plan B Phase 5 — the blocked attempt is captured in the
    // audit log with a quarantine-blocked-revoke row so the
    // legitimate owner can spot a suspicious attempt later.
    const events = await s.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("quarantine-blocked-revoke");
    expect(events[0]?.quarantineUntil).toBe(future);
  });

  it("404s on an unknown targetTokenId (idempotent on a stale UI)", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "ghost",
      disconnectBody({ targetTokenId: "ghost", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(404);
  });

  it("403s on cross-tenant disconnect (target belongs to a different username)", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    // Plant a target row that says it belongs to a different user.
    await s.pushTokens.put({
      tokenId: "intruder",
      username: "bob",
      platform: "apns",
      providerToken: "p",
      pushX25519PubHex: "01".repeat(32),
      registrationSignatureHex: "00".repeat(64),
      label: "Bob's phone",
      registeredAt: 1,
      lastSeenAt: 1,
      quarantineUntil: 0,
    });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "intruder",
      disconnectBody({ targetTokenId: "intruder", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(403);
    expect(await s.pushTokens.get("intruder")).not.toBeUndefined();
  });

  it("400s on malformed body", async () => {
    const s = await setup();
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      // missing callerTokenId
      { request: { username: USERNAME, targetTokenId: "target", issuedAt: Date.now() }, signature: "aa" },
    );
    expect(res.status).toBe(400);
  });

  it("400s when url targetTokenId does not match body targetTokenId", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "other",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(400);
  });

  it("403s on stale request (issuedAt too far from now)", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({
        targetTokenId: "target",
        callerTokenId: "caller",
        issuedAt: Date.now() - 60 * 60_000,
      }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/stale/);
  });

  it("403s on an empty signature", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller", signature: "" }),
    );
    expect(res.status).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────
  // task #39 — real IRK-proof enforcement (the fail-open fix)
  // ──────────────────────────────────────────────────────────────

  it("accepts a valid signature made with the account's CURRENT IRK", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller", label: "Trusted iPhone" });
    await seedDevice(s, { tokenId: "target", label: "Old iPad" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(200);
    expect(await s.pushTokens.get("target")).toBeUndefined();
  });

  it("rejects a signature made with a rotated-out / foreign IRK", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({
        targetTokenId: "target",
        callerTokenId: "caller",
        signWith: OTHER_IRK,
      }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/signature/);
    // Target preserved — the bogus signer could NOT silence push.
    expect(await s.pushTokens.get("target")).not.toBeUndefined();
  });

  it("rejects a garbage (non-hex) signature", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({
        targetTokenId: "target",
        callerTokenId: "caller",
        signature: "zz-not-hex",
      }),
    );
    expect(res.status).toBe(403);
    expect(await s.pushTokens.get("target")).not.toBeUndefined();
  });

  it("rejects a well-formed signature whose targetTokenId was tampered after signing", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    await seedDevice(s, { tokenId: "victim" });
    // Sign for `target`, then point both the URL + body at `victim`.
    const signedForTarget = disconnectBody({
      targetTokenId: "target",
      callerTokenId: "caller",
    });
    const tampered = {
      request: { ...signedForTarget.request, targetTokenId: "victim" },
      signature: signedForTarget.signature,
    };
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "victim",
      tampered,
    );
    expect(res.status).toBe(403);
    expect(await s.pushTokens.get("victim")).not.toBeUndefined();
  });

  it("still enforces quarantine even with a valid current-IRK signature", async () => {
    const s = await setup();
    const future = Date.now() + RE_PAIR_QUARANTINE_MS;
    await seedDevice(s, { tokenId: "caller", quarantineUntil: future });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { reason: string }).reason).toBe("quarantine");
    expect(await s.pushTokens.get("target")).not.toBeUndefined();
  });

  it("403s on username / url mismatch", async () => {
    const s = await setup();
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      "carol",
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────
  // v1.2 Plan B Phase 5 — quarantine-blocked-revoke push fan-out
  // ──────────────────────────────────────────────────────────────

  it("Phase 5: fires push to all the user's OTHER devices when a quarantined caller is blocked", async () => {
    const s = await setup();
    const future = Date.now() + RE_PAIR_QUARANTINE_MS;
    await seedDevice(s, { tokenId: "caller", quarantineUntil: future });
    await seedDevice(s, { tokenId: "target" });
    await seedDevice(s, { tokenId: "trustedOld" });
    const fires: Array<{
      username: string;
      tokenIds: string[];
      category: string;
    }> = [];
    const res = await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
        pushFanout: async ({ username, targets, payload }) => {
          fires.push({
            username,
            tokenIds: targets.map((t) => t.tokenId),
            category: payload.category,
          });
        },
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    expect(res.status).toBe(403);
    expect(fires).toHaveLength(1);
    // Fan-out targets every device EXCEPT the quarantined caller.
    expect(new Set(fires[0]!.tokenIds)).toEqual(new Set(["target", "trustedOld"]));
    expect(fires[0]!.category).toBe("quarantine-blocked-revoke");
    expect(fires[0]!.username).toBe(USERNAME);
  });

  it("Phase 5: quarantine-blocked-revoke audit row carries `quarantineUntil` + `accountTypeAtEvent`", async () => {
    const s = await setup();
    const future = Date.now() + RE_PAIR_QUARANTINE_MS;
    await s.usernames.put({
      username: USERNAME,
      irkPubHex: bytesToHex(ACCOUNT_IRK.publicKey),
      claimedAt: 1,
      accountType: "multi",
    });
    await seedDevice(s, { tokenId: "caller", quarantineUntil: future });
    await seedDevice(s, { tokenId: "target" });
    await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    const events = await s.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("quarantine-blocked-revoke");
    expect(events[0]?.quarantineUntil).toBe(future);
    expect(events[0]?.accountTypeAtEvent).toBe("multi");
  });

  it("Phase 5: device-disconnected happy-path audit row carries accountTypeAtEvent", async () => {
    const s = await setup();
    await s.usernames.put({
      username: USERNAME,
      irkPubHex: bytesToHex(ACCOUNT_IRK.publicKey),
      claimedAt: 1,
      accountType: "multi",
    });
    await seedDevice(s, { tokenId: "caller" });
    await seedDevice(s, { tokenId: "target" });
    await handleDeviceDisconnect(
      {
        pushTokens: s.pushTokens,
        usernames: s.usernames,
        auditEvents: s.auditEvents,
      },
      USERNAME,
      "target",
      disconnectBody({ targetTokenId: "target", callerTokenId: "caller" }),
    );
    const events = await s.auditEvents.list(USERNAME, 0, 10);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe("device-disconnected");
    expect(events[0]?.accountTypeAtEvent).toBe("multi");
  });
});
