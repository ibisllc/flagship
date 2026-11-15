// A retail box's first boot after a claim (retailClaim/firstBoot.ts): the seed the specializer runs
// is made on the box from the claimed recipe with the release's committed preseed engine, and the
// daemon runs the claim service alone until that first boot has finished.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ed, signAuthCode, signInstallBlob, type AuthCode, type InstallBlob, type Keypair } from "@flagship/protocol";
import { retailBootMode, retailSeedFromRecipe } from "../../src/retailClaim/firstBoot.js";
import { verifyClaimRecipe } from "../../src/retailClaim/recipe.js";

const ENGINE = readFileSync(fileURLToPath(new URL("../../../flagship-builder/engine/preseed-engine.js", import.meta.url)), "utf8");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const kp = (byte: number): Keypair => {
  const priv = new Uint8Array(32).fill(byte);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
};
function wire(v: unknown): unknown {
  if (v instanceof Uint8Array) return hex(v);
  if (Array.isArray(v)) return v.map(wire);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)]));
  return v;
}

/** A recipe as the phone sends it in a claim: `{blob, blobSignature}`. */
function claimedRecipe(): string {
  const irk = kp(0x11);
  const t0 = 1_800_000_000_000;
  const c: AuthCode = {
    version: 1,
    serial: "retail-serial-1-xxxx",
    username: "harry",
    serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: kp(0x61).publicKey,
    userPubKey: irk.publicKey,
    issuedAt: t0,
    expiresAt: t0 + 6 * 3600_000,
    adminRootPubKey: kp(0x22).publicKey,
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: c.serverDomain,
    username: "harry",
    serverName: "home",
    phoneDelegatedPubKey: c.delegatedPubKey,
    registrationUrl: "https://flagshipserver.com/api/server/register",
    authCode: c,
    authCodeUserSignature: signAuthCode(c, irk),
    installerGitRef: "a".repeat(40),
    rckPubKey: kp(0x71).publicKey,
    bootUnlockMode: "approve",
  };
  return JSON.stringify({ blob: wire(blob), blobSignature: hex(signInstallBlob(blob, irk)) });
}

describe("retail first-boot seed", () => {
  it("is the specializer's seed for the recipe the claim took, with a bootstrap that keeps keyd's key", () => {
    const recipe = claimedRecipe();
    expect(verifyClaimRecipe(recipe, 1_800_000_000_001)).toMatchObject({ ok: true, serverDomain: "home.harry.flagship.services" });
    const seed = retailSeedFromRecipe(recipe, ENGINE);
    expect(seed.version).toBe(1);
    const blob = Buffer.from(seed.recipeBase64, "base64");
    expect(createHash("sha256").update(blob).digest("hex")).toBe(seed.recipeSha256);
    const parsed = JSON.parse(blob.toString("utf8"));
    expect(parsed.serverDomain).toBe("home.harry.flagship.services");
    expect(parsed.authCode.serial).toBe("retail-serial-1-xxxx");
    expect(parsed.blobSignatureHex).toMatch(/^[0-9a-f]{128}$/);
    const bootstrap = Buffer.from(seed.bootstrapBase64, "base64").toString("utf8");
    expect(bootstrap.startsWith("#!/bin/bash")).toBe(true);
    expect(bootstrap).toContain('if [ "${FLAGSHIP_BOX_KEY_IN_KEYD:-0}" = "1" ]; then');
    expect(bootstrap).toContain("install-helper.ts keyd-public-key --keyd-socket");
    expect(bootstrap).toContain(`echo "approve" > /boot/flagship-boot-unlock-mode`);
  });

  it("refuses a recipe the engine cannot read and an engine that is not one", () => {
    expect(() => retailSeedFromRecipe("{}", ENGINE)).toThrow();
    expect(() => retailSeedFromRecipe(claimedRecipe(), "var x = 1;")).toThrow("the preseed engine did not load");
  });
});

describe("retail boot mode", () => {
  it("serves only once a claim's first boot finished; otherwise the claim service runs alone", () => {
    expect(retailBootMode("unclaimed", false)).toBe("claim-only");
    expect(retailBootMode("unclaimed", true)).toBe("claim-only");
    expect(retailBootMode("locked", true)).toBe("claim-only");
    expect(retailBootMode("claimed", false)).toBe("claim-only");
    expect(retailBootMode("claimed", true)).toBe("serve");
  });
});
