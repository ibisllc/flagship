import { verifyClaimUsername, type ClaimUsername } from "@flagship/protocol";
import type { UsernameStorage } from "@flagship/storage";
import { HEX128, HEX64, hexToBytes, bytesToHex } from "./hex.js";
import { validateUserLabel } from "./labels.js";
import { conflict, forbidden, malformed, notFound, ok } from "./types.js";
import type { HandlerResponseWithHeaders } from "./types.js";

export interface UsernameClaimDeps {
  storage: UsernameStorage;
  freshnessMs?: number;
  now?: () => number;
}

export interface UsernameClaimBody {
  request?: { username?: string; irkPub?: string; issuedAt?: number };
  signature?: string;
}

export async function handleUsernameClaim(
  deps: UsernameClaimDeps,
  body: UsernameClaimBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const now = (deps.now ?? (() => Date.now()))();
  const r = body?.request;
  if (
    !r ||
    typeof r.username !== "string" ||
    typeof r.irkPub !== "string" ||
    !HEX64.test(r.irkPub) ||
    typeof r.issuedAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }

  let irkPub: Uint8Array;
  let sig: Uint8Array;
  try {
    irkPub = hexToBytes(r.irkPub);
    sig = hexToBytes(body.signature);
  } catch {
    return malformed("invalid hex");
  }

  const claim: ClaimUsername = { username: r.username, irkPub, issuedAt: r.issuedAt };
  if (!verifyClaimUsername(claim, sig, irkPub)) return forbidden("invalid signature");
  if (Math.abs(now - r.issuedAt) > freshnessMs) return forbidden("stale request");

  const v = validateUserLabel(r.username);
  if (!v.ok) return malformed(v.reason);

  const out = await deps.storage.put({
    username: v.label,
    irkPubHex: bytesToHex(irkPub),
    claimedAt: now,
  });
  if (!out.ok) return conflict(out.reason);
  return ok({ ok: true, username: v.label });
}

export async function handleUsernameLookup(
  storage: UsernameStorage,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const rec = await storage.get(username);
  if (!rec) return notFound("not found");
  return ok({
    username: rec.username,
    irkPub: rec.irkPubHex,
    claimedAt: rec.claimedAt,
  });
}
