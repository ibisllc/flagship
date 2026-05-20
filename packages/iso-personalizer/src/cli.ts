/**
 * `personalize-iso` — local CLI that turns the base Flagship Alpine ISO
 * into a personalized one with a trailer carrying a self-consistent
 * install blob.
 *
 * Two modes:
 *
 *   1. Standalone (default) — derive an IRK from a seed and synthesize a
 *      self-signed install blob for (username, server-name). Useful for
 *      offline tests that just need the trailer to round-trip.
 *
 *   2. `--blob-json <path>` — read a pre-built install blob + signature
 *      JSON (the exact shape `.com` returns from `/api/build-tickets/
 *      issue` → `envelope.blob` + `envelope.blobSignature`, or the bare
 *      InstallBlob JSON `{ blob, signature }`) and bake that blob into
 *      the trailer verbatim. The e2e harness uses this so the trailer
 *      matches the auth-code `.com` already recorded for the ticket.
 *
 * The pure helpers (arg parsing, label validation, blob synthesis,
 * trailer-with-provided-signature builder) are unit-tested in
 * `tests/cli.test.ts`; only `main()`'s file/process I/O is unexercised.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

import {
  deriveIRK,
  signAuthCode,
  ed,
  type AuthCode,
  type InstallBlob,
  type Bytes,
  type Keypair,
} from "@flagship/protocol";

import {
  buildTrailer,
  parseTrailer,
  installBlobFromJson,
  installBlobToJson,
  MAGIC_HEADER,
  MAGIC_FOOTER,
  FORMAT_VERSION,
  SIG_LEN,
  HEADER_LEN,
  FOOTER_LEN,
  VERSION_LEN,
  JSON_LEN_FIELD,
  TOTAL_SIZE_FIELD,
  MAX_TRAILER_BYTES,
} from "./trailer.js";
import { personalizeBytes } from "./personalize.js";

/* ───────────────────────── pure helpers (unit-tested) ─────────────── */

export interface ParsedArgs {
  baseIso?: string;
  output?: string;
  username?: string;
  serverName?: string;
  blobJson?: string;
  seedHex?: string;
  verify: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== "string" || !tok.startsWith("--")) {
      throw new Error(`unexpected argument: ${String(tok)}`);
    }
    const key = tok.slice(2);
    if (key === "verify" || key === "help") {
      a[key] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      throw new Error(`flag --${key} requires a value`);
    }
    a[key] = val;
    i++;
  }
  return {
    baseIso: typeof a["base-iso"] === "string" ? a["base-iso"] : undefined,
    output: typeof a["output"] === "string" ? a["output"] : undefined,
    username: typeof a["username"] === "string" ? a["username"] : undefined,
    serverName: typeof a["server-name"] === "string" ? a["server-name"] : undefined,
    blobJson: typeof a["blob-json"] === "string" ? a["blob-json"] : undefined,
    seedHex: typeof a["seed-hex"] === "string" ? a["seed-hex"] : undefined,
    verify: a["verify"] === true,
    help: a["help"] === true,
  };
}

/** RFC-1035 single label, lowercased — same regex as the rest of the codebase. */
export const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function validateLabel(name: unknown, what: string): asserts name is string {
  if (typeof name !== "string" || !LABEL_RE.test(name)) {
    throw new Error(
      `--${what} must be a single RFC-1035 label (got: ${JSON.stringify(name)})`,
    );
  }
}

export function hexToBytes(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 2 !== 0) {
    throw new Error(`bad hex string: ${JSON.stringify(s)}`);
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** 26-char hex serial — matches `tools/vps-e2e/src/wire.ts:genSerial`. */
export function genSerial(rand: (n: number) => Uint8Array): string {
  const r = rand(10);
  let s = "01";
  for (const x of r) s += x.toString(16).padStart(2, "0").toUpperCase();
  return s.slice(0, 26);
}

/**
 * Synthesize a self-signed install blob for (username, server-name)
 * with an IRK derived from `seedBytes`. The trailer round-trips through
 * `parseTrailer` and verifies internally, but it has no relationship to
 * anything on `.com` — it's offline/local-test fodder. The e2e harness
 * uses `--blob-json` mode instead so the trailer matches the live ticket.
 */
export function synthesizeBlob(args: {
  username: string;
  serverName: string;
  seedBytes: Uint8Array;
  now: number;
}): { blob: InstallBlob; signer: Keypair } {
  if (args.seedBytes.length !== 32) {
    throw new Error(`seedBytes must be exactly 32 bytes (got ${args.seedBytes.length})`);
  }
  const irk = deriveIRK({ seed: args.seedBytes });
  const delegatedPriv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) delegatedPriv[i] = (args.seedBytes[i] ?? 0) ^ 0x55;
  const delegatedPub = ed.getPublicKey(delegatedPriv);
  const rckPriv = new Uint8Array(32);
  for (let i = 0; i < 32; i++) rckPriv[i] = (args.seedBytes[i] ?? 0) ^ 0xaa;
  const rckPub = ed.getPublicKey(rckPriv);
  const serverDomain = `${args.serverName}.${args.username}.flagship.services`;
  const serial = genSerial((n) => {
    const r = new Uint8Array(n);
    for (let i = 0; i < n; i++) r[i] = (args.seedBytes[(i + 7) % 32] ?? 0) ^ 0x33;
    return r;
  });
  const issuedAt = args.now;
  const expiresAt = args.now + 3_600_000;
  const code: AuthCode = {
    version: 1,
    serial,
    username: args.username,
    serverName: args.serverName,
    serverDomain,
    delegatedPubKey: delegatedPub,
    userPubKey: irk.publicKey,
    issuedAt,
    expiresAt,
  };
  const userSig = signAuthCode(code, irk);
  const blob: InstallBlob = {
    version: 1,
    serverDomain,
    username: args.username,
    serverName: args.serverName,
    phoneDelegatedPubKey: delegatedPub,
    registrationUrl: "https://flagship.services/api/server/register",
    authCode: code,
    authCodeUserSignature: userSig,
    issuedAt,
    expiresAt,
    installerGitRef: "main",
    rckPubKey: rckPub,
  };
  return { blob, signer: irk };
}

/**
 * Same byte layout as `buildTrailer` — used when the caller already has
 * a `.com`-issued signature for the blob (so we don't re-sign with a
 * key we don't possess).
 */
export function buildTrailerWithSignature(
  blob: InstallBlob,
  signature: Uint8Array,
): Uint8Array {
  if (signature.length !== SIG_LEN) {
    throw new Error(`signature must be ${SIG_LEN} bytes (got ${signature.length})`);
  }
  const enc = new TextEncoder();
  const json = enc.encode(JSON.stringify(installBlobToJson(blob)));
  const totalSize =
    HEADER_LEN + VERSION_LEN + JSON_LEN_FIELD + json.length + SIG_LEN + FOOTER_LEN + TOTAL_SIZE_FIELD;
  if (totalSize > MAX_TRAILER_BYTES) {
    throw new Error(`trailer too large: ${totalSize} > ${MAX_TRAILER_BYTES}`);
  }
  const out = new Uint8Array(totalSize);
  let off = 0;
  out.set(MAGIC_HEADER, off);
  off += HEADER_LEN;
  out[off] = FORMAT_VERSION;
  off += VERSION_LEN;
  new DataView(out.buffer).setUint32(off, json.length, true);
  off += JSON_LEN_FIELD;
  out.set(json, off);
  off += json.length;
  out.set(signature, off);
  off += SIG_LEN;
  out.set(MAGIC_FOOTER, off);
  off += FOOTER_LEN;
  new DataView(out.buffer).setUint32(off, totalSize, true);
  return out;
}

/** Acceptance helper used by --verify: parses the personalized ISO back. */
export function verifyPersonalized(
  bytes: Uint8Array,
  expectedUsername: string,
  expectedServerName: string,
): { ok: true } | { ok: false; reason: string } {
  const parsed = parseTrailer(bytes);
  if (!parsed) return { ok: false, reason: "parseTrailer returned null" };
  if (parsed.blob.username !== expectedUsername) {
    return {
      ok: false,
      reason: `username mismatch (${parsed.blob.username} vs ${expectedUsername})`,
    };
  }
  if (parsed.blob.serverName !== expectedServerName) {
    return {
      ok: false,
      reason: `serverName mismatch (${parsed.blob.serverName} vs ${expectedServerName})`,
    };
  }
  if (!parsed.signatureValid) return { ok: false, reason: "signature did not verify" };
  return { ok: true };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ─────────────────────────────── main ─────────────────────────────── */

const USAGE =
  `usage: personalize-iso\n` +
  `  --base-iso    <path>            base Alpine ISO\n` +
  `  --output      <path>            output personalized ISO\n` +
  `  --username    <name>            (standalone mode) RFC-1035 label\n` +
  `  --server-name <name>            (standalone mode) RFC-1035 label\n` +
  `  [--blob-json  <path>]           pre-built blob envelope JSON\n` +
  `  [--seed-hex   <64-hex>]         deterministic IRK seed\n` +
  `  [--verify]                      parse-back the output as a sanity check`;

export async function main(argv: string[]): Promise<number> {
  let a: ParsedArgs;
  try {
    a = parseArgs(argv);
  } catch (e) {
    process.stderr.write(
      `argument error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.stderr.write(USAGE + "\n");
    return 2;
  }
  if (a.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  if (!a.baseIso || !a.output) {
    process.stderr.write("--base-iso and --output are required\n" + USAGE + "\n");
    return 2;
  }

  let base: Uint8Array;
  try {
    base = new Uint8Array(await readFile(a.baseIso));
  } catch (e) {
    process.stderr.write(
      `failed to read base ISO ${a.baseIso}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 3;
  }

  let blob: InstallBlob;
  let trailerBytes: Uint8Array;

  if (a.blobJson) {
    let j: { blob?: unknown; blobSignature?: unknown; signature?: unknown };
    try {
      j = JSON.parse(await readFile(a.blobJson, "utf8"));
    } catch (e) {
      process.stderr.write(
        `failed to read --blob-json ${a.blobJson}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 3;
    }
    // Two accepted shapes: bare InstallBlob JSON OR `{ blob, blobSignature|signature }`.
    const blobJson = (j.blob ?? j) as Parameters<typeof installBlobFromJson>[0];
    const sigHex = (typeof j.blobSignature === "string" && j.blobSignature) ||
                   (typeof j.signature === "string" && j.signature);
    if (!sigHex) {
      process.stderr.write(
        "--blob-json: envelope must include `blobSignature` (or `signature`)\n",
      );
      return 2;
    }
    try {
      blob = installBlobFromJson(blobJson);
    } catch (e) {
      process.stderr.write(
        `--blob-json: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
    const sigBytes = hexToBytes(sigHex);
    try {
      trailerBytes = buildTrailerWithSignature(blob, sigBytes);
    } catch (e) {
      process.stderr.write(
        `${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  } else {
    try {
      validateLabel(a.username, "username");
      validateLabel(a.serverName, "server-name");
    } catch (e) {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      return 2;
    }
    const seedHex = a.seedHex ?? bytesToHex(randomBytes(32));
    let seedBytes: Uint8Array;
    try {
      seedBytes = hexToBytes(seedHex);
    } catch (e) {
      process.stderr.write(
        `--seed-hex: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
    if (seedBytes.length !== 32) {
      process.stderr.write(
        `--seed-hex must be exactly 32 bytes (got ${seedBytes.length})\n`,
      );
      return 2;
    }
    const synth = synthesizeBlob({
      username: a.username!,
      serverName: a.serverName!,
      seedBytes,
      now: Date.now(),
    });
    blob = synth.blob;
    const built = buildTrailer(synth.blob, synth.signer);
    trailerBytes = built.bytes;
  }

  const personalized = personalizeBytes(base, trailerBytes);
  await writeFile(a.output, personalized);

  if (a.verify) {
    const v = verifyPersonalized(personalized, blob.username, blob.serverName);
    if (!v.ok) {
      process.stderr.write(`verify failed: ${v.reason}\n`);
      return 4;
    }
  }

  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: a.output,
      bytes: personalized.length,
      sha256: sha256Hex(personalized),
      username: blob.username,
      serverName: blob.serverName,
      serverDomain: blob.serverDomain,
    }) + "\n",
  );
  return 0;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(
        `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
