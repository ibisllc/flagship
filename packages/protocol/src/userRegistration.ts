/**
 * User registration — `RegisterUser` (`flagship/register-user/v1`), the
 * stable-named IRK→username binding the mobile clients use.
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tag, field
 * order, and guard are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// User registration (RegisterUser canonical-bytes)
//
// Adjacent to the existing `username/claim` flow. Whereas claim is for
// the very first IRK→username binding, RegisterUser is the same envelope
// but kept as a stable name across mobile clients. Functionally a thin
// alias. v2 may extend with display-name + push-token fields.
// ──────────────────────────────────────────────────────────────────────

export interface RegisterUser {
  username: string;
  irkPub: Bytes;
  issuedAt: number;
}

const TAG_REGISTER_USER = "flagship/register-user/v1";

function canonicalRegisterUser(r: RegisterUser): Bytes {
  legacyFieldGuard("username", r.username);
  return new TextEncoder().encode(
    [TAG_REGISTER_USER, r.username, hex(r.irkPub), r.issuedAt].join("|"),
  );
}

export function signRegisterUser(r: RegisterUser, irk: Keypair): Bytes {
  return ed.sign(canonicalRegisterUser(r), irk.privateKey);
}

export function verifyRegisterUser(r: RegisterUser, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalRegisterUser(r), irkPub);
  } catch {
    return false;
  }
}
