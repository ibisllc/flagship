/**
 * End-to-end smoke for the AutoUnlockLease flow against the live Worker.
 *
 * Companion to smoke-luks-unlock.ts (which exercises the legacy
 * DepositUnlockKey envelope). This one walks the new lease-based path:
 *
 *   1. Mint a fresh user + server (same registration shape as the
 *      legacy smoke).
 *   2. Sign + POST a one-shot lease (multiUse=false), 10-min expiry —
 *      mirrors the webapp's Approve flow.
 *   3. Boot-stage simulated /consume → asserts the unsealed key
 *      round-tripped, and a second /consume returns 404 (one-shot
 *      consumed).
 *   4. Sign + POST a multi-use lease (multiUse=true), 7-day expiry —
 *      mirrors the long-lived auto-unlock toggle.
 *   5. Two /consume calls in a row both succeed and return the same
 *      lease (multi-use survives the consume).
 *   6. Sign + DELETE the multi-use lease — kill switch.
 *   7. Subsequent /consume returns 404.
 *
 * Run from the repo root:
 *   npx tsx scripts/smoke-lease-unlock.ts
 */

import {
  ed,
  signAuthCode,
  signAutoUnlockLease,
  signClaimUsername,
  signConsumeUnlockKey,
  signRegisterRck,
  signRevokeAutoUnlockLease,
  signServerRegister,
  type AuthCode,
  type AutoUnlockLease,
  type ClaimUsername,
  type ConsumeUnlockKey,
  type Keypair,
  type RegisterRck,
  type RevokeAutoUnlockLease,
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

function randomLeaseId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}

async function postJson(
  path: string,
  body: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "smoke-lease" },
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
  // Same shape as smoke-luks-unlock.ts — extracted here so the smoke
  // is independently runnable. Any regression in registration would
  // break BOTH smokes loudly, which is the right failure mode.
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36).padStart(4, "0");
  const username = `lt${Date.now().toString(36).slice(-5)}${suffix}`;
  const serverName = "home";
  const serverDomain = `${serverName}.${username}.flagship.services`;
  const irk = makeKey();
  const rck = makeKey();
  const identity = makeKey();

  console.log(`[smoke-lease] registering ${serverDomain}`);

  const claim: ClaimUsername = { username, irkPub: irk.publicKey, issuedAt: Date.now() };
  let r = await postJson("/api/username/claim", {
    request: { username, irkPub: bytesToHex(irk.publicKey), issuedAt: claim.issuedAt },
    signature: bytesToHex(signClaimUsername(claim, irk)),
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

  const serial = `smoke-lease-${Date.now()}-${suffix}`;
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

async function depositLease(args: {
  serverDomain: string;
  irk: Keypair;
  unlockKey: Uint8Array;
  multiUse: boolean;
  ttlMs: number;
}): Promise<{ leaseId: string }> {
  const leaseId = randomLeaseId();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + args.ttlMs;
  const claim: AutoUnlockLease = {
    serverId: args.serverDomain,
    leaseId,
    expiresAt,
    unlockKey: args.unlockKey,
    multiUse: args.multiUse,
    issuedAt,
  };
  const sig = signAutoUnlockLease(claim, args.irk);
  const res = await postJson(`/api/server/${args.serverDomain}/unlock-key/lease`, {
    request: {
      serverId: args.serverDomain,
      leaseId,
      unlockKey: bytesToHex(args.unlockKey),
      multiUse: args.multiUse,
      expiresAt,
      issuedAt,
    },
    signature: bytesToHex(sig),
  });
  if (res.status !== 200) {
    throw new Error(`deposit lease failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(
    `[smoke-lease] deposit ${args.multiUse ? "multi-use" : "one-shot"} lease ${leaseId.slice(0, 8)}… → 200`,
  );
  return { leaseId };
}

async function consume(args: {
  serverDomain: string;
  identity: Keypair;
}): Promise<{ status: number; unlockKey?: string; leaseId?: string; multiUse?: boolean }> {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const issuedAt = Date.now();
  const claim: ConsumeUnlockKey = { serverId: args.serverDomain, nonce, issuedAt };
  const sig = signConsumeUnlockKey(claim, args.identity);
  const res = await postJson(`/api/server/${args.serverDomain}/unlock-key/consume`, {
    request: { serverId: args.serverDomain, nonce: bytesToHex(nonce), issuedAt },
    signature: bytesToHex(sig),
  });
  return {
    status: res.status,
    unlockKey: res.body?.unlockKey,
    leaseId: res.body?.leaseId,
    multiUse: res.body?.multiUse,
  };
}

async function revokeLease(args: {
  serverDomain: string;
  irk: Keypair;
  leaseId: string;
}): Promise<void> {
  const issuedAt = Date.now();
  const claim: RevokeAutoUnlockLease = {
    serverId: args.serverDomain,
    leaseId: args.leaseId,
    issuedAt,
  };
  const sig = signRevokeAutoUnlockLease(claim, args.irk);
  const res = await postJson(
    `/api/server/${args.serverDomain}/unlock-key/lease/${encodeURIComponent(args.leaseId)}`,
    {
      request: { serverId: args.serverDomain, leaseId: args.leaseId, issuedAt },
      signature: bytesToHex(sig),
    },
    "DELETE",
  );
  if (res.status !== 200) {
    throw new Error(`revoke failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  console.log(`[smoke-lease] revoke ${args.leaseId.slice(0, 8)}… → 200`);
}

async function main(): Promise<void> {
  const { serverDomain, irk, identity } = await register();

  // ---- Phase 1: one-shot lease (Approve flow) ----
  const oneShotKey = new Uint8Array(32);
  crypto.getRandomValues(oneShotKey);
  await depositLease({
    serverDomain,
    irk,
    unlockKey: oneShotKey,
    multiUse: false,
    ttlMs: 10 * 60_000,
  });

  let r = await consume({ serverDomain, identity });
  if (r.status !== 200) throw new Error(`one-shot consume failed: ${r.status}`);
  if (r.unlockKey !== bytesToHex(oneShotKey)) {
    throw new Error(`one-shot key mismatch: ${r.unlockKey} vs ${bytesToHex(oneShotKey)}`);
  }
  if (r.multiUse !== false) {
    throw new Error(`expected multiUse=false; got ${r.multiUse}`);
  }
  console.log(`[smoke-lease] ✅ one-shot lease consumed; key roundtripped`);

  r = await consume({ serverDomain, identity });
  if (r.status !== 404) {
    throw new Error(`expected 404 on second one-shot consume; got ${r.status}`);
  }
  console.log(`[smoke-lease] ✅ one-shot lease was deleted on consume`);

  // ---- Phase 2: multi-use long-lived lease ("auto-unlock" toggle) ----
  const multiKey = new Uint8Array(32);
  crypto.getRandomValues(multiKey);
  const { leaseId: multiLeaseId } = await depositLease({
    serverDomain,
    irk,
    unlockKey: multiKey,
    multiUse: true,
    ttlMs: 7 * 24 * 60 * 60_000,
  });

  for (let i = 1; i <= 3; i++) {
    r = await consume({ serverDomain, identity });
    if (r.status !== 200) throw new Error(`multi-use consume #${i} failed: ${r.status}`);
    if (r.unlockKey !== bytesToHex(multiKey)) {
      throw new Error(`multi-use #${i} key mismatch`);
    }
    if (r.multiUse !== true) throw new Error(`multi-use #${i} expected multiUse=true`);
    if (r.leaseId !== multiLeaseId) {
      throw new Error(`multi-use #${i} leaseId mismatch: ${r.leaseId} vs ${multiLeaseId}`);
    }
  }
  console.log(`[smoke-lease] ✅ multi-use lease survived 3 consumes`);

  // ---- Phase 3: revoke → consume returns 404 ----
  await revokeLease({ serverDomain, irk, leaseId: multiLeaseId });
  r = await consume({ serverDomain, identity });
  if (r.status !== 404) {
    throw new Error(`expected 404 after revoke; got ${r.status}`);
  }
  console.log(`[smoke-lease] ✅ revoke kills subsequent consumes`);

  console.log(`[smoke-lease] ✅✅✅ all phases passed`);
}

main().catch((e) => {
  console.error(`[smoke-lease] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
