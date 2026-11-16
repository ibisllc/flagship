// Page call modes, anonymous calls, the ring-back channel and the ring against
// test-vectors/voici-call-modes (tools/voici-call-modes-vectors.ts).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", "voici-call-modes", "vectors.json"), "utf8"));
const h = (s: string) => P.hexToBytes(s);
const H = (b: Uint8Array) => Buffer.from(b).toString("hex");
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("voici call modes vectors", () => {
  it("anonymous requests the browser built, as a ringing device receives them", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", "voici-call-modes", "browser-built.json"), "utf8"));
    for (const [kind, r] of Object.entries(B.requests)) {
      expect(code(P.checkVoiciCallRequestAnon(r, B.ctx)), kind).toBe("ok");
      for (const callsFrom of ["accepted", "signed-in", "callback"]) expect(code(P.checkVoiciCallRequestAnon(r, { ...B.ctx, callsFrom })), `${kind} ${callsFrom}`).toBe("not-allowed");
      expect(code(P.checkVoiciCallRequestAnon(r, { ...B.ctx, acceptsCalls: false })), kind).toBe("calls-off");
    }
  });

  it("proof of work: issue, solve, check", () => {
    expect(P.voiciCallPowSolves(V.pow.challenge, V.pow.nonce)).toBe(true);
    expect(P.voiciCallPowSolves(V.pow.challenge, V.pow.wrongNonce)).toBe(false);
    expect(P.solveVoiciCallPow(V.pow.challenge)).toBe(V.pow.nonce);
    for (const c of V.pow.checks) expect(P.checkVoiciCallPowChallenge(c.challenge, { secret: h(V.pow.secret), pageId: V.pageId, now: c.now }), c.name).toBe(c.expect);
  });

  it("the anonymous request", () => {
    expect(dec(P.canonicalVoiciCallRequestAnon(V.anon.signed))).toBe(V.anon.canonical);
    expect(P.signVoiciCallRequestAnonP256(V.anon.body, h(V.anon.browserPriv))).toEqual(V.anon.signed);
    expect(P.voiciAnonConv(V.pageId, V.anon.browserPub)).toBe(V.anon.body.conv);
    for (const c of V.anon.checks) expect(code(P.checkVoiciCallRequestAnon(c.input, V.anon.ctx)), c.name).toBe(c.expect);
    for (const c of V.anon.modeChecks) expect(code(P.checkVoiciCallRequestAnon(V.anon.signed, { ...V.anon.ctx, callsFrom: c.callsFrom })), c.name).toBe(c.expect);
  });

  it("the ring-back channel", () => {
    expect(dec(P.canonicalVoiciRingBack(V.ringBack.app.order))).toBe(V.ringBack.canonical);
    for (const c of V.ringBack.checks) expect(code(P.checkVoiciRingBackOrder(c.input, V.ringBack.ctx)), c.name).toBe(c.expect);
  });

  it("the ring and its hint", () => {
    expect(dec(P.canonicalVoiciRing(V.ring.order))).toBe(V.ring.canonical);
    for (const c of V.ring.checks) expect(P.verifyVoiciRing(c.ring, c.signature, V.ring.ownerSignPub), c.name).toBe(c.expect);
    const hint = P.b64Encode(P.sealVoiciRingHint(h(V.ring.threadPub), V.ring.hintPlain, h(V.ring.hintEseed)));
    expect(hint).toBe(V.ring.order.hint);
    expect(P.openVoiciRingHint(h(V.ring.threadSeed), V.ring.order.conv, V.ring.order.ringId, P.b64Decode(hint)!)).toEqual(V.ring.hintPlain);
  });

  it("call hours: the owner's sealed setting, its shapes, and when a call may ring", () => {
    const X = V.callSettings;
    const key = P.deriveVoiciCallSettingsKey({ seed: h(X.ownerUmk) } as never);
    expect(H(key)).toBe(X.key);
    expect(P.sealVoiciCallSettings(key, X.username, X.sealed.version, X.plain, h(X.nonce))).toEqual(X.sealed);
    expect(P.openVoiciCallSettings(key, X.username, X.sealed)).toEqual(X.plain);
    expect(P.openVoiciCallSettings(key, "bob", X.sealed)).toBeNull();
    expect(P.openVoiciCallSettings(key, X.username, { ...X.sealed, version: X.sealed.version + 1 })).toBeNull();
    for (const c of X.hoursShapes) expect(P.parseVoiciCallHours(c.value) !== null, c.name).toBe(c.expect);
    for (const c of X.hoursAllow) expect(P.voiciCallHoursAllow(c.hours, c.now), c.name).toBe(c.expect);
    expect(P.mergeVoiciCallSettings(X.plainNone, X.plain)).toEqual(X.plain);
  });

  it("an anonymous call's push opens as an anonymous caller", () => {
    const X = V.anonPush;
    expect(P.b64Encode(P.sealVoiciCallPush(P.hybridSealKeygen(h(X.inboxSeed)).publicKey, { callId: X.payload.callId, pageId: X.payload.pageId, conv: X.payload.conv, from: X.payload.from }, V.now, h(X.eseed)))).toBe(X.sealed);
    expect(P.openVoiciCallPush(h(X.inboxSeed), X.callId, P.b64Decode(X.sealed)!)).toEqual(X.opened);
    expect(X.opened.anonymous).toBe(true);
    expect(P.openVoiciCallPush(h(X.inboxSeed), X.callId, P.b64Decode(X.badConvSealed)!)).toBeNull();
  });

  it("a v2 index carries the new modes", () => {
    for (const from of ["anyone", "callback"]) expect(P.VOICI_CALLS_FROM_VALUES as readonly string[]).toContain(from);
  });

  it("the vectors file is fresh", () => {
    execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "..", "tools", "voici-call-modes-vectors.ts"), "--check"], { stdio: "pipe" });
  }, 60_000);
});
