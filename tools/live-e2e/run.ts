#!/usr/bin/env -S npx tsx
/**
 * LIVE real-server e2e against the gym test env (docs/ui-test-gym.md §6.5).
 *
 * Unlike the gym's Tier-1 (entirely backendless mocks), this provisions — or
 * reuses — an ACTUAL gym Hetzner box and exercises the real backend end-to-end:
 * lifecycle (provision → register → tunnel → ACME cert → serve), real
 * browser-trusted TLS, the control-plane directory, the box daemon's
 * unauthenticated API, and its owner-IRK-SIGNED API (we derive the deterministic
 * demo owner IRK from DEMO_IRK_KEK and sign the same envelopes the phone would).
 *
 *   GYM_ADMIN_SECRET=… GYM_DEMO_IRK_KEK=… npx tsx tools/live-e2e/run.ts
 *   LIVE_E2E_REUSE_USER=gymbox … npx tsx tools/live-e2e/run.ts   # reuse a live box (fast)
 *
 * Env: GYM_LIVE_CONTROL_APEX (default gym.flagshipserver.com),
 *      GYM_LIVE_SERVICES_APEX (default gym.flagship.services),
 *      GYM_ADMIN_SECRET | FLAGSHIP_ADMIN_SECRET (required to provision/delete),
 *      GYM_DEMO_IRK_KEK (hex; enables the signed-endpoint checks),
 *      LIVE_E2E_REUSE_USER (skip provision+teardown, exercise this user's box).
 *
 * Exit 0 = every check passed; 1 = a check failed; 2 = the harness crashed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deriveDemoUserIrk } from "@flagship/control-plane";
import { signJournalRequest, type JournalRequest } from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || "gym.flagshipserver.com";
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
const KEK = process.env.GYM_DEMO_IRK_KEK || "";
const REUSE_USER = process.env.LIVE_E2E_REUSE_USER || "";

interface Res {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: Res[] = [];
function log(s: string): void {
  process.stdout.write(s + "\n");
}
async function check(name: string, fn: () => Promise<string> | string): Promise<boolean> {
  const t = Date.now();
  try {
    const detail = (await fn()) || "";
    results.push({ name, ok: true, detail, ms: Date.now() - t });
    log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
    return true;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail, ms: Date.now() - t });
    log(`  ✗ ${name} — ${detail}`);
    return false;
  }
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function http(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ status: number; text: string; json: any }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: r.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/** issuer / subject / SAN list for a live host's served cert (openssl s_client). */
function certInfo(fqdn: string): { issuer: string; subject: string; sans: string[] } {
  const out = spawnSync(
    "bash",
    [
      "-c",
      `echo | openssl s_client -connect ${fqdn}:443 -servername ${fqdn} 2>/dev/null | ` +
        `openssl x509 -noout -issuer -subject -text 2>/dev/null`,
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  const t = out.stdout || "";
  const issuer = (/issuer=(.*)/.exec(t) || [])[1]?.trim() || "";
  const subject = (/subject=(.*)/.exec(t) || [])[1]?.trim() || "";
  const sanLine = (/DNS:[^\n]*/.exec(t) || [])[0] || "";
  const sans = sanLine.split(",").map((s) => s.trim().replace(/^DNS:/, "")).filter(Boolean);
  return { issuer, subject, sans };
}

async function main(): Promise<void> {
  assert(ADMIN, "GYM_ADMIN_SECRET (or FLAGSHIP_ADMIN_SECRET) is required");
  const startedAt = new Date();
  const tsLabel = startedAt.toISOString().replace(/[:.]/g, "-");
  const user = REUSE_USER || "lv" + Date.now().toString(36).slice(-7);
  const fqdn = `home.${user}.${SERVICES}`;
  const provEnv = { ...process.env, FLAGSHIP_ADMIN_SECRET: ADMIN, FLAGSHIP_BASE_URL: `https://${CONTROL}` };
  log(`\nLIVE real-server e2e`);
  log(`  control = ${CONTROL}`);
  log(`  services= ${SERVICES}`);
  log(`  box     = ${fqdn}  (${REUSE_USER ? "REUSE existing" : "PROVISION fresh"})`);
  log(`  signed  = ${KEK ? "yes (demo IRK derived)" : "SKIP (no GYM_DEMO_IRK_KEK)"}\n`);

  // ── 1. Both planes reachable ──────────────────────────────────────────────
  log("[control + data plane]");
  await check("control plane health 200", async () => {
    const r = await http(`https://${CONTROL}/api/health`);
    assert(r.status === 200, `got ${r.status}`);
    return `service=${r.json?.service ?? "?"} surface=${r.json?.surface ?? "?"}`;
  });
  // (The data plane is proven below by the box SERVING through it — the bare
  // `<apex>:8443` hub port has no apex A record to probe directly; only per-box
  // names resolve into the Fly app, by design.)

  // ── 2. Provision + bring-up (unless reusing) ──────────────────────────────
  if (!REUSE_USER) {
    log("[provision]");
    const provisioned = await check("provision a fresh box via the admin flow", () => {
      execFileSync("node", ["scripts/sample-user.mjs", "create", user], {
        env: provEnv,
        encoding: "utf8",
        timeout: 360000,
      });
      return `requested ${user}`;
    });
    if (provisioned) {
      log("[bring-up — polling registered → online → cert → serving, up to 16 min]");
      await check("box comes online and serves verified TLS", async () => {
        const deadline = Date.now() + 16 * 60 * 1000;
        let last = "";
        while (Date.now() < deadline) {
          const pods = await http(`https://${CONTROL}/api/users/${user}/pods`).catch(() => ({ json: null }) as any);
          const p = pods.json?.pods?.find((x: any) => x.serverDomain === fqdn);
          const serve = await http(`https://${fqdn}/`, {}, 12000).catch(() => ({ status: 0 }) as any);
          last = `registered=${p ? "y" : "n"} cert=${p?.currentCert ? "y" : "n"} hb=${p?.lastReported ? "y" : "n"} http=${serve.status}`;
          if (p && serve.status === 200) return last;
          await new Promise((r) => setTimeout(r, 20000));
        }
        throw new Error(`not online+serving in 16 min (last: ${last})`);
      });
    }
  }

  // ── 3. Box: real TLS + serving ────────────────────────────────────────────
  log("[box: TLS + serving]");
  await check("box serves HTTP 200 (the daemon apex page)", async () => {
    const r = await http(`https://${fqdn}/`);
    assert(r.status === 200, `got ${r.status}`);
    assert(/Flagship/i.test(r.text), "apex html missing the Flagship brand");
    return `${r.text.length}B html`;
  });
  await check("box presents a real Let's Encrypt cert for its own FQDN", () => {
    const c = certInfo(fqdn);
    assert(/Let's Encrypt/i.test(c.issuer), `issuer=${c.issuer || "<none>"}`);
    assert(c.subject.includes(fqdn), `subject=${c.subject || "<none>"}`);
    return c.issuer.replace(/.*CN ?= ?/i, "");
  });
  await check("cert SANs cover the box apex AND its per-box wildcard", () => {
    const c = certInfo(fqdn);
    assert(c.sans.includes(fqdn), `apex SAN missing (sans=${c.sans.join(",") || "<none>"})`);
    assert(c.sans.includes(`*.${fqdn}`), `wildcard SAN missing (sans=${c.sans.join(",")})`);
    return c.sans.join(", ");
  });

  // ── 4. Box: unauthenticated API ───────────────────────────────────────────
  log("[box: unauthenticated API]");
  await check("GET /api/services responds (list, or 503 when the platform is off)", async () => {
    const r = await http(`https://${fqdn}/api/services`);
    assert(r.status === 200 || r.status === 503, `got ${r.status}`);
    if (r.status === 503) return "503 — service platform disabled (demo box runs no docker stack)";
    const list = Array.isArray(r.json) ? r.json : r.json?.services;
    assert(Array.isArray(list), `200 but not an array: ${r.text.slice(0, 80)}`);
    return `${list.length} services`;
  });
  await check("GET /api/front-page returns the apex assignment", async () => {
    const r = await http(`https://${fqdn}/api/front-page`);
    assert(r.status === 200, `got ${r.status}`);
    return JSON.stringify(r.json).slice(0, 70);
  });

  // ── 5. Control plane: directory reflects the live box ─────────────────────
  log("[control plane: directory]");
  await check("GET /api/users/:u/pods shows the box ONLINE with a verified cert", async () => {
    const r = await http(`https://${CONTROL}/api/users/${user}/pods`);
    assert(r.status === 200, `got ${r.status}`);
    const p = r.json?.pods?.find((x: any) => x.serverDomain === fqdn);
    assert(p, `box ${fqdn} not in /pods`);
    assert(p.state === "online", `state=${p.state}`);
    return `state=${p.state} cert=${p.currentCert ? "set" : "-"} hb=${p.lastReported ? "set" : "-"}`;
  });

  // ── 6. Box: owner-IRK SIGNED API (derive demo IRK, sign real envelopes) ───
  if (KEK) {
    log("[box: owner-IRK signed API]");
    const irk = deriveDemoUserIrk(hexToBytes(KEK), user);
    await check("POST /api/journal (owner-IRK signed) returns real daemon log lines", async () => {
      const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 25, issuedAt: Date.now() };
      const sig = bytesToHex(signJournalRequest(req, irk));
      const r = await http(`https://${fqdn}/api/journal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: sig }),
      });
      assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 140)}`);
      const lines = r.json?.lines ?? r.json?.log ?? [];
      assert(Array.isArray(lines) && lines.length > 0, `no lines (${JSON.stringify(r.json).slice(0, 80)})`);
      return `${lines.length} lines`;
    });
    await check("POST /api/journal REJECTS a forged signature (auth is enforced)", async () => {
      const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 5, issuedAt: Date.now() };
      const r = await http(`https://${fqdn}/api/journal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: req, signature: "00".repeat(64) }),
      });
      assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
      return `rejected ${r.status}`;
    });
  } else {
    log("[box: owner-IRK signed API] — SKIPPED (set GYM_DEMO_IRK_KEK to enable)");
  }

  // ── 7. Teardown (unless reusing) ──────────────────────────────────────────
  if (!REUSE_USER) {
    log("[teardown]");
    await check("delete the box (stop billing)", () => {
      execFileSync("node", ["scripts/sample-user.mjs", "delete", user], {
        env: provEnv,
        encoding: "utf8",
        timeout: 180000,
      });
      return `deleted ${user}`;
    });
  }

  // ── results ───────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const dir = join("gym-results", "live-e2e-" + tsLabel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "results.json"),
    JSON.stringify(
      { control: CONTROL, services: SERVICES, box: fqdn, reuse: !!REUSE_USER, startedAt, pass, fail, results },
      null,
      2,
    ),
  );
  log(`\n=== LIVE real-server e2e: ${pass} passed, ${fail} failed of ${results.length} ===`);
  log(`verdict: ${fail === 0 ? "OK" : "FAILED"}`);
  log(`artifact: ${dir}/results.json`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  log("live-e2e harness crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(2);
});
