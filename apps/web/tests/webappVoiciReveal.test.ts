// The webapp's port of a conversation's delete, the caller's reveal, the control body and call hours
// (apps/web/public/webapp/lib/voiciReveal.js, voiciMessages.js, voiciPage.js) against the shared vectors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../public/webapp/lib/voiciProtocol.js";

const dir = join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CV: any = JSON.parse(readFileSync(join(dir, "..", "test-vectors/voici-conversation/vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CM: any = JSON.parse(readFileSync(join(dir, "..", "test-vectors/voici-call-modes/vectors.json"), "utf8"));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

describe("webapp voici conversation port", () => {
  it("the owner's delete bytes and signature", () => {
    expect(dec(P.canonicalVoiciConvDelete(CV.delete.owner.del))).toBe(CV.delete.canonical);
  });
  it("reveal checks, as the TypeScript reference", () => {
    expect(dec(P.canonicalVoiciReveal(CV.reveal.signed))).toBe(CV.reveal.canonical);
    expect(P.signVoiciReveal(CV.reveal.signed, P.hexToBytes(CV.reveal.pageSignSeed))).toEqual(CV.reveal.signed);
    for (const c of CV.reveal.checks) expect(code(P.checkVoiciReveal(c.input, CV.reveal.ctx)), c.name).toBe(c.expect);
    for (const c of CV.reveal.unrevealShapes) expect(P.parseVoiciRevealControl(c.input) !== null, c.name).toBe(c.expect);
  });
  it("the control body opens as a control, never as text", () => {
    const C = CV.control;
    for (const k of ["reveal", "unreveal"]) {
      const r = P.openVoiciBodyAny(P.b64Decode(C[k].body), { conv: CV.conv, msgId: C[k].msgId }, P.hexToBytes(C.inboxSeed));
      expect(r.control).toEqual(C[k].control);
      expect(P.openVoiciBody(P.b64Decode(C[k].body), { conv: CV.conv, msgId: C[k].msgId }, P.hexToBytes(C.inboxSeed)).code).toBe("inner-schema");
    }
    expect(P.openVoiciBodyAny(P.b64Decode(C.wrongConv.body), { conv: CV.conv, msgId: C.wrongConv.msgId }, P.hexToBytes(C.inboxSeed)).code).toBe("inner-schema");
  });
  it("blocking an anonymous caller", () => {
    expect(dec(P.canonicalVoiciAnonBlock(CV.anonBlock.order))).toBe(CV.anonBlock.canonical);
    expect(P.signVoiciAnonBlock(CV.anonBlock.order, P.hexToBytes(CV.reveal.pageSignSeed))).toBe(CV.anonBlock.signature);
    expect(dec(P.canonicalVoiciConvDelete(CV.anonBlock.ownerDelete.del))).toContain(CV.anonBlock.order.conv);
  });

  it("call hours", () => {
    const X = CM.callHours;
    for (const c of X.shapes) expect(P.isVoiciCallHours(c.value), c.name).toBe(c.expect);
    for (const c of X.open) expect(P.voiciCallHoursOpen(c.hours ?? undefined, c.now), c.name).toBe(c.expect);
    expect(dec(P.canonicalVoiciPageIndex(X.withHours))).toBe(X.withHoursCanonical);
    expect(dec(P.canonicalVoiciPageIndex(X.noHours))).toBe(X.noHoursCanonical);
    for (const c of X.index) expect(P.parseVoiciPageIndex(c.index) !== null, c.name).toBe(c.ok);
  });
});

describe("the owner's inbox reads a reveal and the ring-back flag", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const M: any = JSON.parse(readFileSync(join(dir, "messages", "vectors.json"), "utf8"));
  const D = M.derivations;
  it("a control message sets the conversation's reveal, shows no bubble and leaves no seq gap", async () => {
    const { openInbox } = await import("../public/webapp/lib/voiciOwner.js");
    const sentAt = M.t0 + 10_000;
    const msgId = "c1".repeat(16);
    const body = P.sealVoiciBody({ conv: D.conv, msgId, sentAt, fromPub: D.pseudonymPub, recipients: [P.hexToBytes(D.inboxPub), P.hexToBytes(D.threadPub)], plaintext: { v: 1, control: CV.reveal.signed } });
    const env = P.signWebEnvelopeP256({ v: 1, kind: "voici-message", audience: D.pageId, conv: D.conv, from: D.pseudonymPub, msgId, seq: 1, sentAt, bodyB64: P.b64Encode(body), cred: M.message.envelope.cred }, P.hexToBytes(M.keys.browserPriv));
    const r = openInbox({ index: { pageId: D.pageId, inboxEpoch: 1 } }, { items: [{ envelope: env, ringBack: true }], anonBlocks: ["a0c0".repeat(8), "nope"] }, { umk: { seed: P.hexToBytes(D.ownerUmk) }, caKeys: [M.keys.caPub], origin: "https://voi.ci" });
    expect(r.conversations).toHaveLength(1);
    const cv = r.conversations[0];
    expect(cv.control).toEqual(CV.reveal.signed);
    expect(cv.messages).toEqual([]);
    expect([cv.gap, cv.ringBack]).toEqual([false, true]);
    expect(r.anonBlocks).toEqual(["a0c0".repeat(8)]);
  });
});

describe("the owner's ring from the webapp", () => {
  it("the hint and the ring's bytes match the TypeScript reference", async () => {
    const C = await import("../public/webapp/lib/voiciCalls.js");
    const X = CM.ring;
    const hint = C.voiciRingHintB64(C.sealVoiciRingHint(P.hexToBytes(X.threadPub), X.hintPlain, P.hexToBytes(X.hintEseed)));
    expect(hint).toBe(X.order.hint);
    expect(dec(C.canonicalVoiciRing(X.order))).toBe(X.canonical);
    for (const c of X.checks) expect(P.ed25519VerifyHex(c.signature, C.canonicalVoiciRing(c.ring), X.ownerSignPub), c.name).toBe(c.expect);
  });
});
