// Deleting a conversation and the caller's reveal against test-vectors/voici-conversation.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as P from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(readFileSync(join(import.meta.dirname, "..", "test-vectors", "voici-conversation", "vectors.json"), "utf8"));
const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("voici conversation vectors", () => {
  it("delete", () => {
    expect(dec(P.canonicalVoiciConvDelete(V.delete.owner.del))).toBe(V.delete.canonical);
    for (const c of V.delete.checks) expect(code(P.checkVoiciConvDelete(c.input, V.delete.ctx)), c.name).toBe(c.expect);
  });
  it("reveal and unreveal", () => {
    expect(dec(P.canonicalVoiciReveal(V.reveal.signed))).toBe(V.reveal.canonical);
    expect(P.voiciRevealNameHash("Bob Rivera")).toBe(V.reveal.nameHash);
    expect(P.signVoiciReveal(V.reveal.signed, P.hexToBytes(V.reveal.pageSignSeed))).toEqual(V.reveal.signed);
    for (const c of V.reveal.checks) expect(code(P.checkVoiciReveal(c.input, V.reveal.ctx)), c.name).toBe(c.expect);
    for (const c of V.reveal.unrevealShapes) expect(P.parseVoiciRevealControl(c.input) !== null, c.name).toBe(c.expect);
  });
  it("a reveal and an unreveal sealed in the conversation; old readers refuse them", () => {
    const C = V.control;
    for (const k of ["reveal", "unreveal"] as const) {
      const r = P.openVoiciBodyAny(P.b64Decode(C[k].body)!, { conv: V.conv, msgId: C[k].msgId }, P.hexToBytes(C.inboxSeed));
      expect(r.ok && "control" in r ? r.control : null).toEqual(C[k].control);
      expect(P.openVoiciBody(P.b64Decode(C[k].body)!, { conv: V.conv, msgId: C[k].msgId }, P.hexToBytes(C.inboxSeed))).toEqual({ ok: false, code: "inner-schema" });
    }
    expect(P.openVoiciBodyAny(P.b64Decode(C.wrongConv.body)!, { conv: V.conv, msgId: C.wrongConv.msgId }, P.hexToBytes(C.inboxSeed))).toEqual({ ok: false, code: C.wrongConv.expect });
  });

  it("blocking an anonymous caller; the owner deletes its conversation", () => {
    const X = V.anonBlock;
    expect(dec(P.canonicalVoiciAnonBlock(X.order))).toBe(X.canonical);
    for (const c of X.checks) expect(P.verifyVoiciAnonBlock(c.block, c.signature, V.ownerSignPub), c.name).toBe(c.expect);
    for (const c of X.shapes) expect(P.parseVoiciAnonBlock(c.input) !== null, c.name).toBe(c.expect);
    expect(code(P.checkVoiciConvDelete(X.ownerDelete, V.delete.ctx))).toBe("ok");
  });

  it("the vectors file is fresh", () => {
    execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "..", "tools", "voici-conversation-vectors.ts"), "--check"], { stdio: "pipe" });
  }, 60_000);
});
