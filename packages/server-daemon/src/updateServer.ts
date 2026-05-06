/**
 * Serves the `/.flagship/update` endpoint on the canonical-home daemon.
 *
 * The flow:
 *
 *   1. The puller's daemon GETs `https://<app-url>/.flagship/update?since=<hash>`
 *      with `Authorization: Flagship-Identity <hex-pubkey> <hex-sig>` and
 *      `X-Flagship-Update-Pull` carrying the canonical-bytes envelope
 *      (creator, slug, since, issuedAt, pullerServerId).
 *   2. The daemon's reverse proxy routes that path to UpdateServer
 *      *before* forwarding to the container.
 *   3. UpdateServer:
 *        a. Parses the envelope from the header.
 *        b. Verifies the signature against the pulled-from-.com identity
 *           pubkey for `pullerServerId`.
 *        c. Confirms the puller is in the app's subscriber list (or the
 *           app declared `manifest.distribution.public`).
 *        d. Builds (or reads from cache) a `git bundle` of commits since
 *           `since` against the app's local repo.
 *        e. Returns the bundle bytes with `application/x-git-bundle`.
 *   4. The puller writes the bundle to disk, runs `git bundle verify` and
 *      `git fetch <bundle>`, then runs lineage + migration steps.
 *
 * The container never sees `/.flagship/update` traffic — the proxy
 * intercepts it. Apps cannot ship their own /.flagship/update that lies.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  verifyUpdatePull,
  type Bytes,
  type UpdatePullRequest,
} from "@flagship/protocol";
import type { InstalledApp } from "./appPlatform.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const execFileP = promisify(execFile);

export type UpdatePolicy = "auto" | "manual" | "frozen";

export interface AppDistributionInfo {
  /** True if any Flagship server can pull (vs. only listed subscribers). */
  publicDistribution: boolean;
  /** Per-app subscriber registry — `pullerServerId` strings allowed to pull. */
  subscribers: Set<string>;
  /** Absolute path to the app's local bare git repo (Forgejo backing dir or fixture). */
  repoPath: string;
}

export interface UpdateServerDeps {
  /**
   * Per-app distribution lookup. Returns null if the app isn't shareable
   * (no repo, or this box isn't its canonical home). Async so subscriber
   * lookups can hit a real (file/D1-backed) registry.
   */
  appDistribution: (
    app: InstalledApp,
  ) => Promise<AppDistributionInfo | null> | AppDistributionInfo | null;

  /**
   * Resolve a remote server identity FQDN to its Ed25519 pubkey.
   * Production uses `flagshipserver.com /api/server/by-domain/<id>`;
   * tests inject a Map.
   */
  resolveServerPubkey: (serverId: string) => Promise<Bytes | null>;

  /** Cache root, e.g. `/var/flagship/data/forgejo-pack-cache`. */
  cacheDir: string;

  /** Override git binary path. Default `git`. */
  gitBinary?: string;

  /** Inject clock for tests. */
  now?: () => number;

  /** Reject pulls whose `issuedAt` is more than this old. Default 5 min. */
  maxAgeMs?: number;
}

const PATH = "/.flagship/update";
const HEADER = "x-flagship-update-pull";
const AUTH_HEADER = "authorization";

export class UpdateServer {
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private readonly gitBinary: string;

  constructor(private readonly deps: UpdateServerDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
    this.now = deps.now ?? Date.now;
    this.gitBinary = deps.gitBinary ?? "git";
    if (!existsSync(deps.cacheDir)) mkdirSync(deps.cacheDir, { recursive: true });
  }

  /**
   * Returns null if the request isn't an update pull (so the proxy can
   * keep going). Otherwise returns the response (success or denial).
   */
  async handle(app: InstalledApp, req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path !== PATH) return null;
    if (req.method !== "GET") {
      return { status: 405, headers: { "content-type": "text/plain" }, body: "method not allowed" };
    }

    // Parse the canonical envelope from the header.
    const envelope = req.headers[HEADER];
    if (!envelope) {
      return { status: 400, headers: { "content-type": "text/plain" }, body: "missing X-Flagship-Update-Pull" };
    }
    let pull: UpdatePullRequest;
    try {
      const parsed = JSON.parse(envelope) as Record<string, unknown>;
      pull = {
        pullerServerId: String(parsed.pullerServerId),
        creator: String(parsed.creator),
        slug: String(parsed.slug),
        since: String(parsed.since ?? ""),
        issuedAt: Number(parsed.issuedAt),
      };
    } catch {
      return { status: 400, headers: { "content-type": "text/plain" }, body: "malformed envelope" };
    }

    // Match the URL path's app to the envelope's (creator, slug).
    if (pull.creator !== app.creator || pull.slug !== app.slug) {
      return {
        status: 400,
        headers: { "content-type": "text/plain" },
        body: "envelope (creator,slug) does not match URL app",
      };
    }

    // Freshness check.
    if (Math.abs(this.now() - pull.issuedAt) > this.maxAgeMs) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "stale request" };
    }

    // Parse the auth header.
    const auth = req.headers[AUTH_HEADER];
    if (!auth || !auth.startsWith("Flagship-Identity ")) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "missing identity auth" };
    }
    const parts = auth.slice("Flagship-Identity ".length).split(" ");
    if (parts.length !== 2) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "auth format: 'Flagship-Identity <pubkey-hex> <sig-hex>'" };
    }
    const claimedPubkey = safeHexDecode(parts[0]!);
    const sig = safeHexDecode(parts[1]!);
    if (!claimedPubkey || !sig) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "auth hex invalid" };
    }

    // Resolve the puller's pubkey via .com and require it match the claimed pubkey.
    // (This stops a caller from claiming someone else's identity by supplying their
    // pubkey alongside a forged sig — the .com lookup is the trusted source of truth.)
    const resolved = await this.deps.resolveServerPubkey(pull.pullerServerId);
    if (!resolved) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "puller identity not registered with .com" };
    }
    if (!bytesEqual(resolved, claimedPubkey)) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "auth pubkey does not match the .com-registered identity" };
    }

    // Verify signature.
    if (!verifyUpdatePull(pull, sig, resolved)) {
      return { status: 401, headers: { "content-type": "text/plain" }, body: "signature invalid" };
    }

    // Authorization: subscriber-list or public.
    const dist = await this.deps.appDistribution(app);
    if (!dist) {
      return { status: 404, headers: { "content-type": "text/plain" }, body: "app has no distribution surface on this box" };
    }
    if (!dist.publicDistribution && !dist.subscribers.has(pull.pullerServerId)) {
      return { status: 403, headers: { "content-type": "text/plain" }, body: "puller not in subscriber list" };
    }

    // Build / fetch from cache.
    let pack: Buffer;
    try {
      pack = await this.buildPack({ appId: app.appId, repoPath: dist.repoPath, since: pull.since });
    } catch (e) {
      return {
        status: 500,
        headers: { "content-type": "text/plain" },
        body: `pack build failed: ${(e as Error).message}`,
      };
    }

    return {
      status: 200,
      headers: {
        "content-type": "application/x-git-bundle",
        "x-flagship-pack-since": pull.since,
        "content-length": String(pack.length),
      },
      body: pack,
    };
  }

  /**
   * Build (or read cached) git bundle of commits between `since` and current
   * `main`. `since` empty string means "send full history" (no exclusion).
   *
   * Cache key: sha256("<appId>|<since>|<currentTip>"). When the canonical
   * tip advances, the key naturally changes, so old subscribers see a new
   * pack on next request without us having to maintain explicit
   * invalidation. Stale cache entries can be cleaned up by a background
   * job; not on the hot path here.
   */
  async buildPack(args: { appId: string; repoPath: string; since: string }): Promise<Buffer> {
    const tip = await this.repoTip(args.repoPath);
    if (!tip) throw new Error(`repo ${args.repoPath} has no main branch`);

    // If the puller already has the current tip, return empty.
    // Cheap to check before any cache lookup.
    if (args.since && args.since === tip) return Buffer.alloc(0);

    // Decide the bundle range. There are three cases:
    //   1. since="" → full history of main.
    //   2. since=<commit> reachable from main → incremental: <since>..main.
    //   3. since=<commit> NOT reachable from main → full history (puller's
    //      lineage is broken; we still send a bundle, the client's
    //      lineage check will halt on its side rather than us guessing).
    let range: string;
    if (!args.since) {
      range = "main";
    } else {
      const reachable = await this.isAncestor(args.repoPath, args.since, tip);
      range = reachable ? `${args.since}..main` : "main";
    }

    const cacheKey = sha256Hex(`${args.appId}|${args.since}|${tip}|${range}`);
    const cacheFile = join(this.deps.cacheDir, `${args.appId}-${cacheKey}.bundle`);

    if (existsSync(cacheFile)) {
      return await readFile(cacheFile);
    }

    const tmp = await mkdtemp(join(tmpdir(), "flagship-pack-"));
    const tmpBundle = join(tmp, "out.bundle");
    try {
      await this.git(args.repoPath, ["bundle", "create", tmpBundle, range]);
      const bytes = await readFile(tmpBundle);
      await writeFile(cacheFile, bytes);
      return bytes;
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  private async repoTip(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(repoPath, ["rev-parse", "main"]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private git(repoPath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP(this.gitBinary, ["-C", repoPath, ...args], {
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }
}

function safeHexDecode(s: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}
