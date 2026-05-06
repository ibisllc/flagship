/**
 * End-to-end smoke for LUKS unlock-on-boot against the live Worker.
 *
 * Mints fresh keys, registers a server, deposits an unlock-key (as
 * "the phone"), then performs a server-identity-signed
 * unlock-key/consume — the same call boot-stage.sh makes. Confirms the
 * round-trip recovered key matches the deposited key.
 *
 * Run from the repo root:
 *   npx tsx scripts/smoke-luks-unlock.ts
 */

import {
  ed,
  signAuthCode,
  signClaimUsername,
  signConsumeUnlockKey,
  signDepositUnlockKey,
  signRegisterRck,
  signServerRegister,
  type AuthCode,
  type ClaimUsername,
  type ConsumeUnlockKey,
  type DepositUnlockKey,
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

function makeKey(): Keypair {
  const priv = new Uint8Array(32);
  crypto.getRandomValues(priv);
  return { privateKey: priv, publicKey: ed.getPublicKey(priv) };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "smoke-luks" },
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

async function register(): Promise<{
  username: string;
  serverDomain: string;
  irk: Keypair;
  identity: Keypair;
}> {
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36).padStart(4, "0");
  const username = `t${Date.now().toString(36).slice(-5)}${suffix}`;
  const serverName = "home";
  const serverDomain = `${serverName}.${username}.flagship.services`;
  const irk = makeKey();
  const rck = makeKey();
  const identity = makeKey();

  console.log(`[smoke] registering ${serverDomain}`);

  const claim: ClaimUsername = { username, irkPub: irk.publicKey, issuedAt: Date.now() };
  const claimSig = signClaimUsername(claim, irk);
  let r = await postJson("/api/username/claim", {
    request: { username, irkPub: bytesToHex(irk.publicKey), issuedAt: claim.issuedAt },
    signature: bytesToHex(claimSig),
  });
  if (r.status !== 200) throw new Error(`claim failed: ${r.status} ${JSON.stringify(r.body)}`);

  const rckClaim: RegisterRck = {
    username,
    subdomain: serverDomain,
    rckPubKey: rck.publicKey,
    issuedAt: Date.now(),
  };
  r = await postJson("/api/routing/register-rck", {
    request: {
      username,
      subdomain: serverDomain,
      rckPubKey: bytesToHex(rck.publicKey),
      issuedAt: rckClaim.issuedAt,
    },
    signature: bytesToHex(signRegisterRck(rckClaim, irk)),
  });
  if (r.status !== 200) throw new Error(`rck failed: ${r.status} ${JSON.stringify(r.body)}`);

  const serial = `smoke-${Date.now()}-${suffix}`;
  const issuedAt = Date.now();
  const code: AuthCode = {
    version: 1,
    serial,
    username,
    serverName,
    serverDomain,
    delegatedPubKey: makeKey().publicKey,
    userPubKey: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 3_600_000,
  };
  const codeSig = signAuthCode(code, irk);
  r = await postJson("/api/auth-code/issue", {
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
  if (r.status !== 200) throw new Error(`auth failed: ${r.status} ${JSON.stringify(r.body)}`);

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
  r = await postJson("/api/server/register", {
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
    signature: bytesToHex(signServerRegister(reqObj, identity)),
  });
  if (r.status !== 200) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);

  return { username, serverDomain, irk, identity };
}

async function main(): Promise<void> {
  const { serverDomain, irk, identity } = await register();

  // Phone deposits an unlock-key (signed by IRK).
  const unlockKey = new Uint8Array(32);
  crypto.getRandomValues(unlockKey);
  const expiresAt = Date.now() + 5 * 60_000;
  const issuedAt = Date.now();
  const dep: DepositUnlockKey = { serverId: serverDomain, unlockKey, expiresAt, issuedAt };
  const depSig = signDepositUnlockKey(dep, irk);
  const depRes = await postJson(`/api/server/${serverDomain}/unlock-key`, {
    request: {
      serverId: serverDomain,
      unlockKey: bytesToHex(unlockKey),
      expiresAt,
      issuedAt,
    },
    signature: bytesToHex(depSig),
  });
  console.log(`[smoke] phone deposit → ${depRes.status}`);
  if (depRes.status !== 200) throw new Error(`deposit failed: ${JSON.stringify(depRes.body)}`);

  // Boot stage consumes (signed by server identity).
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const consumeIssuedAt = Date.now();
  const cClaim: ConsumeUnlockKey = { serverId: serverDomain, nonce, issuedAt: consumeIssuedAt };
  const cSig = signConsumeUnlockKey(cClaim, identity);
  const consumeRes = await postJson(`/api/server/${serverDomain}/unlock-key/consume`, {
    request: { serverId: serverDomain, nonce: bytesToHex(nonce), issuedAt: consumeIssuedAt },
    signature: bytesToHex(cSig),
  });
  console.log(`[smoke] boot consume → ${consumeRes.status}`);
  if (consumeRes.status !== 200) {
    throw new Error(`consume failed: ${JSON.stringify(consumeRes.body)}`);
  }

  const recovered = consumeRes.body.unlockKey as string;
  const expected = bytesToHex(unlockKey);
  if (recovered !== expected) {
    throw new Error(`mismatch! deposited=${expected} consumed=${recovered}`);
  }
  console.log(`[smoke] ✅ deposit and consume round-tripped the same unlock key`);

  // Second consume should fail with 404 (one-shot).
  const cSig2 = signConsumeUnlockKey({ ...cClaim, nonce: new Uint8Array(32) }, identity);
  const consume2 = await postJson(`/api/server/${serverDomain}/unlock-key/consume`, {
    request: { serverId: serverDomain, nonce: "00".repeat(32), issuedAt: consumeIssuedAt },
    signature: bytesToHex(cSig2),
  });
  console.log(`[smoke] second consume → ${consume2.status}`);
  if (consume2.status !== 404) {
    throw new Error(`expected 404 on second consume; got ${consume2.status}`);
  }
  console.log(`[smoke] ✅ one-shot semantics confirmed`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
