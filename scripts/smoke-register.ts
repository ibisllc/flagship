/**
 * One-shot end-to-end registration against the live flagshipserver.com.
 * Mints fresh keypairs, claims a unique username, issues an auth code,
 * registers a server, and prints the daemon-ready credentials.
 *
 * Run from the repo root:
 *   npx tsx /tmp/smoke-register.ts
 */

import {
  ed,
  signAuthCode,
  signClaimUsername,
  signRegisterRck,
  signServerRegister,
  type AuthCode,
  type ClaimUsername,
  type Keypair,
  type RegisterRck,
  type ServerRegisterRequest,
} from "@flagship/protocol";

const BASE = process.env.FLAGSHIP_BASE ?? "https://flagshipserver.com";

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function makeKey(seed?: number): Keypair {
  const priv = new Uint8Array(32);
  if (seed === undefined) crypto.getRandomValues(priv);
  else for (let i = 0; i < 32; i++) priv[i] = (seed * 31 + i * 13 + 7) & 0xff;
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "smoke-register" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, body: parsed };
}

async function main(): Promise<void> {
  // Unique-ish username so we don't collide with existing test data.
  const suffix = Math.floor(Math.random() * 1_000_000)
    .toString(36)
    .padStart(4, "0");
  const username = `t${Date.now().toString(36).slice(-5)}${suffix}`;
  const serverName = "home";
  const serverDomain = `${serverName}.${username}.flagship.services`;

  const irk = makeKey(); // user's IRK (would come from UMK on a real phone)
  const rck = makeKey(); // routing-control-key for this subdomain
  const identity = makeKey(); // server identity key (would be generated on the box)

  console.log(`[smoke] username      = ${username}`);
  console.log(`[smoke] serverDomain  = ${serverDomain}`);
  console.log(`[smoke] IRK pub       = ${bytesToHex(irk.publicKey)}`);
  console.log(`[smoke] identity pub  = ${bytesToHex(identity.publicKey)}`);

  // 1. Claim username
  const claim: ClaimUsername = { username, irkPub: irk.publicKey, issuedAt: Date.now() };
  const claimSig = signClaimUsername(claim, irk);
  let r = await post("/api/username/claim", {
    request: {
      username,
      irkPub: bytesToHex(irk.publicKey),
      issuedAt: claim.issuedAt,
    },
    signature: bytesToHex(claimSig),
  });
  console.log(`[smoke] claim → ${r.status}`);
  if (r.status !== 200) throw new Error(`claim failed: ${JSON.stringify(r.body)}`);

  // 2. Register RCK for this subdomain
  const rckClaim: RegisterRck = {
    username,
    subdomain: serverDomain,
    rckPubKey: rck.publicKey,
    issuedAt: Date.now(),
  };
  const rckSig = signRegisterRck(rckClaim, irk);
  r = await post("/api/routing/register-rck", {
    request: {
      username,
      subdomain: serverDomain,
      rckPubKey: bytesToHex(rck.publicKey),
      issuedAt: rckClaim.issuedAt,
    },
    signature: bytesToHex(rckSig),
  });
  console.log(`[smoke] rck    → ${r.status}`);
  if (r.status !== 200) throw new Error(`rck failed: ${JSON.stringify(r.body)}`);

  // 3. Issue an auth code (signed by IRK)
  const serial = `smoke-${Date.now()}-${suffix}`;
  const issuedAt = Date.now();
  const delegated = makeKey().publicKey;
  const code: AuthCode = {
    version: 1,
    serial,
    username,
    serverName,
    serverDomain,
    delegatedPubKey: delegated,
    userPubKey: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 3_600_000,
  };
  const codeSig = signAuthCode(code, irk);
  r = await post("/api/auth-code/issue", {
    code: {
      version: code.version,
      serial: code.serial,
      username: code.username,
      serverName: code.serverName,
      serverDomain: code.serverDomain,
      delegatedPubKey: bytesToHex(code.delegatedPubKey),
      userPubKey: bytesToHex(code.userPubKey),
      issuedAt: code.issuedAt,
      expiresAt: code.expiresAt,
    },
    signature: bytesToHex(codeSig),
  });
  console.log(`[smoke] auth   → ${r.status}`);
  if (r.status !== 200) throw new Error(`auth failed: ${JSON.stringify(r.body)}`);

  // 4. Register server (signed by server identity)
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const regIssuedAt = Date.now();
  const reqObj: ServerRegisterRequest = {
    authCode: code,
    authCodeUserSignature: codeSig,
    serverIdentityPubKey: identity.publicKey,
    issuedAt: regIssuedAt,
    nonce,
  };
  const regSig = signServerRegister(reqObj, identity);
  r = await post("/api/server/register", {
    request: {
      authCode: {
        version: code.version,
        serial: code.serial,
        username: code.username,
        serverName: code.serverName,
        serverDomain: code.serverDomain,
        delegatedPubKey: bytesToHex(code.delegatedPubKey),
        userPubKey: bytesToHex(code.userPubKey),
        issuedAt: code.issuedAt,
        expiresAt: code.expiresAt,
      },
      authCodeUserSignature: bytesToHex(codeSig),
      serverIdentityPubKey: bytesToHex(identity.publicKey),
      issuedAt: regIssuedAt,
      nonce: bytesToHex(nonce),
    },
    signature: bytesToHex(regSig),
  });
  console.log(`[smoke] server → ${r.status}`);
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  console.log(`[smoke] ${JSON.stringify(r.body, null, 2)}`);

  console.log(`\n----- daemon credentials -----`);
  console.log(`FLAGSHIP_SUBDOMAIN=${serverDomain}`);
  console.log(`FLAGSHIP_IDENTITY_PRIV_HEX=${bytesToHex(identity.privateKey)}`);
  console.log(`-----`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
