/**
 * STK-signed box-trust-status report — canonical bytes + verify, with a
 * PINNED cross-platform vector. iOS (FlagshipCore) and Android (core) mirror
 * the verifier against these exact constants; the daemon heartbeat and the
 * control-plane relay both import THIS implementation, so the vector is the
 * single byte-level contract for the per-box relay-trust verdict.
 *
 * Pinned vector (regenerate only on a deliberate v2 of the format):
 *   UMK seed   = 07 × 32
 *   serverId   = "abc5.harry1.flagship.services"
 *   STK        = deriveSTK(deriveSWK(UMK, serverId))   (the phone-side path)
 *   STK pub    = 0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47
 */

import { describe, expect, it } from "vitest";
import {
  canonicalBoxTrustStatusReport,
  signBoxTrustStatusReport,
  verifyBoxTrustStatusReport,
  deriveSTK,
  deriveSWK,
  generateUMK,
  type BoxTrustStatusReport,
} from "../src/index.js";

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const UMK_SEED_HEX = "07".repeat(32);
const STK_PUB_HEX =
  "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47";

// An UNTRUSTED box under an owner override — every optional field populated.
const REPORT: BoxTrustStatusReport = {
  serverDomain: "abc5.harry1.flagship.services",
  relayVerdict: "untrusted",
  lockedDown: true,
  failingCertHash:
    "1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372819a0b1c2d3e4f5061",
  coveringExceptionCertHash:
    "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
  nonce: "00112233445566778899aabbccddeeff",
  issuedAt: 1_700_000_000_000,
};

const CANONICAL =
  "flagship/box-trust-status/v1|abc5.harry1.flagship.services|untrusted|1|" +
  "1e2d3c4b5a69788796a5b4c3d2e1f00918273645546372819a0b1c2d3e4f5061|" +
  "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899|" +
  "00112233445566778899aabbccddeeff|1700000000000";

const SIG_HEX =
  "85ad9b3fb100c7ab8ca3600ac8970a3a66fd2c5ee0ebf363573dac5b70b420ab9" +
  "3a7cace49c5fb153c8549933820893aaad3a5a24a47f6aa3be01babbdd6f502";

// A TRUSTED box, healthy — optional fields empty, lockedDown false.
const TRUSTED_REPORT: BoxTrustStatusReport = {
  serverDomain: "abc5.harry1.flagship.services",
  relayVerdict: "trusted",
  lockedDown: false,
  failingCertHash: null,
  coveringExceptionCertHash: null,
  nonce: "00112233445566778899aabbccddeeff",
  issuedAt: 1_700_000_000_000,
};

const TRUSTED_CANONICAL =
  "flagship/box-trust-status/v1|abc5.harry1.flagship.services|trusted|0|||" +
  "00112233445566778899aabbccddeeff|1700000000000";

const TRUSTED_SIG_HEX =
  "e674e0c3e329092e11afe5dd9faab14a82edfc4c5063d01eb3f9b6693bc966fb4" +
  "7015b3258b88b03b4b61c82442a017b5b94a8384a7396eb3539f6db3f053807";

function stk() {
  const umk = generateUMK(() => hexToBytes(UMK_SEED_HEX));
  return deriveSTK(deriveSWK(umk, REPORT.serverDomain));
}

describe("box-trust-status report (pinned cross-platform vector)", () => {
  it("the phone-side STK derivation reproduces the pinned pubkey", () => {
    expect(bytesToHex(stk().publicKey)).toBe(STK_PUB_HEX);
  });

  it("canonical bytes match the pinned string (untrusted + override)", () => {
    expect(
      new TextDecoder().decode(canonicalBoxTrustStatusReport(REPORT)),
    ).toBe(CANONICAL);
  });

  it("trusted-healthy encodes optional fields as empty segments", () => {
    expect(
      new TextDecoder().decode(canonicalBoxTrustStatusReport(TRUSTED_REPORT)),
    ).toBe(TRUSTED_CANONICAL);
  });

  it("signing is deterministic and matches the pinned signature", () => {
    expect(bytesToHex(signBoxTrustStatusReport(REPORT, stk()))).toBe(SIG_HEX);
    expect(bytesToHex(signBoxTrustStatusReport(TRUSTED_REPORT, stk()))).toBe(
      TRUSTED_SIG_HEX,
    );
  });

  it("the pinned signature verifies under the pinned STK pubkey", () => {
    expect(
      verifyBoxTrustStatusReport(
        REPORT,
        hexToBytes(SIG_HEX),
        hexToBytes(STK_PUB_HEX),
      ),
    ).toBe(true);
    expect(
      verifyBoxTrustStatusReport(
        TRUSTED_REPORT,
        hexToBytes(TRUSTED_SIG_HEX),
        hexToBytes(STK_PUB_HEX),
      ),
    ).toBe(true);
  });

  it("rejects a mutation of EACH signed field", () => {
    const sig = hexToBytes(SIG_HEX);
    const pub = hexToBytes(STK_PUB_HEX);
    const mutations: Array<Partial<BoxTrustStatusReport>> = [
      { serverDomain: "evil.harry1.flagship.services" },
      { relayVerdict: "trusted" },
      { relayVerdict: "unknown" },
      { lockedDown: false },
      { failingCertHash: "ab".repeat(32) },
      { failingCertHash: null },
      { coveringExceptionCertHash: "cd".repeat(32) },
      { coveringExceptionCertHash: null },
      { nonce: "ff112233445566778899aabbccddeeff" },
      { issuedAt: 1_700_000_000_001 },
    ];
    for (const m of mutations) {
      expect(
        verifyBoxTrustStatusReport({ ...REPORT, ...m }, sig, pub),
      ).toBe(false);
    }
  });

  it("rejects a signature from a different key", () => {
    const otherUmk = generateUMK(() => new Uint8Array(32).fill(8));
    const other = deriveSTK(deriveSWK(otherUmk, REPORT.serverDomain));
    const sig = signBoxTrustStatusReport(REPORT, other);
    expect(
      verifyBoxTrustStatusReport(REPORT, sig, hexToBytes(STK_PUB_HEX)),
    ).toBe(false);
  });

  it("verify never throws on malformed inputs", () => {
    expect(
      verifyBoxTrustStatusReport(REPORT, new Uint8Array(3), new Uint8Array(2)),
    ).toBe(false);
  });
});
