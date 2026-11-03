/**
 * Root's own copy of the owner keys (`/etc/flagship/config.json`) and the daemon's control plane in
 * `daemon.env`, for boxes installed before the bootstrap wrote them (2a3e3bdaa: ISO, USB and VM
 * appliance boxes, 0.2 boxes updating to 0.3). Root rebuilds them from the install blob the
 * bootstrap copied to `/boot`, and only from that copy: it is root-owned on a filesystem the
 * unprivileged daemon sees read-only, unlike `/var/flagship/install-blob.json`, which the daemon may
 * own. The blob must still verify under the owner's account key, and the box's name in root's
 * `daemon.env` must match it. Anything short of that leaves the box as it is.
 */
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { verifyAuthCode, verifyInstallBlob, type InstallBlob } from "@flagship/protocol";
import { writeFileDurable } from "./durableFile.js";

export const BOOT_INSTALL_BLOB = "/boot/install-blob.json";
export const ROOT_CONFIG = "/etc/flagship/config.json";
export const DAEMON_ENV_FILE = "/etc/flagship/daemon.env";

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX128 = /^[0-9a-fA-F]{128}$/;
const hex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);

/**
 * The config.json the bootstrap's jq program writes (flagship-builder userdata.ts), field for field
 * and in the same order; null where jq fails the install. `rootConfigRepair.test.ts` runs both on
 * the same blobs.
 */
export function rootConfigFromBlob(b: unknown): Record<string, string> | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  const ac = (o.authCode && typeof o.authCode === "object" && !Array.isArray(o.authCode) ? o.authCode : {}) as Record<string, unknown>;
  if (typeof o.serverDomain !== "string" || typeof o.username !== "string" || !hex64(o.phoneDelegatedPubKey) || !hex64(ac.userPubKey)) return null;
  const root = hex64(ac.adminRootPubKey) ? ac.adminRootPubKey : hex64(o.adminRootPubHex) ? o.adminRootPubHex : null;
  return {
    serverId: o.serverDomain,
    userId: o.username,
    bakPublicKey: o.phoneDelegatedPubKey.toLowerCase(),
    irkPublicKey: ac.userPubKey.toLowerCase(),
    ...(hex64(o.ownerAidPubHex) ? { ownerAidPubHex: o.ownerAidPubHex.toLowerCase() } : {}),
    ...(root ? { adminRootPubHex: root.toLowerCase() } : {}),
  };
}

/** The bootstrap's `CONTROL_PLANE_BASE` (sed 's|/api/server/register$||', then http(s) only), or null. */
export function controlPlaneBaseFromRegistrationUrl(url: unknown): string | null {
  if (typeof url !== "string" || !/^[\x21-\x7e]+$/.test(url)) return null;
  const base = url.replace(/\/api\/server\/register$/, "");
  return /^https?:\/\//.test(base) ? base : null;
}

const hexBytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

/** The install blob, rebuilt from its on-disk JSON, if both owner signatures on it verify. */
export function verifiedInstallBlob(o: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  const ac = o.authCode as Record<string, unknown> | undefined;
  if (!ac || typeof ac !== "object") return { ok: false, reason: "it has no AuthCode" };
  const fields = [o.phoneDelegatedPubKey, o.rckPubKey, ac.userPubKey, ac.delegatedPubKey];
  if (o.version !== 2 || ac.version !== 1 || !fields.every(hex64)) return { ok: false, reason: "its fields can't be read" };
  if (typeof o.authCodeUserSignature !== "string" || !HEX128.test(o.authCodeUserSignature)) return { ok: false, reason: "its AuthCode signature can't be read" };
  if (typeof o.blobSignatureHex !== "string" || !HEX128.test(o.blobSignatureHex)) return { ok: false, reason: "its signature can't be read" };
  if (ac.adminRootPubKey !== undefined && !hex64(ac.adminRootPubKey)) return { ok: false, reason: "its admin root can't be read" };
  const strs = [o.serverDomain, o.username, o.serverName, o.registrationUrl, ac.serial, ac.username, ac.serverName, ac.serverDomain];
  if (!strs.every((s) => typeof s === "string")) return { ok: false, reason: "its fields can't be read" };
  if (typeof ac.issuedAt !== "number" || typeof ac.expiresAt !== "number") return { ok: false, reason: "its fields can't be read" };
  if (ac.serverDomain !== o.serverDomain || ac.username !== o.username) return { ok: false, reason: "its AuthCode names another server" };
  const userPub = hexBytes(ac.userPubKey as string);
  const authCode: InstallBlob["authCode"] = {
    version: 1,
    serial: ac.serial as string,
    username: ac.username as string,
    serverName: ac.serverName as string,
    serverDomain: ac.serverDomain as string,
    delegatedPubKey: hexBytes(ac.delegatedPubKey as string),
    userPubKey: userPub,
    issuedAt: ac.issuedAt,
    expiresAt: ac.expiresAt,
    ...(ac.adminRootPubKey !== undefined ? { adminRootPubKey: hexBytes(ac.adminRootPubKey as string) } : {}),
  };
  const blob: InstallBlob = {
    version: 2,
    serverDomain: o.serverDomain as string,
    username: o.username as string,
    serverName: o.serverName as string,
    phoneDelegatedPubKey: hexBytes(o.phoneDelegatedPubKey as string),
    registrationUrl: o.registrationUrl as string,
    authCode,
    authCodeUserSignature: hexBytes(o.authCodeUserSignature),
    installerGitRef: typeof o.installerGitRef === "string" ? o.installerGitRef : "",
    rckPubKey: hexBytes(o.rckPubKey as string),
    ...(o.bootUnlockMode === "auto" || o.bootUnlockMode === "approve" ? { bootUnlockMode: o.bootUnlockMode } : {}),
    ...(o.diskEncryption === "luks" || o.diskEncryption === "none" ? { diskEncryption: o.diskEncryption } : {}),
  };
  if (!verifyAuthCode(authCode, blob.authCodeUserSignature, userPub)) return { ok: false, reason: "its AuthCode isn't signed by the owner" };
  if (!verifyInstallBlob(blob, hexBytes(o.blobSignatureHex), userPub)) return { ok: false, reason: "it isn't signed by the owner" };
  return { ok: true };
}

const writableByOthers = (mode: number) => (mode & 0o022) !== 0;

/**
 * Read `path` only if it and its folder are root's: not a link, owned by root, writable by nobody
 * else, one name only. The checks are made on the open file itself, so the name can't be swapped
 * between the check and the read.
 */
export async function readRootOwnedFile(path: string, rootUid = 0): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/";
  const d = await lstat(dir).catch(() => null);
  if (!d || !d.isDirectory() || d.uid !== rootUid || writableByOthers(d.mode)) return { ok: false, reason: `${dir} is not root's alone` };
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? `${path} is missing` : code === "ELOOP" ? `${path} is a link` : `${path} can't be opened (${code})` };
  }
  try {
    const s = await fh.stat();
    if (!s.isFile()) return { ok: false, reason: `${path} is not a plain file` };
    if (s.uid !== rootUid) return { ok: false, reason: `${path} is not owned by root` };
    if (writableByOthers(s.mode)) return { ok: false, reason: `${path} is writable by others than root` };
    if (s.nlink !== 1) return { ok: false, reason: `${path} has more than one name` };
    if (s.size > 1 << 20) return { ok: false, reason: `${path} is too large` };
    return { ok: true, text: await fh.readFile("utf8") };
  } finally {
    await fh.close();
  }
}

export interface RootConfigRepairDeps {
  bootBlobPath?: string;
  configPath?: string;
  envPath?: string;
  /** Who counts as root for the ownership checks (tests run as an ordinary user). */
  rootUid?: number;
  log?: (m: string) => void;
}

export interface RootConfigRepairResult {
  /** What root wrote this time: empty when nothing was missing or nothing could be trusted. */
  repaired: ("config" | "control-plane" | "config-path")[];
  /** Why root left the box as it is, when something was missing. */
  refused?: string;
}

const envKeys = (text: string): Set<string> =>
  new Set(text.split("\n").map((l) => /^([A-Z_][A-Z0-9_]*)=/.exec(l.trim())?.[1]).filter((k): k is string => !!k));
const envValue = (text: string, key: string): string | undefined =>
  text.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1).replace(/^"(.*)"$/, "$1");

/**
 * Write what the bootstrap of a box installed before 2a3e3bdaa left out: config.json, and
 * FLAGSHIP_CONTROL_PLANE_BASE_URL and FLAGSHIP_CONFIG in daemon.env. Idempotent: a box that has
 * them is untouched, and only the first run that writes logs. Never throws.
 */
export async function repairRootConfig(deps: RootConfigRepairDeps = {}): Promise<RootConfigRepairResult> {
  const bootBlobPath = deps.bootBlobPath ?? BOOT_INSTALL_BLOB;
  const configPath = deps.configPath ?? ROOT_CONFIG;
  const envPath = deps.envPath ?? DAEMON_ENV_FILE;
  const log = deps.log ?? ((m: string) => console.error(m));
  try {
    const env = await readFile(envPath, "utf8").catch(() => null);
    const configMissing = !(await lstat(configPath).then(() => true, () => false));
    const keys = env === null ? new Set<string>() : envKeys(env);
    const needBase = env !== null && !keys.has("FLAGSHIP_CONTROL_PLANE_BASE_URL");
    const needConfigKey = env !== null && !keys.has("FLAGSHIP_CONFIG");
    if (!configMissing && !needBase && !needConfigKey) return { repaired: [] };

    const refuse = (reason: string): RootConfigRepairResult => {
      log(`[root-config] left as it is: ${reason}`);
      return { repaired: [], refused: reason };
    };
    const file = await readRootOwnedFile(bootBlobPath, deps.rootUid ?? 0);
    if (!file.ok) return refuse(`the install blob can't be trusted (${file.reason})`);
    let o: Record<string, unknown>;
    try {
      const parsed = JSON.parse(file.text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return refuse(`${bootBlobPath} is not an install blob`);
      o = parsed as Record<string, unknown>;
    } catch {
      return refuse(`${bootBlobPath} can't be read`);
    }
    const v = verifiedInstallBlob(o);
    if (!v.ok) return refuse(`the install blob on /boot can't be trusted: ${v.reason}`);
    const named = env === null ? undefined : envValue(env, "FLAGSHIP_SUBDOMAIN");
    if (named && named.toLowerCase() !== String(o.serverDomain).toLowerCase()) return refuse("the install blob on /boot is for another server");
    const config = rootConfigFromBlob(o);
    if (!config) return refuse("the install blob on /boot has no usable owner keys");
    const base = controlPlaneBaseFromRegistrationUrl(o.registrationUrl);
    if (needBase && !base) return refuse("the install blob on /boot names no control plane");

    const repaired: RootConfigRepairResult["repaired"] = [];
    if (configMissing) {
      await writeFileDurable(configPath, `${JSON.stringify(config)}\n`, 0o600);
      repaired.push("config");
    }
    if (env !== null && (needBase || needConfigKey)) {
      const lines = [
        ...(needBase ? [`FLAGSHIP_CONTROL_PLANE_BASE_URL=${base}`] : []),
        ...(needConfigKey ? [`FLAGSHIP_CONFIG=${configPath}`] : []),
      ];
      await writeFileDurable(envPath, `${env}${env === "" || env.endsWith("\n") ? "" : "\n"}${lines.join("\n")}\n`, 0o600);
      if (needBase) repaired.push("control-plane");
      if (needConfigKey) repaired.push("config-path");
    }
    log(`[root-config] rebuilt from the owner-signed install blob on /boot: ${repaired.join(", ")}`);
    return { repaired };
  } catch (e) {
    log(`[root-config] left as it is: ${(e as Error).message}`);
    return { repaired: [], refused: (e as Error).message };
  }
}
