import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { BOX_RELEASE } from "@flagship/protocol";

/**
 * Self-update by signed artifact (SEC-UPD-001, SEC-INSTALL-001). The box never
 * resolves code from git, npm or any package repository: an update downloads the
 * release for one exact commit, hands it to installer/install-box-artifact.sh (which
 * checks the digest, the architecture, the k-of-n release signatures, the
 * anti-rollback sequence and the Node floor BEFORE anything of it runs) and flips
 * /opt/flagship in one atomic rename. A rollback only flips the link back to a
 * release that is already on disk.
 */

export type ArtifactCommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string }>;

/** The verifier refused the artifact: nothing on the box changed. */
export class ArtifactRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactRefusedError";
  }
}

export interface ReleaseSwapper {
  /** Download, verify and switch to the release for `commit`. Throws `ArtifactRefusedError` when refused. */
  install(commit: string): Promise<void>;
  /** Switch back to a release that is already installed. */
  restore(commit: string): Promise<void>;
}

export interface InstalledRelease {
  commit: string;
  arch: string;
  sequence: number;
}

const COMMIT = /^[0-9a-f]{40}$/;
export const MAX_MANIFEST_BYTES = 1 << 20;
export const MAX_ARTIFACT_BYTES = 768 * 1024 * 1024;

function parseInstalled(text: string): InstalledRelease | null {
  try {
    const j = JSON.parse(text) as Partial<InstalledRelease>;
    if (typeof j.commit === "string" && COMMIT.test(j.commit) && typeof j.arch === "string" && Number.isInteger(j.sequence)) {
      return { commit: j.commit, arch: j.arch, sequence: j.sequence as number };
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** The release this box runs, as the installer recorded it (null on a box that was not installed from an artifact). */
export function readInstalledReleaseSync(stateDir = "/var/flagship"): InstalledRelease | null {
  try {
    return parseInstalled(readFileSync(join(stateDir, "artifact-current.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function readInstalledRelease(stateDir = "/var/flagship"): Promise<InstalledRelease | null> {
  return parseInstalled(await readFile(join(stateDir, "artifact-current.json"), "utf8").catch(() => ""));
}

export function nodeArch(arch: string = process.arch): "amd64" | "arm64" {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`unsupported architecture ${arch}`);
}

export interface ArtifactSwapperOptions {
  /** The running release (production: /opt/flagship); its installer/ scripts do the work. */
  repoPath: string;
  runner: ArtifactCommandRunner;
  fetchImpl?: typeof fetch;
  /** Scratch space for the download (production: /var/tmp). */
  workDir?: string;
  arch?: string;
  config?: Pick<typeof BOX_RELEASE, "artifactBase" | "minSequence" | "nodeFloor"> & {
    trust: { keys: readonly string[]; threshold: number };
  };
  onLog?: (m: string) => void;
}

async function download(fetchImpl: typeof fetch, url: string, file: string, maxBytes: number): Promise<void> {
  if (!url.startsWith("https://")) throw new Error("artifact URLs must be https");
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${url}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`download too large: ${declared}`);
  let seen = 0;
  const limited = Readable.fromWeb(res.body as never).map((chunk: Buffer) => {
    seen += chunk.length;
    if (seen > maxBytes) throw new Error("download too large");
    return chunk;
  });
  await pipeline(limited, createWriteStream(file, { mode: 0o600 }));
}

export function buildArtifactSwapper(opts: ArtifactSwapperOptions): ReleaseSwapper {
  const log = opts.onLog ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const work = opts.workDir ?? "/var/tmp";
  const cfg = opts.config ?? BOX_RELEASE;
  const arch = nodeArch(opts.arch);
  return {
    async install(commit) {
      if (!COMMIT.test(commit)) throw new ArtifactRefusedError("the target is not an exact commit");
      const name = `flagship-box-${commit.slice(0, 12)}-${arch}`;
      const dir = join(work, `.flagship-update-${commit.slice(0, 12)}`);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const manifestPath = join(dir, `${name}.manifest.json`);
        const artifactPath = join(dir, `${name}.tar.gz`);
        await download(fetchImpl, `${cfg.artifactBase}/${name}.manifest.json`, manifestPath, MAX_MANIFEST_BYTES);
        await download(fetchImpl, `${cfg.artifactBase}/${name}.tar.gz`, artifactPath, MAX_ARTIFACT_BYTES);
        let digest: string;
        try {
          digest = String(JSON.parse(await readFile(manifestPath, "utf8")).manifest.artifactSha256);
        } catch {
          throw new ArtifactRefusedError("the release manifest has no digest");
        }
        log(`[self-update] verifying ${name}`);
        try {
          await opts.runner("bash", [
            join(opts.repoPath, "installer/install-box-artifact.sh"),
            "--manifest", manifestPath,
            "--artifact", artifactPath,
            "--trust-keys", cfg.trust.keys.join(","),
            "--threshold", String(cfg.trust.threshold),
            "--expect-sha256", digest,
            "--expect-commit", commit,
            "--arch", arch,
            "--node-floor", cfg.nodeFloor,
            "--min-sequence", String(cfg.minSequence),
          ]);
        } catch (e) {
          const code = (e as { code?: unknown }).code;
          if (code === 1) throw new ArtifactRefusedError(`the release was refused: ${(e as Error).message}`);
          throw e;
        }
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
    async restore(commit) {
      if (!COMMIT.test(commit)) throw new Error("rollback target is not an exact commit");
      await opts.runner("bash", [join(opts.repoPath, "installer/rollback-box-artifact.sh"), commit]);
    },
  };
}
