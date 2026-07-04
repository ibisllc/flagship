// Slice D — Phase 2 (webapp) — the admin-master-root SIGNING GATE.
//
// docs/device-admin-tier-spec.md §8.3: every sensitive/destructive order the
// webapp signs must sign with the ADMIN MASTER ROOT when this account has one,
// falling back to the legacy owner-IRK (or, for service-invites, the account
// AID) on a pre-wipe / legacy account that never pinned an admin root. The
// canonical bytes are byte-identical — ONLY the signing key changes.
//
// The gate is tag-routed: it inspects the canonical-bytes tag (the token before
// the first `|`). A tag in {@link SENSITIVE_TAGS} signs under the admin root;
// EVERYTHING ELSE (mailbox-auth `flagship/device-endpoint-claim/v1`, pairing,
// deposits, journal, …) signs with the legacy key. This is why a single gated
// signer can be dropped into a mailbox-wrapped flow (decommission / transfer /
// set-leader): the ORDER routes to the admin root while the co-signed mailbox
// AUTH stays the membership IRK the deposit lane requires. It is fail-SAFE: an
// unrecognised tag never accidentally admin-signs a membership credential.
//
// The gate keys entirely off `session.adminRootSeed` (populated by
// state.unlockSession / ensureAdminRoot). No admin root ⇒ pure legacy behaviour,
// so this is inert for every existing account until the clean-slate reburn.

import {
  signWithIrk as ksSignWithIrk,
  signWithAdminRoot as ksSignWithAdminRoot,
  adminRootPubHex as ksAdminRootPubHex,
  hasAdminRoot as ksHasAdminRoot,
  generateAdminRoot as ksGenerateAdminRoot,
  loadAdminRootSeed as ksLoadAdminRootSeed,
} from "../keystore.js";
import { getSession } from "./state.js";

/**
 * The canonical-bytes tags of the SENSITIVE orders the webapp signs — mirrors
 * the docs/device-admin-tier-spec.md §2 table rows that Phase 1 re-pointed
 * through `authorizeSensitiveComOp` / `adminAuthorityLocal`. Keep in sync with
 * the box (`packages/server-daemon`) + `.com` (`packages/control-plane`)
 * enforcement surface; every entry here is verified against the admin root when
 * the gate is open.
 */
export const SENSITIVE_TAGS = new Set([
  // Box-side (adminAuthorityLocal)
  "flagship/root-entitlement/v1", //       authorize a box to serve (boot approval)
  "flagship/server-decommission/v1", //    replace / decommission
  "flagship/order/set-front-page/v1", //   apex front page
  "flagship/set-leader/v1", //             preferred-server vote
  "flagship/order/power-off/v1", //        power off / restart
  "flagship/set-deadman-policy/v1", //     dead-man policy
  "flagship/deadman-affirm/v1", //         dead-man affirmation
  // `.com`-side (authorizeSensitiveComOp)
  "flagship/server-update/v1", //          in-place server update (2-of-2)
  "flagship/account-self-delete/v1", //    account deletion
  "flagship/servers-self-delete/v1", //    content wipe
  "flagship/custom-domain/v1", //          attach custom domain
  "flagship/auto-unlock-lease/v1", //      deposit LUKS auto-unlock lease
  "flagship/revoke-auto-unlock-lease/v1", //  revoke lease
  "flagship/server-transfer-offer/v1", //  transfer (giver)
  "flagship/server-transfer-claim/v2", //  transfer (acquirer; v2 binds their admin root pub)
  "flagship/release-server-name/v1", //    release server name
  "flagship/service-invite/create/v1", //  service collaborator invite (D-2)
  "flagship/service-invite/revoke/v1", //  service collaborator revoke (D-2)
]);

const _decoder = new TextDecoder();

/** The canonical-bytes tag (the token before the first `|`). Decodes only the
 *  head so a large body — e.g. a service-invite `encryptedBundle` — is cheap. */
export function canonicalTag(bytes) {
  const head = _decoder.decode(bytes.subarray(0, 64));
  const bar = head.indexOf("|");
  return bar === -1 ? head : head.slice(0, bar);
}

/**
 * Build a sensitive-order signer with the SAME `(umk, bytes) => Promise<sig>`
 * shape the legacy signer has. When `adminRootSeed` is present AND the canonical
 * bytes carry a {@link SENSITIVE_TAGS} tag, it signs with the admin master root;
 * otherwise it defers to `legacy` (the owner IRK by default, or the account AID
 * for service-invite callsites).
 *
 * @param {Uint8Array|null} adminRootSeed  this device's admin-root seed, or null
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} [legacy]
 * @param {{ signWithAdminRoot?: Function }} [deps]  test seam
 */
export function makeSensitiveSigner(adminRootSeed, legacy = ksSignWithIrk, deps = {}) {
  const signAdmin = deps.signWithAdminRoot || ksSignWithAdminRoot;
  return async (umk, bytes) => {
    if (adminRootSeed && SENSITIVE_TAGS.has(canonicalTag(bytes))) {
      return signAdmin(adminRootSeed, bytes);
    }
    return legacy(umk, bytes);
  };
}

/**
 * Session-scoped convenience: the gated signer bound to the currently-unlocked
 * session's admin root. Pass the resulting function wherever a sensitive lib
 * expects a `signWithIrk`-shaped signer.
 *
 * @param {(umk: Uint8Array, bytes: Uint8Array) => Promise<Uint8Array>} [legacy]
 */
export function sensitiveSigner(legacy = ksSignWithIrk) {
  const session = getSession();
  return makeSensitiveSigner(session?.adminRootSeed ?? null, legacy);
}

/**
 * Ensure this (first) device holds an admin master root, minting one if absent,
 * and load it into the live session so subsequent sensitive signs use it.
 * Returns the admin-root pubkey hex to PUBLISH (username-claim body + recipe
 * AuthCode), or null when there's no unlocked session.
 *
 * Generation is idempotent — only when NO admin root exists for the profile —
 * so re-running the open-account / create-server path never rotates the root.
 *
 * @param {{ umk: Uint8Array, adminRootSeed?: Uint8Array|null }} session
 * @param {{ hasAdminRoot?, generateAdminRoot?, loadAdminRootSeed?, adminRootPubHex? }} [deps]
 * @returns {Promise<string|null>}
 */
export async function ensureAdminRoot(session, deps = {}) {
  if (!session || !(session.umk instanceof Uint8Array)) return null;
  const has = deps.hasAdminRoot || ksHasAdminRoot;
  const gen = deps.generateAdminRoot || ksGenerateAdminRoot;
  const load = deps.loadAdminRootSeed || ksLoadAdminRootSeed;
  const pubHex = deps.adminRootPubHex || ksAdminRootPubHex;

  let seed = session.adminRootSeed instanceof Uint8Array ? session.adminRootSeed : null;
  if (!seed) {
    seed = (await has()) ? await load(session.umk) : await gen(session.umk);
  }
  session.adminRootSeed = seed;
  return seed ? pubHex(seed) : null;
}
