/**
 * The box boot key: a second Ed25519 key, kept on the unencrypted /boot
 * partition, that does only the jobs which must happen before the disk is
 * open. It signs the boot worker requests (lease fetch, unlock request, reply
 * poll) and it is the recipient that unlock replies and auto-unlock leases are
 * sealed to. The STK (the box identity that authorizes everything after boot)
 * stays inside the encrypted root, so a copy of /boot no longer yields it.
 *
 * The STK vouches for the boot key once, with the binding defined in
 * boxKeyPin.ts (`flagship/boot-key-binding/v1|<serverDomain>|<bootPubHex>|<issuedAt>`,
 * signed by the STK). `.com` stores it, the boot worker accepts boot-key
 * signatures only through a binding that verifies under the server's current
 * STK, and a phone seals to a boot key only after verifying the binding under
 * the STK it has pinned. A boot key on /boot is still readable by whoever holds
 * the powered-off disk: this limits what that copy can do, it does not hide it
 * (TPM sealing, plan N10, is what would).
 *
 * This module adds the wire shape `.com` stores and serves:
 *   { binding: { serverDomain, bootPubHex, issuedAt }, signature, hybridSignature? }
 *
 * `hybridSignature` (architecture v2, pq-suites.md §10.3) is the STK's hybrid key
 * (Ed25519 STK AND its bound ML-DSA-65 key) signing the same fields under the
 * v2 tag: `flagship/boot-key-binding/v2|<serverDomain>|<bootPubHex>|<issuedAt>`.
 * A v1 reader ignores it; a strict verifier requires it, through the gate.
 */

import { verifyBootKeyBinding, type BootKeyBinding } from "./boxKeyPin.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { PolicyState } from "./assurancePolicy.js";
import { verifyCriticalSignature, type HybridMsgSigner, type VerifiedPqKeyBinding } from "./pqTrust.js";
import type { Bytes } from "./types.js";

export interface BootKeyBindingWire {
  binding: BootKeyBinding;
  signature: string;
  hybridSignature?: string;
}

export const TAG_BOOT_KEY_BINDING_V2 = "flagship/boot-key-binding/v2";

export function canonicalBootKeyBindingV2(b: BootKeyBinding): Bytes {
  legacyFieldGuard("serverDomain", b.serverDomain);
  if (!HEX32.test(b.bootPubHex)) throw new Error("bootPubHex must be 32 bytes of lowercase hex");
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0) throw new Error("issuedAt must be a non-negative integer");
  return new TextEncoder().encode([TAG_BOOT_KEY_BINDING_V2, b.serverDomain.toLowerCase(), b.bootPubHex, String(b.issuedAt)].join("|"));
}

export function signBootKeyBindingV2(b: BootKeyBinding, stkHybrid: HybridMsgSigner): Bytes {
  return stkHybrid(canonicalBootKeyBindingV2(b));
}

const HEX_HYBRID_SIG = /^[0-9a-f]{6746}$/;

/**
 * The boot key `wire` binds, checked through the critical-signature gate: the v1 STK signature
 * always, and the v2 hybrid signature under the STK's verified binding whenever it is present
 * or the scope is strict. Null on any refusal.
 */
export function verifiedBootKeyGated(
  wire: unknown,
  expect: { serverDomain: string; stkPubHex: string; stkBinding: VerifiedPqKeyBinding | null; policy: PolicyState },
): { bootPubHex: string; hybrid: boolean } | null {
  const boot = verifiedBootKey(wire, expect);
  if (!boot) return null;
  const parsed = bootKeyBindingFromWire(wire)!;
  const h = (wire as { hybridSignature?: unknown }).hybridSignature;
  const stk = expect.stkPubHex.toLowerCase();
  try {
    if (h === undefined) {
      verifyCriticalSignature({
        message: new TextEncoder().encode(
          ["flagship/boot-key-binding/v1", parsed.binding.serverDomain.toLowerCase(), parsed.binding.bootPubHex, String(parsed.binding.issuedAt)].join("|"),
        ),
        expectedPurpose: "flagship/boot-key-binding/v1",
        envelope: { suite: "ed25519/v1", signature: hex(parsed.signature) },
        signerEd25519PubHex: stk,
        binding: expect.stkBinding,
        policy: expect.policy,
      });
      return { bootPubHex: boot, hybrid: false };
    }
    if (typeof h !== "string" || !HEX_HYBRID_SIG.test(h)) return null;
    verifyCriticalSignature({
      message: canonicalBootKeyBindingV2(parsed.binding),
      expectedPurpose: TAG_BOOT_KEY_BINDING_V2,
      envelope: { suite: "hybrid-ed25519-mldsa65/v1", signature: h },
      signerEd25519PubHex: stk,
      binding: expect.stkBinding,
      policy: expect.policy,
    });
    return { bootPubHex: boot, hybrid: true };
  } catch {
    return null;
  }
}

const HEX32 = /^[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{128}$/;

export function bootKeyBindingToWire(b: BootKeyBinding, sig: Bytes, hybridSig?: Bytes): BootKeyBindingWire {
  return {
    binding: { serverDomain: b.serverDomain.toLowerCase(), bootPubHex: b.bootPubHex.toLowerCase(), issuedAt: b.issuedAt },
    signature: hex(sig),
    ...(hybridSig ? { hybridSignature: hex(hybridSig) } : {}),
  };
}

/** Parse the wire shape strictly (hex lower-cased); null on any structural problem. */
export function bootKeyBindingFromWire(w: unknown): { binding: BootKeyBinding; signature: Bytes } | null {
  if (typeof w !== "object" || w === null) return null;
  const o = w as Record<string, unknown>;
  const b = o.binding as Record<string, unknown> | undefined;
  if (typeof b !== "object" || b === null) return null;
  if (typeof b.serverDomain !== "string" || typeof b.bootPubHex !== "string" || typeof b.issuedAt !== "number" || typeof o.signature !== "string") {
    return null;
  }
  const boot = b.bootPubHex.toLowerCase();
  const sig = o.signature.toLowerCase();
  if (!HEX32.test(boot) || !HEX64.test(sig)) return null;
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0) return null;
  return { binding: { serverDomain: b.serverDomain, bootPubHex: boot, issuedAt: b.issuedAt }, signature: fromHex(sig) };
}

/**
 * The boot key pub (lowercase hex) that `wire` binds to `stkPubHex` for
 * `serverDomain`, or null when the binding is for another server, was not
 * signed by that STK, or names the STK itself.
 */
export function verifiedBootKey(wire: unknown, expect: { serverDomain: string; stkPubHex: string }): string | null {
  const parsed = bootKeyBindingFromWire(wire);
  const stk = expect.stkPubHex.toLowerCase();
  if (!parsed || !HEX32.test(stk)) return null;
  if (parsed.binding.bootPubHex === stk) return null;
  return verifyBootKeyBinding(parsed.binding, parsed.signature, fromHex(stk), expect.serverDomain)
    ? parsed.binding.bootPubHex
    : null;
}

function fromHex(s: string): Bytes {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
