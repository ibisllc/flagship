// The release PQ pin's key ids (packages/protocol/src/releasePqPin.ts), baked into the webapp for
// the security notices' PQ half (docs/architecture-v2/pq-suites.md §14). Written by
// `node scripts/pq-release-key.mjs pin` together with the protocol constant; a test checks they
// match. Empty: no release PQ key yet, so a notice's classical signature alone is checked.
// BEGIN RELEASE_PQ_KEY_IDS (generated)
export const RELEASE_PQ_KEY_IDS = Object.freeze([]);
// END RELEASE_PQ_KEY_IDS
