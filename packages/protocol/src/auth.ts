/**
 * Canonical-bytes + Ed25519 sign/verify hub.
 *
 * `auth.ts` was a ~4,700-line monolith holding every signed envelope in the
 * protocol. It has been split BY DOMAIN into the modules re-exported below —
 * a pure code-organization refactor: the public API of `@flagship/protocol`
 * is byte-identical (every symbol previously exported here is re-exported,
 * unchanged) and NO canonical bytes / wire formats changed. Shared
 * primitives live in the leaf module `./canonicalBase.js` (no import cycle:
 * the domain modules import the base, the base imports nothing here).
 *
 * Existing imports keep working two ways:
 *   - `import { signInstallBlob } from "@flagship/protocol"` resolves via
 *     `index.ts` → this hub → `./installBlob.js`.
 *   - sibling protocol modules that did `import { legacyFieldGuard } from
 *     "./auth.js"` still resolve through this hub.
 *
 * Add new envelopes to the appropriate domain module (or a new one) and
 * re-export it here — keep this file a hub, not a home for logic.
 */

// The ONE shared primitive that was public in the pre-split `auth.ts`. The
// other helpers in `./canonicalBase.js` (`hex`, `validateNoSepCtrl`,
// `assertCanonicalField`) stay package-internal — re-exporting only this
// keeps the public API byte-identical.
export { legacyFieldGuard } from "./canonicalBase.js";

// Per-domain envelope modules.
export * from "./legacyEnvelopes.js";
export * from "./installBlob.js";
export * from "./caBindings.js";
export * from "./routing.js";
export * from "./orders.js";
export * from "./journalRequest.js";
export * from "./unlock.js";
export * from "./deadMan.js";
export * from "./recovery.js";
export * from "./totp.js";
export * from "./serviceLifecycle.js";
export * from "./serviceInvite.js";
export * from "./serverIdentity.js";
export * from "./provisioning.js";
export * from "./userRegistration.js";
export * from "./push.js";
export * from "./llmPromo.js";
export * from "./entitlements.js";
export * from "./deviceCapability.js";
export * from "./watchDelegate.js";
export * from "./acmeCustody.js";
export * from "./certRevocation.js";
export * from "./customDomainCert.js";
export * from "./podBinding.js";
