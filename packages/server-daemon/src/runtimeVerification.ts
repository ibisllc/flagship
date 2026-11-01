/**
 * The owner-facing runtime verification view (release plan G2, Appendix G §3): which Node this box runs, where it
 * officially comes from, the checksum Flagship publishes for it at flagshipserver.com (signed by the release keys,
 * verified here against the trust this release pins, never against anything the site sends), the checksum computed
 * here from the executable that is actually running, and whether the two signatures (Node's and Flagship's) hold.
 *
 * Display only: nothing here installs, stops or changes a runtime. A failed fetch keeps the last manifest this box
 * accepted (so the view still says what it said, until it expires); a lower sequence, or another manifest under an
 * accepted sequence, is reported as `rollback` and never replaces the accepted one.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkReleaseLock,
  canonicalRuntimeManifest,
  verifyRuntimeManifest,
  type RuntimeManifest,
  type RuntimeManifestSignature,
} from "@flagship/protocol";
import { readStateFile, writeFileDurable } from "./durableFile.js";

export type FlagshipSignatureStatus =
  | "verified"
  | "not-published"
  | "unavailable"
  | "expired"
  | "rollback"
  | "not-enough-signatures"
  | "pq-signature-required"
  | "lock-mismatch"
  | "signer-revoked"
  | "bad-manifest"
  | "bad-trust"
  | "runtime-manifest-mismatch"
  | "runtime-below-floor";

export interface RuntimeVerificationView {
  runtime: "node";
  /** The version this release locks. */
  version: string;
  /** The version of the Node that is running now. */
  activeVersion: string;
  /** `linux-amd64` or `linux-arm64`. */
  target: string;
  /** The official archive, and the upstream release folder with its signed SHASUMS256.txt. */
  officialUrl: string;
  sourceUrl: string;
  shasumsUrl: string;
  archiveFile: string;
  expectedArchiveSha256: string;
  expectedExecutableSha256: string;
  /** Where the running executable is, for the owner's own `sha256sum`. */
  executablePath: string;
  /** SHA-256 of the running executable, computed on this box; null until computed or when unreadable. */
  localExecutableSha256: string | null;
  /** The running executable is exactly the one the lock names. */
  matchesLock: boolean;
  /** Node's PGP signature over SHASUMS256.txt: checked when this release was built, with this key. */
  upstream: { status: "verified-at-release" | "unknown"; signer: string | null };
  flagship: {
    status: FlagshipSignatureStatus;
    /** The archive checksum the signed manifest gives for this target. */
    expectedArchiveSha256?: string;
    sequence?: number;
    release?: string;
    version?: string;
    validUntil?: number;
    /** The manifest names this release's own lock (false: this release locks a newer runtime). */
    matchesLock?: boolean;
    checkedAt?: number;
  };
  lockSha256: string;
  pageUrl: string;
  manifestUrl: string;
}

interface Doc {
  manifest: RuntimeManifest;
  signatures: RuntimeManifestSignature[];
  pqBindings?: unknown[];
  lockJson: string;
}

interface Lock {
  version: string;
  upstream: { base: string; shasums: string };
  keyring?: { signers?: { fingerprint: string }[] };
  targets: Record<string, { file: string; sha256: string; executableSha256: string }>;
}

export interface RuntimeVerificationOptions {
  repoPath: string;
  dataDir: string;
  /** e.g. https://flagshipserver.com */
  controlBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  execPath?: string;
  arch?: string;
  activeVersion?: string;
  log?: (m: string) => void;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const digestOf = (d: Doc): string => createHash("sha256").update(canonicalRuntimeManifest(d.manifest)).digest("hex");

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

export class RuntimeVerification {
  private readonly lockText: string;
  private readonly lock: Lock;
  private readonly target: string;
  private readonly trust: { keys: string[]; threshold: number; pq?: { keyIds?: string[]; legacyManifests?: string[] } };
  private readonly statePath: string;
  private readonly now: () => number;
  private local: { key: string; sha: string } | null = null;
  private accepted: Doc | null = null;
  private status: FlagshipSignatureStatus = "unavailable";
  private checkedAt: number | undefined;

  private constructor(private readonly o: RuntimeVerificationOptions, lockText: string) {
    this.lockText = lockText;
    this.lock = JSON.parse(lockText) as Lock;
    this.target = `linux-${(o.arch ?? process.arch) === "arm64" ? "arm64" : "amd64"}`;
    this.trust = JSON.parse(readFileSync(join(o.repoPath, "release/box-artifact-trust.json"), "utf8"));
    this.statePath = join(o.dataDir, "runtime-manifest.json");
    this.now = o.now ?? Date.now;
  }

  /** Null when this release carries no runtime lock (older releases) or no release trust. */
  static open(o: RuntimeVerificationOptions): RuntimeVerification | null {
    try {
      return new RuntimeVerification(o, readFileSync(join(o.repoPath, "release/runtime-lock.json"), "utf8"));
    } catch {
      return null;
    }
  }

  private get pageBase(): string {
    return this.o.controlBaseUrl.replace(/\/+$/, "");
  }

  view(): RuntimeVerificationView | null {
    const t = this.lock.targets[this.target];
    if (!t) return null;
    const doc = this.accepted;
    const published = doc ? (JSON.parse(doc.lockJson) as Lock).targets[this.target] : undefined;
    return {
      runtime: "node",
      version: this.lock.version,
      activeVersion: this.o.activeVersion ?? process.versions.node,
      target: this.target,
      officialUrl: this.lock.upstream.base + t.file,
      sourceUrl: this.lock.upstream.base,
      shasumsUrl: this.lock.upstream.base + this.lock.upstream.shasums,
      archiveFile: t.file,
      expectedArchiveSha256: t.sha256,
      expectedExecutableSha256: t.executableSha256,
      executablePath: this.o.execPath ?? process.execPath,
      localExecutableSha256: this.local?.sha ?? null,
      matchesLock: this.local?.sha === t.executableSha256,
      upstream: { status: t.sha256 ? "verified-at-release" : "unknown", signer: this.lock.keyring?.signers?.[0]?.fingerprint ?? null },
      flagship: {
        status: this.status,
        ...(doc
          ? {
              ...(published ? { expectedArchiveSha256: published.sha256 } : {}),
              sequence: doc.manifest.sequence,
              release: doc.manifest.release,
              version: doc.manifest.version,
              validUntil: doc.manifest.validUntil,
              matchesLock: doc.manifest.lockSha256 === sha256(this.lockText),
            }
          : {}),
        ...(this.checkedAt !== undefined ? { checkedAt: this.checkedAt } : {}),
      },
      lockSha256: sha256(this.lockText),
      pageUrl: `${this.pageBase}/runtime`,
      manifestUrl: `${this.pageBase}/api/runtime/manifest`,
    };
  }

  /** Hashes the running executable again when its size or time changed. */
  async hashLocal(): Promise<void> {
    const path = this.o.execPath ?? process.execPath;
    try {
      const st = statSync(path);
      const key = `${path}|${st.size}|${st.mtimeMs}`;
      if (this.local?.key === key) return;
      this.local = { key, sha: await hashFile(path) };
    } catch {
      this.local = null;
    }
  }

  private verify(doc: Doc): ReturnType<typeof verifyRuntimeManifest> {
    const lock = JSON.parse(doc.lockJson) as Lock;
    return verifyRuntimeManifest(doc.manifest, doc.signatures, {
      trust: { keys: this.trust.keys, threshold: this.trust.threshold },
      ...(this.trust.pq ? { pqPin: { version: 1 as const, keyIds: this.trust.pq.keyIds ?? [], legacyManifests: this.trust.pq.legacyManifests ?? [] } } : {}),
      pqBindings: doc.pqBindings ?? [],
      lockText: doc.lockJson,
      lockSigners: (lock.keyring?.signers ?? []).map((s) => s.fingerprint),
      now: this.now(),
    });
  }

  /** The accepted manifest's standing now: expiry and this release's lock. */
  private standing(doc: Doc): FlagshipSignatureStatus {
    const r = this.verify(doc);
    if (!r.ok) return r.code;
    const b = checkReleaseLock(doc.manifest, {
      lockText: this.lockText,
      version: this.lock.version,
      signers: (this.lock.keyring?.signers ?? []).map((s) => s.fingerprint),
    });
    return b.ok ? "verified" : b.code;
  }

  private async loadAccepted(): Promise<void> {
    if (this.accepted) return;
    const r = await readStateFile(this.statePath).catch(() => null);
    if (r && r.kind === "ok") {
      try {
        this.accepted = JSON.parse(r.text) as Doc;
      } catch {
        this.accepted = null;
      }
    }
  }

  /** Fetches the published manifest and updates what the view says. Never throws. */
  async refresh(): Promise<void> {
    await this.hashLocal();
    await this.loadAccepted();
    this.checkedAt = this.now();
    let fetched: Doc | null | "none" = null;
    try {
      const res = await (this.o.fetchImpl ?? fetch)(`${this.pageBase}/api/runtime/manifest`, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 204) fetched = "none";
      else if (res.ok) fetched = (await res.json()) as Doc;
    } catch (e) {
      this.o.log?.(`[runtime] the published runtime manifest could not be fetched: ${(e as Error).message}`);
    }
    if (fetched === "none" && !this.accepted) {
      this.status = "not-published";
      return;
    }
    if (fetched && fetched !== "none") {
      const r = this.verify(fetched);
      if (!r.ok) {
        this.status = r.code;
        return;
      }
      const last = this.accepted;
      if (last) {
        const same = digestOf(fetched);
        const lastDigest = digestOf(last);
        if (fetched.manifest.sequence < last.manifest.sequence || (fetched.manifest.sequence === last.manifest.sequence && same !== lastDigest)) {
          this.status = "rollback";
          return;
        }
      }
      if (!last || fetched.manifest.sequence > last.manifest.sequence) {
        this.accepted = fetched;
        await writeFileDurable(this.statePath, JSON.stringify(fetched), 0o644).catch(() => {});
      }
    }
    this.status = this.accepted ? this.standing(this.accepted) : "unavailable";
  }

  /** Refreshes now (after `firstDelayMs`) and every `everyMs`; timers never hold the process open. */
  start(firstDelayMs = 30_000, everyMs = 12 * 3_600_000): () => void {
    const run = () => void this.refresh().catch(() => {});
    const first = setTimeout(run, firstDelayMs);
    const every = setInterval(run, everyMs);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }
}
