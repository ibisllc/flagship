// Org read tokens (docs/account-read-token.md "Org routes", docs/enterprise-accounts.md §6, §7).
//
// `.com` serves an org's private reads (`/api/orgs/<orgId>/...`) to a bearer of an org read
// token. A token is minted at `POST /api/orgs/<orgId>/read-token` with an `OrgReadTokenRequest`
// signed (Ed25519) by one of:
//
//   - a seat: its seat member key, or its seat admin key (an org admin holds only that one);
//     subject `seat:<seatId>`;
//   - one of the org's servers: its STK; subject `box:<serverDomain>`.
//
// The token itself is opaque to every client: only `.com` reads it.

import { ed, edVerifyFast } from "./edSync.js";
import { hex, validateNoSepCtrl, type MsgSigner, resolveMsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_ORG_READ_TOKEN_REQUEST = "flagship/org-read-token-request/v1";

export function orgReadTokenPath(orgId: string): string {
  return `/api/orgs/${orgId.toLowerCase()}/read-token`;
}

export interface OrgReadTokenRequest {
  /** 16 bytes, lowercase hex. */
  orgId: string;
  /** `seat:<seatId>` (32 hex) or `box:<serverDomain>`. */
  subject: string;
  /** The signing key, 32-byte lowercase hex. */
  pubHex: string;
  issuedAt: number;
  /** 16 random bytes, lowercase hex: the replay handle. */
  nonceHex: string;
}

const SEAT_SUBJECT = /^seat:[0-9a-f]{32}$/;
const BOX_SUBJECT = /^box:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

export function orgSeatReadSubject(seatId: string): string {
  return `seat:${seatId.toLowerCase()}`;
}

export function orgBoxReadSubject(serverDomain: string): string {
  return `box:${serverDomain.toLowerCase()}`;
}

export function canonicalOrgReadTokenRequest(r: OrgReadTokenRequest): Bytes {
  if (typeof r.orgId !== "string" || !/^[0-9a-f]{32}$/.test(r.orgId)) throw new Error("orgId must be 16-byte lowercase hex");
  if (typeof r.subject !== "string") throw new Error("subject must be a string");
  validateNoSepCtrl("subject", r.subject);
  if (!SEAT_SUBJECT.test(r.subject) && !BOX_SUBJECT.test(r.subject)) throw new Error("subject must be seat:<seatId> or box:<serverDomain>");
  if (typeof r.pubHex !== "string" || !/^[0-9a-f]{64}$/.test(r.pubHex)) throw new Error("pubHex must be 32-byte lowercase hex");
  if (typeof r.nonceHex !== "string" || !/^[0-9a-f]{32}$/.test(r.nonceHex)) throw new Error("nonceHex must be 16-byte lowercase hex");
  if (!Number.isSafeInteger(r.issuedAt) || r.issuedAt <= 0) throw new Error("issuedAt must be positive");
  return new TextEncoder().encode([TAG_ORG_READ_TOKEN_REQUEST, r.orgId, r.subject, r.pubHex, r.issuedAt, r.nonceHex].join("|"));
}

export function signOrgReadTokenRequest(r: OrgReadTokenRequest, signer: MsgSigner): string {
  return hex(resolveMsgSigner(signer)(canonicalOrgReadTokenRequest(r)));
}

function sigBytes(signatureHex: string): Uint8Array | null {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(signatureHex)) return null;
  const sig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) sig[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
  return sig;
}

/** `verifyOrgReadTokenRequest`, with the native Ed25519 check where the runtime has it. */
export async function verifyOrgReadTokenRequestFast(r: OrgReadTokenRequest, signatureHex: string, pub: Bytes): Promise<boolean> {
  try {
    const sig = sigBytes(signatureHex);
    return !!sig && (await edVerifyFast(sig, canonicalOrgReadTokenRequest(r), pub));
  } catch {
    return false;
  }
}

export function verifyOrgReadTokenRequest(r: OrgReadTokenRequest, signatureHex: string, pub: Bytes): boolean {
  try {
    const sig = sigBytes(signatureHex);
    return !!sig && ed.verify(sig, canonicalOrgReadTokenRequest(r), pub);
  } catch {
    return false;
  }
}
