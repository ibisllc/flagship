/**
 * Boxes made from a VM appliance image before the specializer re-encrypted
 * the root share that image's LUKS volume key with every other box made from
 * it (docs/luks-burn-passphrase-removal.md §1 item 5). Re-keying a
 * live box needs a keyslot passphrase, and after boot the box holds none (the
 * disk key lives sealed to the phone), so the box cannot fix itself: it tells
 * the owner, once, in Activity.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { writeFileDurable } from "./durableFile.js";

export const APPLIANCE_SPECIALIZED_FLAG = "/var/flagship/appliance-specialized.flag";
export const APPLIANCE_FACTORY_LUKS_RECORD = "/etc/flagship/appliance-factory-luks.json";
export const APPLIANCE_REKEY_MARKER = "/var/flagship/appliance-rekeyed.json";

export const SHARED_KEY_ACTIVITY_KIND = "server.disk.shared-key";
export const SHARED_KEY_ACTIVITY_DETAIL =
  "This server's disk shares its encryption key with every server made from the same VM image. " +
  "Make a new server, move this one's apps to it with Migrate, then delete this one.";

export type ApplianceDiskKeyVerdict =
  | { state: "not-appliance" }
  | { state: "own-key"; digestSha256: string }
  | { state: "shared-key"; reason: "never-rekeyed" | "factory-digest" }
  | { state: "unknown"; reason: string };

export interface ApplianceDiskKeyDeps {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string | null>;
  /** Output of `cryptsetup luksDump` for the root's LUKS device; null if it cannot be read. */
  rootLuksDump(): Promise<string | null>;
}

/** sha256 of luksDump's Digests section, byte-for-byte what the image's shell `flagship_luks_digest_fp` hashes. */
export function luksDigestFingerprint(dump: string): string | null {
  const lines = dump.split("\n");
  const section: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^Digests:/.test(line)) {
      inside = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) inside = false;
    if (inside) section.push(line);
  }
  // Shell command substitution drops trailing newlines, i.e. trailing empty lines.
  while (section.length && section[section.length - 1] === "") section.pop();
  if (!section.length) return null;
  return createHash("sha256").update(section.join("\n") + "\n").digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

function factoryDigest(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const d = (JSON.parse(raw) as { digestSha256?: unknown }).digestSha256;
    return typeof d === "string" && HEX64.test(d) ? d : null;
  } catch {
    return null;
  }
}

export async function checkApplianceDiskKey(deps: ApplianceDiskKeyDeps): Promise<ApplianceDiskKeyVerdict> {
  if (!(await deps.exists(APPLIANCE_SPECIALIZED_FLAG))) return { state: "not-appliance" };
  // Only a specializer that re-encrypts writes the marker, so a specialized box
  // without one came from an image that never did.
  if (!(await deps.exists(APPLIANCE_REKEY_MARKER))) return { state: "shared-key", reason: "never-rekeyed" };
  const factory = factoryDigest(await deps.readText(APPLIANCE_FACTORY_LUKS_RECORD));
  if (!factory) return { state: "unknown", reason: "factory record unreadable" };
  const dump = await deps.rootLuksDump();
  if (dump === null) return { state: "unknown", reason: "LUKS header unreadable" };
  const current = luksDigestFingerprint(dump);
  if (!current) return { state: "unknown", reason: "LUKS header has no digest" };
  if (current === factory) return { state: "shared-key", reason: "factory-digest" };
  return { state: "own-key", digestSha256: current };
}

function capture(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

export const realApplianceDiskKeyDeps: ApplianceDiskKeyDeps = {
  exists: async (p) => stat(p).then(() => true, () => false),
  readText: async (p) => readFile(p, "utf8").catch(() => null),
  rootLuksDump: async () => {
    const source = (await capture("findmnt", ["-n", "-o", "SOURCE", "/"]))?.trim();
    if (!source || !source.startsWith("/dev/mapper/")) return null;
    const status = await capture("cryptsetup", ["status", source.slice("/dev/mapper/".length)]);
    const device = status?.match(/^\s*device:\s*(\S+)/m)?.[1];
    if (!device) return null;
    return capture("cryptsetup", ["luksDump", device]);
  },
};

export interface SharedKeyWarningOptions {
  deps?: ApplianceDiskKeyDeps;
  /** `<dataDir>/appliance-disk-key-warning.json`: the Activity entry is written once. */
  warnedMarkerPath: string;
  note: (kind: string, detail: string) => void;
  log?: (line: string) => void;
}

export async function warnIfSharedApplianceDiskKey(opts: SharedKeyWarningOptions): Promise<ApplianceDiskKeyVerdict> {
  const deps = opts.deps ?? realApplianceDiskKeyDeps;
  const log = opts.log ?? ((l: string) => console.warn(l));
  const verdict = await checkApplianceDiskKey(deps);
  if (verdict.state === "unknown") log(`[disk-key] could not check the disk's encryption key: ${verdict.reason}`);
  if (verdict.state !== "shared-key") return verdict;
  log(`[disk-key] WARNING: this box's disk uses its VM image's shared encryption key (${verdict.reason})`);
  if (await deps.exists(opts.warnedMarkerPath)) return verdict;
  opts.note(SHARED_KEY_ACTIVITY_KIND, SHARED_KEY_ACTIVITY_DETAIL);
  await writeFileDurable(opts.warnedMarkerPath, JSON.stringify({ version: 1, at: Date.now(), reason: verdict.reason }) + "\n");
  return verdict;
}
