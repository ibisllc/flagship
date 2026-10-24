import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installRustStack, parsePins, rustStackRegressions } from "../src/rustStack/install.js";
import {
  BROKER_UNIT_PATH,
  CORE_UNIT_PATH,
  KEYD_RUST_DROPIN_PATH,
  RUST_EXEC_PATH,
  RUST_SELECT_PATH,
  brokerServiceUnit,
  coreServiceUnit,
  keydRustDropIn,
  rustExecScript,
  rustSelectScript,
} from "../src/rustStack/units.js";
import { tsCheckpoint } from "../src/archV2Boot.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox(binaryBody = "#!/bin/bash\nexit 0\n", pinned?: string) {
  const root = mkdtempSync(join(tmpdir(), "rust-select-"));
  dirs.push(root);
  const release = join(root, "release");
  mkdirSync(join(release, "installer/rust"), { recursive: true });
  const bin = join(release, "installer/rust/flagship-keyd");
  writeFileSync(bin, binaryBody);
  chmodSync(bin, 0o755);
  const sha = createHash("sha256").update(binaryBody).digest("hex");
  writeFileSync(join(release, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-keyd": pinned ?? sha } }));
  const config = join(root, "arch-v2.json");
  writeFileSync(config, JSON.stringify({ version: 1, rust: "on", engine: "podman" }));
  const paths = { releasePath: release, configPath: config, engineActivePath: join(root, "engine-active"), stateDir: join(root, "state"), runDir: join(root, "run") };
  const script = join(root, "select.sh");
  writeFileSync(script, rustSelectScript(paths));
  const exec = join(root, "exec.sh");
  writeFileSync(exec, rustExecScript(release, paths.runDir));
  const select = (...args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8" });
  const stopped = (result: string) => spawnSync("bash", [script, "stopped", "keyd"], { encoding: "utf8", env: { ...process.env, SERVICE_RESULT: result } });
  const status = () => JSON.parse(readFileSync(join(paths.runDir, "keyd.status"), "utf8")) as Record<string, string>;
  return { root, paths, select, stopped, status, sha, config, exec, bin };
}

describe("flagship-rust-select", () => {
  it("chooses the pinned Rust binary and confirms it once its socket appears", () => {
    const s = sandbox();
    expect(s.select("select", "keyd").status).toBe(0);
    expect(s.status()).toMatchObject({ choice: "rust", reason: "pinned", sha256: s.sha, pinned: s.sha, switch: "on" });
    const sock = join(s.root, "keyd.sock");
    writeFileSync(sock, "");
    expect(s.select("confirm", "keyd", sock).status).toBe(0);
    expect(s.status().reason).toBe("running");
    expect(readFileSync(join(s.paths.stateDir, "keyd.good"), "utf8").trim()).toBe(s.sha);
  });

  it("falls back to TypeScript after three runs systemd reports as failed", () => {
    const s = sandbox();
    for (let i = 0; i < 3; i++) {
      expect(s.select("select", "keyd").stdout).toContain("rust");
      expect(s.stopped("exit-code").status).toBe(0);
    }
    expect(s.select("select", "keyd").stdout).toContain("ts (failed-to-start)");
    expect(s.status()).toMatchObject({ choice: "ts", reason: "failed-to-start" });
  });

  it("does not let an earlier binary's long good run excuse a new binary's crashes", () => {
    const s = sandbox();
    s.select("select", "keyd");
    const sock = join(s.root, "keyd.sock");
    writeFileSync(sock, "");
    s.select("confirm", "keyd", sock);
    writeFileSync(join(s.paths.stateDir, "keyd.confirmed"), "1\n");
    const body = "#!/bin/bash\nexit 1\n";
    writeFileSync(s.bin, body);
    writeFileSync(join(s.paths.releasePath, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-keyd": createHash("sha256").update(body).digest("hex") } }));
    for (let i = 0; i < 3; i++) {
      s.select("select", "keyd");
      s.stopped("exit-code");
    }
    expect(s.select("select", "keyd").stdout).toContain("ts (failed-to-start)");
  });

  it("counts nothing for a clean stop, so deliberate restarts never fall back", () => {
    const s = sandbox();
    for (let i = 0; i < 6; i++) {
      s.select("select", "keyd");
      s.stopped("success");
    }
    expect(s.select("select", "keyd").stdout).toContain("rust (pinned)");
  });

  it("refuses a binary that is not the one the release pinned", () => {
    const s = sandbox("#!/bin/bash\nexit 0\n", "0".repeat(64));
    s.select("select", "keyd");
    expect(s.status()).toMatchObject({ choice: "ts", reason: "hash-mismatch" });
  });

  it("stays on TypeScript while the switch is off, or without the binary", () => {
    const s = sandbox();
    writeFileSync(s.config, JSON.stringify({ version: 1, rust: "off" }));
    s.select("select", "keyd");
    expect(s.status()).toMatchObject({ choice: "ts", reason: "switched-off", switch: "off" });
    writeFileSync(s.config, JSON.stringify({ version: 1, rust: "on" }));
    rmSync(s.bin);
    s.select("select", "keyd");
    expect(s.status()).toMatchObject({ choice: "ts", reason: "no-binary" });
  });

  it("starts the count again for a new binary (a rollback to the last good release)", () => {
    const s = sandbox();
    for (let i = 0; i < 3; i++) {
      s.select("select", "keyd");
      s.stopped("signal");
    }
    s.select("select", "keyd");
    expect(s.status().reason).toBe("failed-to-start");
    const body = "#!/bin/bash\necho other\n";
    writeFileSync(s.bin, body);
    const sha = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(s.paths.releasePath, "installer/rust/PINS.json"), JSON.stringify({ binaries: { "flagship-keyd": sha } }));
    s.select("select", "keyd");
    expect(s.status()).toMatchObject({ choice: "rust", sha256: sha });
  });

  it("the launcher execs the choice, or the fallback argv", () => {
    const s = sandbox("#!/bin/bash\necho rust-keyd \"$@\"\n");
    s.select("select", "keyd");
    expect(execFileSync("bash", [s.exec, "keyd", "serve", "--", "echo", "ts-keyd"], { encoding: "utf8" }).trim()).toBe("rust-keyd serve");
    writeFileSync(join(s.paths.runDir, "keyd.choice"), "ts\n");
    expect(execFileSync("bash", [s.exec, "keyd", "serve", "--", "echo", "ts-keyd"], { encoding: "utf8" }).trim()).toBe("ts-keyd");
  });
});

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const runs: string[] = [];
  return {
    files,
    runs,
    deps: {
      run: async (cmd: string, args: string[]) => void runs.push(`${cmd} ${args.join(" ")}`),
      hasSystemd: () => true,
      fileExists: (p: string) => files.has(p),
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => void files.set(p, c),
      remove: async (p: string) => void files.delete(p),
      runDir: "/run/flagship-rust",
      stateDir: "/var/lib/flagship-rust",
    },
  };
}

const PIN = "a".repeat(64);
const pins = JSON.stringify({ binaries: { "flagship-keyd": PIN, "flagship-broker": PIN, "flagship-core": PIN } });

describe("installRustStack", () => {
  it("writes the units and the keyd drop-in, enables broker and core, restarts what chose under other pins", async () => {
    const w = fakeFs({ "/opt/flagship/installer/rust/PINS.json": pins, "/etc/systemd/system/flagship-keyd.service": "unit" });
    const r = await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: { version: 1, rust: "on", engine: "podman" } });
    expect(r.action).toBe("installed");
    expect(w.files.get(BROKER_UNIT_PATH)).toBe(brokerServiceUnit());
    expect(w.files.get(CORE_UNIT_PATH)).toBe(coreServiceUnit());
    expect(w.files.get(KEYD_RUST_DROPIN_PATH)).toBe(keydRustDropIn({ keydEntry: "/opt/flagship/packages/keyd/dist/main.js" }));
    expect(w.files.has(RUST_SELECT_PATH) && w.files.has(RUST_EXEC_PATH)).toBe(true);
    expect(w.runs).toContain("systemctl enable flagship-broker.service flagship-core.service");
    expect(w.runs).toContain("systemctl restart --no-block flagship-keyd.service");
  });

  it("does not restart a component whose choice was made under these pins (no restart loop on a bad binary)", async () => {
    const status = (c: string, choice: string, reason: string) => JSON.stringify({ component: c, choice, reason, sha256: "b".repeat(64), pinned: PIN, switch: "on", at: 1 });
    const w = fakeFs({
      "/opt/flagship/installer/rust/PINS.json": pins,
      "/etc/systemd/system/flagship-keyd.service": "unit",
      "/run/flagship-rust/keyd.status": status("keyd", "ts", "hash-mismatch"),
      "/run/flagship-rust/broker.status": status("broker", "ts", "failed-to-start"),
      "/run/flagship-rust/core.status": status("core", "rust", "running"),
    });
    const cfg = { version: 1 as const, rust: "on" as const, engine: "podman" as const };
    await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: cfg });
    w.runs.length = 0;
    const again = await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: cfg });
    expect(again.action).toBe("unchanged");
    expect(w.runs.filter((r) => r.includes("restart"))).toEqual([]);
  });

  it("stays on TypeScript for a release without pinned binaries", async () => {
    const w = fakeFs();
    const r = await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: { version: 1, rust: "on", engine: "docker" } });
    expect(r).toEqual({ action: "skipped", reason: "this release carries no pinned Rust binaries" });
    expect(w.files.size).toBe(0);
  });

  it("takes everything off when the switch is turned off", async () => {
    const w = fakeFs({ [KEYD_RUST_DROPIN_PATH]: "x", [BROKER_UNIT_PATH]: "x", [CORE_UNIT_PATH]: "x" });
    const r = await installRustStack({ ...w.deps, repoPath: "/opt/flagship", config: { version: 1, rust: "off", engine: "docker" } });
    expect(r.action).toBe("removed");
    expect(w.files.size).toBe(0);
    expect(w.runs[0]).toBe("systemctl disable --now flagship-core.service flagship-broker.service");
  });
});

describe("the update gate", () => {
  const cfg = { version: 1 as const, rust: "on" as const, engine: "podman" as const };
  it("fails a release whose Rust binary regressed to the fallback after running before", async () => {
    const files = new Map<string, string>([
      ["/run/flagship-rust/keyd.status", JSON.stringify({ component: "keyd", choice: "ts", reason: "failed-to-start", sha256: "c".repeat(64), pinned: "c".repeat(64), switch: "on", at: 1 })],
      ["/var/lib/flagship-rust/keyd.good", "d".repeat(64)],
      ["/run/flagship-rust/core.status", JSON.stringify({ component: "core", choice: "rust", reason: "not-ready", sha256: "e".repeat(64), pinned: "e".repeat(64), switch: "on", at: 1 })],
      ["/var/lib/flagship-rust/core.good", "e".repeat(64)],
    ]);
    const r = await rustStackRegressions({ config: cfg, read: async (p) => files.get(p) ?? null });
    expect(r).toHaveLength(2);
    expect(r[0]).toMatch(/keyd.*failed-to-start/);
  });
  it("passes a box that never ran Rust, or has the switch off", async () => {
    const files = new Map<string, string>([["/run/flagship-rust/keyd.status", JSON.stringify({ component: "keyd", choice: "ts", reason: "no-binary", sha256: "", pinned: "", switch: "on", at: 1 })]]);
    expect(await rustStackRegressions({ config: cfg, read: async (p) => files.get(p) ?? null })).toEqual([]);
    expect(await rustStackRegressions({ config: { ...cfg, rust: "off" }, read: async () => "x" })).toEqual([]);
  });
});

describe("pins and the core checkpoint", () => {
  it("accepts only 64-hex digests", () => {
    expect(parsePins(pins)?.binaries["flagship-core"]).toBe(PIN);
    expect(parsePins(JSON.stringify({ binaries: { "flagship-core": "short" } }))).toBeNull();
  });
  it("writes core's TsCheckpoint shape exactly", () => {
    const cp = JSON.parse(tsCheckpoint([{ serviceId: "alice--notes" } as never], 5_000));
    expect(cp).toEqual({ takenAt: 5, tsControllerPaused: false, workloads: [{ installation: "alice--notes", generation: 0, image: "", running: true }] });
  });
});
