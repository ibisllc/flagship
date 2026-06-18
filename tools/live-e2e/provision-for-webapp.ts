#!/usr/bin/env -S npx tsx
/**
 * Provision ONE gym Hetzner box owned by a UMK-DERIVED app IRK, then HOLD it
 * (no teardown) and persist the adoption material so the REAL webapp can adopt
 * the account and drive owner features against it.
 *
 * Unlike recipe-provision.ts (which uses a bare random-seed IRK then tears the
 * box down), this:
 *   - generates a 32-byte UMK seed and derives the owner IRK via the SAME
 *     `deriveIRK(umk)` the webapp's keystore uses (HKDF info `flagship.irk.v1`),
 *     so a session restored from that UMK seed in the webapp genuinely OWNS
 *     this box (the box's owner IRK == deriveIrkFromSeed(umkSeed));
 *   - claims the username, mints+records the AuthCode, signs the InstallBlob,
 *     POSTs /api/gym/provision, and polls until the box serves real TLS;
 *   - writes gym-results/feature-screenshots/box.json with
 *     { umkSeedHex, irkPubHex, username, fqdn, serverId, ipv4 } for the webapp
 *     adoption seam + the teardown step;
 *   - DOES NOT tear the box down (teardown.ts does that in a finally).
 *
 * Run:  set -a; source .gym-secrets.env; set +a
 *       GYM_BOX_REGION=ash npx tsx tools/live-e2e/provision-for-webapp.ts
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  ed,
  deriveIRK,
  signAuthCode,
  signInstallBlob,
  signClaimUsername,
  type AuthCode,
  type InstallBlob,
  type ClaimUsername,
} from "@flagship/protocol";
import { bytesToHex } from "@noble/hashes/utils";

const CONTROL = process.env.GYM_LIVE_CONTROL_APEX || "gym.flagshipserver.com";
const SERVICES = process.env.GYM_LIVE_SERVICES_APEX || "gym.flagship.services";
const ADMIN = process.env.GYM_ADMIN_SECRET || process.env.FLAGSHIP_ADMIN_SECRET || "";
const HCLOUD = process.env.GYM_HCLOUD_TOKEN || "";
const DNS_TOKEN = process.env.GYM_DNS_TOKEN || "";
const BOX_SIZE = process.env.GYM_BOX_SIZE || "cpx31";
const BOX_REGION = process.env.GYM_BOX_REGION || "ash";
const SSH_KEY = `${process.env.HOME}/.ssh/gym_flagship_ed25519`;
const OUT_DIR = join("gym-results", "feature-screenshots");

function log(s: string): void {
  process.stdout.write(s + "\n");
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function genSerial(): string {
  return "wap" + bytesToHex(randomBytes(12));
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

function certInfo(fqdn: string): { issuer: string; subject: string } {
  const out = spawnSync(
    "bash",
    [
      "-c",
      `echo | openssl s_client -connect ${fqdn}:443 -servername ${fqdn} 2>/dev/null | ` +
        `openssl x509 -noout -issuer -subject 2>/dev/null`,
    ],
    { encoding: "utf8", timeout: 25000 },
  );
  const t = out.stdout || "";
  const issuer = (/issuer=(.*)/.exec(t) || [])[1]?.trim() || "";
  const subject = (/subject=(.*)/.exec(t) || [])[1]?.trim() || "";
  return { issuer, subject };
}

function sshDiag(ip: string): string {
  const cmd =
    "echo '=== flagship-daemon (tail 50) ==='; journalctl -u flagship-daemon --no-pager -n 50 2>&1; " +
    "echo '=== bootstrap log (tail 30) ==='; tail -n 30 /var/log/flagship-bootstrap.log 2>&1 || echo '(none)'";
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
    { encoding: "utf8", timeout: 45000 },
  );
  return ((out.stdout || "") + (out.stderr || "")).slice(-3000);
}

async function main(): Promise<void> {
  assert(ADMIN, "GYM_ADMIN_SECRET (or FLAGSHIP_ADMIN_SECRET) is required");
  assert(HCLOUD, "GYM_HCLOUD_TOKEN is required");
  assert(DNS_TOKEN, "GYM_DNS_TOKEN is required");

  // ── 1. UMK seed → owner IRK (the webapp-compatible derivation) ────────────
  const umkSeed = randomBytes(32);
  const umk = { seed: umkSeed };
  const irk = deriveIRK(umk); // { privateKey, publicKey } — Ed25519 over HKDF(seed, flagship.irk.v1)
  const irkPubHex = bytesToHex(irk.publicKey);
  const irkPrivHex = bytesToHex(irk.privateKey);
  const umkSeedHex = bytesToHex(umkSeed);

  const user = "wap" + Date.now().toString(36).slice(-6);
  const serverName = "home";
  const serverDomain = `${serverName}.${user}.${SERVICES}`;
  const fqdn = serverDomain;
  const namePrefix = `flagship-gym-${user}-`;

  log(`\nGYM provision-for-webapp (UMK-derived owner IRK; box HELD for the sweep)`);
  log(`  control = ${CONTROL}`);
  log(`  services= ${SERVICES}`);
  log(`  user    = ${user}   IRK ${irkPubHex.slice(0, 16)}…  (from UMK seed ${umkSeedHex.slice(0, 12)}…)`);
  log(`  box     = ${fqdn}   (${BOX_SIZE} @ ${BOX_REGION})\n`);

  // ── 2. Claim username for the IRK ─────────────────────────────────────────
  const claim: ClaimUsername = { username: user, irkPub: irk.publicKey, issuedAt: Date.now() };
  const claimSig = bytesToHex(signClaimUsername(claim, irk));
  {
    const r = await http(`https://${CONTROL}/api/username/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: { username: user, irkPub: irkPubHex, issuedAt: claim.issuedAt },
        signature: claimSig,
      }),
    });
    assert(r.status === 200 || r.status === 409, `claim ${r.status}: ${r.text.slice(0, 160)}`);
    log(`  ✓ claimed username (${r.status})`);
  }

  // ── 3. Mint + record the AuthCode ─────────────────────────────────────────
  // GYM affordance: use the OWNER IRK as the phone-delegated key too. The
  // cloud-init writes `FLAGSHIP_PSK_PUB_HEX = phoneDelegatedPubKey`, which is
  // the key the box's `/api/orders-from-user` verifies against — so making it
  // the IRK lets the REAL webapp pairing UI (which signs an `add-paired-session`
  // order with the IRK) succeed and mint a genuine paired session, unlocking the
  // screens-BFF surfaces (server-detail / services-list) in the sweep. The
  // delegated key is a throwaway test identity anyway; nothing requires it to
  // differ from the IRK. PROD uses the entitlement relay, never this.
  const acIssuedAt = Date.now();
  const acExpiresAt = acIssuedAt + 24 * 3_600_000;
  const delegated = { privateKey: irk.privateKey, publicKey: irk.publicKey };
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
  {
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
    assert(r.status === 200 || r.status === 201, `issue ${r.status}: ${r.text.slice(0, 200)}`);
    log(`  ✓ minted AuthCode (serial ${authCode.serial.slice(0, 12)}…)`);
  }

  // ── 4. Build + sign the InstallBlob ───────────────────────────────────────
  const rckSeed = randomBytes(32);
  const rck = { privateKey: rckSeed, publicKey: ed.getPublicKey(rckSeed) };
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
  const blobSigHex = bytesToHex(signInstallBlob(blob, irk));
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

  // ── 5. POST /api/gym/provision ────────────────────────────────────────────
  log("[provision via /api/gym/provision]");
  let serverId = "";
  let ipv4: string | null = null;
  {
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
    if (r.status >= 400 && r.status < 500) {
      throw new Error(`SHAPE ERROR ${r.status}: ${r.text.slice(0, 300)} — fix the recipe, no box spent`);
    }
    assert(r.status === 200 && r.json?.ok === true, `provision ${r.status}: ${r.text.slice(0, 240)}`);
    serverId = String(r.json.serverId ?? "");
    ipv4 = r.json.ipv4 ?? null;
    log(`  ✓ provisioned serverId=${serverId} ipv4=${ipv4 ?? "?"} domain=${r.json.serverDomain}`);
  }

  // Persist the adoption material NOW so even if bring-up stalls, teardown +
  // any manual debugging have the box coordinates.
  mkdirSync(OUT_DIR, { recursive: true });
  const boxFile = join(OUT_DIR, "box.json");
  writeFileSync(
    boxFile,
    JSON.stringify(
      { control: CONTROL, services: SERVICES, user, username: user, fqdn, serverId, ipv4, irkPubHex, umkSeedHex, namePrefix },
      null,
      2,
    ),
  );
  log(`  ✓ wrote ${boxFile}`);

  // ── 6. Poll registered → cert → serving (up to 18 min) ────────────────────
  log("[bring-up — polling registered → cert → serving, up to 18 min]");
  const deadline = Date.now() + 18 * 60 * 1000;
  let last = "";
  let online = false;
  while (Date.now() < deadline) {
    const pods = await http(`https://${CONTROL}/api/users/${user}/pods`).catch(() => ({ json: null }) as any);
    const p = pods.json?.pods?.find((x: any) => x.serverDomain === fqdn);
    const serve = await http(`https://${fqdn}/`, {}, 12000).catch(() => ({ status: 0 }) as any);
    last = `registered=${p ? "y" : "n"} state=${p?.state ?? "-"} cert=${p?.currentCert ? "y" : "n"} hb=${p?.lastReported ? "y" : "n"} http=${serve.status}`;
    log(`    ${new Date().toISOString().slice(11, 19)} ${last}`);
    if (p && serve.status === 200) {
      online = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 20000));
  }

  if (!online) {
    log(`\n  ✗ box not online+serving in 18 min (last: ${last})`);
    if (ipv4) {
      log("[diagnose — SSH into the box]");
      log(sshDiag(ipv4));
    }
    log(`\nBox coordinates persisted to ${boxFile}; run teardown.ts to delete it.`);
    process.exit(1);
  }

  const c = certInfo(fqdn);
  log(`\n  ✓ ONLINE + serving. cert issuer=${c.issuer} subject=${c.subject}`);
  log(`\n=== provision-for-webapp: box ${fqdn} is HELD for the sweep ===`);
  log(`adoption material: ${boxFile}`);
  log(`  username  = ${user}`);
  log(`  fqdn      = ${fqdn}`);
  log(`  irkPubHex = ${irkPubHex}`);
  log(`  umkSeedHex= ${umkSeedHex}`);
  process.exit(0);
}

main().catch((e) => {
  log("provision-for-webapp crashed: " + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exit(2);
});
