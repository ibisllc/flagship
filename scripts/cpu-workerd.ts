// Measure the `.com` Worker's CPU inside real workerd (the Workers runtime),
// offline, with wrangler's local mode.
//
//   npx tsc -b && npx tsx scripts/cpu-workerd.ts [--only directory,pods] [--runs 60]
//
// How: copy a wrangler local-state directory whose D1 already carries every
// migration, seed the harness account into its sqlite file, start
// `wrangler dev --local` on it, send each scenario's signed requests over HTTP
// and read workerd's own CPU time (ps) before and after. workerd bills no CPU
// to the Worker for the local D1's sqlite (it runs in wrangler's Node process),
// so the figure is the isolate's JS plus the D1 binding's marshalling, which
// is what the Free plan's 10 ms counts. Its resolution is ps's 10 ms over the
// whole batch, so use --runs 50 or more.
//
// Needs `wrangler` on PATH (it is not a repo dependency). Not run in CI.
// Nothing here talks to Cloudflare.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT, SCENARIOS, buildWorld, READ_SECRET } from "./cpuHarness.js";

const args = process.argv.slice(2);
const value = (n: string) => (args.indexOf(n) >= 0 ? args[args.indexOf(n) + 1] : undefined);
const only = value("--only")?.split(",");
const runs = Number(value("--runs") ?? 60);
const warm = Number(value("--warmup") ?? 15);
const port = Number(value("--port") ?? 8799);
const stateSrc = value("--state") ?? process.env.WRANGLER_STATE_TEMPLATE;
const scratch = value("--scratch") ?? `${process.env.TMPDIR ?? "/tmp"}/flagship-cpu-workerd`;

if (!stateSrc || !existsSync(stateSrc)) {
  console.error(
    "Need a wrangler state dir with the migrations applied:\n" +
      "  (cd apps/com && wrangler d1 migrations apply flagship-state --local --persist-to <dir>)\n" +
      "then pass --state <dir>",
  );
  process.exit(2);
}

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const state = join(scratch, "state");
cpSync(stateSrc, state, { recursive: true });
const d1Dir = join(state, "v3/d1/miniflare-D1DatabaseObject");
const dbFile = readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
if (!dbFile) throw new Error("no D1 sqlite file in the state dir");

const scenarios = (only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS).filter(
  (s) => s.request || s.id === "stream-hold",
);

// Seed the account into wrangler's own D1 file with the same world the in-process harness uses.
const world = await buildWorld({ sqliteFile: join(d1Dir, dbFile) });

const comDir = new URL("../apps/com/", import.meta.url).pathname;
const wr: ChildProcess = spawn(
  "wrangler",
  [
    "dev", "--local", "--port", String(port), "--inspector-port", String(port + 1000), "--persist-to", state,
    "--var", `ACCOUNT_READ_TOKEN_SECRET:${READ_SECRET}`,
    "--var", `FLAGSHIP_CA_PRIV_HEX:${"ab".repeat(32)}`,
    "--var", "RATE_LIMIT_SCALE:50",
  ],
  { cwd: comDir, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } },
);
let log = "";
wr.stdout!.on("data", (d) => (log += d));
wr.stderr!.on("data", (d) => (log += d));
const stop = () => {
  try {
    wr.kill("SIGTERM");
  } catch {
    /* gone */
  }
  spawnSync("pkill", ["-f", `workerd.*${port}`]);
};
process.on("exit", stop);

for (let i = 0; i < 120 && !/Ready on/.test(log); i++) await new Promise((r) => setTimeout(r, 500));
if (!/Ready on/.test(log)) {
  console.error(log.slice(-2000));
  stop();
  process.exit(1);
}

function workerdCpuMs(): number {
  const pids = spawnSync("pgrep", ["-f", "workerd"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  let total = 0;
  for (const pid of pids) {
    const out = spawnSync("ps", ["-o", "cputime=", "-p", pid], { encoding: "utf8" }).stdout.trim();
    if (!out) continue;
    // [dd-]hh:mm:ss or mm:ss.cc
    const parts = out.split(/[:]/).map(parseFloat);
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    total += sec * 1000;
  }
  return total;
}

async function send(req: Request): Promise<number> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  headers.set("x-flagship-effective-host", "flagshipserver.com");
  headers.set("cf-connecting-ip", "203.0.113.9");
  const body = req.method === "GET" ? undefined : await req.text();
  const res = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { method: req.method, headers, body });
  await res.arrayBuffer();
  return res.status;
}

console.log(
  `workerd under ${spawnSync("wrangler", ["--version"], { encoding: "utf8" }).stdout.trim().split("\n").pop()} local; ${runs} runs each, ${warm} warm-up`,
);
console.log(`${"scenario".padEnd(20)} ${"ms/request".padEnd(11)} status`);
for (const sc of scenarios) {
  if (sc.id === "stream-hold") {
    // A real 25 s hold: a few runs, each with a fresh cursor.
    const n = Math.min(runs, 4);
    const first = await fetch(`http://127.0.0.1:${port}/api/users/${ACCOUNT}/stream`, {
      headers: { authorization: `Bearer ${world.readToken}`, "x-flagship-effective-host": "flagshipserver.com" },
    });
    const { cursor } = (await first.json()) as { cursor: string };
    // The dev server burns some CPU on its own while a held request waits:
    // measure that idle rate and take it off.
    const idle0 = workerdCpuMs();
    await new Promise((r) => setTimeout(r, 8000));
    const idleRate = (workerdCpuMs() - idle0) / 8000;
    const before = workerdCpuMs();
    const wall0 = Date.now();
    let status = 0;
    for (let i = 0; i < n; i++) {
      const r = await fetch(`http://127.0.0.1:${port}/api/users/${ACCOUNT}/stream?cursor=${cursor}`, {
        headers: { authorization: `Bearer ${world.readToken}`, "x-flagship-effective-host": "flagshipserver.com" },
      });
      status = r.status;
      await r.arrayBuffer();
    }
    const busy = workerdCpuMs() - before - idleRate * (Date.now() - wall0);
    console.log(`${sc.id.padEnd(20)} ${(busy / n).toFixed(2).padEnd(11)} ${status}  (${n} real 25 s holds, idle ${(idleRate * 1000).toFixed(0)} ms/s taken off)`);
    continue;
  }
  let status = 0;
  for (let i = 0; i < warm; i++) status = await send(sc.request!(world));
  const reqs = Array.from({ length: runs }, () => sc.request!(world));
  const before = workerdCpuMs();
  for (const r of reqs) status = await send(r);
  const after = workerdCpuMs();
  console.log(`${sc.id.padEnd(20)} ${((after - before) / runs).toFixed(2).padEnd(11)} ${status}`);
}
world.close();
stop();
