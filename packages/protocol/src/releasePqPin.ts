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

// BEGIN RELEASE_PQ_PIN (generated)
export const RELEASE_PQ_PIN: ReleasePqPin = Object.freeze({
  version: 1,
  keyIds: Object.freeze(["1c07f1ffe8e6e8b89d8b8c8c14544d6f065decfa67ea76ec50c30fadaadb9434"]) as readonly string[],
  requirePqAfter: { releaseId: "978ca58f-a29a-4857-8afc-6dd6238ed223", commitHash: "dbdf2e08875ae55d9b575f390a29810670f9a54d" },
});
// END RELEASE_PQ_PIN
