// GET /api/maintainer-blessing — exposes the public chain so a client can
// verify, against its OWN baked pin + clock, that the served CA key is
// maintainer-authorized. The handler is a pass-through of public material
// plus `.com`'s advisory self-assessment; the real forward verifier runs
// client-side (and, for `.com`'s own gate, in the Worker test). These
// tests inject a fabricated CaTrustChain so they stay hermetic.

import { describe, expect, it } from "vitest";
import { ed, type CaTrustChain, type Keypair } from "@flagship/protocol";
import {
  handleMaintainerBlessing,
  type MaintainerBlessingMaterial,
} from "../src/pubkeyCert.js";

const NOW = 1_770_000_000_000;

function caFromHex(privHex: string): Keypair {
  const sk = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sk[i] = parseInt(privHex.slice(i * 2, i * 2 + 2), 16);
  return { privateKey: sk, publicKey: ed.getPublicKey(sk) };
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const MATERIAL: MaintainerBlessingMaterial = {
  pinnedMandateHash: "ab".repeat(32),
  mandates: [{ kind: "Mandate", track: "ca", holder: "11".repeat(32) }],
  caEndorsements: [{ kind: "CaEndorsement", caPubkey: "22".repeat(32) }],
};

describe("handleMaintainerBlessing", () => {
  it("passes the public material through verbatim with the served key + issuer", () => {
    const keypair = caFromHex("01".repeat(32));
    const res = handleMaintainerBlessing({
      ca: { keypair, issuer: "flagship-ca-v1" },
      material: MATERIAL,
      now: () => NOW,
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(b.pinnedMandateHash).toBe(MATERIAL.pinnedMandateHash);
    expect(b.mandates).toEqual(MATERIAL.mandates);
    expect(b.caEndorsements).toEqual(MATERIAL.caEndorsements);
    expect(b.caPubkey).toBe(hex(keypair.publicKey));
    expect(b.issuer).toBe("flagship-ca-v1");
    expect(b.now).toBe(NOW);
    // no chain injected ⇒ advisory is null (client must verify itself)
    expect(b.caPubkeyAuthorizedNow).toBeNull();
    expect(res.headers?.["cache-control"]).toMatch(/max-age=\d+/);
  });

  it("reports caPubkeyAuthorizedNow=true when the served key is in authorizedCaKeys(now)", () => {
    const keypair = caFromHex("02".repeat(32));
    const served = hex(keypair.publicKey);
    const chain: CaTrustChain = { authorizedCaKeys: () => [served] };
    const res = handleMaintainerBlessing({
      ca: { keypair, issuer: "flagship-ca-v1" },
      material: MATERIAL,
      caTrustChain: chain,
      now: () => NOW,
    });
    expect((res.body as Record<string, unknown>).caPubkeyAuthorizedNow).toBe(true);
  });

  it("reports caPubkeyAuthorizedNow=false when the served key is NOT authorized (lapsed/forked)", () => {
    const keypair = caFromHex("03".repeat(32));
    const chain: CaTrustChain = { authorizedCaKeys: () => [] }; // e.g. lapsed lease
    const res = handleMaintainerBlessing({
      ca: { keypair, issuer: "flagship-ca-v1" },
      material: MATERIAL,
      caTrustChain: chain,
      now: () => NOW,
    });
    expect((res.body as Record<string, unknown>).caPubkeyAuthorizedNow).toBe(false);
  });
});
