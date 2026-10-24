import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyBoxArtifact, type BoxArtifactManifest, type BoxArtifactSignature } from "../src/boxArtifact.js";
import { BOX_ARTIFACT_PQ_PIN, boxArtifactPqPinConfigured, type BoxArtifactPqPin } from "../src/boxArtifactPq.js";

const V = JSON.parse(readFileSync(join(__dirname, "../test-vectors/box-artifact/pq-vectors.json"), "utf8")) as {
  now: number;
  manifest: BoxArtifactManifest;
  trust: { keys: string[]; threshold: number };
  cases: { name: string; signatures: BoxArtifactSignature[]; pin: BoxArtifactPqPin; bindings: unknown[]; expect: { ok: boolean; code?: string } }[];
};

describe("the box artifact's PQ companion", () => {
  it.each(V.cases)("$name", (c) => {
    const r = verifyBoxArtifact(V.manifest, c.signatures, { trust: V.trust, verifierVersion: 1, pqPin: c.pin, pqBindings: c.bindings, now: V.now });
    expect(r.ok ? { ok: true } : { ok: false, code: r.code }).toEqual(c.expect);
  });

  it("ships with an empty pin: nothing changes until the key ceremony", () => {
    expect(boxArtifactPqPinConfigured(BOX_ARTIFACT_PQ_PIN)).toBe(false);
  });
});
