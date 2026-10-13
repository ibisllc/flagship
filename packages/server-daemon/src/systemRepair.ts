/**
 * Putting back operating-system files that an unclean stop (or bad memory)
 * left damaged: dpkg knows the checksum of every file a package installed, and
 * a package with a file that no longer matches is reinstalled at the exact
 * version installed, from a .deb checked against the SHA-256 in apt's package
 * lists (which apt verified against the archive's signature when it fetched
 * them). It goes through dpkg alone, because apt links the very libraries
 * most likely to be the damaged ones.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { CommandRunner } from "./serviceRunner.js";

/** Past this, the disk is too far gone to patch package by package. */
export const MAX_REPAIR_PACKAGES = 80;

export interface SystemRepairOptions {
  cmd: Required<CommandRunner>;
  listsDir?: string;
  /** apt's config dir, for the archives' URLs (`/etc/apt`). */
  aptDir?: string;
  archivesDir?: string;
  workDir?: string;
  fetch?: (url: string) => Promise<Response>;
  log?: (m: string) => void;
}

export type SystemRepair =
  | { ok: true; packages: string[] }
  | { ok: false; reason: string; packages: string[] };

/** Files dpkg says no longer match, outside what images commonly strip. */
const SKIPPED = /^\/usr\/share\/(doc|man|info|locale|lintian)\//;

export function parseDpkgVerify(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\S{9})\s+(c\s+)?(\/.+)$/.exec(line.trimEnd());
    if (!m || m[2] || m[1]![2] !== "5") continue;
    const path = m[3]!;
    if (/^\/(usr|lib|lib64|bin|sbin)\//.test(path) && !SKIPPED.test(path)) files.push(path);
  }
  return files;
}

export function parseDpkgSearch(out: string): string[] {
  const pkgs = new Set<string>();
  for (const line of out.split("\n")) {
    if (line.startsWith("diversion ") || !line.includes(": /")) continue;
    for (const p of line.slice(0, line.indexOf(": /")).split(", ")) pkgs.add(p.split(":")[0]!.trim());
  }
  return [...pkgs].filter((p) => p !== "").sort();
}

async function capture(cmd: Required<CommandRunner>, c: string, args: string[], timeoutMs: number): Promise<string> {
  // dpkg --verify / -S exit non-zero while still printing what they found.
  return cmd.capture(c, args, { timeoutMs }).then(
    (r) => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? "",
  );
}

/** Packages with damaged files: every package, or just `only`. */
export async function damagedPackages(cmd: Required<CommandRunner>, only: string[] = []): Promise<string[]> {
  const files = parseDpkgVerify(await capture(cmd, "dpkg", ["--verify", ...only], 20 * 60_000));
  const pkgs = new Set<string>();
  for (let i = 0; i < files.length; i += 100) {
    for (const p of parseDpkgSearch(await capture(cmd, "dpkg-query", ["-S", ...files.slice(i, i + 100)], 60_000))) pkgs.add(p);
  }
  return [...pkgs].sort();
}

interface Wanted {
  pkg: string;
  version: string;
  arch: string;
}

interface Source {
  urls: string[];
  sha256: string;
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** Every archive URL apt is configured with, `mirror+file:` lists expanded (Debian's cloud images use them). */
export async function aptArchives(aptDir: string): Promise<string[]> {
  const uris: string[] = [];
  const d = join(aptDir, "sources.list.d");
  const files = [join(aptDir, "sources.list"), ...(await readdir(d).catch(() => [] as string[])).map((f) => join(d, f))];
  for (const f of files) {
    for (const l of await lines(f)) {
      if (f.endsWith(".sources") && l.startsWith("URIs:")) uris.push(...l.slice(5).trim().split(/\s+/));
      else if (f.endsWith(".list") && /^deb\s/.test(l)) {
        const u = l.replace(/^deb\s+(\[[^\]]*\]\s+)?/, "").split(/\s+/)[0];
        if (u) uris.push(u);
      }
    }
  }
  const out: string[] = [];
  for (const u of uris) {
    const mirror = /^mirror\+file:(?:\/\/)?(\/.+)$/.exec(u);
    for (const v of mirror ? (await lines(mirror[1]!)).map((l) => l.split(/\s+/)[0]!) : [u]) {
      if (/^https?:\/\//.test(v)) out.push(v.replace(/\/+$/, ""));
    }
  }
  return [...new Set(out)];
}

/**
 * A list file is named after its archive (`deb.debian.org_debian_dists_trixie_main_binary-arm64_Packages`),
 * or after the mirror file that names it (`_etc_apt_mirrors_debian.list_dists_…`).
 */
async function findInLists(listsDir: string, wanted: Wanted[], archives: string[]): Promise<Map<string, Source>> {
  const key = (w: { pkg: string; version: string; arch: string }) => `${w.pkg} ${w.version} ${w.arch}`;
  const need = new Set(wanted.map(key));
  const names = new Set(wanted.map((w) => w.pkg));
  const found = new Map<string, Source>();
  const lists = (await readdir(listsDir).catch(() => [] as string[])).filter((f) => f.endsWith("_Packages") && f.includes("_dists_"));
  for (const list of lists) {
    const named = list.slice(0, list.indexOf("_dists_"));
    const bases = [...(named.startsWith("_") ? [] : [`https://${named.replace(/_/g, "/")}`, `http://${named.replace(/_/g, "/")}`]), ...archives];
    let s: Record<string, string> = {};
    const flush = () => {
      if (s.Package && s.Filename && s.SHA256) {
        const k = key({ pkg: s.Package, version: s.Version ?? "", arch: s.Architecture ?? "" });
        if (need.has(k) && !found.has(k)) {
          found.set(k, { urls: [...new Set(bases.map((b) => `${b}/${s.Filename}`))], sha256: s.SHA256.toLowerCase() });
        }
      }
      s = {};
    };
    let skipping = false;
    const rl = createInterface({ input: createReadStream(join(listsDir, list)), crlfDelay: Infinity });
    for await (const line of rl) {
      if (line === "") {
        flush();
        skipping = false;
        continue;
      }
      if (skipping) continue;
      const i = line.indexOf(": ");
      if (i <= 0 || line.startsWith(" ")) continue;
      const field = line.slice(0, i);
      const value = line.slice(i + 2);
      if (field === "Package" && !names.has(value)) {
        skipping = true;
        continue;
      }
      if (field === "Package" || field === "Version" || field === "Architecture" || field === "Filename" || field === "SHA256") s[field] = value;
    }
    flush();
    if (found.size === need.size) break;
  }
  return found;
}

async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
    for await (const d of src) h.update(d);
  });
  return h.digest("hex");
}

async function fetchDeb(o: SystemRepairOptions, src: Source, dest: string): Promise<boolean> {
  const get = o.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(10 * 60_000) }));
  for (const url of src.urls) {
    try {
      const res = await get(url);
      if (!res.ok || !res.body) continue;
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(dest, { mode: 0o600 }));
      if ((await sha256(dest)) === src.sha256) return true;
    } catch {
      /* try the next mirror URL */
    }
  }
  return false;
}

export async function repairSystemPackages(o: SystemRepairOptions): Promise<SystemRepair> {
  const log = o.log ?? (() => {});
  const listsDir = o.listsDir ?? "/var/lib/apt/lists";
  const archivesDir = o.archivesDir ?? "/var/cache/apt/archives";
  const workDir = o.workDir ?? "/var/cache/flagship-system-repair";
  const pkgs = await damagedPackages(o.cmd);
  if (pkgs.length === 0) return { ok: true, packages: [] };
  log(`[system-repair] damaged files in ${pkgs.length} package(s): ${pkgs.join(", ")}`);
  if (pkgs.length > MAX_REPAIR_PACKAGES) {
    return { ok: false, packages: pkgs, reason: `${pkgs.length} system packages have damaged files; this server's disk is too damaged to repair, so move its apps off and recreate it` };
  }

  const wanted: Wanted[] = [];
  for (const line of (await capture(o.cmd, "dpkg-query", ["-W", "-f", "${Package}\t${Version}\t${Architecture}\n", ...pkgs], 60_000)).split("\n")) {
    const [pkg, version, arch] = line.split("\t");
    if (pkg && version && arch) wanted.push({ pkg, version, arch });
  }
  const archives = await aptArchives(o.aptDir ?? "/etc/apt");
  let sources = await findInLists(listsDir, wanted, archives);
  if (sources.size < wanted.length) {
    // The lists may be missing (images often drop them) or older than the install.
    await o.cmd.run("apt-get", ["update", "-qq"], { timeoutMs: 10 * 60_000 }).catch((e: Error) => log(`[system-repair] apt-get update failed: ${e.message}`));
    sources = await findInLists(listsDir, wanted, archives);
  }
  const key = (w: Wanted) => `${w.pkg} ${w.version} ${w.arch}`;
  const unlisted = wanted.filter((w) => !sources.has(key(w))).map((w) => `${w.pkg} ${w.version}`);
  if (wanted.length === 0 || unlisted.length > 0) {
    return { ok: false, packages: pkgs, reason: `damaged system packages couldn't be found in the archive to repair them (${unlisted.join(", ") || pkgs.join(", ")})` };
  }

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  try {
    const debs: string[] = [];
    const missing: string[] = [];
    for (const w of wanted) {
      const src = sources.get(key(w))!;
      const file = `${w.pkg}_${w.version.replace(/:/g, "%3a")}_${w.arch}.deb`;
      const cached = join(archivesDir, file);
      if ((await sha256(cached).catch(() => "")) === src.sha256) {
        debs.push(cached);
        continue;
      }
      const dest = join(workDir, file);
      if (await fetchDeb(o, src, dest)) debs.push(dest);
      else missing.push(`${w.pkg} ${w.version}`);
    }
    if (missing.length > 0) {
      return { ok: false, packages: pkgs, reason: `damaged system packages couldn't be downloaded to repair them (${missing.join(", ")})` };
    }
    log(`[system-repair] reinstalling ${wanted.map((w) => `${w.pkg} ${w.version}`).join(", ")}`);
    const dpkg = (args: string[]) => o.cmd.run("env", ["DEBIAN_FRONTEND=noninteractive", "dpkg", "--force-confdef", "--force-confold", ...args], { timeoutMs: 20 * 60_000 });
    // A maintainer script can trip over another still-damaged tool after the
    // files are already back; finishing the configure is what matters then.
    await dpkg(["-i", ...debs]).catch(async (e: Error) => {
      log(`[system-repair] dpkg -i: ${e.message}; finishing configuration`);
      await dpkg(["--configure", "-a"]).catch((e2: Error) => log(`[system-repair] dpkg --configure -a: ${e2.message}`));
    });
    await o.cmd.run("sync", [], { timeoutMs: 120_000 }).catch(() => {});
    const left = await damagedPackages(o.cmd, pkgs);
    if (left.length > 0) return { ok: false, packages: pkgs, reason: `reinstalling didn't fix ${left.join(", ")}; this server's disk may be failing` };
    return { ok: true, packages: pkgs };
  } catch (e) {
    return { ok: false, packages: pkgs, reason: `reinstalling the damaged system packages failed: ${(e as Error).message}` };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
