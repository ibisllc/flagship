import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// A box installs only `--include-workspace-root --workspace=packages/server-daemon`
// and builds only `tsc -b packages/server-daemon`. That is complete only while
// everything the daemon and the box-run scripts import lies inside that
// closure: a package the full monorepo install happens to hoist from another
// workspace would be missing on the box, and CI (which installs everything)
// would never notice.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BOX_SCRIPTS = ["scripts/install-helper.ts"];

interface Pkg {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface LockEntry {
  name?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
const declared = (p: Pkg) => Object.keys({ ...p.dependencies, ...p.devDependencies });

const workspaces = new Map<string, string>();
for (const d of readdirSync(join(ROOT, "packages"))) {
  try {
    workspaces.set(readJson<Pkg>(`packages/${d}/package.json`).name, `packages/${d}`);
  } catch {
    // not a package
  }
}

function workspaceClosure(): string[] {
  const seen: string[] = [];
  const queue = ["@flagship/server-daemon"];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.includes(name)) continue;
    const dir = workspaces.get(name);
    if (!dir) throw new Error(`${name} is not a workspace under packages/`);
    seen.push(name);
    queue.push(...declared(readJson<Pkg>(`${dir}/package.json`)).filter((n) => n.startsWith("@flagship/")));
  }
  return seen;
}

/** Package names a scoped `npm ci` installs, walked through the lockfile the way node resolves. */
function installedNames(lock: Record<string, LockEntry>, members: string[]): Set<string> {
  const resolve = (from: string, dep: string): string | null => {
    let base = from;
    for (;;) {
      const candidate = base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`;
      if (lock[candidate]) return candidate;
      if (!base) return null;
      const cut = base.lastIndexOf("/node_modules/");
      base = cut === -1 ? "" : base.slice(0, cut);
    }
  };
  const names = new Set<string>();
  const seen = new Set<string>();
  const queue = ["", ...members.map((m) => workspaces.get(m)!)];
  while (queue.length) {
    const loc = queue.shift()!;
    if (seen.has(loc)) continue;
    seen.add(loc);
    const entry = lock[loc]!;
    if (entry.link && entry.resolved) {
      queue.push(entry.resolved);
      continue;
    }
    const isProject = loc === "" || !loc.includes("node_modules/");
    const optionalPeers = new Set(
      Object.entries(entry.peerDependenciesMeta ?? {})
        .filter(([, m]) => m.optional)
        .map(([n]) => n),
    );
    const deps = [
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}).filter((n) => !optionalPeers.has(n)),
      ...(isProject ? Object.keys(entry.devDependencies ?? {}) : []),
    ];
    for (const dep of deps) {
      const at = resolve(loc, dep);
      if (!at) continue;
      names.add(dep);
      queue.push(at);
    }
  }
  return names;
}

function bareImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out = new Set<string>();
  const patterns = [
    /^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const spec = m[1]!;
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      if (builtinModules.includes(spec.split("/")[0]!)) continue;
      const parts = spec.split("/");
      out.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
    }
  }
  return [...out];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|mts|js|mjs)$/.test(n)) out.push(p);
  }
  return out;
}

describe("box install scope — the daemon's workspace closure is self-sufficient", () => {
  const lock = readJson<{ packages: Record<string, LockEntry> }>("package-lock.json").packages;
  const members = workspaceClosure();
  const installed = installedNames(lock, members);

  it("covers the workspaces the daemon links today, and none of the cloud-side ones", () => {
    expect(members).toContain("@flagship/protocol");
    expect(members).not.toContain("@flagship/control-plane");
    expect(members).not.toContain("@flagship/builder");
    expect(installed.has("typescript")).toBe(true);
    expect(installed.has("tsx")).toBe(true);
  });

  it("every linked workspace is a tsc project reference, so tsc -b packages/server-daemon builds it", () => {
    const missing: string[] = [];
    for (const name of members) {
      const dir = workspaces.get(name)!;
      const tsconfig = readJson<{ references?: { path: string }[] }>(`${dir}/tsconfig.json`);
      const refs = (tsconfig.references ?? []).map((r) => join(dir, r.path));
      const deps = declared(readJson<Pkg>(`${dir}/package.json`)).filter((n) => n.startsWith("@flagship/"));
      for (const dep of deps) {
        if (!refs.includes(workspaces.get(dep)!)) missing.push(`${dir}/tsconfig.json lacks a reference to ${dep}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the lockfile links the same closure, so a scoped npm ci installs it", () => {
    for (const name of members) {
      const dir = workspaces.get(name)!;
      const pkgDeps = Object.keys(readJson<Pkg>(`${dir}/package.json`).dependencies ?? {}).sort();
      expect(Object.keys(lock[dir]?.dependencies ?? {}).sort(), dir).toEqual(pkgDeps);
      expect(lock[`node_modules/${name}`], name).toEqual({ resolved: dir, link: true });
    }
  });

  it("every bare import in the closure's sources is installed by the scoped install", () => {
    const missing: string[] = [];
    for (const name of members) {
      const dir = workspaces.get(name)!;
      for (const file of sourceFiles(join(ROOT, dir, "src"))) {
        for (const spec of bareImports(file)) {
          if (spec !== name && !installed.has(spec)) missing.push(`${file.slice(ROOT.length)} imports ${spec}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("the scripts a box runs with tsx import only what the scoped install provides", () => {
    const missing = BOX_SCRIPTS.flatMap((rel) =>
      bareImports(join(ROOT, rel))
        .filter((spec) => !installed.has(spec))
        .map((spec) => `${rel} imports ${spec}`),
    );
    expect(missing).toEqual([]);
  });

  it("the installed set excludes the monorepo's cloud and browser tooling", () => {
    for (const heavy of ["@cloudflare/workers-types", "playwright-core", "@babel/core", "qrcode"]) {
      expect(installed.has(heavy), heavy).toBe(false);
    }
  });
});
