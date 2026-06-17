import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyComBlessing,
  type ComBlessingResponse,
} from "../src/comBlessing.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/maintainerTrust.vectors.json"),
    "utf8",
  ),
);

describe("verifyComBlessing — authoritative cross-platform vectors", () => {
  const PIN: string = VECTORS.pinnedMandateHash;
  const NOW: number = VECTORS.epochsMs.NOW;
  const resp = VECTORS.blessingResponse as ComBlessingResponse;

  it("the fixture self-describes a trusted verdict at NOW", () => {
    expect(VECTORS.expectedVerdict).toEqual({
      trusted: true,
      caPubkey: VECTORS.keys.hotCaKeyPub,
      reason: "trusted",
    });
  });

  it("trusts a valid blessing against the baked pin + client clock", () => {
    expect(verifyComBlessing(resp, NOW, PIN)).toEqual(VECTORS.expectedVerdict);
  });

  it("uses the CLIENT clock, never response.now (lapsed lease at a later NOW)", () => {
    // notAfter = BASE + 90d; pick a NOW past it but leave response.now at the
    // trusted value to prove response.now is ignored.
    // +1 day clears the ±5min window-edge clock-skew tolerance.
    const past = VECTORS.epochsMs.endorsementNotAfter + VECTORS.epochsMs.DAY;
    expect(verifyComBlessing(resp, past, PIN)).toEqual({
      trusted: false,
      caPubkey: VECTORS.keys.hotCaKeyPub,
      reason: "no-authorized-ca-keys",
    });
  });

  it("matches every documented negative case in the fixture", () => {
    for (const nc of VECTORS.negativeCases) {
      const verdict = verifyComBlessing(nc.response, nc.nowMs, nc.pin);
      expect(verdict, nc.name).toEqual(nc.expectedVerdict);
    }
  });

  it("fails closed when the baked pin is empty", () => {
    expect(verifyComBlessing(resp, NOW, "")).toEqual({
      trusted: false,
      caPubkey: "",
      reason: "pin-unconfigured",
    });
  });

  it("rejects a malformed response (missing caPubkey)", () => {
    const bad = { ...resp, caPubkey: undefined } as unknown as ComBlessingResponse;
    expect(verifyComBlessing(bad, NOW, PIN)).toEqual({
      trusted: false,
      caPubkey: "",
      reason: "malformed-response",
    });
  });

  it("rejects when .com serves a CA key the chain does not authorize", () => {
    const swapped: ComBlessingResponse = {
      ...resp,
      caPubkey: "00".repeat(32),
    };
    expect(verifyComBlessing(swapped, NOW, PIN)).toEqual({
      trusted: false,
      caPubkey: "00".repeat(32),
      reason: "ca-key-not-authorized",
    });
  });
});
