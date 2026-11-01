#!/usr/bin/env -S npx tsx
/**
 * Access decisions, TypeScript vs Rust (release plan G10, R4), on the shared contract
 * packages/protocol/test-vectors/access-enforcement/decisions.json (the "box" fixture's cases).
 *
 *   npx tsx scripts/bench/access.ts [--quick] [--out results.jsonl] [--bin-dir <dir with flagship-access>]
 *
 * ts   = the daemon's in-process path, as packages/server-daemon/tests/accessEnforcementVectors.test.ts runs it:
 *        ServiceAccessStore (loaded once, as the daemon holds it) + buildAppSessionResolver + prepareAppRequest.
 * rust = the real flagship-access binary on its Unix socket, called with the daemon's own client
 *        (rustStack/brokerClient.ts brokerCall: one connection per decision, hello then decide), so the number
 *        includes the IPC and the server re-reading the state and sessions files on every decision, as it does
 *        in production. `rust persistent` reuses one connection to separate the decision from the connect cost.
 * Before timing, every case's answer is checked against the vector: a bench that measures errors fails.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Socket } from "node:net";
import type { Principal, PrincipalResolver } from "../../packages/server-daemon/src/accessPrincipals.js";
import { buildAppSessionResolver } from "../../packages/server-daemon/src/appMemberSession.js";
import type { ApiKeyAuth, ApiKeyAuthenticator } from "../../packages/server-daemon/src/appApiKeys.js";
import type { BoxSigner } from "../../packages/server-daemon/src/keyCustodian.js";
import { ServiceAccessStore } from "../../packages/server-daemon/src/serviceAccess.js";
import { prepareAppRequest } from "../../packages/server-daemon/src/serviceProxy.js";
import type { InstalledService } from "../../packages/server-daemon/src/servicePlatform.js";
import { brokerCall } from "../../packages/server-daemon/src/rustStack/brokerClient.js";
import { arg, flag, host, procUsage, Recorder } from "./common.js";

const REPO = resolve(import.meta.dirname, "../..");
const QUICK = flag("quick");
const BIN = join(resolve(arg("bin-dir") ?? join(REPO, "rust/target/release")), "flagship-access");
const DURATION_MS = QUICK ? 2_500 : 20_000;
const WARMUP_MS = QUICK ? 500 : 3_000;

interface Fixture {
  ownerAid: string;
  principals: Array<{ kind: "device"; pub: string; tier: "admin" | "member" } | { kind: "co-manager"; pub: string; shareId: string; level: "view" | "manage" }>;
  stateText: string | null;
}
interface Case {
  name: string;
  fixture: string;
  catchingUp?: string[];
  app: { serviceRef: string; host: string; publicRoutes: string[]; defaultRole: string };
  request: {
    method: string; path: string; upgrade: boolean; host?: string; headers: Record<string, string>;
    session: { serviceRef: string; aid: string; live: boolean } | null;
    apiKey: "none" | "invalid" | "scope" | "rate-limited" | { keyId: string; scope: "read" | "write" };
    externalFresh: boolean;
  };
  expect: { outcome: string; visitor?: string; role?: string | null; identity?: string | null; external?: boolean };
}
const V = JSON.parse(readFileSync(join(REPO, "packages/protocol/test-vectors/access-enforcement/decisions.json"), "utf8")) as { fixtures: Record<string, Fixture>; cases: Case[] };
const FX = V.fixtures["box"]!;
const CASES = V.cases.filter((c) => c.fixture === "box");

const rec = new Recorder("access");
/** Latencies here are µs: p50/p95/p99 recorded in µs. */
const recordLat = (impl: string, metric: string, us: number[]) => {
  const sorted = [...us].sort((a, b) => a - b);
  for (const p of [50, 95, 99]) rec.add(impl, `${metric}_p${p}`, sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!, "us", sorted.length);
};

/** Run `one` in `clients` concurrent loops for the duration after a warm-up; latencies in µs. */
async function load(one: (i: number) => Promise<void>, clients: number): Promise<{ lat: number[]; perSec: number }> {
  const run = async (ms: number, keep: boolean) => {
    const lat: number[] = [];
    const end = performance.now() + ms;
    let i = 0;
    await Promise.all(Array.from({ length: clients }, async (_, c) => {
      let k = c;
      while (performance.now() < end) {
        const t = performance.now();
        await one(k++ % CASES.length);
        if (keep) lat.push((performance.now() - t) * 1000);
        i++;
      }
    }));
    return { lat, count: i };
  };
  await run(WARMUP_MS, false);
  const t0 = performance.now();
  const r = await run(DURATION_MS, true);
  return { lat: r.lat, perSec: r.count / ((performance.now() - t0) / 1000) };
}

// ── TypeScript ──────────────────────────────────────────────────────────────
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const principals: PrincipalResolver = (() => {
  const all: Principal[] = FX.principals.map((p) =>
    p.kind === "device" ? { kind: "device", pub: p.pub, deviceId: null, tier: p.tier, legacy: false } : { kind: "co-manager", pub: p.pub, shareId: p.shareId, label: "", level: p.level });
  return {
    classify: (pub) => all.find((p) => p.pub === pub.toLowerCase()) ?? null,
    ensure: async () => {},
    devices: () => all.filter((p): p is Extract<Principal, { kind: "device" }> => p.kind === "device"),
    coManagers: () => all.filter((p): p is Extract<Principal, { kind: "co-manager" }> => p.kind === "co-manager"),
    ownerAidHex: () => FX.ownerAid,
  };
})();
const signer = { boxPublicKey: () => new Uint8Array(32), signAsBox: () => new Uint8Array(64) } as unknown as BoxSigner;

type Verdict = { outcome: string; visitor?: string; role?: string | null; identity?: string | null };

async function tsDecide(store: ServiceAccessStore, c: Case): Promise<Verdict> {
  for (const ref of c.catchingUp ?? []) store.setCatchingUp(ref, true);
  try {
    const app = {
      serviceId: c.app.serviceRef, urlLabel: c.app.host.split(".")[0]!,
      manifest: { name: "App", access: { enabled: true, default_role: c.app.defaultRole, public_routes: c.app.publicRoutes } },
      membership: { stableIdFor: (k: Uint8Array) => hex(k) },
    } as unknown as InstalledService;
    const r = c.request;
    const token = r.session ? "tok" : null;
    const sessions = { lookup: (t: string) => (t === token && r.session?.live ? { serviceRef: r.session.serviceRef, aid: r.session.aid } : null) };
    const apiKeys: ApiKeyAuthenticator = {
      authenticate: (): ApiKeyAuth => (r.apiKey === "none" ? { kind: "none" } : r.apiKey === "invalid" ? { kind: "invalid" } : r.apiKey === "scope" ? { kind: "scope" }
        : r.apiKey === "rate-limited" ? { kind: "rate-limited", retryAfterSec: 1 } : { kind: "ok", keyId: r.apiKey.keyId, scope: r.apiKey.scope }) as ApiKeyAuth,
    };
    const headers: Record<string, string> = { host: r.host ?? c.app.host, ...r.headers };
    if (token) headers.cookie = `Flagship-App-Session=${token}`;
    const p = await prepareAppRequest(app, { method: r.method, path: r.path, headers, body: Buffer.alloc(0) } as never, {
      injector: signer, apiKeys, resolveSession: buildAppSessionResolver({ sessions, access: store }),
      externalFresh: () => r.externalFresh, accessMode: (id) => (store.mode(id) === "open" ? "open" : "members-only"),
    }, { upgrade: r.upgrade, routedHost: c.app.host });
    if (p.kind === "respond") {
      const s = p.response.status;
      return { outcome: s === 401 ? "api-invalid" : s === 403 && r.apiKey === "scope" ? "api-scope" : s === 429 ? "api-rate-limited" : "deny" };
    }
    return { outcome: "forward", visitor: p.headers["x-flagship-visitor"]!, role: p.headers["x-flagship-role"] ?? null, identity: p.headers["x-flagship-user"] ?? null };
  } finally {
    for (const ref of c.catchingUp ?? []) store.setCatchingUp(ref, false);
  }
}

// ── Rust ────────────────────────────────────────────────────────────────────
const rustArgs = (c: Case, i: number) => {
  const r = c.request;
  return {
    serviceRef: c.app.serviceRef, routedHost: c.app.host, publicRoutes: c.app.publicRoutes, defaultRole: c.app.defaultRole,
    method: r.method, path: r.path, upgrade: r.upgrade, headers: { host: r.host ?? c.app.host, ...r.headers },
    sessionToken: r.session ? `t${i}` : null, apiKey: typeof r.apiKey === "object" ? { keyId: r.apiKey.keyId } : r.apiKey,
    externalFresh: r.externalFresh, principals: FX.principals, ownerAid: FX.ownerAid,
    catchingUp: (c.catchingUp ?? []).includes(c.app.serviceRef),
  };
};

function frame(v: unknown): Buffer {
  const b = Buffer.from(JSON.stringify(v));
  const h = Buffer.alloc(4);
  h.writeUInt32BE(b.length);
  return Buffer.concat([h, b]);
}

/** One long-lived connection: hello once, then decide frames in sequence. */
class Persistent {
  private s = new Socket();
  private buf = Buffer.alloc(0);
  private waiting: Array<(v: { ok: boolean; result?: unknown }) => void> = [];
  private id = 1;
  async open(path: string): Promise<void> {
    await new Promise<void>((r, j) => { this.s.once("error", j); this.s.connect(path, () => r()); });
    this.s.on("data", (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      while (this.buf.length >= 4 && this.buf.length >= 4 + this.buf.readUInt32BE(0)) {
        const n = this.buf.readUInt32BE(0);
        const v = JSON.parse(this.buf.subarray(4, 4 + n).toString());
        this.buf = this.buf.subarray(4 + n);
        this.waiting.shift()?.(v);
      }
    });
    await this.call("hello", { version: 1 });
  }
  call(op: string, args: unknown): Promise<{ ok: boolean; result?: unknown }> {
    return new Promise((r) => { this.waiting.push(r); this.s.write(frame({ id: ++this.id, op, args })); });
  }
  close(): void { this.s.destroy(); }
}

const same = (got: Verdict, c: Case) =>
  got.outcome === c.expect.outcome && (c.expect.outcome !== "forward" || (got.visitor === c.expect.visitor && (got.role ?? null) === (c.expect.role ?? null) && (got.identity ?? null) === (c.expect.identity ?? null)));

async function main(): Promise<void> {
  console.log(`access decisions: ${CASES.length} cases, ${DURATION_MS / 1000}s per run after ${WARMUP_MS / 1000}s warm-up, ${host()}`);
  const dir = mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "fa-"));
  let child: ChildProcess | null = null;
  try {
    // TS
    const statePath = join(dir, "service-access.json");
    if (FX.stateText !== null) writeFileSync(statePath, FX.stateText);
    const store = new ServiceAccessStore(statePath, { ownerAidHex: FX.ownerAid, principals });
    await store.load();
    const tsWrong = [];
    for (const c of CASES) if (!same(await tsDecide(store, c), c)) tsWrong.push(c.name);
    if (tsWrong.length) throw new Error(`ts disagrees with the vectors: ${tsWrong.slice(0, 3).join("; ")}`);
    for (const clients of [1, 8]) {
      const m0 = process.memoryUsage().rss;
      const r = await load((i) => tsDecide(store, CASES[i]!).then(() => undefined), clients);
      recordLat("ts", `decide_c${clients}`, r.lat);
      rec.add("ts", `decisions_per_s_c${clients}`, r.perSec, "1/s", r.lat.length);
      if (clients === 8) rec.add("ts", "bench_process_rss_delta", (process.memoryUsage().rss - m0) / 1024, "KiB", 1);
    }

    // Rust. flagship-access admits a caller only by SO_PEERCRED (server.rs peer_uid), which exists on Linux only: on
    // any other host it refuses every connection, so the Rust half runs on Linux (the box) only.
    if (process.platform !== "linux") {
      console.log("rust: skipped (flagship-access checks the caller with SO_PEERCRED, Linux only)");
      rec.print();
      return;
    }
    if (!existsSync(BIN)) {
      console.log(`building flagship-access (no ${BIN})`);
      execFileSync("cargo", ["build", "--release", "-p", "flagship-access"], { cwd: join(REPO, "rust"), stdio: "inherit", env: { ...process.env, CARGO_INCREMENTAL: "0" } });
    }
    const sock = join(dir, "a.sock");
    const sessions: Record<string, unknown> = {};
    CASES.forEach((c, i) => {
      const s = c.request.session;
      if (s) sessions[`t${i}`] = { serviceRef: s.serviceRef, aid: s.aid, expiresAt: s.live ? 9e15 : 1 };
    });
    writeFileSync(join(dir, "sessions.json"), JSON.stringify(sessions));
    child = spawn(BIN, ["serve"], {
      env: { PATH: process.env.PATH ?? "", FLAGSHIP_ACCESS_SOCKET: sock, FLAGSHIP_ACCESS_STATE: statePath, FLAGSHIP_ACCESS_SESSIONS: join(dir, "sessions.json"), FLAGSHIP_ACCESS_ALLOW_UIDS: String(process.getuid?.() ?? 0) },
      stdio: ["ignore", "inherit", "inherit"],
    });
    for (let i = 0; i < 200 && !existsSync(sock); i++) await new Promise((r) => setTimeout(r, 25));
    if (!existsSync(sock)) throw new Error("flagship-access did not open its socket");
    const idle0 = procUsage(child.pid!)!;
    const rustWrong = [];
    for (const [i, c] of CASES.entries()) if (!same((await brokerCall("decide", rustArgs(c, i), sock, 5_000)) as Verdict, c)) rustWrong.push(c.name);
    if (rustWrong.length) throw new Error(`rust disagrees with the vectors: ${rustWrong.slice(0, 3).join("; ")}`);
    const cpu0 = procUsage(child.pid!)!.cpuSec;
    for (const clients of [1, 8]) {
      const r = await load((i) => brokerCall("decide", rustArgs(CASES[i]!, i), sock, 5_000).then(() => undefined), clients);
      recordLat("rust", `decide_c${clients}`, r.lat);
      rec.add("rust", `decisions_per_s_c${clients}`, r.perSec, "1/s", r.lat.length);
    }
    const conns = await Promise.all(Array.from({ length: 8 }, async () => { const p = new Persistent(); await p.open(sock); return p; }));
    for (const clients of [1, 8]) {
      const r = await load((i) => conns[i % clients]!.call("decide", rustArgs(CASES[i]!, i)).then(() => undefined), clients);
      recordLat("rust", `persistent_decide_c${clients}`, r.lat);
      rec.add("rust", `persistent_decisions_per_s_c${clients}`, r.perSec, "1/s", r.lat.length);
    }
    for (const c of conns) c.close();
    const u = procUsage(child.pid!)!;
    rec.add("rust", "server_cpu_s_under_load", u.cpuSec - cpu0, "s", 1);
    rec.add("rust", "server_peak_rss", u.peakKiB, "KiB", 1);
    rec.add("rust", "server_rss_idle", idle0.rssKiB, "KiB", 1);
  } finally {
    child?.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
  rec.print();
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
