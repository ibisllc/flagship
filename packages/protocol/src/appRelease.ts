/**
 * A publisher's signed release and the continuity of its key (SECURITY-HARDENING-PLAN.md 18.11, N11).
 *
 * A bundle fetched over TLS from the creator's pod proves who answered, not who published it. The
 * pod signs each release with its publisher key; the signature covers the exact package digest, the
 * permanent app identity, the version, and a digest of the authority the release asks for. A box
 * remembers the FIRST publisher key it verified for an app (a pin that outlives the app's data). A
 * later release under another key is refused unless the old key signed a rotation to the new one,
 * and even then the owner approves before the new key's code runs. A lost old key means a new
 * identity, which also needs approval and is labelled as such.
 *
 * Signatures prove the publisher and the bytes, never good intent.
 */
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard } from "./canonicalBase.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_APP_RELEASE = "flagship/app-release/v1";
export const TAG_PUBLISHER_ROTATION = "flagship/publisher-rotation/v1";
export const TAG_PUBLISHER_TRUST = "flagship/publisher-trust/v1";

export interface AppRelease {
  /** The permanent identity (`<creator>--<slug>` plus its generation); never a display name. */
  appId: string;
  /** Bumps when the identity is re-created (a retired name taken again): old pins never carry over. */
  identityGeneration: number;
  version: string;
  /** The commit (or bundle) digest the release is, lowercase hex. */
  packageDigestHex: string;
  capabilityDigestHex: string;
  /** Position of the signing key in this app's key history. */
  keyEpoch: number;
  issuedAt: number;
}

const HEX = /^[0-9a-f]{40,128}$/;

export function canonicalAppRelease(r: AppRelease): Bytes {
  legacyFieldGuard("appId", r.appId);
  legacyFieldGuard("version", r.version);
  if (!HEX.test(r.packageDigestHex)) throw new Error("packageDigestHex must be lowercase hex");
  if (!/^[0-9a-f]{64}$/.test(r.capabilityDigestHex)) throw new Error("capabilityDigestHex must be 64 lowercase hex characters");
  for (const [k, v] of [["identityGeneration", r.identityGeneration], ["keyEpoch", r.keyEpoch], ["issuedAt", r.issuedAt]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`bad ${k}`);
  }
  return new TextEncoder().encode([TAG_APP_RELEASE, r.appId, r.identityGeneration, r.version, r.packageDigestHex, r.capabilityDigestHex, r.keyEpoch, r.issuedAt].join("|"));
}

export function signAppRelease(r: AppRelease, key: Keypair): string {
  return hex(ed.sign(canonicalAppRelease(r), key.privateKey));
}

const unhex = (h: string): Bytes => Uint8Array.from((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

export function verifyAppRelease(r: AppRelease, signatureHex: string, publisherPubHex: string): boolean {
  try {
    return ed.verify(unhex(signatureHex), canonicalAppRelease(r), unhex(publisherPubHex));
  } catch {
    return false;
  }
}

export interface PublisherRotation {
  appId: string;
  identityGeneration: number;
  oldKeyHex: string;
  newKeyHex: string;
  /** The epoch the NEW key takes. */
  newEpoch: number;
  issuedAt: number;
}

export function canonicalPublisherRotation(r: PublisherRotation): Bytes {
  legacyFieldGuard("appId", r.appId);
  for (const k of ["oldKeyHex", "newKeyHex"] as const) if (!/^[0-9a-f]{64}$/.test(r[k])) throw new Error(`${k} must be 64 lowercase hex characters`);
  return new TextEncoder().encode([TAG_PUBLISHER_ROTATION, r.appId, r.identityGeneration, r.oldKeyHex, r.newKeyHex, r.newEpoch, r.issuedAt].join("|"));
}

export function signPublisherRotation(r: PublisherRotation, oldKey: Keypair): string {
  return hex(ed.sign(canonicalPublisherRotation(r), oldKey.privateKey));
}

export function verifyPublisherRotation(r: PublisherRotation, signatureHex: string): boolean {
  try {
    return ed.verify(unhex(signatureHex), canonicalPublisherRotation(r), unhex(r.oldKeyHex));
  } catch {
    return false;
  }
}

/** What the owner's device signs to trust a new publisher key for ONE service. */
export interface PublisherTrust {
  serviceId: string;
  appId: string;
  identityGeneration: number;
  /** The pinned key being replaced (`none` for a first use the owner confirms). */
  oldKeyHex: string;
  newKeyHex: string;
  newEpoch: number;
  issuedAt: number;
}

export function canonicalPublisherTrust(t: PublisherTrust): Bytes {
  legacyFieldGuard("serviceId", t.serviceId);
  legacyFieldGuard("appId", t.appId);
  return new TextEncoder().encode([TAG_PUBLISHER_TRUST, t.serviceId, t.appId, t.identityGeneration, t.oldKeyHex, t.newKeyHex, t.newEpoch, t.issuedAt].join("|"));
}

export function signPublisherTrust(t: PublisherTrust, owner: Keypair): string {
  return hex(ed.sign(canonicalPublisherTrust(t), owner.privateKey));
}

export function verifyPublisherTrust(t: PublisherTrust, signatureHex: string, ownerPub: Bytes): boolean {
  try {
    return ed.verify(unhex(signatureHex), canonicalPublisherTrust(t), ownerPub);
  } catch {
    return false;
  }
}

export interface PublisherPin {
  appId: string;
  identityGeneration: number;
  keyHex: string;
  keyEpoch: number;
  firstVerifiedAt: number;
}

export type PublisherVerdict =
  | { kind: "first-use"; pin: PublisherPin }
  | { kind: "same-key" }
  | { kind: "rotated"; continuity: "valid-chain"; from: PublisherPin; toKeyHex: string; toEpoch: number }
  | { kind: "new-identity"; continuity: "none"; from: PublisherPin; toKeyHex: string }
  | { kind: "reject"; reason: "bad-signature" | "wrong-app" | "new-generation" | "epoch-rollback" | "packaged-for-other-digest" };

/**
 * Judge a release against the pin. `chain` is the rotations the publisher offered, oldest first.
 * Nothing here applies a change of key: `rotated` and `new-identity` both stop for the owner.
 */
export function judgePublisher(
  pin: PublisherPin | null,
  release: AppRelease,
  signatureHex: string,
  publisherKeyHex: string,
  chain: Array<{ rotation: PublisherRotation; signatureHex: string }>,
  now: number,
  expectedPackageDigestHex?: string,
): PublisherVerdict {
  if (!verifyAppRelease(release, signatureHex, publisherKeyHex)) return { kind: "reject", reason: "bad-signature" };
  if (expectedPackageDigestHex && expectedPackageDigestHex !== release.packageDigestHex) return { kind: "reject", reason: "packaged-for-other-digest" };
  if (!pin) {
    return { kind: "first-use", pin: { appId: release.appId, identityGeneration: release.identityGeneration, keyHex: publisherKeyHex, keyEpoch: release.keyEpoch, firstVerifiedAt: now } };
  }
  if (pin.appId !== release.appId) return { kind: "reject", reason: "wrong-app" };
  // A new generation of the same name is a new identity: nothing carries over from the old one.
  if (release.identityGeneration !== pin.identityGeneration) return { kind: "reject", reason: "new-generation" };
  if (publisherKeyHex === pin.keyHex) {
    return release.keyEpoch < pin.keyEpoch ? { kind: "reject", reason: "epoch-rollback" } : { kind: "same-key" };
  }
  // Walk the chain from the pinned key to the signing key.
  let at = pin.keyHex;
  let epoch = pin.keyEpoch;
  for (const link of chain) {
    const r = link.rotation;
    if (r.oldKeyHex !== at || r.appId !== pin.appId || r.identityGeneration !== pin.identityGeneration || r.newEpoch !== epoch + 1) return { kind: "new-identity", continuity: "none", from: pin, toKeyHex: publisherKeyHex };
    if (!verifyPublisherRotation(r, link.signatureHex)) return { kind: "new-identity", continuity: "none", from: pin, toKeyHex: publisherKeyHex };
    at = r.newKeyHex;
    epoch = r.newEpoch;
  }
  if (at === publisherKeyHex && epoch === release.keyEpoch && chain.length > 0) {
    return { kind: "rotated", continuity: "valid-chain", from: pin, toKeyHex: publisherKeyHex, toEpoch: epoch };
  }
  return { kind: "new-identity", continuity: "none", from: pin, toKeyHex: publisherKeyHex };
}
