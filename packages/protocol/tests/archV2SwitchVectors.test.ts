import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { canonicalArchV2SwitchOrder, verifyArchV2SwitchOrder, type ArchV2SwitchOrder } from "../src/archV2Switch.js";

// The shared set every port reads (Swift, Kotlin and the webapp sign the stack switch the box verifies).
const V = JSON.parse(readFileSync(new URL("../test-vectors/arch-v2-switch/vectors.json", import.meta.url), "utf8")) as {
  signerHex: string;
  cases: Array<{ name: string; order: ArchV2SwitchOrder; canonical?: string; signature: string; expect: boolean }>;
  refused: Array<{ name: string; order: ArchV2SwitchOrder }>;
};

describe("arch-v2-switch vectors", () => {
  for (const c of V.cases) {
    it(`${c.expect ? "accepts" : "refuses"}: ${c.name}`, () => {
      if (c.canonical) expect(new TextDecoder().decode(canonicalArchV2SwitchOrder(c.order))).toBe(c.canonical);
      expect(verifyArchV2SwitchOrder(c.order, hexToBytes(c.signature), hexToBytes(V.signerHex))).toBe(c.expect);
    });
  }
  for (const r of V.refused) {
    it(`will not encode: ${r.name}`, () => expect(() => canonicalArchV2SwitchOrder(r.order)).toThrow());
  }
});
