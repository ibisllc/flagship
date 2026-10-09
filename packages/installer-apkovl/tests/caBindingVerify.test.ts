/**
 * The bootstrap's CA cross-check used to compare the trailer's IRK with the
 * binding flagshipserver.com served, trusting TLS alone. scripts/
 * verify-ca-binding.mjs now verifies the binding's signature against the CA
 * keys the PINNED maintainer chain endorses, using this checkout's real
 * `.maintainers/`. The fixture is a real production binding (public data,
 * captured 2026-10-09) signed by the production CA, so these tests exercise
 * the real chain, the real endorsement lease and a real signature.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveIRK, signUserPubKeyBinding } from "@flagship/protocol";
import { verifyCaBinding } from "../../../scripts/verify-ca-binding.mjs";

const REPO = join(__dirname, "..", "..", "..");
const cert = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "pubkey-cert-playstore-test-0725.json"), "utf8"),
);
const USER = cert.binding.username as string;
const IRK = cert.binding.pubKey as string;
const NOW = cert.binding.issuedAt + 60_000;

const check = (over: Partial<Parameters<typeof verifyCaBinding>[0]> = {}) =>
  verifyCaBinding({ repoPath: REPO, cert, username: USER, irkPubHex: IRK, now: NOW, ...over });

describe("verify-ca-binding (bootstrap H4, signature half)", () => {
  it("accepts a real production binding against the committed, pinned chain", () => {
    expect(check()).toEqual({ ok: true });
  });

  it("refuses it once the binding has expired", () => {
    expect(check({ now: cert.binding.expiresAt + 1 })).toEqual({ ok: false, reason: "artifact-expired" });
  });

  it("refuses a binding whose key was altered after signing", () => {
    const flipped = (IRK[0] === "0" ? "1" : "0") + IRK.slice(1);
    const forged = { ...cert, binding: { ...cert.binding, pubKey: flipped } };
    expect(check({ cert: forged, irkPubHex: flipped })).toEqual({ ok: false, reason: "signature-unverified" });
  });

  it("refuses a binding signed by a CA key the maintainers never endorsed", () => {
    const rogue = deriveIRK({ seed: new Uint8Array(32).fill(0x66) });
    const b = { ...cert.binding, pubKey: Uint8Array.from(Buffer.from(IRK, "hex")) };
    const sig = Buffer.from(signUserPubKeyBinding(b, rogue)).toString("hex");
    expect(check({ cert: { binding: cert.binding, signature: sig } })).toEqual({
      ok: false,
      reason: "signature-unverified",
    });
  });

  it("refuses a binding for a different username or key than the trailer's", () => {
    expect(check({ username: "someone-else" })).toEqual({ ok: false, reason: "username-mismatch" });
    expect(check({ irkPubHex: "00".repeat(32) })).toEqual({ ok: false, reason: "irk-mismatch" });
  });

  it("trusts nothing when the chain does not verify from the pin", () => {
    const r = check({ pinnedMandateHash: "ab".repeat(32) });
    expect(r.ok).toBe(false);
  });

  it("refuses a malformed cert", () => {
    expect(check({ cert: { binding: cert.binding } })).toEqual({ ok: false, reason: "malformed-cert" });
  });
});

describe("bootstrap wiring", () => {
  const BOOTSTRAP = readFileSync(
    join(__dirname, "..", "scripts", "flagship-bootstrap.start"),
    "utf8",
  );
  it("verifies the binding after the endorsement gate and before fetching install.sh", () => {
    const endorse = BOOTSTRAP.indexOf("scripts/verify-endorsement.mjs");
    const binding = BOOTSTRAP.indexOf("scripts/verify-ca-binding.mjs");
    const install = BOOTSTRAP.indexOf("installer/install.sh");
    expect(endorse).toBeGreaterThan(0);
    expect(binding).toBeGreaterThan(endorse);
    expect(install).toBeGreaterThan(binding);
  });
});
