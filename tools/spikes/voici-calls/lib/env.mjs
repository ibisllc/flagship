// Starts and stops the spike's processes. Topology:
//   root netns: the caller's Chromium
//   ── emulated link (lib/linkem.py: delay, jitter, loss, outages) ──
//   netns "phone": relay (SNI passthrough, :443) → phone-b (:7443, TLS ends here) | coturn (TLS :5349, TCP :3478)
//                  and the option-A "phone" Chromium (talks to coturn locally, no loss)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
export const RES = path.join(here, "../results");
const CERTS = path.join(RES, "certs");
const procs = {};

function start(name, cmd, args, readyRe) {
  stop(name);
  const log = fs.createWriteStream(path.join(RES, `${name}.log`));
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  procs[name] = { p, lines: [] };
  const onLine = (d) => { log.write(d); for (const l of d.toString().split("\n")) if (l.trim()) procs[name].lines.push(l); };
  p.stdout.on("data", onLine); p.stderr.on("data", onLine);
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${name} not ready`)), 10000);
    const iv = setInterval(() => { if (procs[name].lines.some((l) => readyRe.test(l))) { clearInterval(iv); clearTimeout(t); res(procs[name]); } }, 50);
    p.on("exit", (c) => { clearInterval(iv); clearTimeout(t); if (c) rej(new Error(`${name} exited ${c}`)); });
  });
}
export function stop(name) { const x = procs[name]; if (x) { x.p.kill("SIGKILL"); delete procs[name]; } }
export function lines(name) { return procs[name]?.lines ?? []; }
export function jsonLines(name) { return lines(name).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); }
export function clearLines(name) { if (procs[name]) procs[name].lines = []; }
export function stopAll() { for (const n of Object.keys(procs)) stop(n); for (const p of ["turnserver", "linkem.py"]) { try { execFileSync("pkill", ["-9", "-f", p]); } catch {} } }

export async function link({ delayMs = 40, jitterMs = 0, loss = 0, outageEveryS = 0, outageMs = 0 } = {}) {
  try { execFileSync("pkill", ["-9", "-f", "linkem.py"]); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  execFileSync("bash", [path.join(here, "netns.sh"), "up"]);
  await start("linkem", "python3", [path.join(here, "linkem.py"), "--delay-ms", delayMs, "--jitter-ms", jitterMs, "--loss", loss, "--outage-every-s", outageEveryS, "--outage-ms", outageMs].map(String), /^ready/);
  execFileSync("bash", [path.join(here, "netns.sh"), "addr"]);
}
const inNs = (args) => ["netns", "exec", "phone", ...args];
export async function coturn(cert = "leaf") {
  try { execFileSync("pkill", ["-9", "-f", "turnserver"]); } catch {}
  await start("coturn", "ip", inNs(["turnserver", "-n", "--no-cli", "--listening-ip=127.0.0.1", "--relay-ip=127.0.0.1", "--listening-port=3478",
    "--tls-listening-port=5349", `--cert=${CERTS}/${cert}.pem`, `--pkey=${CERTS}/${cert}.key`, "--lt-cred-mech", "--user=spike:spike",
    "--realm=calls.test", "--allow-loopback-peers", "--no-dtls", "--log-file=stdout", "--simple-log", "--no-software-attribute"]), /listener opened|Total General servers|IPv4. TLS\/TCP listener/i);
}
export async function relay(target) {
  await start("relay", "ip", inNs(["node", path.join(here, "relay.mjs"), "0.0.0.0", "443", `alice.calls.test=${target}`]), /listening/);
}
export async function phoneB() {
  await start("phoneb", "ip", inNs(["node", path.join(here, "phone-b.mjs"), CERTS, "7443", RES]), /listening/);
}
export const RESOLVE = "MAP alice.calls.test 203.0.113.2";
