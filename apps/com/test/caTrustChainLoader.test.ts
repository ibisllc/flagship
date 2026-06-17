// (e) Worker-side full-verification proof. The constraint is explicit:
// the Worker must run the COMPLETE @ibisllc/maintainers verifier
// (verifyMandateChainFromPin → verifyCaEndorsements) over the shipped
// ca-track mandate chain + endorsement bundle — NOT a weakened
// "trust a pre-verified endorsement / only check TTL+sig" shortcut.
//
// We assert this two ways:
//   1. The loader, over the REAL committed chain + (empty) bundle,
//      returns [] — i.e. it fail-closes through the real verifier
//      with no live lease, exactly as a real forward-verify must.
//   2. The loader's exact two-call composition, exercised over
//      FABRICATED data, behaves as the real verifier: a valid
//      endorsement under the pin-anchored authority yields the key;
//      a WRONG pin yields [] (a shortcut that skipped
//      verifyMandateChainFromPin could not tell these apart).

import { describe, expect, it } from "vitest";
import {
  authorizedCaKeys,
  generateKeypair,
  mandatePinHash,
  signCaEndorsement,
  signMandate,
  verifyMandateChainFromPin,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import { MAINTAINER_PINNED_MANDATE_HASH } from "@flagship/protocol";
import {
  workerCaTrustChain,
  caEnforceFromEnv,
  caTrustChainPublicMaterial,
  activeCaLeaseNotAfterMs,
} from "../src/caTrustChainLoader.js";

const NOW = Date.parse("2026-06-01T00:00:00.000Z");

describe("workerCaTrustChain — real verifier over the committed assets", () => {
  // The committed bundle.json now contains the first live CaEndorsement
  // (Operation 1b ceremony 2026-05-19 in apps/com). At a NOW within the
  // lease window the REAL forward-verify resolves to the endorsed
  // hot-CA pubkey — a 64-hex key, not [] or a stub literal.
  it("real committed chain at NOW WITHIN the live lease ⇒ a 64-hex endorsed pubkey", () => {
    const liveNow = Date.parse("2026-05-25T00:00:00.000Z");
    const chain = workerCaTrustChain();
    const keys = chain.authorizedCaKeys(liveNow);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  // At a NOW past every committed lease's notAfter the real verifier
  // MUST return []. A stub returning a hardcoded key, or one that
  // skipped the per-request lease check, would not.
  it("real committed chain at NOW past every lease ⇒ [] (fail-closed via real verifier)", () => {
    const farFuture = Date.parse("2099-01-01T00:00:00.000Z");
    const chain = workerCaTrustChain();
    expect(chain.authorizedCaKeys(farFuture)).toEqual([]);
  });

  // Prove the loader is anchored at the SAME baked pin every other
  // surface bakes (so it cannot silently diverge).
  it("uses the baked MAINTAINER_PINNED_MANDATE_HASH (non-empty, populated)", () => {
    expect(MAINTAINER_PINNED_MANDATE_HASH).toMatch(/^[0-9a-f]{64}$/);
    // An explicit empty pin ⇒ still [] (the #30 empty-⇒-fail invariant
    // is reachable through the loader's pin parameter too).
    expect(workerCaTrustChain("").authorizedCaKeys(NOW)).toEqual([]);
  });

  // The loader = verifyMandateChainFromPin(pin, mandates) THEN
  // authorizedCaKeys(endorsements, chain, now). Reproduce that exact
  // composition over fabricated data and show it is the real verifier:
  // correct pin ⇒ the endorsed key; wrong pin ⇒ [].
  it("the loader's exact composition is the real forward-verify (correct pin ⇒ key; wrong pin ⇒ [])", () => {
    const authority = generateKeypair();
    const hotCa = generateKeypair();
    const unsignedRoot: Omit<Mandate, "signatures"> = {
      kind: "Mandate",
      version: 1,
      mandateId: "11111111-1111-4111-8111-111111111111",
      track: "ca",
      holder: authority.pubKey,
      issuedAt: "2026-05-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      successors: [authority.pubKey],
      approvalRule: { kind: "threshold", threshold: 1 },
      minSuccessors: 1,
      maxDurationSeconds: 315360000,
      defaultDurationSeconds: 8640000,
      project: { name: "test" },
      signedBy: authority.pubKey,
    };
    const root: Mandate = signMandate(unsignedRoot, [{ privKey: authority.privKey }]);
    const realPin = mandatePinHash(unsignedRoot);

    const endorsement: CaEndorsement = signCaEndorsement(
      {
        kind: "CaEndorsement",
        version: 1,
        endorsementId: "22222222-2222-4222-8222-222222222222",
        track: "ca",
        caPubkey: hotCa.pubKey,
        scope: "flagship/directory-attestation",
        notBefore: "2026-05-20T00:00:00.000Z",
        notAfter: "2026-06-10T00:00:00.000Z",
        issuedAt: "2026-05-20T00:00:00.000Z",
        signedBy: authority.pubKey,
      },
      [{ privKey: authority.privKey }],
    );

    // Correct pin: the REAL verifier anchors the root and the lease
    // resolves to the hot key.
    const goodChain = verifyMandateChainFromPin(realPin, [root]);
    expect(authorizedCaKeys([endorsement], goodChain, new Date(NOW))).toEqual([hotCa.pubKey]);

    // WRONG pin: verifyMandateChainFromPin yields no root ⇒ no
    // authority at now ⇒ []. A shortcut that only checked the
    // endorsement's TTL+signature (skipping the mandate forward-verify)
    // would WRONGLY still return the key here — this is the
    // discriminating assertion.
    const wrongChain = verifyMandateChainFromPin("00".repeat(32), [root]);
    expect(authorizedCaKeys([endorsement], wrongChain, new Date(NOW))).toEqual([]);
  });
});

describe("caTrustChainPublicMaterial — what /api/maintainer-blessing serves", () => {
  // The material a client re-verifies against its OWN baked pin. It must
  // be the SAME committed assets the Worker's own gate consults, anchored
  // at the SAME pin — so a client's verdict can never diverge from .com's.
  it("exposes the baked pin + the real committed ca-track chain + endorsements", () => {
    const mat = caTrustChainPublicMaterial();
    expect(mat.pinnedMandateHash).toBe(MAINTAINER_PINNED_MANDATE_HASH);
    expect(mat.mandates.length).toBeGreaterThanOrEqual(1);
    expect((mat.mandates[0] as Mandate).track).toBe("ca");
    expect(Array.isArray(mat.caEndorsements)).toBe(true);
  });

  // A client running the REAL verifier over exactly this material reaches
  // the SAME authorized-key set the loader's own CaTrustChain returns —
  // proving the endpoint hands clients a sufficient, faithful basis.
  it("client-side verify over the served material == the loader's own verdict", () => {
    const mat = caTrustChainPublicMaterial();
    const liveNow = Date.parse("2026-05-25T00:00:00.000Z");
    const clientChain = verifyMandateChainFromPin(
      mat.pinnedMandateHash,
      mat.mandates as Mandate[],
    );
    const clientKeys = authorizedCaKeys(
      mat.caEndorsements as CaEndorsement[],
      clientChain,
      new Date(liveNow),
    );
    expect(clientKeys).toEqual(workerCaTrustChain().authorizedCaKeys(liveNow));
  });
});

describe("activeCaLeaseNotAfterMs — never reports an expired sibling lease", () => {
  // Regression: after a backdated renewal, the bundle holds TWO leases for
  // the SAME caPubkey — the lapsed original + the live backfill. The key is
  // authorized (via the live one), so a naive filter that only checks
  // "is the key authorized?" leaks the EXPIRED lease's past notAfter and the
  // status/cron falsely reports "expired" while authority is actually live.
  it("every reported expiry is in the future, and authority is live now", () => {
    const now = Date.parse("2026-06-17T00:00:00.000Z"); // within the backdated lease
    const out = activeCaLeaseNotAfterMs(now);
    expect(out.length).toBeGreaterThan(0); // authority IS live at now
    for (const ms of out) expect(ms).toBeGreaterThan(now); // no expired lease leaks
  });
});

describe("caEnforceFromEnv — the single deploy-safe switch", () => {
  it("unset / non-'true' ⇒ OBSERVE (false); literal 'true' ⇒ ENFORCE", () => {
    expect(caEnforceFromEnv({})).toBe(false);
    expect(caEnforceFromEnv({ CA_ENDORSEMENT_ENFORCE: "" })).toBe(false);
    expect(caEnforceFromEnv({ CA_ENDORSEMENT_ENFORCE: "1" })).toBe(false);
    expect(caEnforceFromEnv({ CA_ENDORSEMENT_ENFORCE: "TRUE" })).toBe(false);
    expect(caEnforceFromEnv({ CA_ENDORSEMENT_ENFORCE: "true" })).toBe(true);
  });
});
