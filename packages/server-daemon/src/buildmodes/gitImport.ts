/**
 * Git build mode — ONE option for the user ("import from a Git repo").
 *
 * The flow forks on whether the repo *declares itself fit for Flagship*:
 *
 *   1. Shallow-clone the repo into a scratch dir.
 *   2. Read the text tree into memory (skipping .git, binaries, oversize).
 *   3. Fitness check: is there a top-level `flagship.app.json` that
 *      parses against the manifest schema?
 *        - FIT      → deterministic import. The files are already a
 *                     Flagship app; hand them straight to the existing
 *                     deploy path (manifest + Dockerfile + source). NO
 *                     model, NO key.
 *        - NOT FIT  → the caller routes the tree into the AI "adapt"
 *                     path (vibe-code loop with an adapt system prompt),
 *                     which rewrites it to the contract. Needs a model.
 *
 * This module owns steps 1–3 (the deterministic part). The adapt path
 * reuses the existing streaming session; `buildAdaptPrompt` here renders
 * the repo into the user message for it.
 *
 * Everything is journalled when a `journal` + `buildId` are supplied, so
 * the git mode is as observable as the others.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseManifest, type AppManifest } from "@flagship/protocol";
import {
  assertResolvedHostSafe,
  UnsafeBaseUrlError,
  type BaseUrlGuardOptions,
  type HostResolver,
} from "@flagship/llm-providers";
import type { CommandRunner } from "../serviceRunner.js";
import type { BuildJournal } from "./buildJournal.js";

const MANIFEST_FILE = "flagship.app.json";

/** Files we never read into memory (vcs, deps, build output, binaries). */
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__"]);
const TEXT_EXT = new Set([
  ".json", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".html", ".css",
  ".sql", ".md", ".txt", ".yml", ".yaml", ".toml", ".env", ".sh", ".py",
  ".go", ".rs", ".rb", ".java", ".kt", ".svelte", ".vue", ".xml", ".conf",
]);
const NO_EXT_ALLOW = new Set(["Dockerfile", "Makefile", "Procfile", ".gitignore", ".dockerignore", "LICENSE"]);

export interface GitInspectArgs {
  gitUrl: string;
  /** Branch / tag / commit. Default: the repo's default branch. */
  ref?: string;
  /** Journalled under this id when `journal` is set. */
  buildId?: string;
}

export type GitFitness =
  | {
      fit: true;
      gitUrl: string;
      ref?: string;
      manifest: AppManifest;
      manifestJson: string;
      files: Record<string, string>;
      reason: string;
    }
  | {
      fit: false;
      gitUrl: string;
      ref?: string;
      /** Present when a manifest file existed but failed to parse. */
      manifestErrors?: string[];
      files: Record<string, string>;
      reason: string;
    };

export interface GitImportDeps {
  cmd: CommandRunner;
  /** Scratch root; each inspect gets `<workingDir>/import-<buildId|rand>`. */
  workingDir: string;
  journal?: BuildJournal | null;
  /** Override the clone step in tests; default = `git clone --depth 1`. */
  cloneInto?: (a: { gitUrl: string; ref?: string; dest: string }) => Promise<void>;
  maxFiles?: number;
  maxBytesPerFile?: number;
  now?: () => number;
  /** Random suffix source for scratch dirs (Math.random is banned in some envs). */
  rand?: () => string;
  /**
   * SSRF posture for the clone host (same shape as the LLM baseUrl guard).
   * Strict public-build default; a self-hoster who clones from a LAN Forgejo
   * flips `allowPrivate` or supplies a `hostAllowlist`.
   */
  hostGuard?: BaseUrlGuardOptions;
  /** Override the DNS resolver in tests (no real network). */
  resolveHost?: HostResolver;
}

function validGitUrl(u: string): boolean {
  // https(s) or scp-like git@host:path. No file:// (SSRF/local-fs read),
  // no shell metacharacters.
  if (/[\s;&|`$(){}<>]/.test(u)) return false;
  if (/^https?:\/\/[^/\s]+\/.+/.test(u)) return true;
  if (/^git@[^:\s]+:.+/.test(u)) return true;
  return false;
}

/**
 * Pull the host out of an already-`validGitUrl` URL. Handles `https://host[:port]/...`
 * and scp-style `git@host:path`. Strips any `user@` prefix and `:port`/`:path`
 * suffix so what's left is just the hostname to resolve + classify.
 */
function gitUrlHost(u: string): string | null {
  if (/^https?:\/\//.test(u)) {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  const scp = u.match(/^git@([^:\s]+):/);
  if (scp) return scp[1]!.toLowerCase();
  return null;
}

function validRef(r: string): boolean {
  return /^[A-Za-z0-9._\/-]{1,200}$/.test(r) && !r.includes("..");
}

export class GitImporter {
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly rand: () => string;
  private readonly hostGuard?: BaseUrlGuardOptions;
  private readonly resolveHost?: HostResolver;

  constructor(private readonly deps: GitImportDeps) {
    this.maxFiles = deps.maxFiles ?? 400;
    this.maxBytes = deps.maxBytesPerFile ?? 256 * 1024;
    this.now = deps.now ?? (() => Date.now());
    this.rand = deps.rand ?? (() => Math.random().toString(16).slice(2, 10));
    this.hostGuard = deps.hostGuard;
    this.resolveHost = deps.resolveHost;
  }

  async inspect(args: GitInspectArgs): Promise<GitFitness> {
    const { gitUrl, ref, buildId } = args;
    if (!validGitUrl(gitUrl)) {
      const reason = "not a valid https or git@ URL";
      await this.note(buildId, "git-clone", `rejected: ${reason}`, gitUrl);
      return { fit: false, gitUrl, ref, files: {}, reason };
    }
    if (ref != null && !validRef(ref)) {
      const reason = "invalid git ref";
      await this.note(buildId, "git-clone", `rejected: ${reason}`, ref);
      return { fit: false, gitUrl, ref, files: {}, reason };
    }

    // SSRF guard: a clone URL must not point at the box's loopback data
    // plane (Redis/Postgres/Forgejo on localhost) or the cloud metadata
    // endpoint — by literal internal IP OR by a public name with an
    // internal A record. Only on the real-network clone path; an injected
    // `cloneInto` (tests / a future non-network source) supplies bytes
    // itself and never opens a socket to the host.
    if (!this.deps.cloneInto) {
      const host = gitUrlHost(gitUrl);
      if (!host) {
        const reason = "could not parse clone host";
        await this.note(buildId, "git-clone", `rejected: ${reason}`, gitUrl);
        return { fit: false, gitUrl, ref, files: {}, reason };
      }
      try {
        await assertResolvedHostSafe(host, gitUrl, this.hostGuard, this.resolveHost);
      } catch (e) {
        const reason =
          e instanceof UnsafeBaseUrlError ? `unsafe clone host (${e.reason})` : "unsafe clone host";
        await this.note(buildId, "git-clone", `rejected: ${reason}`, host);
        return { fit: false, gitUrl, ref, files: {}, reason };
      }
    }

    const dest = join(this.deps.workingDir, `import-${buildId ?? this.rand()}`);
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });

    await this.note(buildId, "git-clone", `cloning ${gitUrl}${ref ? ` @ ${ref}` : ""}`, gitUrl);
    try {
      if (this.deps.cloneInto) {
        await this.deps.cloneInto({ gitUrl, ref, dest });
      } else {
        const cloneArgs = ["clone", "--depth", "1"];
        if (ref) cloneArgs.push("--branch", ref);
        cloneArgs.push("--", gitUrl, dest);
        await this.deps.cmd.run("git", cloneArgs);
      }
    } catch (e) {
      const reason = `clone failed: ${(e as Error).message}`;
      await this.note(buildId, "error", reason);
      await rm(dest, { recursive: true, force: true });
      return { fit: false, gitUrl, ref, files: {}, reason };
    }

    const files = await this.readTree(dest);
    await rm(dest, { recursive: true, force: true });

    const manifestJson = files[MANIFEST_FILE];
    if (manifestJson == null) {
      const reason = `no ${MANIFEST_FILE} — repo isn't a Flagship app yet; the AI can adapt it`;
      await this.note(buildId, "fitness-check", reason);
      return { fit: false, gitUrl, ref, files, reason };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(manifestJson);
    } catch (e) {
      const reason = `${MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`;
      await this.note(buildId, "fitness-check", reason);
      return { fit: false, gitUrl, ref, manifestErrors: [reason], files, reason };
    }

    const result = parseManifest(parsedJson);
    if (!result.ok) {
      const reason = `${MANIFEST_FILE} present but invalid: ${result.errors[0] ?? "schema error"}`;
      await this.note(buildId, "fitness-check", reason, result.errors.join("; "));
      return { fit: false, gitUrl, ref, manifestErrors: result.errors, files, reason };
    }

    const reason = `Flagship-ready: '${result.manifest.name}' — installing as-is`;
    await this.note(buildId, "fitness-check", reason);
    return { fit: true, gitUrl, ref, manifest: result.manifest, manifestJson, files, reason };
  }

  private async note(
    buildId: string | undefined,
    kind: "git-clone" | "fitness-check" | "error",
    summary: string,
    detail?: string,
  ): Promise<void> {
    if (!this.deps.journal || !buildId) return;
    await this.deps.journal.append(buildId, {
      mode: "git",
      kind,
      actor: "system",
      summary,
      ...(detail != null ? { detail } : {}),
    });
  }

  /** Walk `dir`, returning a path→content map of text files within limits. */
  private async readTree(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let count = 0;
    const walk = async (cur: string): Promise<void> => {
      if (count >= this.maxFiles) return;
      let entries: string[];
      try {
        entries = readdirSync(cur);
      } catch {
        return;
      }
      for (const name of entries) {
        if (count >= this.maxFiles) return;
        const full = join(cur, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (SKIP_DIRS.has(name)) continue;
          await walk(full);
          continue;
        }
        if (!st.isFile()) continue;
        if (!this.isTextCandidate(name)) continue;
        if (st.size > this.maxBytes) continue;
        const rel = relative(dir, full).split(sep).join("/");
        try {
          const buf = await readFile(full);
          if (looksBinary(buf)) continue;
          out[rel] = buf.toString("utf8");
          count++;
        } catch {
          // unreadable — skip
        }
      }
    };
    if (existsSync(dir)) await walk(dir);
    return out;
  }

  private isTextCandidate(name: string): boolean {
    if (NO_EXT_ALLOW.has(name)) return true;
    const dot = name.lastIndexOf(".");
    if (dot < 0) return false;
    return TEXT_EXT.has(name.slice(dot).toLowerCase());
  }
}

/** Heuristic binary sniff: a NUL in the first 8 KB. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Render a cloned (non-fit) repo into the user message for the AI adapt
 * path. Caps total size so a huge repo can't blow the context; large
 * trees are summarized by file list + the most relevant files first.
 */
export function buildAdaptPrompt(files: Record<string, string>, maxChars = 60_000): string {
  const names = Object.keys(files).sort();
  const ranked = names.slice().sort((a, b) => rank(a) - rank(b));
  let body = "";
  const included: string[] = [];
  for (const path of ranked) {
    const content = files[path]!;
    const block = `\n=== ${path} ===\n${content}\n`;
    if (body.length + block.length > maxChars) continue;
    body += block;
    included.push(path);
  }
  const omitted = names.filter((n) => !included.includes(n));
  const header =
    `Adapt the following Git repository into a Flagship app. Add a valid ` +
    `flagship.app.json, a Dockerfile, and any migrations; rewrite storage ` +
    `to the FLAGSHIP_* env vars; remove the app's own auth (the daemon ` +
    `injects identity headers); expose only the manifest's single port; ` +
    `respect the platform hard-rules.\n\n` +
    `Repository files (${names.length} total${omitted.length ? `, ${omitted.length} omitted for size: ${omitted.join(", ")}` : ""}):\n`;
  return header + body;
}

function rank(path: string): number {
  // Surface the files most useful for adaptation first.
  if (path === "package.json" || path === "go.mod" || path === "requirements.txt" || path === "Cargo.toml") return 0;
  if (path === "README.md") return 1;
  if (/^(src\/)?(index|main|app|server)\.(t|j)sx?$/.test(path)) return 2;
  if (path === "Dockerfile") return 3;
  return 10;
}
