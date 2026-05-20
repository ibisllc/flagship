#!/usr/bin/env node
/**
 * `create-vps` — real-VPS end-to-end harness CLI.
 *
 * Drives + asserts the WHOLE Flagship chain on a real cloud VPS via
 * the pure core (`runE2E`):
 *
 *   1.  Generate / load a local SSH keypair (`.demo-ssh-key`).
 *   2.  Upload its public half to Hetzner idempotently as named SSH
 *       key `flagship-vps-e2e` (POST /v1/ssh_keys; skip if exists).
 *   3.  Mint a build code on `.com` (IRK-signed) — we now have an
 *       install blob the Flagship boot chain will redeem.
 *   4.  Personalize the supplied base ISO with THAT install blob +
 *       signature so the trailer matches the live ticket.
 *   5.  Upload the personalized ISO to R2 + mint a 1h presigned URL
 *       (via `wrangler r2 object put` + `presign`).
 *   6.  Hetzner rescue-mode boot: POST /servers (ubuntu-22.04 +
 *       ssh_keys) → enable_rescue → reset → poll TCP 22 → ssh in +
 *       `wget <presigned> | dd of=/dev/sda && reboot`.
 *   7.  The Flagship Alpine + apkovl + install.sh take over; the
 *       harness asserts the rest of the chain on `.com` + the live
 *       `<server>.<user>.flagship.services` (green padlock, free
 *       account/server, vibecode env-var injection).
 *   8.  TEARDOWN ALWAYS RUNS (finally): DELETE /v1/servers/{id} +
 *       `wrangler r2 object delete <bucket>/<key>` — both are
 *       idempotent.
 *
 * This file is the thin real-I/O wiring + arg parsing; the pure core
 * + the arg/plan builders below ARE unit-tested.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { HetznerProvider } from "./providers/hetzner.js";
import { nodeHttpClient } from "./httpClient.js";
import { makeIdentity } from "./identity.js";
import {
  plannedChain,
  runE2E,
  type PlannedStage,
} from "./runE2E.js";
import type { IsoPublisher } from "./ports.js";
import { R2Uploader, makeObjectKey, rand6 } from "./r2Upload.js";
import type { E2EPlan, Logger, VpsProvider } from "./ports.js";

export interface CliArgs {
  iso?: string;
  provider: string;
  providerTokenEnv: string;
  comBase: string;
  servicesBase: string;
  username: string;
  serverName: string;
  region: string;
  size: string;
  plan: boolean;
  keep: boolean;
  sshKeyPath: string;
  uploadVia: "r2" | "none";
  r2Bucket: string;
}

const DEFAULTS = {
  provider: "hetzner",
  providerTokenEnv: "HCLOUD_TOKEN",
  comBase: "https://flagshipserver.com",
  servicesBase: "https://flagship.services",
  region: "fsn1",
  size: "cx22",
  sshKeyPath: ".demo-ssh-key",
  uploadVia: "r2" as const,
  r2Bucket: "flagship-iso-temp",
};

/** Pure arg parser (unit-tested). Throws on unknown flags. */
export function parseArgs(argv: string[]): CliArgs {
  const a: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined || !tok.startsWith("--")) {
      throw new Error(`unexpected argument: ${tok}`);
    }
    const key = tok.slice(2);
    if (key === "plan" || key === "keep") {
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
  const rnd = Math.random().toString(36).slice(2, 7);
  const uploadVia = (a["upload-via"] as string) ?? DEFAULTS.uploadVia;
  if (uploadVia !== "r2" && uploadVia !== "none") {
    throw new Error(`--upload-via must be "r2" or "none" (got: ${uploadVia})`);
  }
  return {
    iso: typeof a["iso"] === "string" ? (a["iso"] as string) : undefined,
    provider: (a["provider"] as string) ?? DEFAULTS.provider,
    providerTokenEnv:
      (a["provider-token"] as string) ?? DEFAULTS.providerTokenEnv,
    comBase: (a["com-base"] as string) ?? DEFAULTS.comBase,
    servicesBase: (a["services-base"] as string) ?? DEFAULTS.servicesBase,
    username: (a["username"] as string) ?? `e2e${rnd}`,
    serverName: (a["server-name"] as string) ?? "home",
    region: (a["region"] as string) ?? DEFAULTS.region,
    size: (a["size"] as string) ?? DEFAULTS.size,
    plan: a["plan"] === true,
    keep: a["keep"] === true,
    sshKeyPath: (a["ssh-key-path"] as string) ?? DEFAULTS.sshKeyPath,
    uploadVia,
    r2Bucket: (a["r2-bucket"] as string) ?? DEFAULTS.r2Bucket,
  };
}

/** Pure: render the `--plan` text (unit-tested, zero credentials). */
export function renderPlan(chain: PlannedStage[]): string {
  const lines: string[] = [];
  lines.push("create-vps — full ordered chain (no provisioning happens with --plan):");
  lines.push("");
  chain.forEach((s, i) => {
    const tag =
      s.kind === "known-gated"
        ? " [KNOWN-GATED]"
        : s.kind === "teardown"
          ? " [ALWAYS — try/finally]"
          : "";
    lines.push(`${String(i + 1).padStart(2)}. ${s.name}${tag}`);
    lines.push(`    ${s.description}`);
    if (s.gatedReason) {
      lines.push(`    gatedReason: ${s.gatedReason}`);
    }
  });
  lines.push("");
  lines.push(
    "KNOWN-GATED stages are attempted read-only and reported `known-gated`;",
  );
  lines.push(
    "they NEVER fail the overall run — they document a real, not-yet-wired gap.",
  );
  return lines.join("\n");
}

const consoleLogger: Logger = {
  info: (m, d) => console.log(`[e2e] ${m}`, d ?? ""),
  warn: (m, d) => console.warn(`[e2e] ${m}`, d ?? ""),
  error: (m, d) => console.error(`[e2e] ${m}`, d ?? ""),
};

/* ─────────────────── SSH-key management (local) ─────────────────────── */

/**
 * Generate `.demo-ssh-key` (and `.demo-ssh-key.pub`) via `ssh-keygen`
 * if absent. Returns the public-half contents.
 */
export function ensureLocalSshKey(privPath: string): {
  publicKey: string;
  privateKeyPath: string;
} {
  const pubPath = `${privPath}.pub`;
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    mkdirSync(dirname(resolve(privPath)), { recursive: true });
    const res = spawnSync(
      "ssh-keygen",
      ["-t", "ed25519", "-f", privPath, "-N", "", "-q", "-C", "flagship-vps-e2e"],
      { stdio: "inherit" },
    );
    if (res.status !== 0) {
      throw new Error(
        `ssh-keygen failed (status ${res.status}); install OpenSSH or pass --ssh-key-path to a pre-existing key`,
      );
    }
  }
  return {
    privateKeyPath: privPath,
    publicKey: readFileSync(pubPath, "utf8"),
  };
}

function buildProvider(args: CliArgs, token: string): VpsProvider {
  switch (args.provider) {
    case "hetzner":
      return new HetznerProvider({
        token,
        sshKeyPath: args.sshKeyPath,
      });
    default:
      throw new Error(
        `unknown provider "${args.provider}" (only "hetzner" has a reference adapter)`,
      );
  }
}

/* ─────────────────── ISO publisher (R2-backed) ──────────────────────── */

interface UploadedArtifact {
  bucket: string;
  key: string;
  url: string;
}

/**
 * Real-I/O IsoPublisher: builds the personalized ISO at runtime from a
 * fresh `.com`-signed install blob + signature (so the trailer matches
 * the live ticket), uploads to R2, mints a presigned URL.
 */
export function makeR2IsoPublisher(opts: {
  baseIsoPath: string;
  bucket: string;
}): IsoPublisher & { cleanup: () => Promise<void> } {
  const uploader = new R2Uploader({ bucket: opts.bucket });
  let uploaded: UploadedArtifact | null = null;
  let workDir: string | null = null;

  return {
    async publish({ blobJson, blobSignatureHex }): Promise<string> {
      workDir = await mkdtemp(join(tmpdir(), "flagship-e2e-iso-"));
      const envelopePath = join(workDir, "blob.json");
      const outIso = join(workDir, "personalized.iso");
      await writeFile(
        envelopePath,
        JSON.stringify({ blob: blobJson, blobSignature: blobSignatureHex }),
      );
      // Shell out to the iso-personalizer CLI; it's tested + battle-
      // proven, and the harness doesn't need to re-implement the
      // trailer codec.
      const cliPath = resolveIsoPersonalizerCli();
      const tsx = resolveTsx(cliPath);
      const res = spawnSync(
        tsx,
        [
          cliPath,
          "--base-iso",
          opts.baseIsoPath,
          "--output",
          outIso,
          "--blob-json",
          envelopePath,
          "--verify",
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      if (res.status !== 0) {
        throw new Error(
          `personalize-iso CLI failed (status ${res.status}): ${res.stdout?.toString().slice(0, 300) ?? ""}`,
        );
      }
      const key = makeObjectKey(Date.now(), rand6);
      const result = await uploader.upload(outIso, key);
      uploaded = { bucket: result.bucket, key: result.key, url: result.presignedUrl };
      return result.presignedUrl;
    },
    async cleanup(): Promise<void> {
      // Cleanup runs in the same finally as server destroy; both are
      // independent + idempotent.
      const errs: string[] = [];
      if (uploaded) {
        try {
          await uploader.delete(uploaded.key);
        } catch (e) {
          errs.push(`r2 delete: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (workDir) {
        try {
          await rm(workDir, { recursive: true, force: true });
        } catch (e) {
          errs.push(`workdir cleanup: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (errs.length) {
        throw new Error(errs.join("; "));
      }
    },
  };
}

function resolveIsoPersonalizerCli(): string {
  const here = dirname(new URL(import.meta.url).pathname);
  const candidates = [
    resolve(here, "..", "..", "..", "packages", "iso-personalizer", "src", "cli.ts"),
    resolve(here, "..", "..", "..", "..", "packages", "iso-personalizer", "src", "cli.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "could not locate packages/iso-personalizer/src/cli.ts from " +
      "tools/vps-e2e — is this an unusual checkout layout?",
  );
}

function resolveTsx(refFile: string): string {
  let dir = dirname(refFile);
  for (let i = 0; i < 12; i++) {
    const c = join(dir, "node_modules", ".bin", "tsx");
    if (existsSync(c)) return c;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate tsx in any parent node_modules/.bin/");
}

/* ─────────────────── main ───────────────────────────────────────────── */

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(
      `argument error: ${e instanceof Error ? e.message : String(e)}`,
    );
    console.error(
      "usage: create-vps --iso <base-iso-path> --provider <name> " +
        "[--provider-token <ENV>] [--com-base <url>] [--services-base <url>] " +
        "[--region <r>] [--size <s>] [--username <u>] [--server-name <s>] " +
        "[--ssh-key-path <path>] [--upload-via r2|none] [--r2-bucket <name>] " +
        "[--plan] [--keep]",
    );
    return 2;
  }

  // --plan: zero credentials, provisions nothing, exits before any I/O.
  if (args.plan) {
    console.log(renderPlan(plannedChain()));
    return 0;
  }

  if (!args.iso) {
    console.error(
      "fail-closed: --iso is required for a real run — it's the path " +
        "to the BASE Alpine ISO (the harness personalizes it inline " +
        "with a fresh `.com`-signed install blob).",
    );
    return 2;
  }

  // Provider-token check fires BEFORE the iso-exists check so the
  // operator sees the missing-token error first (cheapest fix; most
  // common failure mode for first-time runs).
  const token = process.env[args.providerTokenEnv];
  if (!token) {
    console.error(
      `fail-closed: provider token env "${args.providerTokenEnv}" is not set.\n` +
        `A real run provisions a real ${args.provider} VPS and incurs cost.\n` +
        `Set it and re-run, e.g.:\n` +
        `    export ${args.providerTokenEnv}=<your-${args.provider}-api-token>\n` +
        `    create-vps --iso ${args.iso} --provider ${args.provider}\n` +
        `(or run \`create-vps --plan\` to see the chain without provisioning).`,
    );
    return 3;
  }

  // Provider-build comes before the iso-exists check so an unknown
  // provider is reported as a fail-closed 3 even when the iso path
  // is bogus (matches the deterministic-fail-closed test contract).
  const absSshKey = isAbsolute(args.sshKeyPath)
    ? args.sshKeyPath
    : resolve(process.cwd(), args.sshKeyPath);
  let provider: VpsProvider;
  try {
    provider = buildProvider({ ...args, sshKeyPath: absSshKey }, token);
  } catch (e) {
    console.error(
      `fail-closed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 3;
  }

  if (!existsSync(args.iso)) {
    console.error(
      `fail-closed: --iso "${args.iso}" does not exist on disk.\n` +
        `Download it once:\n` +
        `    curl -L -o /tmp/flagship-base.iso \\\n` +
        `      https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso\n` +
        `then pass --iso /tmp/flagship-base.iso.`,
    );
    return 2;
  }

  // Local SSH key — generate if missing.
  let sshPub: string;
  try {
    const k = ensureLocalSshKey(absSshKey);
    sshPub = k.publicKey;
  } catch (e) {
    console.error(
      `fail-closed: ssh key setup: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 3;
  }

  // Ensure the SSH key is registered on Hetzner (idempotent by name).
  if (provider instanceof HetznerProvider) {
    try {
      const id = await provider.ensureSshKey(sshPub);
      consoleLogger.info("ensured Hetzner SSH key", { name: "flagship-vps-e2e", id });
    } catch (e) {
      console.error(
        `fail-closed: hetzner ensureSshKey: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 3;
    }
  }

  // Build the IsoPublisher (R2 only for now).
  let publisher: (IsoPublisher & { cleanup: () => Promise<void> }) | undefined;
  if (args.uploadVia === "r2") {
    publisher = makeR2IsoPublisher({
      baseIsoPath: args.iso,
      bucket: args.r2Bucket,
    });
  } else {
    console.error(
      `fail-closed: --upload-via "${args.uploadVia}" is not supported in this build (use r2)`,
    );
    return 3;
  }

  const plan: E2EPlan = {
    comBase: args.comBase,
    servicesBase: args.servicesBase,
    // `iso` is now consumed by `IsoPublisher.publish` — the value here
    // is informational; the actual URL handed to the provider comes
    // from publish().
    iso: args.iso,
    username: args.username,
    serverName: args.serverName,
    region: args.region,
    size: args.size,
    pollIntervalMs: 15_000,
    pollMaxAttempts: 80,
    keep: args.keep,
  };

  let report;
  try {
    report = await runE2E(plan, {
      provider,
      http: nodeHttpClient,
      clock: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      logger: consoleLogger,
      identity: makeIdentity(),
      isoPublisher: publisher,
    });
  } finally {
    if (publisher) {
      try {
        await publisher.cleanup();
        consoleLogger.info("R2 cleanup ok");
      } catch (e) {
        consoleLogger.warn(
          `R2 cleanup failure (manual delete may be needed): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  for (const s of report.stages) {
    const line = `[${s.status.toUpperCase()}] ${s.name} — ${s.detail}`;
    if (s.status === "fail") console.error(line);
    else console.log(line);
    if (s.gatedReason) console.log(`        gatedReason: ${s.gatedReason}`);
  }
  console.log(
    `\nresult: ${report.ok ? "OK" : "FAILED"} ` +
      `(${report.stages.filter((s) => s.status === "pass").length} pass, ` +
      `${report.stages.filter((s) => s.status === "fail").length} fail, ` +
      `${report.stages.filter((s) => s.status === "known-gated").length} known-gated, ` +
      `${report.stages.filter((s) => s.status === "skipped").length} skipped)`,
  );
  return report.ok ? 0 : 1;
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("cli.ts") || entry.endsWith("cli.js")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[e2e] fatal:", err);
      process.exit(1);
    });
}
