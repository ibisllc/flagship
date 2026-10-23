#!/usr/bin/env -S npx tsx
/**
 * LIVE "burn" lane: the USB/ISO debian-installer path on a real UpCloud server,
 * stopped as soon as the install is proven. Not the full gym.
 *
 * What it proves (docs/luks-burn-passphrase-removal.md, section 5): the REAL
 * generated preseed + the REAL bootstrap (register with the gym `.com`, seal the
 * key, remove the install-time key, assert exactly one key slot) run to the end
 * on a server that booted a personalized Debian netinst ISO with the disk
 * encrypted. The bootstrap reports "Disk key secured: one unlock key slot,
 * install key removed" on the order-status channel ONLY after
 * flagship_assert_single_luks_slot passed on that server's disk, so reading that
 * detail back from the gym `.com` is the one-slot evidence. The lane stops there
 * (it does not wait for a first boot, a cert or a phone).
 *
 * How (the gym fleet only creates servers from a template, so this lane talks to
 * UpCloud for the ISO and the server; every resource carries flagship-env=gym so
 * the gym-only sweep reaps it):
 *   1. mint a fresh gym account, AuthCode and signed recipe (as recipe-provision.ts)
 *   2. build the preseed with buildDebianPreseed, remaster the pinned amd64 netinst
 *   3. upload the ISO to an UpCloud storage (direct upload), create a server
 *      booting it, with an empty 40 GB disk
 *   4. poll the gym `.com` order status until the one-slot detail (or an error)
 *   5. ALWAYS: destroy the server through the gym teardown (server + this
 *      account's DNS), delete the ISO storage, and compare the gym DNS count
 *      with the count before the run
 *
 * It registers exactly one box's worth of DNS (one account, one server) and
 * nothing else. The install-progress beacons that the preseed hard-codes to the
 * PRODUCTION control plane are blackholed in the installer (/etc/hosts) so the
 * lane never contacts production.
 *
 *   set -a; source .gym-secrets.env; set +a     # GYM_ADMIN_SECRET
 *   npx tsc -b && npx tsx tools/live-e2e/lanes/luks-burn.ts
 *
 * Env: GYM_LIVE_CONTROL_APEX / GYM_LIVE_SERVICES_APEX (harness defaults),
 *      GYM_UPCLOUD_TOKEN_FILE (default ~/.config/flagship/upcloud-token),
 *      LUKS_LANE_WORK (default os.tmpdir()/luks-burn-lane), LUKS_LANE_ISO (a local
 *      copy of the pinned amd64 netinst), LUKS_LANE_ZONE (default de-fra1),
 *      LUKS_LANE_PLAN (default 2xCPU-4GB).
 * Exit 0 = one-slot evidence captured and cleanup verified; 1 otherwise.
 */
import { BOX_RELEASE } from "@flagship/protocol";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import {
  ed,
  signAuthCode,
  signAuthCodeAdmin,
  signClaimUsername,
  signInstallBlob,
  type AuthCode,
  type InstallBlob,
  type Keypair,
} from "@flagship/protocol";
import { PINNED_DISTROS, buildDebianPreseed, optionsFromRecipeJson, remasterIsoWithPreseed } from "@flagship/builder";
import { ADMIN, CONTROL, SERVICES, adminHeaders, http, sleep } from "../lib/harness.js";

const UPCLOUD = "https://api.upcloud.com/1.3";
const ZONE = process.env.LUKS_LANE_ZONE || "de-fra1";
const PLAN = process.env.LUKS_LANE_PLAN || "2xCPU-4GB";
const WORK = process.env.LUKS_LANE_WORK || join(tmpdir(), "luks-burn-lane");
const TOKEN_FILE = process.env.GYM_UPCLOUD_TOKEN_FILE || join(homedir(), ".config/flagship/upcloud-token");
const EVIDENCE = "Disk key secured: one unlock key slot, install key removed";
const LABEL = { key: "flagship-env", value: "gym" };

const log = (s: string): void => void process.stdout.write(`${s}\n`);
const kp = (seed: Uint8Array): Keypair => ({ privateKey: seed, publicKey: ed.getPublicKey(seed) });

let token = "";
async function up(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${UPCLOUD}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: r.status, json, text };
    } catch (e) {
      // A dropped connection after a long upload is common; the calls here are idempotent reads/deletes.
      if (attempt >= 4 || method === "POST") throw e;
      await sleep(3000 * attempt);
    }
  }
}

async function dnsBase(): Promise<{ servers: number; dns: number }> {
  const r = await http(
    `https://${CONTROL}/api/gym/teardown`,
    { method: "POST", headers: { "content-type": "application/json", ...adminHeaders() }, body: JSON.stringify({ all: true, dryRun: true }) },
    120_000,
  );
  if (r.status !== 200) throw new Error(`gym sweep dry run ${r.status}: ${r.text.slice(0, 160)}`);
  return { servers: r.json?.servers?.length ?? -1, dns: r.json?.dnsWouldDelete ?? -1 };
}

async function main(): Promise<number> {
  if (!ADMIN) throw new Error("GYM_ADMIN_SECRET is not set (source .gym-secrets.env)");
  token = readFileSync(TOKEN_FILE, "utf8").trim();
  mkdirSync(WORK, { recursive: true });

  const pre = await up("GET", "/account");
  if (pre.status !== 200) throw new Error(`UpCloud account check ${pre.status}`);
  const base = await dnsBase();
  log(`gym before: ${base.servers} server(s), ${base.dns} DNS record(s) under the gym apex`);
  if (base.servers !== 0) throw new Error(`the gym has ${base.servers} server(s) running: not starting a lane on a busy gym`);

  // 1. identity + recipe (the same steps as recipe-provision.ts, without /api/gym/provision)
  const irk = kp(randomBytes(32));
  const adminRoot = kp(randomBytes(32));
  const sug = await http(`https://${CONTROL}/api/username/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceKey: bytesToHex(kp(randomBytes(32)).publicKey) }),
  });
  const user: string = sug.json?.name;
  if (!user) throw new Error(`username suggest ${sug.status}`);
  const serverName = "home";
  const fqdn = `${serverName}.${user}.${SERVICES}`;
  const irkHex = bytesToHex(irk.publicKey);
  const adminHex = bytesToHex(adminRoot.publicKey);
  const claimAt = Date.now();
  const claim = await http(`https://${CONTROL}/api/username/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request: { username: user, irkPub: irkHex, issuedAt: claimAt },
      signature: bytesToHex(signClaimUsername({ username: user, irkPub: irk.publicKey, issuedAt: claimAt }, irk)),
      adminRootPub: adminHex,
    }),
  });
  if (claim.status !== 200) throw new Error(`claim ${claim.status}: ${claim.text.slice(0, 160)}`);
  const issuedAt = Date.now();
  const delegated = kp(randomBytes(32));
  const authCode: AuthCode = {
    version: 1,
    serial: "lkb" + bytesToHex(randomBytes(12)),
    username: user,
    serverName,
    serverDomain: fqdn,
    delegatedPubKey: delegated.publicKey,
    userPubKey: irk.publicKey,
    issuedAt,
    expiresAt: issuedAt + 24 * 3_600_000,
    adminRootPubKey: adminRoot.publicKey,
  };
  const acSig = signAuthCode(authCode, irk);
  const acWire = {
    version: 1,
    serial: authCode.serial,
    username: user,
    serverName,
    serverDomain: fqdn,
    delegatedPubKey: bytesToHex(delegated.publicKey),
    userPubKey: irkHex,
    issuedAt: authCode.issuedAt,
    expiresAt: authCode.expiresAt,
    adminRootPubKey: adminHex,
  };
  const issue = await http(`https://${CONTROL}/api/auth-code/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: acWire, signature: bytesToHex(acSig), adminSignature: bytesToHex(signAuthCodeAdmin(authCode, adminRoot)) }),
  });
  if (issue.status !== 200 && issue.status !== 201) throw new Error(`auth-code issue ${issue.status}: ${issue.text.slice(0, 160)}`);
  const rck = kp(randomBytes(32));
  const blob: InstallBlob = {
    version: 2,
    serverDomain: fqdn,
    username: user,
    serverName,
    phoneDelegatedPubKey: delegated.publicKey,
    registrationUrl: `https://${CONTROL}/api/server/register`,
    authCode,
    authCodeUserSignature: acSig,
    installerGitRef: process.env.GYM_INSTALLER_GIT_REF || BOX_RELEASE.commit,
    rckPubKey: rck.publicKey,
  };
  const recipeJson = JSON.stringify({
    version: 2,
    serverDomain: fqdn,
    username: user,
    serverName,
    phoneDelegatedPubKey: bytesToHex(delegated.publicKey),
    registrationUrl: blob.registrationUrl,
    authCode: acWire,
    authCodeUserSignature: bytesToHex(acSig),
    installerGitRef: process.env.GYM_INSTALLER_GIT_REF || BOX_RELEASE.commit,
    rckPubKey: bytesToHex(rck.publicKey),
    blobSignatureHex: bytesToHex(signInstallBlob(blob, irk)),
  });
  log(`gym account ${user}, box ${fqdn}, serial ${authCode.serial}`);

  let serverId = "";
  let isoStorage = "";
  let ok = false;
  const isoOut = join(WORK, `${user}.iso`);
  try {
    // 2. preseed + ISO
    const distro = PINNED_DISTROS.find((d) => d.id === "debian-13-netinst-amd64")!;
    const src = process.env.LUKS_LANE_ISO || join(WORK, "debian-netinst-amd64.iso");
    if (!existsSync(src)) {
      log(`downloading ${distro.upstreamUrl}`);
      const dl = spawnSync("curl", ["-fL", "--retry", "3", "-o", src, distro.upstreamUrl], { stdio: "inherit" });
      if (dl.status !== 0) throw new Error("ISO download failed");
    }
    const sha = createHash("sha256").update(readFileSync(src)).digest("hex");
    if (sha !== distro.sha256) throw new Error(`ISO sha256 ${sha} does not match the pinned ${distro.sha256}`);
    let preseed = buildDebianPreseed(optionsFromRecipeJson(recipeJson, {}));
    // Never touch production: the installer's progress beacons are hard-coded to it.
    preseed = preseed.replace(
      "d-i preseed/early_command string ",
      "d-i preseed/early_command string echo '127.0.0.1 flagshipserver.com' >> /etc/hosts; ",
    );
    if (/partman-crypto\/passphrase(-again)? password/.test(preseed)) throw new Error("preseed still carries a passphrase");
    await remasterIsoWithPreseed({ srcIsoPath: src, outIsoPath: isoOut, preseedCfg: preseed });
    const isoBytes = statSync(isoOut).size;
    log(`personalized ISO: ${(isoBytes / 1e6).toFixed(0)} MB`);

    // 3. UpCloud: ISO storage, import, server
    const st = await up("POST", "/storage", {
      storage: {
        size: Math.max(2, Math.ceil(isoBytes / 1e9) + 1),
        tier: "maxiops",
        title: `luks-lane-iso-${user}`,
        zone: ZONE,
        labels: [{ key: LABEL.key, value: LABEL.value }],
      },
    });
    if (st.status >= 300) throw new Error(`create ISO storage ${st.status}: ${st.text.slice(0, 200)}`);
    isoStorage = st.json.storage.uuid;
    const imp = await up("POST", `/storage/${isoStorage}/import`, { storage_import: { source: "direct_upload" } });
    if (imp.status >= 300) throw new Error(`start import ${imp.status}: ${imp.text.slice(0, 200)}`);
    const putUrl = imp.json.storage_import.direct_upload_url as string;
    const put = spawnSync("curl", ["-fsS", "-X", "PUT", "-H", "Content-Type: application/octet-stream", "-T", isoOut, putUrl], { stdio: "inherit" });
    if (put.status !== 0) throw new Error("ISO upload failed");
    for (let i = 0; i < 90; i++) {
      const s = await up("GET", `/storage/${isoStorage}/import`);
      const state = s.json?.storage_import?.state;
      if (state === "completed") break;
      if (state === "failed") throw new Error(`import failed: ${s.text.slice(0, 200)}`);
      await sleep(5000);
      if (i === 89) throw new Error("ISO import did not complete in 7.5 minutes");
    }
    for (let i = 0; i < 120; i++) {
      const s2 = await up("GET", `/storage/${isoStorage}`);
      if (s2.json?.storage?.state === "online") break;
      await sleep(5000);
      if (i === 119) throw new Error(`ISO storage stuck in ${s2.json?.storage?.state}`);
    }
    log("ISO imported");
    const srv = await up("POST", "/server", {
      server: {
        zone: ZONE,
        plan: PLAN,
        title: `flagship-gym-luks-lane-${user}`,
        hostname: "flagship-pod",
        boot_order: "cdrom,disk",
        labels: { label: [{ key: LABEL.key, value: LABEL.value }] },
        storage_devices: {
          storage_device: [
            { action: "create", size: 40, tier: "maxiops", title: `luks-lane-disk-${user}`, type: "disk" },
            { action: "attach", type: "cdrom", storage: isoStorage },
          ],
        },
        networking: { interfaces: { interface: [{ type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }] } },
      },
    });
    if (srv.status >= 300) throw new Error(`create server ${srv.status}: ${srv.text.slice(0, 300)}`);
    serverId = srv.json.server.uuid;
    log(`UpCloud server ${serverId} booting the personalized ISO`);

    // 4. evidence from the gym control plane, until the one-slot detail
    const deadline = Date.now() + 45 * 60_000;
    let last = "";
    let evidence: any = null;
    while (Date.now() < deadline) {
      const st2 = await http(`https://${CONTROL}/api/order/${authCode.serial}/status`, {}, 20_000).catch(() => null);
      const rec = st2?.json;
      const hist: any[] = rec?.history ?? (rec ? [rec] : []);
      const line = `phase=${rec?.phase ?? "-"} detail=${rec?.detail ?? "-"}`;
      if (line !== last) log(`  ${new Date().toISOString()} ${line}`);
      last = line;
      if (hist.some((h) => h.phase === "error")) throw new Error(`install reported error: ${JSON.stringify(rec)}`);
      evidence = hist.find((h) => typeof h.detail === "string" && h.detail.includes(EVIDENCE)) ?? null;
      if (evidence) break;
      await sleep(15_000);
    }
    if (!evidence) throw new Error(`no one-slot evidence within 45 minutes (last: ${last})`);
    log(`EVIDENCE captured from the gym control plane: ${JSON.stringify(evidence)}`);
    ok = true;
  } catch (e) {
    log(`LANE FAILED: ${(e as Error).message}`);
  } finally {
    // 5. cleanup, always
    log("cleanup");
    const td = await http(
      `https://${CONTROL}/api/gym/teardown`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...adminHeaders() },
        body: JSON.stringify({ serverIds: serverId ? [serverId] : [], serverDomains: [fqdn], usernames: [user] }),
      },
      300_000,
    ).catch((e) => ({ status: 0, text: String(e), json: null }) as any);
    log(`  gym teardown: ${td.status} ${JSON.stringify(td.json ?? td.text).slice(0, 300)}`);
    if (isoStorage) {
      // Detach is implicit once the server is gone; retry while UpCloud settles.
      for (let i = 0; i < 12; i++) {
        const d = await up("DELETE", `/storage/${isoStorage}`);
        if (d.status === 204 || d.status === 404) {
          log(`  ISO storage deleted (${d.status})`);
          break;
        }
        await sleep(5000);
        if (i === 11) log(`  ISO storage NOT deleted: ${d.status} ${d.text.slice(0, 160)}`);
      }
    }
    rmSync(isoOut, { force: true });
    const after = await dnsBase();
    log(`gym after: ${after.servers} server(s), ${after.dns} DNS record(s) (before: ${base.servers}, ${base.dns})`);
    if (after.servers !== base.servers || after.dns !== base.dns) {
      log("  NOT back to base: run `npx tsx tools/live-e2e/sweep-cli.ts` (dry run) then --destroy");
      ok = false;
    }
  }
  return ok ? 0 : 1;
}

process.exit(await main().catch((e) => (log(`CRASH: ${e instanceof Error ? e.message : e}`), 2)));
