// Generate the cross-engine golden vectors: {recipeJson, burnOptsJson} →
// expected preseed + user-data, produced by the canonical Node generator. The
// Android (Rhino) + macOS/iOS (JavaScriptCore) engine tests load this fixture,
// run THEIR engine on recipeJson/burnOptsJson, and assert byte-identical output
// — so Node + Rhino + JSC can never diverge. Regenerate after a generator change:
//   node packages/flagship-burner/scripts/genGoldenVectors.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signInstallBlob, ed } from "@flagship/protocol";
import { buildPreseedFromRecipe, buildUserDataFromRecipe } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "engine", "golden", "preseed-vectors.json");

const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const kp = (seed) => { const sk = new Uint8Array(32).fill(seed); return { privateKey: sk, publicKey: ed.getPublicKey(sk) }; };

function buildSignedRecipe(o = {}) {
  const irk = kp(7), delegate = kp(8), rck = kp(9), adminRoot = kp(10);
  const expiresAt = 1_900_000_000_000;
  const authCode = {
    version: 1, serial: "01ENGINETEST", username: "harry", serverName: "home",
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: delegate.publicKey, userPubKey: irk.publicKey,
    issuedAt: expiresAt - 3_600_000, expiresAt,
    ...(o.adminRoot ? { adminRootPubKey: adminRoot.publicKey } : {}),
  };
  const blob = {
    version: 2, serverDomain: authCode.serverDomain, username: authCode.username,
    serverName: authCode.serverName, phoneDelegatedPubKey: delegate.publicKey,
    registrationUrl: "https://flagship.services/api/server/register", authCode,
    authCodeUserSignature: new Uint8Array(64), installerGitRef: "main", rckPubKey: rck.publicKey,
    ...(o.bootUnlockMode ? { bootUnlockMode: o.bootUnlockMode } : {}),
    ...(o.diskEncryption ? { diskEncryption: o.diskEncryption } : {}),
  };
  const sig = signInstallBlob(blob, irk);
  return JSON.stringify({
    version: 2, serverDomain: blob.serverDomain, username: blob.username, serverName: blob.serverName,
    phoneDelegatedPubKey: hex(blob.phoneDelegatedPubKey), registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1, serial: authCode.serial, username: authCode.username, serverName: authCode.serverName,
      serverDomain: authCode.serverDomain, delegatedPubKey: hex(authCode.delegatedPubKey),
      userPubKey: hex(authCode.userPubKey), issuedAt: authCode.issuedAt, expiresAt: authCode.expiresAt,
      ...(authCode.adminRootPubKey ? { adminRootPubKey: hex(authCode.adminRootPubKey) } : {}),
    },
    authCodeUserSignature: hex(blob.authCodeUserSignature), installerGitRef: blob.installerGitRef,
    rckPubKey: hex(blob.rckPubKey),
    ...(o.bootUnlockMode ? { bootUnlockMode: o.bootUnlockMode } : {}),
    ...(o.diskEncryption ? { diskEncryption: o.diskEncryption } : {}),
    blobSignatureHex: hex(sig),
    ...(o.swkHex ? { swkHex: o.swkHex } : {}),
    ...(o.pairingOrder ? { pairingOrder: o.pairingOrder } : {}),
    ...(o.debugGrant ? { debugGrant: o.debugGrant } : {}),
  });
}

const matrix = [
  { name: "luks-default", recipe: { diskEncryption: "luks" }, burn: {} },
  { name: "no-encryption", recipe: { diskEncryption: "none" }, burn: { encryptRoot: false } },
  { name: "wifi", recipe: {}, burn: { wifiSSID: "myssid", wifiPassword: "p@ss w0rd" } },
  { name: "approve-unlock", recipe: { bootUnlockMode: "approve" }, burn: {} },
  { name: "admin-root", recipe: { adminRoot: true }, burn: {} },
  { name: "swk-pairing", recipe: { swkHex: "ab".repeat(32), pairingOrder: '{"request":"x","signature":"y"}' }, burn: {} },
  { name: "debug-grant", recipe: { debugGrant: JSON.stringify({ grant: { serverDomain: "home.harry.flagship.services", sshAuthorizedKey: "ssh-ed25519 AAAAC3Test", issuedAt: 1700000000000 }, signatureHex: "ab".repeat(64) }) }, burn: {} },
];

const vectors = matrix.map((m) => {
  const recipeJson = buildSignedRecipe(m.recipe);
  const burnOptsJson = JSON.stringify(m.burn);
  return {
    name: m.name,
    recipeJson,
    burnOptsJson,
    expectedPreseed: buildPreseedFromRecipe(recipeJson, burnOptsJson),
    expectedUserData: buildUserDataFromRecipe(recipeJson, burnOptsJson),
  };
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ version: 1, vectors }, null, 2) + "\n");
console.log(`wrote ${vectors.length} golden vectors → ${OUT}`);
