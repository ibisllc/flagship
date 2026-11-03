/**
 * A real installer box on UpCloud for the ISO lanes (boot-chain refresh, the 0.2 recipe through the 0.3
 * installer): a recipe signed by a fresh REAL gym account, the generated preseed in the pinned Debian
 * netinst, the encrypted install, then the first boot from the disk, unlocked by the simulated phone
 * (lib/bootApprover.ts). The steps luks-burn.ts proved for the install, carried on to a running box.
 *
 * Every UpCloud resource carries flagship-env=gym, so the gym sweep reaps what a crashed lane leaves; the
 * box itself goes through the gym `.com` teardown (server + this account's DNS).
 */
import { BOX_RELEASE } from "@flagship/protocol";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils";
import { signAuthCode, signInstallBlob, type AuthCode, type InstallBlob } from "@flagship/protocol";
import { PINNED_DISTROS, buildDebianPreseed, optionsFromRecipeJson, remasterIsoWithPreseed } from "@flagship/builder";
import { issueAuthCode, newAuthCode, type Account, type Box } from "./fleet.js";
import { CONTROL, SERVICES, adminHeaders, assert, http, short, sleep } from "./harness.js";

const UPCLOUD = "https://api.upcloud.com/1.3";
const TOKEN_FILE = process.env.GYM_UPCLOUD_TOKEN_FILE || join(homedir(), ".config/flagship/upcloud-token");
export const ISO_ZONE = process.env.ISO_LANE_ZONE || "de-fra1";
export const ISO_PLAN = process.env.ISO_LANE_PLAN || "2xCPU-4GB";
export const ISO_WORK = process.env.ISO_LANE_WORK || join(tmpdir(), "flagship-iso-lanes");
const LABEL = { key: "flagship-env", value: "gym" };

export interface UpResp {
  status: number;
  json: any;
  text: string;
}

export async function upcloud(method: string, path: string, body?: unknown): Promise<UpResp> {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
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
      if (attempt >= 4 || method === "POST") throw e;
      await sleep(3000 * attempt);
    }
  }
}

export interface IsoRecipe {
  recipeJson: string;
  authCode: AuthCode;
  fqdn: string;
  serverName: string;
}

/**
 * The recipe an app hands the installer: the InstallBlob signed by the account's IRK, its AuthCode recorded
 * on `.com` with the admin root's approval (adding a server is admin-only), and `extras` as unsigned
 * siblings (e.g. a `debugGrant`). `installerGitRef` is what the blob carries: the gym release by default,
 * `"main"` for a 0.2 app's recipe.
 */
export async function issueIsoRecipe(acct: Account, serverName: string, o: { installerGitRef?: string; extras?: Record<string, unknown> } = {}): Promise<IsoRecipe> {
  const authCode = newAuthCode(acct, serverName);
  const i = await issueAuthCode(authCode, acct.keys.irk, acct.keys.adminRoot);
  assert(i.status === 200 || i.status === 201, `auth-code issue ${i.status}: ${short(i.text)}`);
  const acSig = signAuthCode(authCode, acct.keys.irk);
  const installerGitRef = o.installerGitRef ?? (process.env.GYM_INSTALLER_GIT_REF || BOX_RELEASE.commit);
  const blob: InstallBlob = {
    version: 2,
    serverDomain: authCode.serverDomain,
    username: acct.username,
    serverName,
    phoneDelegatedPubKey: acct.keys.delegated.publicKey,
    registrationUrl: `https://${CONTROL}/api/server/register`,
    authCode,
    authCodeUserSignature: acSig,
    installerGitRef,
    rckPubKey: acct.keys.rck.publicKey,
  };
  const recipe = {
    version: 2,
    serverDomain: blob.serverDomain,
    username: acct.username,
    serverName,
    phoneDelegatedPubKey: bytesToHex(blob.phoneDelegatedPubKey),
    registrationUrl: blob.registrationUrl,
    authCode: {
      version: 1,
      serial: authCode.serial,
      username: acct.username,
      serverName,
      serverDomain: authCode.serverDomain,
      delegatedPubKey: bytesToHex(authCode.delegatedPubKey),
      userPubKey: bytesToHex(authCode.userPubKey),
      issuedAt: authCode.issuedAt,
      expiresAt: authCode.expiresAt,
      ...(authCode.adminRootPubKey ? { adminRootPubKey: bytesToHex(authCode.adminRootPubKey) } : {}),
    },
    authCodeUserSignature: bytesToHex(acSig),
    installerGitRef,
    rckPubKey: bytesToHex(blob.rckPubKey),
    blobSignatureHex: bytesToHex(signInstallBlob(blob, acct.keys.irk)),
    ...(o.extras ?? {}),
  };
  return { recipeJson: JSON.stringify(recipe), authCode, fqdn: authCode.serverDomain, serverName };
}

/** The pinned amd64 netinst, downloaded once and checked against its pin. */
export function pinnedNetinst(): string {
  const distro = PINNED_DISTROS.find((d) => d.id === "debian-13-netinst-amd64");
  assert(distro, "no pinned debian-13-netinst-amd64");
  mkdirSync(ISO_WORK, { recursive: true });
  const src = process.env.ISO_LANE_ISO || join(ISO_WORK, "debian-netinst-amd64.iso");
  if (!existsSync(src)) {
    const dl = spawnSync("curl", ["-fL", "--retry", "3", "-o", src, distro.upstreamUrl], { stdio: "inherit" });
    assert(dl.status === 0, "ISO download failed");
  }
  const sha = createHash("sha256").update(readFileSync(src)).digest("hex");
  assert(sha === distro.sha256, `ISO sha256 ${sha} does not match the pinned ${distro.sha256}`);
  return src;
}

/** `burn` is what the installing app adds that the recipe doesn't carry (the exact commit, the boot host). */
export interface IsoBurn {
  installerGitRef?: string;
  bootHost?: string;
}

/** The preseed the 0.3 engine generates for a recipe (throws as the engine does on a recipe it refuses). */
export function preseedFor(recipeJson: string, burn: IsoBurn = {}): string {
  let preseed = buildDebianPreseed(optionsFromRecipeJson(recipeJson, { bootHost: burn.bootHost ?? `https://boot.${CONTROL}`, ...(burn.installerGitRef ? { installerGitRef: burn.installerGitRef } : {}) }));
  // Never touch production: the installer's progress beacons are hard-coded to it (luks-burn.ts).
  preseed = preseed.replace("d-i preseed/early_command string ", "d-i preseed/early_command string echo '127.0.0.1 flagshipserver.com' >> /etc/hosts; ");
  assert(!/partman-crypto\/passphrase(-again)? password/.test(preseed), "preseed still carries a passphrase");
  return preseed;
}

export async function personalizedIso(name: string, preseed: string): Promise<string> {
  const out = join(ISO_WORK, `${name}.iso`);
  await remasterIsoWithPreseed({ srcIsoPath: pinnedNetinst(), outIsoPath: out, preseedCfg: preseed });
  return out;
}

export interface IsoServer {
  serverId: string;
  isoStorage: string;
  ipv4: string | null;
}

/** Uploads the ISO and boots a fresh server from it with an empty 40 GB disk. `onStorage` sees the ISO storage at once (for cleanup). */
export async function bootIsoServer(isoPath: string, title: string, onStorage: (uuid: string) => void, log: (s: string) => void): Promise<IsoServer> {
  const bytes = statSync(isoPath).size;
  const st = await upcloud("POST", "/storage", {
    storage: { size: Math.max(2, Math.ceil(bytes / 1e9) + 1), tier: "maxiops", title: `${title}-iso`, zone: ISO_ZONE, labels: [LABEL] },
  });
  assert(st.status < 300, `create ISO storage ${st.status}: ${short(st.text, 200)}`);
  const isoStorage: string = st.json.storage.uuid;
  onStorage(isoStorage);
  const imp = await upcloud("POST", `/storage/${isoStorage}/import`, { storage_import: { source: "direct_upload" } });
  assert(imp.status < 300, `start import ${imp.status}: ${short(imp.text, 200)}`);
  const put = spawnSync("curl", ["-fsS", "-X", "PUT", "-H", "Content-Type: application/octet-stream", "-T", isoPath, imp.json.storage_import.direct_upload_url], { stdio: "inherit" });
  assert(put.status === 0, "ISO upload failed");
  for (let i = 0; ; i++) {
    const s = await upcloud("GET", `/storage/${isoStorage}/import`);
    if (s.json?.storage_import?.state === "completed") break;
    assert(s.json?.storage_import?.state !== "failed", `import failed: ${short(s.text, 200)}`);
    assert(i < 90, "ISO import did not complete in 7.5 minutes");
    await sleep(5000);
  }
  for (let i = 0; ; i++) {
    const s = await upcloud("GET", `/storage/${isoStorage}`);
    if (s.json?.storage?.state === "online") break;
    assert(i < 120, `ISO storage stuck in ${s.json?.storage?.state}`);
    await sleep(5000);
  }
  log("ISO imported");
  const create = () =>
    upcloud("POST", "/server", {
      server: {
        zone: ISO_ZONE,
        plan: ISO_PLAN,
        title,
        hostname: "flagship-pod",
        boot_order: "cdrom,disk",
        labels: { label: [LABEL] },
        storage_devices: {
          storage_device: [
            { action: "create", size: 40, tier: "maxiops", title: `${title}-disk`, type: "disk" },
            { action: "attach", type: "cdrom", storage: isoStorage },
          ],
        },
        networking: { interfaces: { interface: [{ type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }] } },
      },
    });
  let srv = await create();
  for (const deadline = Date.now() + 30 * 60_000; srv.status === 403 && /SERVER_CORE_LIMIT_REACHED/.test(srv.text) && Date.now() < deadline; ) {
    log("UpCloud core quota is full; waiting for room");
    await sleep(30_000);
    srv = await create();
  }
  assert(srv.status < 300, `create server ${srv.status}: ${short(srv.text, 300)}`);
  return { serverId: srv.json.server.uuid, isoStorage, ipv4: publicIpv4(srv.json.server) };
}

export function publicIpv4(server: any): string | null {
  for (const ip of server?.ip_addresses?.ip_address ?? []) if (ip.access === "public" && ip.family === "IPv4") return ip.address as string;
  return null;
}

export async function serverState(uuid: string): Promise<{ state: string; ipv4: string | null }> {
  const s = await upcloud("GET", `/server/${uuid}`);
  return { state: String(s.json?.server?.state ?? ""), ipv4: publicIpv4(s.json?.server) };
}

/** Polls the gym `.com` order status until `done(detail-history)` says so, an `error` phase, or the time runs out. */
export async function waitInstallEvidence(serial: string, want: (h: Array<{ phase?: string; detail?: string }>) => boolean, minutes: number, log: (s: string) => void): Promise<string> {
  const deadline = Date.now() + minutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const r = await http(`https://${CONTROL}/api/order/${serial}/status`, {}, 20_000).catch(() => null);
    const rec = r?.json;
    const hist: Array<{ phase?: string; detail?: string }> = rec?.history ?? (rec ? [rec] : []);
    const line = `phase=${rec?.phase ?? "-"} detail=${rec?.detail ?? "-"}`;
    if (line !== last) log(`  install: ${line}`);
    last = line;
    if (hist.some((h) => h.phase === "error")) throw new Error(`install reported error: ${short(rec, 300)}`);
    if (want(hist)) return last;
    await sleep(15_000);
  }
  throw new Error(`no install evidence within ${minutes} min (last: ${last})`);
}

/**
 * After d-i powers the machine off: take the CD out, boot from the disk only, start. The first boot then
 * runs the box's own premount, which asks the phone to unlock.
 */
export async function bootFromDisk(uuid: string, log: (s: string) => void, minutes = 25): Promise<void> {
  const deadline = Date.now() + minutes * 60_000;
  let state = "";
  while (Date.now() < deadline) {
    state = (await serverState(uuid)).state;
    if (state === "stopped") break;
    await sleep(15_000);
  }
  assert(state === "stopped", `the installer did not power the machine off within ${minutes} min (state ${state})`);
  const ej = await upcloud("POST", `/server/${uuid}/cdrom/eject`);
  log(`  CD ejected (${ej.status})`);
  const m = await upcloud("PUT", `/server/${uuid}`, { server: { boot_order: "disk" } });
  assert(m.status < 300, `boot order ${m.status}: ${short(m.text, 200)}`);
  const s = await upcloud("POST", `/server/${uuid}/start`);
  assert(s.status < 300, `start ${s.status}: ${short(s.text, 200)}`);
  log("  booting the installed system from its disk");
}

/** The power button: start a stopped server (a Lock/restart order can end in a shutdown). */
export async function powerOn(uuid: string): Promise<string> {
  const { state } = await serverState(uuid);
  if (state !== "stopped") return state;
  const s = await upcloud("POST", `/server/${uuid}/start`);
  return `started (${s.status})`;
}

export async function gymCounts(): Promise<{ servers: number; dns: number }> {
  const r = await http(`https://${CONTROL}/api/gym/teardown`, { method: "POST", headers: { "content-type": "application/json", ...adminHeaders() }, body: JSON.stringify({ all: true, dryRun: true }) }, 120_000);
  assert(r.status === 200, `gym sweep dry run ${r.status}: ${short(r.text, 160)}`);
  return { servers: r.json?.servers?.length ?? -1, dns: r.json?.dnsWouldDelete ?? -1 };
}

/** Destroys the server through the gym teardown (server + DNS of the usernames), then the ISO storage. */
export async function destroyIsoServer(o: { serverIds: string[]; fqdns: string[]; usernames: string[]; isoStorages: string[] }, log: (s: string) => void): Promise<void> {
  const td = await http(
    `https://${CONTROL}/api/gym/teardown`,
    { method: "POST", headers: { "content-type": "application/json", ...adminHeaders() }, body: JSON.stringify({ serverIds: o.serverIds, serverDomains: o.fqdns, usernames: o.usernames }) },
    300_000,
  ).catch((e) => ({ status: 0, text: String(e), json: null }) as any);
  log(`  gym teardown: ${td.status} ${short(td.json ?? td.text, 300)}`);
  for (const uuid of o.isoStorages) {
    for (let i = 0; i < 12; i++) {
      const d = await upcloud("DELETE", `/storage/${uuid}`);
      if (d.status === 204 || d.status === 404) {
        log(`  ISO storage deleted (${d.status})`);
        break;
      }
      await sleep(5000);
      if (i === 11) log(`  ISO storage ${uuid} NOT deleted: ${d.status} ${short(d.text, 160)}`);
    }
  }
}

export function isoBox(acct: Account, r: IsoRecipe, srv: IsoServer): Box {
  return { account: acct.username, serverName: r.serverName, fqdn: r.fqdn, serverId: srv.serverId, via: "gym-provision", online: false, serial: r.authCode.serial, ipv4: srv.ipv4 };
}

export function removeIso(path: string): void {
  rmSync(path, { force: true });
}

/** `<server>.<user>.<services>`: the box name the gym zone wildcard answers. */
export const boxFqdn = (server: string, user: string): string => `${server}.${user}.${SERVICES}`;
