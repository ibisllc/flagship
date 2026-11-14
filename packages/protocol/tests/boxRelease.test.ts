import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boxReleaseProblem, canonicalBoxRelease, ed, parseBoxRelease, signBoxRelease, verifyBoxRelease, type BoxReleaseOrder } from "../src/index.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/box-release/vectors.json", import.meta.url), "utf8"));
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const admin = { privateKey: bytes(V.keys.adminRootSeedHex), publicKey: bytes(V.keys.adminRootPubHex) };

describe("box release vectors", () => {
  it("derives the admin root", () => {
    expect(Buffer.from(ed.getPublicKey(admin.privateKey)).toString("hex")).toBe(V.keys.adminRootPubHex);
  });

  it("reproduces the canonical bytes and signature", () => {
    const o = V.order.fields as BoxReleaseOrder;
    expect(new TextDecoder().decode(canonicalBoxRelease(o))).toBe(V.order.canonical);
    expect(Buffer.from(signBoxRelease(o, admin)).toString("hex")).toBe(V.order.signatureHex);
    expect(verifyBoxRelease(o, bytes(V.order.signatureHex), admin.publicKey)).toBe(true);
  });

  it("rejects every reject case", () => {
    for (const r of V.reject) expect(verifyBoxRelease(r.fields, bytes(r.signatureHex), bytes(r.verifyUnder)), r.why).toBe(false);
  });

  it("refuses every refuse case before signing", () => {
    for (const r of V.refuse) {
      expect(boxReleaseProblem(r.fields), r.why).toBe(r.problem);
      expect(() => signBoxRelease(r.fields, admin), r.why).toThrow();
      expect(verifyBoxRelease(r.fields, bytes(V.order.signatureHex), admin.publicKey), r.why).toBe(false);
    }
  });

  it("parses only the order's shape", () => {
    expect(parseBoxRelease(V.order.fields)).toEqual(V.order.fields);
    expect(parseBoxRelease({ ...V.order.fields, issuedAt: "1" })).toBeNull();
    expect(parseBoxRelease(null)).toBeNull();
  });

  it("the committed file is what the generator writes", () => {
    const tool = fileURLToPath(new URL("../../../tools/box-release-vectors.ts", import.meta.url));
    expect(() => execFileSync("npx", ["tsx", tool, "--check"], { stdio: "pipe" })).not.toThrow();
  }, 60_000);
});
