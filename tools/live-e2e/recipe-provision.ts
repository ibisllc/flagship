#!/usr/bin/env -S npx tsx
/**
 * LIVE Phase-1 e2e for the gym recipe→Hetzner pipeline (docs/gym-recipe-to-hetzner.md).
 *
 * Proves the "app owns + drives a box built from its OWN recipe" chain end to
 * end against the deployed gym env, with NO demo-IRK or trust backdoor in the
 * identity path:
 *
 *   1. Generate a FRESH app IRK from a random seed (the app's own device key).
 *   2. Claim a fresh username for that IRK (`flagship/claim-username/v1`).
 *   3. Mint + self-sign an AuthCode (the inner IRK-signed credential).
 *   4. Build + self-sign an InstallBlob (the recipe) embedding the AuthCode.
 *   5. POST it to `POST /api/gym/provision` (the app composes the recipe; the
 *      gym provisions a Hetzner box FROM it). A 4xx here is a SHAPE bug — we
 *      stop and print the body (no box was spent). A 200 returns the box id.
 *   6. Poll up to 16 min for the box to register + serve a real Let's Encrypt
 *      cert; if it stalls, SSH in and read the daemon journal + bootstrap log.
 *   7. PROVE app-ownership: a JournalRequest signed by the APP IRK returns real
 *      daemon log lines (200), and a forged signature is rejected (401/403).
 *   8. BONUS: install a public service via the owner-IRK /api/services path and
 *      assert it serves 200 at its subdomain (the serve-502 fix on a recipe box).
 *   9. TEARDOWN (always): delete the Hetzner box + its CF DNS records.
 *
 * Secrets come from the environment (source .gym-secrets.env first):
 *   GYM_ADMIN_SECRET, GYM_HCLOUD_TOKEN, GYM_DNS_TOKEN.
 *
 *   set -a; source .gym-secrets.env; set +a
 *   npx tsx tools/live-e2e/recipe-provision.ts
 *
 * Env overrides: GYM_LIVE_CONTROL_APEX (default gym.flagshipserver.com),
 *                GYM_LIVE_SERVICES_APEX (default gym.flagship.services),
 *                GYM_BOX_SIZE (default cpx31),
 *                GYM_CF_ZONE_ID (default the gym flagship.services zone).
 *
 * Exit 0 = the POST 200'd and every observed check passed; 1 = a check failed
 * (the box is still torn down); 2 = the harness crashed before teardown.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ed,
  signAuthCode,
  signInstallBlob,
  signClaimUsername,
  signJournalRequest,
  signInstallService,
  signUninstallService,
  type AuthCode,
  type InstallBlob,
  type ClaimUsername,
  type JournalRequest,
  type InstallServiceRequest,
  type UninstallServiceRequest,
  type Keypair,
} from "@flagship/protocol";
import { bytesToHex } from "@noble/hashes/utils";

const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || "gym.flagshipserver.com";
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
const HCLOUD = process.env.GYM_HCLOUD_TOKEN || "";
const DNS_TOKEN = process.env.GYM_DNS_TOKEN || "";
const CF_ZONE = process.env.GYM_CF_ZONE_ID || "51f3bfe11a729db57effd70ed3cf9c77";
const BOX_SIZE = process.env.GYM_BOX_SIZE || "cpx31";
// The endpoint defaults to fsn1, but Hetzner's CPX line is stock-gated to
// specific datacenters (the fsn1/EU DCs frequently report "unsupported location
// for server type" for cpx*). Pass region explicitly so we land where the size
// is actually available; override with GYM_BOX_REGION if stock moves.
const BOX_REGION = process.env.GYM_BOX_REGION || "ash";
const SSH_KEY = `${process.env.HOME}/.ssh/gym_flagship_ed25519`;

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

/** A bare Ed25519 keypair from a 32-byte seed (mirrors protocol seedToKeypair). */
function keypairFromSeed(seed: Uint8Array): Keypair {
  return { privateKey: seed, publicKey: ed.getPublicKey(seed) };
}

/** A serial matching the control plane's SERIAL_RE (/^[A-Za-z0-9_-]{8,64}$/). */
function genSerial(): string {
  return "rcp" + bytesToHex(randomBytes(12));
}

async function http(
  url: string,
  opts: RequestInit = {},
  timeoutMs = 20000,
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

/**
 * Raw response headers (lower-cased keys) + status for a curl request.
 * Used by the CORS checks so we can assert on Access-Control-* headers,
 * which the fetch-based `http` helper above doesn't surface.
 */
function curlHeaders(
  url: string,
  args: string[],
): { status: number; headers: Record<string, string>; raw: string } {
  const out = spawnSync("curl", ["-s", "-D", "-", "-o", "/dev/null", ...args, url], {
    encoding: "utf8",
    timeout: 25000,
  });
  const raw = (out.stdout || "") + (out.stderr || "");
  const lines = raw.split(/\r?\n/);
  const status = parseInt((/HTTP\/\S+\s+(\d+)/.exec(lines[0] || "") || [])[1] || "0", 10) || 0;
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const idx = lines[i]!.indexOf(":");
    if (idx === -1) continue;
    const k = lines[i]!.slice(0, idx).trim().toLowerCase();
    const v = lines[i]!.slice(idx + 1).trim();
    // Preserve the first occurrence; CORS headers are single-valued here.
    if (!(k in headers)) headers[k] = v;
  }
  return { status, headers, raw };
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

// ── Hetzner teardown ────────────────────────────────────────────────────────
async function hetznerFindServer(namePrefix: string): Promise<{ id: number; name: string } | null> {
  const r = await http("https://api.hetzner.cloud/v1/servers?per_page=50", {
    headers: { authorization: `Bearer ${HCLOUD}` },
  });
  if (r.status !== 200) throw new Error(`hetzner list ${r.status}: ${r.text.slice(0, 120)}`);
  const srv = (r.json?.servers ?? []).find((s: any) => String(s.name).startsWith(namePrefix));
  return srv ? { id: srv.id, name: srv.name } : null;
}
async function hetznerDelete(id: number): Promise<number> {
  const r = await http(`https://api.hetzner.cloud/v1/servers/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${HCLOUD}` },
  });
  return r.status;
}

// ── Cloudflare DNS teardown (delete this box's records only) ─────────────────
async function cfListRecords(name: string): Promise<Array<{ id: string; type: string; name: string }>> {
  const r = await http(
    `https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
    { headers: { authorization: `Bearer ${DNS_TOKEN}` } },
  );
  if (r.status !== 200) throw new Error(`cf list ${name} ${r.status}: ${r.text.slice(0, 120)}`);
  return (r.json?.result ?? []).map((x: any) => ({ id: x.id, type: x.type, name: x.name }));
}
async function cfDeleteRecord(id: string): Promise<number> {
  const r = await http(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE}/dns_records/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${DNS_TOKEN}` },
  });
  return r.status;
}

/** Best-effort SSH diagnosis when a box stalls (boxes are root-SSH-able). */
function sshDiag(ip: string): string {
  const cmd =
    "echo '=== flagship-daemon (tail 40) ==='; journalctl -u flagship-daemon --no-pager -n 40 2>&1; " +
    "echo '=== bootstrap log (tail 40) ==='; tail -n 40 /var/log/flagship-bootstrap.log 2>&1 || echo '(no bootstrap log)'";
  const out = spawnSync(
    "ssh",
    [
      "-i", SSH_KEY,
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=15",
      "-o", "BatchMode=yes",
      `root@${ip}`,
      cmd,
    ],
    { encoding: "utf8", timeout: 40000 },
  );
  return ((out.stdout || "") + (out.stderr || "")).slice(-2400);
}

async function main(): Promise<void> {
  assert(ADMIN, "GYM_ADMIN_SECRET (or FLAGSHIP_ADMIN_SECRET) is required");
  assert(HCLOUD, "GYM_HCLOUD_TOKEN is required (teardown)");
  assert(DNS_TOKEN, "GYM_DNS_TOKEN is required (teardown)");

  const startedAt = new Date();
  const tsLabel = startedAt.toISOString().replace(/[:.]/g, "-");

  // ── 1. Fresh app identity ─────────────────────────────────────────────────
  const irk = keypairFromSeed(randomBytes(32)); // the app's OWN IRK, NOT the demo IRK
  const irkPubHex = bytesToHex(irk.publicKey);
  const irkPrivHex = bytesToHex(irk.privateKey);
  const user = "rcp" + Date.now().toString(36).slice(-6);
  const serverName = "home";
  const serverDomain = `${serverName}.${user}.${SERVICES}`;
  const fqdn = serverDomain;
  const namePrefix = `flagship-gym-${user}-`;

  log(`\nGYM recipe→Hetzner Phase-1 e2e (app owns + drives a box from its own recipe)`);
  log(`  control = ${CONTROL}`);
  log(`  services= ${SERVICES}`);
  log(`  user    = ${user}  (FRESH app IRK ${irkPubHex.slice(0, 16)}…)`);
  log(`  box     = ${fqdn}  (${BOX_SIZE} @ ${BOX_REGION}, PROVISION via /api/gym/provision)\n`);

  let provisioned = false;
  let serverId = "";
  let ipv4: string | null = null;

  try {
    // ── 2. Claim the username for the app IRK ───────────────────────────────
    log("[compose recipe — app side]");
    await check("claim username (flagship/claim-username/v1) for the app IRK", async () => {
      const claim: ClaimUsername = { username: user, irkPub: irk.publicKey, issuedAt: Date.now() };
      const sig = bytesToHex(signClaimUsername(claim, irk));
      const r = await http(`https://${CONTROL}/api/username/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request: { username: user, irkPub: irkPubHex, issuedAt: claim.issuedAt },
          signature: sig,
        }),
      });
      assert(r.status === 200 || r.status === 409, `claim ${r.status}: ${r.text.slice(0, 140)}`);
      return r.status === 409 ? "already claimed (ok)" : "claimed";
    });

    // ── 3. Mint + self-sign the AuthCode ────────────────────────────────────
    const acIssuedAt = Date.now();
    const acExpiresAt = acIssuedAt + 24 * 3_600_000; // 24h TTL (== endpoint maxExpiry)
    const delegated = keypairFromSeed(randomBytes(32)); // ephemeral phone-delegated key
    const authCode: AuthCode = {
      version: 1,
      serial: genSerial(),
      username: user,
      serverName,
      serverDomain,
      delegatedPubKey: delegated.publicKey,
      userPubKey: irk.publicKey,
      issuedAt: acIssuedAt,
      expiresAt: acExpiresAt,
    };
    const authCodeSig = signAuthCode(authCode, irk);
    const authCodeSigHex = bytesToHex(authCodeSig);

    await check("mint + record the AuthCode (POST /api/auth-code/issue)", async () => {
      const r = await http(`https://${CONTROL}/api/auth-code/issue`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: {
            version: authCode.version,
            serial: authCode.serial,
            username: authCode.username,
            serverName: authCode.serverName,
            serverDomain: authCode.serverDomain,
            delegatedPubKey: bytesToHex(authCode.delegatedPubKey),
            userPubKey: irkPubHex,
            issuedAt: authCode.issuedAt,
            expiresAt: authCode.expiresAt,
          },
          signature: authCodeSigHex,
        }),
      });
      assert(r.status === 200 || r.status === 201, `issue ${r.status}: ${r.text.slice(0, 160)}`);
      return `serial=${authCode.serial.slice(0, 12)}…`;
    });

    // ── 4. Build + self-sign the InstallBlob (the recipe) ───────────────────
    const rck = keypairFromSeed(randomBytes(32));
    const blob: InstallBlob = {
      version: 2,
      serverDomain,
      username: user,
      serverName,
      phoneDelegatedPubKey: delegated.publicKey,
      registrationUrl: `https://${CONTROL}/api/server/register`,
      authCode,
      authCodeUserSignature: authCodeSig,
      installerGitRef: "main",
      rckPubKey: rck.publicKey,
    };
    const blobSig = signInstallBlob(blob, irk);
    const blobSigHex = bytesToHex(blobSig);

    // The on-wire (InstallBlobJsonShort) shape the endpoint parses — hex pubkeys.
    const onWireBlob = {
      version: blob.version,
      serverDomain: blob.serverDomain,
      username: blob.username,
      serverName: blob.serverName,
      phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
      registrationUrl: blob.registrationUrl,
      authCode: {
        version: authCode.version,
        serial: authCode.serial,
        username: authCode.username,
        serverName: authCode.serverName,
        serverDomain: authCode.serverDomain,
        delegatedPubKey: bytesToHex(authCode.delegatedPubKey),
        userPubKey: irkPubHex,
        issuedAt: authCode.issuedAt,
        expiresAt: authCode.expiresAt,
      },
      authCodeUserSignature: authCodeSigHex,
      installerGitRef: blob.installerGitRef,
      rckPubKey: bytesToHex(blob.rckPubKey),
    };

    // ── 5. POST /api/gym/provision (the recipe → box step) ──────────────────
    log("[provision via /api/gym/provision]");
    let provBody: any = null;
    const posted = await check("POST /api/gym/provision returns 200 {ok, serverId, ipv4}", async () => {
      const r = await http(
        `https://${CONTROL}/api/gym/provision`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-secret": ADMIN },
          body: JSON.stringify({
            installBlob: onWireBlob,
            blobSignature: blobSigHex,
            irkPrivHex,
            size: BOX_SIZE,
            region: BOX_REGION,
          }),
        },
        60000,
      );
      // A 4xx is a SHAPE bug — STOP (no box spent). Print the body to fix it.
      if (r.status >= 400 && r.status < 500) {
        throw new Error(`SHAPE ERROR ${r.status}: ${r.text.slice(0, 300)} — fix the recipe, no box spent`);
      }
      assert(r.status === 200, `provision ${r.status}: ${r.text.slice(0, 240)}`);
      assert(r.json?.ok === true, `no ok: ${r.text.slice(0, 160)}`);
      provBody = r.json;
      provisioned = true;
      serverId = String(r.json.serverId ?? "");
      ipv4 = r.json.ipv4 ?? null;
      assert(r.json.serverDomain === fqdn, `serverDomain echo ${r.json.serverDomain} != ${fqdn}`);
      return `serverId=${serverId} ipv4=${ipv4 ?? "?"} domain=${r.json.serverDomain}`;
    });
    if (!posted) {
      // The POST itself failed (shape or upstream). Nothing to wait for; jump to
      // teardown (which is a no-op if no box exists) via the finally block.
      throw new Error("provision POST did not 200 — see the error above; not waiting for a box");
    }
    void provBody;

    // ── 6. Bring-up: poll registered + serving a real LE cert (up to 16 min) ─
    log("[bring-up — polling registered → cert → serving, up to 16 min]");
    const broughtUp = await check("box registers and serves a verified Let's Encrypt cert", async () => {
      const deadline = Date.now() + 16 * 60 * 1000;
      let last = "";
      while (Date.now() < deadline) {
        const pods = await http(`https://${CONTROL}/api/users/${user}/pods`).catch(() => ({ json: null }) as any);
        const p = pods.json?.pods?.find((x: any) => x.serverDomain === fqdn);
        const serve = await http(`https://${fqdn}/`, {}, 12000).catch(() => ({ status: 0 }) as any);
        last = `registered=${p ? "y" : "n"} state=${p?.state ?? "-"} cert=${p?.currentCert ? "y" : "n"} hb=${p?.lastReported ? "y" : "n"} http=${serve.status}`;
        if (p && serve.status === 200) return last;
        await new Promise((r) => setTimeout(r, 20000));
      }
      throw new Error(`not online+serving in 16 min (last: ${last})`);
    });

    if (!broughtUp && ipv4) {
      log("[diagnose — SSH into the stalled box]");
      log(sshDiag(ipv4));
    }

    if (broughtUp) {
      // ── Box: real TLS ────────────────────────────────────────────────────
      log("[box: TLS]");
      await check("box presents a real Let's Encrypt cert for its FQDN", () => {
        const c = certInfo(fqdn);
        assert(/Let's Encrypt/i.test(c.issuer), `issuer=${c.issuer || "<none>"}`);
        assert(c.subject.includes(fqdn), `subject=${c.subject || "<none>"}`);
        return c.issuer.replace(/.*CN ?= ?/i, "");
      });

      // ── CORS — the box's own /api/* must answer the webapp origin ─────────
      log("[CORS — daemon /api/* honours the webapp origin]");
      const webappOrigin = `https://web.${CONTROL}`; // web.gym.flagshipserver.com
      const apiUrl = `https://${fqdn}/api/front-page`;
      await check("OPTIONS preflight from the webapp origin echoes ACAO + methods/headers", () => {
        const r = curlHeaders(apiUrl, [
          "-X", "OPTIONS",
          "-H", `Origin: ${webappOrigin}`,
          "-H", "Access-Control-Request-Method: GET",
          "-H", "Access-Control-Request-Headers: content-type, x-flagship-session",
        ]);
        assert(r.status === 204 || r.status === 200, `preflight status ${r.status}`);
        assert(
          r.headers["access-control-allow-origin"] === webappOrigin,
          `ACAO=${r.headers["access-control-allow-origin"] ?? "<none>"} (want ${webappOrigin})`,
        );
        const methods = r.headers["access-control-allow-methods"] ?? "";
        assert(/GET/.test(methods) && /POST/.test(methods) && /OPTIONS/.test(methods), `methods=${methods}`);
        const hdrs = (r.headers["access-control-allow-headers"] ?? "").toLowerCase();
        assert(/x-flagship-session/.test(hdrs) && /content-type/.test(hdrs), `allow-headers=${hdrs}`);
        return `${r.status} ACAO=${r.headers["access-control-allow-origin"]} methods=[${methods}]`;
      });
      await check("actual GET from the webapp origin carries ACAO + Vary: Origin", () => {
        const r = curlHeaders(apiUrl, ["-H", `Origin: ${webappOrigin}`]);
        assert(
          r.headers["access-control-allow-origin"] === webappOrigin,
          `ACAO=${r.headers["access-control-allow-origin"] ?? "<none>"} (want ${webappOrigin})`,
        );
        assert(/origin/i.test(r.headers["vary"] ?? ""), `Vary=${r.headers["vary"] ?? "<none>"}`);
        return `http ${r.status} ACAO=${r.headers["access-control-allow-origin"]} Vary=${r.headers["vary"]}`;
      });
      await check("NEGATIVE — an evil Origin gets NO Access-Control-Allow-Origin echoed", () => {
        const r = curlHeaders(apiUrl, ["-H", "Origin: https://evil.example"]);
        assert(
          r.headers["access-control-allow-origin"] === undefined,
          `leaked ACAO=${r.headers["access-control-allow-origin"]} to evil.example`,
        );
        return `http ${r.status} no ACAO (rejected)`;
      });

      // ── 7. PROVE app-ownership via the app IRK ───────────────────────────
      log("[prove ownership — APP IRK signed journal]");
      await check("POST /api/journal signed by the APP IRK returns real log lines (owned!)", async () => {
        const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 25, issuedAt: Date.now() };
        const sig = bytesToHex(signJournalRequest(req, irk));
        const r = await http(`https://${fqdn}/api/journal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: req, signature: sig }),
        });
        assert(r.status === 200, `got ${r.status}: ${r.text.slice(0, 160)}`);
        const lines = r.json?.lines ?? r.json?.log ?? [];
        assert(Array.isArray(lines) && lines.length > 0, `no lines (${JSON.stringify(r.json).slice(0, 80)})`);
        return `${lines.length} lines (box owned by the app IRK)`;
      });
      await check("POST /api/journal REJECTS a forged signature (ownership is enforced)", async () => {
        const req: JournalRequest = { serverId: fqdn, unit: "flagship-daemon", lines: 5, issuedAt: Date.now() };
        const r = await http(`https://${fqdn}/api/journal`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ request: req, signature: "00".repeat(64) }),
        });
        assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
        return `rejected ${r.status}`;
      });

      // ── 8. BONUS: install a public service via the app IRK + serve it ─────
      log("[bonus: install a service via the APP IRK + serve it]");
      const slug = "probe";
      let installed = false;
      const platformUp = await check("GET /api/services responds (200 list, or 503 if platform off)", async () => {
        const r = await http(`https://${fqdn}/api/services`);
        assert(r.status === 200 || r.status === 503, `got ${r.status}`);
        return r.status === 503 ? "503 (platform off — bonus skipped)" : "200 (platform up)";
      });
      const svcAvail = results.find((x) => x.name.startsWith("GET /api/services"))?.detail.includes("platform up");
      if (platformUp && svcAvail) {
        const manifest = JSON.stringify({
          schema_version: 1,
          name: slug,
          version: "0.1.0",
          description: "serve probe",
          runtime: { image: "traefik/whoami", port: 80 },
          data: {},
          network: { subdomain: slug },
          access: { enabled: true, public_routes: ["/"] },
          migration: { verification: "standard" },
        });
        await check("install a service (APP IRK signed) → appears in /api/services", async () => {
          const req: InstallServiceRequest = {
            serverId: fqdn,
            creator: user,
            slug,
            manifestJson: manifest,
            addOwnerToMembership: true,
            issuedAt: Date.now(),
          };
          const sig = bytesToHex(signInstallService(req, irk));
          const r = await http(
            `https://${fqdn}/api/services`,
            { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }) },
            90000,
          );
          assert(r.status === 200, `install ${r.status}: ${r.text.slice(0, 180)}`);
          installed = true;
          const list = await http(`https://${fqdn}/api/services`);
          const apps = (Array.isArray(list.json) ? list.json : (list.json?.apps ?? list.json?.services)) ?? [];
          assert(apps.some((a: any) => JSON.stringify(a).includes(slug)), `not listed: ${JSON.stringify(apps).slice(0, 140)}`);
          return `installed + listed (${apps.length} services)`;
        });
        if (installed) {
          await check("installed container SERVES 200 at its subdomain (serve-502 fix proven)", async () => {
            const url = `https://${slug}.${fqdn}/`;
            let last = { status: 0, snippet: "" };
            for (let i = 0; i < 24; i++) {
              const c = await http(url, {}, 12000).catch(() => ({ status: 0, text: "fetch failed", json: null }) as any);
              if (c.status === 200) {
                const whoami = /Hostname|GET \/|RemoteAddr/i.test(String(c.text ?? "")) ? " (whoami body)" : "";
                return `200 at ${slug}.${fqdn}${whoami}`;
              }
              last = { status: c.status, snippet: String(c.text ?? "").replace(/\s+/g, " ").slice(0, 60) };
              await new Promise((r) => setTimeout(r, 5000));
            }
            const c = certInfo(`${slug}.${fqdn}`);
            const tlsOk = /Let's Encrypt/i.test(c.issuer) || c.sans.includes(`*.${fqdn}`);
            throw new Error(
              `not serving 200 in 120s — ${tlsOk ? `TLS+routing OK but HTTP ${last.status} ${last.snippet}` : `TLS/routing incomplete (issuer=${c.issuer || "<none>"})`}`,
            );
          });
          await check("uninstall the service (APP IRK signed) → 200", async () => {
            const req: UninstallServiceRequest = { serverId: fqdn, creator: user, slug, issuedAt: Date.now() };
            const sig = bytesToHex(signUninstallService(req, irk));
            const serviceIdStr = `${user}-${slug}`;
            const r = await http(
              `https://${fqdn}/api/services/${encodeURIComponent(serviceIdStr)}`,
              { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: req, signature: sig }) },
              60000,
            );
            assert(r.status === 200, `uninstall ${r.status}: ${r.text.slice(0, 160)}`);
            return "uninstalled";
          });
        }
      }
    }
  } catch (e) {
    log(`\n[harness] aborting to teardown: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    // ── 9. TEARDOWN — always, even on failure ─────────────────────────────
    log("\n[teardown]");
    await check("delete the Hetzner box (stop billing)", async () => {
      const srv = await hetznerFindServer(namePrefix).catch(() => null);
      if (!srv) return provisioned ? "box not found (already gone?)" : "no box was provisioned";
      const st = await hetznerDelete(srv.id);
      assert(st === 200 || st === 204 || st === 202 || st === 404, `delete ${st}`);
      // Confirm it's gone.
      await new Promise((r) => setTimeout(r, 3000));
      const still = await hetznerFindServer(namePrefix).catch(() => null);
      assert(!still, `box ${srv.name} still present after delete`);
      return `deleted ${srv.name} (id ${srv.id}); 0 boxes remain for ${user}`;
    });
    await check("delete this box's CF DNS records (and only this box's)", async () => {
      const names = [
        fqdn,
        `*.${fqdn}`,
        `${user}.${SERVICES}`,
        `*.${user}.${SERVICES}`,
      ];
      let deleted = 0;
      const remaining: string[] = [];
      for (const name of names) {
        const recs = await cfListRecords(name).catch(() => []);
        for (const rec of recs) {
          // Safety: never touch a record that isn't under this user's subtree.
          assert(
            rec.name === fqdn ||
              rec.name === `*.${fqdn}` ||
              rec.name === `${user}.${SERVICES}` ||
              rec.name === `*.${user}.${SERVICES}`,
            `refusing to delete out-of-scope record ${rec.name}`,
          );
          const st = await cfDeleteRecord(rec.id);
          if (st === 200) deleted++;
          else remaining.push(`${rec.type} ${rec.name} (del ${st})`);
        }
      }
      // Re-list to confirm nothing remains for this user.
      for (const name of names) {
        const recs = await cfListRecords(name).catch(() => []);
        for (const rec of recs) remaining.push(`${rec.type} ${rec.name}`);
      }
      assert(remaining.length === 0, `${deleted} deleted; still present: ${remaining.join(", ")}`);
      return `${deleted} records deleted; 0 remain for ${user}`;
    });
  }

  // ── results ─────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  const dir = join("gym-results", "recipe-provision-" + tsLabel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "results.json"),
    JSON.stringify(
      { control: CONTROL, services: SERVICES, user, box: fqdn, irkPub: irkPubHex, serverId, ipv4, startedAt, pass, fail, results },
      null,
      2,
    ),
  );
  log(`\n=== recipe→provision e2e: ${pass} passed, ${fail} failed of ${results.length} ===`);
  log(`verdict: ${fail === 0 ? "OK" : "FAILED"}`);
  log(`artifact: ${dir}/results.json`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  log("recipe-provision harness crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(2);
});
