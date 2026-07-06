import { describe, expect, it } from "vitest";
import {
  ed,
  canonicalDebugAccessGrant,
  signDebugAccessGrant,
  verifyDebugAccessGrant,
  type DebugAccessGrant,
  type Keypair,
} from "../src/index.js";

const SERVER = "home.alice.flagship.services";

function makeKey(seed: number): Keypair {
  const priv = new Uint8Array(32).fill(seed);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

describe("debug-access grant", () => {
  const grant: DebugAccessGrant = {
    serverDomain: SERVER,
    sshAuthorizedKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILEXAMPLE phone",
    issuedAt: 1700,
  };

  it("canonical bytes — tag|serverDomain|sshKey|issuedAt", () => {
    const expected = new TextEncoder().encode(
      `flagship/debug-access/v1|${SERVER}|${grant.sshAuthorizedKey}|1700`,
    );
    expect(canonicalDebugAccessGrant(grant)).toEqual(expected);
  });

  it("empty ssh key canonicalizes with an empty field", () => {
    const g = { ...grant, sshAuthorizedKey: "" };
    expect(new TextDecoder().decode(canonicalDebugAccessGrant(g)))
      .toBe(`flagship/debug-access/v1|${SERVER}||1700`);
  });

  it("signs + verifies under the owner IRK (pinned cross-platform vector)", () => {
    const irk = makeKey(7);
    const sig = signDebugAccessGrant(grant, irk);
    expect(verifyDebugAccessGrant(grant, sig, irk.publicKey)).toBe(true);
    // Pinned vector — the Swift/Kotlin mirrors assert this exact signature.
    expect(Buffer.from(sig).toString("hex")).toBe(
      "818ed03fb15414fe647aecd466524d8069df53f245dfe6dff7ab78da15ab976e922a39595e5e34ebdb4cec1e628efba0a4cc1cbd1efb1684234a8b8d4e21aa05",
    );
  });

  it("rejects a tampered grant, a wrong key, and the zero key", () => {
    const irk = makeKey(7);
    const sig = signDebugAccessGrant(grant, irk);
    expect(verifyDebugAccessGrant({ ...grant, issuedAt: 1701 }, sig, irk.publicKey)).toBe(false);
    expect(verifyDebugAccessGrant(grant, sig, makeKey(8).publicKey)).toBe(false);
    expect(verifyDebugAccessGrant(grant, sig, new Uint8Array(32))).toBe(false);
  });
});
