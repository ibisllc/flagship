import { describe, expect, it } from "vitest";
import {
  buildAutoUnlockLeaseV2,
  buildSealedSecretResponse,
  openAutoUnlockLeaseV2,
  openSealedSecretResponse,
  signAutoUnlockLeaseV2,
  signDeviceEndpointClaim,
  signLeaseRevocation,
  signRootEntitlement,
  signSecretRequest,
  verifyAutoUnlockLeaseV2,
  verifyDeviceEndpointClaim,
  verifyLeaseRevocation,
  verifyRootEntitlement,
  verifySecretRequest,
  type AutoUnlockLeaseV2,
  type DeviceEndpointClaim,
  type LeaseRevocation,
  type RootEntitlement,
  type SecretRequest,
} from "../src/index.js";
import { openSealedFromEd25519Recipient, sealForEd25519Recipient } from "../src/encryption.js";
import { deriveIRK, deriveSTK, deriveSWK } from "../src/keys.js";

const umk = { seed: new Uint8Array(32).fill(42) };
const otherUmk = { seed: new Uint8Array(32).fill(7) };

const irk = deriveIRK(umk);
const otherIrk = deriveIRK(otherUmk);
const stk = deriveSTK(deriveSWK(umk, "kitchen.john.flagship.services"));
const otherStk = deriveSTK(deriveSWK(otherUmk, "kitchen.john.flagship.services"));

function fill(n: number, v: number): Uint8Array {
  return new Uint8Array(n).fill(v);
}

// ──────────────────────────────────────────────────────────────────────
// 1. DeviceEndpointClaim
// ──────────────────────────────────────────────────────────────────────

describe("DeviceEndpointClaim (IRK-signed)", () => {
  const base: DeviceEndpointClaim = {
    username: "john",
    endpointLabel: "device",
    phoneIrkPub: irk.publicKey,
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_300_000,
    nonce: fill(32, 1),
  };

  it("round-trips sign/verify against the user IRK", () => {
    const sig = signDeviceEndpointClaim(base, irk);
    expect(verifyDeviceEndpointClaim(base, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a claim verified against a different IRK", () => {
    const sig = signDeviceEndpointClaim(base, irk);
    expect(verifyDeviceEndpointClaim(base, sig, otherIrk.publicKey)).toBe(false);
  });

  it("rejects tamper: username flipped", () => {
    const sig = signDeviceEndpointClaim(base, irk);
    expect(
      verifyDeviceEndpointClaim({ ...base, username: "mallory" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: endpointLabel flipped", () => {
    const sig = signDeviceEndpointClaim(base, irk);
    expect(
      verifyDeviceEndpointClaim({ ...base, endpointLabel: "evil" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: nonce flipped", () => {
    const sig = signDeviceEndpointClaim(base, irk);
    expect(
      verifyDeviceEndpointClaim({ ...base, nonce: fill(32, 2) }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: expiresAt extended", () => {
    const sig = signDeviceEndpointClaim(base, irk);
    expect(
      verifyDeviceEndpointClaim({ ...base, expiresAt: base.expiresAt + 1 }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects a username carrying the canonical separator at sign-time", () => {
    expect(() => signDeviceEndpointClaim({ ...base, username: "john|admin" }, irk)).toThrow(
      /separator/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. SecretRequest
// ──────────────────────────────────────────────────────────────────────

describe("SecretRequest (STK-signed)", () => {
  const base: SecretRequest = {
    serverDomain: "kitchen.john.flagship.services",
    stkPub: stk.publicKey,
    purpose: "unlock-key",
    nonce: fill(32, 3),
    issuedAt: 1_700_000_000_000,
  };

  it("round-trips sign/verify against the box STK", () => {
    const sig = signSecretRequest(base, stk);
    expect(verifySecretRequest(base, sig, stk.publicKey)).toBe(true);
  });

  it("rejects a request verified against a different STK", () => {
    const sig = signSecretRequest(base, stk);
    expect(verifySecretRequest(base, sig, otherStk.publicKey)).toBe(false);
  });

  it("rejects tamper: serverDomain flipped", () => {
    const sig = signSecretRequest(base, stk);
    expect(
      verifySecretRequest({ ...base, serverDomain: "evil.john.flagship.services" }, sig, stk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: purpose flipped (unlock-key → entitlement)", () => {
    const sig = signSecretRequest(base, stk);
    expect(verifySecretRequest({ ...base, purpose: "entitlement" }, sig, stk.publicKey)).toBe(
      false,
    );
  });

  it("rejects tamper: nonce flipped", () => {
    const sig = signSecretRequest(base, stk);
    expect(verifySecretRequest({ ...base, nonce: fill(32, 9) }, sig, stk.publicKey)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. SealedSecretResponse
// ──────────────────────────────────────────────────────────────────────

describe("SealedSecretResponse (sealed FOR the box STK)", () => {
  const request: SecretRequest = {
    serverDomain: "kitchen.john.flagship.services",
    stkPub: stk.publicKey,
    purpose: "unlock-key",
    nonce: fill(32, 4),
    issuedAt: 1_700_000_000_000,
  };
  const secret = fill(64, 0xab); // a LUKS key

  it("seal→open round-trips the secret for the requesting STK", () => {
    const resp = buildSealedSecretResponse(secret, request);
    const opened = openSealedSecretResponse(resp, request, stk.privateKey);
    expect(opened).toEqual(secret);
  });

  it("carries NO plaintext field — the secret only lives inside `sealed`", () => {
    const resp = buildSealedSecretResponse(secret, request);
    // The wire object's own fields never contain the secret bytes.
    const wireBytes = new TextEncoder().encode(JSON.stringify({ ...resp, sealed: undefined }));
    // (sealed excluded above; the rest must not embed the secret)
    for (const k of Object.keys(resp) as (keyof typeof resp)[]) {
      if (k === "sealed") continue;
      expect(resp[k]).not.toEqual(secret);
    }
    void wireBytes;
  });

  it("a DIFFERENT STK cannot open the response", () => {
    const resp = buildSealedSecretResponse(secret, request);
    expect(() => openSealedSecretResponse(resp, request, otherStk.privateKey)).toThrow();
  });

  it("a response for one nonce fails to open against a different-nonce request", () => {
    const resp = buildSealedSecretResponse(secret, request);
    const otherNonceReq: SecretRequest = { ...request, nonce: fill(32, 99) };
    expect(() => openSealedSecretResponse(resp, otherNonceReq, stk.privateKey)).toThrow(
      /different \(nonce, purpose\)/,
    );
  });

  it("a response for one purpose fails to open against a different-purpose request", () => {
    const resp = buildSealedSecretResponse(secret, request);
    const otherPurposeReq: SecretRequest = { ...request, purpose: "entitlement" };
    expect(() => openSealedSecretResponse(resp, otherPurposeReq, stk.privateKey)).toThrow(
      /different \(nonce, purpose\)/,
    );
  });

  it("the entitlement purpose round-trips too", () => {
    const entReq: SecretRequest = { ...request, purpose: "entitlement", nonce: fill(32, 5) };
    const resp = buildSealedSecretResponse(secret, entReq);
    expect(openSealedSecretResponse(resp, entReq, stk.privateKey)).toEqual(secret);
  });

  it("each seal of the same secret produces distinct ciphertext (fresh ephemeral key)", () => {
    const a = buildSealedSecretResponse(secret, request);
    const b = buildSealedSecretResponse(secret, request);
    expect(a.sealed).not.toEqual(b.sealed);
  });

  it("handles an empty secret", () => {
    const resp = buildSealedSecretResponse(new Uint8Array(0), request);
    expect(openSealedSecretResponse(resp, request, stk.privateKey)).toEqual(new Uint8Array(0));
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. AutoUnlockLease v2 + LeaseRevocation
// ──────────────────────────────────────────────────────────────────────

describe("AutoUnlockLeaseV2 (box-sealed, IRK-signed)", () => {
  const luksKey = fill(64, 0xcd);

  function makeLease(overrides: Partial<Parameters<typeof buildAutoUnlockLeaseV2>[0]> = {}) {
    return buildAutoUnlockLeaseV2({
      serverDomain: "kitchen.john.flagship.services",
      stkPub: stk.publicKey,
      leaseId: "lease-0123456789abcdef",
      luksKey,
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_604_800_000,
      ...overrides,
    });
  }

  it("the lease type carries only the sealed key — no plaintext field (I1)", () => {
    const lease = makeLease();
    expect("unlockKey" in lease).toBe(false);
    expect("luksKey" in lease).toBe(false);
    expect(lease.sealedKey).not.toEqual(luksKey);
  });

  it("round-trips IRK sign/verify", () => {
    const lease = makeLease();
    const sig = signAutoUnlockLeaseV2(lease, irk);
    expect(verifyAutoUnlockLeaseV2(lease, sig, irk.publicKey)).toBe(true);
  });

  it("the box (pinned STK) recovers the LUKS key", () => {
    const lease = makeLease();
    expect(openAutoUnlockLeaseV2(lease, stk.privateKey)).toEqual(luksKey);
  });

  it("a DIFFERENT STK cannot open the sealed key (I2 — pinned recipient)", () => {
    const lease = makeLease();
    expect(() => openAutoUnlockLeaseV2(lease, otherStk.privateKey)).toThrow();
  });

  it("rejects retarget: the signature pins stkPub so swapping it fails verify (I2)", () => {
    const lease = makeLease();
    const sig = signAutoUnlockLeaseV2(lease, irk);
    const retargeted: AutoUnlockLeaseV2 = { ...lease, stkPub: otherStk.publicKey };
    expect(verifyAutoUnlockLeaseV2(retargeted, sig, irk.publicKey)).toBe(false);
  });

  it("rejects tamper: serverDomain flipped", () => {
    const lease = makeLease();
    const sig = signAutoUnlockLeaseV2(lease, irk);
    expect(
      verifyAutoUnlockLeaseV2({ ...lease, serverDomain: "evil.john.flagship.services" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: leaseId flipped", () => {
    const lease = makeLease();
    const sig = signAutoUnlockLeaseV2(lease, irk);
    expect(
      verifyAutoUnlockLeaseV2({ ...lease, leaseId: "lease-ffffffffffffffff" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: expiresAt extended", () => {
    const lease = makeLease();
    const sig = signAutoUnlockLeaseV2(lease, irk);
    expect(
      verifyAutoUnlockLeaseV2({ ...lease, expiresAt: lease.expiresAt + 1 }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects a sealedKey swap (a substituted key invalidates the signature)", () => {
    const lease = makeLease();
    const sig = signAutoUnlockLeaseV2(lease, irk);
    const swapped: AutoUnlockLeaseV2 = {
      ...lease,
      sealedKey: sealForEd25519Recipient(fill(64, 0xee), stk.publicKey),
    };
    expect(verifyAutoUnlockLeaseV2(swapped, sig, irk.publicKey)).toBe(false);
  });

  it("maxUses present vs absent produce different canonical bytes (so they don't alias)", () => {
    const withCap = makeLease({ maxUses: 5 });
    const withoutCap = makeLease();
    const sigCap = signAutoUnlockLeaseV2(withCap, irk);
    // a signature over the capped lease must NOT verify the uncapped one.
    expect(verifyAutoUnlockLeaseV2({ ...withoutCap, sealedKey: withCap.sealedKey }, sigCap, irk.publicKey)).toBe(
      false,
    );
    // and its own round-trip holds
    expect(verifyAutoUnlockLeaseV2(withCap, sigCap, irk.publicKey)).toBe(true);
  });
});

describe("LeaseRevocation (IRK-signed)", () => {
  const base: LeaseRevocation = {
    serverDomain: "kitchen.john.flagship.services",
    leaseId: "lease-0123456789abcdef",
    issuedAt: 1_700_000_000_000,
  };

  it("round-trips IRK sign/verify", () => {
    const sig = signLeaseRevocation(base, irk);
    expect(verifyLeaseRevocation(base, sig, irk.publicKey)).toBe(true);
  });

  it("rejects verification against a different IRK", () => {
    const sig = signLeaseRevocation(base, irk);
    expect(verifyLeaseRevocation(base, sig, otherIrk.publicKey)).toBe(false);
  });

  it("rejects tamper: leaseId flipped (can't re-aim a revocation at another lease)", () => {
    const sig = signLeaseRevocation(base, irk);
    expect(
      verifyLeaseRevocation({ ...base, leaseId: "lease-ffffffffffffffff" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: serverDomain flipped", () => {
    const sig = signLeaseRevocation(base, irk);
    expect(
      verifyLeaseRevocation({ ...base, serverDomain: "other.john.flagship.services" }, sig, irk.publicKey),
    ).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. Phone-signed RootEntitlement (the handshake's entitlement variant)
// ──────────────────────────────────────────────────────────────────────

describe("RootEntitlement phone-signing (IRK signs the box STK)", () => {
  const cert: RootEntitlement = {
    username: "john",
    podPubKey: stk.publicKey,
    podCanonical: "kitchen.john.flagship.services",
    issuedAt: 1_700_000_000_000,
  };

  it("the phone IRK signs and the hub verifies", () => {
    const sig = signRootEntitlement(cert, irk);
    expect(verifyRootEntitlement(cert, sig, irk.publicKey)).toBe(true);
  });

  it("rejects a self-signed entitlement (STK signing itself) under the IRK", () => {
    // The interim self-sign path used the STK as signer; the phone-signed
    // path must NOT verify such a cert against the user's IRK.
    const selfSig = signRootEntitlement(cert, stk);
    expect(verifyRootEntitlement(cert, selfSig, irk.publicKey)).toBe(false);
  });

  it("rejects tamper: podCanonical flipped", () => {
    const sig = signRootEntitlement(cert, irk);
    expect(
      verifyRootEntitlement({ ...cert, podCanonical: "evil.john.flagship.services" }, sig, irk.publicKey),
    ).toBe(false);
  });

  it("rejects tamper: podPubKey (STK) swapped", () => {
    const sig = signRootEntitlement(cert, irk);
    expect(verifyRootEntitlement({ ...cert, podPubKey: otherStk.publicKey }, sig, irk.publicKey)).toBe(
      false,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// Ed25519-recipient seal helper (box opens a seal made for its STK)
// ──────────────────────────────────────────────────────────────────────

describe("openSealedFromEd25519Recipient", () => {
  it("opens a blob sealed for an Ed25519 pubkey using its Ed25519 seed", () => {
    const msg = fill(48, 0x5a);
    const sealed = sealForEd25519Recipient(msg, stk.publicKey);
    expect(openSealedFromEd25519Recipient(sealed, stk.privateKey)).toEqual(msg);
  });

  it("a different Ed25519 key cannot open it", () => {
    const sealed = sealForEd25519Recipient(fill(16, 1), stk.publicKey);
    expect(() => openSealedFromEd25519Recipient(sealed, otherStk.privateKey)).toThrow();
  });

  it("rejects a non-32-byte seed", () => {
    const sealed = sealForEd25519Recipient(fill(16, 1), stk.publicKey);
    expect(() => openSealedFromEd25519Recipient(sealed, new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Canonical-bytes wire-format pins.
//
// These freeze the exact signature bytes for fixed deterministic inputs
// (IRK/STK derived from a fixed UMK seed). A refactor that silently
// changes the canonical-bytes layout — field order, separators, tag —
// breaks these, which is the point: the wire is consumed by `.com`
// (esbuild), the daemon, and mirrored in iOS/Android, so the bytes must
// not drift.
// ──────────────────────────────────────────────────────────────────────

describe("canonical-bytes wire-format pins", () => {
  const pinIrk = deriveIRK({ seed: new Uint8Array(32).fill(1) });
  const pinStk = deriveSTK(deriveSWK({ seed: new Uint8Array(32).fill(1) }, "pin-server"));

  it("DeviceEndpointClaim signature is stable", () => {
    const c: DeviceEndpointClaim = {
      username: "alice",
      endpointLabel: "device",
      phoneIrkPub: pinIrk.publicKey,
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_000_120_000,
      nonce: fill(32, 0x11),
    };
    const sig = signDeviceEndpointClaim(c, pinIrk);
    expect(toHex(sig)).toMatchInlineSnapshot(`"3c03058365d1dfbb9f0226b8eef8496fe88547260c600a976d79c588fee260271fa49f4b724c180c5bf0f269bca66523fe24d61ea233a66ff0d31dccf12e5101"`);
  });

  it("SecretRequest signature is stable", () => {
    const r: SecretRequest = {
      serverDomain: "pin-server",
      stkPub: pinStk.publicKey,
      purpose: "unlock-key",
      nonce: fill(32, 0x22),
      issuedAt: 1_700_000_000_000,
    };
    const sig = signSecretRequest(r, pinStk);
    expect(toHex(sig)).toMatchInlineSnapshot(`"71e18724e163142ad4afad0045cff395135b299dfe26df9d71979b585388d206cae07d098beb330954abdec43b1c547c565b90580e1c8f3fd9939fe798127a03"`);
  });

  it("AutoUnlockLeaseV2 signature is stable (deterministic sealedKey input)", () => {
    // The sealedKey is non-deterministic (fresh ephemeral key per seal),
    // so we pin against a fixed sealedKey blob rather than re-sealing.
    const lease: AutoUnlockLeaseV2 = {
      serverDomain: "pin-server",
      stkPub: pinStk.publicKey,
      leaseId: "lease-pin-0000000000",
      sealedKey: fill(108, 0x33),
      issuedAt: 1_700_000_000_000,
      expiresAt: 1_700_604_800_000,
      maxUses: 3,
    };
    const sig = signAutoUnlockLeaseV2(lease, pinIrk);
    expect(toHex(sig)).toMatchInlineSnapshot(`"1b94ad85a506fee68b402b09dac7e56c8f2e3230478392ebbb5ee63e0971992e10e68d81a59e04a17e14252d7cbab1b987df9145e35062f4e8a9359b21924a07"`);
  });

  it("LeaseRevocation signature is stable", () => {
    const r: LeaseRevocation = {
      serverDomain: "pin-server",
      leaseId: "lease-pin-0000000000",
      issuedAt: 1_700_000_000_000,
    };
    const sig = signLeaseRevocation(r, pinIrk);
    expect(toHex(sig)).toMatchInlineSnapshot(`"47e301a44d56af5e43853c940b8fc054445a807ea3b2247f522dbe61e49cd84c7b7d12e0a929fa8f64aa143ca868c3d9038a1b33e314bc984ab7bd9f1f40a701"`);
  });
});

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
