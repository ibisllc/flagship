import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { keepCorruptAside, readStateFile, removeDurable, withFileLock, writeFileDurable } from "./durableFile.js";
import { promisify } from "node:util";
import {
  verifyUpdateOrder,
  type AdminGrantView,
  type UpdateOrder,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import { readInstalledReleaseSync, type ReleaseSwapper, ArtifactRefusedError } from "./artifactUpdate.js";
import type { AuthorityHub } from "./authority/hub.js";
import { LedgerError } from "./authority/operationLedger.js";
import { digestOf, runOrderOperation, type OrderOperationContext } from "./authority/orderOperation.js";
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
 *   2. AUTHENTICITY — the target must be a release artifact signed by enough
 *      baked-in release keys (the injected `ReleaseSwapper`, production:
 *      `buildArtifactSwapper`). An admin key compromise is therefore NOT
 *      arbitrary code execution — only a signed release can ever be applied.
 *
 * Anti-replay / anti-skip gates (each independently rejecting):
 *   - `serverDomain` must name THIS box;
 *   - `issuedAt` freshness window (default = the `.com` lane's 14d TTL);
 *   - `nonce` single-use (persisted used-nonce marker — `.com`'s consume-once
 *     is the primary guard, the marker survives a rollback + redelivery);
 *   - `fromCommit` must equal the commit of the release the box runs now
 *     (a stale order for an older/newer base can never apply).
 *
 * Apply (CODE SWAP ONLY — never touches /var/flagship keys/data):
 *   download the signed release for the target commit → verify it (k-of-n
 *   signatures, digest, architecture, sequence, Node floor; nothing of it runs
 *   before that) → switch releases atomically → write the pending-verify marker
 *   → exit(0) so systemd restarts into the new code. The boot-time health gate
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
 * Lazily-cached reader of the release this box runs: the SAME applied-commit
 * truth step 7 of the consumer enforces `fromCommit` against. The installer
 * records it (`artifact-current.json`) when it switches releases. The screens
 * BFF surfaces it on server-detail so clients can display the current version
 * and mint `fromCommit` from the box's real release instead of guessing.
 *
 * Sync (the BFF's server-detail builder is synchronous) and cached after the
 * first read: the running release only changes across a daemon restart (the
 * consumer exits into systemd after the switch). Returns null when the box was
 * not installed from a signed artifact or the read fails; clients disable the
 * update action on null.
 */
export function buildCurrentCommitProvider(
  stateDir: string = "/var/flagship",
  readRelease: (dir: string) => { commit: string } | null = readInstalledReleaseSync,
): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = readRelease(stateDir)?.commit ?? null;
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
  /** Whether the order (`nonce`, `issuedAt`) must be treated as already used. */
  has(nonce: string, issuedAt: number): Promise<boolean>;
  mark(nonce: string): Promise<void>;
}

const MAX_STORED_NONCES = 500;

interface UsedNonces {
  nonces: string[];
  /** Set when the file was lost: every order issued at or before it counts as used. */
  refuseIssuedBefore?: number;
}

function parseUsedNonces(text: string): UsedNonces {
  const v = JSON.parse(text) as { nonces?: unknown; refuseIssuedBefore?: unknown };
  if (!v || typeof v !== "object" || !Array.isArray(v.nonces)) throw new Error("not a used-nonce list");
  return {
    nonces: v.nonces.filter((n): n is string => typeof n === "string"),
    ...(typeof v.refuseIssuedBefore === "number" ? { refuseIssuedBefore: v.refuseIssuedBefore } : {}),
  };
}

/**
 * Default file-backed store: a small JSON `{nonces: string[]}`, newest-last.
 * An unreadable file can't say which orders were used, so it fails closed:
 * it is set aside and every order issued before that moment counts as used
 * (the owner sends a fresh one), never as unused.
 */
export function fileUsedNonceStore(path: string, now: () => number = () => Date.now()): UsedNonceStore {
  async function current(): Promise<UsedNonces> {
    const read = await readStateFile(path);
    if (read.kind === "missing") return { nonces: [] };
    try {
      if (read.kind === "unreadable") throw read.error;
      return parseUsedNonces(read.text);
    } catch (e) {
      const closed: UsedNonces = { nonces: [], refuseIssuedBefore: now() };
      await keepCorruptAside(path, e, "Update orders sent before now are refused; send the update again.");
      await writeFileDurable(path, JSON.stringify(closed));
      return closed;
    }
  }
  return {
    async has(nonce, issuedAt) {
      const s = await current();
      if (s.refuseIssuedBefore !== undefined && issuedAt <= s.refuseIssuedBefore) return true;
      return s.nonces.includes(nonce.toLowerCase());
    },
    async mark(nonce) {
      await current();
      // Read-modify-write in turn: the update consumer and a co-manager's
      // update share this file, and two marks at once kept only one nonce.
      await withFileLock(path, async (write) => {
        let s: UsedNonces;
        try {
          s = parseUsedNonces(await readFile(path, "utf-8"));
        } catch (e) {
          s = (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { nonces: [] } : { nonces: [], refuseIssuedBefore: now() };
        }
        s.nonces.push(nonce.toLowerCase());
        s.nonces = s.nonces.slice(-MAX_STORED_NONCES);
        await write(JSON.stringify(s));
      });
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

  /**
   * The AUTHENTICITY half and the code swap in one: download the release for the target
   * commit, verify its k-of-n signatures, digest, architecture and sequence, switch to it.
   * Tests inject a fake; production is `buildArtifactSwapper`.
   */
  swapper: ReleaseSwapper;
  /** Record each apply as a ledger operation (production wires it). */
  operations?: { hub: AuthorityHub; grantDeps: string[] };
  /** The commit of the release this box runs now (production: the installer's record). */
  currentCommit: () => string | null | Promise<string | null>;
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
        | "apply-failed"
        | "busy";
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
  //    never stack a second one on top. One being applied right now (a
  //    co-manager's order, or the first-boot move) leaves the deposit for
  //    the next poll.
  if (updateApplyInProgress()) return { applied: false, reason: "busy" };
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

  const admitted = await admitUpdateOrder(opts, order);
  if (!admitted.admitted) return admitted.outcome;
  return applyEndorsedUpdate(opts, admitted.currentCommit, order.targetCommit, "admin-authorized, maintainer-endorsed", {
    requester: "owner",
    by: "admin",
    signatureHex: Buffer.from(signature).toString("hex"),
  });
}

export interface AdmitUpdateOrderOptions {
  serverDomain: string;
  currentCommit: () => string | null | Promise<string | null>;
  usedNonceStore: UsedNonceStore;
  maxOrderAgeMs?: number;
  futureSkewMs?: number;
  now?: () => number;
  onLog?: (m: string) => void;
}

export type AdmitUpdateOrderResult =
  | { admitted: true; currentCommit: string }
  | { admitted: false; outcome: Extract<UpdateConsumeOutcome, { applied: false }> };

/**
 * The replay and base gates every authorized update order passes before the
 * endorsement check, whoever signed it (the owner's order from `.com`, or a
 * co-manager's straight to the box): it names this box, it is fresh, its
 * nonce is new, and it was made for the commit the box runs. Burns the nonce
 * on success, before any side effect.
 */
export async function admitUpdateOrder(
  opts: AdmitUpdateOrderOptions,
  order: UpdateOrder,
): Promise<AdmitUpdateOrderResult> {
  const log = opts.onLog ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const refuse = (reason: Extract<UpdateConsumeOutcome, { applied: false }>["reason"]): AdmitUpdateOrderResult => ({
    admitted: false,
    outcome: { applied: false, reason },
  });

  // 4. The order must name THIS box.
  if (order.serverDomain.toLowerCase() !== opts.serverDomain.toLowerCase()) {
    log(
      `[self-update] order names ${order.serverDomain}, not this box ${opts.serverDomain}; ignoring`,
    );
    return refuse("wrong-domain");
  }

  // 5. issuedAt freshness (anti-replay of an ancient order; the `.com` lane's
  //    TTL is the primary bound, this is the box-side independent check).
  const age = now() - order.issuedAt;
  if (age > (opts.maxOrderAgeMs ?? DEFAULT_MAX_ORDER_AGE_MS) || age < -(opts.futureSkewMs ?? DEFAULT_FUTURE_SKEW_MS)) {
    log(`[self-update] order issuedAt out of window (age ${age}ms); ignoring`);
    return refuse("stale");
  }

  // 6. Nonce single-use (survives rollback + redelivery — a rolled-back update
  //    can never be replayed onto the box with the same order).
  try {
    if (await opts.usedNonceStore.has(order.nonce, order.issuedAt)) {
      log("[self-update] nonce already consumed; ignoring replay");
      return refuse("replayed-nonce");
    }
  } catch (e) {
    // A store that can't answer can't rule out a replay (a rolled-back
    // release coming back): refuse rather than assume "not used".
    log(`[self-update] used-nonce store unreadable (${(e as Error).message}); refusing`);
    return refuse("error");
  }

  // 7. fromCommit must equal the CURRENT HEAD (anti-replay/anti-skip: an order
  //    minted against a different base never applies).
  let currentCommit: string;
  try {
    const head = await opts.currentCommit();
    if (!head) {
      log("[self-update] this box was not installed from a signed release; cannot update it in place");
      return refuse("error");
    }
    currentCommit = head.toLowerCase();
  } catch (e) {
    log(`[self-update] cannot read the running release: ${(e as Error).message}`);
    return refuse("error");
  }
  if (order.fromCommit.toLowerCase() !== currentCommit) {
    log(
      `[self-update] order fromCommit ${order.fromCommit} != current HEAD ${currentCommit}; ignoring`,
    );
    return refuse("from-commit-mismatch");
  }

  // 8. Burn the nonce BEFORE any side effect (a crash mid-apply must not make
  //    the order replayable). Best-effort: `.com`'s consume-once already burned
  //    the deposit itself.
  try {
    await opts.usedNonceStore.mark(order.nonce);
  } catch (e) {
    log(`[self-update] could not persist used nonce (${(e as Error).message}); continuing`);
  }

  return { admitted: true, currentCommit };
}

export interface ApplyEndorsedUpdateOptions {
  swapper: ReleaseSwapper;
  pendingStore: PendingVerifyStore;
  requestExit: () => void;
  onLog?: (m: string) => void;
  /** Record the apply as a ledger operation, cancelled if the grants it depends on are revoked. */
  operations?: { hub: AuthorityHub; grantDeps: string[] };
}

/** Who signed the order being applied, when one did (the first-boot move is release-signed only). */
export interface ApplyApproval {
  requester: string;
  by: string;
  signatureHex: string;
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
  approval?: ApplyApproval,
): Promise<UpdateConsumeOutcome> {
  if (applying) return { applied: false, reason: "busy" };
  applying = true;
  try {
    if (!opts.operations || !approval) return await applyEndorsedUpdateNow(opts, currentCommit, targetCommit, why);
    let outcome: UpdateConsumeOutcome = { applied: false, reason: "apply-failed" };
    const ran = await runOrderOperation(
      opts.operations.hub,
      {
        kind: "server-update",
        requester: approval.requester,
        idempotencyKey: digestOf("server-update", currentCommit, targetCommit, approval.signatureHex),
        canonicalPayload: ["flagship/operation/server-update/v1", currentCommit, targetCommit].join("|"),
        capabilityDigest: targetCommit,
        grantDeps: opts.operations.grantDeps,
        approvedBy: approval.by,
        orderSignatureHex: approval.signatureHex,
        label: `update to ${targetCommit.slice(0, 8)}`,
      },
      async (ctx) => {
        outcome = await applyEndorsedUpdateNow(opts, currentCommit, targetCommit, why, ctx);
        if (!outcome.applied) throw new Error(`update not applied: ${outcome.reason}`);
        return { value: outcome, resultDigest: digestOf("server-update", targetCommit) };
      },
    );
    if (ran.ran) return ran.value;
    if (ran.reason === "in-progress") return { applied: false, reason: "busy" };
    const last = outcome as UpdateConsumeOutcome;
    if (!last.applied && last.reason !== "apply-failed") return last;
    return { applied: false, reason: ran.reason === "already-applied" ? "busy" : "apply-failed" };
  } finally {
    applying = false;
  }
}

let applying = false;

/** True while this process fetches, checks or applies an update. */
export function updateApplyInProgress(): boolean {
  return applying;
}

async function applyEndorsedUpdateNow(
  opts: ApplyEndorsedUpdateOptions,
  currentCommit: string,
  targetCommit: string,
  why: string,
  ctx?: OrderOperationContext,
): Promise<UpdateConsumeOutcome> {
  const log = opts.onLog ?? (() => {});
  // 9. Apply: download + verify + switch releases, stage the pending-verify marker, restart.
  //    CODE SWAP ONLY — /var/flagship (keys/data) is never touched. The installer checks the
  //    k-of-n release signatures, digest, architecture, sequence and Node floor before
  //    anything of the release runs; a refusal changes nothing.
  log(`[self-update] applying ${why} update ${currentCommit} → ${targetCommit}`);
  // The marker goes down BEFORE the release changes: if the box dies anywhere in the
  // switch, the next start finds `applying` and rolls back (updateGuard.ts before the
  // daemon runs, the boot gate inside it).
  const marker = { previousCommit: currentCommit, targetCommit, bootAttempts: 0 };
  try {
    await opts.pendingStore.write({ ...marker, stage: "applying" });
  } catch (e) {
    log(`[self-update] could not write pending-verify marker: ${(e as Error).message}; not applying`);
    return { applied: false, reason: "apply-failed" };
  }
  const revert = async (why: string) => {
    log(`[self-update] ${why}; switching back to ${currentCommit}`);
    try {
      await opts.swapper.restore(currentCommit);
      await opts.pendingStore.clear();
    } catch (revertErr) {
      // The `applying` marker stays, so the next start rolls back.
      log(`[self-update] revert also failed: ${(revertErr as Error).message}`);
    }
  };
  try {
    // The release swap is the point of no return: authority is checked again here.
    await ctx?.crossPointOfNoReturn();
    await opts.swapper.install(targetCommit);
  } catch (e) {
    if (e instanceof LedgerError) {
      log(`[self-update] cancelled before the swap: ${e.message}`);
      await opts.pendingStore.clear().catch(() => {});
      return { applied: false, reason: "apply-failed" };
    }
    if (e instanceof ArtifactRefusedError) {
      log(`[self-update] REFUSED: ${e.message}`);
      await opts.pendingStore.clear().catch(() => {});
      return { applied: false, reason: "unendorsed" };
    }
    await revert(`install failed: ${(e as Error).message}`);
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
