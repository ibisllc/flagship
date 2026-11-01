#!/usr/bin/env -S npx tsx
/**
 * TLS frontends and the app proxy path (release plan G10, G4/R3).
 *
 *   npx tsx scripts/bench/ingress.ts [--quick] [--out results.jsonl] [--bin-dir <dir with flagship-ingress>]
 *        [--backend-ip 10.89.0.250] [--big-mib 64]
 *
 * A "daemon" child process (this file with --serve) holds everything that is not the frontend: a fake keyd (the
 * certificate key: hello / tls.active / tls.sign over keyd wire v1, as rust/crates/flagship-ingress/tests/ingress.rs
 * fakes it), the backend app (Node http), and the daemon's REAL app code paths:
 *   - the upstream socket served by tlsUpstream.ts listenForFrontend + appConnection.ts handleAppConnection with
 *     serviceProxy.ts prepareAppRequest (an open app, anonymous visitor) and an endpoint-table lease: what a box
 *     runs for app traffic when the proxy setting is `ts`;
 *   - the decision socket served by rustProxyDecide.ts listenForDecisions with the same options: what the Rust
 *     proxy asks when the setting is `rust`.
 * Implementations (each a separate frontend process; the client is this process):
 *   ts   = flagship-ingress (Rust TLS) -> upstream socket -> TS app proxy (decide + stream) -> backend
 *   go   = flagship-tlsd (Go TLS, installer/tls-frontend) -> the same TS app proxy -> backend
 *   rust = flagship-ingress with --proxy-decide: Rust TLS + Rust proxy, the TS decision over the decide socket,
 *          bytes straight to the backend. Its targets must be in a private app network, so the backend listens on
 *          --backend-ip (10.89.0.250) if the host has it, else on a private LAN address the host already has, else
 *          (Linux root) on 10.89.0.250 added to `lo` and removed after; otherwise the rust impl is skipped. All
 *          impls use the same backend address.
 * Scenarios: handshake (new TLS connection, then close), request (new connection + one small GET, as the TS
 * proxy serves one request per connection), bulk (one GET of --big-mib MiB). CPU seconds and peak RSS are the
 * frontend process's and the daemon child's (which also carries the fake keyd and the backend, the same for
 * every impl).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { connect as tlsConnect } from "node:tls";
import { flag, arg, nowMs, procUsage, Recorder, sleep } from "./common.js";

const REPO = resolve(import.meta.dirname, "../..");
const QUICK = flag("quick");
const SNI = "chess.home.alice.flagship.services";
const BACKEND_IP = arg("backend-ip") ?? "10.89.0.250";
const BIG = Number(arg("big-mib") ?? (QUICK ? 16 : 64)) * 1024 * 1024;

// ── the daemon child ────────────────────────────────────────────────────────

async function serve(dir: string): Promise<void> {
  const { listenForFrontend } = await import("../../packages/server-daemon/src/tlsUpstream.js");
  const { AppConnectionLimiter, handleAppConnection } = await import("../../packages/server-daemon/src/appConnection.js");
  const { listenForDecisions } = await import("../../packages/server-daemon/src/rustProxyDecide.js");
  const { prepareAppRequest } = await import("../../packages/server-daemon/src/serviceProxy.js");
  const { endpoints } = await import("../../packages/server-daemon/src/endpoints.js");
  const cfg = JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")) as { backendIp: string; big: number };

  // keyd: wire v1 (4-byte BE length + JSON), hello first, the leaf key signs what tls.sign describes.
  const leafKey = createPrivateKey(readFileSync(join(dir, "leaf.key")));
  const chainPem = readFileSync(join(dir, "leaf.pem"), "utf8");
  const signedInput = (a: Record<string, string>): Buffer => {
    const h = (k: string) => Buffer.from(a[k] ?? "", "hex");
    if (a.tls === "1.3") return Buffer.concat([Buffer.alloc(64, 0x20), Buffer.from("TLS 1.3, server CertificateVerify\0"), h("transcriptHash")]);
    return Buffer.concat([h("clientRandom"), h("serverRandom"), h("params")]);
  };
  const keyd = createNetServer((c) => {
    let buf = Buffer.alloc(0);
    c.on("error", () => c.destroy());
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const req = JSON.parse(buf.subarray(4, 4 + n).toString()) as { id: number; op: string; args: Record<string, string> };
        buf = buf.subarray(4 + n);
        let res: unknown;
        if (req.op === "hello") res = { id: req.id, ok: true, result: { v: 1, publicKey: "00", hasSwk: true, hasCgk: true } };
        else if (req.op === "tls.active") res = { id: req.id, ok: true, result: { active: { handle: "h1", chainPem, notAfter: 0, names: [SNI, "*.home.alice.flagship.services"], legacy: false } } };
        else if (req.op === "tls.sign" && req.args.handle === "h1") res = { id: req.id, ok: true, result: { sig: cryptoSign("sha256", signedInput(req.args), leafKey).toString("hex") } };
        else res = { id: req.id, ok: false, code: "unknown-op", message: "no" };
        const out = Buffer.from(JSON.stringify(res));
        const head = Buffer.alloc(4);
        head.writeUInt32BE(out.length);
        c.write(Buffer.concat([head, out]));
      }
    });
  });
  await new Promise<void>((r) => keyd.listen(join(dir, "k.sock"), () => r()));

  // The backend app: a small answer and a large streamed one, both with a Content-Length.
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const backend = createHttpServer((req, res) => {
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(cfg.big) });
      let left = cfg.big;
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, chunk.length);
          left -= n;
          if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    } else {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "1024" });
      res.end(chunk.subarray(0, 1024));
    }
  });
  await new Promise<void>((r) => backend.listen(0, cfg.backendIp, () => r()));
  const port = (backend.address() as { port: number }).port;

  const key = { serviceId: "alice-chess", env: "live" as const, component: "main", role: "http" as const };
  endpoints.publish(key, { host: cfg.backendIp, port, generation: 1, incarnation: "bench" });
  const app = {
    creator: "alice", slug: "chess", serviceId: "alice-chess", urlLabel: "chess", containerPort: port, data: null, installedAt: 0,
    manifest: { name: "Chess", access: { enabled: true, default_role: "member", public_routes: [] } },
    membership: { stableIdFor: (k: Uint8Array) => Buffer.from(k).toString("hex") },
  } as never;
  const injector = { boxPublicKey: () => new Uint8Array(32), signAsBox: () => new Uint8Array(64) } as never;
  const options = {
    serviceId: "alice-chess",
    gate: async () => null,
    prepare: (req: never, info: { upgrade: boolean }) => prepareAppRequest(app, req, { injector, apiKeys: null, accessMode: () => "open" as const }, { ...info, routedHost: SNI }),
    upstream: { endpoint: key },
    limiter: new AppConnectionLimiter(4096),
  };
  await listenForFrontend(join(dir, "u.sock"), (s) => handleAppConnection(s, options as never));
  await listenForDecisions(join(dir, "d.sock"), { appForSni: () => app, options: () => options as never, enabled: () => true });
  writeFileSync(join(dir, "ready"), String(port));
  await new Promise(() => {});
}

// ── the client ──────────────────────────────────────────────────────────────

interface Front { impl: "ts" | "go" | "rust"; child: ChildProcess; port: number }

async function startFront(impl: Front["impl"], bin: string, dir: string, backendIp: string): Promise<Front> {
  const args = ["--listen", "127.0.0.1:0", "--keyd", join(dir, "k.sock"), "--upstream", join(dir, "u.sock"), "--max-conns", "8192"];
  if (impl === "rust") args.push("--proxy-decide", join(dir, "d.sock"), "--proxy-allow", `${backendIp}/32`);
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
  const port = await new Promise<number>((res, rej) => {
    let out = "";
    child.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /listening \S*:(\d+)/.exec(out);
      if (m) res(Number(m[1]));
    });
    child.once("exit", (c) => rej(new Error(`${impl} frontend exited ${c}: ${err}`)));
    setTimeout(() => rej(new Error(`${impl} frontend did not start: ${err}`)), 10_000);
  });
  return { impl, child, port };
}

let portRetries = 0;
/** A TLS connection; when the client runs out of ephemeral ports (macOS keeps closed ones in TIME_WAIT for 15 s
 *  and has ~16k), wait and retry: counted in `client_port_retries`, outside the latency of the try that worked. */
async function open(port: number, ca: Buffer): Promise<{ s: ReturnType<typeof tlsConnect>; ms: number }> {
  for (let i = 0; ; i++) {
    try {
      return await openOnce(port, ca);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL" || i > 400) throw e;
      portRetries++;
      await sleep(50);
    }
  }
}

function openOnce(port: number, ca: Buffer): Promise<{ s: ReturnType<typeof tlsConnect>; ms: number }> {
  const t = nowMs();
  return new Promise((res, rej) => {
    const s = tlsConnect({ host: "127.0.0.1", port, servername: SNI, ca, ALPNProtocols: ["http/1.1"], session: undefined });
    s.once("secureConnect", () => res({ s, ms: nowMs() - t }));
    s.once("error", rej);
  });
}

/** Send one GET and read the response until its Content-Length is in; resolves with the body bytes. */
function get(s: Socket, path: string): Promise<number> {
  return new Promise((res, rej) => {
    let head = Buffer.alloc(0);
    let need = -1;
    let got = 0;
    const done = (n: number) => { s.removeAllListeners("data"); s.destroy(); res(n); };
    s.on("data", (d: Buffer) => {
      if (need < 0) {
        head = Buffer.concat([head, d]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const text = head.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.[01] 200/.test(text)) return rej(new Error(`answer: ${text.split("\r\n")[0]}`));
        need = Number(/content-length:\s*(\d+)/i.exec(text)?.[1] ?? "0");
        got = head.length - end - 4;
      } else got += d.length;
      if (got >= need) done(got);
    });
    s.once("error", rej);
    s.once("close", () => (need >= 0 && got >= need ? res(got) : rej(new Error(`closed after ${got} of ${need}`))));
    s.write(`GET ${path} HTTP/1.1\r\nhost: ${SNI}\r\nconnection: close\r\n\r\n`);
  });
}

async function loops(clients: number, ms: number, one: () => Promise<number>): Promise<{ lat: number[]; perSec: number }> {
  const lat: number[] = [];
  const end = nowMs() + ms;
  const t0 = nowMs();
  await Promise.all(Array.from({ length: clients }, async () => {
    while (nowMs() < end) lat.push(await one());
  }));
  return { lat, perSec: lat.length / ((nowMs() - t0) / 1000) };
}

async function bench(rec: Recorder, f: Front, ca: Buffer, daemonPid: number): Promise<void> {
  const run = QUICK ? 1_000 : 12_000;
  const warm = QUICK ? 300 : 2_000;
  const handshake = async () => { const { s, ms } = await open(f.port, ca); s.destroy(); return ms; };
  const request = async () => { const t = nowMs(); const { s } = await open(f.port, ca); await get(s, "/small"); return nowMs() - t; };
  // Correctness first: a bench that measures refusals fails.
  if ((await (async () => { const { s } = await open(f.port, ca); return get(s, "/small"); })()) !== 1024) throw new Error(`${f.impl}: wrong body`);
  await loops(4, warm, request);
  const front0 = procUsage(f.child.pid!)!;
  const daemon0 = procUsage(daemonPid)!;
  const h1 = await loops(1, run, handshake);
  rec.latency(f.impl, "handshake_c1", h1.lat);
  const h16 = await loops(16, run, handshake);
  rec.latency(f.impl, "handshake_c16", h16.lat);
  rec.add(f.impl, "handshakes_per_s_c16", h16.perSec, "1/s", h16.lat.length);
  const r1 = await loops(1, run, request);
  rec.latency(f.impl, "request_c1", r1.lat);
  const r16 = await loops(16, run, request);
  rec.latency(f.impl, "request_c16", r16.lat);
  rec.add(f.impl, "requests_per_s_c16", r16.perSec, "1/s", r16.lat.length);
  const reps = QUICK ? 2 : 5;
  const mbps: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t = nowMs();
    const { s } = await open(f.port, ca);
    const n = await get(s, "/big");
    if (n !== BIG) throw new Error(`${f.impl}: bulk got ${n} of ${BIG}`);
    mbps.push(BIG / 1024 / 1024 / ((nowMs() - t) / 1000));
  }
  mbps.sort((a, b) => a - b);
  rec.add(f.impl, `bulk_${BIG >> 20}MiB_median`, mbps[Math.floor(mbps.length / 2)]!, "MiB/s", reps);
  const front1 = procUsage(f.child.pid!)!;
  const daemon1 = procUsage(daemonPid)!;
  rec.add(f.impl, "client_port_retries", portRetries, "count", 1);
  portRetries = 0;
  rec.add(f.impl, "frontend_cpu_s", front1.cpuSec - front0.cpuSec, "s", 1);
  rec.add(f.impl, "frontend_peak_rss", front1.peakKiB, "KiB", 1);
  rec.add(f.impl, "daemon_cpu_s", daemon1.cpuSec - daemon0.cpuSec, "s", 1);
  rec.add(f.impl, "daemon_rss", daemon1.rssKiB, "KiB", 1);
  // Idle: one second with nothing to do.
  const i0 = procUsage(f.child.pid!)!;
  await sleep(QUICK ? 1_000 : 5_000);
  const i1 = procUsage(f.child.pid!)!;
  rec.add(f.impl, "frontend_idle_cpu_s_per_s", (i1.cpuSec - i0.cpuSec) / (QUICK ? 1 : 5), "s/s", 1);
}

/** The backend address the Rust proxy may dial: on this host already, or added to `lo` (Linux root). */
function backendAddress(): { ip: string; added: boolean } {
  const probe = (ip: string) => {
    try {
      execFileSync(process.execPath, ["-e", `require("net").createServer().listen(0,${JSON.stringify(ip)},function(){this.close()}).on("error",()=>process.exit(1))`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (probe(BACKEND_IP)) return { ip: BACKEND_IP, added: false };
  // Any private IPv4 address this host already has (a LAN address) serves as well: it is local, and private.
  if (!arg("backend-ip")) {
    const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && priv.test(a.address) && probe(a.address)) return { ip: a.address, added: false };
    }
  }
  if (process.platform === "linux" && process.getuid?.() === 0) {
    try {
      execFileSync("ip", ["addr", "add", `${BACKEND_IP}/32`, "dev", "lo"], { stdio: "ignore" });
      if (probe(BACKEND_IP)) return { ip: BACKEND_IP, added: true };
    } catch { /* fall through */ }
  }
  return { ip: "127.0.0.1", added: false };
}

async function main(): Promise<void> {
  const rec = new Recorder("ingress");
  const dir = mkdtempSync("/tmp/fi-");
  let daemon: ChildProcess | null = null;
  const fronts: Front[] = [];
  const addr = backendAddress();
  try {
    // Certificates: a throwaway CA and a P-256 leaf for the app's names.
    const ossl = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    ossl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=bench ca");
    ossl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=bench");
    writeFileSync(join(dir, "ext"), `subjectAltName=DNS:${SNI},DNS:*.home.alice.flagship.services\n`);
    ossl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "ext");
    const ca = readFileSync(join(dir, "ca.pem"));
    writeFileSync(join(dir, "cfg.json"), JSON.stringify({ backendIp: addr.ip, big: BIG }));

    daemon = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--serve", dir], { stdio: ["ignore", "inherit", "inherit"], cwd: REPO });
    for (let i = 0; i < 400 && !existsSync(join(dir, "ready")); i++) await sleep(25);
    if (!existsSync(join(dir, "ready"))) throw new Error("the daemon child did not start");

    const binDir = resolve(arg("bin-dir") ?? join(REPO, "rust/target/release"));
    const ingress = join(binDir, "flagship-ingress");
    if (!existsSync(ingress)) execFileSync("cargo", ["build", "--release", "-p", "flagship-ingress"], { cwd: join(REPO, "rust"), stdio: "inherit", env: { ...process.env, CARGO_INCREMENTAL: "0" } });
    let tlsd: string | null = join(binDir, "flagship-tlsd");
    if (!existsSync(tlsd)) {
      tlsd = join(dir, "flagship-tlsd");
      try {
        execFileSync("go", ["build", "-mod=readonly", "-trimpath", "-o", tlsd, "."], { cwd: join(REPO, "installer/tls-frontend"), stdio: "ignore", env: { ...process.env, CGO_ENABLED: "0" } });
      } catch {
        console.log("go: skipped (no Go toolchain to build installer/tls-frontend)");
        tlsd = null;
      }
    }
    const plan: Array<[Front["impl"], string]> = [["ts", ingress]];
    if (tlsd) plan.push(["go", tlsd]);
    if (addr.ip !== "127.0.0.1") plan.push(["rust", ingress]);
    else console.log(`rust: skipped (the Rust proxy dials only private app networks and ${BACKEND_IP} is not on this host; run as root on Linux, or alias it)`);
    for (const [impl, bin] of plan) {
      const f = await startFront(impl, bin, dir, addr.ip);
      fronts.push(f);
      await bench(rec, f, ca, daemon.pid!);
      f.child.kill("SIGKILL");
    }
  } finally {
    for (const f of fronts) f.child.kill("SIGKILL");
    daemon?.kill("SIGKILL");
    if (addr.added) try { execFileSync("ip", ["addr", "del", `${BACKEND_IP}/32`, "dev", "lo"], { stdio: "ignore" }); } catch { /* best effort */ }
    rmSync(dir, { recursive: true, force: true });
  }
  rec.print();
}

if (flag("serve")) {
  const d = arg("serve")!;
  mkdirSync(d, { recursive: true });
  serve(d).catch((e) => { console.error(e); process.exit(1); });
} else {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
}
