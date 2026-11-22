/**
 * voi.ci call budgets (docs/voici-calls.md §6, owner-approved 2026-11-21): a request spends the caller, page and
 * anonymous budgets only after it verified, answering the owner's ring-back is free, and an answered call talked
 * through for 15 s gives its ring back (the room's `refund` action).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryVoiciCallStorage, InMemoryVoiciStorage } from "@flagship/storage";
import { hexToBytes, signVoiciCallEndOwner } from "@flagship/protocol";
import { handleVoiciCallRequest, VOICI_CALL_REFUND_MIN_MS, VoiciCallRoomCore, type VoiciCallRequestDeps, type VoiciCallRoomInit } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CM: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-call-modes/vectors.json"), "utf8"));
const K = V.keys;
const code = (r: { status: number; body: unknown }) => (r.body as { code?: string }).code ?? "ok";
const body = (request: unknown) => JSON.stringify({ request });

async function world(now: number, o: { callsFrom?: string; replied?: boolean } = {}) {
  const voici = new InMemoryVoiciStorage();
  const calls = new InMemoryVoiciCallStorage();
  const index = o.callsFrom ? { ...V.pageV2.signed, callsFrom: o.callsFrom } : V.pageV2.signed;
  await voici.publishPage({ username: "alice", pageId: K.pageId, seq: 8, issuedAt: now, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: K.ownerSignPub, indexJson: JSON.stringify(index), publishedAt: now }, 0);
  if (o.replied) await calls.setCallAllow({ pageId: K.pageId, conv: K.conv, op: "allow", issuedAt: now, signature: "00" }, now);
  const spent: string[] = [];
  const rooms: VoiciCallRoomInit[] = [];
  const deps: VoiciCallRequestDeps = {
    voici,
    calls,
    origin: V.constants.origin,
    caKeys: () => [K.caPub],
    isPseudonymBanned: async () => false,
    limitIp: async () => (spent.push("ip"), null),
    limitCaller: async (p) => (spent.push(`caller:${p}`), null),
    limitPage: async (p) => (spent.push(`page:${p}`), null),
    limitAnonPage: async (p) => (spent.push(`anon:${p}`), null),
    powSecret: hexToBytes(CM.pow.secret),
    openRoom: async (init) => (rooms.push(init), true),
    ring: async () => 1,
    apex: "flagshipserver.com",
    random: (n) => new Uint8Array(n).fill(7),
    sha256Hex: async (b) => Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex"),
    now: () => now,
  };
  return { voici, calls, deps, spent, rooms };
}

describe("charging after verification", () => {
  it("a forged request spends only the per-address budget, never the caller's or the page's", async () => {
    const w = await world(V.now, { replied: true });
    const forged = { ...V.request.signed, offerSdp: V.sdp.answer };
    expect(code(await handleVoiciCallRequest(w.deps, body(forged)))).toBe("bad-signature");
    expect(w.spent).toEqual(["ip"]);
    expect(await w.calls.countRing(K.pageId, new Date(V.now).toISOString().slice(0, 10), 1)).toBe(true);
  });

  it("a blocked caller is refused before any budget", async () => {
    const w = await world(V.now, { replied: true });
    await w.voici.setBlock({ pageId: K.pageId, pseudonymPub: K.pseudonymPub, op: "block", issuedAt: V.now, signature: "00" }, V.now);
    expect(code(await handleVoiciCallRequest(w.deps, body(V.request.signed)))).toBe("calls-off");
    expect(w.spent).toEqual([]);
  });

  it("a caller the page does not take spends its own budget, not the page's", async () => {
    const w = await world(V.now);
    expect(code(await handleVoiciCallRequest(w.deps, body(V.request.signed)))).toBe("not-allowed");
    expect(w.spent).toEqual(["ip", `caller:${K.pseudonymPub}`]);
  });

  it("a verified call spends every budget and the room records what it spent", async () => {
    const w = await world(V.now, { replied: true });
    expect((await handleVoiciCallRequest(w.deps, body(V.request.signed))).status).toBe(200);
    expect(w.spent).toEqual(["ip", `caller:${K.pseudonymPub}`, `page:${K.pageId}`]);
    expect(w.rooms[0]!.charged).toEqual({ at: V.now, caller: K.pseudonymPub, page: K.pageId });
  });

  it("an anonymous request spends the page's anonymous budget only after its work verified and was spent", async () => {
    const w = await world(CM.now, { callsFrom: "anyone" });
    expect(code(await handleVoiciCallRequest(w.deps, body({ ...CM.anon.signed, pow: { ...CM.anon.signed.pow, nonce: "0" } })))).not.toBe("ok");
    expect(w.spent).toEqual(["ip"]);
    expect((await handleVoiciCallRequest(w.deps, body(CM.anon.signed))).status).toBe(200);
    expect(w.spent).toEqual(["ip", "ip", `anon:${K.pageId}`]);
    expect(w.rooms[0]!.charged).toEqual({ at: CM.now, anonPage: K.pageId });
    await w.calls.releaseLiveCall("alice", CM.anon.signed.callId);
    expect(code(await handleVoiciCallRequest(w.deps, body(CM.anon.signed)))).toBe("bad-pow");
    expect(w.spent.filter((s) => s.startsWith("anon:"))).toHaveLength(1);
  });
});

describe("answering the owner's ring-back", () => {
  it("is free: no caller, page or daily budget, and nothing to refund", async () => {
    const w = await world(V.now, { replied: true });
    await w.calls.putRing({ pageId: K.pageId, conv: K.conv, ringId: "ab".repeat(16), hint: "x", media: "audio", issuedAt: V.now, expiresAt: V.now + 45_000 });
    expect(await w.calls.countRing(K.pageId, new Date(V.now).toISOString().slice(0, 10), 0)).toBe(false);
    expect((await handleVoiciCallRequest(w.deps, body(V.request.signed))).status).toBe(200);
    expect(w.spent).toEqual(["ip"]);
    expect(w.rooms[0]!.charged).toBeUndefined();
  });

  it("an expired ring is an ordinary call again", async () => {
    const w = await world(V.now, { replied: true });
    await w.calls.putRing({ pageId: K.pageId, conv: K.conv, ringId: "ab".repeat(16), hint: "x", media: "audio", issuedAt: V.now - 60_000, expiresAt: V.now - 1 });
    expect((await handleVoiciCallRequest(w.deps, body(V.request.signed))).status).toBe(200);
    expect(w.spent).toEqual(["ip", `caller:${K.pseudonymPub}`, `page:${K.pageId}`]);
  });
});

describe("the room gives an answered call's ring back", () => {
  const charged = { at: V.t0 + 1_000, caller: K.pseudonymPub, page: K.pageId };
  const init: VoiciCallRoomInit = {
    callId: V.request.signed.callId,
    username: "alice",
    pageId: K.pageId,
    ownerSignPub: K.ownerSignPub,
    inboxPub: V.pageV2.signed.inboxPub,
    request: V.request.signed,
    callerPub: K.browserPub,
    callerTokenHash: "00".repeat(32),
    ringingAt: V.t0 + 1_000,
    charged,
  };
  const ca = { seed: hexToBytes(K.caSeed) };
  const NOW: number = V.now;
  const answered = (i: VoiciCallRoomInit = init) => {
    const room = new VoiciCallRoomCore(VoiciCallRoomCore.start(i).state, ca);
    room.message({ role: "device", deviceRef: K.deviceRef }, { t: "answer", answer: V.answer.signed }, NOW);
    return room;
  };
  const refunds = (a: { kind: string }[]) => a.filter((x) => x.kind === "refund");

  it("a hang-up 15 s after the answer refunds; 14 s does not", () => {
    expect(refunds(answered().deviceLeft(K.deviceRef, NOW + VOICI_CALL_REFUND_MIN_MS))).toEqual([{ kind: "refund", charged }]);
    expect(refunds(answered().deviceLeft(K.deviceRef, NOW + 14_000))).toEqual([]);
  });

  it("a signed hang-up and the 60-minute limit refund; a failed call does not", () => {
    const later = NOW + 20_000;
    const hangup = signVoiciCallEndOwner({ callId: init.callId, reason: "hangup", issuedAt: later }, hexToBytes(K.ownerSignSeed));
    expect(refunds(answered().message({ role: "device", deviceRef: K.deviceRef }, { t: "end", end: hangup }, later))).toHaveLength(1);
    const failed = signVoiciCallEndOwner({ callId: init.callId, reason: "failed", issuedAt: later }, hexToBytes(K.ownerSignSeed));
    expect(refunds(answered().message({ role: "device", deviceRef: K.deviceRef }, { t: "end", end: failed }, later))).toEqual([]);
    const limit = answered();
    expect(refunds(limit.alarm(NOW + 60 * 60_000))).toHaveLength(1);
  });

  it("an unanswered call, a decline or a cancel never refunds; nor does a call that spent nothing", () => {
    const ringing = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    expect(refunds(ringing.alarm(init.ringingAt + 45_000))).toEqual([]);
    const declined = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    expect(refunds(declined.message({ role: "device", deviceRef: K.deviceRef }, { t: "decline" }, NOW))).toEqual([]);
    const { charged: _c, ...free } = init;
    expect(refunds(answered(free).deviceLeft(K.deviceRef, NOW + 60_000))).toEqual([]);
  });

  it("a second end refunds nothing", () => {
    const room = answered();
    expect(refunds(room.deviceLeft(K.deviceRef, NOW + 30_000))).toHaveLength(1);
    expect(room.deviceLeft(K.deviceRef, NOW + 31_000)).toEqual([]);
    expect(room.alarm(NOW + 60 * 60_000)).toEqual([]);
  });
});
