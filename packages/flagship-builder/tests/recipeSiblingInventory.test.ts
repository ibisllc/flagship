import { describe, expect, it } from "vitest";
import { ed, signAuthCode, signInstallBlob, type AuthCode, type InstallBlob } from "@flagship/protocol";
import { installBlobToJson } from "../src/userdata.js";

/**
 * SEC-RECIPE-001 gate: every top-level field of a recipe that is NOT in the signed install blob is a
 * "sibling", and a sibling is only as trustworthy as its own authentication. This test lists every
 * sibling the builder writes and the check that authenticates it. A new sibling fails here until
 * someone writes down how it is authenticated.
 */
const SIBLINGS: Record<string, string> = {
  pairingOrder: "an add-paired-session order signed by the owner's account key; the box verifies the signature before adding the session",
  swkHex: "committed to by `offlineSecrets` (the account key signs the key's hash for this server and order); the builder and the box refuse a key without it",
  offlineSecrets: "signed by the account key the install blob names; verified by the builder (loadBlob) and again by the box",
  debugGrant: "a debug-access grant signed by the owner's account key and bound to this box; the box's debugAccessGate verifies it",
};

const SIGNED_BLOB_FIELDS = new Set([
  "version", "serverDomain", "username", "serverName", "phoneDelegatedPubKey", "registrationUrl", "authCode", "authCodeUserSignature",
  "installerGitRef", "rckPubKey", "bootUnlockMode", "diskEncryption", "blobSignatureHex",
]);

function blob(): { blob: InstallBlob; sig: string } {
  const k = (b: number) => { const privateKey = new Uint8Array(32).fill(b); return { privateKey, publicKey: ed.getPublicKey(privateKey) }; };
  const irk = k(1), dev = k(2), rck = k(3);
  const authCode: AuthCode = { version: 1, serial: "S1", username: "u", serverName: "s", serverDomain: "s.u.flagship.services", delegatedPubKey: dev.publicKey, userPubKey: irk.publicKey, issuedAt: 1, expiresAt: 2 };
  const b: InstallBlob = { version: 2, serverDomain: authCode.serverDomain, username: "u", serverName: "s", phoneDelegatedPubKey: dev.publicKey, registrationUrl: "https://x/api", authCode, authCodeUserSignature: signAuthCode(authCode, irk), installerGitRef: "a".repeat(40), rckPubKey: rck.publicKey, bootUnlockMode: "approve", diskEncryption: "luks" };
  return { blob: b, sig: Buffer.from(signInstallBlob(b, irk)).toString("hex") };
}

describe("recipe siblings (SEC-RECIPE-001)", () => {
  it("every sibling the builder can write has a recorded authentication", () => {
    const { blob: b, sig } = blob();
    const written = Object.keys(installBlobToJson(b, sig, "{}", "ab".repeat(32), "{}", "{}"));
    const siblings = written.filter((k) => !SIGNED_BLOB_FIELDS.has(k)).sort();
    expect(siblings).toEqual(Object.keys(SIBLINGS).sort());
  });

  it("a recipe without siblings writes none", () => {
    const { blob: b, sig } = blob();
    expect(Object.keys(installBlobToJson(b, sig)).filter((k) => !SIGNED_BLOB_FIELDS.has(k))).toEqual([]);
  });
});
