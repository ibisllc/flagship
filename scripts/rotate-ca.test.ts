/**
 * Pure-logic tests for scripts/rotate-ca.mjs. The interactive shell is
 * not exercised; the security-critical parts (canonical bytes matching
 * the upstream protocol, Ed25519 keygen coherence, the safe-ordering
 * "is the new lease actually live" gate, and farthest-future serving
 * selection) are.
 */
import { describe, expect, it } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { createPrivateKey, sign as nodeSign } from "node:crypto";
import {
  parseArgs,
  b64urlToHex,
  hexToB64url,
  genEd25519,
  caEndorsementCanonicalBytes,
  verifyEd25519,
  readAuthorizedCaSigners,
  readCaEndorsements,
  isLeaseLive,
  selectFarthestFutureValid,
  selectLiveLeaseForPubkey,
} from "./rotate-ca.mjs";

/** Sign a Buffer with an Ed25519 seed (hex) → hex signature. */
function signWithSeed(seedHex: string, pubHex: string, msg: Buffer): string {
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: hexToB64url(seedHex), x: hexToB64url(pubHex) },
    format: "jwk",
  });
  return nodeSign(null, msg, key).toString("hex");
}

function mkLease(
  signer: { seedHex: string; pubHex: string },
  o: Partial<{
    endorsementId: string;
    track: string;
    caPubkey: string;
    scope: string;
    notBefore: string;
    notAfter: string;
    issuedAt: string;
  }> = {},
) {
  const base = {
    kind: "CaEndorsement",
    version: 1,
    endorsementId: o.endorsementId ?? "e1",
    track: o.track ?? "ca",
    caPubkey: o.caPubkey ?? "aa".repeat(32),
    scope: o.scope ?? "flagship/directory-attestation",
    notBefore: o.notBefore ?? "2026-01-01T00:00:00.000Z",
    notAfter: o.notAfter ?? "2026-01-08T00:00:00.000Z",
    issuedAt: o.issuedAt ?? "2026-01-01T00:00:00.000Z",
    signedBy: signer.pubHex,
  };
  const sig = signWithSeed(signer.seedHex, signer.pubHex, caEndorsementCanonicalBytes(base));
  return { ...base, signatures: [{ pubkey: signer.pubHex, sig }] };
}

describe("parseArgs", () => {
  it("defaults command to 'rotate' and parses flags", () => {
    expect(parseArgs([])).toMatchObject({ command: "rotate", flags: {} });
    const a = parseArgs(["status", "--com-url", "https://x", "--yes", "--n=1"]);
    expect(a.command).toBe("status");
    expect(a.flags).toMatchObject({ "com-url": "https://x", yes: true, n: "1" });
  });
});

describe("base64url <-> hex", () => {
  it("round-trips", () => {
    const h = "ab".repeat(32);
    expect(b64urlToHex(hexToB64url(h))).toBe(h);
  });
});

describe("genEd25519", () => {
  it("produces 64-hex seed+pub that form a coherent signing pair", () => {
    const { seedHex, pubHex } = genEd25519();
    expect(seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(pubHex).toMatch(/^[0-9a-f]{64}$/);
    const msg = Buffer.from("hello", "utf8");
    const sig = signWithSeed(seedHex, pubHex, msg);
    expect(verifyEd25519(pubHex, msg, sig)).toBe(true);
    // wrong key must not verify
    const other = genEd25519();
    expect(verifyEd25519(other.pubHex, msg, sig)).toBe(false);
  });
});

describe("caEndorsementCanonicalBytes", () => {
  it("byte-matches the upstream @ibisllc/maintainers order (spec §3.7)", () => {
    const bytes = caEndorsementCanonicalBytes({
      endorsementId: "eid",
      track: "ca",
      caPubkey: "aa".repeat(32),
      scope: "flagship/directory-attestation",
      notBefore: "2026-01-01T00:00:00.000Z",
      notAfter: "2026-01-08T00:00:00.000Z",
      issuedAt: "2026-01-01T00:00:00.000Z",
      signedBy: "bb".repeat(32),
    });
    expect(bytes.toString("utf8")).toBe(
      "maintainers/ca-endorsement/v1|eid|ca|" +
        "aa".repeat(32) +
        "|flagship/directory-attestation|2026-01-01T00:00:00.000Z|" +
        "2026-01-08T00:00:00.000Z|2026-01-01T00:00:00.000Z|" +
        "bb".repeat(32),
    );
  });
  it("rejects a separator-injecting field", () => {
    expect(() =>
      caEndorsementCanonicalBytes({
        endorsementId: "e|vil",
        track: "ca",
        caPubkey: "aa".repeat(32),
        scope: "s",
        notBefore: "x",
        notAfter: "y",
        issuedAt: "z",
        signedBy: "bb".repeat(32),
      }),
    ).toThrow();
  });
});

describe("isLeaseLive / selectors — the safe-ordering gate", () => {
  const maint = genEd25519();
  const rogue = genEd25519();
  const signers = new Set([maint.pubHex]);
  const within = Date.parse("2026-01-04T00:00:00.000Z");

  it("accepts a well-formed in-window lease signed by an authorized signer", () => {
    expect(isLeaseLive(mkLease(maint), signers, within)).toBe(true);
  });
  it("rejects before notBefore and at/after notAfter", () => {
    const e = mkLease(maint);
    expect(isLeaseLive(e, signers, Date.parse("2025-12-31T00:00:00.000Z"))).toBe(false);
    expect(isLeaseLive(e, signers, Date.parse("2026-01-08T00:00:00.000Z"))).toBe(false);
  });
  it("rejects a signer not authorized by the ca-track mandates", () => {
    expect(isLeaseLive(mkLease(rogue), signers, within)).toBe(false);
  });
  it("rejects a tampered field (signature no longer matches canonical bytes)", () => {
    const e = mkLease(maint);
    expect(isLeaseLive({ ...e, caPubkey: "cc".repeat(32) }, signers, within)).toBe(false);
  });
  it("selectLiveLeaseForPubkey only matches the exact new key", () => {
    const forA = mkLease(maint, { caPubkey: "aa".repeat(32) });
    expect(selectLiveLeaseForPubkey([forA], signers, within, "aa".repeat(32))).toBeTruthy();
    expect(selectLiveLeaseForPubkey([forA], signers, within, "dd".repeat(32))).toBeNull();
  });
  it("selectFarthestFutureValid serves the live lease with the max notAfter", () => {
    const near = mkLease(maint, { endorsementId: "near", notAfter: "2026-01-08T00:00:00.000Z" });
    const far = mkLease(maint, { endorsementId: "far", notAfter: "2026-01-20T00:00:00.000Z" });
    const picked = selectFarthestFutureValid([near, far], signers, within);
    expect(picked?.endorsementId).toBe("far");
  });
});

describe("fs readers", () => {
  it("reads ca-track signers and ca-endorsements from a .maintainers tree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rca-"));
    const maint = genEd25519();
    fs.mkdirSync(path.join(dir, "tracks", "ca", "mandates"), { recursive: true });
    fs.mkdirSync(path.join(dir, "ca-endorsements"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "tracks", "ca", "mandates", "g.json"),
      JSON.stringify({ kind: "Mandate", track: "ca", holder: maint.pubHex, successors: [] }),
    );
    fs.writeFileSync(
      path.join(dir, "ca-endorsements", "l1.json"),
      JSON.stringify(mkLease(maint, { endorsementId: "l1" })),
    );
    const signers = readAuthorizedCaSigners(dir);
    expect(signers.has(maint.pubHex)).toBe(true);
    const es = readCaEndorsements(dir);
    expect(es).toHaveLength(1);
    expect(
      selectLiveLeaseForPubkey(es, signers, Date.parse("2026-01-04T00:00:00.000Z"), "aa".repeat(32)),
    ).toBeTruthy();
  });
});
