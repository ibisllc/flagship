import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import {
  gpuApprovalCanonicalBytes,
  gpuApprovalWithdrawCanonicalBytes,
  verifyGpuApproval,
  verifyGpuApprovalWithdraw,
  type GpuApprovalTerms,
  type GpuApprovalWithdraw,
} from "../src/gpuApproval.js";
import { buildGpuApprovalVectors, VECTORS_PATH } from "./genGpuApprovalVectors.js";

interface Case {
  name: string;
  approval: GpuApprovalTerms;
  proof: { issuedAt: number; signature: string };
  canonical?: string;
  expect: boolean;
}
const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as {
  anchor: { server: string; signerHex: string };
  cases: Case[];
  withdraw: { name: string; withdraw: GpuApprovalWithdraw; signature: string; canonical?: string; expect: boolean }[];
};

const sig = (h: string) => (/^[0-9a-f]{128}$/.test(h) ? hexToBytes(h) : new Uint8Array(64));

describe("gpu-approval vectors (gpud checks the owner's signature itself)", () => {
  it("the file is what the generator writes", () => {
    expect(V).toEqual(JSON.parse(JSON.stringify(buildGpuApprovalVectors())));
  });

  it("reads the shared set at packages/protocol/test-vectors/gpu-approval/vectors.json", () => {
    expect(VECTORS_PATH.replace(/\\/g, "/").endsWith("test-vectors/gpu-approval/vectors.json")).toBe(true);
  });

  for (const c of V.cases) {
    it(`${c.expect ? "accepts" : "refuses"}: ${c.name}`, () => {
      if (c.canonical) expect(new TextDecoder().decode(gpuApprovalCanonicalBytes(V.anchor.server, c.approval, c.proof.issuedAt))).toBe(c.canonical);
      expect(verifyGpuApproval(V.anchor.server, c.approval, c.proof.issuedAt, sig(c.proof.signature), hexToBytes(V.anchor.signerHex))).toBe(c.expect);
    });
  }

  for (const c of V.withdraw) {
    it(`${c.expect ? "accepts" : "refuses"} the withdrawal: ${c.name}`, () => {
      if (c.canonical) expect(new TextDecoder().decode(gpuApprovalWithdrawCanonicalBytes(V.anchor.server, c.withdraw))).toBe(c.canonical);
      expect(verifyGpuApprovalWithdraw(V.anchor.server, c.withdraw, sig(c.signature), hexToBytes(V.anchor.signerHex))).toBe(c.expect);
    });
  }

  it("refuses to sign what gpud could not read back", () => {
    const a = V.cases[0]!.approval;
    for (const bad of [
      { ...a, app: { ...a.app, appId: "alice|render" } },
      { ...a, app: { ...a.app, installationId: "" } },
      { ...a, maxCount: 17 },
      { ...a, maxCount: 0 },
      { ...a, capabilities: [] },
      { ...a, policies: ["shared"] },
      { ...a, trustDomain: "fam,ily" },
      { ...a, backend: "cuda" },
    ] as GpuApprovalTerms[]) {
      expect(() => gpuApprovalCanonicalBytes(V.anchor.server, bad, 1)).toThrow(/gpu-approval/);
    }
    expect(() => gpuApprovalCanonicalBytes("Home.Alice", a, 1)).toThrow(/serverDomain/);
  });
});
