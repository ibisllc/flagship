/**
 * Entitlement-revocation list endpoints (N12c).
 *
 *   POST /api/cert-revocations
 *     IRK-signed `EntitlementRevocationList`. Replaces the user's
 *     stored list iff issuedAt is monotonically newer.
 *
 *   GET /api/cert-revocations/<username>
 *     Returns the current list + IRK signature so .services can
 *     re-verify locally without trusting the Worker as an oracle.
 *
 * Per the architectural call: the Worker is just a sturdy mailbox
 * for the phone-signed list. .services pulls per-user with a 5-min
 * cache and applies the list at HELLO time.
 */

import {
  verifyEntitlementRevocationList,
  type EntitlementRevocationList,
} from "@flagship/protocol";
import type {
  EntitlementRevocationStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponse,
} from "./types.js";

export interface EntitlementRevocationsDeps {
  storage: EntitlementRevocationStorage;
  usernames: UsernameStorage;
  /** Replay window for issuedAt (default 30d — phones can be offline). */
  maxAgeMs?: number;
  now?: () => number;
}

interface PostBody {
  request?: Partial<EntitlementRevocationList>;
  signature?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export async function handlePostEntitlementRevocations(
  deps: EntitlementRevocationsDeps,
  body: PostBody | undefined,
): Promise<HandlerResponse> {
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    !Array.isArray(r.certIds) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  for (const id of r.certIds) {
    if (typeof id !== "string" || !HEX64.test(id)) {
      return malformed("certIds must be 32-byte hex");
    }
  }
  const userRec = await deps.usernames.get(r.username);
  if (!userRec) return notFound("username not registered");

  const list: EntitlementRevocationList = {
    username: r.username,
    certIds: r.certIds as string[],
    issuedAt: r.issuedAt,
  };
  let sig: Uint8Array;
  let irkPub: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
    irkPub = hexToBytes(userRec.irkPubHex);
  } catch {
    return malformed("invalid hex");
  }
  if (!verifyEntitlementRevocationList(list, sig, irkPub)) {
    return forbidden("invalid IRK signature");
  }
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = deps.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  if (Math.abs(now - list.issuedAt) > maxAgeMs) {
    return forbidden("issuedAt outside replay window");
  }
  const result = await deps.storage.putIfNewer({
    username: list.username,
    certIdsJson: JSON.stringify(list.certIds),
    irkSignatureHex: body.signature,
    issuedAt: list.issuedAt,
    updatedAt: now,
  });
  if (!result.accepted) {
    return conflict("a newer list is already on record");
  }
  return ok({ ok: true, count: list.certIds.length, issuedAt: list.issuedAt });
}

export async function handleGetEntitlementRevocations(
  deps: EntitlementRevocationsDeps,
  username: string,
): Promise<HandlerResponse> {
  const rec = await deps.storage.get(username);
  if (!rec) {
    return ok({
      username,
      certIds: [] as string[],
      issuedAt: 0,
      signature: null,
    });
  }
  let certIds: string[] = [];
  try {
    const parsed = JSON.parse(rec.certIdsJson);
    if (Array.isArray(parsed)) certIds = parsed.filter((s) => typeof s === "string");
  } catch {
    /* corrupt row → treat as empty */
  }
  return ok({
    username: rec.username,
    certIds,
    issuedAt: rec.issuedAt,
    signature: rec.irkSignatureHex,
  });
}
