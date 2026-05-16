#!/usr/bin/env node
/**
 * rotate-ca — guided, safe rotation of the Flagship operational CA key.
 *
 * SECURITY MODEL (why this is a CLI and not a web button):
 *   The operational CA private key (the `FLAGSHIP_CA_PRIV_HEX` Worker
 *   secret) signs UserPubKeyBinding / DemoDirective per request. It must
 *   be generated in a controlled environment and transmitted ONLY to
 *   Cloudflare. A browser must never generate or carry it. The cold
 *   maintainer key (YubiKey, via the maintainers web-ui PRF or the
 *   @maintainers/cli) only ever signs the SHORT-LIVED CaEndorsement that
 *   *authorizes* this hot key — it never touches the hot key itself.
 *
 *   There is deliberately NO "re-issue every user key" daemon: bindings
 *   and directives are minted per request with a ~7d TTL and re-fetched,
 *   so once the Worker holds the new key AND a live CaEndorsement covers
 *   it, the next fetch is already signed by the new CA. Nothing to batch.
 *
 *   SAFE ORDERING (enforced below): the new CaEndorsement must be LIVE
 *   (committed + verifiable) BEFORE the Worker secret is swapped. The
 *   old lease keeps serving until its own notAfter, so rotation has no
 *   validity gap. This tool refuses to swap until it has independently
 *   verified the new lease.
 *
 * Run `node scripts/rotate-ca.mjs help`.
 *
 * Pure helpers are exported for scripts/rotate-ca.test.ts; the file is
 * import-safe (no side effects unless run as main).
 */

import { generateKeyPairSync, createPublicKey, verify as nodeVerify } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

const SEP = "|";
const CA_ENDORSEMENT_TAG = "maintainers/ca-endorsement/v1";

// ---- pure helpers (unit-tested) -----------------------------------------

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const name = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
    } else {
      positionals.push(tok);
    }
  }
  return { command: positionals[0] ?? "rotate", flags, positionals };
}

function b64urlToBuf(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
export function b64urlToHex(s) {
  return b64urlToBuf(s).toString("hex");
}
export function hexToB64url(h) {
  return Buffer.from(h, "hex")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Generate an Ed25519 keypair as { seedHex, pubHex } (64-hex each). */
export function genEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubJwk = publicKey.export({ format: "jwk" });
  const privJwk = privateKey.export({ format: "jwk" });
  const seedHex = b64urlToHex(privJwk.d);
  const pubHex = b64urlToHex(pubJwk.x);
  if (!/^[0-9a-f]{64}$/.test(seedHex) || !/^[0-9a-f]{64}$/.test(pubHex)) {
    throw new Error("ed25519 keygen produced a non-32-byte component");
  }
  return { seedHex, pubHex };
}

function assertNoControl(name, v) {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) {
      throw new Error(`field "${name}" contains illegal canonical-bytes char`);
    }
  }
}

/**
 * Canonical bytes for a CaEndorsement — MUST byte-match
 * @maintainers/protocol canonicalCaEndorsement (spec §3.7):
 *   maintainers/ca-endorsement/v1
 *     |endorsementId|track|caPubkey|scope|notBefore|notAfter|issuedAt|signedBy
 */
export function caEndorsementCanonicalBytes(e) {
  const parts = [
    e.endorsementId,
    e.track,
    e.caPubkey,
    e.scope,
    e.notBefore,
    e.notAfter,
    e.issuedAt,
    e.signedBy,
  ];
  for (const [i, p] of parts.entries()) {
    if (typeof p !== "string") throw new Error(`canonical part ${i} not a string`);
    assertNoControl(`part${i}`, p);
  }
  return Buffer.from([CA_ENDORSEMENT_TAG, ...parts].join(SEP), "utf8");
}

/** Ed25519 verify a hex signature over `msg` (Buffer) by a 64-hex pubkey. */
export function verifyEd25519(pubHex, msg, sigHex) {
  if (!/^[0-9a-f]{64}$/.test(pubHex)) return false;
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: hexToB64url(pubHex) },
      format: "jwk",
    });
    return nodeVerify(null, msg, key, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

/**
 * Operator pre-flight authority check. The AUTHORITATIVE verification is
 * @maintainers/protocol verifyCaEndorsements, run consumer-side (daemon
 * + clients) against the full ca-track mandate chain. This is only a
 * "did my lease actually land and is it self-consistent" gate before the
 * irreversible Worker-secret swap. It checks signature + window + that
 * the signer is a holder/successor named anywhere in the ca-track
 * mandates (a deliberately looser, fs-only check).
 */
export function readAuthorizedCaSigners(maintainersDir) {
  const dir = path.join(maintainersDir, "tracks", "ca", "mandates");
  const signers = new Set();
  if (!fs.existsSync(dir)) return signers;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (m && m.kind === "Mandate" && m.track === "ca") {
      if (typeof m.holder === "string") signers.add(m.holder);
      if (Array.isArray(m.successors)) for (const s of m.successors) signers.add(s);
    }
  }
  return signers;
}

export function readCaEndorsements(maintainersDir) {
  const dir = path.join(maintainersDir, "ca-endorsements");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (e && e.kind === "CaEndorsement") out.push(e);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** A CaEndorsement is "self-consistent live" at nowMs iff window ok, all
 *  signatures verify over canonical bytes, signedBy is in signatures, and
 *  signedBy is an authorized ca-track signer. */
export function isLeaseLive(e, authorizedSigners, nowMs) {
  if (!e || e.kind !== "CaEndorsement") return false;
  const nb = Date.parse(e.notBefore);
  const na = Date.parse(e.notAfter);
  if (!isFinite(nb) || !isFinite(na) || na <= nb) return false;
  if (nowMs < nb || nowMs >= na) return false;
  if (!Array.isArray(e.signatures) || e.signatures.length === 0) return false;
  let bytes;
  try {
    bytes = caEndorsementCanonicalBytes(e);
  } catch {
    return false;
  }
  const sigPubs = new Set();
  for (const s of e.signatures) {
    if (!s || typeof s.pubkey !== "string" || typeof s.sig !== "string") return false;
    if (!verifyEd25519(s.pubkey, bytes, s.sig)) return false;
    sigPubs.add(s.pubkey);
  }
  if (!sigPubs.has(e.signedBy)) return false;
  if (!authorizedSigners.has(e.signedBy)) return false;
  return true;
}

/** The lease that should be served: among live leases, the one whose
 *  notAfter runs farthest into the future. null if none. */
export function selectFarthestFutureValid(endorsements, authorizedSigners, nowMs) {
  let best = null;
  for (const e of endorsements) {
    if (!isLeaseLive(e, authorizedSigners, nowMs)) continue;
    if (best === null || Date.parse(e.notAfter) > Date.parse(best.notAfter)) best = e;
  }
  return best;
}

/** Is there a live lease for exactly `pubHex`? Returns it (farthest-future) or null. */
export function selectLiveLeaseForPubkey(endorsements, authorizedSigners, nowMs, pubHex) {
  const forKey = endorsements.filter((e) => e && e.caPubkey === pubHex);
  return selectFarthestFutureValid(forKey, authorizedSigners, nowMs);
}

// ---- interactive shell (only runs as main) ------------------------------

const C = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

function tryClipboard(text) {
  if (process.platform !== "darwin") return false;
  try {
    const p = spawnSync("pbcopy", { input: text });
    return p.status === 0;
  } catch {
    return false;
  }
}

function printHelp(p) {
  p(`${C.b("rotate-ca")} — safe Flagship operational-CA rotation

  ${C.b("node scripts/rotate-ca.mjs rotate")}   generate a key, guide the
                                       maintainer lease, then swap the
                                       Cloudflare Worker secret (in order)
  ${C.b("node scripts/rotate-ca.mjs status")}   show the live/served lease
  ${C.b("node scripts/rotate-ca.mjs help")}

Flags: --duration-days N (default 7)  --scope S  --com-url URL
       --maintainers-dir D (default .maintainers)  --com-dir D (default apps/com)
       --verify-user NAME (post-swap live pubkey-cert check)
       --yes (skip confirms)  --dry-run (print, don't swap)  --non-interactive

The maintainer lease step is intentionally NOT automated here: it needs
your YubiKey. Do it in the web-ui (flagshipserver.com/maintainers →
"Replace CA") or headless via the @maintainers/cli — this tool prints
the exact fallback command. It will not swap the Worker key until it has
independently verified the new lease is live.`);
}

function cmdStatus(opts, p) {
  const signers = readAuthorizedCaSigners(opts.maintainersDir);
  const es = readCaEndorsements(opts.maintainersDir);
  const now = Date.now();
  const served = selectFarthestFutureValid(es, signers, now);
  p(C.b("CA leases (" + opts.maintainersDir + "/ca-endorsements):"));
  if (es.length === 0) { p(C.y("  (none)")); return 0; }
  const sorted = [...es].sort((a, b) => Date.parse(b.notAfter || 0) - Date.parse(a.notAfter || 0));
  for (const e of sorted) {
    const live = isLeaseLive(e, signers, now);
    const days = ((Date.parse(e.notAfter) - now) / 86400000).toFixed(1);
    const tag = e === served ? C.g(" ← SERVED (farthest-future valid)") : "";
    p(`  ${live ? C.g("●") : C.dim("○")} ${e.caPubkey?.slice(0, 16)}…  exp ${e.notAfter} (${days}d)  ${live ? "" : C.dim("not-live")}${tag}`);
  }
  if (!served) p(C.r("\n  No live lease — clients will reject CA-signed artifacts. Issue one."));
  return 0;
}

async function cmdRotate(opts, p) {
  p(C.b("\n▶ Step 1/4 — generate a new operational CA keypair (local, never transmitted except to Cloudflare)\n"));
  const { seedHex, pubHex } = genEd25519();
  const copied = tryClipboard(pubHex);
  p("  New CA public key" + (copied ? C.dim(" (copied to clipboard)") : "") + ":\n");
  p("    " + C.b(C.g(pubHex)) + "\n");
  p(C.dim("  (the private seed is held only in this process's memory until the swap; never printed, never written to disk)\n"));

  const dur = Number(opts.flags["duration-days"] ?? 7);
  const scope = String(opts.flags.scope ?? "flagship/directory-attestation");
  p(C.b("▶ Step 2/4 — authorize it with your cold maintainer key (YubiKey)\n"));
  p(`  Go to ${C.b(opts.comUrl + "/maintainers")} → "Replace CA":`);
  p(`    • paste the public key above`);
  p(`    • scope: ${C.b(scope)}   • duration: ${C.b(dur + "d")}   • tap your YubiKey, commit\n`);
  p(C.dim("  Headless / air-gapped / successor fallback (no browser):"));
  p(C.dim(`    cd maintainers && node packages/cli/dist/index.js ca-endorsement \\`));
  p(C.dim(`      --ca-pubkey ${pubHex} --scope ${scope} --duration ${dur}d \\`));
  p(C.dim(`      --track ca --signing-key <your-maintainer-key-source> --path ../.maintainers`));
  p(C.dim(`  then commit .maintainers/ca-endorsements/ and \`git pull\` here.\n`));

  if (opts.flags["non-interactive"]) {
    p(C.y("--non-interactive: stopping before the verify/swap. Re-run `status` once the lease is committed."));
    return 0;
  }

  p(C.b("▶ Step 3/4 — verify the new lease is LIVE before touching the Worker key\n"));
  const signers = readAuthorizedCaSigners(opts.maintainersDir);
  const timeoutMs = Number(opts.flags["poll-timeout"] ?? 600000);
  const intervalMs = Number(opts.flags["poll-interval"] ?? 5000);
  const start = Date.now();
  let live = null;
  for (;;) {
    const es = readCaEndorsements(opts.maintainersDir);
    live = selectLiveLeaseForPubkey(es, signers, Date.now(), pubHex);
    if (live) break;
    if (Date.now() - start > timeoutMs) {
      p(C.r(`  Timed out waiting for a live lease for this key in ${opts.maintainersDir}/ca-endorsements.`));
      p(C.r("  Nothing was changed. Commit the lease + `git pull`, then re-run `rotate`."));
      return 1;
    }
    await ask(C.y(`  No live lease for this key yet. Commit it + \`git pull\`, then press Enter to re-check (or Ctrl-C to abort) `));
  }
  p(C.g(`  ✓ Verified live lease for this key — expires ${live.notAfter}, signed by ${live.signedBy.slice(0, 16)}…\n`));

  p(C.b("▶ Step 4/4 — swap the Cloudflare Worker secret FLAGSHIP_CA_PRIV_HEX\n"));
  p(C.dim("  The old lease keeps serving until its notAfter, so there is no gap. After the swap"));
  p(C.dim("  new pubkey-certs/demo-directives sign under the new CA on the very next fetch —"));
  p(C.dim("  no re-issuance daemon, ~7d for caches to fully roll.\n"));
  if (opts.flags["dry-run"]) {
    p(C.y(`  --dry-run: would run (seed via stdin, never argv):`));
    p(C.y(`    cd ${opts.comDir} && printf %s '<SEED>' | npx wrangler secret put FLAGSHIP_CA_PRIV_HEX`));
    return 0;
  }
  if (!opts.flags.yes) {
    const a = await ask(C.b(`  Swap the production Worker secret now? This makes .com sign with the new CA. [y/N] `));
    if (a.toLowerCase() !== "y" && a.toLowerCase() !== "yes") {
      p(C.y("  Aborted before swap. Nothing changed. The verified lease remains valid."));
      return 0;
    }
  }
  const ok = await putWranglerSecret(opts.comDir, "FLAGSHIP_CA_PRIV_HEX", seedHex);
  if (!ok) { p(C.r("  wrangler secret put FAILED — Worker key unchanged. Re-run after fixing wrangler auth.")); return 1; }
  p(C.g("  ✓ Worker secret swapped.\n"));

  const vu = opts.flags["verify-user"];
  if (typeof vu === "string" && vu) await postSwapVerify(opts.comUrl, vu, pubHex, p);

  p(C.g(C.b("\n✓ Rotation complete.")) + " No daemon needed: artifacts re-sign under the new CA on next fetch.");
  p(C.dim("  Keep issuing leases before each notAfter (web-ui or @maintainers/cli) — that is the only recurring chore."));
  return 0;
}

function putWranglerSecret(comDir, name, value) {
  return new Promise((res) => {
    const child = spawn("npx", ["wrangler", "secret", "put", name], {
      cwd: comDir,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.stdin.write(value);
    child.stdin.end();
    child.on("close", (code) => res(code === 0));
    child.on("error", () => res(false));
  });
}

async function postSwapVerify(comUrl, user, pubHex, p) {
  try {
    const r = await fetch(`${comUrl}/api/users/${encodeURIComponent(user)}/pubkey-cert`);
    if (!r.ok) { p(C.y(`  post-swap check: /pubkey-cert returned ${r.status} (skip)`)); return; }
    const j = await r.json();
    const b = j.binding;
    const msg = Buffer.from(
      [
        "flagship-ca-binding/v1",
        b.version,
        b.username,
        b.pubKey,
        b.issuedAt,
        b.expiresAt,
        b.issuer,
      ].join("|"),
      "utf8",
    );
    const okSig = verifyEd25519(pubHex, msg, j.signature);
    p(okSig
      ? C.g(`  ✓ post-swap: live pubkey-cert for "${user}" verifies under the NEW CA.`)
      : C.r(`  ✗ post-swap: pubkey-cert did NOT verify under the new CA (caches may lag, or check the lease).`));
  } catch (e) {
    p(C.y(`  post-swap check skipped: ${e?.message ?? e}`));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const opts = {
    flags: args.flags,
    comUrl: String(args.flags["com-url"] ?? "https://flagshipserver.com").replace(/\/$/, ""),
    maintainersDir: String(args.flags["maintainers-dir"] ?? ".maintainers"),
    comDir: String(args.flags["com-dir"] ?? "apps/com"),
  };
  const p = (s) => console.log(s);
  if (args.command === "help" || args.flags.help) { printHelp(p); return 0; }
  if (args.command === "status") return cmdStatus(opts, p);
  if (args.command === "rotate") return cmdRotate(opts, p);
  console.error(`unknown command: ${args.command}`);
  printHelp((s) => console.error(s));
  return 2;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().then((code) => process.exit(code ?? 0)).catch((e) => {
    console.error(e?.stack ?? String(e));
    process.exit(1);
  });
}
