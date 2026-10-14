// Account read tokens (docs/account-read-token.md).
//
// `.com` serves an account's server inventory (`/api/users/<u>/pods`,
// `/stream`), device history (`/audit`) and app names (`/apps/aliases`,
// `/apps/<id>/links`) only to a bearer of an account read token. A token is
// minted at `POST /api/accounts/<u>/read-token` by one of three signers:
//
//   - a device of the account: an `account-directory-request/v1` over
//     POST + `accountReadTokenPath(u)` (accountMetadata.ts), in headers;
//   - the account's IRK: a `device-endpoint-claim/v1` with endpointLabel
//     `ACCOUNT_READ_TOKEN_LABEL` (phoneEndpoint.ts), in the body;
//   - one of the account's servers: a `BoxReadTokenRequest` signed with its
//     STK (below), in the body.
//
// The token itself is opaque to every client: only `.com` reads it.

import { ed } from "./edSync.js";
import { hex, validateNoSepCtrl, type MsgSigner, resolveMsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const ACCOUNT_READ_TOKEN_LABEL = "account-read-token";
export const TAG_BOX_READ_TOKEN_REQUEST = "flagship/box-read-token-request/v1";

export function accountReadTokenPath(username: string): string {
  return `/api/accounts/${username.toLowerCase()}/read-token`;
}

export interface BoxReadTokenRequest {
  username: string;
  serverDomain: string;
  stkPubHex: string;
  issuedAt: number;
  /** 16 random bytes, lowercase hex: the replay handle. */
  nonceHex: string;
}

export function canonicalBoxReadTokenRequest(r: BoxReadTokenRequest): Bytes {
  validateNoSepCtrl("username", r.username);
  validateNoSepCtrl("serverDomain", r.serverDomain);
  if (!/^[0-9a-f]{64}$/.test(r.stkPubHex)) throw new Error("stkPubHex must be 32-byte lowercase hex");
  if (!/^[0-9a-f]{32}$/.test(r.nonceHex)) throw new Error("nonceHex must be 16-byte lowercase hex");
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return new TextEncoder().encode([
    TAG_BOX_READ_TOKEN_REQUEST,
    r.username.toLowerCase(),
    r.serverDomain.toLowerCase(),
    r.stkPubHex,
    r.issuedAt,
    r.nonceHex,
  ].join("|"));
}

export function signBoxReadTokenRequest(r: BoxReadTokenRequest, signer: MsgSigner): string {
  return hex(resolveMsgSigner(signer)(canonicalBoxReadTokenRequest(r)));
}

export function verifyBoxReadTokenRequest(r: BoxReadTokenRequest, signatureHex: string, stkPub: Bytes): boolean {
  try {
    if (!/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
    return ed.verify(sig, canonicalBoxReadTokenRequest(r), stkPub);
  } catch {
    return false;
  }
}
