/**
 * `POST /api/time` (architecture v2, pq-suites.md §17): the time, signed with the CA operational
 * key over the box's nonce, for a box whose own clock it cannot trust at boot. Anonymous on
 * purpose (a box asks before it has any session); the answer says nothing about any account.
 */
import { signSignedTime } from "@flagship/protocol";
import type { CaIssuer } from "./pubkeyCert.js";
import { malformed, ok, type HandlerResponse } from "./types.js";

export function handleSignedTime(
  deps: { ca: CaIssuer; now?: () => number },
  body: unknown,
): HandlerResponse {
  const nonce = (body as { nonce?: unknown } | null)?.nonce;
  if (typeof nonce !== "string" || !/^[0-9a-f]{64}$/.test(nonce)) return malformed("nonce must be 32-byte lowercase hex");
  return ok(signSignedTime(nonce, (deps.now ?? Date.now)(), deps.ca.keypair.privateKey));
}
