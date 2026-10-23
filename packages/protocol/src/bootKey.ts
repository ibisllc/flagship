/**
 * The box boot key: a second Ed25519 key, kept on the unencrypted /boot
 * partition, that does only the jobs which must happen before the disk is
 * open. It signs the boot worker requests (lease fetch, unlock request, reply
 * poll) and it is the recipient that unlock replies and auto-unlock leases are
 * sealed to. The STK (the box identity that authorizes everything after boot)
 * stays inside the encrypted root, so a copy of /boot no longer yields it.
 *
 * The STK vouches for the boot key once, with a binding:
 *
 *   flagship/boot-key-binding/v1|<serverDomain>|<stkPub hex>|<bootKeyPub hex>|<issuedAt>
 *
 * signed by the STK. `.com` stores it, the boot worker accepts boot-key
 * signatures only through a binding that verifies under the server's current
 * STK, and a phone seals to a boot key only after verifying the binding under
 * the STK it trusts. A boot key on /boot is still readable by whoever holds the
 * powered-off disk: this limits what that copy can do, it does not hide it
 * (TPM sealing, plan N10, is what would).
 */

import { ed } from "./edSync.js";
import { assertCanonicalField, hex, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_BOOT_KEY_BINDING = "flagship/boot-key-binding/v1";

export interface BootKeyBinding {
  serverDomain: string;
  stkPub: Bytes;
  bootKeyPub: Bytes;
  issuedAt: number;
}

/** The JSON shape on the wire (hex fields), as `.com` stores and serves it. */
export interface BootKeyBindingWire {
  binding: { serverDomain: string; stkPub: string; bootKeyPub: string; issuedAt: number };
  signature: string;
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

export function canonicalBootKeyBinding(b: BootKeyBinding): Bytes {
  assertCanonicalField(b.serverDomain, "boot-key-binding", "serverDomain");
  if (b.stkPub.length !== 32 || b.bootKeyPub.length !== 32) throw new Error("boot-key-binding: keys must be 32 bytes");
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0) throw new Error("boot-key-binding: bad issuedAt");
  return new TextEncoder().encode(
    [TAG_BOOT_KEY_BINDING, b.serverDomain, hex(b.stkPub), hex(b.bootKeyPub), b.issuedAt].join("|"),
  );
}

/** Signed by the STK (a raw key, or keyd's signer). */
export function signBootKeyBinding(b: BootKeyBinding, stk: MsgSigner): Bytes {
  return resolveMsgSigner(stk)(canonicalBootKeyBinding(b));
}

/**
 * True when `sig` is the STK's signature over the binding and the binding names
 * two different keys. Callers must still check that `stkPub` is the STK they
 * trust for `serverDomain` (use {@link verifiedBootKey}).
 */
export function verifyBootKeyBinding(b: BootKeyBinding, sig: Bytes): boolean {
  try {
    if (sig.length !== 64) return false;
    if (hex(b.stkPub) === hex(b.bootKeyPub)) return false;
    return ed.verify(sig, canonicalBootKeyBinding(b), b.stkPub);
  } catch {
    return false;
  }
}

export function bootKeyBindingToWire(b: BootKeyBinding, sig: Bytes): BootKeyBindingWire {
  return {
    binding: { serverDomain: b.serverDomain, stkPub: hex(b.stkPub), bootKeyPub: hex(b.bootKeyPub), issuedAt: b.issuedAt },
    signature: hex(sig),
  };
}

/** Parse the wire shape strictly; null on any structural problem. */
export function bootKeyBindingFromWire(w: unknown): { binding: BootKeyBinding; signature: Bytes } | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const b = o.binding as Record<string, unknown> | undefined;
  if (typeof b !== "object" || b === null) return null;
  if (
    typeof b.serverDomain !== "string" ||
    typeof b.stkPub !== "string" ||
    typeof b.bootKeyPub !== "string" ||
    typeof b.issuedAt !== "number" ||
    typeof o.signature !== "string"
  ) {
    return null;
  }
  const stk = b.stkPub.toLowerCase();
  const boot = b.bootKeyPub.toLowerCase();
  const sig = o.signature.toLowerCase();
  if (!HEX32.test(stk) || !HEX32.test(boot) || !HEX64.test(sig)) return null;
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0) return null;
  return {
    binding: { serverDomain: b.serverDomain, stkPub: fromHex(stk), bootKeyPub: fromHex(boot), issuedAt: b.issuedAt },
    signature: fromHex(sig),
  };
}

/**
 * The boot key pub (lowercase hex) that `wire` binds to `stkPubHex` for
 * `serverDomain`, or null when the binding is for another server, another STK,
 * or does not verify.
 */
export function verifiedBootKey(wire: unknown, expect: { serverDomain: string; stkPubHex: string }): string | null {
  const parsed = bootKeyBindingFromWire(wire);
  if (!parsed) return null;
  const { binding, signature } = parsed;
  if (binding.serverDomain.toLowerCase() !== expect.serverDomain.toLowerCase()) return null;
  if (hex(binding.stkPub) !== expect.stkPubHex.toLowerCase()) return null;
  if (!verifyBootKeyBinding(binding, signature)) return null;
  return hex(binding.bootKeyPub);
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
