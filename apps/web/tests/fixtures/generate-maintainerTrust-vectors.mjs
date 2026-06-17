// Generate cross-platform test vectors for webapp maintainer-trust verify.
//
// Uses @ibisllc/maintainers with the SAME fixed-seed convention as the
// maintainers CLI tests (keypair(byte) = generateKeypair with seed[0]=byte),
// so the bytes here are byte-identical to what the authoritative protocol
// fixture (packages/protocol/tests/fixtures/maintainerTrust.vectors.json,
// produced by Worker A) carries. Final reconciliation with A's fixture
// happens at integration; until then these locally-generated vectors pin the
// webapp verify against real maintainers-produced data.
//
//   node apps/web/tests/fixtures/generate-maintainerTrust-vectors.mjs

import {
  generateKeypair,
  signMandate,
  signCaEndorsement,
  mandatePinHash,
} from "@ibisllc/maintainers";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

function keypair(seedByte) {
  const s = new Uint8Array(32);
  s[0] = seedByte;
  return generateKeypair(s);
}

const maint = keypair(1);
const hot = keypair(9);
const otherKey = keypair(99); // a key NOT endorsed

function caRootMandate(holder) {
  const unsigned = {
    kind: "Mandate",
    version: 1,
    mandateId: "ca-root-0000-4000-8000-000000000000",
    track: "ca",
    holder: holder.pubKey,
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2027-01-01T00:00:00.000Z",
    successors: [holder.pubKey],
    approvalRule: { kind: "threshold", threshold: 1 },
    minSuccessors: 1,
    maxDurationSeconds: 365 * 86_400,
    defaultDurationSeconds: 365 * 86_400,
    project: {
      name: "flagship",
      contact: "harry@flagship.services",
      tracks: ["ca"],
    },
    signedBy: holder.pubKey,
  };
  return signMandate(unsigned, [{ privKey: holder.privKey }]);
}

function caEndorsement({ issuer, caPubkey, notBefore, notAfter, id }) {
  const unsigned = {
    kind: "CaEndorsement",
    version: 1,
    endorsementId: id,
    track: "ca",
    caPubkey,
    scope: "flagship/directory-attestation",
    notBefore,
    notAfter,
    issuedAt: notBefore,
    signedBy: issuer.pubKey,
  };
  return signCaEndorsement(unsigned, [{ privKey: issuer.privKey }]);
}

const root = caRootMandate(maint);
const pin = mandatePinHash(root);

// A live lease covering the hot CA key, wide window.
const liveLease = caEndorsement({
  issuer: maint,
  caPubkey: hot.pubKey,
  notBefore: "2026-06-01T00:00:00.000Z",
  notAfter: "2026-12-01T00:00:00.000Z",
  id: "ca-e-live-0000-0000-000000000000",
});

// A lapsed lease (expired before the test clock).
const lapsedLease = caEndorsement({
  issuer: maint,
  caPubkey: hot.pubKey,
  notBefore: "2026-01-01T00:00:00.000Z",
  notAfter: "2026-02-01T00:00:00.000Z",
  id: "ca-e-lapsed-0000-0000-00000000000",
});

const CLIENT_NOW = "2026-06-16T00:00:00.000Z";

function blessing(caPubkey, mandates, caEndorsements, issuer = maint.pubKey) {
  return {
    version: 1,
    pinnedMandateHash: pin,
    caPubkey,
    issuer,
    mandates,
    caEndorsements,
    caPubkeyAuthorizedNow: undefined, // server hint; verifier ignores it
    now: "2026-06-16T00:00:00.000Z", // server clock; verifier must NOT trust this
  };
}

const vectors = {
  _note:
    "Webapp-local maintainer-trust vectors. Seeds match the maintainers CLI " +
    "test convention (keypair(byte)). Reconcile with " +
    "packages/protocol/tests/fixtures/maintainerTrust.vectors.json at integration.",
  pin,
  clientNow: CLIENT_NOW,
  keys: {
    maintainerPub: maint.pubKey,
    hotCaPub: hot.pubKey,
    otherPub: otherKey.pubKey,
  },
  mandates: [root],
  caEndorsements: [liveLease],
  cases: [
    {
      name: "trusted: served key is the live-authorized hot CA key",
      blessing: blessing(hot.pubKey, [root], [liveLease]),
      expect: { trusted: true, reason: "ok" },
    },
    {
      name: "untrusted: served key is NOT the authorized key",
      blessing: blessing(otherKey.pubKey, [root], [liveLease]),
      expect: { trusted: false, reason: "served-key-not-authorized" },
    },
    {
      name: "untrusted: lease lapsed at client clock",
      blessing: blessing(hot.pubKey, [root], [lapsedLease]),
      expect: { trusted: false, reason: "no-authorized-ca-keys" },
    },
    {
      name: "untrusted: pin not in mandate log (forked/tampered)",
      blessing: { ...blessing(hot.pubKey, [], [liveLease]) },
      expect: { trusted: false, reason: "no-authorized-ca-keys" },
    },
    {
      name: "untrusted: blessing missing caPubkey",
      blessing: blessing(undefined, [root], [liveLease]),
      expect: { trusted: false, reason: "no-served-key" },
    },
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "maintainerTrust.webapp.vectors.json");
writeFileSync(out, JSON.stringify(vectors, null, 2) + "\n");
console.log("wrote", out);
console.log("pin", pin);
