/**
 * Live smoke for the server-identity-signed revoke endpoint.
 * Registers a fresh server, calls /api/server/by-domain/<host>/revoke,
 * confirms 200 ok + revokedAt set in storage (via lookup endpoint).
 *
 *   npx tsx scripts/smoke-revoke.ts
 */

import {
  ed,
  signAuthCode,
  signClaimUsername,
  signRegisterRck,
  signServerRegister,
  signServerRevokeBySelf,
  type AuthCode,
  type ClaimUsername,
  type Keypair,
  type RegisterRck,
  type ServerRegisterRequest,
  type ServerRevokeBySelf,
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
async function postJson(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed as any };
}
async function getJson(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

async function register(): Promise<{ serverDomain: string; identity: Keypair }> {
  const suffix = Math.floor(Math.random() * 1_000_000).toString(36).padStart(4, "0");
  const username = `r${Date.now().toString(36).slice(-5)}${suffix}`;
  const serverName = "home";
  const serverDomain = `${serverName}.${username}.flagship.services`;
  const irk = makeKey();
  const rck = makeKey();
  const identity = makeKey();
  const claim: ClaimUsername = { username, irkPub: irk.publicKey, issuedAt: Date.now() };
  let r = await postJson("/api/username/claim", {
    request: { username, irkPub: bytesToHex(irk.publicKey), issuedAt: claim.issuedAt },
    signature: bytesToHex(signClaimUsername(claim, irk)),
  });
  if (r.status !== 200) throw new Error(`claim: ${JSON.stringify(r.body)}`);
  const rckClaim: RegisterRck = { username, subdomain: serverDomain, rckPubKey: rck.publicKey, issuedAt: Date.now() };
  r = await postJson("/api/routing/register-rck", {
    request: { username, subdomain: serverDomain, rckPubKey: bytesToHex(rck.publicKey), issuedAt: rckClaim.issuedAt },
    signature: bytesToHex(signRegisterRck(rckClaim, irk)),
  });
  if (r.status !== 200) throw new Error(`rck: ${JSON.stringify(r.body)}`);
  const issuedAt = Date.now();
  const code: AuthCode = {
    version: 1, serial: `revoke-${Date.now()}-${suffix}`, username, serverName, serverDomain,
    delegatedPubKey: makeKey().publicKey, userPubKey: irk.publicKey, issuedAt, expiresAt: issuedAt + 3_600_000,
  };
  const codeSig = signAuthCode(code, irk);
  r = await postJson("/api/auth-code/issue", {
    code: { ...code,
      delegatedPubKey: bytesToHex(code.delegatedPubKey),
      userPubKey: bytesToHex(code.userPubKey),
    },
    signature: bytesToHex(codeSig),
  });
  if (r.status !== 200) throw new Error(`auth: ${JSON.stringify(r.body)}`);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const regIssuedAt = Date.now();
  const reqObj: ServerRegisterRequest = {
    authCode: code, authCodeUserSignature: codeSig,
    serverIdentityPubKey: identity.publicKey, issuedAt: regIssuedAt, nonce,
  };
  r = await postJson("/api/server/register", {
    request: {
      authCode: { ...code,
        delegatedPubKey: bytesToHex(code.delegatedPubKey),
        userPubKey: bytesToHex(code.userPubKey),
      },
      authCodeUserSignature: bytesToHex(codeSig),
      serverIdentityPubKey: bytesToHex(identity.publicKey),
      issuedAt: regIssuedAt, nonce: bytesToHex(nonce),
    },
    signature: bytesToHex(signServerRegister(reqObj, identity)),
  });
  if (r.status !== 200) throw new Error(`register: ${JSON.stringify(r.body)}`);
  return { serverDomain, identity };
}

async function main() {
  const { serverDomain, identity } = await register();
  console.log(`[smoke] registered ${serverDomain}`);

  // confirm not-revoked
  let look = await getJson(`/api/server/by-domain/${encodeURIComponent(serverDomain)}`);
  console.log(`[smoke] before revoke: revoked=${look.body.revoked ? "yes" : "no"}`);

  // post revoke
  const reason = "smoke-test self-revoke";
  const issuedAt = Date.now();
  const claim: ServerRevokeBySelf = { serverId: serverDomain, reason, issuedAt };
  const sig = signServerRevokeBySelf(claim, identity);
  const rev = await postJson(`/api/server/by-domain/${encodeURIComponent(serverDomain)}/revoke`, {
    request: { serverId: serverDomain, reason, issuedAt },
    signature: bytesToHex(sig),
  });
  console.log(`[smoke] revoke → ${rev.status}: ${JSON.stringify(rev.body)}`);
  if (rev.status !== 200) throw new Error("revoke failed");

  // confirm revoked
  look = await getJson(`/api/server/by-domain/${encodeURIComponent(serverDomain)}`);
  console.log(`[smoke] after revoke: revoked=${JSON.stringify(look.body.revoked)}`);
  if (!look.body.revoked) throw new Error("storage didn't flip");
  console.log(`[smoke] ✅ self-revoke landed in D1`);

  // idempotent retry
  const issuedAt2 = Date.now();
  const sig2 = signServerRevokeBySelf({ serverId: serverDomain, reason: "retry", issuedAt: issuedAt2 }, identity);
  const rev2 = await postJson(`/api/server/by-domain/${encodeURIComponent(serverDomain)}/revoke`, {
    request: { serverId: serverDomain, reason: "retry", issuedAt: issuedAt2 },
    signature: bytesToHex(sig2),
  });
  if (rev2.status !== 200 || !rev2.body.alreadyRevoked) {
    throw new Error(`expected idempotent 200/alreadyRevoked; got ${rev2.status} ${JSON.stringify(rev2.body)}`);
  }
  console.log(`[smoke] ✅ idempotent retry returns alreadyRevoked`);
}

main().catch((e) => {
  console.error(`[smoke] fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
