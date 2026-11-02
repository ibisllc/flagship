#!/usr/bin/env -S npx tsx
/**
 * Writes packages/protocol/test-vectors/maintainer-ca/vectors.json from `@ibisllc/maintainers` (the library every
 * TypeScript consumer resolves its CA keys with: `relayMeshCaKeys`, `makeCaTrustChain`). The Rust relay's port
 * (rust/crates/flagship-relay/src/mesh/ca.rs) must give the same mandate pin hashes, the same accepted chain length and
 * the same authorized CA keys at every probe time.
 *
 * Cases: the committed `.maintainers/` snapshot under the baked pin (probed before, during, between and after leases),
 * a wrong pin, a tampered successor mandate, a forged lease signature, a lease signed by a key that is not the
 * authority, and a synthetic chain (threshold 2, a successor outside the set, a duplicate id, an over-long window).
 *
 *   npx tsx tools/maintainer-ca-vectors.ts          write
 *   npx tsx tools/maintainer-ca-vectors.ts --check  fail when the file is stale
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  authorizedCaKeys,
  canonicalCaEndorsement,
  canonicalMandate,
  generateKeypair,
  mandatePinHash,
  sign,
  verifyMandateChainFromPin,
  type CaEndorsement,
  type Mandate,
} from "@ibisllc/maintainers";
import { MAINTAINER_PINNED_MANDATE_HASH } from "../packages/protocol/src/maintainerCa.js";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const OUT = resolve(REPO, "packages/protocol/test-vectors/maintainer-ca/vectors.json");

const readDir = (sub: string, skipBundle: boolean): unknown[] =>
  readdirSync(resolve(REPO, ".maintainers", sub))
    .filter((f) => f.endsWith(".json") && !(skipBundle && f === "bundle.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(resolve(REPO, ".maintainers", sub, f), "utf8")));

const mandates = readDir("tracks/ca/mandates", false) as Mandate[];
const endorsements = readDir("ca-endorsements", true) as CaEndorsement[];

const iso = (s: string) => Date.parse(s);
const snapshotTimes = [
  "2026-05-01T00:00:00.000Z",
  "2026-05-25T00:00:00.000Z",
  "2026-06-20T00:00:00.000Z",
  "2026-10-10T00:00:00.000Z",
  "2026-11-01T00:00:00.000Z",
  "2027-01-17T01:38:00.000Z",
  "2027-01-17T01:45:00.000Z",
  "2027-05-01T00:00:00.000Z",
].map(iso);

interface Case {
  name: string;
  pin: string;
  mandates: unknown[];
  endorsements: unknown[];
  times: number[];
}

function run(c: Case) {
  const chain = verifyMandateChainFromPin(c.pin, c.mandates as Mandate[]);
  return {
    name: c.name,
    pin: c.pin,
    mandates: c.mandates,
    endorsements: c.endorsements,
    chainLength: chain.validMandates.length,
    at: c.times.map((now) => ({ now, keys: authorizedCaKeys(c.endorsements as CaEndorsement[], chain, new Date(now)) })),
  };
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// A tampered successor: its bytes no longer match its signature.
const tampered = clone(mandates);
if (tampered[1]) tampered[1].expiresAt = "2030-01-01T00:00:00.000Z";

// A forged lease signature.
const forged = clone(endorsements);
const last = forged[forged.length - 1];
if (last?.signatures[0]) last.signatures[0].sig = last.signatures[0].sig.replace(/^./, (c) => (c === "0" ? "1" : "0"));

// A lease signed by a key that is not the ca authority.
const stranger = generateKeypair(new Uint8Array(32).fill(7));
function lease(signer: { privKey: string; pubKey: string }, caPubkey: string, notBefore: string, notAfter: string, id: string): CaEndorsement {
  const e: CaEndorsement = {
    kind: "CaEndorsement",
    version: 1,
    endorsementId: id,
    track: "ca",
    caPubkey,
    scope: "flagship/directory-attestation",
    notBefore,
    notAfter,
    issuedAt: notBefore,
    signedBy: signer.pubKey,
    signatures: [],
  } as CaEndorsement;
  e.signatures = [{ pubkey: signer.pubKey, sig: sign(canonicalCaEndorsement(e), signer.privKey) }];
  return e;
}
const strangerLease = lease(stranger, "ab".repeat(32), "2026-10-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "stranger");

// A synthetic chain: root (threshold 2 over a, b), a valid successor signed by both, then rejects.
const a = generateKeypair(new Uint8Array(32).fill(11));
const b = generateKeypair(new Uint8Array(32).fill(12));
const c = generateKeypair(new Uint8Array(32).fill(13));
function mandate(o: Partial<Mandate> & { mandateId: string; holder: string; issuedAt: string; expiresAt: string }, signers: { privKey: string; pubKey: string }[]): Mandate {
  const m = {
    kind: "Mandate",
    version: 1,
    track: "ca",
    successors: [a.pubKey, b.pubKey],
    approvalRule: { kind: "threshold", threshold: 2 },
    minSuccessors: 2,
    maxDurationSeconds: 400 * 86_400,
    defaultDurationSeconds: 90 * 86_400,
    project: { name: "test", contact: "x@example.com", tracks: ["ca"] },
    signedBy: signers[0]!.pubKey,
    signatures: [],
    ...o,
  } as Mandate;
  const bytes = canonicalMandate(m);
  m.signatures = signers.map((s) => ({ pubkey: s.pubKey, sig: sign(bytes, s.privKey) }));
  return m;
}
const root = mandate({ mandateId: "r", holder: a.pubKey, issuedAt: "2030-01-01T00:00:00.000Z", expiresAt: "2030-06-01T00:00:00.000Z" }, [a]);
const next = mandate({ mandateId: "n", holder: b.pubKey, issuedAt: "2030-05-01T00:00:00.000Z", expiresAt: "2030-12-01T00:00:00.000Z" }, [a, b]);
const oneSigner = mandate({ mandateId: "o", holder: a.pubKey, issuedAt: "2030-07-01T00:00:00.000Z", expiresAt: "2030-09-01T00:00:00.000Z" }, [a]);
const outsider = mandate({ mandateId: "x", holder: c.pubKey, issuedAt: "2030-07-01T00:00:00.000Z", expiresAt: "2030-09-01T00:00:00.000Z" }, [a, c]);
const duplicate = mandate({ mandateId: "n", holder: a.pubKey, issuedAt: "2030-07-01T00:00:00.000Z", expiresAt: "2030-09-01T00:00:00.000Z" }, [a, b]);
const tooLong = mandate({ mandateId: "l", holder: a.pubKey, issuedAt: "2030-07-01T00:00:00.000Z", expiresAt: "2032-07-01T00:00:00.000Z" }, [a, b]);
const synthetic = [root, next, oneSigner, outsider, duplicate, tooLong];
const syntheticLeases = [
  lease(a, "cd".repeat(32), "2030-01-01T00:00:00.000Z", "2030-12-01T00:00:00.000Z", "by-a"),
  lease(b, "ef".repeat(32), "2030-01-01T00:00:00.000Z", "2030-12-01T00:00:00.000Z", "by-b"),
];
const syntheticTimes = ["2030-02-01T00:00:00.000Z", "2030-05-15T00:00:00.000Z", "2030-08-01T00:00:00.000Z", "2031-01-01T00:00:00.000Z"].map(iso);

const vectors = {
  description:
    "Maintainer ca-track chain and CaEndorsement leases, produced by @ibisllc/maintainers (verifyMandateChainFromPin, authorizedCaKeys, mandatePinHash). Generated by tools/maintainer-ca-vectors.ts; do not edit. The Rust relay's port is rust/crates/flagship-relay/src/mesh/ca.rs.",
  pinHashes: [...mandates, ...synthetic].map((m, i) => ({ name: `mandate ${i}`, mandate: m, pinHash: mandatePinHash(m) })),
  cases: [
    run({ name: "committed snapshot", pin: MAINTAINER_PINNED_MANDATE_HASH, mandates, endorsements, times: snapshotTimes }),
    run({ name: "wrong pin", pin: "00".repeat(32), mandates, endorsements, times: snapshotTimes }),
    run({ name: "no pin", pin: "", mandates, endorsements, times: snapshotTimes }),
    run({ name: "tampered successor", pin: MAINTAINER_PINNED_MANDATE_HASH, mandates: tampered, endorsements, times: snapshotTimes }),
    run({ name: "forged lease", pin: MAINTAINER_PINNED_MANDATE_HASH, mandates, endorsements: forged, times: snapshotTimes }),
    run({ name: "lease from a stranger", pin: MAINTAINER_PINNED_MANDATE_HASH, mandates, endorsements: [strangerLease], times: snapshotTimes }),
    run({ name: "synthetic chain", pin: mandatePinHash(root), mandates: synthetic, endorsements: syntheticLeases, times: syntheticTimes }),
  ],
};

const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const had = readFileSync(OUT, "utf8");
  if (had !== text) {
    console.error(`${OUT} is stale: run npx tsx tools/maintainer-ca-vectors.ts`);
    process.exit(1);
  }
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
