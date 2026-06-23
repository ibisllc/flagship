/**
 * Embedded / sealed `add-paired-session` order helpers — the SECRET-FREE pairing
 * path (the twin of swkDelivery.ts, for the paired-session token instead of the
 * SWK).
 *
 * Background. The first recipe used to embed `pairingKeyPrivHex` — a phone-minted
 * pairing keypair's PRIVATE half — purely so the box could OPEN a `.com`-deposited,
 * owner-IRK-signed `add-paired-session` order at first boot and auto-pair. That was
 * a SECRET in the recipe. We remove it. Two secret-free modes both eliminate the
 * pairing keypair:
 *
 *   DEFAULT (online):  the recipe carries NO pairing material at all. The phone
 *     deposits the `add-paired-session` order SEALED to the box's IDENTITY pub
 *     (read from `/pods` post-registration) into the EXISTING `.com` pairing-deposit
 *     lane; the box opens it with its identity key.  (No code here — the deposit
 *     carrier is just the sealed `{request,signature}` JSON, opened by
 *     `openPairingOrderEnvelope`.)
 *
 *   OFFLINE (advanced/embed):  the recipe embeds the owner-IRK-signed
 *     `add-paired-session` order in PLAINTEXT — `{request, signature}` — as an
 *     UNSIGNED recipe sibling (exactly like `swkHex`). The box reads it at boot,
 *     verifies the owner-IRK signature under `cfg.irkPublicKey`, and adds the
 *     session LOCALLY with no `.com` call.
 *
 * The order itself + its canonical bytes + `sealForEd25519Recipient` already exist
 * (`orders.ts` / `encryption.ts`). This module only adds the small,
 * never-throwing parse/verify/extract helpers the daemon needs so BOTH paths share
 * one validation chokepoint and the later native agent has a pinned wire shape to
 * match.
 *
 * Wire shape (both the embedded sibling AND the inner plaintext of the sealed
 * deposit), UTF-8 JSON:
 *
 *   {
 *     "request":   { "type":"add-paired-session", "serverId":"<fqdn>",
 *                    "token":"<hex>", "label":"<name>", "issuedAt":<ms> },
 *     "signature": "<hex Ed25519 over canonicalPhoneOrder(request), by the owner IRK>"
 *   }
 */
import { hex } from "./canonicalBase.js";
import { verifyPhoneOrder } from "./orders.js";
import type { PhoneOrder } from "./orders.js";
import type { Bytes } from "./types.js";

const HEX = /^[0-9a-f]+$/;

/** The plaintext `add-paired-session` envelope (the wire form, parsed). */
export interface PairingOrderEnvelope {
  /** The `add-paired-session` PhoneOrder. */
  request: Extract<PhoneOrder, { type: "add-paired-session" }>;
  /** Owner-IRK Ed25519 signature over `canonicalPhoneOrder(request)`. */
  signature: Bytes;
}

function hexToBytes(h: string): Bytes {
  if (h.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Serialize a built `add-paired-session` order + its owner-IRK signature into the
 * plaintext envelope JSON STRING (UTF-8). This is what the phone embeds as the
 * recipe's unsigned `pairingOrder` sibling (offline mode), or seals into the `.com`
 * pairing-deposit lane (default mode). Mirrors how the swk carrier is serialized,
 * but the payload here is PUBLIC (an IRK-signed order, not a secret), so the
 * embedded form is plaintext.
 */
export function pairingOrderToJson(
  request: Extract<PhoneOrder, { type: "add-paired-session" }>,
  signature: Bytes,
): string {
  return JSON.stringify({
    request: {
      type: request.type,
      serverId: request.serverId,
      token: request.token,
      label: request.label,
      issuedAt: request.issuedAt,
    },
    signature: hex(signature),
  });
}

/**
 * Parse a `{request, signature}` JSON envelope (a STRING) into a typed
 * `PairingOrderEnvelope`, validating shape ONLY (NOT the signature). Returns null
 * on any defect — never throws. The caller then runs `verifyPairingOrderEnvelope`
 * against the owner IRK.
 */
export function parsePairingOrderEnvelope(json: string): PairingOrderEnvelope | null {
  let p: unknown;
  try {
    p = JSON.parse(json);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object") return null;
  const o = p as { request?: unknown; signature?: unknown };
  if (typeof o.signature !== "string" || !HEX.test(o.signature.toLowerCase()) ||
      o.signature.length === 0 || o.signature.length % 2 !== 0) {
    return null;
  }
  const r = o.request as Record<string, unknown> | undefined;
  if (
    !r ||
    r.type !== "add-paired-session" ||
    typeof r.serverId !== "string" ||
    typeof r.token !== "string" ||
    typeof r.label !== "string" ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return {
    request: {
      type: "add-paired-session",
      serverId: r.serverId,
      token: r.token,
      label: r.label,
      issuedAt: r.issuedAt,
    },
    signature: hexToBytes(o.signature.toLowerCase()),
  };
}

/**
 * Verify a parsed envelope: the owner-IRK signature must cover the order's
 * canonical bytes AND the order must name `expectedServerId` (so a relay/`.com`
 * can't re-target the pairing to a different box). Never throws.
 */
export function verifyPairingOrderEnvelope(
  env: PairingOrderEnvelope,
  ownerIrkPub: Bytes,
  expectedServerId: string,
): boolean {
  if (env.request.serverId.toLowerCase() !== expectedServerId.toLowerCase()) return false;
  return verifyPhoneOrder(env.request, env.signature, ownerIrkPub);
}

/**
 * One-call parse + verify. Given the plaintext envelope JSON (the embedded sibling,
 * OR the unsealed inner plaintext of a `.com` deposit), return the verified
 * `add-paired-session` order — or null on any defect (bad JSON / shape / signature /
 * wrong box). Never throws. The daemon adds the session ONLY on a non-null result.
 */
export function openPairingOrderEnvelope(args: {
  json: string;
  ownerIrkPub: Bytes;
  expectedServerId: string;
}): Extract<PhoneOrder, { type: "add-paired-session" }> | null {
  const env = parsePairingOrderEnvelope(args.json);
  if (!env) return null;
  if (!verifyPairingOrderEnvelope(env, args.ownerIrkPub, args.expectedServerId)) return null;
  return env.request;
}
