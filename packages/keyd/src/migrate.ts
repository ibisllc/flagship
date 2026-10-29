import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Move a box's existing key files into keyd's state directory (SECURITY-HARDENING-PLAN.md 6.4,
 * "migration of existing keys"). Each file is verified, written 0400 into the keyd directory,
 * read back, and only then removed from where the daemon could read it. Safe to run twice.
 */
export interface MigrateResult {
  moved: string[];
  alreadyThere: string[];
  missing: string[];
}

const SOURCES: Array<{ name: "identity" | "swk" | "cgk"; from: string[] }> = [
  { name: "identity", from: ["identity/identity.priv.hex"] },
  { name: "swk", from: ["swk.hex"] },
  { name: "cgk", from: ["cgk.hex"] },
];

export function migrateKeyFiles(opts: { legacyDir: string; keydDir: string; identityKeyPath?: string }): MigrateResult {
  const result: MigrateResult = { moved: [], alreadyThere: [], missing: [] };
  mkdirSync(opts.keydDir, { recursive: true, mode: 0o700 });
  chmodSync(opts.keydDir, 0o700);
  for (const { name, from } of SOURCES) {
    const target = name === "identity" && opts.identityKeyPath ? opts.identityKeyPath : join(opts.keydDir, `${name}.key`);
    const src = from.map((f) => join(opts.legacyDir, f)).find((p) => existsSync(p));
    if (existsSync(target)) {
      if (src) {
        if (readFileSync(src, "utf8").trim() !== readFileSync(target, "utf8").trim()) {
          throw new Error(`${target} exists and differs from ${src}; refusing to guess which is right`);
        }
        rmSync(src);
      }
      result.alreadyThere.push(name);
      continue;
    }
    if (!src) {
      result.missing.push(name);
      continue;
    }
    const hex = readFileSync(src, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${src} is not a 32-byte hex key`);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, hex + "\n", { mode: 0o400 });
    renameSync(tmp, target);
    if (readFileSync(target, "utf8").trim() !== hex || (statSync(target).mode & 0o077) !== 0) {
      throw new Error(`could not verify ${target}`);
    }
    rmSync(src);
    result.moved.push(name);
  }
  return result;
}

/**
 * Remove the identity key from the environment files systemd feeds to the daemon, so a
 * restart does not hand it back. Only the named variables are dropped; everything else in
 * the file is kept byte for byte.
 */
export function scrubEnvFile(path: string, variables: readonly string[]): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  const kept = text.split("\n").filter((line) => !variables.some((v) => line.startsWith(`${v}=`)));
  const next = kept.join("\n");
  if (next === text) return false;
  const mode = statSync(path).mode & 0o777;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, next, { mode });
  renameSync(tmp, path);
  return true;
}

/** Give the keyd user its state (only when running as root, i.e. as the migration step). */
export function handOverToKeydUser(dir: string, user: string, group: string): void {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    execFileSync("chown", ["-R", `${user}:${group}`, dir]);
  }
}

/**
 * The names and ACME state this keyd serves, written once by the migration from the box's own
 * recipe (root-owned files keyd itself cannot read). keyd never accepts a name from a request.
 */
export interface KeydPolicy {
  serverFqdn: string;
}

export function writePolicyFromEnv(envFile: string, keydDir: string): KeydPolicy | null {
  const target = join(keydDir, "policy.json");
  if (existsSync(target)) return JSON.parse(readFileSync(target, "utf8")) as KeydPolicy;
  if (!existsSync(envFile)) return null;
  const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("FLAGSHIP_SUBDOMAIN="));
  const fqdn = line?.slice("FLAGSHIP_SUBDOMAIN=".length).trim().toLowerCase();
  if (!fqdn || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(fqdn) || accountZoneOf(fqdn) === null) return null;
  mkdirSync(keydDir, { recursive: true, mode: 0o700 });
  writeFileSync(`${target}.tmp`, JSON.stringify({ serverFqdn: fqdn }), { mode: 0o400 });
  renameSync(`${target}.tmp`, target);
  return { serverFqdn: fqdn };
}

export function loadPolicy(keydDir: string): KeydPolicy | null {
  const target = join(keydDir, "policy.json");
  if (!existsSync(target)) return null;
  const p = JSON.parse(readFileSync(target, "utf8")) as Partial<KeydPolicy>;
  return typeof p.serverFqdn === "string" ? { serverFqdn: p.serverFqdn } : null;
}

/**
 * The names this box's certificate keys may cover: its own name, everything under it, and the account's
 * app names (`*.<user>.<apex>`, which the box only gets a certificate for with the admin's grant, checked
 * by `.com` on the challenge: serverWildcardGrant.ts in the daemon).
 */
export function namesFor(fqdn: string, apexes: readonly string[] = SERVICES_APEXES): string[] {
  const account = accountZoneOf(fqdn, apexes);
  return account ? [fqdn, `*.${fqdn}`, `*.${account}`] : [];
}

/** The data-plane apexes a box name may sit under: production, and the test gym's. */
export const SERVICES_APEXES: readonly string[] = ["flagship.services", "gym.flagship.services"];
const SERVER_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const USER_LABEL = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * `<user>.<apex>` for a box name of exactly the shape `<server>.<user>.<apex>` under one of the
 * apexes, or null. keyd derives the account's wildcard from it, so a name one label short (or any
 * other shape) yields no names at all rather than a wildcard over the whole apex.
 */
export function accountZoneOf(fqdn: string, apexes: readonly string[] = SERVICES_APEXES): string | null {
  for (const apex of apexes) {
    if (!fqdn.endsWith(`.${apex}`)) continue;
    const labels = fqdn.slice(0, -apex.length - 1).split(".");
    if (labels.length !== 2) continue;
    const [server, user] = labels as [string, string];
    if (SERVER_LABEL.test(server) && USER_LABEL.test(user) && !user.includes("--")) return `${user}.${apex}`;
  }
  return null;
}

/** The PEM files an upgraded box already serves with, if any (the daemon's persistent ACME store). */
export function legacyTlsFiles(legacyDir: string, fqdn: string): { keyPath: string; certPath: string } | null {
  const base = join(legacyDir, "acme", "cert", fqdn.replace(/[^a-z0-9.-]/g, "_"));
  const keyPath = `${base}.key`;
  const certPath = `${base}.pem`;
  return existsSync(keyPath) && existsSync(certPath) ? { keyPath, certPath } : null;
}

/** The owner key root keyd checks a sealed SWK/CGK delivery against (`owner.json`). */
export interface KeydOwnerAnchor {
  irkPubHex: string;
  /** The admin root from the box's config (`adminRootPubHex`), when the account has one. */
  adminRootPubHex?: string;
}

/**
 * Pin the owner's account key (IRK) in keyd's state, from root's own copy of the box's config:
 * `/etc/flagship/server.json` (`irkPublicKey`) when there is one, else the install blob's
 * `authCode.userPubKey`. Run as root at every keyd start (the boot ceremony), so a process on the
 * keyd socket can never choose the key a delivery must be signed by. Returns the anchor or null.
 */
export function writeOwnerAnchorFromConfig(
  sources: { serverJson: string; installBlob: string },
  keydDir: string,
): KeydOwnerAnchor | null {
  const read = (p: string): Record<string, unknown> | null => {
    try {
      return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const hex32 = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : null);
  const cfg = read(sources.serverJson);
  const blob = read(sources.installBlob);
  const irk = hex32(cfg?.irkPublicKey) ?? hex32((blob?.authCode as Record<string, unknown> | undefined)?.userPubKey);
  if (!irk) return null;
  // The pinned admin root rides inside the signed AuthCode as `adminRootPubKey` (the daemon reads the same field); a
  // sibling `adminRootPubHex` is the cloud-init/demo spelling. Missing it leaves keyd without the key that signs grants
  // and rank orders, so it would sign no `master` at all.
  const code = blob?.authCode as Record<string, unknown> | undefined;
  const root = hex32(cfg?.adminRootPubHex) ?? hex32(code?.adminRootPubKey) ?? hex32(code?.adminRootPubHex) ?? hex32(blob?.adminRootPubHex);
  const target = join(keydDir, "owner.json");
  const anchor: KeydOwnerAnchor = root ? { irkPubHex: irk, adminRootPubHex: root } : { irkPubHex: irk };
  if (existsSync(target) && readFileSync(target, "utf8") === JSON.stringify(anchor)) return anchor;
  mkdirSync(keydDir, { recursive: true, mode: 0o700 });
  writeFileSync(`${target}.tmp`, JSON.stringify(anchor), { mode: 0o400 });
  renameSync(`${target}.tmp`, target);
  return anchor;
}

export function loadOwnerAnchor(keydDir: string): KeydOwnerAnchor | null {
  const target = join(keydDir, "owner.json");
  if (!existsSync(target)) return null;
  try {
    const p = JSON.parse(readFileSync(target, "utf8")) as Partial<KeydOwnerAnchor>;
    if (typeof p.irkPubHex !== "string" || !/^[0-9a-f]{64}$/.test(p.irkPubHex)) return null;
    return typeof p.adminRootPubHex === "string" && /^[0-9a-f]{64}$/.test(p.adminRootPubHex)
      ? { irkPubHex: p.irkPubHex, adminRootPubHex: p.adminRootPubHex }
      : { irkPubHex: p.irkPubHex };
  } catch {
    return null;
  }
}

/** Where the boot ceremony's one-time token for raw keys is written (only keyd and root read it). */
export const CEREMONY_TOKEN_FILE = "provision-ceremony.token";
/** How long after keyd starts a raw key may be moved in. */
export const CEREMONY_WINDOW_MS = 10 * 60_000;
