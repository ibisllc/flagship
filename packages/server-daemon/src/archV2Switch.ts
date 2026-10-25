/**
 * Moving an existing box between its container stacks on the owner's signed order
 * (docs/architecture-v2/engine-and-rust-path.md §7): from the classic stack (Docker, the TS
 * keyd and privd) to arch-v2 (Podman, and keyd, the broker and core from the release's Rust
 * programs), or back.
 *
 * Who does what:
 *   - the daemon checks the order (admin root on a pinned box, hybrid under strict), shows the
 *     plan and its blockers, and hands the order to root;
 *   - root (setup.js `arch-v2-switch`, or the daemon itself while it still runs as root) checks
 *     the order again against its own copy of the owner's keys, installs Podman from Debian,
 *     and writes the box switch; it keeps the switch's record where the daemon can't write;
 *   - the next start does the move itself (archV2Boot.ts: engine/migrate.ts, the Rust units);
 *   - the trial: the switch stands only once the box is healthy and every app that ran before
 *     runs again. A failed move, three starts that never get there, or no health within the
 *     window put the switch back (setup.js `arch-v2-settle`); a revert is refused once the
 *     switch was kept or its window ended, so a daemon can't undo the owner's choice later.
 * Docker's data is never deleted (engine/migrate.ts), so going back finds the apps as they were.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import {
  canonicalArchV2SwitchOrder,
  parseArchV2SwitchOrder,
  verifyArchV2SwitchOrder,
  type AdminGrantView,
  type ArchV2SwitchOrder,
  type BoxStackTarget,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { applyRotationChain, fetchRotationChain } from "./adminRootRotationConsumer.js";
import { writeFileDurable } from "./durableFile.js";
import { ARCH_V2_CONFIG, parseArchV2Config, type ArchV2Config, type EngineKind } from "./engine/engine.js";
import { hybridOrderSignature } from "./pqAuthority.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { CommandRunner } from "./serviceRunner.js";

export const SWITCH_ORDER_FILE = "/var/flagship/arch-v2-order.json";
export const SWITCH_VERDICT_FILE = "/var/flagship/arch-v2-verdict.json";
export const SWITCH_TRIAL_FILE = "/var/flagship/arch-v2-trial.json";
export const SWITCH_RECORD = "/var/lib/flagship/arch-v2-switch.json";
export const RUST_PINS_IN_RELEASE = "installer/rust/PINS.json";
export const ORDER_MAX_AGE_MS = 5 * 60_000;
export const ROOT_ORDER_MAX_AGE_MS = 10 * 60_000;
export const TRIAL_MS = 24 * 3_600_000;
export const TRIAL_MAX_BOOTS = 3;
export const APPS_BACK_MS = 20 * 60_000;
const GiB = 1024 ** 3;

/** What a new arch-v2 box installs (flagship-builder engineSetup.ts ENGINE_APT_PACKAGES; a test pins them together). */
export const ENGINE_PACKAGES = ["podman", "netavark", "aardvark-dns", "crun", "conmon", "catatonit", "docker-compose", "nftables", "zstd"];
export const COMPOSE_DROPIN_PATH = "/etc/containers/containers.conf.d/40-flagship-compose.conf";
export const COMPOSE_DROPIN = `# The data services' compose file runs through docker-compose against Podman's root-only socket.
[engine]
compose_providers = ["/usr/bin/docker-compose"]
compose_warning_logs = false
`;

export type SwitchState = "installing" | "trial" | "done" | "reverted";

export interface SwitchRecord {
  version: 1;
  nonce: string;
  target: BoxStackTarget;
  order: ArchV2SwitchOrder;
  signatureHex: string;
  /** The switch file as it was before (null: none, an existing box's legacy path). */
  previousText: string | null;
  state: SwitchState;
  startedAt: number;
  trialUntil?: number;
  finishedAt?: number;
  reason?: string;
  usedNonces: string[];
}

export interface SwitchFiles {
  read(path: string): Promise<string | null>;
  write(path: string, content: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): boolean;
}

export const realSwitchFiles: SwitchFiles = {
  read: async (p) => await readFile(p, "utf8").catch(() => null),
  write: async (p, c, mode) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFileDurable(p, c, mode);
  },
  remove: async (p) => await rm(p, { force: true }),
  exists: existsSync,
};

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function parseSwitchRecord(text: string | null): SwitchRecord | null {
  const r = parseJson(text) as Partial<SwitchRecord> | null;
  if (!r || r.version !== 1 || typeof r.nonce !== "string" || !["installing", "trial", "done", "reverted"].includes(r.state as string)) return null;
  const order = parseArchV2SwitchOrder(r.order);
  if (!order || order.nonce !== r.nonce) return null;
  return { ...(r as SwitchRecord), order, usedNonces: Array.isArray(r.usedNonces) ? r.usedNonces.filter((n) => typeof n === "string") : [] };
}

const HEX_SIG = /^[0-9a-f]{128}$/;
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);

/** The switch file a target stands for. */
export function targetConfig(target: BoxStackTarget, now: Date): ArchV2Config {
  return target === "arch-v2"
    ? { version: 1, rust: "on", engine: "podman", source: "owner", setAt: now.toISOString() }
    : { version: 1, rust: "off", engine: "docker", source: "owner", setAt: now.toISOString() };
}

/** Where a switch file puts the box: the engine decides (the Rust units follow the switch on their own). */
export function stackOf(c: ArchV2Config): BoxStackTarget {
  return c.engine === "podman" ? "arch-v2" : "classic";
}

// ── root ──────────────────────────────────────────────────────────────────

export interface RootSwitchDeps {
  files: SwitchFiles;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  /** The box's own name, from root's copy of the daemon's environment. */
  serverDomain: string;
  /** The order is the owner's: root's copy of the pinned admin root (as rotated) or, without one, the IRK. */
  authorize: (order: ArchV2SwitchOrder, signature: Uint8Array) => Promise<boolean>;
  repoPath: string;
  now: () => number;
  log?: (m: string) => void;
  configPath?: string;
  recordPath?: string;
  orderPath?: string;
  verdictPath?: string;
}

export class SwitchRefused extends Error {}

/**
 * Root's check of the owner's order: the pinned admin root, followed along its signed rotation
 * chain from `.com` (each hop verified), or the IRK on a box that pins none.
 */
export function ownerSwitchAuthorizer(o: {
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username: string;
  controlPlaneBaseUrl?: string;
  log?: (m: string) => void;
}): RootSwitchDeps["authorize"] {
  return async (order, signature) => {
    let adminRootPub = o.adminRootPub;
    if (adminRootPub && o.controlPlaneBaseUrl) {
      const chain = await fetchRotationChain(o.controlPlaneBaseUrl, o.username, fetch, o.log ?? (() => {}));
      adminRootPub = Uint8Array.from(Buffer.from(applyRotationChain({ pinnedHex: Buffer.from(adminRootPub).toString("hex"), username: o.username, chain }).pinnedHex, "hex"));
    }
    return authorizeSensitiveOrder({
      order,
      signature,
      verify: verifyArchV2SwitchOrder,
      ownerIrkPub: o.ownerIrkPub,
      ...(adminRootPub ? { adminRootPub } : {}),
      username: o.username,
      activeGrants: [],
    });
  };
}

/**
 * Root's half of starting a switch: the order checked again, Podman installed, the switch
 * written. Resumes an install the same order began (a restart mid-install); refuses a second
 * switch while one is under way, a used order, and a stale one.
 */
export async function applySwitchAsRoot(d: RootSwitchDeps): Promise<{ state: SwitchState; target: BoxStackTarget }> {
  const files = d.files;
  const configPath = d.configPath ?? ARCH_V2_CONFIG;
  const recordPath = d.recordPath ?? SWITCH_RECORD;
  const raw = parseJson(await files.read(d.orderPath ?? SWITCH_ORDER_FILE)) as { order?: unknown; signatureHex?: unknown } | null;
  const order = parseArchV2SwitchOrder(raw?.order);
  const signatureHex = typeof raw?.signatureHex === "string" ? raw.signatureHex : "";
  if (!order || !HEX_SIG.test(signatureHex)) throw new SwitchRefused("the switch order can't be read");
  if (order.serverDomain.toLowerCase() !== d.serverDomain.toLowerCase()) throw new SwitchRefused("the switch order is for another server");
  if (!(await d.authorize(order, Uint8Array.from(Buffer.from(signatureHex, "hex"))))) throw new SwitchRefused("the switch order isn't signed by the owner");

  const rec = parseSwitchRecord(await files.read(recordPath));
  if (rec?.nonce === order.nonce && rec.state === "trial") return { state: "trial", target: rec.target };
  const resuming = rec?.nonce === order.nonce && rec.state === "installing";
  if (!resuming) {
    if (rec && (rec.state === "installing" || rec.state === "trial")) throw new SwitchRefused("another switch is under way on this server");
    if (rec && (rec.nonce === order.nonce || rec.usedNonces.includes(order.nonce))) throw new SwitchRefused("this switch order was already used");
    if (Math.abs(d.now() - order.issuedAt) > ROOT_ORDER_MAX_AGE_MS) throw new SwitchRefused("the switch order is too old");
  }
  if (order.target === "arch-v2" && !files.exists(`${d.repoPath}/${RUST_PINS_IN_RELEASE}`)) {
    throw new SwitchRefused("this server's release doesn't carry the new stack");
  }
  if (order.target === "classic" && !files.exists("/usr/bin/docker")) throw new SwitchRefused("this server has no Docker to go back to");

  const previousText = resuming ? rec!.previousText : await files.read(configPath);
  const record: SwitchRecord = {
    version: 1,
    nonce: order.nonce,
    target: order.target,
    order,
    signatureHex,
    previousText,
    state: "installing",
    startedAt: resuming ? rec!.startedAt : d.now(),
    usedNonces: [...(rec?.usedNonces ?? []), ...(rec && rec.nonce !== order.nonce ? [rec.nonce] : [])].slice(-64),
  };
  await files.write(recordPath, `${JSON.stringify(record, null, 2)}\n`, 0o644);

  try {
    if (order.target === "arch-v2") {
      d.log?.("[arch-v2-switch] installing Podman from Debian");
      await d.run("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", "update", "-q"]);
      await d.run("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q", "--no-install-recommends", ...ENGINE_PACKAGES]);
      await files.write(COMPOSE_DROPIN_PATH, COMPOSE_DROPIN, 0o644);
      await d.run("systemctl", ["enable", "podman.socket"]);
    }
    await files.write(configPath, `${JSON.stringify(targetConfig(order.target, new Date(d.now())))}\n`, 0o644);
  } catch (e) {
    // The switch file is written last, so nothing has moved: the box stays as it was.
    if (previousText === null) await files.remove(configPath).catch(() => {});
    else await files.write(configPath, previousText, 0o644).catch(() => {});
    const reason = oneLine(`the new stack couldn't be installed: ${(e as Error).message}`);
    await files.write(recordPath, `${JSON.stringify({ ...record, state: "reverted", finishedAt: d.now(), reason }, null, 2)}\n`, 0o644);
    throw new SwitchRefused(reason);
  }
  const trial: SwitchRecord = { ...record, state: "trial", trialUntil: d.now() + TRIAL_MS };
  await files.write(recordPath, `${JSON.stringify(trial, null, 2)}\n`, 0o644);
  d.log?.(`[arch-v2-switch] the switch is set for ${order.target}; the next start moves the box`);
  return { state: "trial", target: order.target };
}

/** Root's half of ending a trial: keep the switch, or put the switch file back as it was. */
export async function settleSwitchAsRoot(d: RootSwitchDeps): Promise<{ state: SwitchState }> {
  const files = d.files;
  const recordPath = d.recordPath ?? SWITCH_RECORD;
  const v = parseJson(await files.read(d.verdictPath ?? SWITCH_VERDICT_FILE)) as { nonce?: unknown; verdict?: unknown; reason?: unknown } | null;
  const rec = parseSwitchRecord(await files.read(recordPath));
  if (!rec || typeof v?.nonce !== "string" || rec.nonce !== v.nonce) throw new SwitchRefused("no switch is on trial");
  if (rec.state === "done" || rec.state === "reverted") {
    if ((v.verdict === "commit" && rec.state === "done") || (v.verdict === "revert" && rec.state === "reverted")) return { state: rec.state };
    throw new SwitchRefused("this switch is already settled");
  }
  if (v.verdict === "commit") {
    if (rec.state !== "trial") throw new SwitchRefused("the switch hasn't been set yet");
    await files.write(recordPath, `${JSON.stringify({ ...rec, state: "done", finishedAt: d.now() }, null, 2)}\n`, 0o644);
    return { state: "done" };
  }
  if (v.verdict !== "revert") throw new SwitchRefused("unknown verdict");
  if (rec.state === "trial" && rec.trialUntil !== undefined && d.now() > rec.trialUntil) {
    throw new SwitchRefused("the switch's trial has ended; going back needs the owner's order");
  }
  const configPath = d.configPath ?? ARCH_V2_CONFIG;
  if (rec.previousText === null) await files.remove(configPath);
  else await files.write(configPath, rec.previousText, 0o644);
  const reason = typeof v.reason === "string" ? oneLine(v.reason) : "";
  await files.write(recordPath, `${JSON.stringify({ ...rec, state: "reverted", finishedAt: d.now(), ...(reason ? { reason } : {}) }, null, 2)}\n`, 0o644);
  d.log?.(`[arch-v2-switch] switched back: ${reason}`);
  return { state: "reverted" };
}

// ── daemon ────────────────────────────────────────────────────────────────

export interface SwitchBlocker {
  code: "already" | "in-progress" | "update-in-progress" | "no-rust-binaries" | "docker-down" | "no-podman-room" | "no-docker";
  error: string;
}

export interface SwitchPlan {
  from: BoxStackTarget;
  target: BoxStackTarget;
  steps: string[];
  images: number;
  volumes: number;
  needBytes: number;
  freeBytes: number;
  blockers: SwitchBlocker[];
}

export interface SwitchDaemonDeps {
  files: SwitchFiles;
  cmd: Required<CommandRunner>;
  /** The switch file in force now (engine/engine.ts loadArchV2Config). */
  config: () => ArchV2Config;
  /** The engine this start chose. */
  engine: () => EngineKind;
  repoPath: string;
  /** Free and total bytes where Podman keeps its images (/var/lib). */
  disk?: () => Promise<{ freeBytes: number; totalBytes: number }>;
  /** The flagship-* app containers that run now (their names). */
  runningApps: () => Promise<string[]>;
  root: { apply(): Promise<unknown>; settle(): Promise<unknown> };
  note?: (kind: string, detail: string, ok: boolean) => void;
  now?: () => number;
  log?: (m: string) => void;
  recordPath?: string;
  orderPath?: string;
  verdictPath?: string;
  trialPath?: string;
  updatePendingPath?: string;
}

interface TrialFile {
  nonce: string;
  boots: number;
  appsBefore: string[];
}

export async function diskAt(path: string): Promise<{ freeBytes: number; totalBytes: number }> {
  const s = await statfs(path);
  return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
}

export class ArchV2Switcher {
  constructor(private readonly d: SwitchDaemonDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  async record(): Promise<SwitchRecord | null> {
    return parseSwitchRecord(await this.d.files.read(this.d.recordPath ?? SWITCH_RECORD));
  }

  private async trial(): Promise<TrialFile | null> {
    const t = parseJson(await this.d.files.read(this.d.trialPath ?? SWITCH_TRIAL_FILE)) as Partial<TrialFile> | null;
    if (!t || typeof t.nonce !== "string" || typeof t.boots !== "number" || !Array.isArray(t.appsBefore)) return null;
    return { nonce: t.nonce, boots: t.boots, appsBefore: t.appsBefore.filter((a): a is string => typeof a === "string") };
  }

  private async writeTrial(t: TrialFile): Promise<void> {
    await this.d.files.write(this.d.trialPath ?? SWITCH_TRIAL_FILE, `${JSON.stringify(t)}\n`, 0o600);
  }

  private async dockerImages(): Promise<{ count: number; bytes: number; largest: number }> {
    const ids = [...new Set((await this.d.cmd.capture("docker", ["image", "ls", "-q"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0) return { count: 0, bytes: 0, largest: 0 };
    const sizes = (await this.d.cmd.capture("docker", ["image", "inspect", "--format", "{{.Size}}", ...ids])).stdout
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isSafeInteger(n) && n >= 0);
    return { count: ids.length, bytes: sizes.reduce((a, b) => a + b, 0), largest: Math.max(0, ...sizes) };
  }

  /** What a switch to `target` would do now, and why it can't start yet (empty blockers: it can). */
  async plan(target: BoxStackTarget): Promise<SwitchPlan> {
    const from = stackOf(this.d.config());
    const blockers: SwitchBlocker[] = [];
    const plan: SwitchPlan = { from, target, steps: [], images: 0, volumes: 0, needBytes: 0, freeBytes: 0, blockers };
    if (from === target && (target === "classic" ? this.d.engine() === "docker" : this.d.engine() === "podman")) {
      blockers.push({ code: "already", error: target === "arch-v2" ? "This server already runs the new stack." : "This server already runs the classic stack." });
    }
    const rec = await this.record();
    if (rec && (rec.state === "installing" || rec.state === "trial")) {
      blockers.push({ code: "in-progress", error: "A switch is already under way on this server. Wait until it has finished." });
    }
    if (this.d.files.exists(this.d.updatePendingPath ?? "/var/flagship/update-pending.json")) {
      blockers.push({ code: "update-in-progress", error: "This server is finishing an update. Try again once it is done." });
    }
    if (target === "classic") {
      if (!this.d.files.exists("/usr/bin/docker")) blockers.push({ code: "no-docker", error: "This server has no Docker to go back to." });
      plan.steps = ["Turn Docker back on, with the apps' images and data from before the move", "Run keyd and privd from the release's TS code again", "Restart, then check every app comes back"];
      return plan;
    }
    if (!this.d.files.exists(`${this.d.repoPath}/${RUST_PINS_IN_RELEASE}`)) {
      blockers.push({ code: "no-rust-binaries", error: "This server's release doesn't carry the new stack yet. Update the server first." });
    }
    let images = { count: 0, bytes: 0, largest: 0 };
    try {
      images = await this.dockerImages();
      plan.volumes = (await this.d.cmd.capture("docker", ["volume", "ls", "-q"])).stdout.split("\n").filter((s) => s.trim()).length;
    } catch {
      blockers.push({ code: "docker-down", error: "Docker isn't answering on this server, so its apps can't be moved yet." });
    }
    plan.images = images.count;
    plan.needBytes = images.bytes + images.largest + 2 * GiB;
    if (this.d.disk) {
      const disk = await this.d.disk().catch(() => null);
      plan.freeBytes = disk?.freeBytes ?? 0;
      if (plan.freeBytes < plan.needBytes) {
        const gb = (n: number) => (Math.ceil((n / GiB) * 10) / 10).toFixed(1);
        blockers.push({ code: "no-podman-room", error: `Moving the apps needs about ${gb(plan.needBytes)} GB free on this server; it has ${gb(plan.freeBytes)} GB.` });
      }
    }
    plan.steps = [
      "Install Podman and its tools from Debian",
      `Move ${plan.images} app image(s) and ${plan.volumes} volume(s) from Docker to Podman (Docker's copy is kept)`,
      "Run keyd, the broker and core from the release's Rust programs",
      "Restart, then check every app comes back; go back to Docker if not",
    ];
    return plan;
  }

  /** Start a switch the HTTP layer has already checked: the plan must have no blockers. */
  async start(order: ArchV2SwitchOrder, signatureHex: string): Promise<{ ok: true; plan: SwitchPlan } | { ok: false; plan: SwitchPlan }> {
    const plan = await this.plan(order.target);
    if (plan.blockers.length > 0) return { ok: false, plan };
    const appsBefore = (await this.d.runningApps()).sort();
    await this.writeTrial({ nonce: order.nonce, boots: 0, appsBefore });
    await this.d.files.write(this.d.orderPath ?? SWITCH_ORDER_FILE, `${JSON.stringify({ order, signatureHex })}\n`, 0o600);
    try {
      await this.d.root.apply();
    } catch (e) {
      await this.d.files.remove(this.d.trialPath ?? SWITCH_TRIAL_FILE).catch(() => {});
      throw e;
    }
    this.d.note?.("server.stack.switch-started", order.target === "arch-v2" ? "Moving this server to the new stack." : "Moving this server back to the classic stack.", true);
    return { ok: true, plan };
  }

  private async revert(nonce: string, reason: string): Promise<boolean> {
    await this.d.files.write(this.d.verdictPath ?? SWITCH_VERDICT_FILE, `${JSON.stringify({ nonce, verdict: "revert", reason })}\n`, 0o600);
    try {
      await this.d.root.settle();
    } catch (e) {
      this.d.log?.(`[arch-v2-switch] could not switch back: ${(e as Error).message}`);
      return false;
    }
    await this.d.files.remove(this.d.trialPath ?? SWITCH_TRIAL_FILE).catch(() => {});
    this.d.note?.("server.stack.switch-reverted", `The switch was undone: ${reason}`, false);
    return true;
  }

  /**
   * At the start of every boot, before the engine is chosen: finishes an install a restart cut
   * short, and puts back a switch that hasn't reached health in three starts. True when the
   * switch file changed (the caller reads it again).
   */
  async beforeEngine(): Promise<boolean> {
    let rec = await this.record();
    let resumed = false;
    if (rec?.state === "installing") {
      // A restart cut the install short: the same order picks it up where it stopped.
      try {
        await this.d.root.apply();
      } catch (e) {
        this.d.log?.(`[arch-v2-switch] the switch was not finished: ${(e as Error).message}`);
        this.d.note?.("server.stack.switch-reverted", `The switch was undone: ${(e as Error).message}`, false);
        await this.d.files.remove(this.d.trialPath ?? SWITCH_TRIAL_FILE).catch(() => {});
        return true;
      }
      rec = await this.record();
      resumed = true;
    }
    if (!rec || rec.state !== "trial") return resumed;
    const t = (await this.trial()) ?? { nonce: rec.nonce, boots: 0, appsBefore: [] };
    if (t.nonce !== rec.nonce) return resumed;
    const boots = t.boots + 1;
    await this.writeTrial({ ...t, boots });
    if (boots <= TRIAL_MAX_BOOTS) return resumed;
    return this.revert(rec.nonce, `the server didn't come up healthy in ${TRIAL_MAX_BOOTS} starts on the new stack`);
  }

  /** Once the engine is chosen: a move to Podman that failed is undone at once. */
  async afterEngine(engine: EngineKind, engineNote?: string): Promise<boolean> {
    const rec = await this.record();
    if (!rec || rec.state !== "trial") return false;
    const want: EngineKind = rec.target === "arch-v2" ? "podman" : "docker";
    if (engine === want) return false;
    return this.revert(rec.nonce, engineNote ?? `the apps didn't move to ${want === "podman" ? "Podman" : "Docker"}`);
  }

  /**
   * After the boot: keep the switch once the box is healthy and every app that ran before the
   * order runs again; otherwise put it back and restart. Returns what it did.
   */
  async settle(o: { awaitHealthy: () => Promise<boolean>; requestRestart: () => void; pollMs?: number; appsBackMs?: number }): Promise<"none" | "kept" | "reverted" | "unsettled"> {
    const rec = await this.record();
    if (!rec || rec.state !== "trial") return "none";
    const t = await this.trial();
    const missing = async (): Promise<string[]> => {
      const running = new Set(await this.d.runningApps().catch(() => [] as string[]));
      return (t?.nonce === rec.nonce ? t.appsBefore : []).filter((a) => !running.has(a));
    };
    let reason = "";
    if (!(await o.awaitHealthy().catch(() => false))) reason = "the server didn't report healthy on the new stack";
    else {
      const deadline = this.now() + (o.appsBackMs ?? APPS_BACK_MS);
      let left = await missing();
      while (left.length > 0 && this.now() < deadline) {
        await new Promise((r) => setTimeout(r, o.pollMs ?? 30_000));
        left = await missing();
      }
      if (left.length > 0) reason = `${left.length} app(s) didn't come back: ${left.slice(0, 5).join(", ")}`;
    }
    if (!reason) {
      await this.d.files.write(this.d.verdictPath ?? SWITCH_VERDICT_FILE, `${JSON.stringify({ nonce: rec.nonce, verdict: "commit" })}\n`, 0o600);
      try {
        await this.d.root.settle();
      } catch (e) {
        this.d.log?.(`[arch-v2-switch] could not keep the switch: ${(e as Error).message}`);
        return "unsettled";
      }
      await this.d.files.remove(this.d.trialPath ?? SWITCH_TRIAL_FILE).catch(() => {});
      this.d.note?.("server.stack.switched", rec.target === "arch-v2" ? "This server now runs the new stack." : "This server runs the classic stack again.", true);
      return "kept";
    }
    if (!(await this.revert(rec.nonce, reason))) return "unsettled";
    o.requestRestart();
    return "reverted";
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────

const H = { "content-type": "application/json" };
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: H, body: JSON.stringify(body) });

export interface ArchV2SwitchHttpOptions {
  serverId: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username?: string;
  activeGrants?: () => readonly AdminGrantView[];
  /** The owner's own sessions, for the status and plan. */
  gate: { check(req: HttpRequest): HttpResponse | null };
  switcher: ArchV2Switcher;
  config: () => ArchV2Config;
  engine: () => EngineKind;
  requestRestart: () => void;
  now?: () => number;
}

/**
 * `GET /api/stack` (owner sessions): the stack, the switch's record and the plan for the other stack.
 * `POST /api/stack/switch` `{ order, signature, pqSignature?, dryRun? }`: the owner's signed
 * order; a dry run answers with the plan and changes nothing.
 */
export function buildArchV2SwitchHttp(o: ArchV2SwitchHttpOptions) {
  const now = o.now ?? (() => Date.now());
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path === "/api/stack") {
      if (req.method !== "GET") return json(405, { error: "method not allowed" });
      const denied = o.gate.check(req);
      if (denied) return denied;
      const config = o.config();
      const target: BoxStackTarget = stackOf(config) === "arch-v2" && o.engine() === "podman" ? "classic" : "arch-v2";
      return json(200, { stack: stackOf(config), engine: o.engine(), rust: config.rust, switch: await o.switcher.record(), plan: await o.switcher.plan(target) });
    }
    if (req.path !== "/api/stack/switch") return null;
    if (req.method !== "POST") return json(405, { error: "method not allowed" });
    let env: { order?: unknown; signature?: unknown; pqSignature?: unknown; dryRun?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8")) as typeof env;
    } catch {
      return json(400, { error: "invalid json" });
    }
    const order = parseArchV2SwitchOrder(env?.order);
    if (!order || typeof env.signature !== "string" || !HEX_SIG.test(env.signature)) return json(400, { error: "malformed switch order" });
    if (order.serverDomain.toLowerCase() !== o.serverId.toLowerCase()) return json(403, { error: "serverId mismatch" });
    if (Math.abs(now() - order.issuedAt) > ORDER_MAX_AGE_MS) return json(403, { error: "stale request" });
    const authorized = authorizeSensitiveOrder({
      order,
      signature: Uint8Array.from(Buffer.from(env.signature, "hex")),
      verify: verifyArchV2SwitchOrder,
      ownerIrkPub: o.ownerIrkPub,
      ...(o.adminRootPub ? { adminRootPub: o.adminRootPub } : {}),
      username: o.username ?? "",
      activeGrants: o.activeGrants?.() ?? [],
      hybrid: hybridOrderSignature(canonicalArchV2SwitchOrder(order), env.pqSignature),
    });
    if (!authorized) return json(403, { error: "invalid signature" });
    if (env.dryRun === true) return json(200, { ok: true, dryRun: true, plan: await o.switcher.plan(order.target) });
    let r: Awaited<ReturnType<ArchV2Switcher["start"]>>;
    try {
      r = await o.switcher.start(order, env.signature);
    } catch (e) {
      return json(409, { error: `The switch couldn't start: ${(e as Error).message}`, code: "switch-failed" });
    }
    if (!r.ok) return json(409, { error: r.plan.blockers[0]!.error, code: r.plan.blockers[0]!.code, plan: r.plan });
    setTimeout(() => o.requestRestart(), 500).unref?.();
    return json(202, { ok: true, state: "restarting", plan: r.plan });
  };
}
