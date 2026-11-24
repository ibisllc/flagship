import { isAcceptableEd25519PublicKey } from "@flagship/protocol";
import type { HandlerResponseWithHeaders } from "./types.js";

/**
 * `.com` never stores or vouches for an Ed25519 key that is not canonical or is of small order: anyone can sign
 * under such a key (test-vectors/ed25519-low-order). Verifies through `ed` already refuse them; this covers keys
 * taken on someone else's signature (a device grant, a delegate, a rotation's new root). No honest client sends one.
 */
export function badEd25519Key(...keys: (string | undefined)[]): HandlerResponseWithHeaders | null {
  for (const k of keys) {
    if (k !== undefined && !isAcceptableEd25519PublicKey(k)) {
      return { status: 400, body: { error: "not a usable Ed25519 public key", code: "bad-public-key" } };
    }
  }
  return null;
}
