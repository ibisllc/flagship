/**
 * Puts the Rust path on the box, or takes it off, to match the box's switch
 * (`/var/lib/flagship/arch-v2.json`, engine/engine.ts). Runs at every daemon start, like the
 * keyd and update-guard installers, and never throws: a box that cannot install the Rust path
 * keeps the TS path and says so.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PRIVD_DAEMON_DROPIN_PATH, PRIVD_HELPER, PRIVD_UNIT_PATH, daemonPrivdDropIn, privdSetupScript, privdUnit } from "@flagship/privd/unit";
import { writeFileDurable } from "../durableFile.js";
import type { ArchV2Config } from "../engine/engine.js";
import {
  BROKER_UNIT_PATH,
  CORE_UNIT_PATH,
  KEYD_RUST_DROPIN_PATH,
  RUST_COMPONENTS,
  RUST_EXEC_PATH,
  RUST_PINS_REL,
  RUST_RUN_DIR,
  RUST_SELECT_PATH,
  RUST_STATE_DIR,
  brokerServiceUnit,
  coreServiceUnit,
  coreSetupScript,
  keydRustDropIn,
  rustExecScript,
  rustSelectScript,
  type RustComponent,
} from "./units.js";

export interface RustComponentStatus {
  component: RustComponent;
  choice: "rust" | "ts";
  /** pinned / running / not-ready / switched-off / no-binary / unpinned / hash-mismatch / failed-to-start */
  reason: string;
  sha256: string;
  /** The SHA-256 the release's PINS.json named when this was chosen. */
  pinned: string;
  /** The box switch at that time. */
  switch: "on" | "off";
  at: number;
}

export interface RustStackDeps {
  repoPath: string;
  config: ArchV2Config;
  run: (cmd: string, args: string[]) => Promise<unknown>;
  hasSystemd?: () => boolean;
  fileExists?: (path: string) => boolean;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, content: string, mode: number) => Promise<void>;
  remove?: (path: string) => Promise<void>;
  runDir?: string;
  stateDir?: string;
  onLog?: (m: string) => void;
}

export type RustStackOutcome =
  | { action: "installed" | "unchanged" | "removed" | "restarted"; restarted: RustComponent[] }
  | { action: "skipped"; reason: string }
  | { action: "failed"; reason: string };

function io(d: RustStackDeps) {
  return {
    exists: d.fileExists ?? existsSync,
    read: d.read ?? (async (p: string) => await readFile(p, "utf8").catch(() => null)),
    write:
      d.write ??
      (async (p: string, c: string, mode: number) => {
        await mkdir(dirname(p), { recursive: true });
        await writeFileDurable(p, c, mode);
      }),
    remove: d.remove ?? (async (p: string) => await rm(p, { force: true })),
  };
}

export function parseRustStatus(text: string | null): RustComponentStatus | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as Partial<RustComponentStatus>;
    if ((v.component !== "keyd" && v.component !== "broker" && v.component !== "core") || (v.choice !== "rust" && v.choice !== "ts")) return null;
    return {
      component: v.component,
      choice: v.choice,
      reason: String(v.reason ?? ""),
      sha256: String(v.sha256 ?? ""),
      pinned: String(v.pinned ?? ""),
      switch: v.switch === "on" ? "on" : "off",
      at: Number(v.at ?? 0),
    };
  } catch {
    return null;
  }
}

export interface ReleasePins {
  binaries: Partial<Record<`flagship-${RustComponent}`, string>>;
}

export function parsePins(text: string | null): ReleasePins | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as ReleasePins;
    if (typeof v !== "object" || v === null || typeof v.binaries !== "object" || v.binaries === null) return null;
    for (const h of Object.values(v.binaries)) if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return null;
    return v;
  } catch {
    return null;
  }
}

export async function readRustStatuses(deps: Pick<RustStackDeps, "read" | "runDir">): Promise<Partial<Record<RustComponent, RustComponentStatus>>> {
  const read = deps.read ?? (async (p: string) => await readFile(p, "utf8").catch(() => null));
  const dir = deps.runDir ?? RUST_RUN_DIR;
  const out: Partial<Record<RustComponent, RustComponentStatus>> = {};
  for (const c of RUST_COMPONENTS) {
    const s = parseRustStatus(await read(join(dir, `${c}.status`)));
    if (s) out[c] = s;
  }
  return out;
}

/**
 * The update gate's view (updateHealthGate.ts): a component that ran Rust before (it has a
 * `.good` record) and now runs its fallback because this release's binary is missing, wrong
 * or will not start makes the boot unhealthy, so a release with a broken Rust binary rolls back
 * to the last good one instead of silently running on the fallback.
 */
export async function rustStackRegressions(deps: Pick<RustStackDeps, "read" | "runDir" | "stateDir" | "config">): Promise<string[]> {
  if (deps.config.rust !== "on") return [];
  const read = deps.read ?? (async (p: string) => await readFile(p, "utf8").catch(() => null));
  const statuses = await readRustStatuses(deps);
  const out: string[] = [];
  for (const c of RUST_COMPONENTS) {
    const s = statuses[c];
    if (!s) continue;
    const good = (await read(join(deps.stateDir ?? RUST_STATE_DIR, `${c}.good`)))?.trim();
    if (!good) continue;
    if (s.choice === "ts" && ["no-binary", "unpinned", "hash-mismatch", "failed-to-start"].includes(s.reason)) {
      out.push(`${c}: the Rust binary in this release is not usable (${s.reason}); it ran before`);
    }
    if (s.choice === "rust" && s.reason === "not-ready") out.push(`${c}: the Rust binary in this release does not come up`);
  }
  return out;
}

export async function installRustStack(deps: RustStackDeps): Promise<RustStackOutcome> {
  const log = deps.onLog ?? (() => {});
  const f = io(deps);
  const hasSystemd = deps.hasSystemd ?? (() => existsSync("/run/systemd/system"));
  if (!hasSystemd()) return { action: "skipped", reason: "no systemd" };
  const keydEntry = join(deps.repoPath, "packages/keyd/dist/main.js");
  try {
    if (deps.config.rust !== "on") {
      const had = (await f.read(KEYD_RUST_DROPIN_PATH)) !== null || f.exists(BROKER_UNIT_PATH) || f.exists(CORE_UNIT_PATH);
      if (!had) return { action: "unchanged", restarted: [] };
      // A daemon that gave up root with the broker as its helper gets flagship-privd back first, so
      // it is never without one. Run through that helper (the rust-stack step is the broker's own
      // child), the broker is stopped last: stopping it ends this step.
      const handBack = (await f.read(PRIVD_DAEMON_DROPIN_PATH))?.includes("flagship-broker.service") === true;
      if (handBack) {
        await f.write(PRIVD_UNIT_PATH, privdUnit(join(deps.repoPath, "packages/privd/dist/main.js")), 0o644);
        await f.write(PRIVD_DAEMON_DROPIN_PATH, daemonPrivdDropIn(PRIVD_HELPER), 0o644);
        await deps.run("systemctl", ["daemon-reload"]);
        await deps.run("systemctl", ["enable", "--now", "flagship-privd.service"]);
        log("[rust-path] the daemon's privileged helper is flagship-privd again");
      }
      await deps.run("systemctl", ["disable", ...(handBack ? [] : ["--now"]), "flagship-core.service", "flagship-broker.service"]).catch(() => {});
      for (const p of [KEYD_RUST_DROPIN_PATH, BROKER_UNIT_PATH, CORE_UNIT_PATH]) await f.remove(p);
      await deps.run("systemctl", ["daemon-reload"]);
      log("[rust-path] switched off: keyd back on TypeScript, broker and core removed");
      await deps.run("systemctl", ["restart", "--no-block", "flagship-keyd.service"]).catch(() => {});
      if (handBack) {
        await deps.run("systemctl", ["restart", "--no-block", "flagship-daemon.service"]).catch(() => {});
        await deps.run("systemctl", ["stop", "--no-block", "flagship-core.service", "flagship-broker.service"]).catch(() => {});
      }
      return { action: "removed", restarted: ["keyd"] };
    }
    if (!f.exists(join(deps.repoPath, RUST_PINS_REL))) {
      // A release without Rust binaries (a source checkout, an older artifact): stay on TS.
      return { action: "skipped", reason: "this release carries no pinned Rust binaries" };
    }
    await deps.run("sh", ["-c", coreSetupScript()]);
    // The daemon's account exists before the broker first selects: its TS fallback serves the v1
    // socket to that group, and the Rust units admit that uid.
    for (const line of privdSetupScript().trim().split("\n")) await deps.run("sh", ["-c", line]);
    const files: Array<[string, string, number]> = [
      [RUST_SELECT_PATH, rustSelectScript({ releasePath: deps.repoPath }), 0o755],
      [RUST_EXEC_PATH, rustExecScript(deps.repoPath), 0o755],
      [BROKER_UNIT_PATH, brokerServiceUnit({ privdEntry: join(deps.repoPath, "packages/privd/dist/main.js") }), 0o644],
      [CORE_UNIT_PATH, coreServiceUnit(), 0o644],
    ];
    const keydThere = f.exists("/etc/systemd/system/flagship-keyd.service");
    if (keydThere) files.push([KEYD_RUST_DROPIN_PATH, keydRustDropIn({ keydEntry }), 0o644]);
    const changed: string[] = [];
    for (const [path, content, mode] of files) {
      if ((await f.read(path)) !== content) {
        await f.write(path, content, mode);
        changed.push(path);
      }
    }
    if (changed.length > 0) {
      await deps.run("systemctl", ["daemon-reload"]);
      await deps.run("systemctl", ["enable", "flagship-broker.service", "flagship-core.service"]);
    }
    // A component running a binary that is not this release's (an update or a rollback swapped
    // the tree under it) is restarted so it selects again. keyd's restart restarts the daemon too.
    const pins = parsePins(await f.read(join(deps.repoPath, RUST_PINS_REL)));
    const statuses = await readRustStatuses({ read: f.read, runDir: deps.runDir ?? RUST_RUN_DIR });
    const restart: RustComponent[] = [];
    for (const c of RUST_COMPONENTS) {
      if (c === "keyd" && !keydThere) continue;
      const pinned = pins?.binaries[`flagship-${c}`] ?? "";
      const s = statuses[c];
      // Chosen under another release's pins or another switch position: choose again. A choice
      // made under these pins stays, whatever it was, so a bad binary cannot restart-loop the box.
      const stale = !s || s.pinned !== pinned || s.switch !== "on";
      const unitChanged = changed.some((p) => p.includes(`flagship-${c}`) || (c === "keyd" && p === KEYD_RUST_DROPIN_PATH));
      if (stale || unitChanged) restart.push(c);
    }
    // The broker goes last: run as root by the daemon's privileged helper (the rust-stack step),
    // this step is the broker's own child, and the broker's restart ends it.
    if (restart.includes("core")) await deps.run("systemctl", ["restart", "--no-block", "flagship-core.service"]);
    if (restart.includes("keyd")) {
      log("[rust-path] restarting keyd on this release's binary (the daemon restarts with it)");
      await deps.run("systemctl", ["restart", "--no-block", "flagship-keyd.service"]);
    }
    if (restart.includes("broker")) await deps.run("systemctl", ["restart", "--no-block", "flagship-broker.service"]);
    if (changed.length > 0) log(`[rust-path] installed (${changed.length} file(s) changed)`);
    return { action: changed.length > 0 ? "installed" : restart.length > 0 ? "restarted" : "unchanged", restarted: restart };
  } catch (e) {
    log(`[rust-path] could not install: ${(e as Error).message}`);
    return { action: "failed", reason: (e as Error).message };
  }
}
