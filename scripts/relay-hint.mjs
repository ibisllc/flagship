#!/usr/bin/env node
// relay-hint — mint the maintainer-signed list of the relay's well-known
// addresses (docs/relay-hints.md). The apps use it only when DNS fails; a box is
// still authenticated by TLS to its own name, so a wrong list can at worst make
// the fallback fail. Same safety as scripts/security-notice.mjs:
//
//   * PREVIEW by default: builds the hint, checks every rule the apps enforce,
//     prints the exact canonical bytes and writes nothing. Signing needs --sign.
//   * --sign signs with the ca-track YubiKey (`yubikey-piv:slot=9c`) after a typed
//     confirmation and writes .maintainers/relay-hints/current.json (+ history/<seq>.json).
//
// Usage:
//   node scripts/relay-hint.mjs --address 149.248.216.86 --address 2a09:8280:1::110:d2b6:0 [--until +90d] --sign
//
//   --address <ip>        repeatable, 1 to 8, public IPv4 or IPv6 literals (the relay's, from `flyctl ips list -a flagship-services`)
//   --from <time>         first moment it applies (default: now)
//   --until <time>        last moment (exclusive); at most 180 days after --from (default: from + 90 days)
//   --seq <N>             default: one above the highest ever signed
//   --signing-key <src>   default yubikey-piv:slot=9c (for a drill: file:/path/to/priv-hex)
//   --path <dir>          maintainers folder (default .maintainers)
//   --sign                actually sign and write; omit for a preview
//
// <time> is ISO 8601 with a Z or offset, a date (UTC midnight), "now" or +30m / +6h / +7d.
// Exit codes: 0 ok, 1 error, 2 usage.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RELAY_HINT_MAX_WINDOW_MS,
  RelayHintError,
  assembleRelayHint,
  canonicalRelayHint,
  verifyRelayHint,
} from "@flagship/protocol";
import { authorityKeysAt, loadMaintainersCli } from "./security-notice.mjs";

const DAY = 24 * 3600_000;

export class UsageError extends Error {}

const VALUE_FLAGS = new Set(["address", "from", "until", "seq", "signing-key", "path"]);
const BOOL_FLAGS = new Set(["sign", "help"]);

export function parseArgs(argv) {
  const out = { address: [], sign: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (BOOL_FLAGS.has(key)) {
      out[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`--${key} needs a value`);
      if (key === "address") out.address.push(v);
      else out[key.replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    } else {
      throw new UsageError(`unknown option --${key}`);
    }
  }
  return out;
}

export function parseTime(text, now, flag) {
  if (text === "now") return now;
  const rel = /^\+(\d+)([mhd])$/.exec(text);
  if (rel) return now + Number(rel[1]) * { m: 60_000, h: 3600_000, d: DAY }[rel[2]];
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(`${text}T00:00:00Z`) : Date.parse(text);
  if (!Number.isFinite(ms)) throw new UsageError(`${flag}: cannot read the time "${text}"`);
  return ms;
}

function relayHintsDir(root) {
  return path.join(root, "relay-hints");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The highest seq ever signed, read from current.json and history/. */
export function highestSignedSeq(root) {
  let max = 0;
  const cur = readJson(path.join(relayHintsDir(root), "current.json"));
  if (cur && Number.isSafeInteger(cur.seq)) max = cur.seq;
  const dir = path.join(relayHintsDir(root), "history");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return max;
}

export function buildBody(args, { now, root }) {
  if (args.address.length === 0) throw new UsageError("give at least one --address");
  const validFrom = args.from ? parseTime(args.from, now, "--from") : now;
  const validUntil = args.until ? parseTime(args.until, now, "--until") : validFrom + 90 * DAY;
  if (validUntil - validFrom > RELAY_HINT_MAX_WINDOW_MS) throw new UsageError("--until is more than 180 days after --from");
  const seq = args.seq ? Number(args.seq) : highestSignedSeq(root) + 1;
  if (!Number.isSafeInteger(seq) || seq < 1) throw new UsageError("--seq must be a positive integer");
  const highest = highestSignedSeq(root);
  if (seq <= highest) throw new UsageError(`seq ${seq} is not above ${highest}, the highest ever signed: apps ignore it as a rollback`);
  return { seq, validFrom, validUntil, addresses: args.address };
}

export function canonicalOrExplain(body, signerPub) {
  try {
    return canonicalRelayHint(body, signerPub);
  } catch (e) {
    if (e instanceof RelayHintError) throw new UsageError(`this hint breaks a rule the apps enforce (${e.code}); it cannot be signed`);
    throw e;
  }
}

/** Sign `body` with `signer` ({ pubKey, sign(bytes) -> hex }), check it the way an app will, and write it. */
export async function signAndWrite({ body, signer, root, authorityKeys }) {
  const bytes = canonicalOrExplain(body, signer.pubKey);
  const hint = assembleRelayHint(body, signer.pubKey, await signer.sign(bytes));
  const v = verifyRelayHint(hint, authorityKeys);
  if (!v.ok) throw new Error(`the signed hint does not verify as the ca-track authority's (${v.reason}); nothing was written`);
  const dir = relayHintsDir(root);
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });
  const text = JSON.stringify(hint, null, 2) + "\n";
  fs.writeFileSync(path.join(dir, "history", `${String(hint.seq).padStart(4, "0")}.json`), text);
  fs.writeFileSync(path.join(dir, "current.json"), text);
  return hint;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  if (args.help) {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
    process.stdout.write(src.slice(1, src.findIndex((l, i) => i > 2 && !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return 0;
  }
  const out = (s) => process.stdout.write(s + "\n");
  const root = args.path ?? ".maintainers";
  const now = Date.now();
  const signingKey = args.signingKey ?? "yubikey-piv:slot=9c";

  let body;
  try {
    body = buildBody(args, { now, root });
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

  const lib = await loadMaintainersCli();
  let signerPub = null;
  let signerNote = null;
  if (lib) {
    try {
      signerPub = (await lib.keysource.loadSignerBoundPubKey(signingKey)).toLowerCase();
    } catch (e) {
      signerNote = e instanceof Error ? e.message : String(e);
    }
  } else {
    signerNote = "maintainers CLI not found (set FLAGSHIP_MAINTAINERS_DIR to its clone, built)";
  }
  const maintainers = await import("@ibisllc/maintainers");
  const authorityKeys = await authorityKeysAt(root, now, maintainers);

  let canonical;
  try {
    canonical = new TextDecoder().decode(canonicalOrExplain(body, signerPub ?? "0".repeat(64)));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }
  out(`relay hint seq ${body.seq}`);
  out(`  valid:            ${new Date(body.validFrom).toISOString()} to ${new Date(body.validUntil).toISOString()}`);
  out(`  addresses:        ${body.addresses.join(", ")}`);
  out(`  signing key:      ${signingKey}`);
  out(`  signer pubkey:    ${signerPub ?? `(could not read: ${signerNote})`}`);
  out(`  ca authority now: ${authorityKeys.length ? authorityKeys.join(", ") : "(none: the apps would reject every hint)"}`);
  if (signerPub && authorityKeys.length) out(`  signer matches:   ${authorityKeys.includes(signerPub) ? "yes" : "NO: apps would reject this key"}`);
  out(`\n  canonical bytes:\n    ${canonical}\n`);
  if (!args.sign) {
    out("DRY RUN: nothing signed, nothing written. Re-run with --sign to mint it.");
    return 0;
  }
  if (!lib || !signerPub || !authorityKeys.includes(signerPub)) {
    process.stderr.write(`error: ${signerNote ?? "the signing key is not the current ca-track authority; the apps would reject the hint"}. Nothing signed.\n`);
    return 1;
  }
  const ok = await lib.ceremony.ttyConfirm({ ceremony: "relay-hint", phrase: "RELAY-HINT" }).catch(() => false);
  if (!ok) {
    process.stderr.write("aborted at the confirmation prompt: nothing was signed or written.\n");
    return 1;
  }
  out("Invoking the maintainers signer: approve the signature on your token when prompted...\n");
  const signer = await lib.keysource.loadSigner(signingKey, {
    pivTransport: lib.cli.defaultEnv.pivTransport,
    pivPin: lib.cli.defaultEnv.pivPin,
  });
  const hint = await signAndWrite({ body, signer, root, authorityKeys });
  try {
    execFileSync("git", ["add", path.join(root, "relay-hints")], { stdio: "inherit" });
  } catch {
    /* the operator can add it by hand */
  }
  out(`Done. seq ${hint.seq} written to ${path.join(root, "relay-hints", "current.json")}.`);
  out("Review and commit it, land it on main, then redeploy .com (`npm run deploy` in apps/com): the Worker bundles the file.");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
      process.exit(1);
    },
  );
}
