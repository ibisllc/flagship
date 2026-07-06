#!/usr/bin/env -S npx tsx
/**
 * LIVE ENFORCEMENT gates — the standing "does this security control actually fire
 * on the wire" check (docs/ui-test-gym.md).
 *
 * The lesson this encodes (the restricted-mode no-op): a control can pass its unit
 * tests while being BYPASSABLE off-box. So each control is DRIVEN over the real
 * wire against a REAL gym box (or, where the wire proof needs a capability the gym
 * can't provision on a legacy demo box, proven deterministically against the same
 * @flagship/protocol primitives the box uses, with the live step recorded as a
 * TODO). The verdict rolls up STRICT: a bypass is RED (exit 1); a skip (no box / no
 * secret / transport error) is INCONCLUSIVE (exit 3) and never reads as a pass.
 *
 * Controls (task order):
 *   1. Restricted-mode on the real request path (GAP-1) — a restricted service is
 *      gated on the tier-1 wildcard Host AND the tier-2 leader-routed share URL AND
 *      a spoofed/absent Host raw request (curl --resolve class). All three knock/403.
 *   2. Admin gate rejects a non-admin — the pinned owner IRK authorizes a sensitive
 *      op (dead-man policy, enabled:false); a non-owner / forged signature is
 *      rejected. (Admin-root pin boundary proven deterministically + TODO.)
 *   3. Revocation reaches the box — revoke an invite on .com → the box denies the
 *      revoked identity's redeem; an un-revoked invite still redeems.
 *   4. Debug-access requires the admin authority — deterministic authority-boundary
 *      proof + TODO (needs a pinned-root box + LAN SSH).
 *   5. Transfer re-home requires the giver signature (GAP-3) — deterministic
 *      proof that no/forged/tampered authorization verifies + TODO (broker deposit).
 *
 * SEQUENCING: the enforcement FIXES these gates prove live are on v1-hardening,
 * NOT yet on `main`. The gym provisions boxes that clone from the control-plane-
 * pinned repo (main), so controls 1–3 will REDDEN against a main box until
 * v1-hardening merges. Run this in the FINAL gym pass AFTER the merge. It is wired
 * into gym:total / gym:weekly as the "enforcement" phase but self-skips cleanly
 * with no secrets.
 *
 * Usage (env from .gym-secrets.env):
 *   set -a; . ./.gym-secrets.env; set +a
 *   npx tsx tools/live-e2e/enforcement-drive.ts
 *   LIVE_E2E_REUSE_USER=<user> npx tsx tools/live-e2e/enforcement-drive.ts   # reuse a box
 *
 * Exit: 0 = every control enforced · 1 = a control BYPASSED · 3 = a check SKIPPED
 * (no secrets/box/precondition) · 2 = the harness crashed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveDemoUserIrk, deriveDemoDelegatedKey } from "@flagship/control-plane";
import {
  ed,
  deriveIRK,
  deriveAccountId,
  deriveHouseholdKey,
  signInstallService,
  signSetServiceAccessMode,
  signPhoneOrder,
  type Keypair,
  type InstallServiceRequest,
  type SetServiceAccessMode,
  type PhoneOrder,
} from "@flagship/protocol";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import {
  runEnforcementChecks,
  rollup,
  verdictExitCode,
  renderReport,
  type EnforcementContext,
  type EnforcementKeys,
  type WireResponse,
  type HttpFn,
  type RawFn,
} from "../gym/src/enforcement/index.js";

const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || process.env.LIVE_E2E_CONTROL || "gym.flagshipserver.com";
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || process.env.LIVE_E2E_SERVICES || "gym.flagship.services";
const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
const KEK = process.env.GYM_DEMO_IRK_KEK || "";
const REUSE_USER = process.env.LIVE_E2E_REUSE_USER || "";

function log(s: string): void {
  process.stdout.write(s + "\n");
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The injected HTTP transport — fetch, normalized to the check's WireResponse. */
async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}, timeoutMs = 15000): Promise<WireResponse> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    const setCookies =
      typeof (r.headers as { getSetCookie?: () => string[] }).getSetCookie === "function"
        ? (r.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
        : ([r.headers.get("set-cookie")].filter(Boolean) as string[]);
    return { status: r.status, text, json, setCookies };
  } finally {
    clearTimeout(t);
  }
}

/**
 * The RAW TLS transport — an `openssl s_client` request with the SNI and Host
 * chosen INDEPENDENTLY (the curl --resolve / spoofed-or-absent-Host class fetch()
 * can't express). Connects to the tier-1 FQDN (which resolves into the Fly hub) but
 * writes an arbitrary — or omitted — Host header.
 */
const rawTls: RawFn = async ({ sni, host, path }): Promise<WireResponse> => {
  const hostLine = host === null ? "" : `Host: ${host}\\r\\n`;
  const req = `GET ${path} HTTP/1.1\\r\\n${hostLine}Connection: close\\r\\n\\r\\n`;
  const out = spawnSync(
    "bash",
    [
      "-c",
      `printf '${req}' | openssl s_client -quiet -connect ${sni}:443 -servername ${sni} 2>/dev/null | head -c 1200`,
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  const raw = out.stdout || "";
  const statusLine = /HTTP\/1\.[01] (\d{3})/.exec(raw);
  if (!statusLine) throw new Error(`raw TLS request produced no HTTP response (sni=${sni})`);
  const status = Number(statusLine[1]);
  // Body is everything after the header terminator.
  const sep = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") + 4 : raw.indexOf("\n\n") + 2;
  const body = sep > 1 ? raw.slice(sep) : raw;
  return { status, text: body, json: null, setCookies: [] };
};

function fqdnOf(user: string): string {
  return `home.${user}.${SERVICES}`;
}

async function main(): Promise<void> {
  assert(ADMIN, "GYM_ADMIN_SECRET required");
  assert(KEK, "GYM_DEMO_IRK_KEK required (owner-signed envelopes)");
  const startedAt = new Date();
  const tsLabel = startedAt.toISOString().replace(/[:.]/g, "-");
  const user = REUSE_USER || "ef" + Date.now().toString(36).slice(-7);
  const fqdn = fqdnOf(user);
  const slug = "gate";
  const serviceRef = `${user}--${slug}`;
  const serviceUrl = `https://${slug}.${fqdn}`;
  const provEnv = { ...process.env, FLAGSHIP_ADMIN_SECRET: ADMIN, FLAGSHIP_BASE_URL: `https://${CONTROL}` };

  // ── identities ────────────────────────────────────────────────────────────
  const ownerIrk = deriveDemoUserIrk(hexToBytes(KEK), user);
  const delegated = deriveDemoDelegatedKey(hexToBytes(KEK), user);
  const attackerSeed = randomBytes(32);
  const adminSeed = randomBytes(32);
  const authorUmk = { seed: new Uint8Array(32).fill(0xa1) };
  const friendUmk = { seed: new Uint8Array(32).fill(0xf2) };
  const acquirerUmk = { seed: new Uint8Array(32).fill(0xac) };
  const keys: EnforcementKeys = {
    ownerIrk,
    attacker: { privateKey: attackerSeed, publicKey: ed.getPublicKey(attackerSeed) } as Keypair,
    friendAid: deriveAccountId(friendUmk),
    author: {
      aid: deriveAccountId(authorUmk),
      device: deriveIRK(authorUmk),
      householdKey: deriveHouseholdKey(authorUmk),
    },
    acquirerIrk: deriveIRK(acquirerUmk),
    adminRoot: { privateKey: adminSeed, publicKey: ed.getPublicKey(adminSeed) } as Keypair,
  };

  log(`\nLIVE enforcement gates`);
  log(`  control = ${CONTROL}`);
  log(`  box     = ${fqdn} (${REUSE_USER ? "REUSE" : "PROVISION cpx31"})`);
  log("");

  // ── provision + bring-up ────────────────────────────────────────────────────
  if (!REUSE_USER) {
    log("[provision cpx31 + bring-up]");
    try {
      execFileSync("node", ["scripts/sample-user.mjs", "create", user, "--size", "cpx31"], { env: provEnv, encoding: "utf8", timeout: 240000 });
      log(`  ✓ provisioned ${user}`);
    } catch (e: unknown) {
      log(`  · kicked off ${user}; CLI: ${String((e as Error)?.message ?? e).split("\n")[0].slice(0, 80)} — bring-up poll confirms`);
    }
    const deadline = Date.now() + 16 * 60_000;
    let online = false;
    let last = "";
    while (Date.now() < deadline) {
      const pods = await http(`https://${CONTROL}/api/users/${user}/pods`).catch(() => ({ json: null }) as WireResponse);
      const p = (pods.json as { pods?: Array<{ serverDomain?: string }> } | null)?.pods?.find((x) => x.serverDomain === fqdn);
      const serve = await http(`https://${fqdn}/`, {}, 12000).catch(() => ({ status: 0 }) as WireResponse);
      last = `registered=${p ? "y" : "n"} http=${serve.status}`;
      if (p && serve.status === 200) {
        online = true;
        break;
      }
      await sleep(20000);
    }
    if (!online) {
      log(`  ✗ box not online in 16 min (${last}) — tearing down + reporting SKIP`);
    } else {
      log(`  ✓ box online (${last})`);
    }
  }

  // Everything after provision runs in a try so teardown ALWAYS happens.
  let serviceRestricted = false;
  try {
    // ── setup: paired session → install whoami → set restricted ───────────────
    log("[setup: install + restrict a service to gate]");
    let paired = false;
    try {
      const token = bytesToHex(randomBytes(24));
      const order: PhoneOrder = { type: "add-paired-session", serverId: fqdn, token, label: "enforce-e2e", issuedAt: Date.now() };
      const sig = bytesToHex(signPhoneOrder(order, delegated));
      const r = await http(`https://${fqdn}/api/orders-from-user`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: order, signature: sig }) });
      paired = r.status === 200 || r.status === 204;
      log(`  ${paired ? "✓" : "·"} paired session (${r.status})`);
    } catch (e) {
      log(`  · paired session failed: ${(e as Error).message}`);
    }

    if (paired) {
      try {
        const manifestJson = JSON.stringify({
          schema_version: 1,
          name: slug,
          version: "0.1.0",
          description: "enforcement-e2e gate service",
          runtime: { image: "traefik/whoami", port: 80 },
          data: {},
          network: { subdomain: slug },
          access: { enabled: true, public_routes: ["/"] },
          migration: { verification: "standard" },
        });
        const req: InstallServiceRequest = { serverId: fqdn, creator: user, slug, manifestJson, addOwnerToMembership: true, issuedAt: Date.now() };
        const isig = bytesToHex(signInstallService(req, ownerIrk));
        const r = await http(`https://${fqdn}/api/services`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: isig }) }, 90_000);
        log(`  ${r.status === 200 ? "✓" : "·"} install ${serviceRef} (${r.status})`);
        if (r.status === 200) {
          // Wait for the container to serve the OPEN baseline.
          let serving = false;
          for (let i = 0; i < 20; i++) {
            const g = await http(`${serviceUrl}/`, { headers: { accept: "text/html" } }, 12000).catch(() => ({ status: 0 }) as WireResponse);
            if (g.status === 200) {
              serving = true;
              break;
            }
            await sleep(6000);
          }
          log(`  ${serving ? "✓" : "·"} service serves the open baseline`);
          if (serving) {
            const order: SetServiceAccessMode = { serverId: fqdn, serviceRef, mode: "restricted", issuedAt: Date.now() };
            const ssig = bytesToHex(signSetServiceAccessMode(order, ownerIrk));
            const sr = await http(`https://${fqdn}/api/service-access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: order, signature: ssig }) });
            serviceRestricted = sr.status === 200;
            log(`  ${serviceRestricted ? "✓" : "·"} set restricted (${sr.status})`);
          }
        }
      } catch (e) {
        log(`  · install/restrict failed: ${(e as Error).message}`);
      }
    }

    // ── run the five controls over the real wire ──────────────────────────────
    log("\n[drive the enforcement controls]");
    // Controls 1 & 3 need the RESTRICTED service; control 2 needs only the box up
    // (dead-man endpoint); controls 4 & 5 are deterministic (no transport). If the
    // service wasn't restricted, route every NON-dead-man request to a throwing
    // transport so controls 1 & 3 read SKIPPED — a control we couldn't set up must
    // never read bypassed/enforced (skip is not a pass), while control 2 still runs.
    const routedHttp: HttpFn = serviceRestricted
      ? http
      : (url, init) => {
          if (url.includes("/api/deadman/")) return http(url, init);
          return Promise.reject(new Error("precondition: service not installed/restricted"));
        };
    const wireCtx: EnforcementContext = {
      http: routedHttp,
      raw: rawTls,
      now: () => Date.now(),
      target: { control: CONTROL, servicesApex: SERVICES, user, fqdn, serviceSlug: slug, serviceRef },
      keys,
    };
    const outcomes = await runEnforcementChecks(wireCtx);

    const report = rollup(outcomes);
    log("\n" + renderReport(report));

    const dir = join("gym-results", "enforcement-live-" + tsLabel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "results.json"), JSON.stringify({ control: CONTROL, box: fqdn, startedAt, report }, null, 2));
    writeFileSync(join(dir, "report.txt"), renderReport(report) + "\n");

    // Stash the exit code; teardown runs first (finally), then we exit.
    process.exitCode = verdictExitCode(report);
    log(`\nverdict: exit ${process.exitCode}  ·  artifact: ${dir}/results.json`);
  } finally {
    if (!REUSE_USER) {
      log("\n[teardown]");
      try {
        execFileSync("node", ["scripts/sample-user.mjs", "delete", user], { env: provEnv, encoding: "utf8", timeout: 180000 });
        log(`  ✓ deleted ${user}`);
      } catch (e) {
        log(`  ✗ teardown failed for ${user}: ${(e as Error).message} — DELETE MANUALLY`);
      }
    }
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  log("enforcement-drive crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(2);
});
