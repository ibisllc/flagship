/**
 * Adapter abstraction — the seam between the maintainers UI and the
 * outside world.
 *
 * The UI never knows whether it's running in Model A (server holds a
 * Personal Access Token and commits on the user's behalf) or Model B
 * (purely static page; commits ride a GitHub OAuth device flow, fall
 * back to "download a ZIP and commit yourself" otherwise). Both
 * deployments speak this same interface.
 *
 * Spec mapping: this is the §6 StorageAdapter interface from the
 * protocol spec, framed for the UI's needs (read returns a parsed
 * folder; write returns either "committed" or "downloadable").
 */

import type { Envelope } from "@maintainers/protocol";
import {
  type ParsedFolder,
  type RawFolder,
  parseMaintainersFolder,
} from "./parse-folder.js";
import {
  BUILTIN_PROVIDERS,
  type RepoProvider,
  type RepoRef,
  parseRepoUrl,
  pickProvider,
} from "./repo-provider.js";
import { buildZip } from "./zip.js";

export interface LoadedProject {
  ref: RepoRef;
  folder: ParsedFolder;
  /** Whether the `.maintainers/` folder existed at all. */
  exists: boolean;
}

export interface CommittedResult {
  kind: "committed";
  sha: string;
  url?: string;
}

export interface DownloadableResult {
  kind: "downloadable";
  blob: Blob;
  filename: string;
  /** Optional URL to a "create this file" page on the provider. */
  manualCommitUrl?: string;
}

export type SubmitResult = CommittedResult | DownloadableResult;

export interface SubmitInput {
  repoUrl: string;
  /** Path relative to `.maintainers/` (e.g. `tracks/release/mandates/2026-05-11-genesis.json`). */
  path: string;
  envelope: Envelope;
  /** Pre-serialized canonical-bytes form. The adapter writes these bytes verbatim. */
  bytes: Uint8Array;
  /** Optional commit message hint. */
  message?: string;
}

export interface BulkSubmitInput {
  repoUrl: string;
  /** Multiple envelopes to commit/download together (e.g. genesis = policy + mandate + keyfile). */
  entries: { path: string; envelope: Envelope; bytes: Uint8Array }[];
  message?: string;
}

export interface AdapterClient {
  /** Identify this adapter for the UI footer ("via flagshipserver" / "static page"). */
  readonly displayName: string;
  /** Whether the adapter can actually push commits (Model A or Model B with OAuth). */
  readonly canCommit: boolean;
  /** Fetch and parse the project's `.maintainers/` folder. */
  loadProject(repoUrl: string): Promise<LoadedProject>;
  /** Submit a single envelope. */
  submitEnvelope(input: SubmitInput): Promise<SubmitResult>;
  /** Submit a bundle (for genesis or any other multi-envelope operation). */
  submitBundle(input: BulkSubmitInput): Promise<SubmitResult>;
}

// ---------------------------------------------------------------------------
// Static adapter (Model B)
// ---------------------------------------------------------------------------

export interface StaticAdapterOptions {
  /** Custom fetch (e.g. injected for tests). Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Optional list of known paths to attempt to read. If omitted, the
   * adapter tries to discover via the provider's tree API and falls
   * back to a known-layout probe.
   */
  knownPaths?: string[];
  providers?: RepoProvider[];
  /**
   * If supplied, the adapter will use this OAuth token to PUT new
   * files via the provider's API instead of returning a ZIP. Token
   * scope must be sufficient to write to the repo (GitHub: `public_repo`
   * or `repo`).
   */
  oauthToken?: string;
}

export function staticAdapter(opts: StaticAdapterOptions = {}): AdapterClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) {
    throw new Error("staticAdapter: no fetch implementation available");
  }
  const providers = opts.providers ?? BUILTIN_PROVIDERS;
  const canCommit = !!opts.oauthToken;
  return {
    displayName: canCommit ? "OAuth (browser)" : "Static (ZIP download)",
    canCommit,

    async loadProject(repoUrl: string): Promise<LoadedProject> {
      const ref = parseRepoUrl(repoUrl);
      const provider = pickProvider(ref, providers);
      const files = await discoverMaintainersFolder(fetchImpl!, provider, ref, opts.knownPaths);
      const folder = parseMaintainersFolder({ files });
      return { ref, folder, exists: files.size > 0 };
    },

    async submitEnvelope(input: SubmitInput): Promise<SubmitResult> {
      return submit(this, fetchImpl!, providers, opts.oauthToken, {
        repoUrl: input.repoUrl,
        entries: [{ path: input.path, envelope: input.envelope, bytes: input.bytes }],
        message: input.message ?? defaultMessageForEnvelope(input.envelope),
      });
    },

    async submitBundle(input: BulkSubmitInput): Promise<SubmitResult> {
      return submit(this, fetchImpl!, providers, opts.oauthToken, input);
    },
  };
}

async function submit(
  _self: AdapterClient,
  fetchImpl: typeof fetch,
  providers: RepoProvider[],
  oauthToken: string | undefined,
  input: BulkSubmitInput,
): Promise<SubmitResult> {
  const ref = parseRepoUrl(input.repoUrl);
  const provider = pickProvider(ref, providers);
  if (oauthToken && provider.name === "github") {
    return commitViaGithub(fetchImpl, ref, oauthToken, input);
  }
  // Fallback: build a ZIP with `.maintainers/` prefix so the user can drop it.
  const zipEntries = input.entries.map((e) => ({
    path: `.maintainers/${e.path}`,
    bytes: e.bytes,
  }));
  const bytes = buildZip(zipEntries);
  // Cast bypasses the SharedArrayBuffer/ArrayBuffer union complaint in
  // recent lib.dom.d.ts. Our bytes is always a fresh ArrayBuffer-backed
  // Uint8Array from buildZip; the runtime path is safe.
  const blob = new Blob([bytes as BlobPart], { type: "application/zip" });
  const filename = filenameForBundle(ref, input.entries);
  return {
    kind: "downloadable",
    blob,
    filename,
    manualCommitUrl: provider.manualCommitUrl(ref, `.maintainers/${input.entries[0]?.path ?? ""}`),
  };
}

async function commitViaGithub(
  fetchImpl: typeof fetch,
  ref: RepoRef,
  token: string,
  input: BulkSubmitInput,
): Promise<SubmitResult> {
  // We use the contents API one PUT per file for simplicity; that's
  // fine for the small (1-5 files) bundles the UI produces. For larger
  // bundles a tree+commit two-step would be more atomic.
  let lastSha = "";
  const message = input.message ?? "maintainers: update";
  for (const entry of input.entries) {
    const fullPath = `.maintainers/${entry.path}`;
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/contents/${fullPath}`;
    const body = {
      message,
      content: base64Encode(entry.bytes),
      branch: ref.ref,
    };
    const r = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`github PUT ${url} failed: ${r.status} ${text}`);
    }
    const data = (await r.json()) as { content?: { sha?: string } };
    lastSha = data.content?.sha ?? lastSha;
  }
  return {
    kind: "committed",
    sha: lastSha,
    url: `https://github.com/${ref.owner}/${ref.repo}/tree/${ref.ref}/.maintainers`,
  };
}

function filenameForBundle(ref: RepoRef, entries: { path: string }[]): string {
  if (entries.length === 1) {
    const leaf = entries[0]!.path.split("/").pop() ?? "envelope.json";
    return `${ref.owner}-${ref.repo}-${leaf}.zip`;
  }
  return `${ref.owner}-${ref.repo}-maintainers-bundle.zip`;
}

function defaultMessageForEnvelope(env: Envelope): string {
  switch (env.kind) {
    case "Mandate":
      return `maintainers: ${env.track} mandate ${env.mandateId.slice(0, 8)}`;
    case "KeyFile":
      return `maintainers: introduce key ${env.displayName} (${env.currentEmail})`;
    case "KeyRedirect":
      return `maintainers: redirect ${env.fromEmail} → ${env.renamedTo}`;
    case "EmailRotation":
      return `maintainers: rotate email ${env.fromEmail} → ${env.toEmail}`;
    case "KeyIntroductionRequest":
      return `maintainers: key introduction request ${env.displayName}`;
    case "ReleaseEndorsement":
      return `maintainers: endorse ${env.semverTag}`;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Walk a `.maintainers/` folder. Strategy:
 *   1. If `knownPaths` was supplied, fetch exactly those.
 *   2. Otherwise, probe the provider's tree API for `.maintainers/` and
 *      recurse one level (deep enough for our layout).
 *   3. If the tree API isn't accessible (rate limit, private repo,
 *      etc.), fall back to probing well-known fixed paths (policy.json,
 *      tracks/release/policy.json, ...).
 */
async function discoverMaintainersFolder(
  fetchImpl: typeof fetch,
  provider: RepoProvider,
  ref: RepoRef,
  knownPaths: string[] | undefined,
): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const fetchOne = async (relPath: string): Promise<boolean> => {
    const url = provider.rawContentUrl(ref, `.maintainers/${relPath}`);
    const r = await fetchImpl(url);
    if (!r.ok) return false;
    const ab = await r.arrayBuffer();
    files.set(relPath, new Uint8Array(ab));
    return true;
  };

  if (knownPaths && knownPaths.length > 0) {
    for (const p of knownPaths) await fetchOne(p);
    return files;
  }

  if (provider.treeApiUrl) {
    try {
      const enumerated = await enumerateTreeFiles(fetchImpl, provider, ref, "");
      for (const rel of enumerated) await fetchOne(rel);
      if (files.size > 0) return files;
    } catch {
      // fall through to probe
    }
  }

  // Probe well-known paths
  const probes = [
    "policy.json",
    "README.md",
    "tracks/release/policy.json",
    "tracks/ca/policy.json",
    "tracks/ops/policy.json",
  ];
  for (const p of probes) await fetchOne(p);
  return files;
}

async function enumerateTreeFiles(
  fetchImpl: typeof fetch,
  provider: RepoProvider,
  ref: RepoRef,
  relPrefix: string,
): Promise<string[]> {
  if (!provider.treeApiUrl) return [];
  const apiPath = relPrefix ? `.maintainers/${relPrefix}` : `.maintainers`;
  const url = provider.treeApiUrl(ref, apiPath);
  const r = await fetchImpl(url);
  if (!r.ok) return [];
  const data = (await r.json()) as unknown;
  const items = normaliseTreeResponse(data, provider.name);
  const out: string[] = [];
  for (const it of items) {
    if (it.type === "file") {
      out.push(relPrefix ? `${relPrefix}/${it.name}` : it.name);
    } else if (it.type === "dir") {
      const nestedPrefix = relPrefix ? `${relPrefix}/${it.name}` : it.name;
      const nested = await enumerateTreeFiles(fetchImpl, provider, ref, nestedPrefix);
      out.push(...nested);
    }
  }
  return out;
}

interface TreeItem { name: string; type: "file" | "dir" }

function normaliseTreeResponse(data: unknown, providerName: string): TreeItem[] {
  if (!Array.isArray(data)) return [];
  if (providerName === "github" || providerName === "codeberg" || providerName === "forgejo") {
    return data.flatMap((x): TreeItem[] => {
      const o = x as { name?: string; type?: string };
      if (typeof o.name !== "string") return [];
      if (o.type === "file") return [{ name: o.name, type: "file" }];
      if (o.type === "dir") return [{ name: o.name, type: "dir" }];
      return [];
    });
  }
  if (providerName === "gitlab") {
    return data.flatMap((x): TreeItem[] => {
      const o = x as { name?: string; type?: string };
      if (typeof o.name !== "string") return [];
      if (o.type === "blob") return [{ name: o.name, type: "file" }];
      if (o.type === "tree") return [{ name: o.name, type: "dir" }];
      return [];
    });
  }
  return [];
}

function base64Encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  if (typeof btoa !== "undefined") return btoa(s);
  return Buffer.from(s, "binary").toString("base64");
}

// ---------------------------------------------------------------------------
// Model A stub
// ---------------------------------------------------------------------------

/**
 * Shape of the Model A server adapter. The actual implementation lives
 * in the (forthcoming) `@maintainers/server-adapters` package; this
 * stub keeps the UI compile-clean and documents what's expected.
 *
 * Server adapters typically:
 *   - hold a PAT or App-installation token for the repo,
 *   - expose a small JSON API (loadProject, submitEnvelope,
 *     submitBundle) over HTTPS,
 *   - sign every response themselves so the UI can pin TLS + an
 *     out-of-band fingerprint.
 */
export interface ServerAdapterOptions {
  /** Base URL of the server adapter API (e.g. `https://api.example.com/maintainers`). */
  baseUrl: string;
  /** Optional bearer that the UI obtained out-of-band (session cookie, signed-in user, etc.). */
  bearer?: string;
  fetchImpl?: typeof fetch;
}

export function serverAdapter(opts: ServerAdapterOptions): AdapterClient {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (!fetchImpl) throw new Error("serverAdapter: no fetch implementation available");
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.bearer) h["Authorization"] = `Bearer ${opts.bearer}`;
    return h;
  };
  return {
    displayName: `Server: ${opts.baseUrl}`,
    canCommit: true,
    async loadProject(repoUrl: string): Promise<LoadedProject> {
      const r = await fetchImpl(`${opts.baseUrl}/loadProject?repo=${encodeURIComponent(repoUrl)}`, {
        headers: headers(),
      });
      if (!r.ok) throw new Error(`server adapter loadProject failed: ${r.status}`);
      const data = (await r.json()) as {
        ref: RepoRef;
        files: Record<string, string>;
        exists: boolean;
      };
      const files = new Map<string, Uint8Array>();
      for (const [path, b64] of Object.entries(data.files)) {
        files.set(path, decodeBase64(b64));
      }
      const folder = parseMaintainersFolder({ files });
      return { ref: data.ref, folder, exists: data.exists };
    },
    async submitEnvelope(input: SubmitInput): Promise<SubmitResult> {
      return this.submitBundle({
        repoUrl: input.repoUrl,
        entries: [{ path: input.path, envelope: input.envelope, bytes: input.bytes }],
        message: input.message,
      });
    },
    async submitBundle(input: BulkSubmitInput): Promise<SubmitResult> {
      const r = await fetchImpl(`${opts.baseUrl}/submitBundle`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          repoUrl: input.repoUrl,
          message: input.message,
          entries: input.entries.map((e) => ({
            path: e.path,
            envelope: e.envelope,
            bytesBase64: base64Encode(e.bytes),
          })),
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`server adapter submitBundle failed: ${r.status} ${text}`);
      }
      const data = (await r.json()) as {
        kind: "committed" | "downloadable";
        sha?: string;
        url?: string;
      };
      if (data.kind === "committed") {
        return { kind: "committed", sha: data.sha ?? "", url: data.url };
      }
      throw new Error("server adapter unexpectedly returned downloadable; this is Model A");
    },
  };
}

function decodeBase64(s: string): Uint8Array {
  const bin = typeof atob !== "undefined" ? atob(s) : Buffer.from(s, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Re-export for convenience
export type { RawFolder, ParsedFolder } from "./parse-folder.js";
export type { RepoRef, RepoProvider } from "./repo-provider.js";
