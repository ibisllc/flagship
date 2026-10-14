import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import type { Bytes, Keypair, ServerId, UserMasterKey } from "./types.js";

const INFO_BAK = "flagship.bak.v1";
const INFO_IRK = "flagship.irk.v1";
const INFO_SWK = "flagship.swk.v1";
const INFO_STK = "flagship.stk.v1";
const INFO_APP_SECRET = "flagship.app-secret.v1";
const INFO_APP_MEMBER = "flagship.app-member.v1";
const INFO_ACCOUNT_ID = "flagship/account-id/v1";
const INFO_CONTACT_ID = "flagship/contact-aid/v1";
const INFO_APP_ACCOUNT_ID = "flagship/app-aid/v1";
const INFO_HOUSEHOLD_KEY = "flagship/household-key/v1";

export function generateUMK(rng: () => Bytes = randomBytes): UserMasterKey {
  const seed = rng();
  if (seed.length !== 32) throw new Error("UMK seed must be 32 bytes");
  return { seed };
}

function randomBytes(): Bytes {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return b;
}

function derive(umk: UserMasterKey, info: string): Bytes {
  return hkdf(sha256, umk.seed, new Uint8Array(0), new TextEncoder().encode(info), 32);
}

function seedToKeypair(seed: Bytes): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

export function deriveIRK(umk: UserMasterKey): Keypair {
  return seedToKeypair(derive(umk, INFO_IRK));
}

/**
 * Account Identity Key (AID) — the STABLE, NON-rotating account identity.
 *
 * Anchored to the UMK (the account root, preserved through every recovery)
 * under a FIXED HKDF info — unlike `deriveIRK`, which is VERSIONED
 * (`flagship.irk.v1`, and re-pair / Wipe & restart derive a fresh IRK from
 * the same shared UMK). Because the IRK rotates it is a signing/device key,
 * useless as a long-lived identifier; the AID never rotates (it changes only
 * when the UMK does — i.e. a brand-new account), so it is the right primitive
 * for allow-lists, capability-invite bindings, and author/friend attribution.
 *
 * The IRK stays the signer for the author's ACTIVE orders (an order from a
 * compromised device dies when its IRK rotates); the AID identifies WHO the
 * author and the friend are. A friend proves control of their account by
 * signing the redeem (and later visits) with their AID.
 */
export function deriveAccountId(umk: UserMasterKey): Keypair {
  return seedToKeypair(derive(umk, INFO_ACCOUNT_ID));
}

/**
 * Superseded for everything a visitor does by {@link deriveAppAccountId} (owner
 * rule, 2026-10-13): kept only so older vectors and tests stay reproducible.
 *
 * Contact Account Id — a PER-AUTHOR pseudonymous identity the consumer (friend)
 * presents when redeeming / visiting / authorizing a given author's services.
 * Derived from the consumer's UMK + the AUTHOR's AID pubkey, so:
 *  - it is STABLE with that author (survives the consumer's IRK rotations + new
 *    devices, and re-redeem is idempotent — same UMK + same author ⇒ same id),
 *  - two DIFFERENT authors get UNLINKABLE ids for the same consumer, so neither
 *    the authors nor flagshipserver.com can cross-link the same person across
 *    hosts (privacy by construction — closes the cleartext-friend-graph gap,
 *    docs/service-access-gating.md v2 §H3), and
 *  - it stays per-AUTHOR (not per-service), so cross-app reuse within one author
 *    still works (add the friend to another of your services with the same id,
 *    no new link).
 * The v2 redemption identity replaces the GLOBAL AID for the CONSUMER side; the
 * author still uses their own (global) AID for create/revoke attribution.
 */
export function deriveContactAccountId(umk: UserMasterKey, authorAidPub: Bytes): Keypair {
  return seedToKeypair(derive(umk, `${INFO_CONTACT_ID}|${hexOf(authorAidPub)}`));
}

/**
 * App Account Id — the identity a visitor presents to ONE app (redeeming its
 * invites, visiting it, signing in to it), derived from their UMK and that
 * app's stable id only:
 *
 *   seed = HKDF-SHA256(UMK, salt = "", info = "flagship/app-aid/v1|<appRef>")
 *
 * `appRef` is the app's service id, `<creator>--<slug>`: the same on every one
 * of the owner's servers (a copy or a move keeps it) and whoever sends the
 * invite. So a co-manager's invite and the owner's invite to the same app
 * bind the same identity (the owner may link two grants of ONE app), while two
 * apps see unrelated ids: nothing a visitor presents is shared between apps,
 * and nothing depends on who invited them. Replaces the per-author contact
 * AID for everything a visitor does (docs/service-access-gating.md, "Per-app
 * identity"). The owner is still recognised by their own AID.
 */
export function deriveAppAccountId(umk: UserMasterKey, appRef: string): Keypair {
  if (!APP_REF_RE.test(appRef)) throw new Error("app ref must be a service id (lowercase, digits, dashes)");
  return seedToKeypair(derive(umk, `${INFO_APP_ACCOUNT_ID}|${appRef}`));
}

/** A service id as apps are named (`<creator>--<slug>`; dashes, lowercase, digits). */
const APP_REF_RE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;

function hexOf(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Household encryption key — a symmetric AEAD key derived from the UMK under
 * a FIXED info, so EVERY device of the account (which all share the UMK) can
 * independently derive the same key, and it can be provisioned to the author's
 * own servers over their pinned pipe. It seals the capability-invite bundle
 * (`{ name, photo? }`): flagshipserver.com only ever stores the ciphertext and
 * NEVER holds the UMK, so it cannot read the friend's name/photo.
 *
 * UMK-derived (not server-key-derived) on purpose: the bundle must be openable
 * by a sibling device the author pairs LATER and by any of the author's boxes,
 * all of which derive this same key from the one shared UMK — no per-device
 * key exchange, and no dependency on a particular server's SWK.
 */
export function deriveHouseholdKey(umk: UserMasterKey): Bytes {
  return derive(umk, INFO_HOUSEHOLD_KEY);
}

export function deriveBAK(umk: UserMasterKey, serverId: ServerId): Keypair {
  return seedToKeypair(derive(umk, `${INFO_BAK}|${serverId}`));
}

export function deriveSWK(umk: UserMasterKey, serverId: ServerId): Bytes {
  return derive(umk, `${INFO_SWK}|${serverId}`);
}

/**
 * Server Tunnel Key — Ed25519 keypair derived from SWK. Lives on the server
 * (since SWK lives on the server post-provisioning) and signs the tunnel HELLO
 * so a stolen serverId cannot impersonate without also possessing SWK.
 *
 * The pubkey is registered with the control plane at image-build time (the
 * phone derives the same value from UMK and signs a registration with IRK).
 */
export function deriveSTK(swk: Bytes): Keypair {
  const seed = hkdf(
    sha256,
    swk,
    new Uint8Array(0),
    new TextEncoder().encode(INFO_STK),
    32,
  );
  return seedToKeypair(seed);
}

/**
 * Per-service secret used by the runtime on a Flagship server. Different
 * services on the same server have independent secrets, so a stable-id
 * derived for service A cannot be linked to a stable-id derived for service
 * B (privacy by construction — services cannot cross-link the same person
 * without explicit handshake).
 */
export function deriveServiceSecret(swk: Bytes, serviceId: string): Bytes {
  return hkdf(
    sha256,
    swk,
    new TextEncoder().encode(serviceId),
    new TextEncoder().encode(INFO_APP_SECRET),
    32,
  );
}

/**
 * Per-service stable member identifier derived from the service's secret
 * and the member's IRK pubkey. Used by Caddy as the value of
 * `X-Flagship-Member` injected on inbound requests. Returns 32 hex chars
 * (16 bytes) for compactness.
 */
export function deriveServiceMemberStableId(
  serviceSecret: Bytes,
  accepterIrkPub: Bytes,
): string {
  const out = hkdf(
    sha256,
    serviceSecret,
    accepterIrkPub,
    new TextEncoder().encode(INFO_APP_MEMBER),
    16,
  );
  let s = "";
  for (const x of out) s += x.toString(16).padStart(2, "0");
  return s;
}
