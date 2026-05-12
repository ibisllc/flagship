/**
 * Username handover (#93). The user can rename their account, with
 * the OLD username permanently consumed (never re-issuable) and
 * resolvable via an alias map for the life of the project.
 *
 * Why permanent-consume? Old invite links contain the OLD username.
 * Re-issuing that name to anyone else means stale links resolve to a
 * different person — a real security regression. Permanent consumption
 * + an indefinitely-resolvable alias map closes that path while still
 * letting the new owner of the account use their preferred handle.
 *
 *   POST /api/username/rename
 *     IRK-signed { oldUsername, newUsername, effectiveAt }.
 *
 *   GET /api/username/alias/<username>
 *     Returns { resolved, isAlias, chain }. Public, no signature.
 */

import {
  verifyUsernameRename,
  type UsernameRename,
} from "@flagship/protocol";
import type {
  UsernameAliasStorage,
  UsernameStorage,
} from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import {
  conflict,
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface UsernameHandoverDeps {
  usernames: UsernameStorage;
  aliases: UsernameAliasStorage;
  freshnessMs?: number;
  now?: () => number;
}

interface RenameBody {
  request?: Partial<UsernameRename>;
  signature?: string;
}

const HEX128 = /^[0-9a-f]{128}$/;

export async function handlePostUsernameRename(
  deps: UsernameHandoverDeps,
  body: RenameBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  const freshnessMs = deps.freshnessMs ?? 5 * 60_000;
  const r = body?.request;
  if (
    !r ||
    typeof r.oldUsername !== "string" ||
    typeof r.newUsername !== "string" ||
    typeof r.effectiveAt !== "number" ||
    typeof body?.signature !== "string" ||
    !HEX128.test(body.signature)
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - r.effectiveAt) > freshnessMs) {
    return malformed("stale request");
  }
  if (r.oldUsername === r.newUsername) {
    return malformed("oldUsername and newUsername are identical");
  }

  const oldRec = await deps.usernames.get(r.oldUsername);
  if (!oldRec) return notFound("oldUsername not registered");

  // Reject if newUsername has ever been used (current registration OR
  // alias source/destination). This is the load-bearing security
  // property — re-issuing a consumed name would let stale invite
  // links resolve to a different person.
  const existingNew = await deps.usernames.get(r.newUsername);
  if (existingNew) return conflict("newUsername already registered");
  const isConsumed = await deps.aliases.isConsumed(r.newUsername);
  if (isConsumed) return conflict("newUsername has been consumed by a prior rename");

  // Verify IRK signature against the existing username's IRK pubkey.
  const claim: UsernameRename = {
    oldUsername: r.oldUsername,
    newUsername: r.newUsername,
    effectiveAt: r.effectiveAt,
  };
  const sig = hexToBytes(body.signature);
  if (!verifyUsernameRename(claim, sig, hexToBytes(oldRec.irkPubHex))) {
    return forbidden("invalid IRK signature");
  }

  // Re-claim the new name with the SAME IRK pubkey (so the user
  // retains their identity) and record the alias.
  const putNew = await deps.usernames.put({
    username: r.newUsername,
    irkPubHex: oldRec.irkPubHex,
    claimedAt: r.effectiveAt,
  });
  if (!putNew.ok) return conflict(putNew.reason);

  const putAlias = await deps.aliases.put({
    oldUsername: r.oldUsername,
    newUsername: r.newUsername,
    effectiveAt: r.effectiveAt,
    signatureHex: body.signature,
  });
  if (!putAlias.ok) return conflict(putAlias.reason);

  // Note: we deliberately leave the OLD usernames row in place. The
  // /api/username/<old> endpoint will continue to resolve to the
  // user's IRK pubkey, which preserves cert verification for older
  // signed messages. The /api/username/alias/<old> endpoint signals
  // the alias relationship to clients that want to display the new
  // handle. After a 30-day operational window, callers should follow
  // the alias map (operationally enforced at the deployment layer).

  return ok({
    ok: true,
    oldUsername: r.oldUsername,
    newUsername: r.newUsername,
    effectiveAt: r.effectiveAt,
  });
}

export async function handleGetUsernameAlias(
  deps: UsernameHandoverDeps,
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const resolved = await deps.aliases.resolve(username);
  return ok({
    queried: username.toLowerCase(),
    resolved: resolved.current,
    isAlias: resolved.chain.length > 1,
    chain: resolved.chain,
  });
}
