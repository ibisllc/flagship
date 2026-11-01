#!/usr/bin/env node
/**
 * What `--jitless` costs the box daemon (release plan G9). Runs the same workloads twice, in a child
 * Node with and without `--jitless`, and prints one JSON report. The workloads are the daemon's own
 * hot paths at small scale: loading its dependency graph, Ed25519 verification in JavaScript
 * (@noble/ed25519, what packages/protocol falls back to), Node's native Ed25519, JSON of a large
 * screen payload, Fastify request handling, and whether WebAssembly exists at all (`--jitless`
 * removes it, and the daemon's PDF text extraction, unpdf/pdf.js, carries WebAssembly decoders).
 *
 *   node scripts/jitless-bench.mjs [--node /path/to/node] [--rounds 3]
 *
 * Needs `npm ci` (node_modules) in the repository. Numbers are for the machine it runs on: record
 * the platform with them (docs/architecture-v2/execution-surfaces.md, "--jitless").
 */
import { spawnSync } from "node:child_process";
import { arch, cpus, platform } from "node:os";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);

async function workload() {
  const out = {};
  // An unhandled rejection from a dependency must not end the run: record it instead.
  process.on("unhandledRejection", (e) => { out.unhandled = String(e?.message ?? e).slice(0, 160); });
  const t0 = performance.now();
  out.importFailures = [];
  for (const m of ["reflect-metadata", "fastify", "pg", "@peculiar/x509", "acme-client", "ws", "tar-stream", "@noble/ed25519"]) {
    try { await import(m); } catch (e) { out.importFailures.push(`${m}: ${String(e?.message ?? e).slice(0, 100)}`); }
  }
  out.importMs = performance.now() - t0;
  try {
    const http = await import("node:http");
    const srv = http.createServer((_q, r) => r.end("ok"));
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const before = out.unhandled;
    const r = await Promise.race([
      fetch(`http://127.0.0.1:${srv.address().port}/`, { signal: ctl.signal }).then((x) => x.text()),
      new Promise((_, rej) => process.once("unhandledRejection", rej)),
    ]).finally(() => { clearTimeout(timer); srv.close(); });
    if (r !== "ok" || out.unhandled !== before) throw new Error(out.unhandled ?? "fetch returned " + r);
    out.fetchWorks = true;
  } catch (e) {
    out.fetchWorks = false;
    out.fetchError = String(e?.message ?? e).slice(0, 120);
  }
  try {
    const t1 = performance.now();
    await import("unpdf");
    out.unpdfImportMs = performance.now() - t1;
  } catch (e) {
    out.unpdfImportMs = null;
    out.unpdfError = String(e?.message ?? e).slice(0, 120);
  }
  out.webAssembly = typeof WebAssembly === "object";

  const ed = await import("@noble/ed25519");
  const { createHash, generateKeyPairSync, sign, verify } = await import("node:crypto");
  ed.etc.sha512Sync = (...m) => createHash("sha512").update(ed.etc.concatBytes(...m)).digest();
  const priv = ed.utils.randomPrivateKey();
  const pub = ed.getPublicKey(priv);
  const msg = new TextEncoder().encode("flagship/bench/v1|" + "x".repeat(200));
  const sig = ed.sign(msg, priv);
  let n = 0;
  const t2 = performance.now();
  while (performance.now() - t2 < 1500) { if (!ed.verify(sig, msg, pub)) throw new Error("bad"); n++; }
  out.nobleVerifyPerSec = Math.round(n / ((performance.now() - t2) / 1000));

  const kp = generateKeyPairSync("ed25519");
  const nsig = sign(null, msg, kp.privateKey);
  n = 0;
  const t3 = performance.now();
  while (performance.now() - t3 < 1000) { if (!verify(null, msg, kp.publicKey, nsig)) throw new Error("bad"); n++; }
  out.nativeVerifyPerSec = Math.round(n / ((performance.now() - t3) / 1000));

  const doc = { servers: Array.from({ length: 2000 }, (_, i) => ({ id: `s${i}`, name: `server ${i}`, apps: Array.from({ length: 10 }, (_, j) => ({ slug: `a${j}`, ok: true, at: i * j })) })) };
  const t4 = performance.now();
  for (let i = 0; i < 20; i++) JSON.parse(JSON.stringify(doc));
  out.jsonRoundTripMs = (performance.now() - t4) / 20;

  const Fastify = (await import("fastify")).default;
  const app = Fastify({ logger: false });
  app.get("/api/screens/home", async () => ({ ok: true, servers: doc.servers.slice(0, 20) }));
  await app.ready();
  const reqs = 3000;
  const t5 = performance.now();
  for (let i = 0; i < reqs; i++) {
    const r = await app.inject({ method: "GET", url: "/api/screens/home" });
    if (r.statusCode !== 200) throw new Error("status " + r.statusCode);
  }
  out.fastifyReqPerSec = Math.round(reqs / ((performance.now() - t5) / 1000));
  await app.close();
  out.rssMiB = Math.round(process.memoryUsage().rss / 1048576);
  return out;
}

if (argv.includes("--child")) {
  workload().then((r) => process.stdout.write(JSON.stringify(r)), (e) => { console.error(e); process.exit(1); });
} else {
  const node = opt("node", process.execPath);
  const rounds = Number(opt("rounds", "3"));
  const run = (flags) => {
    const t = performance.now();
    const r = spawnSync(node, [...flags, self, "--child"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
    if (r.status !== 0) return { error: (r.stderr || "").split("\n").slice(-4).join(" ").slice(0, 300) };
    return { ...JSON.parse(r.stdout), processMs: Math.round(performance.now() - t) };
  };
  const median = (xs) => { const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const summarize = (rs) => {
    if (rs.every((r) => r.error)) return { error: rs[0].error };
    const keys = Object.keys(rs.find((r) => !r.error) ?? {});
    return Object.fromEntries(keys.map((k) => [k, typeof rs[0][k] === "number" ? Math.round(median(rs.map((r) => r[k])) * 10) / 10 : rs[0][k]]));
  };
  const jit = [], jitless = [];
  for (let i = 0; i < rounds; i++) { jit.push(run([])); jitless.push(run(["--jitless"])); }
  const report = {
    node: spawnSync(node, ["--version"], { encoding: "utf8" }).stdout.trim(),
    platform: `${platform()} ${arch()}`, cpu: cpus()[0]?.model ?? "?", rounds,
    jit: summarize(jit), jitless: summarize(jitless),
  };
  console.log(JSON.stringify(report, null, 2));
}
