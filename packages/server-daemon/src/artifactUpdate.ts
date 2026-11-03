import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { writeFile } from "node:fs/promises";
import { BOX_ARTIFACT_PQ_PIN, BOX_RELEASE, boxArtifactPqPinConfigured, verifyRuntimeManifest, type RuntimeManifest, type RuntimeManifestSignature } from "@flagship/protocol";

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
  /**
   * Where the signed runtime manifest is published (G2). Default: `/api/runtime/manifest` on the artifact host's
   * origin. `null` turns the runtime-manifest check off for this swapper.
   */
  runtimeManifestUrl?: string | null;
  now?: () => number;
}

/** The fixed name privd/the broker copy in (packages/privd/src/policy.ts RUNTIME_MANIFEST_FILE). */
export const RUNTIME_MANIFEST_FILE = "runtime-manifest.json";
export const MAX_RUNTIME_MANIFEST_BYTES = 256 * 1024;

type RuntimeTrust = { keys: string[]; threshold: number; pq?: { keyIds?: string[]; legacyManifests?: string[] } };

/**
 * Whether the published runtime manifest goes to the installer (release plan G2; owner decision 2026-11-02). THE RULE:
 * a manifest that verifies under this release's own trust and has not expired is passed, and the root updater then
 * refuses (exit 1, nothing changed) a release whose runtime lock that manifest does not accept, or a manifest older
 * than one the box already accepted. Anything else (nothing published: 204; `.com` unreachable; unreadable; a bad
 * signature; expired, e.g. the owner did not re-sign in time) is NOT passed, and the artifact's own signed runtime
 * lock decides, exactly as before the manifest existed. A missing or stale manifest therefore never stops an
 * update, a rollback, a boot or the update guard; only a valid, current manifest that disagrees refuses an update.
 */
export function pickRuntimeManifest(body: string | null, trust: RuntimeTrust | null, now: number): { pass: true } | { pass: false; why: string } {
  if (body === null) return { pass: false, why: "none is published, or .com did not answer" };
  if (!trust) return { pass: false, why: "this release pins no release trust" };
  let doc: { manifest: RuntimeManifest; signatures: RuntimeManifestSignature[]; pqBindings?: unknown[]; lockJson: string };
  try {
    doc = JSON.parse(body);
    if (!doc || typeof doc !== "object" || !doc.manifest || !Array.isArray(doc.signatures) || typeof doc.lockJson !== "string") throw new Error("shape");
  } catch {
    return { pass: false, why: "the published one is unreadable" };
  }
  let signers: string[] = [];
  try {
    signers = ((JSON.parse(doc.lockJson) as { keyring?: { signers?: { fingerprint: string }[] } }).keyring?.signers ?? []).map((s) => s.fingerprint);
  } catch {
    return { pass: false, why: "the published one carries an unreadable lock" };
  }
  const r = verifyRuntimeManifest(doc.manifest, doc.signatures, {
    trust: { keys: trust.keys, threshold: trust.threshold },
    ...(trust.pq ? { pqPin: { version: 1 as const, keyIds: trust.pq.keyIds ?? [], legacyManifests: trust.pq.legacyManifests ?? [] } } : {}),
    pqBindings: doc.pqBindings ?? [],
    lockText: doc.lockJson,
    lockSigners: signers,
    now,
  });
  if (!r.ok) return { pass: false, why: r.code === "expired" ? `the published one expired at ${new Date(doc.manifest.validUntil).toISOString()}` : `the published one does not verify (${r.code})` };
  return { pass: true };
}

async function fetchRuntimeManifest(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 204 || !res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_RUNTIME_MANIFEST_BYTES) return null;
  return text;
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
  const runtimeUrl = opts.runtimeManifestUrl === undefined ? `${new URL(cfg.artifactBase).origin}/api/runtime/manifest` : opts.runtimeManifestUrl;
  const readTrust = (): RuntimeTrust | null => {
    try {
      return JSON.parse(readFileSync(join(opts.repoPath, "release/box-artifact-trust.json"), "utf8")) as RuntimeTrust;
    } catch {
      return null;
    }
  };
  /** Puts the runtime manifest beside the artifact when the rule says so; the installer flags to add. Never throws. */
  async function stageRuntimeManifest(dir: string): Promise<string[]> {
    if (!runtimeUrl) return [];
    const body = await fetchRuntimeManifest(fetchImpl, runtimeUrl).catch(() => null);
    const pick = pickRuntimeManifest(body, readTrust(), (opts.now ?? Date.now)());
    if (!pick.pass) {
      log(`[self-update] runtime manifest not checked: ${pick.why}; the release's own signed runtime lock decides`);
      return [];
    }
    const path = join(dir, RUNTIME_MANIFEST_FILE);
    await writeFile(path, body!, { mode: 0o600 });
    log(`[self-update] runtime manifest checked by the installer: it must accept the release's runtime lock`);
    return ["--runtime-manifest", path];
  }
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
        const runtimeFlags = await stageRuntimeManifest(dir);
        log(`[self-update] verifying ${name}`);
        try {
          const out = await opts.runner("bash", [
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
            ...(boxArtifactPqPinConfigured(BOX_ARTIFACT_PQ_PIN)
              ? ["--pq-key-ids", BOX_ARTIFACT_PQ_PIN.keyIds.join(","), ...(BOX_ARTIFACT_PQ_PIN.legacyManifests.length ? ["--legacy-manifests", BOX_ARTIFACT_PQ_PIN.legacyManifests.join(",")] : [])]
              : []),
            ...runtimeFlags,
          ]);
          // "installed: <commit> <arch> sequence <n>", with "(flagship-updater)" when the Rust updater did it.
          const said = out?.stdout?.trim().split("\n").pop();
          if (said) log(`[self-update] ${said.slice(0, 200)}`);
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
