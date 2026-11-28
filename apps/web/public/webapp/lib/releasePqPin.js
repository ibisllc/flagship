// The release PQ pin's key ids (packages/protocol/src/releasePqPin.ts), baked into the webapp for
// the security notices' PQ half (docs/architecture-v2/pq-suites.md §14). Written by
// `node scripts/pq-release-key.mjs pin` together with the protocol constant; a test checks they
// match. Empty: no release PQ key yet, so a notice's classical signature alone is checked.
// BEGIN RELEASE_PQ_KEY_IDS (generated)
export const RELEASE_PQ_KEY_IDS = Object.freeze(["53627a4671a4ec0e2386f0bdc2e6b6b7f9017bb1302dffbb0a307ac8a4b90d62"]);
// END RELEASE_PQ_KEY_IDS
