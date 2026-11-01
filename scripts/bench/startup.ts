#!/usr/bin/env -S npx tsx
/**
 * Startup, idle CPU and RSS of the box's Rust services (release plan G10), each started the way its systemd unit
 * starts it but with every path in a private temp directory, and the TypeScript relay for comparison.
 *
 *   npx tsx scripts/bench/startup.ts [--quick] [--out results.jsonl] [--bin-dir rust/target/release] [--runs N]
 *
 * Per service: time from spawn to ready (its socket exists, or its "listening" line), cold (the first start after
 * the page cache is dropped: Linux as root only, otherwise reported as "first") and warm (median of the following
 * starts); then, with every service running together, each one's idle CPU over a window and its RSS, and the total.
 * Exec + dynamic loading + the service's own setup are all in "ready"; nothing here waits for a network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { arg, flag, nowMs, pct, procUsage, Recorder, sleep } from "./common.js";

const REPO = resolve(import.meta.dirname, "../..");
const BIN = resolve(arg("bin-dir") ?? join(REPO, "rust/target/release"));
const QUICK = flag("quick");
const RUNS = Number(arg("runs") ?? (QUICK ? 3 : 10));
const rec = new Recorder("startup");
// Unix socket paths are short on macOS.
const base = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "fsb-"));
const uid = String(process.getuid?.() ?? 0);

interface Service {
  name: string;
  bin: string;
  args: string[];
  env: (dir: string) => Record<string, string>;
  /** Ready when this file exists (relative to dir) or a stdout/stderr line matches. */
  ready: { file?: string; line?: RegExp };
  needs?: string[];
  /** Files the service expects before it starts (a throwaway key, never a real one). */
  prepare?: (dir: string) => void;
}

const SERVICES: Service[] = [
  {
    name: "keyd", bin: "flagship-keyd", args: ["serve"],
    env: (d) => ({ FLAGSHIP_KEYD_STATE: join(d, "keyd-state"), FLAGSHIP_KEYD_SOCKET: join(d, "keyd.sock"), FLAGSHIP_KEYD_ALLOW_UIDS: uid }),
    ready: { file: "keyd.sock" },
    prepare: (d) => {
      mkdirSync(join(d, "keyd-state"), { recursive: true, mode: 0o700 });
      const k = join(d, "keyd-state", "identity.key");
      if (!existsSync(k)) writeFileSync(k, randomBytes(32).toString("hex") + "\n", { mode: 0o400 });
    },
  },
  {
    name: "broker", bin: "flagship-broker", args: ["serve"],
    env: (d) => ({
      FLAGSHIP_BROKER_V1_SOCKET: join(d, "privd.sock"), FLAGSHIP_BROKER_SOCKET: join(d, "broker.sock"),
      FLAGSHIP_BROKER_STATE: join(d, "broker-state"), FLAGSHIP_BROKER_FILES_ROOT: join(d, "files"),
      FLAGSHIP_BROKER_ENGINE_FILE: join(d, "engine-active"), FLAGSHIP_BROKER_V1_UIDS: uid,
    }),
    ready: { file: "broker.sock" },
  },
  {
    name: "core", bin: "flagship-core", args: ["serve"],
    env: (d) => ({
      FLAGSHIP_CORE_DIR: join(d, "core"), FLAGSHIP_CORE_SOCKET: join(d, "core.sock"), FLAGSHIP_CORE_BROKER: join(d, "broker.sock"),
      FLAGSHIP_CORE_STATUS: join(d, "core-status.json"), FLAGSHIP_CORE_ALLOW_UIDS: uid,
    }),
    ready: { file: "core.sock" },
  },
  {
    name: "access", bin: "flagship-access", args: [],
    env: (d) => ({
      FLAGSHIP_ACCESS_SOCKET: join(d, "access.sock"), FLAGSHIP_ACCESS_STATE: join(d, "service-access.json"),
      FLAGSHIP_ACCESS_SESSIONS: join(d, "sessions.json"), FLAGSHIP_ACCESS_ALLOW_UIDS: uid,
    }),
    ready: { file: "access.sock" },
  },
  {
    name: "ingress", bin: "flagship-ingress", args: [],
    env: () => ({}),
    ready: { line: /^listening / },
    needs: ["keyd"],
  },
  {
    name: "relay", bin: "flagship-relay", args: [],
    env: () => ({
      PORT: "0", TUNNEL_TCP_PORT: "0", RELAY_ECHO_PORT: "0", HOST: "127.0.0.1", FLAGSHIP_SURFACE: "services",
      FLAGSHIP_SERVICES_APEX: "flagship.services", FLAGSHIP_COM_BASE_URL: "http://127.0.0.1:9", SERVICES_CONTROL_SECRET: "bench",
      FLAGSHIP_HUB_HOST: "flagship.services", FLAGSHIP_OUTBOUND_RELAY: "off", FLAGSHIP_RELAY_ID: "bench", FLAGSHIP_PHONE_ROUTE: "off",
    }),
    ready: { line: /^tunnel hub:/ },
  },
];

function argsFor(s: Service, dir: string): string[] {
  if (s.name === "ingress") {
    return ["--listen", "127.0.0.1:0", "--keyd", join(dir, "keyd.sock"), "--upstream", join(dir, "upstream.sock")];
  }
  return s.args;
}

async function start(s: Service, dir: string): Promise<{ child: ChildProcess; ms: number; logs: string[] }> {
  const env = { PATH: process.env.PATH ?? "", ...s.env(dir) };
  s.prepare?.(dir);
  const t0 = nowMs();
  const child = spawn(join(BIN, s.bin), argsFor(s, dir), { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  let lineSeen = false;
  const onData = (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line) continue;
      logs.push(line);
      if (s.ready.line?.test(line)) lineSeen = true;
    }
  };
  child.stdout!.on("data", onData);
  child.stderr!.on("data", onData);
  let exited: number | null = null;
  child.on("exit", (c) => (exited = c ?? -1));
  const deadline = t0 + 15_000;
  for (;;) {
    if (s.ready.file && existsSync(join(dir, s.ready.file))) break;
    if (lineSeen) break;
    if (exited !== null) throw new Error(`${s.name} exited ${exited}: ${logs.slice(-4).join(" | ")}`);
    if (nowMs() > deadline) throw new Error(`${s.name} not ready in 15 s: ${logs.slice(-4).join(" | ")}`);
    await new Promise((r) => setImmediate(r));
  }
  return { child, ms: nowMs() - t0, logs };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await Promise.race([gone, sleep(3000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function dropCaches(): boolean {
  if (process.platform !== "linux" || process.getuid?.() !== 0) return false;
  try {
    writeFileSync("/proc/sys/vm/drop_caches", "3\n");
    return true;
  } catch {
    return false;
  }
}

const available = SERVICES.filter((s) => existsSync(join(BIN, s.bin)));
for (const s of SERVICES) if (!available.includes(s)) console.log(`skipping ${s.name}: no ${join(BIN, s.bin)}`);

try {
  // Readiness, one service at a time (each with what it needs already running).
  for (const s of available) {
    const times: number[] = [];
    let cold = false;
    for (let i = 0; i < RUNS + 1; i++) {
      const dir = mkdtempSync(join(base, `${s.name}-`));
      const deps: ChildProcess[] = [];
      try {
        for (const n of s.needs ?? []) deps.push((await start(SERVICES.find((x) => x.name === n)!, dir)).child);
        if (i === 0) cold = dropCaches();
        const r = await start(s, dir);
        times.push(r.ms);
        await stop(r.child);
      } finally {
        for (const d of deps) await stop(d);
        rmSync(dir, { recursive: true, force: true });
      }
    }
    rec.add("rust", `${s.name}_ready_${cold ? "cold" : "first"}`, times[0]!, "ms", 1);
    rec.add("rust", `${s.name}_ready_warm_p50`, pct(times.slice(1), 50), "ms", times.length - 1);
  }

  // All together, idle.
  const dir = mkdtempSync(join(base, "all-"));
  const running: Array<{ s: Service; child: ChildProcess }> = [];
  for (const s of available) running.push({ s, child: (await start(s, dir)).child });
  await sleep(2000);
  const window = QUICK ? 5 : 60;
  const before = running.map((r) => procUsage(r.child.pid!));
  await sleep(window * 1000);
  let total = 0;
  running.forEach((r, i) => {
    const a = before[i];
    const b = procUsage(r.child.pid!);
    if (!a || !b) return;
    rec.add("rust", `${r.s.name}_idle_cpu_percent`, (100 * (b.cpuSec - a.cpuSec)) / window, "%", window);
    rec.add("rust", `${r.s.name}_idle_rss`, b.rssKiB / 1024, "MiB");
    total += b.rssKiB;
  });
  rec.add("rust", "all_services_idle_rss_total", total / 1024, "MiB", running.length);
  for (const r of running) await stop(r.child);
  rmSync(dir, { recursive: true, force: true });
} finally {
  rmSync(base, { recursive: true, force: true });
}
rec.print();
process.exit(0);
