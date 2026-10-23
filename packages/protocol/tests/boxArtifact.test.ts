import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NODE_SECURITY_FLOOR,
  assertBoxArtifactManifest,
  canonicalBoxArtifact,
  compareSemver,
  nodeRuntimeStatus,
  signBoxArtifact,
  verifyBoxArtifact,
  type BoxArtifactManifest,
} from "../src/boxArtifact.js";

const V = JSON.parse(readFileSync(new URL("../test-vectors/box-artifact/vectors.json", import.meta.url), "utf8"));
const floorFile = JSON.parse(readFileSync(new URL("../../../release/security-floor.json", import.meta.url), "utf8"));
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("box artifact manifest (shared vectors)", () => {
  it("has the shared canonical bytes and a signature per authority", () => {
    expect(new TextDecoder().decode(canonicalBoxArtifact(V.manifest))).toBe(V.canonical);
    V.seeds.forEach((s: string, i: number) => {
      expect(signBoxArtifact(V.manifest, unhex(s))).toEqual(V.signatures[i]);
    });
  });

  it.each(V.cases as Array<{ name: string; signatures: never[]; options: never; expect: { ok: boolean; code?: string } }>)("$name", (c) => {
    const r = verifyBoxArtifact(V.manifest, c.signatures, c.options);
    expect(r.ok).toBe(c.expect.ok);
    if (!r.ok) expect(r.code).toBe(c.expect.code);
  });
});

describe("what the manifest refuses to describe", () => {
  const m = V.manifest as BoxArtifactManifest;
  it.each([
    ["a branch name", { commit: "main" }],
    ["a tag", { commit: "v1.2.3" }],
    ["an abbreviated commit", { commit: "0123456" }],
    ["an upper-case commit", { commit: "0123456789ABCDEF0123456789ABCDEF01234567" }],
    ["an empty commit", { commit: "" }],
    ["an unknown architecture", { arch: "riscv" as never }],
    ["a short digest", { artifactSha256: "ab" }],
    ["a Node version with a pre-release", { nodeVersion: "24.22.1-rc1" }],
    ["a separator in the Node version", { nodeVersion: "24.22.1|x" }],
    ["a negative sequence", { sequence: -1 }],
    ["an empty artifact", { artifactBytes: 0 }],
  ])("%s", (_n, over) => {
    expect(() => assertBoxArtifactManifest({ ...m, ...over })).toThrow();
    expect(verifyBoxArtifact({ ...m, ...over }, V.signatures, { trust: V.trust, verifierVersion: 1 })).toMatchObject({ ok: false, code: "bad-manifest" });
  });

  it("treats a malformed trust set as no trust", () => {
    for (const trust of [{ keys: [], threshold: 1 }, { keys: V.trust.keys, threshold: 0 }, { keys: V.trust.keys, threshold: 9 }, { keys: ["zz"], threshold: 1 }]) {
      expect(verifyBoxArtifact(m, V.signatures, { trust, verifierVersion: 1 })).toMatchObject({ ok: false, code: "bad-trust" });
    }
  });

  it("ignores a garbage signature instead of throwing", () => {
    const r = verifyBoxArtifact(m, [{ keyHex: V.publicKeys[0], signatureHex: "zz" }, V.signatures[0], V.signatures[1]], { trust: V.trust, verifierVersion: 1 });
    expect(r.ok).toBe(true);
  });
});

describe("the Node security floor", () => {
  it("is one number in code and in release/security-floor.json", () => {
    expect(floorFile.node.minimum).toBe(NODE_SECURITY_FLOOR);
  });

  it("compares versions numerically and reports the running Node", () => {
    expect(compareSemver("24.22.1", "24.22.1")).toBe(0);
    expect(compareSemver("24.9.0", "24.22.1")).toBe(-1);
    expect(compareSemver("24.100.0", "24.22.1")).toBe(1);
    expect(compareSemver("20.19.5", NODE_SECURITY_FLOOR)).toBe(-1);
    expect(nodeRuntimeStatus("20.19.5")).toMatchObject({ belowFloor: true });
    expect(nodeRuntimeStatus("24.22.1")).toMatchObject({ belowFloor: false });
    expect(nodeRuntimeStatus("not a version")).toMatchObject({ belowFloor: true });
  });
});
