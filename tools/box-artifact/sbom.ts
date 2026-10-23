/**
 * A small software bill of materials taken straight from package-lock.json: every
 * package, its exact version and its integrity hash, in a stable order. It is
 * what the lockfile says was installed, not a scan, and its SHA-256 goes into
 * the signed manifest.
 */
import { createHash } from "node:crypto";

interface LockPackage {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
}

export interface Sbom {
  bomFormat: "flagship-lock-sbom";
  schema: 1;
  lockSha256: string;
  components: Array<{ path: string; name: string; version: string; integrity: string | null; resolved: string | null }>;
}

export function buildSbom(lockText: string): Sbom {
  const lock = JSON.parse(lockText) as { packages?: Record<string, LockPackage> };
  const components: Sbom["components"] = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (path === "" || p.link || !p.version) continue;
    const idx = path.lastIndexOf("node_modules/");
    // A path outside node_modules is one of our own workspace packages: its code is in the commit, not fetched.
    if (idx < 0) continue;
    const name = path.slice(idx + "node_modules/".length);
    components.push({ path, name, version: p.version, integrity: p.integrity ?? null, resolved: p.resolved ?? null });
  }
  components.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { bomFormat: "flagship-lock-sbom", schema: 1, lockSha256: createHash("sha256").update(lockText).digest("hex"), components };
}

/** Every component should come with an integrity hash; the build refuses one that does not. */
export function componentsWithoutIntegrity(s: Sbom): string[] {
  return s.components.filter((c) => !c.integrity).map((c) => `${c.name}@${c.version}`);
}
