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
