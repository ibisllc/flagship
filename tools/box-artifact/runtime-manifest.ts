#!/usr/bin/env -S npx tsx
/**
 * Build, sign and verify the signed runtime manifest (packages/protocol/src/runtimeManifest.ts) from
 * release/runtime-lock.json. The published file is `{ manifest, signatures, pqBindings?, lockJson }`; `lockJson` is the
 * exact text of the lock, so `manifest.lockSha256` can be checked by anyone with `shasum -a 256`.
 *
 *   build  --sequence N [--valid-days 45] [--revoke FP,FP] [--lock release/runtime-lock.json] --out unsigned.json
 *   sign   --manifest unsigned.json --out signed.json (--key-file <hexseed> | --signer-cmd <cmd>)
 *   verify --manifest signed.json [--trust release/box-artifact-trust.json] [--last-sequence N] [--now ms]
 *
 * `--signer-cmd` is the box artifact's contract (scripts/yubikey-sign.mjs): it reads the canonical bytes on stdin and
 * prints `<pubkeyhex> <signaturehex>`. The PQ companion is added by `node scripts/pq-release-key.mjs
 * sign-runtime-manifest` (the same release key, a YubiKey-encrypted seed), then `verify` again.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import {
  canonicalRuntimeManifest,
  signRuntimeManifest,
  verifyRuntimeManifest,
  type RuntimeManifest,
  type RuntimeManifestPq,
  type RuntimeManifestSignature,
} from "../../packages/protocol/src/runtimeManifest.js";

const REPO = join(import.meta.dirname, "..", "..");

interface Doc {
  manifest: RuntimeManifest;
  signatures: RuntimeManifestSignature[];
  pqBindings?: unknown[];
  lockJson: string;
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function need(argv: string[], name: string): string {
  const v = arg(argv, name);
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");

export function buildRuntimeManifest(lockText: string, o: { sequence: number; issuedAt: number; validDays: number; revoked?: string[] }): Doc {
  const lock = JSON.parse(lockText) as { version: string; securityFloor: string; runtime: string; keyring?: { signers?: { fingerprint: string }[] } };
  const manifest: RuntimeManifest = {
    runtime: lock.runtime as "node",
    version: lock.version,
    lockSha256: sha256(lockText),
    securityFloor: lock.securityFloor,
    sequence: o.sequence,
    issuedAt: o.issuedAt,
    validUntil: o.issuedAt + o.validDays * 86_400_000,
    revokedSigners: o.revoked ?? [],
  };
  canonicalRuntimeManifest(manifest); // refuses a malformed manifest before anything is signed
  return { manifest, signatures: [], lockJson: lockText };
}

function build(argv: string[]): void {
  const lockText = readFileSync(arg(argv, "lock") ?? join(REPO, "release/runtime-lock.json"), "utf8");
  const doc = buildRuntimeManifest(lockText, {
    sequence: Number(need(argv, "sequence")),
    issuedAt: Number(arg(argv, "issued-at") ?? Date.now()),
    validDays: Number(arg(argv, "valid-days") ?? 45),
    revoked: (arg(argv, "revoke") ?? "").split(",").filter(Boolean).map((f) => f.toLowerCase()),
  });
  writeFileSync(need(argv, "out"), JSON.stringify(doc, null, 2) + "\n");
  console.log(`runtime manifest for node ${doc.manifest.version}, sequence ${doc.manifest.sequence}, valid until ${new Date(doc.manifest.validUntil).toISOString()}`);
}

function sign(argv: string[]): void {
  const doc = JSON.parse(readFileSync(need(argv, "manifest"), "utf8")) as Doc;
  const keyFile = arg(argv, "key-file");
  const signerCmd = arg(argv, "signer-cmd");
  let sig: RuntimeManifestSignature;
  if (keyFile) {
    sig = signRuntimeManifest(doc.manifest, Uint8Array.from(Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex")));
  } else if (signerCmd) {
    const r = spawnSync("sh", ["-c", signerCmd], { input: Buffer.from(canonicalRuntimeManifest(doc.manifest)), encoding: "utf8" });
    const m = /^([0-9a-f]{64})\s+([0-9a-f]{128})\s*$/.exec(r.stdout);
    if (r.status !== 0 || !m) throw new Error("the signer command did not print '<pubkeyhex> <signaturehex>'");
    sig = { keyHex: m[1]!, signatureHex: m[2]! };
  } else {
    throw new Error("give --key-file or --signer-cmd");
  }
  doc.signatures = [...doc.signatures.filter((s) => s.keyHex !== sig.keyHex), sig];
  writeFileSync(need(argv, "out"), JSON.stringify(doc, null, 2) + "\n");
  console.log(`signed by ${sig.keyHex}`);
}

export function verifyRuntimeManifestFile(doc: Doc, trust: { keys: string[]; threshold: number; pq?: { keyIds?: string[]; legacyManifests?: string[] } }, now: number, lastSequence?: number) {
  const lock = JSON.parse(doc.lockJson) as { keyring?: { signers?: { fingerprint: string }[] } };
  return verifyRuntimeManifest(doc.manifest, doc.signatures, {
    trust: { keys: trust.keys, threshold: trust.threshold },
    ...(trust.pq ? { pqPin: { version: 1 as const, keyIds: trust.pq.keyIds ?? [], legacyManifests: trust.pq.legacyManifests ?? [] } } : {}),
    pqBindings: doc.pqBindings ?? [],
    lockText: doc.lockJson,
    lockSigners: (lock.keyring?.signers ?? []).map((s) => s.fingerprint),
    now,
    ...(lastSequence !== undefined ? { lastSequence } : {}),
  });
}

function verify(argv: string[]): void {
  const doc = JSON.parse(readFileSync(need(argv, "manifest"), "utf8")) as Doc;
  const trust = JSON.parse(readFileSync(arg(argv, "trust") ?? join(REPO, "release/box-artifact-trust.json"), "utf8"));
  const last = arg(argv, "last-sequence");
  const r = verifyRuntimeManifestFile(doc, trust, Number(arg(argv, "now") ?? Date.now()), last !== undefined ? Number(last) : undefined);
  if (!r.ok) {
    console.error(`refused: ${r.code}${r.detail ? ` (${r.detail})` : ""}`);
    process.exit(1);
  }
  console.log(`verified: node ${doc.manifest.version} sequence ${doc.manifest.sequence}, signed by ${r.signers.length} authorized key(s)`);
}

const cmd = process.argv[2];
if (process.argv[1] && basename(process.argv[1]).startsWith("runtime-manifest")) {
  try {
    if (cmd === "build") build(process.argv.slice(3));
    else if (cmd === "sign") sign(process.argv.slice(3));
    else if (cmd === "verify") verify(process.argv.slice(3));
    else throw new Error("usage: runtime-manifest.ts build|sign|verify ... (see the header)");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
export type { RuntimeManifestPq };
