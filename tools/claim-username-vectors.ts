#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for `flagship/claim-username/v2` (the IRK-signed username claim, POST /api/username/claim and
 * the claim inside POST /api/accounts). v2 binds the AID and admin-root keys the body carries, so a captured claim
 * can't be replayed with other keys. The TS port (packages/protocol/src/legacyEnvelopes.ts) generates them; the
 * webapp, Swift and Kotlin ports read the same file.
 *
 * Run:          npx tsx tools/claim-username-vectors.ts
 * CI freshness: npx tsx tools/claim-username-vectors.ts --check
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ed } from "../packages/protocol/src/edSync.js";
import { signClaimUsername, verifyClaimUsername } from "../packages/protocol/src/legacyEnvelopes.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/claim-username/vectors.json");
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const seed = (v: number): Uint8Array => new Uint8Array(32).fill(v);
const kp = (v: number) => ({ privateKey: seed(v), publicKey: ed.getPublicKey(seed(v)) });

const irk = kp(0x11);
const aid = kp(0x22);
const root = kp(0x33);
const otherAid = kp(0x44);
const otherRoot = kp(0x55);
const ISSUED_AT = 1_790_000_000_000;
const USERNAME = "plucky-avocet";

const canonical = (aidPub: string, rootPub: string): string =>
  ["flagship/claim-username/v2", USERNAME, hex(irk.publicKey), aidPub, rootPub, ISSUED_AT].join("|");

interface Case {
  name: string;
  request: { username: string; irkPub: string; issuedAt: number };
  aidPub: string | null;
  adminRootPub: string | null;
  canonical: string;
  signatureHex: string;
}

const request = { username: USERNAME, irkPub: hex(irk.publicKey), issuedAt: ISSUED_AT };

function signed(name: string, aidPub: Uint8Array | null, rootPub: Uint8Array | null): Case {
  const sig = signClaimUsername(
    {
      username: USERNAME,
      irkPub: irk.publicKey,
      issuedAt: ISSUED_AT,
      ...(aidPub ? { aidPub } : {}),
      ...(rootPub ? { adminRootPub: rootPub } : {}),
    },
    irk,
  );
  const c = canonical(aidPub ? hex(aidPub) : "", rootPub ? hex(rootPub) : "");
  if (hex(ed.sign(new TextEncoder().encode(c), irk.privateKey)) !== hex(sig)) throw new Error(`${name}: canonical drift`);
  return { name, request, aidPub: aidPub ? hex(aidPub) : null, adminRootPub: rootPub ? hex(rootPub) : null, canonical: c, signatureHex: hex(sig) };
}

const both = signed("aid-and-admin-root", aid.publicKey, root.publicKey);
const accept = [both, signed("admin-root-only", null, root.publicKey), signed("no-keys", null, null)];

const v1Bytes = ["flagship/claim-username/v1", USERNAME, hex(irk.publicKey), ISSUED_AT].join("|");
const reject = [
  { ...both, name: "swapped-aid-pub", aidPub: hex(otherAid.publicKey), canonical: canonical(hex(otherAid.publicKey), hex(root.publicKey)) },
  { ...both, name: "swapped-admin-root-pub", adminRootPub: hex(otherRoot.publicKey), canonical: canonical(hex(aid.publicKey), hex(otherRoot.publicKey)) },
  { ...both, name: "stripped-admin-root-pub", adminRootPub: null, canonical: canonical(hex(aid.publicKey), "") },
  {
    name: "v1-bytes-as-v2",
    request,
    aidPub: hex(aid.publicKey),
    adminRootPub: hex(root.publicKey),
    canonical: both.canonical,
    signatureHex: hex(ed.sign(new TextEncoder().encode(v1Bytes), irk.privateKey)),
    v1Canonical: v1Bytes,
  },
];

const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
for (const c of [...accept, ...reject]) {
  const ok = verifyClaimUsername(
    {
      username: c.request.username,
      irkPub: fromHex(c.request.irkPub),
      issuedAt: c.request.issuedAt,
      ...(c.aidPub ? { aidPub: fromHex(c.aidPub) } : {}),
      ...(c.adminRootPub ? { adminRootPub: fromHex(c.adminRootPub) } : {}),
    },
    fromHex(c.signatureHex),
    fromHex(c.request.irkPub),
  );
  if (ok !== accept.includes(c as Case)) throw new Error(`${c.name}: unexpected verdict ${ok}`);
}

const out = JSON.stringify(
  {
    about:
      "flagship/claim-username/v2: the IRK signs flagship/claim-username/v2|<username>|<irkPub hex>|<aidPub hex or empty>|<adminRootPub hex or empty>|<issuedAt ms>, lowercase hex, '|'-joined. The body's aidPub/adminRootPub (null = absent = empty field) are the keys signed. accept: verify under request.irkPub and canonical must equal the bytes built from the case. reject: build the canonical from the case's fields and the signature must NOT verify (keys swapped or stripped after signing, or a v1 signature presented as v2). Seeds are raw Ed25519 seeds.",
    keys: {
      irkSeedHex: hex(irk.privateKey),
      irkPubHex: hex(irk.publicKey),
      aidPubHex: hex(aid.publicKey),
      adminRootPubHex: hex(root.publicKey),
      otherAidPubHex: hex(otherAid.publicKey),
      otherAdminRootPubHex: hex(otherRoot.publicKey),
    },
    accept,
    reject,
  },
  null,
  2,
) + "\n";

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== out) {
    console.error("claim-username vectors are stale: run npx tsx tools/claim-username-vectors.ts");
    process.exit(1);
  }
} else {
  writeFileSync(OUT, out);
}
