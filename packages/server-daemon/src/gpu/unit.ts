/**
 * Installing flagship-gpud (the accelerator broker, rust/crates/flagship-gpu) on a box that has a
 * GPU. It runs only the binary the endorsed release carries, when its SHA-256 equals the one the
 * release's signed installer/rust/PINS.json names; it is copied out of the release so an update
 * can't swap it under the running service. A box with no NVIDIA, AMD or Intel display/accelerator
 * function gets nothing, and every GPU question on it is answered "no GPU service".
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { GVISOR_RELEASE } from "../appSandbox/gvisor.js";
import { GPUD_SOCKET } from "./client.js";

export const GPUD_BIN_REL = "installer/rust/flagship-gpud";
export const GPUD_PINS_REL = "installer/rust/PINS.json";
export const GPUD_INSTALLED = "/usr/local/lib/flagship-gpu/flagship-gpud";
export const GPUD_UNIT_PATH = "/etc/systemd/system/flagship-gpud.service";
export const GPUD_STATE_DIR = "/var/lib/flagship-gpu";
export const GPU_CATALOG_REL = "release/gpu-catalog/catalog.json";
export const GPU_TRUST_REL = "release/box-artifact-trust.json";

const SAFE = /^\/[A-Za-z0-9._/+-]+$/;
const VERSION = /^[A-Za-z0-9._+ -]{1,64}$/;

export interface GpudTools {
  nvidiaSmi?: string;
  nvidiaCtk?: string;
  rocmSmi?: string;
  amdSmi?: string;
  xpuSmi?: string;
}

export interface GpudVersions {
  runsc?: string;
  cdiGenerator?: string;
  vmRuntime?: string;
  rocm?: string;
  levelZero?: string;
}

export const TOOL_CANDIDATES: Record<keyof GpudTools, string> = {
  nvidiaSmi: "/usr/bin/nvidia-smi",
  nvidiaCtk: "/usr/bin/nvidia-ctk",
  rocmSmi: "/opt/rocm/bin/rocm-smi",
  amdSmi: "/opt/rocm/bin/amd-smi",
  xpuSmi: "/usr/bin/xpu-smi",
};

export function gpudUnit(opts: { releasePath: string; engine: string; tools: GpudTools; versions: GpudVersions; daemonUid?: number }): string {
  const flag = (name: string, v: string | undefined, re: RegExp) => {
    if (v === undefined) return [];
    if (!re.test(v)) throw new Error(`unsafe ${name} value`);
    return re === SAFE ? [`--${name}`, v] : [`--${name}`, `"${v}"`];
  };
  for (const p of [opts.releasePath, opts.engine]) if (!SAFE.test(p)) throw new Error(`unsafe path ${p}`);
  const args = [
    GPUD_INSTALLED,
    "serve",
    "--state", GPUD_STATE_DIR,
    "--socket", GPUD_SOCKET,
    "--allow-uid", "0",
    ...(opts.daemonUid !== undefined && Number.isSafeInteger(opts.daemonUid) && opts.daemonUid > 0 ? ["--allow-uid", String(opts.daemonUid)] : []),
    "--catalog", join(opts.releasePath, GPU_CATALOG_REL),
    "--trust", join(opts.releasePath, GPU_TRUST_REL),
    "--engine", opts.engine,
    ...flag("nvidia-smi", opts.tools.nvidiaSmi, SAFE),
    ...flag("nvidia-ctk", opts.tools.nvidiaCtk, SAFE),
    ...flag("rocm-smi", opts.tools.rocmSmi, SAFE),
    ...flag("amd-smi", opts.tools.amdSmi, SAFE),
    ...flag("xpu-smi", opts.tools.xpuSmi, SAFE),
    ...flag("runsc-version", opts.versions.runsc, VERSION),
    ...flag("cdi-generator", opts.versions.cdiGenerator, VERSION),
    ...flag("vm-runtime-version", opts.versions.vmRuntime, VERSION),
    ...flag("rocm-version", opts.versions.rocm, VERSION),
    ...flag("level-zero-version", opts.versions.levelZero, VERSION),
  ];
  return `# Flagship accelerator broker (installed by the daemon; gpu/unit.ts)
[Unit]
Description=Flagship accelerator broker (flagship-gpud)
After=local-fs.target
ConditionPathExists=${GPUD_INSTALLED}

[Service]
Type=simple
ExecStart=${args.join(" ")}
Restart=on-failure
RestartSec=5
RuntimeDirectory=flagship-gpu
RuntimeDirectoryMode=0755
StateDirectory=flagship-gpu
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
`;
}

/** A PCI function from a GPU vendor we have a backend for, of class display (0x03) or accelerator (0x12). */
export async function hostHasAccelerator(sysRoot = "/sys"): Promise<boolean> {
  const dir = join(sysRoot, "bus/pci/devices");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  for (const n of names) {
    const v = (await readFile(join(dir, n, "vendor"), "utf8").catch(() => "")).trim().toLowerCase();
    const c = parseInt((await readFile(join(dir, n, "class"), "utf8").catch(() => "0")).trim(), 16);
    if (["0x10de", "0x1002", "0x8086"].includes(v) && [0x03, 0x12].includes(c >> 16)) return true;
  }
  return false;
}

export interface GpudInstallDeps {
  repoPath: string;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Buffer | null>;
  write(path: string, data: Buffer | string, mode: number): Promise<void>;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
  hasAccelerator?: () => Promise<boolean>;
  engine: string;
  log?: (s: string) => void;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The pinned tool versions this host has, as the catalog names them. */
export async function measureVersions(deps: Pick<GpudInstallDeps, "read" | "run">, tools: GpudTools): Promise<GpudVersions> {
  const out: GpudVersions = { runsc: GVISOR_RELEASE };
  if (tools.nvidiaCtk) {
    const r = await deps.run(tools.nvidiaCtk, ["--version"]).catch(() => ({ code: 1, stdout: "" }));
    const m = /version\s+([0-9][0-9.]*)/i.exec(r.stdout);
    if (r.code === 0 && m) out.cdiGenerator = `nvidia-ctk ${m[1]}`;
  }
  const rocm = (await deps.read("/opt/rocm/.info/version"))?.toString("utf8").trim();
  if (rocm && VERSION.test(rocm)) out.rocm = rocm.split("-")[0];
  const kata = await deps.run("/opt/kata/bin/kata-runtime", ["--version"]).catch(() => ({ code: 1, stdout: "" }));
  const km = /kata-runtime\s*:\s*([0-9][0-9.]*)/i.exec(kata.stdout);
  if (kata.code === 0 && km) out.vmRuntime = `kata ${km[1]}`;
  return out;
}

export type GpudInstallResult = { action: "installed" | "unchanged" | "skipped"; reason: string };

export async function installGpud(deps: GpudInstallDeps): Promise<GpudInstallResult> {
  const log = deps.log ?? (() => {});
  if (!(await (deps.hasAccelerator ?? hostHasAccelerator)())) return { action: "skipped", reason: "no-accelerators" };
  const bin = await deps.read(join(deps.repoPath, GPUD_BIN_REL));
  const pinsText = (await deps.read(join(deps.repoPath, GPUD_PINS_REL)))?.toString("utf8") ?? null;
  let pinned = "";
  try {
    pinned = (JSON.parse(pinsText ?? "{}") as { binaries?: Record<string, string> }).binaries?.["flagship-gpud"] ?? "";
  } catch {
    pinned = "";
  }
  if (!bin || !/^[0-9a-f]{64}$/.test(pinned)) return { action: "skipped", reason: "the release carries no pinned flagship-gpud" };
  if (sha256(bin) !== pinned) return { action: "skipped", reason: "flagship-gpud does not match its pin" };
  const tools: GpudTools = {};
  for (const [k, p] of Object.entries(TOOL_CANDIDATES) as [keyof GpudTools, string][]) if (await deps.exists(p)) tools[k] = p;
  // An unprivileged daemon runs as `flagship`: gpud's socket admits that uid by its kernel credentials.
  const id = await deps.run("/usr/bin/id", ["-u", "flagship"]).catch(() => ({ code: 1, stdout: "" }));
  const daemonUid = id.code === 0 && /^\d+$/.test(id.stdout.trim()) ? Number(id.stdout.trim()) : undefined;
  const unit = gpudUnit({ releasePath: deps.repoPath, engine: deps.engine, tools, versions: await measureVersions(deps, tools), ...(daemonUid !== undefined ? { daemonUid } : {}) });
  const current = await deps.read(GPUD_INSTALLED);
  const currentUnit = (await deps.read(GPUD_UNIT_PATH))?.toString("utf8");
  if (current && sha256(current) === pinned && currentUnit === unit) return { action: "unchanged", reason: "current" };
  await deps.write(GPUD_INSTALLED, bin, 0o755);
  await deps.write(GPUD_UNIT_PATH, unit, 0o644);
  await deps.run("systemctl", ["daemon-reload"]);
  await deps.run("systemctl", ["enable", "flagship-gpud.service"]);
  await deps.run("systemctl", ["restart", "flagship-gpud.service"]);
  log(`[gpu] flagship-gpud ${pinned.slice(0, 12)} installed`);
  return { action: "installed", reason: "pinned binary" };
}
