/**
 * Where a WASI app's worker runs, and how it is fenced (docs/wasi-apps.md).
 *
 * One systemd template, `flagship-wasi@<instance>.service`, one instance per
 * app. The instance is a hash of the service id, so the dynamic user and
 * every path stay short and say nothing about the app. Each worker:
 *
 * - runs as its own dynamic user, with no capabilities and no new privileges;
 * - sees an empty `/var` with only its own folder at `/var/app/pkg` (config,
 *   module, the daemon's socket for its host calls, read-only) and its files
 *   folder at `/var/app/data`: never another app's, never the box's state;
 * - may talk only to the loopback (IPAddressDeny=any, IPAddressAllow=localhost):
 *   it listens for the app proxy, and every outside request goes through the
 *   daemon's broker, which checks the owner's approvals;
 * - is held to its app's memory, task and CPU limits by its cgroup, under the
 *   per-run limits the worker itself enforces (fuel, wall time, linear memory).
 *
 * MemoryDenyWriteExecute is the one hardening setting left off: the worker
 * compiles WebAssembly with Cranelift and maps the code executable (the same
 * finding as the TS keyd's --jitless, HANDOVER.md M5). It never loads code it
 * did not compile itself.
 */
import { createHash } from "node:crypto";

export const WASI_ROOT = "/var/lib/flagship-wasi";
export const WASI_APPS_DIR = `${WASI_ROOT}/apps`;
export const WASI_MODULES_DIR = `${WASI_ROOT}/modules`;
export const WASI_BIN_DIR = "/usr/local/lib/flagship-wasi";
export const WASI_WORKER_BIN = `${WASI_BIN_DIR}/flagship-wasi-worker`;
export const WASI_WORKER_NAME = "flagship-wasi-worker";
export const WASI_UNIT_PATH = "/etc/systemd/system/flagship-wasi@.service";
export const WASI_DROPIN_ROOT = "/run/systemd/system";
/** Inside the worker's namespace. */
export const GUEST_PKG = "/var/app/pkg";
export const GUEST_DATA = "/var/app/data";
export const GUEST_CONFIG = `${GUEST_PKG}/worker.json`;
export const GUEST_CAP_SOCKET = `${GUEST_PKG}/cap.sock`;

/** The instance name for a service: 16 hex of a domain-separated hash. */
export function wasiInstance(serviceId: string): string {
  return createHash("sha256").update(`flagship/wasi-instance/v1|${serviceId}`).digest("hex").slice(0, 16);
}

export function wasiUnitName(serviceId: string): string {
  return `flagship-wasi@${wasiInstance(serviceId)}.service`;
}

export function wasiAppDir(serviceId: string, root: string = WASI_APPS_DIR): string {
  return `${root}/${wasiInstance(serviceId)}`;
}

export function wasiDropInPath(serviceId: string, root: string = WASI_DROPIN_ROOT): string {
  return `${root}/${wasiUnitName(serviceId)}.d/50-app.conf`;
}

const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** The template every WASI app's worker runs from. */
export function wasiTemplateUnit(bin: string = WASI_WORKER_BIN): string {
  if (!SAFE_PATH.test(bin)) throw new Error("unsafe worker path");
  return `# Written by the Flagship daemon (wasi/unit.ts). One instance per WASI app.
[Unit]
Description=Flagship WASI app worker %i
After=network.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
DynamicUser=yes
User=fwasi-%i
ExecStart=${bin} serve --config ${GUEST_CONFIG}
Restart=on-failure
RestartSec=2
TemporaryFileSystem=/var:ro
BindReadOnlyPaths=${WASI_APPS_DIR}/%i:${GUEST_PKG}
InaccessiblePaths=-/run/flagship-daemon -/run/flagship-privd -/run/flagship-broker -/run/flagship-keyd -/run/flagship-rust -/run/docker.sock -/run/docker -/run/podman -/run/containerd -/etc/flagship -/opt/flagship -/root
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
PrivateIPC=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @mount @debug @module @raw-io @reboot @swap @cpu-emulation @obsolete @clock
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
UMask=0077
LimitCORE=0
MemoryMax=512M
MemorySwapMax=0
TasksMax=64
CPUQuota=100%
`;
}

export interface WasiDropIn {
  world: "command" | "http-proxy";
  /** Unit cgroup limits for this app. */
  memoryMiB: number;
  tasks: number;
  /** Percent of one CPU. */
  cpuPercent: number;
  /** The files folder's host path (the app's quota-backed volume), when it has one. */
  filesHostPath?: string;
  restart: "always" | "on-failure" | "never";
  bin?: string;
}

const clampInt = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(n)));

/** The drop-in's limits as written: whole numbers within the unit's bounds (what the broker accepts). */
export function wasiDropInLimits(d: Pick<WasiDropIn, "memoryMiB" | "tasks" | "cpuPercent">): { memoryMiB: number; tasks: number; cpuPercent: number } {
  return { memoryMiB: clampInt(d.memoryMiB, 32, 8192), tasks: clampInt(d.tasks, 8, 4096), cpuPercent: clampInt(d.cpuPercent, 5, 800) };
}

/** The per-app part, written to /run (rebuilt at every start). */
export function wasiDropIn(d: WasiDropIn): string {
  const bin = d.bin ?? WASI_WORKER_BIN;
  if (!SAFE_PATH.test(bin)) throw new Error("unsafe worker path");
  if (d.filesHostPath !== undefined && !SAFE_PATH.test(d.filesHostPath)) throw new Error("unsafe files path");
  const int = clampInt;
  const lines = [
    "# Written by the Flagship daemon (wasi/unit.ts) for one app.",
    "[Service]",
    "ExecStart=",
    `ExecStart=${bin} ${d.world === "command" ? "run" : "serve"} --config ${GUEST_CONFIG}`,
    `Restart=${d.restart === "never" ? "no" : d.restart}`,
    `MemoryMax=${int(d.memoryMiB, 32, 8192)}M`,
    `TasksMax=${int(d.tasks, 8, 4096)}`,
    `CPUQuota=${int(d.cpuPercent, 5, 800)}%`,
  ];
  if (d.filesHostPath) lines.push(`BindPaths=${d.filesHostPath}:${GUEST_DATA}`);
  return lines.join("\n") + "\n";
}
