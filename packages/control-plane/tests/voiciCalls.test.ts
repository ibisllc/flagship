import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryVoiciCallStorage, InMemoryVoiciStorage } from "@flagship/storage";
import { b64Decode, checkVoiciCallReceipt, hexToBytes, openVoiciMissedCall, signVoiciCallEndCallerP256, signVoiciCallEndOwner, signVoiciCallRequestP256, VOICI_CALL_MAX_MS, VOICI_CALL_RING_MS } from "@flagship/protocol";
import { handleVoiciCallAllow, handleVoiciCallRequest, recordVoiciMissedCall, VoiciCallRoomCore, type VoiciCallRequestDeps, type VoiciCallRoomAction, type VoiciCallRoomInit } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VP: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici/vectors.json"), "utf8"));
const NOW: number = V.now;
const K = V.keys;

async function world(o: { index?: unknown; replied?: boolean } = {}) {
  const voici = new InMemoryVoiciStorage();
  const calls = new InMemoryVoiciCallStorage();
  const index = o.index ?? V.pageV2.signed;
  await voici.publishPage(
    { username: "alice", pageId: K.pageId, seq: 8, issuedAt: NOW, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: K.ownerSignPub, indexJson: JSON.stringify(index), publishedAt: NOW },
    0,
  );
  const rooms: VoiciCallRoomInit[] = [];
  const rings: string[] = [];
  const limits = { ip: null as number | null };
  const deps: VoiciCallRequestDeps = {
    voici,
    calls,
    origin: V.constants.origin,
    caKeys: () => [K.caPub],
    isPseudonymBanned: async () => false,
    limitIp: async () => limits.ip,
    limitCaller: async () => null,
    limitPage: async () => null,
    openRoom: async (init) => (rooms.some((r) => r.callId === init.callId) ? false : (rooms.push(init), true)),
    ring: async (_u, c) => (rings.push(c.callId), 1),
    apex: "flagshipserver.com",
    random: (n) => new Uint8Array(n).fill(7),
    sha256Hex: async (b) => Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex"),
    now: () => NOW,
  };
  if (o.replied) await calls.setCallAllow({ pageId: K.pageId, conv: K.conv, op: "allow", issuedAt: NOW, signature: "00" }, NOW);
  return { voici, calls, deps, rooms, rings, limits };
}

const body = (request: unknown = V.request.signed) => JSON.stringify({ request });
const code = (r: { status: number; body: unknown }) => (r.body as { code?: string }).code ?? "ok";

describe("POST /api/voici/calls", () => {
  it("opens a room and rings when the conversation may call", async () => {
    const w = await world({ replied: true });
    const r = await handleVoiciCallRequest(w.deps, body());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ callId: V.request.signed.callId, room: `wss://flagshipserver.com/api/voici/calls/${V.request.signed.callId}/caller`, ringMs: VOICI_CALL_RING_MS });
    expect(w.rooms[0]).toMatchObject({ username: "alice", callerPub: K.browserPub, inboxPub: V.pageV2.signed.inboxPub });
    expect(w.rings).toEqual([V.request.signed.callId]);
  });

  it("refuses a v1 page (calls off), a stranger under 'accepted', a blocked caller, limits and a second live call", async () => {
    expect(code(await handleVoiciCallRequest((await world({ index: VP.index.signed })).deps, body()))).toBe("calls-off");
    expect(code(await handleVoiciCallRequest((await world()).deps, body()))).toBe("not-allowed");
    const blocked = await world({ replied: true });
    await blocked.voici.setBlock({ pageId: K.pageId, pseudonymPub: K.pseudonymPub, op: "block", issuedAt: NOW, signature: "00" }, NOW);
    expect(code(await handleVoiciCallRequest(blocked.deps, body()))).toBe("calls-off");
    const limited = await world({ replied: true });
    limited.limits.ip = 60;
    const lr = await handleVoiciCallRequest(limited.deps, body());
    expect([lr.status, code(lr), (lr.body as { retryAfterSec?: number }).retryAfterSec]).toEqual([429, "rate-limited", 60]);
    const busy = await world({ replied: true });
    expect((await handleVoiciCallRequest(busy.deps, body())).status).toBe(200);
    const second = signVoiciCallRequestP256({ ...V.request.body, callId: "b2".repeat(16) }, hexToBytes(K.browserPriv));
    expect(code(await handleVoiciCallRequest(busy.deps, body(second)))).toBe("busy");
    expect(busy.calls.missed.map((m) => m.callId)).toEqual(["b2".repeat(16)]);
    expect(code(await handleVoiciCallRequest((await world({ replied: true })).deps, body({ ...V.request.signed, offerSdp: V.sdp.answer })))).toBe("bad-signature");
  });

  it("a reply or an accept lets the conversation call under 'accepted'", async () => {
    const w = await world();
    await w.voici.setBlock({ pageId: K.pageId, pseudonymPub: K.pseudonymPub, op: "unblock", issuedAt: NOW, signature: "00" }, NOW);
    expect((await handleVoiciCallRequest(w.deps, body())).status).toBe(200);
  });

  it("the owner's call-allow order is checked and stored", async () => {
    const w = await world();
    const deps = { voici: w.voici, calls: w.calls, now: () => V.allow.order.issuedAt };
    expect((await handleVoiciCallAllow(deps, "alice", { allow: V.allow.order, signature: V.allow.signature })).status).toBe(200);
    expect(code(await handleVoiciCallAllow(deps, "alice", { allow: { ...V.allow.order, op: "disallow" }, signature: V.allow.signature }))).toBe("bad-signature");
    expect((await w.calls.getCallAllow(K.pageId, K.conv))?.op).toBe("allow");
  });
});

describe("the call room", () => {
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
  };
  const ca = { seed: hexToBytes(K.caSeed) };
  const other = "aa".repeat(32);
  const sends = (a: VoiciCallRoomAction[]) => a.filter((x) => x.kind === "send").map((x) => (x.kind === "send" ? [x.to, x.msg.t] : null));

  it("first answer wins; the winner gets a CA receipt, the others stop, the caller gets the signed answer", () => {
    const { state, actions } = VoiciCallRoomCore.start(init);
    expect(actions).toEqual([{ kind: "alarm", at: init.ringingAt + VOICI_CALL_RING_MS }]);
    const room = new VoiciCallRoomCore(state, ca);
    expect(sends(room.joined({ role: "device", deviceRef: K.deviceRef }))).toEqual([[{ deviceRef: K.deviceRef }, "request"]]);
    expect(room.message({ role: "device", deviceRef: other }, { t: "answer", answer: V.answer.signed }, NOW)).toEqual([
      { kind: "send", to: { deviceRef: other }, msg: { t: "error", code: "wrong-device" } },
    ]);
    const won = room.message({ role: "device", deviceRef: K.deviceRef }, { t: "answer", answer: V.answer.signed }, NOW);
    expect(sends(won)).toEqual([
      [{ deviceRef: K.deviceRef }, "won"],
      [{ notDeviceRef: K.deviceRef }, "answered-elsewhere"],
      ["caller", "answer"],
    ]);
    const receipt = (won[0] as { msg: { receipt: unknown } }).msg.receipt;
    expect(checkVoiciCallReceipt(receipt, { caKeys: [K.caPub], now: NOW, account: "alice", deviceRef: K.deviceRef }).ok).toBe(true);
    expect(won).toContainEqual({ kind: "alarm", at: NOW + VOICI_CALL_MAX_MS });
    expect(sends(room.message({ role: "device", deviceRef: other }, { t: "answer", answer: V.answer.signed }, NOW))).toEqual([[{ deviceRef: other }, "answered-elsewhere"]]);
    expect(sends(room.joined({ role: "device", deviceRef: other }))).toEqual([[{ deviceRef: other }, "answered-elsewhere"]]);
    expect(sends(room.message({ role: "caller" }, { t: "ice", candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host" }, NOW))).toEqual([[{ deviceRef: K.deviceRef }, "ice"]]);
    expect(room.message({ role: "device", deviceRef: other }, { t: "ice", candidate: "x" }, NOW)).toEqual([]);
    expect(room.callerLeft(NOW)).toEqual([]);
    const end = signVoiciCallEndOwner({ callId: init.callId, reason: "hangup", issuedAt: NOW }, hexToBytes(K.ownerSignSeed));
    expect(room.message({ role: "device", deviceRef: other }, { t: "end", end }, NOW)).toEqual([]);
    const ended = room.message({ role: "device", deviceRef: K.deviceRef }, { t: "end", end }, NOW);
    expect(ended.map((a) => a.kind)).toEqual(["send", "send", "release", "close-all"]);
    expect(room.state.phase).toBe("ended");
  });

  it("the 60-minute limit ends an answered call", () => {
    const room = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    room.message({ role: "device", deviceRef: K.deviceRef }, { t: "answer", answer: V.answer.signed }, NOW);
    expect(room.alarm(NOW + 1000)).toEqual([{ kind: "alarm", at: NOW + VOICI_CALL_MAX_MS }]);
    const end = room.alarm(NOW + VOICI_CALL_MAX_MS);
    expect(end[0]).toEqual({ kind: "send", to: "caller", msg: { t: "ended", reason: "limit" } });
    expect(end.some((a) => a.kind === "missed")).toBe(false);
  });

  it("no answer, a caller's cancel and a decline leave a missed call that opens with the inbox key", async () => {
    const a = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    expect(a.alarm(init.ringingAt + VOICI_CALL_RING_MS)).toContainEqual({ kind: "missed", reason: "no-answer", endedAt: init.ringingAt + VOICI_CALL_RING_MS });
    const b = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    const cancel = signVoiciCallEndCallerP256({ callId: init.callId, reason: "cancel", issuedAt: NOW }, hexToBytes(K.browserPriv));
    expect(b.message({ role: "device", deviceRef: K.deviceRef }, { t: "end", end: cancel }, NOW)).toEqual([]);
    expect(b.message({ role: "caller" }, { t: "end", end: cancel }, NOW)).toContainEqual({ kind: "missed", reason: "cancel", endedAt: NOW });
    const c = new VoiciCallRoomCore(VoiciCallRoomCore.start(init).state, ca);
    expect(c.message({ role: "device", deviceRef: other }, { t: "decline" }, NOW)).toContainEqual({ kind: "missed", reason: "decline", endedAt: NOW });

    const calls = new InMemoryVoiciCallStorage();
    expect(await recordVoiciMissedCall(calls, { pageId: K.pageId, inboxPub: init.inboxPub, request: init.request, ringingAt: init.ringingAt, endedAt: NOW, reason: "no-answer" })).toBe(true);
    const opened = openVoiciMissedCall(hexToBytes(K.inboxSeed), init.callId, b64Decode(calls.missed[0]!.sealed)!, { pageId: K.pageId, origin: V.constants.origin, caKeys: [K.caPub] });
    expect(opened?.reason).toBe("no-answer");
  });
});
