/**
 * Who may call a page, and ringing a caller back (docs/voici-calls.md, owner-approved 2026-11-15): anonymous calls
 * with a proof of work on "anyone" pages, the ring-back channel a "callback" page requires, the owner's ring, and
 * that `.com` never handles a raw push token or tells the push relay which conversation a ring is for.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemoryVoiciCallStorage, InMemoryVoiciStorage } from "@flagship/storage";
import { canonicalVoiciThreadFetch, hexToBytes, signVoiciRing, signVoiciRingBackPseudonym } from "@flagship/protocol";
import { p256 } from "@noble/curves/nist.js";
import { handleVoiciCallChallenge, handleVoiciCallRequest, handleVoiciRing, handleVoiciRingBack, handleVoiciThread, type VoiciCallRequestDeps, type VoiciCallRoomInit } from "../src/index.js";

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
    // `.com` keeps the sealed targets as they came: it has nothing to open them with.
    expect((await w.calls.getRingBack(K.pageId, M.derivations.conv, NOW))!.targets).toEqual(attach.order.targets);
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

  it("the owner's ring: the relay gets sealed targets and the ring id, never the conversation; the thread fetch shows it", async () => {
    const w = await world("callback");
    await handleVoiciRingBack({ voici: w.voici, calls: w.calls, origin: V.constants.origin, caKeys: () => [K.caPub], now: () => NOW }, attach);
    const delivered: { sealed: string; payload: Record<string, string> }[] = [];
    const pushRelay = { deliver: async (items: { sealed: string; payload: Record<string, string> }[]) => (delivered.push(...items), items.length) };
    const r = await handleVoiciRing({ voici: w.voici, calls: w.calls, pushRelay, now: () => NOW }, "alice", { ring: CM.ring.order, signature: CM.ring.signature });
    expect(r.status).toBe(200);
    expect(delivered.map((d) => d.sealed)).toEqual(attach.order.targets);
    for (const d of delivered) {
      expect(Object.keys(d.payload).sort()).toEqual(["hint", "kind", "ringId"]);
      expect(JSON.stringify(d.payload)).not.toContain(M.derivations.conv);
      expect(JSON.stringify(d.payload)).not.toContain(K.pageId);
    }
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
