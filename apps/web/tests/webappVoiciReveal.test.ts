// The webapp's port of a conversation's delete, the caller's reveal, the control body and call hours
// (apps/web/public/webapp/lib/voiciReveal.js, voiciMessages.js, voiciPage.js) against the shared vectors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../public/webapp/lib/voiciProtocol.js";

const dir = join(import.meta.dirname, "..", "..", "..", "packages", "protocol", "test-vectors");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CV: any = JSON.parse(readFileSync(join(dir, "voici-conversation", "vectors.json"), "utf8"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CM: any = JSON.parse(readFileSync(join(dir, "voici-call-modes", "vectors.json"), "utf8"));
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
