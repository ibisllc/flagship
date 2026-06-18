// GYM TEST BRANCH ONLY. Proves the gym's self-contained maintainer-trust
// chain is byte-correct by running the EXACT verify logic the gym apps run —
// `verifyComBlessing` = verifyMandateChainFromPin(BAKED_PIN, mandates) →
// authorizedCaKeys(caEndorsements, chain, CLIENT_NOW) ∋ served caPubkey.
//
// The webapp's lib/maintainerTrust.js is browser-JS; this test uses the SAME
// algorithm via the real `@ibisllc/maintainers` verifier — exactly what
// caTrustChainLoader.ts feeds the worker — so a pass here proves the committed
// envelopes (root Mandate + the 100-yr / expired CaEndorsements) verify, and
// that the gym pin == sha256hex(canonicalMandate(root)).

import { describe, expect, it } from "vitest";
import {
  authorizedCaKeys,
  mandatePinHash,
  verifyMandateChainFromPin,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import {
  GYM_K_PUB,
  GYM_PIN,
  GYM_ROOT_MANDATE,
  GYM_LIVE_CA_ENDORSEMENT,
  GYM_EXPIRED_CA_ENDORSEMENT,
} from "../src/gymTrustMaterial.js";

// A `now` comfortably inside the 100-yr window and well after 2020.
const NOW = new Date("2026-06-18T00:00:00.000Z");

/**
 * Faithful re-implementation of `verifyComBlessing` (lib/maintainerTrust.js):
 * the baked pin is the floor (a `.com`-asserted pin must equal it), the chain
 * is verified FORWARD from that pin, and the served CA key must be in the keys
 * authorized live at the CALLER's clock. Returns the same shape the apps key
 * off ({ trusted, caPubkey, reason }).
 */
function verifyComBlessing(
  blessing: {
    pinnedMandateHash: string;
    caPubkey: string;
    mandates: Mandate[];
    caEndorsements: CaEndorsement[];
  },
  now: Date,
  pinnedMandateHash: string,
): { trusted: boolean; caPubkey: string | null; reason: string } {
  const pin = pinnedMandateHash;
  if (!pin) return { trusted: false, caPubkey: null, reason: "pin-unconfigured" };
  const servedKey = blessing.caPubkey;
  if (typeof servedKey !== "string" || servedKey.length !== 64) {
    return { trusted: false, caPubkey: null, reason: "no-served-key" };
  }
  const chain = verifyMandateChainFromPin(pin, blessing.mandates);
  const keys = authorizedCaKeys(blessing.caEndorsements, chain, now);
  if (!keys || keys.length === 0) {
    return { trusted: false, caPubkey: servedKey, reason: "no-authorized-ca-keys" };
  }
  if (!keys.includes(servedKey)) {
    return { trusted: false, caPubkey: servedKey, reason: "served-key-not-authorized" };
  }
  return { trusted: true, caPubkey: servedKey, reason: "ok" };
}

describe("gym self-contained maintainer-trust chain", () => {
  it("gym pin == sha256hex(canonicalMandate(gym root Mandate))", () => {
    expect(mandatePinHash(GYM_ROOT_MANDATE as unknown as Mandate)).toBe(GYM_PIN);
  });

  it("the gym root Mandate verifies FORWARD from the gym pin (self-signed root)", () => {
    const chain = verifyMandateChainFromPin(GYM_PIN, [
      GYM_ROOT_MANDATE as unknown as Mandate,
    ]);
    expect(chain.rootError).toBeUndefined();
    expect(chain.root).not.toBeNull();
    expect(chain.validMandates).toHaveLength(1);
    // K is the live authority now.
    const keys = authorizedCaKeys(
      [GYM_LIVE_CA_ENDORSEMENT as unknown as CaEndorsement],
      chain,
      NOW,
    );
    expect(keys).toContain(GYM_K_PUB);
  });

  it("TRUSTED: served caPubkey == K with the live 100-yr endorsement", () => {
    const r = verifyComBlessing(
      {
        pinnedMandateHash: GYM_PIN,
        caPubkey: GYM_K_PUB,
        mandates: [GYM_ROOT_MANDATE as unknown as Mandate],
        caEndorsements: [GYM_LIVE_CA_ENDORSEMENT as unknown as CaEndorsement],
      },
      NOW,
      GYM_PIN,
    );
    expect(r).toEqual({ trusted: true, caPubkey: GYM_K_PUB, reason: "ok" });
  });

  it("UNTRUSTED: only the EXPIRED endorsement ⇒ no-authorized-ca-keys", () => {
    const r = verifyComBlessing(
      {
        pinnedMandateHash: GYM_PIN,
        caPubkey: GYM_K_PUB,
        mandates: [GYM_ROOT_MANDATE as unknown as Mandate],
        caEndorsements: [GYM_EXPIRED_CA_ENDORSEMENT as unknown as CaEndorsement],
      },
      NOW,
      GYM_PIN,
    );
    expect(r.trusted).toBe(false);
    expect(r.reason).toBe("no-authorized-ca-keys");
  });

  it("the expired endorsement authorizes NOTHING at now (authorizedCaKeys = [])", () => {
    const chain = verifyMandateChainFromPin(GYM_PIN, [
      GYM_ROOT_MANDATE as unknown as Mandate,
    ]);
    const keys = authorizedCaKeys(
      [GYM_EXPIRED_CA_ENDORSEMENT as unknown as CaEndorsement],
      chain,
      NOW,
    );
    expect(keys).toHaveLength(0);
  });
});
