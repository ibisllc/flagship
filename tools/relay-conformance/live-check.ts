#!/usr/bin/env -S npx tsx
/**
 * Checks a live relay (the gym's, or prod's after a canary deploy) from the outside: which implementation answers its
 * health route, the PROXY-header echo on :8444, and that every box of a kept gym fleet still answers TLS through it
 * (the box's own certificate, so the relay passed the bytes untouched). Read-only; deploys nothing.
 *
 *   npx tsx tools/relay-conformance/live-check.ts --relay flagship-services-gym.fly.dev --expect rust \
 *     [--fleet gym-results/<run>/fleet.json] [--services gym.flagship.services]
 *
 * Exit 0 when every check passed, 1 otherwise. Used by scripts/relay-canary.sh (docs/architecture-v2/relay-transport.md §8).
 */
import { readFileSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const relay = arg("relay") ?? "flagship-services-gym.fly.dev";
const expect = arg("expect");
const fleet = arg("fleet");

let failed = 0;
const ok = (m: string) => console.log(`  ok    ${m}`);
const bad = (m: string) => {
  failed += 1;
  console.log(`  FAIL  ${m}`);
};

function tlsRequest(host: string, port: number, servername: string, request: string, timeoutMs = 15_000): Promise<{ text: string; subject: string }> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host, port, servername, rejectUnauthorized: true, timeout: timeoutMs });
    let text = "";
    s.on("secureConnect", () => {
      s.write(request);
    });
    s.on("data", (d) => (text += d.toString()));
    s.on("end", () => resolve({ text, subject: JSON.stringify(s.getPeerCertificate()?.subjectaltname ?? "") }));
    s.on("timeout", () => {
      s.destroy();
      if (text) resolve({ text, subject: "" });
      else reject(new Error("timed out"));
    });
    s.on("error", reject);
  });
}

async function main(): Promise<void> {
  console.log(`relay ${relay}`);
  try {
    const r = await fetch(`https://${relay}:8443/api/health`, { signal: AbortSignal.timeout(15_000) });
    const h = (await r.json()) as { runtime?: string; ok?: boolean };
    const impl = h.runtime === "rust" ? "rust" : "ts";
    if (r.status !== 200) bad(`health answered ${r.status}`);
    else if (expect && expect !== impl) bad(`health says the ${impl} relay answers, expected ${expect}`);
    else ok(`health 200 from the ${impl} relay`);
  } catch (e) {
    bad(`health: ${(e as Error).message}`);
  }

  try {
    const e = await tlsRequest(relay, 8444, relay, `GET /echo HTTP/1.1\r\nHost: ${relay}\r\nConnection: close\r\n\r\n`);
    const body = e.text.slice(e.text.indexOf("\r\n\r\n") + 4);
    if (/^HTTP\/1\.1 200/.test(e.text) && body.trim().startsWith("{")) ok(`echo :8444 ${body.trim()}`);
    else bad(`echo :8444 answered ${e.text.split("\r\n")[0] ?? "nothing"}`);
  } catch (e) {
    bad(`echo :8444: ${(e as Error).message}`);
  }

  if (fleet) {
    const f = JSON.parse(readFileSync(fleet, "utf8")) as { accounts: Array<{ boxes: Array<{ fqdn: string; online?: boolean }> }> };
    for (const b of f.accounts.flatMap((a) => a.boxes)) {
      try {
        const r = await tlsRequest(b.fqdn, 443, b.fqdn, `GET /api/health HTTP/1.1\r\nHost: ${b.fqdn}\r\nConnection: close\r\n\r\n`);
        const line = r.text.split("\r\n")[0] ?? "";
        if (line.startsWith("HTTP/1.1")) ok(`${b.fqdn}: ${line} (box certificate ${r.subject})`);
        else bad(`${b.fqdn}: no HTTP answer`);
      } catch (e) {
        bad(`${b.fqdn}: ${(e as Error).message}`);
      }
    }
  }
  console.log(failed === 0 ? "all checks passed" : `${failed} check(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
