import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { removeDurable, writeFileDurable } from "./durableFile.js";
import { promisify } from "node:util";
import {
  verifyUpdateOrder,
  type AdminGrantView,
  type UpdateOrder,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import type { ReleaseGate } from "./updateClient.js";
import { refusalRecord, type UpdateOutcomeStore } from "./updateOutcome.js";

const execFileP = promisify(execFile);

/**
 * Box-side consumer of the phone-ordered, dual-signed in-place server update
 * (docs/server-update-mechanism.md). The 2-of-2 gate, enforced HERE, on-box,
 * independently — `.com` verified the deposit too, but `.com` is never a trust
 * anchor:
 *
 *   1. AUTHORIZATION — the `UpdateOrder` re-verifies through the SAME Slice-D
 *      master-admin gate as wipe/transfer/decommission
 *      (`authorizeSensitiveOrder`): with an admin master root pinned, ONLY the
 *      admin root / an admin-root-signed `admin` grant authorizes (the bare
 *      membership IRK CANNOT); with no admin root pinned it falls back to the
 *      legacy owner-IRK verify (a strict no-op on pre-Slice-D boxes).
 *   2. AUTHENTICITY — the target commit must be maintainer-ENDORSED via the
 *      injected `ReleaseGate` (production: `buildMaintainersReleaseGate`, the
 *      offline verify-forward-from-pin release-endorsement check). An admin
 *      key compromise is therefore NOT arbitrary code execution — only a
 *      blessed commit can ever be applied.
 *
 * Anti-replay / anti-skip gates (each independently rejecting):
 *   - `serverDomain` must name THIS box;
 *   - `issuedAt` freshness window (default = the `.com` lane's 14d TTL);
 *   - `nonce` single-use (persisted used-nonce marker — `.com`'s consume-once
 *     is the primary guard, the marker survives a rollback + redelivery);
 *   - `fromCommit` must equal the CURRENT git HEAD of the box's own checkout
 *     (a stale order for an older/newer base can never apply).
 *
 * Apply (CODE SWAP ONLY — never touches /var/flagship keys/data):
 *   `git fetch` → releaseGate (post-fetch so the endorsement lineage walk has
 *   the objects; nothing is checked out before BOTH gates pass) →
 *   `git checkout <target>` → rebuild → write the pending-verify marker →
 *   exit(0) so systemd restarts into the new code. The boot-time health gate
 *   (updateHealthGate.ts) then COMMITS the update on a healthy boot or ROLLS
 *   BACK after too many failed boots — a bad update can never brick a box.
 *
 * Mirrors decommissionConsumer/cgkDepositConsumer: every side effect (fetch,
 * command runner, stores, clock, exit) is injected; never throws; a defective
 * or unauthorized order is ignored, never acted on.
 */

const HEX = /^[0-9a-f]+$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Injected command runner (tests never touch a real box)
// ──────────────────────────────────────────────────────────────────────

export type UpdateCommandRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string }>;

/** Production runner: execFile with a generous bound (npm ci + tsc -b). */
export const realUpdateCommandRunner: UpdateCommandRunner = async (cmd, args, opts) => {
  const { stdout } = await execFileP(cmd, args, {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    timeout: 20 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout };
};

/**
 * Install + compile only the daemon's workspace closure, as the install-time
 * bootstrap does. The scope is derived by npm and tsc from whatever checkout is
 * on disk (npm follows the daemon's `@flagship/*` links, `tsc -b` its project
 * references), so the same command serves an update (old daemon, new checkout)
 * and a rollback (new daemon, old checkout) for any commit that has
 * packages/server-daemon.
 */
const BOX_WORKSPACE = "packages/server-daemon";
const BOX_NPM_SCOPE = ["--include-workspace-root", `--workspace=${BOX_WORKSPACE}`];

/**
 * Put the checkout back on `commit` even after a power cut mangled it: a
 * killed git can leave a stale index.lock, an index that no longer matches the
 * files, and 0-byte files the index still believes are clean. Dropping the
 * index makes `reset --hard` rewrite every tracked file, and cleaning
 * `packages/` removes files only the abandoned commit had (a truncated one
 * there would break the rebuild). Ignored output (node_modules, dist) is left
 * for the rebuild.
 */
export async function restoreCheckout(
  runner: UpdateCommandRunner,
  repoPath: string,
  commit: string,
): Promise<void> {
  await runner("rm", ["-f", `${repoPath}/.git/index.lock`, `${repoPath}/.git/index`]);
  await runner("git", ["-C", repoPath, "reset", "-q", "--hard", commit]);
  await runner("git", ["-C", repoPath, "clean", "-fdq", "--", "packages"]);
}

/** `npm ci` (falling back to `npm install`) + `npx tsc -b` of the daemon. */
export async function rebuildWorkspace(
  runner: UpdateCommandRunner,
  repoPath: string,
  log: (m: string) => void,
): Promise<void> {
  try {
    await runner("npm", ["ci", "--no-audit", "--no-fund", ...BOX_NPM_SCOPE], { cwd: repoPath });
  } catch (e) {
    log(`[self-update] npm ci failed (${(e as Error).message}); falling back to npm install`);
    await runner("npm", ["install", "--no-audit", "--no-fund", ...BOX_NPM_SCOPE], { cwd: repoPath });
  }
  await runner("npx", ["tsc", "-b", BOX_WORKSPACE], { cwd: repoPath });
  // The checkout, node_modules and build output are all still in the page
  // cache; flush them before a marker claims the tree is ready (home2 lost
  // power 2 s after its rebuild and came back with thousands of 0-byte files).
  await runner("sync", []);
}

/**
 * Lazily-cached reader of the box's own checkout HEAD — the SAME
 * applied-commit truth step 7 of the consumer enforces `fromCommit`
 * against. The screens BFF surfaces it on server-detail so clients can
 * display the current version and mint `fromCommit` from the box's real
 * HEAD instead of guessing.
 *
 * Sync (the BFF's server-detail builder is synchronous) and cached after
 * the first read: HEAD only ever changes across a daemon restart (the
 * consumer exits into systemd after a checkout), so one read per process
 * is the truth for the process's lifetime. Returns null when the daemon
 * isn't running from a git checkout or the read fails — clients disable
 * the update action on null.
 */
export function buildCurrentCommitProvider(
  repoPath: string,
  readHead: (repo: string) => string = (repo) =>
    execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 10_000,
    }),
): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      const head = readHead(repoPath).trim().toLowerCase();
      cached = /^[0-9a-f]{40}$/.test(head) ? head : null;
    } catch {
      cached = null;
    }
    return cached;
  };
}

// ──────────────────────────────────────────────────────────────────────
// Persisted stores: used nonces + the pending-verify marker
// ──────────────────────────────────────────────────────────────────────

/** Single-use-nonce persistence (survives restarts + rollbacks). */
export interface UsedNonceStore {
  has(nonce: string): Promise<boolean>;
  mark(nonce: string): Promise<void>;
}

const MAX_STORED_NONCES = 500;

/** Default file-backed store: a small JSON `{nonces: string[]}`, newest-last. */
export function fileUsedNonceStore(path: string): UsedNonceStore {
  async function load(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8")) as { nonces?: unknown };
      return Array.isArray(parsed.nonces)
        ? parsed.nonces.filter((n): n is string => typeof n === "string")
        : [];
    } catch {
      return [];
    }
  }
  return {
    async has(nonce) {
      return (await load()).includes(nonce.toLowerCase());
    },
    async mark(nonce) {
      const nonces = await load();
      nonces.push(nonce.toLowerCase());
      await writeFileDurable(path, JSON.stringify({ nonces: nonces.slice(-MAX_STORED_NONCES) }));
    },
  };
}

/** The staged-update sentinel the boot health gate consumes. */
export interface PendingVerifyMarker {
  previousCommit: string;
  targetCommit: string;
  bootAttempts: number;
  /**
   * `applying` from just before the checkout until the rebuild finishes, so a
   * box interrupted mid-apply knows to roll back. Absent (markers written by
   * older code) means `staged`.
   */
  stage?: "applying" | "staged";
}

export interface PendingVerifyStore {
  read(): Promise<PendingVerifyMarker | null>;
  write(marker: PendingVerifyMarker): Promise<void>;
  clear(): Promise<void>;
}

/** Default file-backed marker (lives under /var/flagship so it survives the
 *  code swap — the update never touches the data dir except its own markers). */
export function filePendingVerifyStore(path: string): PendingVerifyStore {
  return {
    async read() {
      try {
        const p = JSON.parse(await readFile(path, "utf-8")) as Partial<PendingVerifyMarker>;
        if (
          typeof p.previousCommit !== "string" ||
          typeof p.targetCommit !== "string" ||
          typeof p.bootAttempts !== "number"
        ) {
          return null;
        }
        return {
          previousCommit: p.previousCommit,
          targetCommit: p.targetCommit,
          bootAttempts: p.bootAttempts,
          ...(p.stage === "applying" ? { stage: "applying" as const } : {}),
        };
      } catch {
        return null;
      }
    },
    async write(marker) {
      await writeFileDurable(path, JSON.stringify(marker));
    },
    async clear() {
      await removeDurable(path);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Carrier decode
// ──────────────────────────────────────────────────────────────────────

/**
 * Decode the deposited carrier hex (UTF-8 JSON `{order, signature}` — the
 * PUBLIC admin-signed order, exactly as `handlePostUpdateDeposit` stored it)
 * into the parsed order + raw signature. Throws with a specific reason on any
 * defect — the caller maps that to "ignore, don't act". Does NOT authorize:
 * that is the caller's admin-gate step.
 */
export function decodeUpdateOrderCarrier(sealedHex: string): {
  order: UpdateOrder;
  signature: Uint8Array;
} {
  const hexLower = sealedHex.toLowerCase();
  if (!HEX.test(hexLower) || hexLower.length % 2 !== 0) {
    throw new Error("update carrier is not valid hex");
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(hexLower));
  } catch {
    throw new Error("update carrier hex is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`update carrier is not valid JSON: ${(e as Error).message}`);
  }
  const p = parsed as {
    order?: {
      serverDomain?: unknown;
      targetCommit?: unknown;
      fromCommit?: unknown;
      nonce?: unknown;
      issuedAt?: unknown;
    };
    signature?: unknown;
  };
  const o = p?.order;
  if (
    !o ||
    typeof o.serverDomain !== "string" ||
    typeof o.targetCommit !== "string" ||
    typeof o.fromCommit !== "string" ||
    typeof o.nonce !== "string" ||
    typeof o.issuedAt !== "number" ||
    typeof p.signature !== "string" ||
    !HEX.test(p.signature.toLowerCase())
  ) {
    throw new Error("update carrier is missing required fields");
  }
  let signature: Uint8Array;
  try {
    signature = hexToBytes(p.signature.toLowerCase());
  } catch {
    throw new Error("update signature is not valid hex");
  }
  return {
    order: {
      serverDomain: o.serverDomain,
      targetCommit: o.targetCommit,
      fromCommit: o.fromCommit,
      nonce: o.nonce,
      issuedAt: o.issuedAt,
    },
    signature,
  };
}

// ──────────────────────────────────────────────────────────────────────
// The consumer
// ──────────────────────────────────────────────────────────────────────

export interface RunUpdateConsumerOptions {
  /** This box's canonical FQDN. */
  serverDomain: string;
  /** The config-pinned MEMBERSHIP owner IRK — the LEGACY (no-admin-root) anchor. */
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root; present ⇒ ONLY admin authority
   *  passes (never the bare owner IRK), absent ⇒ legacy owner-IRK verify. */
  adminRootPub?: Uint8Array;
  /** This box's owner account — for the delegated-grant check. */
  username: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;

  /** The box's own code checkout (production: /opt/flagship). */
  repoPath: string;
  /** The AUTHENTICITY half — maintainer-endorsement check for the target. */
  releaseGate: ReleaseGate;
  /** Injected command runner (git / npm / npx) — tests never touch a real box. */
  runner: UpdateCommandRunner;
  /** Single-use-nonce persistence. */
  usedNonceStore: UsedNonceStore;
  /** The staged-update sentinel the boot health gate consumes. */
  pendingStore: PendingVerifyStore;
  /** Exit so systemd restarts into the staged code (production: process.exit(0)). */
  requestExit: () => void;

  /** issuedAt freshness window (default 14d — the `.com` deposit lane's TTL). */
  maxOrderAgeMs?: number;
  /** Allowed forward clock skew on issuedAt (default 5min). */
  futureSkewMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
}

export type UpdateConsumeOutcome =
  | {
      applied: false;
      reason:
        | "pending-verify"
        | "no-order"
        | "error"
        | "rejected"
        | "wrong-domain"
        | "stale"
        | "replayed-nonce"
        | "from-commit-mismatch"
        | "unendorsed"
        | "apply-failed";
    }
  | { applied: true; previousCommit: string; targetCommit: string };

const DEFAULT_MAX_ORDER_AGE_MS = 14 * 24 * 60 * 60_000; // the lane's deposit TTL
const DEFAULT_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * One poll: claim this box's update order, enforce the FULL 2-of-2 + replay
 * gates, and on success stage the new code + exit for the restart. Never
 * throws — returns an outcome.
 */
export async function runUpdateConsumer(
  opts: RunUpdateConsumerOptions,
): Promise<UpdateConsumeOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  const now = opts.now ?? (() => Date.now());

  // 0. An update is already staged and awaiting its boot health verdict —
  //    never stack a second one on top.
  try {
    if ((await opts.pendingStore.read()) !== null) {
      return { applied: false, reason: "pending-verify" };
    }
  } catch {
    /* an unreadable marker is treated as "none pending" */
  }

  // 1. Claim the deposit (public consume-once — the carrier is a PUBLIC
  //    admin-signed order; `.com` holds nothing forgeable).
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/update`;
  let sealedHex: string | undefined;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { applied: false, reason: "no-order" };
    if (!res.ok) {
      log(`[self-update] GET ${res.status}; ignoring`);
      return { applied: false, reason: "error" };
    }
    const body = (await res.json()) as { sealed?: string };
    sealedHex = body?.sealed;
  } catch (e) {
    log(`[self-update] GET failed: ${(e as Error).message}`);
    return { applied: false, reason: "error" };
  }
  if (typeof sealedHex !== "string" || sealedHex.length === 0) {
    log("[self-update] deposit missing carrier; ignoring");
    return { applied: false, reason: "rejected" };
  }

  // 2. Decode the carrier (shape only — no trust yet).
  let order: UpdateOrder;
  let signature: Uint8Array;
  try {
    ({ order, signature } = decodeUpdateOrderCarrier(sealedHex));
  } catch (e) {
    log(`[self-update] carrier rejected: ${(e as Error).message}`);
    return { applied: false, reason: "rejected" };
  }

  // 3. AUTHORIZATION (2-of-2 half #1) — the Slice-D master-admin gate. With an
  //    admin root pinned ONLY admin authority passes (an owner-IRK-signed order
  //    is REJECTED); with no admin root, the legacy owner-IRK verify. NEVER a
  //    bare owner-IRK check when an admin root is pinned — the transition rule
  //    lives inside authorizeSensitiveOrder, identical to decommission/self-
  //    delete.
  if (
    !authorizeSensitiveOrder({
      order,
      signature,
      verify: verifyUpdateOrder,
      ownerIrkPub: opts.ownerIrkPub,
      adminRootPub: opts.adminRootPub,
      username: opts.username,
      activeGrants: opts.activeGrants,
      now: now(),
    })
  ) {
    log("[self-update] order NOT authorized under the admin authority; ignoring");
    return { applied: false, reason: "rejected" };
  }

  // 4. The order must name THIS box.
  if (order.serverDomain.toLowerCase() !== opts.serverDomain.toLowerCase()) {
    log(
      `[self-update] order names ${order.serverDomain}, not this box ${opts.serverDomain}; ignoring`,
    );
    return { applied: false, reason: "wrong-domain" };
  }

  // 5. issuedAt freshness (anti-replay of an ancient order; the `.com` lane's
  //    TTL is the primary bound, this is the box-side independent check).
  const age = now() - order.issuedAt;
  if (age > (opts.maxOrderAgeMs ?? DEFAULT_MAX_ORDER_AGE_MS) || age < -(opts.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS)) {
    log(`[self-update] order issuedAt out of window (age ${age}ms); ignoring`);
    return { applied: false, reason: "stale" };
  }

  // 6. Nonce single-use (survives rollback + redelivery — a rolled-back update
  //    can never be replayed onto the box with the same order).
  try {
    if (await opts.usedNonceStore.has(order.nonce)) {
      log("[self-update] nonce already consumed; ignoring replay");
      return { applied: false, reason: "replayed-nonce" };
    }
  } catch {
    /* an unreadable store is treated as "not used" — .com consume-once is primary */
  }

  // 7. fromCommit must equal the CURRENT HEAD (anti-replay/anti-skip: an order
  //    minted against a different base never applies).
  let currentCommit: string;
  try {
    const { stdout } = await opts.runner("git", ["-C", opts.repoPath, "rev-parse", "HEAD"]);
    currentCommit = stdout.trim().toLowerCase();
  } catch (e) {
    log(`[self-update] cannot read current HEAD: ${(e as Error).message}`);
    return { applied: false, reason: "error" };
  }
  if (order.fromCommit.toLowerCase() !== currentCommit) {
    log(
      `[self-update] order fromCommit ${order.fromCommit} != current HEAD ${currentCommit}; ignoring`,
    );
    return { applied: false, reason: "from-commit-mismatch" };
  }

  // 8. Burn the nonce BEFORE any side effect (a crash mid-apply must not make
  //    the order replayable). Best-effort: `.com`'s consume-once already burned
  //    the deposit itself.
  try {
    await opts.usedNonceStore.mark(order.nonce);
  } catch (e) {
    log(`[self-update] could not persist used nonce (${(e as Error).message}); continuing`);
  }

  return applyEndorsedUpdate(opts, currentCommit, order.targetCommit, "admin-authorized, maintainer-endorsed");
}

export interface ApplyEndorsedUpdateOptions {
  repoPath: string;
  releaseGate: ReleaseGate;
  runner: UpdateCommandRunner;
  pendingStore: PendingVerifyStore;
  requestExit: () => void;
  onLog?: (m: string) => void;
}

/**
 * Fetch, prove the target maintainer-endorsed, then swap the code and restart
 * into it under the boot health gate. Shared by the owner's update order and a
 * new box's first-boot update (firstBootUpdate.ts); whatever authorized the
 * move, only an endorsed commit is ever checked out.
 */
export async function applyEndorsedUpdate(
  opts: ApplyEndorsedUpdateOptions,
  currentCommit: string,
  targetCommit: string,
  why: string,
): Promise<UpdateConsumeOutcome> {
  const log = opts.onLog ?? (() => {});
  // 9. Fetch the objects, then run the AUTHENTICITY gate (2-of-2 half #2).
  //    Fetch first is deliberate: the gate's endorsement lineage walk needs the
  //    target's objects locally, and a fetch only downloads into .git — nothing
  //    is checked out or executed before the gate passes.
  try {
    await opts.runner("git", ["-C", opts.repoPath, "fetch"]);
  } catch (e) {
    log(`[self-update] git fetch failed: ${(e as Error).message}; will retry next poll`);
    return { applied: false, reason: "apply-failed" };
  }
  // Real boxes are cloned SHALLOW (`git clone --depth 50`, demoCloudConfig.ts),
  // but the AUTHENTICITY gate's first-parent lineage walk needs the target's
  // full ancestry — the FIRST endorsement is a genesis covering the entire
  // history, and a shallow walk truncates at the graft boundary and would
  // count-mismatch → reject. Deepen to full history before the gate. Only when
  // actually shallow (`--unshallow` errors on a complete repo), and best-effort:
  // if it fails the gate simply can't verify and rejects — never a bypass.
  try {
    const { stdout } = await opts.runner("git", [
      "-C",
      opts.repoPath,
      "rev-parse",
      "--is-shallow-repository",
    ]);
    if (stdout.trim() === "true") {
      log("[self-update] deepening shallow clone for the endorsement lineage walk");
      await opts.runner("git", ["-C", opts.repoPath, "fetch", "--unshallow"]);
    }
  } catch (e) {
    log(`[self-update] shallow-deepen skipped (${(e as Error).message}); continuing`);
  }
  try {
    opts.releaseGate.assertCommitEndorsed(targetCommit);
  } catch (e) {
    log(`[self-update] REFUSED: ${(e as Error).message}`);
    return { applied: false, reason: "unendorsed" };
  }

  // 10. Apply: checkout + rebuild + stage the pending-verify marker + restart.
  //     CODE SWAP ONLY — /var/flagship (keys/data) is never touched.
  log(`[self-update] applying ${why} update ${currentCommit} → ${targetCommit}`);
  // The marker goes down BEFORE the tree changes: if the box dies anywhere in
  // the checkout or rebuild, the next start finds `applying` and rolls back
  // (updateGuard.ts before the daemon runs, the boot gate inside it). Without
  // it an interrupted apply left half-built code and nothing to undo it.
  const marker = { previousCommit: currentCommit, targetCommit, bootAttempts: 0 };
  try {
    await opts.pendingStore.write({ ...marker, stage: "applying" });
  } catch (e) {
    log(`[self-update] could not write pending-verify marker: ${(e as Error).message}; not applying`);
    return { applied: false, reason: "apply-failed" };
  }
  const revert = async (why: string) => {
    log(`[self-update] ${why}; reverting checkout`);
    try {
      await restoreCheckout(opts.runner, opts.repoPath, currentCommit);
      await rebuildWorkspace(opts.runner, opts.repoPath, log);
      await opts.pendingStore.clear();
    } catch (revertErr) {
      // The `applying` marker stays, so the next start rolls back.
      log(`[self-update] revert also failed: ${(revertErr as Error).message}`);
    }
  };
  try {
    await opts.runner("git", ["-C", opts.repoPath, "checkout", targetCommit]);
  } catch (e) {
    // git refuses a checkout before touching the tree, so nothing to undo.
    log(`[self-update] checkout failed: ${(e as Error).message}`);
    await opts.pendingStore.clear().catch(() => {});
    return { applied: false, reason: "apply-failed" };
  }
  try {
    await rebuildWorkspace(opts.runner, opts.repoPath, log);
  } catch (e) {
    await revert(`rebuild failed: ${(e as Error).message}`);
    return { applied: false, reason: "apply-failed" };
  }
  try {
    await opts.pendingStore.write({ ...marker, stage: "staged" });
  } catch (e) {
    // Restarting with the marker still `applying` would only roll back again.
    await revert(`could not mark the update staged: ${(e as Error).message}`);
    return { applied: false, reason: "apply-failed" };
  }

  log("[self-update] staged; restarting into the new code (health gate will verify)");
  opts.requestExit();
  return { applied: true, previousCommit: currentCommit, targetCommit };
}

// ──────────────────────────────────────────────────────────────────────
// Poller (heartbeat cadence)
// ──────────────────────────────────────────────────────────────────────

export interface UpdateConsumerPoller {
  pollOnce(): Promise<UpdateConsumeOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the update lane on the daemon heartbeat cadence (default 5 min). Stops
 * itself after a successful stage (the restart is imminent) or while a staged
 * update awaits its boot verdict. Mirrors buildDecommissionPoller's shape; the
 * timer is unref'd so it never keeps the process alive on its own.
 */
export function buildUpdateConsumerPoller(
  opts: RunUpdateConsumerOptions & {
    intervalMs?: number;
    /** Records refusals the owner should see (see updateOutcome.ts). */
    outcomeStore?: UpdateOutcomeStore;
  },
): UpdateConsumerPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<UpdateConsumeOutcome> {
    const out = await runUpdateConsumer(opts);
    const refusal = refusalRecord(out, (opts.now ?? Date.now)());
    if (refusal && opts.outcomeStore) {
      await opts.outcomeStore.write(refusal).catch(() => {});
    }
    if (out.applied || (!out.applied && out.reason === "pending-verify")) stop();
    return out;
  }
  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}
