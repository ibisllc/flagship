import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalRuntimeManifest, verifyRuntimeManifest, type RuntimeManifest } from "../src/runtimeManifest.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/runtime-manifest/vectors.json", import.meta.url), "utf8"));

describe("runtime manifest vectors", () => {
  for (const c of vectors.cases) {
    it(c.name, () => {
      const r = verifyRuntimeManifest(c.manifest as RuntimeManifest, c.signatures, {
        trust: c.trust,
        pqPin: c.pin,
        pqBindings: c.bindings,
        lockText: c.lockText,
        lockSigners: c.lockSigners,
        now: c.now,
        ...(c.lastSequence !== undefined ? { lastSequence: c.lastSequence } : {}),
      });
      expect(r.ok).toBe(c.expect.ok);
      if (!r.ok) expect(r.code).toBe(c.expect.code);
    });
  }

  it("the canonical bytes are the documented form", () => {
    const m = vectors.cases[0].manifest as RuntimeManifest;
    expect(Buffer.from(canonicalRuntimeManifest(m)).toString()).toBe(vectors.canonicalV1);
    expect(vectors.canonicalV1).toMatch(/^flagship\/runtime-manifest\/v1\|node\|24\.22\.1\|[0-9a-f]{64}\|24\.22\.1\|12\|\d+\|\d+\|-$/);
  });

  it("refuses to canonicalise a malformed manifest", () => {
    const m = vectors.cases[0].manifest as RuntimeManifest;
    expect(() => canonicalRuntimeManifest({ ...m, version: "24.22" })).toThrow();
    expect(() => canonicalRuntimeManifest({ ...m, lockSha256: "abc" })).toThrow();
    expect(() => canonicalRuntimeManifest({ ...m, validUntil: m.issuedAt })).toThrow();
    expect(() => canonicalRuntimeManifest({ ...m, revokedSigners: ["XYZ"] })).toThrow();
    expect(() => canonicalRuntimeManifest({ ...m, runtime: "bun" as never })).toThrow();
  });

  it("the revoked list is sorted so the signed bytes do not depend on order", () => {
    const m = vectors.cases[0].manifest as RuntimeManifest;
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(canonicalRuntimeManifest({ ...m, revokedSigners: [b, a] })).toEqual(canonicalRuntimeManifest({ ...m, revokedSigners: [a, b] }));
  });
});
