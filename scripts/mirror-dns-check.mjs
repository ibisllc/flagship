#!/usr/bin/env node
/**
 * mirror-dns-check: the proxied records our own short domains need, which no tool writes and a DNS clean-up can
 * delete by mistake (fshp.tech's apex went missing on 2026-11-27, and the mirror was dead until it was put back).
 *
 *   fshp.tech  @ and * (www and every other name)  proxied AAAA 100::  -> the zone routes in apps/com/wrangler.toml
 *   fshp.app   @                                   proxied AAAA 100::  -> the bare apex redirect (its other names are
 *                                                                         DNS-only records .com publishes)
 *
 * Read-only: public DNS over HTTPS (1.1.1.1) and plain HTTPS requests. Exit 1 when anything is missing.
 *   npm run mirror-dns
 */

import { fileURLToPath } from "node:url";

const DOH = "https://cloudflare-dns.com/dns-query";

export const CHECKS = [
  { name: "fshp.tech", why: "the mirror's bare apex (proxied AAAA @ 100::)", get: "https://fshp.tech/", status: [200] },
  { name: "www.fshp.tech", why: "proxied AAAA www (or the * record)", get: "https://www.fshp.tech/", status: [301, 302, 307, 308] },
  { name: "mirror-dns-probe.fshp.tech", why: "the proxied * record", get: null, status: null },
  { name: "fshp.app", why: "the direct domain's bare apex (proxied AAAA @ 100::)", get: "https://fshp.app/", status: [301, 302, 307, 308] },
];

async function resolves(name, fetchImpl) {
  for (const type of ["AAAA", "A"]) {
    const r = await fetchImpl(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" } });
    if (!r.ok) continue;
    const j = await r.json();
    if (Array.isArray(j.Answer) && j.Answer.some((a) => a.type === 1 || a.type === 28)) return true;
  }
  return false;
}

export async function runChecks(fetchImpl = fetch) {
  const results = [];
  for (const c of CHECKS) {
    let ok = await resolves(c.name, fetchImpl).catch(() => false);
    let detail = ok ? "resolves" : `no address: add ${c.why}`;
    if (ok && c.get) {
      try {
        const r = await fetchImpl(c.get, { redirect: "manual", signal: AbortSignal.timeout(15000) });
        ok = c.status.includes(r.status);
        detail = ok ? `resolves, HTTP ${r.status}` : `resolves, but HTTP ${r.status} (expected ${c.status.join("/")})`;
      } catch (e) {
        ok = false;
        detail = `resolves, but HTTPS failed (${e?.message ?? e})`;
      }
    }
    results.push({ name: c.name, ok, detail });
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await runChecks();
  for (const r of results) console.log(`${r.ok ? "OK  " : "FAIL"} ${r.name}: ${r.detail}`);
  const bad = results.filter((r) => !r.ok).length;
  if (bad) console.log("\nNever delete these records in a DNS clean-up: AGENTS.md \"fshp.tech mirror domain\".");
  process.exit(bad ? 1 : 0);
}
