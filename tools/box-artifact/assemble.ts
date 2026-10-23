/**
 * Assemble the box artifact from an already-prepared workspace (SEC-REL-001).
 *
 * The caller (build.ts, in clean CI) has produced: the source tree at an exact
 * commit, the daemon's dependencies installed from the exact lockfile, its
 * packages compiled, and the Node binary taken from the official archive. This
 * module only decides what goes in and writes it deterministically, so the same
 * inputs give the same artifact digest on any builder.
 */
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { buildTar, collectTree, gzipDeterministic, sha256Hex, type TarEntry } from "./tar.js";

/** The only top-level names a box needs at run time. Everything else stays out of the artifact. */
export const APP_TOP_LEVEL: readonly string[] = [
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "LICENSE",
  "installer",
  "scripts",
  "packages",
  "release",
  ".maintainers",
  "node_modules",
];

/** Paths (relative to the app tree) that never go in: tests, caches, editor and VCS state. */
export function skipInApp(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1]!;
  if (parts.includes(".git") || parts.includes(".cache") || base === ".DS_Store") return true;
  if (/\.tsbuildinfo$/.test(base) || /\.test\.(ts|js|mjs)$/.test(base)) return true;
  // Tests of our own packages (not dependencies' folders named test, which some need).
  if (parts[0] === "packages" && parts.length >= 3 && (parts[2] === "tests" || parts[2] === "test-vectors")) return true;
  if (parts[0] === "scripts" && /\.test\.ts$/.test(base)) return true;
  return false;
}

export interface BuildInfo {
  schema: 1;
  commit: string;
  arch: "amd64" | "arm64";
  nodeVersion: string;
  nodeSha256: string;
  lockSha256: string;
  /** SOURCE_DATE_EPOCH: the source commit's time, in seconds. Every file gets it. */
  sourceDateEpoch: number;
}

export interface AssembleInput {
  /** The prepared workspace: the repo at the commit with node_modules installed and packages compiled. */
  appDir: string;
  /** The Node binary taken from the official archive, and its license file. */
  nodeBinary: string;
  nodeLicense?: string;
  /** The static `flagship-unseal` early-boot helper, built in CI for this architecture. */
  unsealBinary?: string;
  /** The static `flagship-tlsd` TLS frontend. */
  tlsdBinary?: string;
  info: BuildInfo;
}

export interface AssembledArtifact {
  tarGz: Buffer;
  sha256: string;
  bytes: number;
  files: number;
}

export function assembleArtifact(input: AssembleInput): AssembledArtifact {
  const root = "flagship";
  const entries: TarEntry[] = [{ kind: "dir", path: root }];

  entries.push({ kind: "dir", path: `${root}/app` });
  for (const name of readdirSync(input.appDir).sort()) {
    if (!APP_TOP_LEVEL.includes(name)) continue;
    const abs = join(input.appDir, name);
    const st = lstatSync(abs);
    const path = `${root}/app/${name}`;
    if (st.isDirectory()) {
      entries.push(...collectTree(abs, path, { skip: (rel) => skipInApp(`${name}/${rel}`), base: name }));
    } else if (st.isFile()) {
      entries.push({ kind: "file", path, data: readFileSync(abs), executable: (st.mode & 0o111) !== 0 });
    }
  }

  entries.push({ kind: "dir", path: `${root}/app/.runtime` });
  entries.push({ kind: "dir", path: `${root}/app/.runtime/node` });
  entries.push({ kind: "dir", path: `${root}/app/.runtime/node/bin` });
  entries.push({ kind: "file", path: `${root}/app/.runtime/node/bin/node`, data: readFileSync(input.nodeBinary), executable: true });
  if (input.nodeLicense) entries.push({ kind: "file", path: `${root}/app/.runtime/node/LICENSE`, data: readFileSync(input.nodeLicense), executable: false });

  if (input.unsealBinary) {
    entries.push({ kind: "file", path: `${root}/app/installer/flagship-unseal`, data: readFileSync(input.unsealBinary), executable: true });
  }

  if (input.tlsdBinary) {
    entries.push({ kind: "file", path: `${root}/app/installer/flagship-tlsd`, data: readFileSync(input.tlsdBinary), executable: true });
  }

  entries.push({
    kind: "file",
    path: `${root}/BUILD-INFO.json`,
    data: new TextEncoder().encode(JSON.stringify(input.info, null, 2) + "\n"),
    executable: false,
  });

  const tar = buildTar(entries, input.info.sourceDateEpoch);
  const tarGz = gzipDeterministic(tar);
  return { tarGz, sha256: sha256Hex(tarGz), bytes: tarGz.length, files: entries.length };
}
