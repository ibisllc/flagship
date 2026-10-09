/**
 * STK-signed LAN hint — canonical bytes, verification, and the LAN-address
 * filter, with a PINNED cross-platform vector (Android core/LanHint.kt and
 * iOS FlagshipCore/LanHint.swift check these exact constants).
 *
 * Pinned vector (same key as the daemon-status vector):
 *   UMK seed = 07 × 32, serverId = "abc5.harry1.flagship.services"
 *   STK pub  = 0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47
 */
import { describe, expect, it } from "vitest";
import {
  canonicalLanHint,
  checkLanHint,
  deriveSTK,
  deriveSWK,
  isLanAddress,
  signLanHint,
  type LanHint,
} from "../src/index.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

const SERVER = "abc5.harry1.flagship.services";
const STK = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(7) }, SERVER));
const OTHER_STK = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(8) }, SERVER));
const CERT = "ab".repeat(32);
const ISSUED = 1791500000000;

const HINT: LanHint = {
  serverDomain: SERVER,
  certSha256: CERT,
  endpoints: [
    { address: "fd12:3456::7", port: 443 },
    { address: "192.168.1.20", port: 443 },
  ],
  issuedAt: ISSUED,
  expiresAt: ISSUED + 3_600_000,
};
const CANONICAL =
  "flagship/lan-hint/v1|abc5.harry1.flagship.services|" +
  "abababababababababababababababababababababababababababababababab|" +
  "192.168.1.20:443,[fd12:3456::7]:443|1791500000000|1791503600000";
const SIG_HEX =
  "9fc9b39958189204e86823a832b42257f3a2773d671a8292be0826c3a45e3cdb" +
  "b6c3f212dd159b73f86d5b9ad5815e8e024b3f9042c127133dfb30fdeb73e800";

const expectOk = { serverDomain: SERVER, certSha256: CERT, now: ISSUED + 1000 };

describe("LAN hint — pinned vector", () => {
  it("STK pub matches the shared vector key", () => {
    expect(hex(STK.publicKey)).toBe(
      "0a1eaaad1e4f57435b95e2339654618e121b2b84d3ac595c64f73520fde90d47",
    );
  });
  it("canonical bytes sort endpoints and bracket IPv6", () => {
    expect(new TextDecoder().decode(canonicalLanHint(HINT))).toBe(CANONICAL);
  });
  it("signature is deterministic and verifies", () => {
    expect(hex(signLanHint(HINT, STK))).toBe(SIG_HEX);
    expect(checkLanHint(HINT, unhex(SIG_HEX), STK.publicKey, expectOk)).toEqual({ ok: true });
  });
});

describe("LAN hint — rejection", () => {
  const sig = unhex(SIG_HEX);
  const reason = (h: LanHint, s = sig, pub = STK.publicKey, e = expectOk) => {
    const r = checkLanHint(h, s, pub, e);
    return r.ok ? "ok" : r.reason;
  };

  it("a tampered endpoint breaks the signature", () => {
    const h = { ...HINT, endpoints: [{ address: "192.168.1.99", port: 443 }, HINT.endpoints[0]!] };
    expect(reason(h)).toBe("bad-signature");
  });
  it("a hint signed by another box's STK is refused", () => {
    expect(reason(HINT, sig, OTHER_STK.publicKey)).toBe("bad-signature");
  });
  it("expired, not-yet-valid and over-long hints are refused", () => {
    expect(reason(HINT, sig, STK.publicKey, { ...expectOk, now: HINT.expiresAt })).toBe("expired");
    expect(reason(HINT, sig, STK.publicKey, { ...expectOk, now: ISSUED - 10 * 60_000 })).toBe(
      "not-yet-valid",
    );
    const long = { ...HINT, expiresAt: ISSUED + 25 * 3_600_000 };
    expect(reason(long, signLanHint(long, STK))).toBe("ttl-too-long");
  });
  it("a hint for another box, or another cert, is refused", () => {
    expect(reason(HINT, sig, STK.publicKey, { ...expectOk, serverDomain: "x.harry1.flagship.services" })).toBe(
      "wrong-server",
    );
    expect(reason(HINT, sig, STK.publicKey, { ...expectOk, certSha256: "cd".repeat(32) })).toBe(
      "cert-mismatch",
    );
  });
  it("a correctly signed hint naming a public address is still refused", () => {
    const h = { ...HINT, endpoints: [{ address: "8.8.8.8", port: 443 }] };
    expect(reason(h, signLanHint(h, STK))).toBe("non-lan-endpoint");
  });
  it("bad ports and empty endpoint lists are refused", () => {
    const p = { ...HINT, endpoints: [{ address: "10.0.0.2", port: 0 }] };
    expect(reason(p, signLanHint(p, STK))).toBe("bad-port");
    const none = { ...HINT, endpoints: [] };
    expect(reason(none, signLanHint(none, STK))).toBe("bad-endpoint-count");
  });
});

describe("isLanAddress", () => {
  const cases: Array<[string, boolean]> = [
    ["10.0.0.5", true],
    ["172.16.0.1", true],
    ["172.31.255.254", true],
    ["192.168.0.10", true],
    ["fd00::1", true],
    ["fc12:3456::1", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["100.64.0.1", false],
    ["127.0.0.1", false],
    ["169.254.10.1", false],
    ["0.0.0.0", false],
    ["255.255.255.255", false],
    ["224.0.0.1", false],
    ["256.1.1.1", false],
    ["::1", false],
    ["fe80::1", false],
    ["fc::1", false],
    ["2001:db8::1", false],
    ["::ffff:192.168.1.1", false],
    ["ff02::1", false],
    ["", false],
    ["localhost", false],
  ];
  for (const [addr, want] of cases) {
    it(`${addr || "(empty)"} → ${want}`, () => expect(isLanAddress(addr)).toBe(want));
  }
});
