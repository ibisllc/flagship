#!/usr/bin/env -S npx tsx
/**
 * Shared vectors for the PQ release endorsement (docs/architecture-v2/pq-suites.md §12). The
 * TypeScript port (packages/protocol/src/releaseEndorsementPq.ts) GENERATES them;
 * packages/protocol/tests/releaseEndorsementPqVectors.test.ts and
 * rust/crates/flagship-crypto/tests/release_pq_vectors.rs check them.
 *
 * Run:          npx tsx tools/release-pq-vectors.ts
 * CI freshness: npx tsx tools/release-pq-vectors.ts --check
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalReleaseEndorsement, intermediateMerkleRoot, signReleaseEndorsement, type ReleaseEndorsement } from "@ibisllc/maintainers";
import { hybridSigKeygen } from "../packages/protocol/src/pqHybrid.js";
import {
  canonicalReleaseEndorsementV2,
  releaseEndorsementV1Digest,
  releasePqKeyId,
  signReleaseEndorsementPq,
  signReleasePqBinding,
  type ReleaseEndorsementPqWire,
  type ReleasePqPin,
} from "../packages/protocol/src/releaseEndorsementPq.js";
import type { PqKeyBindingWire } from "../packages/protocol/src/pqTrust.js";

const OUT = resolve(import.meta.dirname, "..", "packages/protocol/test-vectors/release-endorsement-v2/vectors.json");

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fill = (n: number, v: number): Uint8Array => new Uint8Array(n).fill(v);
const zero = (s: string, from: number, to: number): string => s.slice(0, from * 2) + "00".repeat(to - from) + s.slice(to * 2);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function key(a: number, b: number) {
  const edSeed = fill(32, a);
  const mldsaSeed = fill(32, b);
  const { publicKey } = hybridSigKeygen(edSeed, mldsaSeed);
  const ed25519PubHex = hex(publicKey.subarray(0, 32));
  const mldsaPubHex = hex(publicKey.subarray(32));
  return {
    edSeedHex: hex(edSeed),
    mldsaSeedHex: hex(mldsaSeed),
    ed25519PubHex,
    mldsaPubHex,
    keyId: releasePqKeyId(ed25519PubHex, mldsaPubHex),
    edSign: async (m: Uint8Array) => ed25519.sign(m, edSeed),
    mldsaSeed,
  };
}

const REL = key(0x51, 0x52);
const OTHER = key(0x61, 0x62);
const NOW = 1_790_000_000_000;
const BOUND_AT = NOW - 86_400_000;

const commit = (n: number) => n.toString(16).padStart(2, "0").repeat(20);

function endorse(
  k: typeof REL,
  id: string,
  head: number,
  prev: ReleaseEndorsement | null,
  between: number[],
  issuedAt: string,
): ReleaseEndorsement {
  const intermediateCommits = [...between.map(commit), commit(head)];
  return signReleaseEndorsement(
    {
      kind: "ReleaseEndorsement",
      version: 1,
      releaseId: id,
      semverTag: `v0.0.0-${issuedAt.slice(0, 10)}-${commit(head).slice(0, 8)}`,
      commitHash: commit(head),
      previousReleaseId: prev?.releaseId ?? null,
      previousCommitHash: prev?.commitHash ?? null,
      intermediateCommits,
      intermediateMerkleRoot: intermediateMerkleRoot(intermediateCommits),
      endorsedNotes: null,
      issuedAt,
      signedBy: k.ed25519PubHex,
    },
    [{ privKey: k.edSeedHex }],
  );
}

async function main(): Promise<void> {
  const A = endorse(REL, "00000000-0000-4000-8000-00000000000a", 0x0a, null, [0x01, 0x02], "2026-10-01T00:00:00.000Z");
  const B = endorse(REL, "00000000-0000-4000-8000-00000000000b", 0x0b, A, [0x03], "2026-10-10T00:00:00.000Z");
  const C = endorse(REL, "00000000-0000-4000-8000-00000000000c", 0x0c, B, [0x04], "2026-10-20T00:00:00.000Z");
  const D = endorse(REL, "00000000-0000-4000-8000-00000000000d", 0x0d, C, [], "2026-10-21T00:00:00.000Z");
  const X = endorse(OTHER, "00000000-0000-4000-8000-0000000000ee", 0x0e, C, [], "2026-10-22T00:00:00.000Z");
  const notesChanged: ReleaseEndorsement = { ...C, endorsedNotes: "edited after signing" };
  const v1Zeroed: ReleaseEndorsement = { ...C, signatures: [{ pubkey: REL.ed25519PubHex, sig: "00".repeat(64) }] };

  const binding = await signReleasePqBinding(
    { ed25519PubHex: REL.ed25519PubHex, mldsaPubHex: REL.mldsaPubHex, issuedAt: BOUND_AT },
    REL.edSign,
    REL.mldsaSeed,
    { deterministic: true },
  );
  const otherBinding = await signReleasePqBinding(
    { ed25519PubHex: OTHER.ed25519PubHex, mldsaPubHex: OTHER.mldsaPubHex, issuedAt: BOUND_AT },
    OTHER.edSign,
    OTHER.mldsaSeed,
    { deterministic: true },
  );
  const sign = (e: ReleaseEndorsement, k = REL) => signReleaseEndorsementPq(e, k, k.edSign, k.mldsaSeed, { deterministic: true });
  const pqC = await sign(C);
  const pqX = await sign(X, OTHER);

  const pins: Record<string, ReleasePqPin> = {
    none: { version: 1, keyIds: [], requirePqAfter: null },
    main: { version: 1, keyIds: [REL.keyId], requirePqAfter: { releaseId: B.releaseId, commitHash: B.commitHash } },
    strict: { version: 1, keyIds: [REL.keyId], requirePqAfter: null },
    "marker-wrong-commit": { version: 1, keyIds: [REL.keyId], requirePqAfter: { releaseId: B.releaseId, commitHash: commit(0xff) } },
    both: { version: 1, keyIds: [REL.keyId, OTHER.keyId], requirePqAfter: null },
  };

  const sig = pqC.signature;
  const companionCases: Array<{ name: string; endorsement: string; companion: unknown; bindings: string[]; pin: string; expect: { ok: true; keyId: string } | { ok: false; code: string } }> = [];
  const ok = { ok: true as const, keyId: REL.keyId };
  const no = (code: string) => ({ ok: false as const, code });
  const cc = (name: string, endorsement: string, companion: unknown, expect: (typeof companionCases)[number]["expect"], bindings = ["release"], pin = "main") =>
    companionCases.push({ name, endorsement, companion: companion === undefined ? null : clone(companion), bindings, pin, expect });

  cc("valid", "C", pqC, ok);
  cc("valid-strict-pin", "C", pqC, ok, ["release"], "strict");
  cc("missing", "C", undefined, no("pq-missing"));
  cc("extra-field", "C", { ...pqC, note: "x" }, no("pq-malformed"));
  cc("wrong-kind", "C", { ...pqC, kind: "ReleaseEndorsement" }, no("pq-malformed"));
  cc("version-1", "C", { ...pqC, version: 1 }, no("pq-malformed"));
  cc("uppercase-key-id", "C", { ...pqC, keyId: pqC.keyId.toUpperCase() }, no("pq-malformed"));
  cc("other-release-id", "C", { ...pqC, releaseId: D.releaseId }, no("pq-mismatch"));
  cc("other-commit", "C", { ...pqC, commitHash: D.commitHash }, no("pq-mismatch"));
  cc("applied-to-another-endorsement", "D", { ...pqC, releaseId: D.releaseId, commitHash: D.commitHash }, no("pq-mismatch"));
  cc("v1-edited-after-signing", "C-notes-changed", pqC, no("pq-mismatch"));
  cc("v1-digest-relabelled", "C-notes-changed", { ...pqC, v1Digest: releaseEndorsementV1Digest(notesChanged) }, no("v1-signature"));
  cc("key-not-pinned", "X", pqX, no("pq-key-not-pinned"), ["release", "other"], "main");
  cc("v1-signer-not-the-bound-key", "X", { ...pqX, keyId: REL.keyId }, no("binding-key-mismatch"), ["release", "other"], "main");
  cc("no-binding-on-file", "C", pqC, no("no-binding"), []);
  cc("v1-signature-zeroed", "C-v1-zeroed", { ...pqC, v1Digest: releaseEndorsementV1Digest(v1Zeroed) }, no("v1-signature"));
  cc("suite-relabelled-classical", "C", { ...pqC, suite: "ed25519/v1", signature: sig.slice(0, 128) }, no("strict-requires-hybrid"));
  cc("unknown-suite", "C", { ...pqC, suite: "mldsa65/v1" }, no("unknown-suite"));
  cc("pq-half-stripped", "C", { ...pqC, signature: sig.slice(0, 128) }, no("bad-signature"));
  cc("ed-half-stripped", "C", { ...pqC, signature: sig.slice(128) }, no("bad-signature"));
  cc("pq-half-zeroed", "C", { ...pqC, signature: zero(sig, 64, 3373) }, no("bad-signature"));
  cc("ed-half-zeroed", "C", { ...pqC, signature: zero(sig, 0, 64) }, no("bad-signature"));
  cc("signature-of-another-release", "D", { ...pqC, releaseId: D.releaseId, commitHash: D.commitHash, v1Digest: releaseEndorsementV1Digest(D) }, no("bad-signature"));
  cc("both-keys-pinned-other-valid", "X", pqX, { ok: true, keyId: OTHER.keyId }, ["release", "other"], "both");

  const bindingCases = [
    { name: "pinned", binding: "release", pin: "main", expect: { verified: [REL.keyId], errors: [] as string[] } },
    { name: "not-pinned", binding: "other", pin: "main", expect: { verified: [] as string[], errors: ["pq-key-not-pinned"] } },
    { name: "wrong-role", binding: "release-as-box-stk", pin: "main", expect: { verified: [] as string[], errors: ["binding-role"] } },
    { name: "compact-on-another-role", binding: "compact-as-box-stk", pin: "main", expect: { verified: [] as string[], errors: ["binding-malformed"] } },
    { name: "tampered", binding: "release-tampered", pin: "main", expect: { verified: [] as string[], errors: ["bad-signature"] } },
  ];

  const classifyCases = [
    { name: "rollout", pin: "main", companions: ["C"], bindings: ["release"], expect: { eligible: ["C"], lineageOnly: ["A", "B"], refused: [{ endorsement: "D", code: "pq-missing" }] } },
    { name: "no-pin-keeps-v1", pin: "none", companions: [], bindings: [], expect: { eligible: ["A", "B", "C", "D"], lineageOnly: [] as string[], refused: [] as { endorsement: string; code: string }[] } },
    { name: "strict-pin-no-lineage", pin: "strict", companions: ["C"], bindings: ["release"], expect: { eligible: ["C"], lineageOnly: [] as string[], refused: [{ endorsement: "A", code: "pq-missing" }, { endorsement: "B", code: "pq-missing" }, { endorsement: "D", code: "pq-missing" }] } },
    { name: "marker-with-wrong-commit", pin: "marker-wrong-commit", companions: ["C"], bindings: ["release"], expect: { eligible: ["C"], lineageOnly: [] as string[], refused: [{ endorsement: "A", code: "pq-missing" }, { endorsement: "B", code: "pq-missing" }, { endorsement: "D", code: "pq-missing" }] } },
    { name: "binding-missing", pin: "main", companions: ["C"], bindings: [], expect: { eligible: [] as string[], lineageOnly: ["A", "B"], refused: [{ endorsement: "C", code: "no-binding" }, { endorsement: "D", code: "pq-missing" }] } },
  ];

  const bindings: Record<string, PqKeyBindingWire | unknown> = {
    release: binding,
    other: otherBinding,
    // Relabelled to another role on the v1 wire: refused for its role. On the compact v2 wire (the release key's own
    // form) any other role is malformed, which "compact-as-box-stk" pins.
    "release-as-box-stk": { ...binding, v: 1, role: "box-stk" },
    "compact-as-box-stk": { ...binding, role: "box-stk" },
    "release-tampered": { ...binding, issuedAt: BOUND_AT + 1 },
  };
  const companions: Record<string, ReleaseEndorsementPqWire> = { C: pqC };

  const endorsements: Record<string, ReleaseEndorsement> = { A, B, C, D, X, "C-notes-changed": notesChanged, "C-v1-zeroed": v1Zeroed };
  const statements = Object.fromEntries(
    [A, B, C, D].map((e) => [
      e.releaseId,
      {
        v1CanonicalHex: hex(canonicalReleaseEndorsement((({ signatures: _s, ...r }) => r)(e))),
        v1Digest: releaseEndorsementV1Digest(e),
        v2StatementHex: hex(canonicalReleaseEndorsementV2(e, REL.keyId)),
      },
    ]),
  );

  const doc = {
    description:
      "flagship/release-endorsement/v2: the hybrid (Ed25519 AND ML-DSA-65) companion of a maintainers ReleaseEndorsement, its release-key binding and the pin rule. docs/architecture-v2/pq-suites.md §12. DRAFT, pending Q01 external review.",
    generator: "tools/release-pq-vectors.ts",
    now: NOW,
    keys: {
      release: { ed25519PubHex: REL.ed25519PubHex, mldsaPubHex: REL.mldsaPubHex, keyId: REL.keyId, edSeedHex: REL.edSeedHex, mldsaSeedHex: REL.mldsaSeedHex },
      other: { ed25519PubHex: OTHER.ed25519PubHex, mldsaPubHex: OTHER.mldsaPubHex, keyId: OTHER.keyId, edSeedHex: OTHER.edSeedHex, mldsaSeedHex: OTHER.mldsaSeedHex },
    },
    pins,
    bindings,
    endorsements,
    companions,
    statements,
    companionCases,
    bindingCases,
    classifyCases,
  };
  const text = JSON.stringify(doc, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const cur = readFileSync(OUT, "utf8");
    if (cur !== text) {
      console.error(`${OUT} is stale: run npx tsx tools/release-pq-vectors.ts`);
      process.exit(1);
    }
    console.log("release-endorsement-v2 vectors are fresh");
    return;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}

await main();
