/**
 * The release PQ pin: which hybrid release keys a box, `.com` and the release tools accept, and
 * the last endorsement signed before the PQ key existed. Written by
 * `node scripts/pq-release-key.mjs pin` at the key ceremony (docs/runbooks/pq-release-key.md);
 * a code constant on purpose, like MAINTAINER_PINNED_MANDATE_HASH, because `.maintainers/` may
 * be read from a fetched, not-yet-trusted ref.
 *
 * Empty `keyIds`: no PQ key yet, so the v1 YubiKey endorsement alone is checked (today).
 * Once a key id is here, every update target needs the v1 signature AND the hybrid companion.
 */
import type { ReleasePqPin } from "./releaseEndorsementPq.js";

// ⚠️ GYM TEST BRANCH ONLY: the gym endorses releases with its own classical key K, so the pin names no PQ key here.
// BEGIN RELEASE_PQ_PIN (generated)
export const RELEASE_PQ_PIN: ReleasePqPin = Object.freeze({
  version: 1,
  keyIds: Object.freeze([]) as readonly string[],
  requirePqAfter: null,
});
// END RELEASE_PQ_PIN
