/**
 * Who may call a page, and ringing a caller back (docs/voici-calls.md, owner-approved 2026-11-15): anonymous calls
 * with a proof of work on "anyone" pages, the ring-back channel a "callback" page requires, the owner's ring and its
 * content-free push to the caller's own account.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryStorage, InMemoryVoiciCallStorage, InMemoryVoiciStorage } from "@flagship/storage";
import * as P from "@flagship/protocol";
import { canonicalVoiciThreadFetch, hexToBytes, signVoiciAnonBlock, signVoiciBlock, signVoiciRing, signVoiciRingBackPseudonym } from "@flagship/protocol";
import { p256 } from "@noble/curves/nist.js";
import { handleVoiciAnonBlock, handleVoiciBlock, handleVoiciCallSettingsGet, handleVoiciCallSettingsPut, handleVoiciConvDelete, handleVoiciInbox, handleVoiciCallChallenge, handleVoiciCallRequest, handleVoiciRing, handleVoiciRingBack, handleVoiciThread, type VoiciCallRequestDeps, type VoiciCallRoomInit } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-calls/vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CM: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-call-modes/vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/messages/vectors.json"), "utf8"));
const NOW: number = CM.now;
const K = V.keys;
const powSecret = hexToBytes(CM.pow.secret);
const code = (r: { status: number; body: unknown }) => (r.body as { code?: string }).code ?? "ok";

async function world(callsFrom: string) {
  const voici = new InMemoryVoiciStorage();
  const calls = new InMemoryVoiciCallStorage();
  const index = { ...V.pageV2.signed, callsFrom };
  await voici.publishPage({ username: "alice", pageId: K.pageId, seq: 8, issuedAt: NOW, acceptsMessages: 1, inboxEpoch: 1, ownerSignPub: K.ownerSignPub, indexJson: JSON.stringify(index), publishedAt: NOW }, 0);
  const rooms: VoiciCallRoomInit[] = [];
  const deps: VoiciCallRequestDeps = {
    voici,
    calls,
    origin: V.constants.origin,
    caKeys: () => [K.caPub],
    isPseudonymBanned: async () => false,
    limitIp: async () => null,
    limitCaller: async () => null,
    limitPage: async () => null,
    limitAnonPage: async () => null,
    powSecret,
    openRoom: async (init) => (rooms.push(init), true),
    ring: async () => 1,
    apex: "flagshipserver.com",
    random: (n) => new Uint8Array(n).fill(7),
    sha256Hex: async (b) => Buffer.from(await crypto.subtle.digest("SHA-256", b)).toString("hex"),
    now: () => NOW,
  };
  return { voici, calls, deps, rooms };
}
const body = (request: unknown) => JSON.stringify({ request });

describe("anonymous calls (pages open to anyone)", () => {
  it("a solved, signed anonymous request rings; its room names the browser key", async () => {
    const w = await world("anyone");
    const r = await handleVoiciCallRequest(w.deps, body(CM.anon.signed));
    expect(r.status).toBe(200);
    expect(w.rooms[0]).toMatchObject({ callerPub: CM.anon.browserPub, request: { kind: "voici-call-request-anon" } });
  });

  it("a challenge is spent once; a callback page, a page without the secret and a blocked key refuse", async () => {
    const w = await world("anyone");
    expect((await handleVoiciCallRequest(w.deps, body(CM.anon.signed))).status).toBe(200);
    await w.calls.releaseLiveCall("alice", CM.anon.signed.callId);
    expect(code(await handleVoiciCallRequest(w.deps, body({ ...CM.anon.signed })))).toBe("bad-pow");
    expect(code(await handleVoiciCallRequest((await world("callback")).deps, body(CM.anon.signed)))).toBe("not-allowed");
    const noSecret = await world("anyone");
    delete noSecret.deps.powSecret;
    expect(code(await handleVoiciCallRequest(noSecret.deps, body(CM.anon.signed)))).toBe("unavailable");
    const blocked = await world("anyone");
    await blocked.calls.blockAnon(K.pageId, CM.anon.signed.conv, NOW + 1000);
    expect(code(await handleVoiciCallRequest(blocked.deps, body(CM.anon.signed)))).toBe("calls-off");
    const limited = await world("anyone");
    limited.deps.limitAnonPage = async () => 120;
    expect(code(await handleVoiciCallRequest(limited.deps, body(CM.anon.signed)))).toBe("rate-limited");
  });

  it("issues challenges only for pages open to anyone, only with a secret", async () => {
    const w = await world("anyone");
    const r = await handleVoiciCallChallenge({ voici: w.voici, powSecret, limitIp: async () => null, now: () => NOW }, "alice");
    expect(r.status).toBe(200);
    expect((r.body as { challenge: string }).challenge).toMatch(/^flagship\/voici-call-pow\/v1\|/);
    expect(code(await handleVoiciCallChallenge({ voici: (await world("callback")).voici, powSecret, limitIp: async () => null, now: () => NOW }, "alice"))).toBe("not-allowed");
    expect(code(await handleVoiciCallChallenge({ voici: w.voici, limitIp: async () => null, now: () => NOW }, "alice"))).toBe("unavailable");
  });
});

describe("ringing a caller back", () => {
  const attach = CM.ringBack.app;

  it("a callback page takes a signed-in call only once the conversation's channel is attached", async () => {
    const w = await world("callback");
    const req = V.request.signed;
    expect(code(await handleVoiciCallRequest(w.deps, body(req)))).toBe("ring-back-required");
    const rb = await handleVoiciRingBack({ voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW }, attach);
    expect(rb.status).toBe(200);
    expect((await w.calls.getRingBack(K.pageId, M.derivations.conv, NOW))!.username).toBeNull();
    expect((await handleVoiciCallRequest(w.deps, body(req))).status).toBe(200);
  });

  it("stop deletes the channel; an older order never replaces a newer one", async () => {
    const w = await world("callback");
    const d = { voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW };
    await handleVoiciRingBack(d, attach);
    const older = signVoiciRingBackPseudonym({ ...attach.order, issuedAt: NOW - 1000 }, hexToBytes(M.derivations.pseudonymSeed));
    expect(code(await handleVoiciRingBack(d, older))).toBe("stale");
    expect(code(await handleVoiciRingBack(d, CM.ringBack.stop))).toBe("ok");
    expect(await w.calls.getRingBack(K.pageId, M.derivations.conv, NOW)).toBeNull();
    expect(code(await handleVoiciRingBack(d, { ...attach, sig: "00".repeat(64) }))).toBe("bad-signature");
  });

  it("the owner's ring: a content-free push to the account the caller's app attached; the thread fetch shows it", async () => {
    const w = await world("callback");
    await handleVoiciRingBack({ voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW }, attach, "visitor");
    const pushed: { username: string; payload: Record<string, string> }[] = [];
    const pushRing = async (username: string, payload: { kind: "voici-ring"; ringId: string; hint: string }) => (pushed.push({ username, payload }), 2);
    const r = await handleVoiciRing({ voici: w.voici, calls: w.calls, pushRing, now: () => NOW }, "alice", { ring: CM.ring.order, signature: CM.ring.signature });
    expect(r.status).toBe(200);
    expect((r.body as { pushed: number }).pushed).toBe(2);
    expect(pushed.map((p) => p.username)).toEqual(["visitor"]);
    // No text: the ring id and the hint sealed to the caller's thread key.
    expect(Object.keys(pushed[0]!.payload).sort()).toEqual(["hint", "kind", "ringId"]);
    // A browser's later attach keeps the account the app named.
    const again = signVoiciRingBackPseudonym({ ...attach.order, issuedAt: NOW + 1 }, hexToBytes(M.derivations.pseudonymSeed));
    await handleVoiciRingBack({ voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW }, again);
    expect((await w.calls.getRingBack(K.pageId, M.derivations.conv, NOW))!.username).toBe("visitor");
    expect(code(await handleVoiciRing({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { ring: CM.ring.order, signature: CM.ring.checks[3].signature }))).toBe("bad-signature");
    // The caller's browser sees the ring in its thread fetch while it rings.
    const browserPriv = hexToBytes(M.keys.browserPriv);
    const fetch = { conv: M.derivations.conv, since: "", issuedAt: NOW };
    const sig = Buffer.from(p256.sign(canonicalVoiciThreadFetch(fetch), browserPriv, { lowS: true })).toString("hex");
    const t = await handleVoiciThread({ voici: w.voici, origin: V.constants.origin, caKeys: () => [K.caPub], calls: w.calls, now: () => NOW }, { ...fetch, sig, cred: M.message.envelope.cred });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    expect((t.body as { ring?: { ringId: string } }).ring?.ringId).toBe(CM.ring.order.ringId);
  });

  it("no channel, no ring", async () => {
    const w = await world("callback");
    expect(code(await handleVoiciRing({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { ring: CM.ring.order, signature: CM.ring.signature }))).toBe("no-ring-back");
  });
});

describe("the channel ends with the conversation", () => {
  it("an owner's block deletes it; a browser order may not name an account", async () => {
    const w = await world("callback");
    const d = { voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW };
    expect(code(await handleVoiciRingBack(d, CM.ringBack.browser, "visitor"))).toBe("malformed");
    await handleVoiciRingBack(d, CM.ringBack.app, "visitor");
    const block = { pageId: K.pageId, pseudonymPub: M.derivations.pseudonymPub, op: "block" as const, issuedAt: NOW };
    const r = await handleVoiciBlock({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { block, signature: signVoiciBlock(block, hexToBytes(M.derivations.ownerSignSeed)) });
    expect(r.status).toBe(200);
    expect(await w.calls.getRingBack(K.pageId, M.derivations.conv, NOW)).toBeNull();
  });
});

describe("delete = forget (docs/voici-calls.md, owner 2026-11-16)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CV: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-conversation/vectors.json"), "utf8"));
  const conv: string = M.derivations.conv;

  async function filled() {
    const w = await world("callback");
    const d = { voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW };
    await w.voici.insertMessage({ pageId: K.pageId, conv, msgId: "11".repeat(16), kind: "voici-message", fromPub: M.derivations.pseudonymPub, delegatePub: M.keys.browserPub, sentAt: NOW, envelope: "{}", size: 2, direct: false, pushed: false, storedAt: NOW });
    await w.voici.putAlert({ conv, endpointHash: "aa".repeat(32), pageId: K.pageId, subscription: "{}", delegatePub: M.keys.browserPub, createdAt: NOW, expiresAt: NOW + 1000 }, 3);
    await handleVoiciRingBack(d, CM.ringBack.app, "visitor");
    await handleVoiciRing({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { ring: CM.ring.order, signature: CM.ring.signature });
    await w.calls.setCallAllow({ pageId: K.pageId, conv, op: "allow", issuedAt: NOW, signature: "00" }, NOW);
    await w.calls.putMissedCall({ pageId: K.pageId, conv, callId: "c1".repeat(16), sealed: "x", storedAt: NOW });
    expect((await w.voici.conversationRowCount(K.pageId, conv)) + (await w.calls.conversationCallRowCount(K.pageId, conv))).toBe(6);
    return { w, d };
  }

  for (const side of ["owner", "app", "browser"] as const) {
    it(`a delete by the ${side} leaves zero rows in every table the conversation touched`, async () => {
      const { w, d } = await filled();
      const r = await handleVoiciConvDelete(d, CV.delete[side]);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await w.voici.conversationRowCount(K.pageId, conv)).toBe(0);
      expect(await w.calls.conversationCallRowCount(K.pageId, conv)).toBe(0);
      // No tombstone, no archive, no log: the stores hold nothing else about it either.
      expect(JSON.stringify([...w.calls.ringBacks.values(), ...w.calls.rings.values(), ...w.calls.allows.values(), ...w.calls.missed])).not.toContain(conv);
      // A ring into the gone conversation fails: its channel is gone.
      expect(code(await handleVoiciRing({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { ring: CM.ring.order, signature: CM.ring.signature }))).toBe("no-ring-back");
    });
  }

  it("refuses a forged delete and keeps everything", async () => {
    const { w, d } = await filled();
    expect(code(await handleVoiciConvDelete(d, { ...CV.delete.owner, sig: "00".repeat(64) }))).toBe("bad-signature");
    expect(await w.voici.conversationRowCount(K.pageId, conv)).toBe(2);
  });
});

describe("blocking and the inbox's ring-back flag (release-manager decisions 2026-11-16)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CV: any = JSON.parse(readFileSync(join(here, "../../protocol/test-vectors/voici-conversation/vectors.json"), "utf8"));
  const conv: string = M.derivations.conv;

  it("the owner blocks an anonymous caller until unblocked; a forged or stale order is refused", async () => {
    const w = await world("anyone");
    const anonConv = CM.anon.signed.conv;
    const order = { pageId: K.pageId, conv: anonConv, op: "block" as const, issuedAt: NOW };
    const sig = signVoiciAnonBlock(order, hexToBytes(M.derivations.ownerSignSeed));
    expect(code(await handleVoiciAnonBlock({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { block: order, signature: signVoiciAnonBlock(order, hexToBytes(M.derivations.pseudonymSeed)) }))).toBe("bad-signature");
    expect(code(await handleVoiciAnonBlock({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { block: { ...order, op: "unblock" }, signature: sig }))).toBe("bad-signature");
    expect(code(await handleVoiciAnonBlock({ voici: w.voici, calls: w.calls, now: () => NOW + 11 * 60_000 }, "alice", { block: order, signature: sig }))).toBe("stale");
    expect(code(await handleVoiciAnonBlock({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { block: order, signature: sig }))).toBe("ok");
    expect(code(await handleVoiciCallRequest(w.deps, body(CM.anon.signed)))).toBe("calls-off");
    // It lasts: a year on, still blocked.
    expect(await w.calls.isAnonBlocked(K.pageId, anonConv, NOW + 365 * 86_400_000)).toBe(true);
    const un = { ...order, op: "unblock" as const, issuedAt: NOW + 1 };
    await handleVoiciAnonBlock({ voici: w.voici, calls: w.calls, now: () => NOW }, "alice", { block: un, signature: signVoiciAnonBlock(un, hexToBytes(M.derivations.ownerSignSeed)) });
    expect(await w.calls.isAnonBlocked(K.pageId, anonConv, NOW)).toBe(false);
  });

  it("deleting a conversation lifts its block: a caller who writes again is a new request", async () => {
    const w = await world("callback");
    const d = { voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW };
    await w.voici.setBlock({ pageId: K.pageId, pseudonymPub: M.derivations.pseudonymPub, op: "block", issuedAt: NOW, signature: "00" }, NOW);
    await w.voici.insertMessage({ pageId: K.pageId, conv, msgId: "12".repeat(16), kind: "voici-message", fromPub: M.derivations.pseudonymPub, delegatePub: M.keys.browserPub, sentAt: NOW, envelope: "{}", size: 2, direct: false, pushed: false, storedAt: NOW });
    expect((await handleVoiciConvDelete(d, CV.delete.owner)).status).toBe(200);
    expect(await w.voici.getBlock(K.pageId, M.derivations.pseudonymPub)).toBeNull();
    // An anonymous caller's conversation: the owner deletes it, and its block goes too.
    await w.calls.blockAnon(K.pageId, CV.anonBlock.order.conv, Number.MAX_SAFE_INTEGER);
    expect((await handleVoiciConvDelete(d, CV.anonBlock.ownerDelete)).status).toBe(200);
    expect(await w.calls.conversationCallRowCount(K.pageId, CV.anonBlock.order.conv)).toBe(0);
  });

  it("inbox items say whether their conversation can be rung back", async () => {
    const w = await world("callback");
    await w.voici.insertMessage({ pageId: K.pageId, conv, msgId: "13".repeat(16), kind: "voici-message", fromPub: M.derivations.pseudonymPub, delegatePub: M.keys.browserPub, sentAt: NOW, envelope: JSON.stringify(M.message.envelope), size: 2, direct: false, pushed: false, storedAt: NOW });
    const owner = {
      voici: w.voici,
      calls: w.calls,
      readTokens: { secret: undefined, usernames: { get: async () => ({ username: "alice", isDemo: true }) } as never, identities: {} as never, servers: {} as never, demoUsers: { get: async () => ({ username: "alice" }) } as never, nonces: { claim: async () => true } },
      directory: {} as never,
      now: () => NOW,
    };
    const before = await handleVoiciInbox(owner, "alice", "", null);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect((before.body as { items: { ringBack: boolean }[] }).items.map((i) => i.ringBack)).toEqual([false]);
    await handleVoiciRingBack({ voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW }, CM.ringBack.app, "visitor");
    await w.voici.insertMessage({ pageId: K.pageId, conv, msgId: "14".repeat(16), kind: "voici-message", fromPub: M.derivations.pseudonymPub, delegatePub: M.keys.browserPub, sentAt: NOW, envelope: JSON.stringify(M.message.envelope), size: 2, direct: false, pushed: false, storedAt: NOW });
    const after = await handleVoiciInbox(owner, "alice", "", null);
    expect((after.body as { items: { ringBack: boolean }[] }).items.map((i) => i.ringBack)).toEqual([true, true]);
  });
});

describe("the owner's call hours: sealed, synced, never on the page (owner decision 2026-11-16, option c)", () => {
  it("devices of the account store and read the sealed blob with compare-and-set; .com holds no hours or zone", async () => {
    const s = Object.assign(new InMemoryStorage(), { voiciCalls: new InMemoryVoiciCallStorage() });
    const deviceSeed = new Uint8Array(32).fill(0x75);
    const device = { privateKey: deviceSeed, publicKey: P.ed.getPublicKey(deviceSeed) };
    const deviceId = "ce".repeat(16);
    await s.deviceIdentities.put({ accountId: "alice", deviceId, devicePubHex: Buffer.from(device.publicKey).toString("hex"), platformClass: "ios", createdAt: 1, lastSeenAt: 1, revokedAt: null });
    let rid = 0;
    const auth = () => {
      const request = { accountId: "alice", deviceId, signerPubHex: Buffer.from(device.publicKey).toString("hex"), method: "PUT", path: "/api/accounts/alice/voici-call-settings", requestId: (++rid).toString(16).padStart(32, "0"), issuedAt: NOW };
      return { request, signature: P.signAccountDirectoryRequest(request, device) };
    };
    const directory = { identities: s.deviceIdentities, nonces: { claim: async () => true }, now: () => NOW };
    const d = { calls: s.voiciCalls, directory, now: () => NOW };
    const X = CM.callSettings;
    expect(code(await handleVoiciCallSettingsPut(d, "alice", auth(), JSON.stringify(X.sealed)))).toBe("version-conflict"); // version 3 first
    const v1 = { ...X.sealed, version: 1 };
    expect(code(await handleVoiciCallSettingsPut(d, "alice", auth(), JSON.stringify(v1)))).toBe("ok");
    expect(code(await handleVoiciCallSettingsPut(d, "alice", auth(), JSON.stringify(v1)))).toBe("version-conflict");
    expect(code(await handleVoiciCallSettingsPut(d, "alice", undefined, JSON.stringify({ ...v1, version: 2 })))).toBe("forbidden");
    expect(code(await handleVoiciCallSettingsPut(d, "alice", auth(), JSON.stringify({ ...v1, version: 2, hours: "x" })))).toBe("malformed");
    const stored = JSON.stringify([...s.voiciCalls.callSettings.values()]);
    for (const leak of ["Europe/Paris", "1111100", "0900", "1730"]) expect(stored).not.toContain(leak);
    const readTokens = { secret: undefined, usernames: { get: async () => ({ username: "alice", isDemo: true }) } as never, identities: {} as never, servers: {} as never, demoUsers: { get: async () => ({ username: "alice" }) } as never, nonces: { claim: async () => true } };
    const got = await handleVoiciCallSettingsGet({ calls: s.voiciCalls, readTokens }, "alice", null);
    expect(got.body).toEqual(JSON.parse(P.canonicalJson(v1)));
    await s.voiciCalls.deleteCallsForAccount("alice");
    expect(await s.voiciCalls.getCallSettings("alice")).toBeNull();
  });
});
