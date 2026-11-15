// The webapp shell's manifest and its release signature (docs/webapp-key-custody.md item 5;
// browser side in apps/web/public/webapp/lib/shellTrust.js, runbook docs/runbooks/webapp-shell-signing.md).
//
//   npx tsx scripts/webapp-shell.ts manifest [dir]        print the manifest of a built webapp dir
//   npx tsx scripts/webapp-shell.ts sign [--sign] [--signing-key <src>] [--path .maintainers]
//                                       [--no-pq] [--key-file <f>] [--identity <f>] [--fake-yubikey <dir>]
//
// `sign` builds the webapp assets exactly as the deploy does (scripts/static-assets.ts), computes the
// manifest, previews the statement, and with --sign has the ca-track maintainer key (YubiKey) sign
//   flagship/webapp-shell/v1|<shellVersion>|<manifestSha256>|<issuedAt>|<signedBy>
// plus the release key's PQ half (pq-suites.md §14), then writes release/webapp-shell/<version>.json.
// The deploy's build copies that file to /shell-signature.json when its manifest digest matches.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const TAG_WEBAPP_SHELL = "flagship/webapp-shell/v1";
export const SIGNATURES_DIR = join(REPO, "release", "webapp-shell");
const SKIP = new Set(["/shell-manifest.json", "/shell-signature.json"]);

/** The service worker's SHELL list and SHELL_VERSION, read by running the file in a sandbox. */
export function serviceWorkerShell(swSource: string): { version: string; paths: string[] } {
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: () => {}, location: { origin: "https://webapp.example" } },
    caches: {},
    fetch: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(swSource, sandbox);
  return { version: vm.runInContext("SHELL_VERSION", sandbox) as string, paths: vm.runInContext("SHELL", sandbox) as string[] };
}

export interface ShellManifest {
  v: 1;
  shellVersion: string;
  files: Record<string, string>;
}

/** The manifest of a built webapp directory: every SHELL file that exists, plus the worker itself. */
export function shellManifest(dir: string): ShellManifest {
  const sw = readFileSync(join(dir, "service-worker.js"), "utf8");
  const { version, paths } = serviceWorkerShell(sw);
  const files: Record<string, string> = {};
  for (const p of [...new Set([...paths, "/service-worker.js"])].sort()) {
    if (SKIP.has(p)) continue;
    const file = join(dir, p === "/" ? "index.html" : p.slice(1));
    if (!existsSync(file)) continue;
    files[p] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return { v: 1, shellVersion: version, files };
}

export function manifestBytes(m: ShellManifest): Buffer {
  return Buffer.from(JSON.stringify(m, null, 1) + "\n");
}

export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export function canonicalShellStatement(s: { shellVersion: string; manifestSha256: string; issuedAt: number }, signedBy: string): Uint8Array {
  return new TextEncoder().encode([TAG_WEBAPP_SHELL, s.shellVersion, s.manifestSha256, String(s.issuedAt), signedBy].join("|"));
}

/**
 * Writes /shell-manifest.json into a built dir and, when release/webapp-shell/<version>.json signs
 * exactly that manifest, /shell-signature.json. Returns whether the shell is signed.
 */
export function stampShell(dir: string, signaturesDir = SIGNATURES_DIR): { shellVersion: string; manifestSha256: string; signed: boolean } {
  const m = shellManifest(dir);
  const bytes = manifestBytes(m);
  writeFileSync(join(dir, "shell-manifest.json"), bytes);
  const digest = sha256Hex(bytes);
  const sigFile = join(signaturesDir, `${m.shellVersion}.json`);
  rmSync(join(dir, "shell-signature.json"), { force: true });
  let signed = false;
  if (existsSync(sigFile)) {
    const doc = JSON.parse(readFileSync(sigFile, "utf8"));
    if (doc?.shellVersion === m.shellVersion && doc?.manifestSha256 === digest) {
      writeFileSync(join(dir, "shell-signature.json"), JSON.stringify(doc) + "\n");
      signed = true;
    }
  }
  return { shellVersion: m.shellVersion, manifestSha256: digest, signed };
}

/** Whether the webapp requires a signed shell (lib/shellTrust.js SHELL_SIGNATURE_REQUIRED). */
export function shellSignatureRequired(webappDir = join(REPO, "apps/web/public/webapp")): boolean {
  return /export const SHELL_SIGNATURE_REQUIRED = true;/.test(readFileSync(join(webappDir, "lib/shellTrust.js"), "utf8"));
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function sign(argv: string[]): Promise<number> {
  const { buildWebappAssets } = await import("./static-assets.js");
  const out = (s: string) => process.stdout.write(s + "\n");
  const tmp = mkdtempSync(join(tmpdir(), "webapp-shell-"));
  try {
    await buildWebappAssets(tmp);
    const m = shellManifest(tmp);
    const digest = sha256Hex(manifestBytes(m));
    const issuedAt = Date.now();
    const root = arg(argv, "path") ?? ".maintainers";
    const signingKey = arg(argv, "signing-key") ?? "yubikey-piv:slot=9c";
    const pq = await import("./pq-release-key.mjs");
    const sn = await import("./security-notice.mjs");
    const maintainers = await import("@ibisllc/maintainers");
    const lib = await pq.loadMaintainersCli();
    let signerPub: string | null = null;
    if (lib) {
      try {
        signerPub = String(await lib.keysource.loadSignerBoundPubKey(signingKey)).toLowerCase();
      } catch {
        signerPub = null;
      }
    }
    const authority = await sn.authorityKeysAt(root, issuedAt, maintainers);
    const pqPlan = signerPub ? sn.noticePqPlan({ noPq: argv.includes("--no-pq"), root, signerPub }) : { describe: "unknown (the signing key could not be read)" };
    out("\n=== webapp shell signature preview ===");
    out(`  shell version:  ${m.shellVersion}`);
    out(`  files:          ${Object.keys(m.files).length}`);
    out(`  manifest sha:   ${digest}`);
    out(`  signing key:    ${signingKey} (${signerPub ?? "unreadable"})`);
    out(`  ca authority:   ${authority.join(", ") || "(none)"}`);
    out(`  PQ half:        ${pqPlan.describe ?? pqPlan.error}`);
    if (!argv.includes("--sign")) {
      out("\nDRY RUN: nothing signed. Re-run with --sign.\n");
      return 0;
    }
    if (pqPlan.error) throw new Error(pqPlan.error);
    if (!lib || !signerPub || !authority.includes(signerPub)) throw new Error("the signing key is not the current ca-track authority; browsers would refuse this shell");
    const ok = await lib.ceremony.ttyConfirm({ ceremony: "webapp-shell", phrase: "SHELL" }).catch(() => false);
    if (!ok) throw new Error("aborted at the confirmation prompt");
    const signer = await lib.keysource.loadSigner(signingKey, { pivTransport: lib.cli.defaultEnv.pivTransport, pivPin: lib.cli.defaultEnv.pivPin });
    const statement = { shellVersion: m.shellVersion, manifestSha256: digest, issuedAt };
    const bytes = canonicalShellStatement(statement, signerPub);
    const signature = String(await signer.sign(bytes)).toLowerCase();
    let pqPart: { binding: unknown; signature: string } | undefined;
    if (pqPlan.binding) {
      const proto = await import("@flagship/protocol");
      const b = pqPlan.binding;
      const edSigner = await pq.loadEd25519Signer(signingKey);
      const vault = pq.vaultFromFlags({ fakeYubikey: arg(argv, "fake-yubikey"), identities: arg(argv, "identity") ? [arg(argv, "identity")] : [] });
      const sig = await pq.withSeed(vault, arg(argv, "key-file") ?? pq.DEFAULT_KEY_FILE, (seed: Uint8Array) =>
        proto.hybridSignExternal(Buffer.from(b.ed25519PubHex + b.mldsaPubHex, "hex"), TAG_WEBAPP_SHELL, bytes, edSigner.sign, seed),
      );
      pqPart = { binding: b, signature: Buffer.from(sig).toString("hex") };
    }
    const doc = { v: 1, ...statement, signedBy: signerPub, signature, ...(pqPart ? { pq: pqPart } : {}), mandates: sn.readCaMandates(root) };
    mkdirSync(SIGNATURES_DIR, { recursive: true });
    const file = join(SIGNATURES_DIR, `${m.shellVersion}.json`);
    writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    out(`\nWrote ${file}. Commit it on main; the next webapp deploy serves it as /shell-signature.json.\n`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "manifest") {
    process.stdout.write(manifestBytes(shellManifest(rest[0] ?? join(REPO, "apps/web/public/webapp"))));
    return 0;
  }
  if (cmd === "sign") return sign(rest);
  process.stderr.write("usage: npx tsx scripts/webapp-shell.ts manifest [dir] | sign [--sign] ...\n");
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    (c) => process.exit(c),
    (e) => {
      process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
