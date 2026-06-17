#!/usr/bin/env node
/**
 * gen-maintainer-trust-vectors — regenerate the AUTHORITATIVE
 * cross-platform maintainer-trust vectors fixture.
 *
 *   output: packages/protocol/tests/fixtures/maintainerTrust.vectors.json
 *
 * This is the single source of truth Workers B (webapp) and C (mobile)
 * pin their hand-ported `verifyComBlessing` to. It is generated from
 * `@ibisllc/maintainers` with FIXED seeds so it is byte-reproducible:
 * re-running this script produces an identical file (modulo `generatedNote`
 * which is static text).
 *
 *   SEED CONVENTION (mirror this in any new fixture):
 *     - Ed25519 keypairs are derived from a 32-byte seed filled with a
 *       single byte value (the `@ibisllc/maintainers` `generateKeypair(seed)`
 *       path is a raw 32-byte private scalar — NOT the flagship deriveIRK
 *       HKDF path). We use:
 *         CA-TRACK HOLDER / SUCCESSOR seed = 0x51 ("Q")  -> rootHolder
 *         HOT CA KEY              seed     = 0xCA         -> caHotKey
 *         .services HUB KEY       seed     = 0x5E ("^")   -> hubKey   (for ServiceBlessing demo, informational)
 *     - All timestamps are derived from a fixed BASE epoch so the lease
 *       window is deterministic and a fixed NOW falls inside it.
 *
 *   FIXED EPOCHS (ms):
 *     BASE      = 1_700_000_000_000   (2023-11-14T22:13:20.000Z)
 *     NOW       = BASE + 60 days      (inside the lease window)
 *     mandate   issuedAt = BASE,           expiresAt = BASE + 3650 days
 *     endorse   notBefore= BASE,           notAfter  = BASE + 90 days
 *
 *   The fixture documents, with concrete bytes:
 *     - the ca root Mandate (verify-forward pin = mandatePinHash(root))
 *     - the live CaEndorsement (signed by the root holder)
 *     - the assembled `/api/maintainer-blessing` response
 *     - the canonical-byte strings + signatures for both envelopes
 *     - the expected `verifyComBlessing` verdict at the fixed NOW
 *     - NEGATIVE cases (lapsed-now, wrong-pin) with their expected verdicts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateKeypair,
  signMandate,
  signCaEndorsement,
  canonicalMandate,
  canonicalCaEndorsement,
  mandatePinHash,
} from "@ibisllc/maintainers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const OUT = path.join(
  REPO,
  "packages/protocol/tests/fixtures/maintainerTrust.vectors.json",
);

function seed(byte) {
  return new Uint8Array(32).fill(byte);
}
function iso(ms) {
  return new Date(ms).toISOString();
}
function bytesToHexUtf8String(u8) {
  return new TextDecoder().decode(u8);
}

const BASE = 1_700_000_000_000;
const DAY = 86_400_000;
const NOW = BASE + 60 * DAY;

// --- keys (fixed seeds) ---
const rootHolder = generateKeypair(seed(0x51)); // ca-track holder + successor
const caHotKey = generateKeypair(seed(0xca)); // the hot key .com serves
const hubKey = generateKeypair(seed(0x5e)); // .services hub key (informational)

// --- ca root Mandate (self-signed; the pin anchors exactly this) ---
const unsignedMandate = {
  kind: "Mandate",
  version: 1,
  mandateId: "00000000-0000-4000-8000-000000000001",
  track: "ca",
  holder: rootHolder.pubKey,
  issuedAt: iso(BASE),
  expiresAt: iso(BASE + 3650 * DAY),
  successors: [rootHolder.pubKey],
  approvalRule: { kind: "threshold", threshold: 1 },
  minSuccessors: 1,
  maxDurationSeconds: 315_360_000,
  defaultDurationSeconds: 8_640_000,
  project: { name: "flagship-test", contact: "vectors@example.invalid" },
  signedBy: rootHolder.pubKey,
};
const rootMandate = signMandate(unsignedMandate, [
  { privKey: rootHolder.privKey },
]);
const PIN = mandatePinHash(unsignedMandate);
const mandateCanonical = bytesToHexUtf8String(canonicalMandate(unsignedMandate));

// --- live CaEndorsement (root holder leases the hot CA key) ---
const unsignedEndorsement = {
  kind: "CaEndorsement",
  version: 1,
  endorsementId: "00000000-0000-4000-8000-000000000002",
  track: "ca",
  caPubkey: caHotKey.pubKey,
  scope: "flagship/directory-attestation",
  notBefore: iso(BASE),
  notAfter: iso(BASE + 90 * DAY),
  issuedAt: iso(BASE),
  signedBy: rootHolder.pubKey,
};
const endorsement = signCaEndorsement(unsignedEndorsement, [
  { privKey: rootHolder.privKey },
]);
const endorsementCanonical = bytesToHexUtf8String(
  canonicalCaEndorsement(unsignedEndorsement),
);

// --- a LAPSED endorsement (notAfter before NOW) for the negative case ---
const lapsedUnsigned = {
  ...unsignedEndorsement,
  endorsementId: "00000000-0000-4000-8000-000000000003",
  notBefore: iso(BASE),
  notAfter: iso(BASE + 30 * DAY), // < NOW (BASE + 60d) ⇒ lapsed at NOW
};
const lapsedEndorsement = signCaEndorsement(lapsedUnsigned, [
  { privKey: rootHolder.privKey },
]);

// --- assembled /api/maintainer-blessing response (the trusted case) ---
const blessingResponse = {
  version: 1,
  pinnedMandateHash: PIN,
  caPubkey: caHotKey.pubKey,
  issuer: "flagship-ca-test",
  mandates: [rootMandate],
  caEndorsements: [endorsement],
  caPubkeyAuthorizedNow: true,
  now: NOW,
};

const fixture = {
  $schema: "flagship/maintainer-trust-vectors/v1",
  generatedNote:
    "AUTHORITATIVE cross-platform vectors for verifyComBlessing. Regenerate with `node scripts/gen-maintainer-trust-vectors.mjs`. Workers B (webapp) and C (mobile) PIN their verifyComBlessing port to these bytes. Do not hand-edit.",
  seedConvention: {
    description:
      "Ed25519 keys via @ibisllc/maintainers generateKeypair(32-byte seed filled with one byte). NOT flagship deriveIRK/HKDF.",
    caTrackHolderSeedByte: "0x51",
    hotCaKeySeedByte: "0xca",
    hubKeySeedByte: "0x5e",
  },
  epochsMs: {
    BASE,
    DAY,
    NOW,
    mandateIssuedAt: BASE,
    mandateExpiresAt: BASE + 3650 * DAY,
    endorsementNotBefore: BASE,
    endorsementNotAfter: BASE + 90 * DAY,
  },
  keys: {
    caTrackHolderPub: rootHolder.pubKey,
    hotCaKeyPub: caHotKey.pubKey,
    hubKeyPub: hubKey.pubKey,
  },
  pinnedMandateHash: PIN,
  canonical: {
    mandate: mandateCanonical,
    caEndorsement: endorsementCanonical,
  },
  rootMandate,
  caEndorsement: endorsement,
  blessingResponse,
  // The expected verdict at NOW for `verifyComBlessing(blessingResponse, NOW, PIN)`.
  expectedVerdict: {
    trusted: true,
    caPubkey: caHotKey.pubKey,
    reason: "trusted",
  },
  negativeCases: [
    {
      name: "lapsed-lease-at-now",
      description:
        "Same root + hot key, but the only endorsement's notAfter is before NOW ⇒ authorizedCaKeys is empty.",
      response: {
        ...blessingResponse,
        caEndorsements: [lapsedEndorsement],
      },
      nowMs: NOW,
      pin: PIN,
      expectedVerdict: {
        trusted: false,
        caPubkey: caHotKey.pubKey,
        reason: "no-authorized-ca-keys",
      },
    },
    {
      name: "wrong-baked-pin",
      description:
        "The trusted response verified against a DIFFERENT baked pin (one the served mandate log does not anchor to) ⇒ pin-mismatch.",
      response: blessingResponse,
      nowMs: NOW,
      pin: "f".repeat(64),
      expectedVerdict: {
        trusted: false,
        caPubkey: caHotKey.pubKey,
        reason: "pin-mismatch",
      },
    },
    {
      name: "before-lease-window",
      description:
        "The trusted response evaluated at a NOW before notBefore ⇒ no live lease ⇒ no-authorized-ca-keys.",
      response: blessingResponse,
      nowMs: BASE - DAY,
      pin: PIN,
      expectedVerdict: {
        trusted: false,
        caPubkey: caHotKey.pubKey,
        reason: "no-authorized-ca-keys",
      },
    },
  ],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
console.log(`wrote ${path.relative(REPO, OUT)}`);
console.log(`  pin            = ${PIN}`);
console.log(`  caTrackHolder  = ${rootHolder.pubKey}`);
console.log(`  hotCaKey       = ${caHotKey.pubKey}`);
console.log(`  NOW            = ${NOW} (${iso(NOW)})`);
