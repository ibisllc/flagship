/**
 * STK-signed daemon-status report — canonical bytes + verify, with a PINNED
 * cross-platform vector. iOS (FlagshipCore) and Android (core) mirror the
 * verifier against these exact constants; the daemon heartbeat and the
 * control-plane verifier both import THIS implementation, so the vector is
 * the single byte-level contract for cert-fingerprint pinning.
 *
 * Pinned vector (regenerate only on a deliberate v2 of the format):
 *   UMK seed   = 07 × 32
 *   serverId   = "abc5.harry1.flagship.services"
 *   STK        = deriveSTK(deriveSWK(UMK, serverId))   (the phone-side path)
 *   STK pub    = 0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47
 */

import { describe, expect, it } from "vitest";
import {
  canonicalDaemonStatusReport,
  signDaemonStatusReport,
  verifyDaemonStatusReport,
  deriveSTK,
  deriveSWK,
  generateUMK,
  type DaemonStatusReport,
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

const REPORT: DaemonStatusReport = {
  serverDomain: "abc5.harry1.flagship.services",
  certSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  certValidUntil: 1_800_000_000_000,
  certIssuer: "C=US, O=Let's Encrypt, CN=YR1",
  // Deliberately unsorted — canonical bytes sort.
  appsServed: [
    "wiki.abc5.harry1.flagship.services",
    "abc5.harry1.flagship.services",
  ],
  nonce: "00112233445566778899aabbccddeeff",
  issuedAt: 1_700_000_000_000,
};

const CANONICAL =
  "flagship/daemon-status/v1|abc5.harry1.flagship.services|" +
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08|" +
  "1800000000000|C=US, O=Let's Encrypt, CN=YR1|" +
  "abc5.harry1.flagship.services,wiki.abc5.harry1.flagship.services|" +
  "00112233445566778899aabbccddeeff|1700000000000";

const SIG_HEX =
  "367b6e23c4f6bcc5f7ea0d082c3f411a439642af775be6c12517f9563f7228706" +
  "4d207b9b3af42a92b0a0f8b2ea7d35b10616bc9d73d95d960b12ba1c72c6005";

const NULL_REPORT: DaemonStatusReport = {
  ...REPORT,
  certSha256: null,
  certValidUntil: null,
  certIssuer: null,
  appsServed: [],
};

const NULL_CANONICAL =
  "flagship/daemon-status/v1|abc5.harry1.flagship.services|||||" +
  "00112233445566778899aabbccddeeff|1700000000000";

const NULL_SIG_HEX =
  "890c1bcf92399d2560b6a326844a5b66cd934ee724d02722f7e141e01ba555172" +
  "12934a9bde72128aaf21f496a06bec2aed802fb84a5cc67d3e2536e6b782308";

function stk() {
  const umk = generateUMK(() => hexToBytes(UMK_SEED_HEX));
  return deriveSTK(deriveSWK(umk, REPORT.serverDomain));
}

describe("daemon-status report (pinned cross-platform vector)", () => {
  it("the phone-side STK derivation reproduces the pinned pubkey", () => {
    expect(bytesToHex(stk().publicKey)).toBe(STK_PUB_HEX);
  });

  it("canonical bytes match the pinned string (apps sorted)", () => {
    expect(new TextDecoder().decode(canonicalDaemonStatusReport(REPORT))).toBe(
      CANONICAL,
    );
  });

  it("null cert fields + empty apps encode as empty segments", () => {
    expect(
      new TextDecoder().decode(canonicalDaemonStatusReport(NULL_REPORT)),
    ).toBe(NULL_CANONICAL);
  });

  it("signing is deterministic and matches the pinned signature", () => {
    expect(bytesToHex(signDaemonStatusReport(REPORT, stk()))).toBe(SIG_HEX);
    expect(bytesToHex(signDaemonStatusReport(NULL_REPORT, stk()))).toBe(
      NULL_SIG_HEX,
    );
  });

  it("the pinned signature verifies under the pinned STK pubkey", () => {
    expect(
      verifyDaemonStatusReport(
        REPORT,
        hexToBytes(SIG_HEX),
        hexToBytes(STK_PUB_HEX),
      ),
    ).toBe(true);
    expect(
      verifyDaemonStatusReport(
        NULL_REPORT,
        hexToBytes(NULL_SIG_HEX),
        hexToBytes(STK_PUB_HEX),
      ),
    ).toBe(true);
  });

  it("rejects a mutation of EACH signed field", () => {
    const sig = hexToBytes(SIG_HEX);
    const pub = hexToBytes(STK_PUB_HEX);
    const mutations: Array<Partial<DaemonStatusReport>> = [
      { serverDomain: "evil.harry1.flagship.services" },
      { certSha256: "ab".repeat(32) },
      { certSha256: null },
      { certValidUntil: 1_800_000_000_001 },
      { certValidUntil: null },
      { certIssuer: "C=US, O=Evil CA, CN=X1" },
      { certIssuer: null },
      { appsServed: ["abc5.harry1.flagship.services"] },
      { appsServed: [] },
      { nonce: "ff112233445566778899aabbccddeeff" },
      { issuedAt: 1_700_000_000_001 },
    ];
    for (const m of mutations) {
      expect(verifyDaemonStatusReport({ ...REPORT, ...m }, sig, pub)).toBe(
        false,
      );
    }
  });

  it("rejects a signature from a different key", () => {
    const otherUmk = generateUMK(() => new Uint8Array(32).fill(8));
    const other = deriveSTK(deriveSWK(otherUmk, REPORT.serverDomain));
    const sig = signDaemonStatusReport(REPORT, other);
    expect(
      verifyDaemonStatusReport(REPORT, sig, hexToBytes(STK_PUB_HEX)),
    ).toBe(false);
  });

  it("apps order does not affect the signature (canonical sorting)", () => {
    const reordered: DaemonStatusReport = {
      ...REPORT,
      appsServed: [...REPORT.appsServed].reverse(),
    };
    expect(
      verifyDaemonStatusReport(
        reordered,
        hexToBytes(SIG_HEX),
        hexToBytes(STK_PUB_HEX),
      ),
    ).toBe(true);
  });

  it("verify never throws on malformed inputs", () => {
    expect(
      verifyDaemonStatusReport(REPORT, new Uint8Array(3), new Uint8Array(2)),
    ).toBe(false);
  });
});
