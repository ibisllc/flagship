/**
 * Dev→prod promotion gate (feat/dev-prod-dataspace, spec §5–6).
 *
 * The gate is the invariant's enforcement point: a prod data principal is
 * created ONLY when both the owner/admin promote order AND a valid, unexpired,
 * digest-matching review attestation verify. These tests pin every refusal
 * path (fail-closed) and the single accept path, plus the state machine.
 */
import { describe, expect, it } from "vitest";
import {
  ed,
  signServicePromote,
  signCodeSecurityAttestation,
  type ServicePromoteOrder,
  type CodeSecurityAttestation,
  type Keypair,
} from "@flagship/protocol";
import {
  evaluatePromoteGate,
  canTransition,
  type ServiceSpaceState,
} from "../src/buildmodes/promoteGate.js";

function makeKey(fill: number): Keypair {
  const seed = new Uint8Array(32).fill(fill);
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

const ownerIrk = makeKey(0x11);
const reviewKey = makeKey(0x22);
const attacker = makeKey(0x33);
const DIGEST = "ab".repeat(32);
const NOW = 1_700_000_500_000;

function order(over: Partial<ServicePromoteOrder> = {}): ServicePromoteOrder {
  return {
    serverId: "home.alice.flagship.services",
    creator: "alice",
    slug: "notes",
    artifactDigest: DIGEST,
    issuedAt: 1_700_000_000_000,
    ...over,
  };
}
function attestation(over: Partial<CodeSecurityAttestation> = {}): CodeSecurityAttestation {
  return {
    serverId: "home.alice.flagship.services",
    creator: "alice",
    slug: "notes",
    artifactDigest: DIGEST,
    verdict: "pass",
    scanners: "trivy@0.50.0,flagship-checks@3",
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_900_000,
    ...over,
  };
}

function fullInput(overrides: {
  order?: ServicePromoteOrder;
  att?: CodeSecurityAttestation;
  orderSigner?: Keypair;
  attSigner?: Keypair;
  reviewPub?: Uint8Array | undefined;
} = {}) {
  const o = overrides.order ?? order();
  const a = overrides.att ?? attestation();
  return {
    order: o,
    orderSig: signServicePromote(o, overrides.orderSigner ?? ownerIrk),
    attestation: a,
    attestationSig: signCodeSecurityAttestation(a, overrides.attSigner ?? reviewKey),
    ownerIrkPub: ownerIrk.publicKey,
    username: "alice",
    reviewAuthorityPub: "reviewPub" in overrides ? overrides.reviewPub : reviewKey.publicKey,
    now: NOW,
  };
}

describe("evaluatePromoteGate — the single accept path", () => {
  it("authorized order + valid pass attestation for the same digest ⇒ ok", () => {
    expect(evaluatePromoteGate(fullInput()).ok).toBe(true);
  });
});

describe("evaluatePromoteGate — owner/admin authorization refusals", () => {
  it("refuses an order signed by a non-owner", () => {
    const r = evaluatePromoteGate(fullInput({ orderSigner: attacker }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not authorized/);
  });
});

describe("evaluatePromoteGate — review-gate refusals (fail-closed)", () => {
  it("refuses when no review authority is pinned", () => {
    const r = evaluatePromoteGate(fullInput({ reviewPub: undefined }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no pinned review authority/);
  });

  it("refuses when no attestation is presented", () => {
    const input = fullInput();
    const r = evaluatePromoteGate({ ...input, attestation: undefined, attestationSig: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no security attestation/);
  });

  it("refuses an attestation for a DIFFERENT artifact digest", () => {
    const r = evaluatePromoteGate(fullInput({ att: attestation({ artifactDigest: "cd".repeat(32) }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match/);
  });

  it("refuses a fail verdict", () => {
    const r = evaluatePromoteGate(fullInput({ att: attestation({ verdict: "fail" }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verdict is fail/);
  });

  it("refuses an expired attestation", () => {
    const r = evaluatePromoteGate(fullInput({ att: attestation({ expiresAt: NOW - 1 }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });

  it("refuses a not-yet-valid attestation", () => {
    const r = evaluatePromoteGate(fullInput({ att: attestation({ issuedAt: NOW + 1000, expiresAt: NOW + 2000 }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not yet valid/);
  });

  it("refuses an attestation signed by a non-review key", () => {
    const r = evaluatePromoteGate(fullInput({ attSigner: attacker }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/signature failed/);
  });

  it("refuses a mismatched (service) attestation even if correctly signed", () => {
    const r = evaluatePromoteGate(fullInput({ att: attestation({ slug: "other" }) }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not match/);
  });
});

describe("service space state machine", () => {
  const legal: Array<[ServiceSpaceState, ServiceSpaceState]> = [
    ["authoring", "dev-deployed"],
    ["dev-deployed", "promotion-requested"],
    ["promotion-requested", "prod-deployed"],
    ["promotion-requested", "dev-deployed"],
    ["prod-deployed", "dev-deployed"],
  ];
  it.each(legal)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("forbids skipping straight to prod-deployed from authoring or dev-deployed", () => {
    expect(canTransition("authoring", "prod-deployed")).toBe(false);
    expect(canTransition("dev-deployed", "prod-deployed")).toBe(false);
  });
});
