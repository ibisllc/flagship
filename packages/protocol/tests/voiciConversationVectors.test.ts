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
  it("the vectors file is fresh", () => {
    execFileSync("npx", ["tsx", join(import.meta.dirname, "..", "..", "..", "tools", "voici-conversation-vectors.ts"), "--check"], { stdio: "pipe" });
  }, 60_000);
});
