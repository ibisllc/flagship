#!/usr/bin/env node
/**
 * The root steps flagship-privd runs for the daemon once it no longer runs as root
 * (SECURITY-HARDENING-PLAN.md SEC-DAEMON-001): `node dist/setup.js <step>`, from the release, which
 * the daemon cannot change. What a step reads from the daemon's own files is checked again here,
 * against root's own copies of the box's name and the owner's keys. The last line on stdout is the
 * step's JSON result; logs go to stderr.
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseDebugAccessGrant, verifyDebugAccessGrant, DEBUG_ACCESS_MAX_MS, type DebugAccessGrant } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { applyRotationChain, fetchRotationChain } from "./adminRootRotationConsumer.js";
import { ensureGvisor, gvisorMirrorBases } from "./appSandbox/gvisor.js";
import { loadConfig } from "./config.js";
import { ensureContainerLinksUnmanaged } from "./containerLinks.js";
import { DATA_UNIT_FILE } from "./dataLayer/stack.js";
import { buildDebugSystem, realDebugCommandRunner } from "./debugAccessGate.js";
import { writeFileDurable } from "./durableFile.js";
import { showServerCode } from "./enrollment.js";
import { loadArchV2Config } from "./engine/engine.js";
import { installHealthReporter } from "./healthReporter.js";
import { installRustStack } from "./rustStack/install.js";
import { SERVER_CODE_REQUEST } from "./privileged.js";
import { localCommandRunner, type CommandRunner } from "./serviceRunner.js";
import { repairSystemPackages } from "./systemRepair.js";
import { installUpdateGuard } from "./updateGuard.js";
import { FILES_HELPER_IMAGE } from "./volumeDump.js";

const REPO = "/opt/flagship";
const DATA_DIR = "/var/flagship";
const DAEMON_ENV = "/etc/flagship/daemon.env";
const SKEW_MS = 10 * 60_000;

const log = (m: string) => console.error(m);
const run = (cmd: string, args: string[]) => localCommandRunner.run(cmd, args);
const cmd = localCommandRunner as Required<CommandRunner>;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

async function daemonEnv(): Promise<Record<string, string>> {
  return parseEnvFile(await readFile(DAEMON_ENV, "utf8").catch(() => ""));
}

/**
 * Open debug access only for a grant root can verify itself: the one the daemon saved as open, signed
 * by the owner's admin root (followed along its signed rotation chain from root's seed) or, on a box
 * that pins none, the account key in root's config; for this box; not ended.
 */
export async function verifiedDebugGrant(o: {
  state: unknown;
  serverDomain: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username: string;
  rotations?: () => Promise<Parameters<typeof applyRotationChain>[0]["chain"]>;
  now: number;
}): Promise<{ ok: true; grant: DebugAccessGrant } | { ok: false; reason: string }> {
  const active = (o.state as { active?: { grant?: unknown; signatureHex?: unknown; ending?: unknown } } | null)?.active;
  if (!active || active.ending) return { ok: false, reason: "no open grant" };
  const grant = parseDebugAccessGrant(active.grant);
  if (!grant) return { ok: false, reason: "the open grant can't be read" };
  if (grant.serverDomain.toLowerCase() !== o.serverDomain.toLowerCase()) return { ok: false, reason: "the grant is for another server" };
  if (grant.expiresAt <= o.now) return { ok: false, reason: "the grant has ended" };
  if (grant.expiresAt - o.now > DEBUG_ACCESS_MAX_MS + SKEW_MS || grant.issuedAt > o.now + SKEW_MS) return { ok: false, reason: "the grant's dates are out of range" };
  const sigHex = String(active.signatureHex ?? "");
  if (!/^[0-9a-f]{128}$/.test(sigHex)) return { ok: false, reason: "the grant's signature can't be read" };
  let adminRootPub = o.adminRootPub;
  if (adminRootPub && o.rotations) {
    const pinned = applyRotationChain({ pinnedHex: Buffer.from(adminRootPub).toString("hex"), username: o.username, chain: await o.rotations() }).pinnedHex;
    adminRootPub = Uint8Array.from(Buffer.from(pinned, "hex"));
  }
  const ok = authorizeSensitiveOrder({
    order: grant,
    signature: Uint8Array.from(Buffer.from(sigHex, "hex")),
    verify: verifyDebugAccessGrant,
    ownerIrkPub: o.ownerIrkPub,
    ...(adminRootPub ? { adminRootPub } : {}),
    username: o.username,
    activeGrants: [],
    now: o.now,
  });
  return ok ? { ok: true, grant } : { ok: false, reason: "the grant isn't signed by the owner" };
}

async function openDebugAccess(): Promise<unknown> {
  const env = await daemonEnv();
  const cfg = await loadConfig(env.FLAGSHIP_CONFIG ?? "/etc/flagship/config.json");
  const state = JSON.parse(await readFile(join(DATA_DIR, "debug-access.json"), "utf8").catch(() => "null")) as unknown;
  const base = env.FLAGSHIP_CONTROL_PLANE_BASE_URL;
  const r = await verifiedDebugGrant({
    state,
    serverDomain: env.FLAGSHIP_SUBDOMAIN ?? "",
    ownerIrkPub: cfg.irkPublicKey,
    ...(cfg.adminRootPub ? { adminRootPub: cfg.adminRootPub } : {}),
    username: cfg.userId,
    ...(base ? { rotations: () => fetchRotationChain(base, cfg.userId, fetch, log) } : {}),
    now: Date.now(),
  });
  const system = buildDebugSystem({ runner: realDebugCommandRunner, log });
  if (!r.ok) {
    await system.close();
    throw new Error(`debug access refused: ${r.reason}`);
  }
  await system.open({ sshPublicKey: r.grant.sshPublicKey, expiresAt: r.grant.expiresAt });
  return { open: true, expiresAt: r.grant.expiresAt };
}

async function syncDataUnit(): Promise<unknown> {
  const wanted = await readFile(join(REPO, "installer/data-services/flagship-data-services.service"), "utf8");
  const installed = await readFile(DATA_UNIT_FILE, "utf8").catch(() => null);
  if (installed === wanted) return { changed: false };
  await writeFileDurable(DATA_UNIT_FILE, wanted, 0o644);
  await run("systemctl", ["daemon-reload"]);
  return { changed: true };
}

async function serverCode(): Promise<unknown> {
  const env = await daemonEnv();
  const req = JSON.parse(await readFile(SERVER_CODE_REQUEST, "utf8")) as { stkPubHex?: unknown };
  const stkPubHex = String(req.stkPubHex ?? "");
  if (!/^[0-9a-f]{64}$/.test(stkPubHex) || !env.FLAGSHIP_SUBDOMAIN) throw new Error("no server code to show");
  return { code: await showServerCode({ stkPubHex, serverDomain: env.FLAGSHIP_SUBDOMAIN }) };
}

export const STEPS: Record<string, () => Promise<unknown>> = {
  gvisor: async () =>
    ensureGvisor({ cmd, probeImage: FILES_HELPER_IMAGE, mirrors: gvisorMirrorBases((await daemonEnv()).FLAGSHIP_CONTROL_PLANE_BASE_URL), log }),
  "health-reporter": async () => {
    const env = await daemonEnv();
    if (!env.FLAGSHIP_CONTROL_PLANE_BASE_URL || !env.FLAGSHIP_SUBDOMAIN) return false;
    return installHealthReporter({ controlPlaneBaseUrl: env.FLAGSHIP_CONTROL_PLANE_BASE_URL, serverDomain: env.FLAGSHIP_SUBDOMAIN, run, onLog: log });
  },
  "update-guard": () => installUpdateGuard({ repoPath: REPO, dataDir: DATA_DIR, run, onLog: log }),
  "container-links": () => ensureContainerLinksUnmanaged(localCommandRunner, { log }),
  "data-unit": syncDataUnit,
  "debug-access": openDebugAccess,
  "debug-access-close": async () => {
    await buildDebugSystem({ runner: realDebugCommandRunner, log }).close();
    return { open: false };
  },
  "system-repair": () => repairSystemPackages({ cmd, log }),
  "server-code": serverCode,
  // The Rust path's units, for a daemon that no longer runs as root (archV2Boot.ts).
  "rust-stack": () => installRustStack({ repoPath: REPO, config: loadArchV2Config(), run, onLog: log }),
};

// Real paths: /opt/flagship is a link to the running release, and Node reports a module by its real path.
const invokedDirectly = !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const step = STEPS[process.argv[2] ?? ""];
  if (!step || process.getuid?.() !== 0) {
    console.error("usage (as root, from flagship-privd): setup.js <step>");
    process.exit(2);
  }
  step().then(
    (r) => {
      console.log(JSON.stringify(r ?? null));
      process.exit(0);
    },
    (e) => {
      console.error(`[setup] ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
