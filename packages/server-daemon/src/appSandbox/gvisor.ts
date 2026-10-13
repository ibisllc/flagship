/**
 * gVisor for every app (docs/app-runtimes.md §5.1). The box downloads one
 * pinned gVisor release, checks it against the SHA-512 this release names,
 * registers `runsc` with dockerd, and proves it runs a container before any
 * app is started on it. Every app container then runs in its own gVisor
 * sandbox: its system calls reach gVisor's user-space kernel, not the host's.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { CommandRunner } from "../serviceRunner.js";

export const GVISOR_RELEASE = "20260921.0";

/** SHA-512 of each architecture's `gvisor.tar.zstd` for GVISOR_RELEASE. */
export const GVISOR_SHA512: Readonly<Record<"x86_64" | "aarch64", string>> = {
  x86_64: "66a5b17354690ec2e4037b54080eeabde55a1503779ceb823d73856283a6836953e105493d7e38fb2dcf85e5c86e0f48c66a9abb0244a78bd612df938702475c",
  aarch64: "bac6a20f57b71c66538f9d33fb71e05c025bd1a420ed0c3afef58e0cde14273604a67411b886a1aae468de268dff66021ab7373f977a5715c6ab6f5ab62331fe",
};

export const GVISOR_RUNTIME = "runsc";
export const GVISOR_BASE_DIR = "/usr/local/lib/flagship-gvisor";
export const DOCKER_DAEMON_JSON = "/etc/docker/daemon.json";

export function gvisorArch(nodeArch: string = process.arch): "x86_64" | "aarch64" | null {
  return nodeArch === "x64" ? "x86_64" : nodeArch === "arm64" ? "aarch64" : null;
}

export function gvisorUrl(arch: "x86_64" | "aarch64"): string {
  return `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${arch}/gvisor.tar.zstd`;
}

export type GvisorResult = { ok: true; version: string; runscPath: string } | { ok: false; reason: string };

export interface EnsureGvisorOptions {
  cmd: Required<CommandRunner>;
  /** A pinned, already-present image to prove the sandbox with. */
  probeImage: string;
  baseDir?: string;
  daemonJson?: string;
  arch?: "x86_64" | "aarch64" | null;
  /** In place of GVISOR_SHA512 (tests). */
  pinnedSha512?: string;
  fetch?: (url: string) => Promise<Response>;
  /** Unpack the tarball into `dir` (default `tar --zstd`, installing zstd when missing). */
  extract?: (tarball: string, dir: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
}

interface Marker {
  release: string;
  tarSha512: string;
  runscSha256: string;
}

export async function ensureGvisor(o: EnsureGvisorOptions): Promise<GvisorResult> {
  const log = o.log ?? (() => {});
  const arch = o.arch === undefined ? gvisorArch() : o.arch;
  if (!arch) return { ok: false, reason: `gVisor isn't available for this processor (${process.arch})` };
  const base = o.baseDir ?? GVISOR_BASE_DIR;
  const dir = join(base, GVISOR_RELEASE);
  const runsc = join(dir, "runsc");
  const want = o.pinnedSha512 ?? GVISOR_SHA512[arch];
  try {
    if (!(await installedIntact(dir, want))) {
      log(`[app-sandbox] installing gVisor ${GVISOR_RELEASE} (${arch})`);
      await install(o, arch, base, dir, want);
    }
    const version = (await o.cmd.capture(runsc, ["--version"], { timeoutMs: 15_000 })).stdout.split("\n")[0]?.trim() || GVISOR_RELEASE;
    await registerWithDocker(o, runsc);
    await probe(o);
    await pruneOtherReleases(base);
    return { ok: true, version, runscPath: runsc };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

async function installedIntact(dir: string, tarSha512: string): Promise<boolean> {
  try {
    const m = JSON.parse(await readFile(join(dir, ".flagship-verified"), "utf8")) as Marker;
    return m.release === GVISOR_RELEASE && m.tarSha512 === tarSha512 && (await sha("sha256", join(dir, "runsc"))) === m.runscSha256;
  } catch {
    return false;
  }
}

async function install(o: EnsureGvisorOptions, arch: "x86_64" | "aarch64", base: string, dir: string, want: string): Promise<void> {
  await mkdir(base, { recursive: true, mode: 0o755 });
  const tmp = join(base, `.download-${process.pid}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  try {
    const tarball = join(tmp, "gvisor.tar.zstd");
    const res = await (o.fetch ?? ((u: string) => fetch(u, { signal: AbortSignal.timeout(15 * 60_000) })))(gvisorUrl(arch));
    if (!res.ok || !res.body) throw new Error(`couldn't download gVisor (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(tarball, { mode: 0o600 }));
    const got = await sha("sha512", tarball);
    if (got !== want) throw new Error("the gVisor download doesn't match the checksum this release pins");
    const out = join(tmp, "out");
    await mkdir(out, { mode: 0o755 });
    await (o.extract ?? ((t, d) => extractWithTar(o.cmd, t, d)))(tarball, out);
    const runsc = join(out, "runsc");
    await chmod(runsc, 0o755);
    const marker: Marker = { release: GVISOR_RELEASE, tarSha512: want, runscSha256: await sha("sha256", runsc) };
    await writeFile(join(out, ".flagship-verified"), JSON.stringify(marker));
    await rm(dir, { recursive: true, force: true });
    await rename(out, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function extractWithTar(cmd: Required<CommandRunner>, tarball: string, dir: string): Promise<void> {
  const hasZstd = await cmd.capture("zstd", ["--version"], { timeoutMs: 10_000 }).then(
    () => true,
    () => false,
  );
  if (!hasZstd) {
    await cmd.run("env", ["DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", "zstd"], {
      timeoutMs: 10 * 60_000,
    });
  }
  await cmd.run("tar", ["--zstd", "-xf", tarball, "-C", dir, "--no-same-owner"], { timeoutMs: 5 * 60_000 });
}

/** Add `runsc` to dockerd's runtimes, keeping everything else in daemon.json. */
async function registerWithDocker(o: EnsureGvisorOptions, runsc: string): Promise<void> {
  const path = o.daemonJson ?? DOCKER_DAEMON_JSON;
  let cfg: Record<string, unknown> = {};
  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text !== null && text.trim() !== "") {
    try {
      cfg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`${path} isn't valid JSON, so gVisor can't be registered with Docker`);
    }
    if (typeof cfg !== "object" || cfg === null || Array.isArray(cfg)) throw new Error(`${path} isn't a JSON object`);
  }
  const runtimes = (cfg.runtimes ?? {}) as Record<string, unknown>;
  const want = { path: runsc };
  if (JSON.stringify(runtimes[GVISOR_RUNTIME]) !== JSON.stringify(want)) {
    cfg.runtimes = { ...runtimes, [GVISOR_RUNTIME]: want };
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(`${path}.flagship-tmp`, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o644 });
    await rename(`${path}.flagship-tmp`, path);
    // A reload (SIGHUP) picks up runtimes without stopping any container.
    await o.cmd.run("systemctl", ["reload", "docker"], { timeoutMs: 30_000 });
  }
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 30; i++) {
    const out = await o.cmd
      .capture("docker", ["info", "--format", "{{json .Runtimes}}"], { timeoutMs: 15_000 })
      .then((r) => r.stdout, () => "");
    if (out.includes(`"${GVISOR_RUNTIME}"`)) return;
    await sleep(1_000);
  }
  throw new Error("Docker didn't pick up the gVisor runtime");
}

/** Run one throwaway container under gVisor, locked down like an app. */
async function probe(o: EnsureGvisorOptions): Promise<void> {
  try {
    await o.cmd.capture(
      "docker",
      [
        "run",
        "--rm",
        `--runtime=${GVISOR_RUNTIME}`,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--entrypoint",
        "true",
        o.probeImage,
      ],
      { timeoutMs: 120_000 },
    );
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const why = (err.stderr ?? err.message).trim().split("\n").slice(-3).join(" ").slice(0, 400);
    throw new Error(`gVisor couldn't run a container on this server: ${why}`);
  }
}

async function pruneOtherReleases(base: string): Promise<void> {
  for (const name of await readdir(base).catch(() => [] as string[])) {
    if (name !== GVISOR_RELEASE) await rm(join(base, name), { recursive: true, force: true }).catch(() => {});
  }
}

async function sha(alg: "sha256" | "sha512", path: string): Promise<string> {
  const h = createHash(alg);
  await pipeline(createReadStream(path), async function* (src: AsyncIterable<Buffer>) {
    for await (const d of src) h.update(d);
  });
  return h.digest("hex");
}
