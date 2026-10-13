/**
 * Getting dockerd up when it isn't, for every part of the box that needs it
 * (boot, the data layer, app copies). It starts the units the way systemd
 * would after resetting a failure systemd gave up on; when dockerd still won't
 * start, it reads dockerd's own error from the journal (not systemd's lines
 * around it) and repairs the one failure an unclean stop commonly leaves: a
 * corrupt network database, which is moved aside (never deleted) for dockerd
 * to rebuild. Nothing else of Docker's state is ever touched: images and
 * volumes hold the owner's apps and data.
 */
import { rename, stat } from "node:fs/promises";
import type { CommandRunner } from "./serviceRunner.js";

export const DOCKER_NETWORK_DB = "/var/lib/docker/network/files/local-kv.db";

export type DockerHealth = { ok: true; repaired?: string } | { ok: false; reason: string };

export interface WakeDockerOptions {
  cmd: Required<CommandRunner>;
  /** How long to wait for dockerd after each start. */
  waitMs?: number;
  networkDb?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}

/** With a custom format, `docker info` exits 0 when dockerd is down; only a version says it answered. */
export async function dockerAnswers(cmd: Required<CommandRunner>): Promise<boolean> {
  try {
    const { stdout } = await cmd.capture("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
    return stdout.trim() !== "";
  } catch {
    return false;
  }
}

/** A network-controller database dockerd can't open (boltdb corruption). */
const NETWORK_DB_BROKEN = /(local-kv\.db|network controller)[\s\S]*(bolt|kmap|invalid database|corrupt|page \d+|self identifies|unexpected EOF|checksum)/i;

let inFlight: Promise<DockerHealth> | null = null;

/** One attempt at a time: callers that arrive meanwhile share it. */
export function wakeDocker(o: WakeDockerOptions): Promise<DockerHealth> {
  if (!inFlight) {
    inFlight = wake(o).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function wake(o: WakeDockerOptions): Promise<DockerHealth> {
  const log = o.log ?? (() => {});
  if (await dockerAnswers(o.cmd)) return { ok: true };
  await startUnits(o.cmd);
  if (await waitUp(o)) return { ok: true };

  const failure = await dockerFailure(o.cmd);
  const db = o.networkDb ?? DOCKER_NETWORK_DB;
  if (NETWORK_DB_BROKEN.test(failure.errors.join("\n")) && (await exists(db))) {
    const aside = `${db}.broken-${(o.now ?? Date.now)()}`;
    await rename(db, aside);
    log(`[docker] dockerd couldn't open its network database; moved it aside to ${aside} and starting again`);
    await startUnits(o.cmd);
    if (await waitUp(o)) return { ok: true, repaired: `Docker's network database was damaged; it was moved aside (${aside}) and rebuilt` };
  }
  return { ok: false, reason: describe(await dockerFailure(o.cmd)) };
}

async function startUnits(cmd: Required<CommandRunner>): Promise<void> {
  // A unit that failed too often is refused until its failure is reset.
  await cmd.run("systemctl", ["reset-failed", "docker.service", "docker.socket", "containerd.service"], { timeoutMs: 15_000 }).catch(() => {});
  await cmd.run("systemctl", ["start", "--no-block", "containerd.service", "docker.socket", "docker.service"], { timeoutMs: 15_000 }).catch(() => {});
}

async function waitUp(o: WakeDockerOptions): Promise<boolean> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const until = now() + (o.waitMs ?? 60_000);
  for (;;) {
    if (await dockerAnswers(o.cmd)) return true;
    if (now() >= until) return false;
    await sleep(2_000);
  }
}

export interface DockerFailure {
  docker: Record<string, string>;
  containerd: string;
  /** dockerd's (or containerd's) own error lines, newest last. */
  errors: string[];
}

async function show(cmd: Required<CommandRunner>, unit: string, props: string[]): Promise<Record<string, string>> {
  const r = await cmd
    .capture("systemctl", ["show", unit, ...props.map((p) => `--property=${p}`)], { timeoutMs: 15_000 })
    .catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  const out: Record<string, string> = {};
  for (const line of r.stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

/** systemd's own lines about the unit, which say only that it failed. */
const SYSTEMD_LINE = /^(docker|containerd)\.(service|socket)[: ]|^(Failed to start|Started|Starting|Stopped|Stopping|Consumed|Scheduled restart)/;
const ERROR_LINE = /level=(error|fatal)|failed to start daemon|Error starting daemon|panic:|unable to configure|failed to (load|initialize|create|mount|register)|error initializing|no such file|permission denied|address already in use/i;

async function journalErrors(cmd: Required<CommandRunner>, unit: string, n: number): Promise<string[]> {
  const r = await cmd
    .capture("journalctl", ["-u", unit, "-b", "--no-pager", "-o", "cat", "-n", "300"], { timeoutMs: 15_000 })
    .catch(() => ({ stdout: "" }));
  const own = r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !SYSTEMD_LINE.test(l));
  const errors = own.filter((l) => ERROR_LINE.test(l));
  const pick = (errors.length > 0 ? errors : own).slice(-n);
  return [...new Set(pick)].map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l));
}

export async function dockerFailure(cmd: Required<CommandRunner>): Promise<DockerFailure> {
  const docker = await show(cmd, "docker.service", ["ActiveState", "SubState", "Result", "ExecMainStatus", "NRestarts"]);
  const containerd = (await show(cmd, "containerd.service", ["ActiveState"])).ActiveState ?? "unknown";
  const errors = await journalErrors(cmd, "docker.service", 3);
  if (containerd !== "active") errors.push(...(await journalErrors(cmd, "containerd.service", 2)).map((l) => `containerd: ${l}`));
  return { docker, containerd, errors };
}

export function describe(f: DockerFailure): string {
  const d = f.docker;
  const unit = d.ActiveState
    ? `docker.service is ${d.ActiveState}${d.SubState ? `/${d.SubState}` : ""}${d.Result && d.Result !== "success" ? `, result ${d.Result}` : ""}${d.ExecMainStatus && d.ExecMainStatus !== "0" ? `, exit ${d.ExecMainStatus}` : ""}${d.NRestarts && d.NRestarts !== "0" ? `, restarted ${d.NRestarts} times` : ""}`
    : "docker.service state unknown";
  const parts = [`Docker isn't running on this server (${unit}${f.containerd !== "active" ? `; containerd is ${f.containerd}` : ""})`];
  if (f.errors.length > 0) parts.push(`dockerd said: ${f.errors.join(" | ")}`);
  return parts.join(". ");
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

let repairedHook: (why: string) => void = () => {};

/** The daemon restarts itself after a repair made once it was running (its networks went with the database). */
export function setDockerRepairedHook(fn: (why: string) => void): void {
  repairedHook = fn;
}

export function dockerRepaired(why: string): void {
  repairedHook(why);
}
