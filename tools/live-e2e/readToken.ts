// `.com` lists an account's servers only to a bearer of its read token
// (docs/account-read-token.md). The drivers that use a real (non-demo)
// account mint one with the IRK they hold; demo accounts need none.
import { randomBytes } from "node:crypto";
import { bytesToHex } from "@noble/hashes/utils";
import { ACCOUNT_READ_TOKEN_LABEL, signDeviceEndpointClaim, type Keypair } from "@flagship/protocol";

const cache = new Map<string, { token: string; expiresAt: number }>();

/** `{ authorization }` for reading `username`'s `/pods`, minted with its IRK. */
export async function accountReadHeaders(
  control: string,
  username: string,
  irk: Keypair,
): Promise<Record<string, string>> {
  const key = `${control}|${username}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt - 60_000) return { authorization: `Bearer ${hit.token}` };
  const issuedAt = Date.now();
  const claim = {
    username,
    endpointLabel: ACCOUNT_READ_TOKEN_LABEL,
    phoneIrkPub: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 5 * 60_000,
    nonce: new Uint8Array(randomBytes(32)),
  };
  const r = await fetch(`https://${control}/api/accounts/${encodeURIComponent(username)}/read-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      auth: { ...claim, phoneIrkPub: bytesToHex(claim.phoneIrkPub), nonce: bytesToHex(claim.nonce) },
      authSignature: bytesToHex(signDeviceEndpointClaim(claim, irk)),
    }),
  });
  const body = (await r.json().catch(() => ({}))) as { token?: unknown; expiresAt?: unknown };
  if (!r.ok || typeof body.token !== "string" || typeof body.expiresAt !== "number") {
    throw new Error(`read token refused: ${r.status}`);
  }
  cache.set(key, { token: body.token, expiresAt: body.expiresAt });
  return { authorization: `Bearer ${body.token}` };
}
