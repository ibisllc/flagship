/**
 * The Messages abuse public keys (docs/voici-and-messages.md §9.3): bundled from `.maintainers/abuse-keys/list.json`
 * and used only when an entry's signature verifies under a holder of the pinned ca-track mandate chain (the cold
 * YubiKey key, as for security notices). Verified once per isolate; the private halves never come near `.com`.
 */
import { currentAuthority, verifyMandateChainFromPin, type Mandate } from "@ibisllc/maintainers";
import { abuseKeyFor, hexToBytes, MAINTAINER_PINNED_MANDATE_HASH, verifyAbuseKeyEntry, type AbuseKeyEntry } from "@flagship/protocol";
import committedList from "../../../.maintainers/abuse-keys/list.json";
import { caTrustChainPublicMaterial } from "./caTrustChainLoader.js";

export interface SignedAbuseKeyEntry extends AbuseKeyEntry {
  signature: string;
}

/** Every key that ever held the ca-track mandate in the pinned chain (an entry outlives the mandate that signed it). */
export function caTrackHolders(mandates: readonly Mandate[] = caTrustChainPublicMaterial().mandates, pin = MAINTAINER_PINNED_MANDATE_HASH): string[] {
  try {
    const chain = verifyMandateChainFromPin(pin, [...mandates]);
    return chain.validMandates.map((m) => m.holder.toLowerCase());
  } catch {
    return [];
  }
}

/** The ca-track holder at `now` (scripts compare the signing key against it before signing). */
export function caTrackAuthorityNow(now: number, mandates: readonly Mandate[] = caTrustChainPublicMaterial().mandates): string | null {
  try {
    return currentAuthority(verifyMandateChainFromPin(MAINTAINER_PINNED_MANDATE_HASH, [...mandates]), new Date(now))?.holder.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** The entries of a list document whose signature verifies under `signers`; anything malformed is dropped. */
export function verifiedAbuseKeys(doc: unknown, signers: readonly string[]): AbuseKeyEntry[] {
  if (!doc || typeof doc !== "object") return [];
  const entries = (doc as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  const out: AbuseKeyEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as SignedAbuseKeyEntry;
    const entry: AbuseKeyEntry = { epoch: e.epoch, xwingPub: e.xwingPub, notBefore: e.notBefore, notAfter: e.notAfter };
    if (typeof e.signature === "string" && verifyAbuseKeyEntry(entry, e.signature, signers)) out.push(entry);
  }
  return out;
}

let bundled: AbuseKeyEntry[] | null = null;

/** The committed list, verified once per isolate. */
export function bundledAbuseKeys(): AbuseKeyEntry[] {
  bundled ??= verifiedAbuseKeys(committedList, caTrackHolders());
  return bundled;
}

/** The key to seal new tags to at `now`, as {epoch, public key bytes}; null when none is in its window. */
export function currentAbuseKey(entries: readonly AbuseKeyEntry[], now: number): { epoch: number; publicKey: Uint8Array } | null {
  const e = abuseKeyFor(entries, now);
  return e ? { epoch: e.epoch, publicKey: hexToBytes(e.xwingPub) } : null;
}
