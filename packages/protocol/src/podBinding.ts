/**
 * Pod identity binding (#89) — an IRK-signed attestation that a pod identity
 * pubkey is one of the user's pods (presented at sibling-WS handshakes).
 *
 * Extracted verbatim from the original monolithic `auth.ts`; tag, field
 * order, and guard are unchanged, so canonical bytes and signatures remain
 * byte-identical.
 */
import { ed } from "./edSync.js";
import { hex, validateNoSepCtrl } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// PodIdentityBinding (#89) — IRK-signed attestation that a pod identity
// pubkey is one of the user's pods. Issued at registration and stored
// on the pod's encrypted disk; presented at sibling-WS handshakes so
// other pods can verify locally (they know the same IRK pubkey via
// their shared UMK derivation) without round-tripping .com.
// ──────────────────────────────────────────────────────────────────────

export interface PodIdentityBinding {
  username: string;
  podIdentityPubKey: Bytes;
  serverDomain: string;
  registeredAt: number;
}

const TAG_POD_BINDING = "flagship/pod-binding/v1";

function canonicalPodIdentityBinding(b: PodIdentityBinding): Bytes {
  validateNoSepCtrl("username", b.username);
  validateNoSepCtrl("serverDomain", b.serverDomain);
  return new TextEncoder().encode(
    [TAG_POD_BINDING, b.username, hex(b.podIdentityPubKey), b.serverDomain, b.registeredAt].join("|"),
  );
}

export function signPodIdentityBinding(b: PodIdentityBinding, irk: Keypair): Bytes {
  return ed.sign(canonicalPodIdentityBinding(b), irk.privateKey);
}

export function verifyPodIdentityBinding(b: PodIdentityBinding, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPodIdentityBinding(b), irkPub);
  } catch {
    return false;
  }
}
