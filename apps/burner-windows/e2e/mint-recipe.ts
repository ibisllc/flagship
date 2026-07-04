#!/usr/bin/env -S npx tsx
/**
 * Mint a REAL recipe for the Windows desktop-VM e2e (docs/coordination/
 * desktop-windows.md): the scripted equivalent of the /dev/create-server
 * phone simulator, minus the build-ticket short code (we hand the recipe
 * file straight to the app, so no typeable code is needed).
 *
 *   1. POST /api/username/suggest        — names are claimable only if
 *      recently suggested (docs/username-suggestion-queue.md).
 *   2. Claim it for a FRESH IRK           (flagship/claim-username/v1).
 *   3. Mint + record an AuthCode          (POST /api/auth-code/issue).
 *   4. Register the RCK                   (flagship/rck-register/v1).
 *   5. Build + self-sign the InstallBlob v2 with diskEncryption:"none"
 *      (proves the VM loop with NO phone in the unlock path) and an
 *      owner-IRK-signed debugGrant sibling (serial console for diagnosis —
 *      the box-side gate verifies it against this same IRK).
 *
 * Writes the issued-envelope recipe JSON + a .identity.json sidecar (the
 * IRK, for later owner-signed journal queries; NEVER part of the recipe).
 *
 *   npx tsx apps/burner-windows/e2e/mint-recipe.ts out\recipe.json
 */
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  ed,
  signAuthCode,
  signInstallBlob,
  signClaimUsername,
  signRegisterRck,
  signDebugAccessGrant,
  type AuthCode,
  type InstallBlob,
  type ClaimUsername,
  type RegisterRck,
  type DebugAccessGrant,
  type Keypair,
} from "@flagship/protocol";
import { bytesToHex } from "@noble/hashes/utils";

const CONTROL = process.env.FLAGSHIP_E2E_CONTROL || "flagshipserver.com";
const SERVICES = process.env.FLAGSHIP_E2E_SERVICES || "flagship.services";
const SERVER_NAME = process.env.FLAGSHIP_E2E_SERVER_NAME || "vmdesk";
const OUT = resolve(process.argv[2] || "recipe.e2e.json");

function keypairFromSeed(seed: Uint8Array): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

function genSerial(): string {
  return "vme2e" + bytesToHex(randomBytes(12));
}

async function post(path: string, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const r = await fetch(`https://${CONTROL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: r.status, text, json };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  // 1. A server-suggested name (the generator is the claim gatekeeper).
  const sug = await post("/api/username/suggest", {
    deviceKey: bytesToHex(keypairFromSeed(randomBytes(32)).publicKey),
  });
  const username: string = sug.json?.name;
  assert(username, `suggest failed (${sug.status}): ${sug.text.slice(0, 160)}`);
  const serverDomain = `${SERVER_NAME}.${username}.${SERVICES}`;
  console.log(`suggested username: ${username}`);
  console.log(`server domain:      ${serverDomain}`);

  // 2. Claim it for a fresh IRK.
  const irk = keypairFromSeed(randomBytes(32));
  const claim: ClaimUsername = { username, irkPub: irk.publicKey, issuedAt: Date.now() };
  const claimRes = await post("/api/username/claim", {
    request: { username, irkPub: bytesToHex(irk.publicKey), issuedAt: claim.issuedAt },
    signature: bytesToHex(signClaimUsername(claim, irk)),
  });
  assert(claimRes.status === 200, `claim failed (${claimRes.status}): ${claimRes.text.slice(0, 160)}`);
  console.log("username claimed");

  // 3. AuthCode (24h — the endpoint's max expiry), recorded with .com so the
  //    box's registration verifies.
  const delegated = keypairFromSeed(randomBytes(32));
  const authCode: AuthCode = {
    version: 1,
    serial: genSerial(),
    username,
    serverName: SERVER_NAME,
    serverDomain,
    delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 24 * 3_600_000,
  };
  const authCodeSig = signAuthCode(authCode, irk);
  const issueRes = await post("/api/auth-code/issue", {
    code: {
      version: authCode.version,
      serial: authCode.serial,
      username: authCode.username,
      serverName: authCode.serverName,
      serverDomain: authCode.serverDomain,
      delegatedPubKey: bytesToHex(authCode.delegatedPubKey),
      userPubKey: bytesToHex(authCode.userPubKey),
      issuedAt: authCode.issuedAt,
      expiresAt: authCode.expiresAt,
    },
    signature: bytesToHex(authCodeSig),
  });
  assert(issueRes.status === 200 || issueRes.status === 201,
    `auth-code issue failed (${issueRes.status}): ${issueRes.text.slice(0, 160)}`);
  console.log(`auth code recorded (serial ${authCode.serial.slice(0, 12)}…)`);

  // 4. Register the routing-control key for the subdomain.
  const rck = keypairFromSeed(randomBytes(32));
  const rckReg: RegisterRck = {
    username,
    subdomain: serverDomain,
    rckPubKey: rck.publicKey,
    issuedAt: Date.now(),
  };
  const rckRes = await post("/api/routing/register-rck", {
    request: {
      username,
      subdomain: serverDomain,
      rckPubKey: bytesToHex(rck.publicKey),
      issuedAt: rckReg.issuedAt,
    },
    signature: bytesToHex(signRegisterRck(rckReg, irk)),
  });
  assert(rckRes.status === 200, `register-rck failed (${rckRes.status}): ${rckRes.text.slice(0, 160)}`);
  console.log("RCK registered");

  // 5. The recipe: InstallBlob v2, diskEncryption "none" (signed in — a relay
  //    can't flip it), plus the owner-signed debugGrant sibling.
  const blob: InstallBlob = {
    version: 2,
    serverDomain,
    username,
    serverName: SERVER_NAME,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: `https://${CONTROL}/api/server/register`,
    authCode,
    authCodeUserSignature: authCodeSig,
    installerGitRef: "main",
    rckPubKey: rck.publicKey,
    diskEncryption: "none",
  };
  const blobSig = signInstallBlob(blob, irk);

  const grant: DebugAccessGrant = {
    serverDomain,
    sshAuthorizedKey: "",
    issuedAt: Date.now(),
  };
  const grantSigHex = bytesToHex(signDebugAccessGrant(grant, irk));

  const envelope = {
    blob: {
      version: blob.version,
      serverDomain: blob.serverDomain,
      username: blob.username,
      serverName: blob.serverName,
      phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
      registrationUrl: blob.registrationUrl,
      authCode: {
        version: authCode.version,
        serial: authCode.serial,
        username: authCode.username,
        serverName: authCode.serverName,
        serverDomain: authCode.serverDomain,
        delegatedPubKey: bytesToHex(authCode.delegatedPubKey),
        userPubKey: bytesToHex(authCode.userPubKey),
        issuedAt: authCode.issuedAt,
        expiresAt: authCode.expiresAt,
      },
      authCodeUserSignature: bytesToHex(authCodeSig),
      installerGitRef: blob.installerGitRef,
      rckPubKey: bytesToHex(blob.rckPubKey),
      diskEncryption: "none",
    },
    blobSignature: bytesToHex(blobSig),
    debugGrant: JSON.stringify({ grant, signatureHex: grantSigHex }),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(envelope, null, 2));
  writeFileSync(OUT.replace(/\.json$/, "") + ".identity.json", JSON.stringify({
    note: "e2e owner identity — NEVER ships in a recipe; kept for journal queries/cleanup",
    username,
    serverDomain,
    irkPubHex: bytesToHex(irk.publicKey),
    irkPrivHex: bytesToHex(irk.privateKey),
    rckPubHex: bytesToHex(rck.publicKey),
    rckPrivHex: bytesToHex(rck.privateKey),
  }, null, 2));

  console.log(`\nrecipe written: ${OUT}`);
  console.log(`identity sidecar: ${OUT.replace(/\.json$/, "")}.identity.json`);
  console.log(`\nnext: remaster + boot; expect https://${serverDomain}/ to serve when registered.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
