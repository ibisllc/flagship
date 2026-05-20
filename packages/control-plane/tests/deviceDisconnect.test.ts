/**
 * v1.2 Plan B Phase 2 — POST /api/users/:u/devices/:id/disconnect tests.
 *
 * Covers the quarantine gate, the audit-event emission, and the
 * happy-path remove. Phase 5 will replace the structural signature
 * check with a real ed25519 verifyDeviceDisconnect; until then,
 * the tests only assert that a non-empty signature is accepted and
 * an empty one rejected.
 */

import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@flagship/storage";
import { handleDeviceDisconnect } from "../src/deviceDisconnect.js";
import { RE_PAIR_QUARANTINE_MS } from "../src/rePair.js";

const USERNAME = "alice";

async function setup(): Promise<InMemoryStorage> {
  const s = new InMemoryStorage();
  await s.usernames.put({
    username: USERNAME,
    irkPubHex: "aa".repeat(32),
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
  signature?: string;
}) {
  return {
    request: {
      username: USERNAME,
      targetTokenId: args.targetTokenId,
      callerTokenId: args.callerTokenId,
      issuedAt: args.issuedAt ?? Date.now(),
    },
    signature: args.signature ?? "aa",
  };
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
    // Target row preserved + no audit event.
    expect(await s.pushTokens.get("target")).not.toBeUndefined();
    expect(await s.auditEvents.list(USERNAME, 0, 10)).toHaveLength(0);
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

  it("403s on an empty signature (Phase 2 structural gate)", async () => {
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
});
