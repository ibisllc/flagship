#!/usr/bin/env node
// gpu-catalog — build, sign and verify the signed GPU compatibility catalog
// (docs/architecture-v2/gpu-and-wasi.md §1.5, plan §9.3, work package G01).
//
// The catalog is signed under the release-key trust model of the box artifact
// (release/box-artifact-trust.json): each release signer adds an Ed25519 signature
// (the YubiKey, PIV slot 9c) over
//   flagship/gpu-compat-catalog/v1|<signer key>|<serial>|sha256:<payload>
// until the threshold is met, and, once that file's pq.keyIds names the hybrid
// release key, a PQ companion over
//   flagship/gpu-compat-catalog/v2|<signer key>|<serial>|sha256:<payload>|<pq key id>
// under a release-key binding for subject flagship-gpu-catalog. The box checks it
// in Rust (flagship-gpu catalog_trust.rs, `flagship-gpud verify-catalog`); `verify`
// here runs the same rules.
//
// Usage:
//   node scripts/gpu-catalog.mjs build --matrix release/gpu-catalog/matrix.json \
//        --receipts docs/architecture-v2/gpu-receipts --serial <n> --out <payload.json>
//   node scripts/gpu-catalog.mjs sign --payload <payload.json> --out <catalog.json>
//        [--signing-key yubikey-piv:slot=9c|file:<seed hex file>] [--pq]
//        [--key-file <age file>] [--fake-yubikey <dir>] [--pq-seed file:<hex>]
//   node scripts/gpu-catalog.mjs verify --catalog <catalog.json> [--trust release/box-artifact-trust.json] [--now <ms>]
//
//   build   keeps only the matrix profiles whose every receipt file exists (receipts/<id>.md),
//           pins each receipt's SHA-256, and refuses a profile with a missing exact field
//   sign    adds this signer's signature (and companion with --pq) to <out>; run once per signer
//           (k-of-n); <out> must hold the same payload or not exist
//   --pq-seed  TEST MODE: an ML-DSA seed from a file instead of the YubiKey-encrypted release key
//
// Exit codes: 0 ok, 1 error, 2 usage.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ed25519VerifyStrict,
  hybridSignExternal,
  hybridVerify,
  mldsa65PublicKey,
  pqBindingPublicKey,
  pqKeyId,
  SUITE_HYBRID_SIG_ED25519_MLDSA65_V1,
  verifyPqKeyBinding,
} from "@flagship/protocol";
import {
  DEFAULT_KEY_FILE,
  loadEd25519Signer,
  signSubjectBinding,
  UsageError,
  vaultFromFlags,
  withSeed,
} from "./pq-release-key.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");
export const SCHEMA = "flagship/gpu-compat-catalog/v1";
export const PQ_TAG = "flagship/gpu-compat-catalog/v2";
export const SUBJECT = "flagship-gpu-catalog";
const MATRIX_SCHEMA = "flagship/gpu-qualification-matrix/v1";
const HEX64 = /^[0-9a-f]{64}$/;

const sha256Hex = (b) => createHash("sha256").update(b).digest("hex");
const toHex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const utf8 = (s) => new TextEncoder().encode(s);

export function signingBytes(keyHex, serial, payload) {
  return utf8(`${SCHEMA}|${keyHex.toLowerCase()}|${serial}|sha256:${sha256Hex(payload)}`);
}

export function pqStatement(keyHex, serial, payload, keyIdHex) {
  return utf8(`${PQ_TAG}|${keyHex.toLowerCase()}|${serial}|sha256:${sha256Hex(payload)}|${keyIdHex.toLowerCase()}`);
}

const ENTRY_FIELDS = [
  "id", "backend", "pciDeviceIds", "model", "kernels", "moduleSigningRequired", "drivers", "toolkits",
  "cdiGenerators", "runsc", "vmRuntimes", "isolation", "capabilities", "graphicsApis", "videoCodecs",
  "partitioning", "cooperativeSharing", "images", "driverPackages", "cleanup",
];

/** The catalog payload from the matrix: only fully receipted, exact profiles. */
export function buildPayload(matrix, receiptsDir, serial, issuedAt = new Date().toISOString()) {
  if (matrix?.schema !== MATRIX_SCHEMA || !Array.isArray(matrix.profiles)) throw new UsageError(`not a ${MATRIX_SCHEMA} file`);
  const entries = [];
  const skipped = [];
  for (const p of matrix.profiles) {
    const ids = Array.isArray(p.receiptIds) ? p.receiptIds : [];
    const missing = ids.filter((id) => !fs.existsSync(path.join(receiptsDir, `${id}.md`)));
    if (ids.length === 0 || missing.length) {
      skipped.push({ id: p.entry?.id ?? "?", why: ids.length ? `missing receipts: ${missing.join(", ")}` : "no receipts named" });
      continue;
    }
    const e = p.entry ?? {};
    const empty = ["pciDeviceIds", "kernels", "drivers", "toolkits", "isolation", "capabilities", "images", "driverPackages"].filter(
      (k) => !Array.isArray(e[k]) || e[k].length === 0,
    );
    if (empty.length) {
      skipped.push({ id: e.id ?? "?", why: `not exact yet: ${empty.join(", ")}` });
      continue;
    }
    const entry = {};
    for (const k of ENTRY_FIELDS) if (e[k] !== undefined) entry[k] = e[k];
    entry.receipts = ids.map((id) => ({ id, sha256: sha256Hex(fs.readFileSync(path.join(receiptsDir, `${id}.md`))) }));
    entries.push(entry);
  }
  return {
    payload: { schema: SCHEMA, serial, issuedAt, entries, advisories: matrix.advisories ?? [] },
    skipped,
  };
}

/** Adds one signer to an envelope (k-of-n), with its PQ companion when `seed` is given. */
export async function addSignature(envelope, ed, seed = null, now = Date.now()) {
  const sig = await ed.sign(signingBytes(ed.pubHex, envelope.serial, envelope.payload));
  const entry = { keyHex: ed.pubHex, signatureHex: toHex(sig) };
  const next = { ...envelope, signatures: envelope.signatures.filter((s) => s.keyHex !== ed.pubHex), pqBindings: [...(envelope.pqBindings ?? [])] };
  if (seed) {
    const mldsaPubHex = toHex(mldsa65PublicKey(seed));
    const pk = pqBindingPublicKey({ ed25519PubHex: ed.pubHex, mldsaPubHex });
    const keyId = toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk));
    const pqSig = await hybridSignExternal(pk, PQ_TAG, pqStatement(ed.pubHex, envelope.serial, envelope.payload, keyId), ed.sign, seed);
    entry.pq = { keyId, suite: "hybrid-ed25519-mldsa65/v1", signatureHex: toHex(pqSig) };
    if (!next.pqBindings.some((b) => b.ed25519PubHex === ed.pubHex && b.mldsaPubHex === mldsaPubHex)) {
      next.pqBindings.push(await signSubjectBinding(SUBJECT, ed, seed, now));
    }
  }
  next.signatures = [...next.signatures, entry];
  return next;
}

/** The box's rules (catalog_trust.rs): threshold of trusted keys, PQ companions once pinned. */
export function verifyEnvelope(envelope, trust, now = Date.now()) {
  if (envelope?.schema !== SCHEMA) return { ok: false, reason: "schema" };
  const payload = JSON.parse(envelope.payload);
  if (payload.serial !== envelope.serial) return { ok: false, reason: "serial" };
  const keys = (trust.keys ?? []).map((k) => k.toLowerCase());
  const pinned = (trust.pq?.keyIds ?? []).map((k) => k.toLowerCase());
  const good = new Set();
  const errors = [];
  for (const s of envelope.signatures ?? []) {
    const key = String(s.keyHex).toLowerCase();
    if (!keys.includes(key)) {
      errors.push(`${key.slice(0, 12)}: not a release signer`);
      continue;
    }
    if (!ed25519VerifyStrict(fromHex(s.signatureHex), signingBytes(key, envelope.serial, envelope.payload), fromHex(key))) {
      errors.push(`${key.slice(0, 12)}: bad-signature`);
      continue;
    }
    if (pinned.length) {
      if (!s.pq) {
        errors.push(`${key.slice(0, 12)}: pq-missing`);
        continue;
      }
      if (!pinned.includes(s.pq.keyId)) {
        errors.push(`${key.slice(0, 12)}: pq-key-not-pinned`);
        continue;
      }
      let ok = false;
      for (const w of (envelope.pqBindings ?? []).filter((b) => b.subjectId === SUBJECT && b.ed25519PubHex === key)) {
        try {
          const b = verifyPqKeyBinding(w, { role: "release-key", subjectId: SUBJECT, ed25519PubHex: key, now });
          if (b.keyIdHex !== s.pq.keyId) continue;
          hybridVerify(b.hybridPublicKey, PQ_TAG, pqStatement(key, envelope.serial, envelope.payload, s.pq.keyId), fromHex(s.pq.signatureHex));
          ok = true;
          break;
        } catch {
          // try the next binding
        }
      }
      if (!ok) {
        errors.push(`${key.slice(0, 12)}: pq companion does not verify`);
        continue;
      }
    }
    good.add(key);
  }
  const ok = good.size >= (trust.threshold ?? 1) && (trust.threshold ?? 0) >= 1;
  return { ok, signers: good.size, threshold: trust.threshold, errors, serial: envelope.serial, entries: payload.entries.map((e) => e.id) };
}

function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const a = { verb };
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (!k.startsWith("--")) throw new UsageError(`unexpected ${k}`);
    const name = k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (name === "pq") {
      a.pq = true;
      continue;
    }
    a[name] = rest[++i];
  }
  return a;
}

async function main() {
  let a;
  try {
    a = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  const out = (s) => process.stdout.write(s + "\n");
  if (a.verb === "build") {
    if (!a.matrix || !a.receipts || !a.serial || !a.out) throw new UsageError("build needs --matrix --receipts --serial --out");
    const { payload, skipped } = buildPayload(JSON.parse(fs.readFileSync(a.matrix, "utf8")), a.receipts, Number(a.serial), a.issuedAt);
    fs.writeFileSync(a.out, JSON.stringify(payload, null, 2) + "\n");
    out(`wrote ${a.out}: ${payload.entries.length} qualified entries`);
    for (const s of skipped) out(`  not in the catalog: ${s.id} (${s.why})`);
    return 0;
  }
  if (a.verb === "sign") {
    if (!a.payload || !a.out) throw new UsageError("sign needs --payload and --out");
    const payloadText = JSON.stringify(JSON.parse(fs.readFileSync(a.payload, "utf8")));
    const serial = JSON.parse(payloadText).serial;
    let env = { schema: SCHEMA, serial, payload: payloadText, signatures: [], pqBindings: [] };
    if (fs.existsSync(a.out)) {
      const prev = JSON.parse(fs.readFileSync(a.out, "utf8"));
      if (prev.payload !== payloadText) throw new Error(`${a.out} holds a different payload; sign the same payload or remove it`);
      env = prev;
    }
    const ed = await loadEd25519Signer(a.signingKey ?? "yubikey-piv:slot=9c");
    let next;
    if (a.pq && a.pqSeed) {
      if (!a.pqSeed.startsWith("file:")) throw new UsageError("--pq-seed takes file:<hex seed>");
      out("TEST MODE: the ML-DSA seed comes from a file. Nothing here protects a real release key.");
      const seed = Uint8Array.from(Buffer.from(fs.readFileSync(a.pqSeed.slice(5), "utf8").trim(), "hex"));
      next = await addSignature(env, ed, seed);
    } else if (a.pq) {
      out("Opening the release ML-DSA key: PIN and touch on a YubiKey.");
      next = await withSeed(vaultFromFlags({ fakeYubikey: a.fakeYubikey }), a.keyFile ?? DEFAULT_KEY_FILE, (seed) => addSignature(env, ed, seed));
    } else {
      next = await addSignature(env, ed, null);
    }
    fs.writeFileSync(a.out, JSON.stringify(next, null, 2) + "\n");
    out(`wrote ${a.out}: ${next.signatures.length} signature(s), serial ${serial}`);
    return 0;
  }
  if (a.verb === "verify") {
    if (!a.catalog) throw new UsageError("verify needs --catalog");
    const trust = JSON.parse(fs.readFileSync(a.trust ?? path.join(REPO, "release", "box-artifact-trust.json"), "utf8"));
    const r = verifyEnvelope(JSON.parse(fs.readFileSync(a.catalog, "utf8")), trust, a.now ? Number(a.now) : Date.now());
    out(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  process.stderr.write("usage: gpu-catalog.mjs build|sign|verify (see the header)\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}

export { HEX64 };
