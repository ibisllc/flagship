/**
 * The box key a device seals secrets to (disk-key replies, leases, SWK/CGK and
 * pairing deposits) is pinned on the device, per server, the first time the
 * device learns it. `.com`'s `/pods` echo is never enough on its own after
 * that: a different key is refused until the owner re-pins it (creating or
 * reinstalling that server on this device, or a confirmed "trust its new
 * key"), so a `.com` that turns hostile later can't swap in its own key.
 *
 * A box's boot-only key (the key a box uses before its disk unlocks) is
 * accepted only through a binding the pinned STK signs:
 *
 *   flagship/boot-key-binding/v1|<serverDomain>|<bootPubHex>|<issuedAt>
 *
 * Shared vectors: packages/protocol/test-vectors/box-key-pin/vectors.json
 * (TS, webapp, Swift, Kotlin).
 */
import { ed } from "./edSync.js";
import { legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import { PqTrustError, verifyPqKeyBinding } from "./pqTrust.js";
import type { Bytes } from "./types.js";

export type BoxKeyPinVerdict = "first" | "match" | "mismatch" | "invalid";

const HEX32 = /^[0-9a-f]{64}$/;

/** What a device does with the box key it was just given for a server. */
export function decideBoxKeyPin(pinnedHex: string | null | undefined, reportedHex: string): BoxKeyPinVerdict {
  const reported = String(reportedHex ?? "").toLowerCase();
  if (!HEX32.test(reported)) return "invalid";
  if (!pinnedHex) return "first";
  return pinnedHex.toLowerCase() === reported ? "match" : "mismatch";
}

export interface BootKeyBinding {
  serverDomain: string;
  bootPubHex: string;
  issuedAt: number;
}

export const TAG_BOOT_KEY_BINDING = "flagship/boot-key-binding/v1";

export function canonicalBootKeyBinding(b: BootKeyBinding): Bytes {
  legacyFieldGuard("serverDomain", b.serverDomain);
  if (!HEX32.test(b.bootPubHex)) throw new Error("bootPubHex must be 32 bytes of lowercase hex");
  if (!Number.isSafeInteger(b.issuedAt) || b.issuedAt < 0) throw new Error("issuedAt must be a non-negative integer");
  return new TextEncoder().encode(
    [TAG_BOOT_KEY_BINDING, b.serverDomain.toLowerCase(), b.bootPubHex, String(b.issuedAt)].join("|"),
  );
}

export function signBootKeyBinding(b: BootKeyBinding, stk: MsgSigner): Bytes {
  return resolveMsgSigner(stk)(canonicalBootKeyBinding(b));
}

/** True only when the binding names `serverDomain` and the PINNED STK signed it. */
export function verifyBootKeyBinding(
  b: BootKeyBinding,
  signature: Bytes,
  pinnedStkPub: Bytes,
  serverDomain: string,
): boolean {
  try {
    if (b.serverDomain.toLowerCase() !== serverDomain.toLowerCase()) return false;
    return ed.verify(signature, canonicalBootKeyBinding(b), pinnedStkPub);
  } catch {
    return false;
  }
}

/**
 * Architecture v2: a box's STK binds an ML-DSA-65 key (pqTrust.ts, role `box-stk`). A device
 * accepts that binding only under the STK it PINNED, pins the ML-DSA key the first time, and
 * treats a binding naming another ML-DSA key as a key change (the owner must re-pin). Once an
 * ML-DSA key is pinned, the device requires the boot-key binding's v2 hybrid signature too.
 */
export type BoxPqKeyPinVerdict =
  | { verdict: "first" | "match"; mldsaPubHex: string; issuedAt: number }
  | { verdict: "mismatch" | "invalid"; code: string };

export function decideBoxPqKeyPin(
  pin: { stkHex: string; mldsaPubHex?: string | null; minIssuedAt?: number },
  serverDomain: string,
  wire: unknown,
  now: number,
): BoxPqKeyPinVerdict {
  try {
    const b = verifyPqKeyBinding(wire, {
      role: "box-stk",
      subjectId: serverDomain.toLowerCase(),
      ed25519PubHex: pin.stkHex,
      mldsaPubHex: pin.mldsaPubHex ?? null,
      now,
      ...(pin.minIssuedAt !== undefined ? { minIssuedAt: pin.minIssuedAt } : {}),
    });
    return { verdict: pin.mldsaPubHex ? "match" : "first", mldsaPubHex: b.mldsaPubHex, issuedAt: b.issuedAt };
  } catch (e) {
    const code = e instanceof PqTrustError ? e.code : "binding-malformed";
    return { verdict: code === "binding-pq-key-changed" ? "mismatch" : "invalid", code };
  }
}
