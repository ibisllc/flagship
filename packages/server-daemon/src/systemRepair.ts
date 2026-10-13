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
import { createGunzip } from "node:zlib";
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

export interface AptSource {
  /** Archive base URLs, `mirror+file:` lists expanded (Debian's cloud images use them). */
  uris: string[];
  suites: string[];
  components: string[];
  /** Keyring files the archive must be signed by; empty = apt's default keyrings. */
  signedBy: string[];
}

async function expandUris(uris: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const u of uris) {
    const mirror = /^mirror\+file:(?:\/\/)?(\/.+)$/.exec(u);
    for (const v of mirror ? (await lines(mirror[1]!)).map((l) => l.split(/\s+/)[0]!) : [u]) {
      if (/^https?:\/\//.test(v)) out.push(v.replace(/\/+$/, ""));
    }
  }
  return [...new Set(out)];
}

const paths = (v: string | undefined) => (v ?? "").split(/[\s,]+/).filter((x) => x.startsWith("/"));

/** apt's binary-package sources, from `sources.list` and `sources.list.d/` (one-line and deb822). */
export async function aptSources(aptDir: string): Promise<AptSource[]> {
  const out: AptSource[] = [];
  const d = join(aptDir, "sources.list.d");
  const files = [join(aptDir, "sources.list"), ...(await readdir(d).catch(() => [] as string[])).sort().map((f) => join(d, f))];
  for (const f of files) {
    if (f.endsWith(".sources")) {
      const text = await readFile(f, "utf8").catch(() => "");
      for (const block of text.split(/\n\s*\n/)) {
        const fields: Record<string, string> = {};
        let last = "";
        for (const raw of block.split("\n")) {
          if (raw.startsWith("#")) continue;
          if (/^\s/.test(raw)) {
            if (last) fields[last] += `\n${raw.trim()}`;
            continue;
          }
          const i = raw.indexOf(":");
          if (i > 0) fields[(last = raw.slice(0, i).trim().toLowerCase())] = raw.slice(i + 1).trim();
        }
        if (!(fields.types ?? "").split(/\s+/).includes("deb") || /^(no|false)$/i.test(fields.enabled ?? "")) continue;
        out.push({
          uris: await expandUris((fields.uris ?? "").split(/\s+/).filter(Boolean)),
          suites: (fields.suites ?? "").split(/\s+/).filter(Boolean),
          components: (fields.components ?? "").split(/\s+/).filter(Boolean),
          signedBy: paths(fields["signed-by"]),
        });
      }
    } else if (f.endsWith(".list")) {
      for (const l of await lines(f)) {
        const m = /^deb\s+(?:\[([^\]]*)\]\s+)?(\S+)\s+(\S+)\s*(.*)$/.exec(l);
        if (!m) continue;
        const signed = /signed-by=(\S+)/.exec(m[1] ?? "");
        out.push({ uris: await expandUris([m[2]!]), suites: [m[3]!], components: m[4]!.split(/\s+/).filter(Boolean), signedBy: paths(signed?.[1]) });
      }
    }
  }
  return out.filter((x) => x.uris.length > 0 && x.suites.length > 0);
}

export async function aptArchives(aptDir: string): Promise<string[]> {
  return [...new Set((await aptSources(aptDir)).flatMap((x) => x.uris))];
}

async function defaultKeyrings(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ["/usr/share/keyrings", "/etc/apt/trusted.gpg.d"]) {
    for (const f of (await readdir(dir).catch(() => [] as string[])).sort()) {
      if ((dir.endsWith("trusted.gpg.d") || f.startsWith("debian-archive-")) && /\.(gpg|pgp)$/.test(f) && !f.includes("removed")) out.push(join(dir, f));
    }
  }
  return out;
}

/** sqv (apt's verifier on Debian 13) or gpgv; either checks a detached signature without apt. */
async function verifySignature(cmd: Required<CommandRunner>, keyrings: string[], sig: string, file: string): Promise<void> {
  const keys = keyrings.flatMap((k) => ["--keyring", k]);
  const hasSqv = await cmd.capture("sqv", ["--version"], { timeoutMs: 10_000 }).then(
    () => true,
    () => false,
  );
  await cmd.capture(hasSqv ? "sqv" : "gpgv", [...keys, sig, file], { timeoutMs: 60_000 });
}

/** The SHA-256 section of a Release file: path → {sha256, size}. */
export function parseReleaseSha256(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let inSha = false;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      inSha = line.startsWith("SHA256:");
      continue;
    }
    if (!inSha) continue;
    const m = /^\s+([0-9a-f]{64})\s+\d+\s+(\S+)$/.exec(line);
    if (m) out.set(m[2]!, m[1]!);
  }
  return out;
}

/**
 * Package lists fetched and verified without apt (boxes ship with apt's lists
 * removed, and apt may be among the damaged packages): each suite's Release is
 * checked against its detached signature with the source's keyring, and each
 * Packages.gz against the SHA-256 that Release names.
 */
async function fetchVerifiedLists(o: SystemRepairOptions, sources: AptSource[], archs: string[], into: string, done: () => Promise<boolean>): Promise<string[]> {
  const get = o.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(10 * 60_000) }));
  const problems: string[] = [];
  await mkdir(into, { recursive: true, mode: 0o700 });
  const download = async (url: string, dest: string): Promise<boolean> => {
    const res = await get(url).catch(() => null);
    if (!res?.ok || !res.body) return false;
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(dest, { mode: 0o600 }));
    return true;
  };
  for (const src of sources) {
    const keyrings = src.signedBy.length > 0 ? src.signedBy : await defaultKeyrings();
    for (const suite of src.suites) {
      for (const base of src.uris) {
        const name = `${base.replace(/^https?:\/\//, "").replace(/\//g, "_")}_dists_${suite.replace(/\//g, "_")}`;
        const release = join(into, `${name}_Release`);
        if (!(await download(`${base}/dists/${suite}/Release`, release)) || !(await download(`${base}/dists/${suite}/Release.gpg`, `${release}.gpg`))) {
          problems.push(`${base} ${suite}: couldn't download its Release`);
          continue;
        }
        try {
          await verifySignature(o.cmd, keyrings, `${release}.gpg`, release);
        } catch (e) {
          problems.push(`${base} ${suite}: its signature didn't verify (${(e as Error).message.slice(0, 160)})`);
          continue;
        }
        const index = parseReleaseSha256(await readFile(release, "utf8"));
        for (const comp of src.components) {
          for (const arch of archs) {
            const path = `${comp}/binary-${arch}/Packages.gz`;
            const want = index.get(path);
            if (!want) continue;
            const gz = join(into, `${name}_${comp}_binary-${arch}_Packages.gz`);
            if (!(await download(`${base}/dists/${suite}/${path}`, gz)) || (await sha256(gz)) !== want) {
              problems.push(`${base} ${suite} ${path}: download didn't match its Release`);
              continue;
            }
            await pipeline(createReadStream(gz), createGunzip(), createWriteStream(gz.replace(/\.gz$/, ""), { mode: 0o600 }));
            await rm(gz, { force: true });
          }
        }
        if (await done()) return problems;
        break;
      }
    }
  }
  return problems;
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
  const sourcesList = await aptSources(o.aptDir ?? "/etc/apt");
  const archives = [...new Set(sourcesList.flatMap((x) => x.uris))];
  const key = (w: Wanted) => `${w.pkg} ${w.version} ${w.arch}`;
  const unlisted = (found: Map<string, Source>) => wanted.filter((w) => !found.has(key(w))).map((w) => `${w.pkg} ${w.version}`);

  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  try {
    let sources = await findInLists(listsDir, wanted, archives);
    if (unlisted(sources).length > 0) {
      // Boxes ship without apt's lists, and apt may be among the damaged packages.
      const fetched = join(workDir, "lists");
      const archs = [...new Set(wanted.map((w) => w.arch))];
      log(`[system-repair] fetching Debian's signed package lists`);
      const problems = await fetchVerifiedLists(o, sourcesList, archs, fetched, async () => {
        sources = new Map([...(await findInLists(listsDir, wanted, archives)), ...(await findInLists(fetched, wanted, archives))]);
        return unlisted(sources).length === 0;
      });
      for (const p of problems) log(`[system-repair] ${p}`);
      if (unlisted(sources).length > 0 && problems.length > 0) {
        return { ok: false, packages: pkgs, reason: `damaged system packages couldn't be repaired: Debian's package lists couldn't be fetched (${problems.slice(0, 2).join("; ")})` };
      }
    }
    const left = unlisted(sources);
    if (wanted.length === 0 || left.length > 0) {
      return { ok: false, packages: pkgs, reason: `damaged system packages couldn't be found in the archive to repair them (${left.join(", ") || pkgs.join(", ")})` };
    }

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
    const still = await damagedPackages(o.cmd, pkgs);
    if (still.length > 0) return { ok: false, packages: pkgs, reason: `reinstalling didn't fix ${still.join(", ")}; this server's disk may be failing` };
    // PID 1 keeps running the binary it started with until it re-executes.
    if (pkgs.includes("systemd")) await o.cmd.run("systemctl", ["daemon-reexec"], { timeoutMs: 120_000 }).catch((e: Error) => log(`[system-repair] systemctl daemon-reexec: ${e.message}`));
    return { ok: true, packages: pkgs };
  } catch (e) {
    return { ok: false, packages: pkgs, reason: `reinstalling the damaged system packages failed: ${(e as Error).message}` };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
