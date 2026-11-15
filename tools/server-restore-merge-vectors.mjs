// Writes packages/protocol/test-vectors/server-restore-merge/vectors.json
// (docs/restore-into-server.md §4). `--check` exits 1 when the file on disk differs.
// Run: node --import tsx tools/server-restore-merge-vectors.mjs [--check]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ed } from "../packages/protocol/src/edSync.ts";
import { hybridSign, hybridSigKeygen, hybridVerify } from "../packages/protocol/src/pqHybrid.ts";
import {
  appRestoreUndoCanonicalBytes,
  restoreMergePlanLineString,
  restoreMergePlanSha256,
  serverRestoreMergeCanonicalBytes,
  serverRestoreStageCanonicalBytes,
  signAppRestoreUndo,
  signServerRestoreMerge,
  signServerRestoreStage,
} from "../packages/protocol/src/serverRestoreMerge.ts";

const OUT = "packages/protocol/test-vectors/server-restore-merge/vectors.json";
const hex = (b) => Buffer.from(b).toString("hex");
const text = (b) => new TextDecoder().decode(b);
const seed = new Uint8Array(32).fill(0x52);
const admin = { privateKey: seed, publicKey: ed.getPublicKey(seed) };
const domain = "home.harry.flagship.services";
const archiveId = "00112233445566778899aabbccddeeff";
const restoreId = "a0a1a2a3a4a5a6a7a8a9aaabacadaeaf";
const sha = "ab".repeat(32);

const stage = { serverDomain: domain, archiveId, bytes: 123456789, sha256: sha, source: "saved", issuedAt: 1794000000000 };
const lines = [
  { archivedServiceId: "harry--notes", action: "replace", sameApp: false, guardCode: `tree:${"11".repeat(32)}`, guardSchema: "22".repeat(32), guardGen: 0 },
  { archivedServiceId: "sam--chess", action: "copy", targetServiceId: "harry--chess-restored", sameApp: false },
  { archivedServiceId: "harry--blog", action: "keep", sameApp: false },
  { archivedServiceId: "harry--photos", action: "replace-data", sameApp: false, guardCode: `sha256:${"33".repeat(32)}`, guardSchema: "44".repeat(32), guardGen: 2 },
  { archivedServiceId: "harry--todo", action: "install", sameApp: false },
  { archivedServiceId: "bob--wiki", action: "replace", sameApp: true, guardCode: `wasi:${"55".repeat(32)}`, guardSchema: "66".repeat(32), guardGen: 1 },
  { archivedServiceId: "harry--old", action: "skip", sameApp: false },
];
const planSha256 = restoreMergePlanSha256(lines);
const sortedLines = [...lines].sort((a, b) => (a.archivedServiceId < b.archivedServiceId ? -1 : 1)).map(restoreMergePlanLineString);
const merge = { serverDomain: domain, restoreId, archiveId, sha256: sha, planSha256, issuedAt: 1794000060000, expiresAt: 1794086460000 };
const undo = { serverDomain: domain, restoreId, serviceId: "harry--notes", action: "undo", issuedAt: 1794000120000 };
const discard = { ...undo, action: "discard" };

const invalidLines = [
  ["a copy without its new app", { archivedServiceId: "harry--x", action: "copy", sameApp: false }],
  ["a replace without guards", { archivedServiceId: "harry--x", action: "replace", sameApp: false }],
  ["a keep with a guard", { archivedServiceId: "harry--x", action: "keep", sameApp: false, guardGen: 0 }],
  ["sameApp on a replace-data", { archivedServiceId: "harry--x", action: "replace-data", sameApp: true, guardCode: `tree:${"11".repeat(32)}`, guardSchema: "22".repeat(32), guardGen: 0 }],
  ["an unknown action", { archivedServiceId: "harry--x", action: "merge", sameApp: false }],
  ["a bar in an id", { archivedServiceId: "harry--x|y", action: "skip", sameApp: false }],
];
for (const [name, l] of invalidLines) {
  let threw = false;
  try {
    restoreMergePlanLineString(l);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`invalid line accepted: ${name}`);
}

// The admin root's hybrid half (hybrid-ed25519-mldsa65/v1, purpose = the order's tag) over the same
// canonical bytes, sent as `pqSignature: {suite, signature}`. A strict box refuses an order without it.
const mldsaSeed = new Uint8Array(32).fill(0x53);
const hybridKey = hybridSigKeygen(seed, mldsaSeed);
const hybridSecret = Uint8Array.from([...seed, ...mldsaSeed]);
const pqOf = (canonical) => {
  const purpose = text(canonical).split("|")[0];
  const sig = hybridSign(hybridSecret, purpose, canonical, { deterministic: true });
  hybridVerify(hybridKey.publicKey, purpose, canonical, sig);
  return { suite: "hybrid-ed25519-mldsa65/v1", signature: hex(sig) };
};

const doc = {
  about:
    "Restore into a running server (docs/restore-into-server.md §4). Ed25519 with seed 0x52 repeated. stage: tag|serverDomain|archiveId|bytes|sha256|source|issuedAt. merge: tag|serverDomain|restoreId|archiveId|sha256|planSha256|issuedAt|expiresAt, where planSha256 = SHA-256 hex of the plan lines sorted by archived id and joined by \\n, a line being archivedServiceId|action|target or -|sameApp 0/1|guardCode or -|guardSchema or -|guardGen or -. undo: tag|serverDomain|restoreId|serviceId|undo or discard|issuedAt. Every invalid line must be refused before signing.",
  adminSeedHex: hex(seed),
  adminPubHex: hex(admin.publicKey),
  stage: { order: stage, canonical: text(serverRestoreStageCanonicalBytes(stage)), signatureHex: hex(signServerRestoreStage(stage, admin)) },
  plan: { lines, sortedLines, planSha256 },
  merge: { order: merge, canonical: text(serverRestoreMergeCanonicalBytes(merge)), signatureHex: hex(signServerRestoreMerge(merge, admin)) },
  undo: [undo, discard].map((o) => ({ order: o, canonical: text(appRestoreUndoCanonicalBytes(o)), signatureHex: hex(signAppRestoreUndo(o, admin)) })),
  invalidLines: invalidLines.map(([name, line]) => ({ name, line })),
  hybrid: {
    about:
      "The admin root's hybrid signature (hybrid-ed25519-mldsa65/v1, purpose = the order's tag, the text before the first |) over each canonical above, sent beside signatureHex as pqSignature: {suite, signature}. ML-DSA-65 seed 0x53 repeated; the hybrid public key is the Ed25519 key followed by the ML-DSA-65 key. Signed deterministically here; a client may sign hedged, the box verifies either.",
    mldsaSeedHex: hex(mldsaSeed),
    hybridPubHex: hex(hybridKey.publicKey),
    stage: pqOf(serverRestoreStageCanonicalBytes(stage)),
    merge: pqOf(serverRestoreMergeCanonicalBytes(merge)),
    undo: [undo, discard].map((o) => pqOf(appRestoreUndoCanonicalBytes(o))),
  },
};
const out = JSON.stringify(doc, null, 2) + "\n";
if (process.argv.includes("--check")) {
  let disk = "";
  try {
    disk = readFileSync(OUT, "utf8");
  } catch {}
  if (disk !== out) {
    console.error(`${OUT} is out of date: run node --import tsx tools/server-restore-merge-vectors.mjs`);
    process.exit(1);
  }
  console.log("server-restore-merge vectors: ok");
} else {
  mkdirSync("packages/protocol/test-vectors/server-restore-merge", { recursive: true });
  writeFileSync(OUT, out);
  console.log("wrote", OUT);
}
