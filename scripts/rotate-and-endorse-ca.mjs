#!/usr/bin/env node
/**
 * rotate-and-endorse-ca — one-process Flagship hot CA rotation.
 *
 * Same end state as `rotate-ca.mjs rotate`, but driven from a single
 * terminal: the maintainers CLI is spawned in-process with stdio
 * inherited so the YubiKey insert / typed `CA-LEASE` / PIN / tap prompts
 * land here, not in a second window. No `git pull` round-trip — this
 * process writes the endorsement file, regenerates `bundle.json`, then
 * (and only then) `wrangler secret put`s the new private seed.
 *
 * Steps:
 *   1. Pre-flight (maintainers CLI reachable, ca-track mandates present,
 *      apps/com/wrangler.toml present, holder pubkey resolvable, no
 *      already-live lease for some other reason of concern).
 *   2. genEd25519 in memory — pubkey printed, seed never written/echoed.
 *   3. Spawn `maintainers ca-endorsement --ca-pubkey <pub> …` with
 *      stdio: "inherit". YubiKey UX is the CLI's own (typed CA-LEASE +
 *      PIN + tap). On non-zero exit, abort — Cloudflare untouched.
 *   4. Detect the new `.maintainers/ca-endorsements/<ts>-<id>.json` the
 *      CLI just wrote; locally verify it (rotate-ca's `isLeaseLive` →
 *      `selectLiveLeaseForPubkey` against the ca-track signers).
 *   5. Regenerate `.maintainers/ca-endorsements/bundle.json` (the
 *      Worker reads this; the daemon reads the per-file `*.json`s).
 *   6. Pipe the seed via stdin to `npx wrangler secret put
 *      FLAGSHIP_CA_PRIV_HEX` in `apps/com`. Confirm with the user
 *      first (the only step that touches Cloudflare).
 *   7. Optional post-swap check: GET `/api/users/<--verify-user>/
 *      pubkey-cert` and verify under the new pubkey.
 *
 * Ordering is fail-safe: if step 3 or 4 fails, nothing in Cloudflare
 * changes. If step 5 fails, the per-file `*.json` is still on disk
 * (the daemon can read it) — re-run with `--skip-keygen` to retry just
 * the bundle/swap (or rerun the whole thing; latest rotation wins).
 * If step 6 fails after a successful endorsement, the in-memory seed
 * is lost; re-running mints a new key + new endorsement (the old
 * endorsement file is harmless in OBSERVE mode but should be removed
 * before commit to keep the on-disk state clean).
 *
 * Usage:
 *   node scripts/rotate-and-endorse-ca.mjs [flags]
 *
 * Flags (all optional):
 *   --days N                  convenience for --duration Nd (positive
 *                             integer). Exclusive with --duration.
 *   --duration DUR            default: 7d  (passed to the CLI verbatim)
 *   --maintainers-cli PATH    default: ./maintainers/packages/cli/bin/maintainers
 *   --maintainers-dir DIR     default: .maintainers
 *   --com-dir DIR             default: apps/com
 *   --com-url URL             default: https://flagshipserver.com  (post-swap probe)
 *   --scope SCOPE             default: flagship/directory-attestation
 *   --signing-key KEY         default: yubikey-piv:slot=9c
 *   --track TRACK             default: ca
 *   --verify-user NAME        OPTIONAL post-swap sanity check: GET
 *                             https://<--com-url>/api/users/NAME/pubkey-cert
 *                             and verify the signature parses under the
 *                             NEW CA pubkey. NAME must already be a
 *                             registered user on .com. Skip this flag if
 *                             you don't have one yet — the rotation
 *                             itself doesn't need it; this is purely an
 *                             outside-in reconfirmation.
 *   --verbose / -v            print full preflight detail + the full
 *                             wrangler secret list. Default is a single
 *                             verdict line for each. The maintainers
 *                             CLI's own canonical-bytes review block is
 *                             unaffected (that's the security gate, not
 *                             verbosity).
 *   --dry-run                 invoke the CLI with --dry-run (no signature,
 *                             no file write) and SKIP the wrangler PUT.
 *                             The wrangler-auth probe still runs — the
 *                             whole point of dry-run is to surface every
 *                             failure path before the YubiKey is engaged.
 *   --yes                     skip the pre-swap confirmation
 *
 * Pure helpers are exported for the test file. The file is import-safe
 * (no side effects unless run as main).
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  genEd25519,
  readAuthorizedCaSigners,
  readCaEndorsements,
  selectLiveLeaseForPubkey,
  verifyEd25519,
} from "./rotate-ca.mjs";

// ---- pure helpers (unit-tested) ----------------------------------------

/**
 * Snapshot the set of filenames currently in `<maintainersDir>/ca-endorsements/`.
 * After the CLI exits, the file it just wrote is exactly the new entry
 * minus this snapshot (filtering out `bundle.json`).
 */
export function snapshotEndorsementDir(maintainersDir) {
  const dir = path.join(maintainersDir, "ca-endorsements");
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "bundle.json"),
  );
}

/**
 * Given a before-snapshot and the current dir state, return the
 * filename of the newly-written endorsement (or null if zero/many
 * were added — both are anomalies the caller treats as failures).
 */
export function detectNewEndorsementFile(maintainersDir, before) {
  const dir = path.join(maintainersDir, "ca-endorsements");
  if (!fs.existsSync(dir)) return null;
  const now = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "bundle.json");
  const added = now.filter((f) => !before.has(f));
  return added.length === 1 ? added[0] : null;
}

/**
 * Read every per-file CaEndorsement from `<maintainersDir>/ca-endorsements/`
 * in filename-sorted order, returning the canonical bundle.json content
 * (without trailing newline). Pure: no I/O writes.
 */
export function buildBundleContent(maintainersDir) {
  const dir = path.join(maintainersDir, "ca-endorsements");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "bundle.json")
    .sort();
  const a = files
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.kind === "CaEndorsement");
  return JSON.stringify(a, null, 2);
}

/**
 * Build the argv passed to the maintainers CLI for `ca-endorsement`.
 * Kept pure so the test can assert the exact wire shape without
 * spawning a child.
 */
export function buildCliArgs({
  pubHex,
  scope,
  duration,
  track,
  signingKey,
  maintainersDir,
  dryRun,
}) {
  const args = [
    "ca-endorsement",
    "--ca-pubkey",
    pubHex,
    "--scope",
    scope,
    "--duration",
    duration,
    "--track",
    track,
    "--signing-key",
    signingKey,
    "--path",
    maintainersDir,
  ];
  if (dryRun) args.push("--dry-run");
  return args;
}

/**
 * Resolve `--days N` (positive integer) into a CLI `Nd` duration string,
 * or throw a user-readable error. Returns null when `--days` is absent.
 */
export function daysFlagToDuration(daysFlag) {
  if (daysFlag === undefined || daysFlag === null || daysFlag === "") return null;
  const s = String(daysFlag);
  if (!/^[1-9][0-9]*$/.test(s)) {
    throw new Error(`--days must be a positive integer (got: ${JSON.stringify(daysFlag)})`);
  }
  return `${s}d`;
}

/**
 * Resolve defaults relative to the flagship repo root. Pure modulo `fs`
 * existence checks — the test stubs the fs root via the input dir.
 */
export function resolveOpts(flags, repoRoot) {
  const daysDur = daysFlagToDuration(flags.days);
  if (daysDur && flags.duration) {
    throw new Error("--days and --duration are mutually exclusive; pick one");
  }
  return {
    maintainersCli: String(
      flags["maintainers-cli"] ??
        path.join(repoRoot, "maintainers/packages/cli/bin/maintainers"),
    ),
    maintainersDir: String(
      flags["maintainers-dir"] ?? path.join(repoRoot, ".maintainers"),
    ),
    comDir: String(flags["com-dir"] ?? path.join(repoRoot, "apps/com")),
    comUrl: String(flags["com-url"] ?? "https://flagshipserver.com"),
    duration: String(daysDur ?? flags.duration ?? "7d"),
    scope: String(flags.scope ?? "flagship/directory-attestation"),
    signingKey: String(flags["signing-key"] ?? "yubikey-piv:slot=9c"),
    track: String(flags.track ?? "ca"),
    verifyUser: flags["verify-user"] ? String(flags["verify-user"]) : null,
    verbose: Boolean(flags.verbose || flags.v),
    dryRun: Boolean(flags["dry-run"]),
    yes: Boolean(flags.yes),
  };
}

/**
 * Pre-flight failure messages — pure so the test can pin them. Returns
 * an array of strings (empty if everything is in order).
 */
export function preflightErrors(opts) {
  const errors = [];
  if (!fs.existsSync(opts.maintainersCli)) {
    errors.push(
      `maintainers CLI not found at ${opts.maintainersCli} ` +
        `(override with --maintainers-cli)`,
    );
  }
  const mandatesDir = path.join(opts.maintainersDir, "tracks", opts.track, "mandates");
  if (!fs.existsSync(mandatesDir)) {
    errors.push(
      `no '${opts.track}'-track mandates in ${mandatesDir} — genesis ceremony ` +
        `(Operation 0) has not happened, or --maintainers-dir is wrong`,
    );
  }
  if (!fs.existsSync(path.join(opts.comDir, "wrangler.toml"))) {
    errors.push(
      `apps/com/wrangler.toml not found at ${opts.comDir} ` +
        `(override with --com-dir)`,
    );
  }
  return errors;
}

// ---- interactive shell (only runs as main) -----------------------------

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

function spawnCli(maintainersCli, args) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [maintainersCli, ...args], {
      stdio: "inherit",
    });
    child.on("close", (code) => res(code ?? 1));
    child.on("error", () => res(1));
  });
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

/**
 * Non-mutating wrangler probe: `wrangler secret list` in `apps/com`.
 * Proves three things at once: (1) wrangler binary is reachable via
 * `npx`, (2) the user is authenticated to Cloudflare, (3) the
 * wrangler.toml in `apps/com` resolves to a Worker this account has
 * access to. Returns the captured stdout so we can show whether
 * FLAGSHIP_CA_PRIV_HEX is currently set (informational).
 */
function wranglerSecretList(comDir) {
  return new Promise((res) => {
    const child = spawn("npx", ["wrangler", "secret", "list"], {
      cwd: comDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => res({ ok: code === 0, code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => res({ ok: false, code: 1, stdout, stderr: stderr + (e?.message ?? String(e)) }));
  });
}

async function postSwapVerify(comUrl, user, pubHex, p) {
  try {
    const r = await fetch(`${comUrl}/api/users/${encodeURIComponent(user)}/pubkey-cert`);
    if (!r.ok) {
      p(C.y(`  post-swap check: /pubkey-cert returned ${r.status} (skip)`));
      return;
    }
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

function printHelp(p) {
  p(`${C.b("rotate-and-endorse-ca")} — one-process Flagship hot CA rotation

  ${C.b("node scripts/rotate-and-endorse-ca.mjs")}            run the ceremony
  ${C.b("node scripts/rotate-and-endorse-ca.mjs --dry-run")}  CLI dry-run, no Cloudflare touch
  ${C.b("node scripts/rotate-and-endorse-ca.mjs help")}

Flags:
  --days N                    lease length in days (positive integer);
                              convenience for --duration Nd. Default 7.
  --duration DUR              long form (e.g. 14d, 1h). Exclusive
                              with --days.
  --maintainers-cli PATH      default ./maintainers/packages/cli/bin/maintainers
  --maintainers-dir DIR       default .maintainers
  --com-dir DIR               default apps/com
  --com-url URL               default https://flagshipserver.com
  --scope SCOPE               default flagship/directory-attestation
  --signing-key KEY           default yubikey-piv:slot=9c
  --track TRACK               default ca
  --verify-user NAME          OPTIONAL post-swap probe: any user
                              already registered on .com. Skip the flag
                              entirely if you don't have one yet.
  --verbose, -v               print full preflight detail + the full
                              wrangler secret list. Default is one
                              verdict line per check.
  --dry-run                   CLI --dry-run + skip wrangler PUT; the
                              wrangler-AUTH probe still runs.
  --yes                       skip pre-swap confirmation

The maintainer YubiKey signs the CaEndorsement in-process (stdio is
inherited from this script — typed CA-LEASE + PIN + tap appear here).
If anything fails before the wrangler PUT step, Cloudflare is untouched.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const p = (s = "") => process.stdout.write(s + "\n");

  if (args.command === "help" || args.flags.help) {
    printHelp(p);
    return 0;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let opts;
  try {
    opts = resolveOpts(args.flags, repoRoot);
  } catch (e) {
    p(C.r("✗ " + (e?.message ?? String(e))));
    return 1;
  }

  // ---- Step 1: preflight
  p(C.b("\n▶ Step 1 — preflight"));
  const errors = preflightErrors(opts);
  if (errors.length > 0) {
    for (const e of errors) p(C.r("  ✗ " + e));
    return 1;
  }
  const signers = readAuthorizedCaSigners(opts.maintainersDir);
  if (signers.size === 0) {
    p(C.r(`  ✗ no authorized ca-track signers resolvable from ${opts.maintainersDir}/tracks/${opts.track}/mandates`));
    return 1;
  }
  if (opts.verbose) {
    p(C.dim(`  maintainers CLI: ${opts.maintainersCli}`));
    p(C.dim(`  .maintainers:    ${opts.maintainersDir}`));
    p(C.dim(`  apps/com:        ${opts.comDir}`));
    p(C.dim(`  ca-track holder candidates (one must be on your YubiKey):`));
    for (const s of signers) p(C.dim(`    ${s.slice(0, 16)}…${s.slice(-8)}`));
  }
  p(C.g(`  ✓ preflight OK (${signers.size} ca-track holder${signers.size === 1 ? "" : "s"} authorized; lease ${opts.duration})\n`));

  // ---- Step 1b: wrangler auth probe (runs in BOTH dry-run and real)
  p(C.b("▶ Step 1b — wrangler probe (auth + Worker access)"));
  const probe = await wranglerSecretList(opts.comDir);
  if (!probe.ok) {
    p(C.r("  ✗ wrangler secret list FAILED — fix this before the real run."));
    if (probe.stderr.trim()) p(C.r("    stderr:\n" + probe.stderr.trim().split("\n").map((l) => "      " + l).join("\n")));
    if (probe.stdout.trim()) p(C.dim("    stdout:\n" + probe.stdout.trim().split("\n").map((l) => "      " + l).join("\n")));
    p(C.y("  Common causes:"));
    p(C.y("    • not logged in:                npx wrangler login"));
    p(C.y("    • wrong account in toml:        check `account_id` in apps/com/wrangler.toml"));
    p(C.y("    • multi-account auth:           CLOUDFLARE_ACCOUNT_ID env var or `wrangler login` again"));
    return 1;
  }
  const alreadySet = /FLAGSHIP_CA_PRIV_HEX/.test(probe.stdout);
  let secretCount = 0;
  try { secretCount = JSON.parse(probe.stdout).length; } catch {}
  if (opts.verbose) {
    p(C.dim("  wrangler secret list output:"));
    p(probe.stdout.trim().split("\n").map((l) => C.dim("    " + l)).join("\n"));
  }
  p(alreadySet
    ? C.g(`  ✓ wrangler authed; ${secretCount} secrets configured; FLAGSHIP_CA_PRIV_HEX currently set (this run will OVERWRITE it)\n`)
    : C.y(`  ✓ wrangler authed; ${secretCount} secrets configured; FLAGSHIP_CA_PRIV_HEX NOT yet set (this run will be the FIRST put)\n`));

  // ---- Step 2: keygen
  p(C.b("▶ Step 2 — generate a new operational CA keypair (memory-only)\n"));
  const { seedHex, pubHex } = genEd25519();
  const copied = tryClipboard(pubHex);
  p("  New CA public key" + (copied ? C.dim(" (copied to clipboard)") : "") + ":");
  p("    " + C.b(C.g(pubHex)));
  p(C.dim("  (the private seed is held only in this process's memory until the swap; never printed, never written to disk)\n"));

  // ---- Step 3: spawn maintainers CLI for the YubiKey ceremony
  p(C.b("▶ Step 3 — YubiKey CaEndorsement ceremony (stdio inherited — prompts appear below)\n"));
  p(C.y(`  Insert your YubiKey (the ca-track holder) now. The CLI will ask you to:`));
  p(C.y(`    • type CA-LEASE to confirm`));
  p(C.y(`    • enter your PIV PIN`));
  p(C.y(`    • physically tap the YubiKey`));
  p("");

  const before = snapshotEndorsementDir(opts.maintainersDir);
  const cliArgs = buildCliArgs({
    pubHex,
    scope: opts.scope,
    duration: opts.duration,
    track: opts.track,
    signingKey: opts.signingKey,
    maintainersDir: opts.maintainersDir,
    dryRun: opts.dryRun,
  });
  const code = await spawnCli(opts.maintainersCli, cliArgs);
  if (code !== 0) {
    p(C.r(`\n  ✗ maintainers CLI exited ${code} — endorsement was NOT signed. Cloudflare untouched.`));
    return 1;
  }

  if (opts.dryRun) {
    p(C.g("\n  ✓ CLI --dry-run completed (no file written, no Cloudflare touch). Re-run without --dry-run to do it for real."));
    return 0;
  }

  // ---- Step 4: detect + verify the new endorsement file
  p(C.b("\n▶ Step 4 — locally verify the freshly-signed endorsement\n"));
  const newFile = detectNewEndorsementFile(opts.maintainersDir, before);
  if (!newFile) {
    p(C.r(`  ✗ could not identify a single new endorsement file in ${opts.maintainersDir}/ca-endorsements`));
    p(C.r(`    (expected exactly one .json added; check the directory manually)`));
    return 1;
  }
  p(C.dim(`  new file: ${newFile}`));

  const endorsements = readCaEndorsements(opts.maintainersDir);
  const live = selectLiveLeaseForPubkey(endorsements, signers, Date.now(), pubHex);
  if (!live) {
    p(C.r(`  ✗ no live lease for ${pubHex.slice(0, 16)}… verifies against the ca-track signers right now`));
    p(C.r(`    (signature canon mismatch, window error, or signer not in mandate holder set)`));
    p(C.r(`    Cloudflare untouched. Inspect ${path.join(opts.maintainersDir, "ca-endorsements", newFile)} and try again.`));
    return 1;
  }
  p(C.g(`  ✓ live lease verified — exp ${live.notAfter}, signed by ${live.signedBy.slice(0, 16)}…\n`));

  // ---- Step 5: regenerate bundle.json
  p(C.b("▶ Step 5 — regenerate .maintainers/ca-endorsements/bundle.json\n"));
  const bundleContent = buildBundleContent(opts.maintainersDir);
  const bundlePath = path.join(opts.maintainersDir, "ca-endorsements", "bundle.json");
  fs.writeFileSync(bundlePath, bundleContent + "\n");
  p(C.g(`  ✓ bundle.json regenerated (${JSON.parse(bundleContent).length} endorsement(s))\n`));

  // ---- Step 6: swap Cloudflare worker secret (the point of no return)
  p(C.b("▶ Step 6 — swap the Cloudflare Worker secret FLAGSHIP_CA_PRIV_HEX\n"));
  p(C.dim("  This is the only step that reaches Cloudflare. The old lease keeps serving"));
  p(C.dim("  until its own notAfter, so there is no validity gap.\n"));
  if (!opts.yes) {
    const a = (await ask(C.y("  Proceed? [yes/NO] "))).toLowerCase();
    if (a !== "yes" && a !== "y") {
      p(C.y("  Aborted before swap. The signed endorsement file remains on disk;"));
      p(C.y("  re-run with --yes when ready, or delete the file to back out cleanly."));
      return 1;
    }
  }
  const ok = await putWranglerSecret(opts.comDir, "FLAGSHIP_CA_PRIV_HEX", seedHex);
  if (!ok) {
    p(C.r("  ✗ wrangler secret put FAILED — Worker key unchanged."));
    p(C.r("    The in-memory seed is now lost; re-run the whole script to mint a fresh key."));
    p(C.r(`    Before committing .maintainers, delete the orphan endorsement: ${newFile}`));
    return 1;
  }
  p(C.g("  ✓ wrangler secret put succeeded — Worker now signs under the new CA\n"));

  // ---- Step 7: post-swap probe (optional)
  if (opts.verifyUser) {
    p(C.b("▶ Step 7 — post-swap probe\n"));
    await postSwapVerify(opts.comUrl, opts.verifyUser, pubHex, p);
    p("");
  }

  // ---- Summary
  p(C.b("✅ Done. Next steps:"));
  p(`  1. ${C.b("git add")} ${path.relative(repoRoot, opts.maintainersDir)} && ${C.b("git commit")} -m "ca: new CaEndorsement (exp ${live.notAfter})"`);
  p(`  2. Push + deploy the Worker — stays in OBSERVE (no behavior change) until ENFORCE is flipped.`);
  p(`  3. In Worker logs, confirm the ca-gate structured line reports ${C.b("authorized: true")} on a live pubkey-cert request.`);
  p(`  4. Only then: arm enforcement → ${C.b("wrangler deploy --var CA_ENDORSEMENT_ENFORCE:true")} (or set under [vars] in wrangler.toml).`);
  p(`  5. Schedule the next renewal before ${live.notAfter} (re-run this script).`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code ?? 0)).catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + "\n");
    process.exit(1);
  });
}
