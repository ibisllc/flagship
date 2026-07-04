import { readFile, writeFile } from "node:fs/promises";
import {
  isMigrationDisposition,
  signServerMigrationAck,
  signServerMigrationAttach,
  verifyServerMigrationOrder,
  type AdminGrantView,
  type Keypair,
  type ServerMigrationAck,
  type ServerMigrationAttach,
  type ServerMigrationOrder,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

/**
 * Box-side server-migration consumer (docs/server-migration.md) — the NEW
 * box's driver. The fresh replacement box boots as an ordinary same-account
 * pod (its own provisional FQDN + STK); this consumer discovers the account's
 * migration session on `.com`, RE-VERIFIES the admin-signed MigrationOrder
 * under the config-pinned authority (`authorizeSensitiveOrder` — `.com` is
 * never a trust anchor), then drives the new-box half of the state machine:
 *
 *   initiated   → attach myself (STK-signed)
 *   provisioned → pre-seed restore (peer-backup, injected) → ack pre-seeded
 *   pre-seeded / ready → wait (the phone drives)
 *   freezing    → wait for the final-delta barrier, restore the delta,
 *                 ack take-over (the fail-safe key-off + directory rebind)
 *   taken-over  → fire onTakeOver (production: write the re-home marker for
 *                 the migrated name + restart — the transfer-a-box boot path
 *                 re-homes FQDN/cert/entitlement with zero new code)
 *   aborted     → stand down; the old box stays authoritative
 *
 * Consumer discipline (clones decommission/selfDelete): NEVER throws — every
 * poll returns an outcome; idempotent via a small marker file (a crash
 * mid-phase resumes exactly where the server-side phase says); every
 * side-effect (fetch, restore, marker, clock, take-over hook) is injected.
 *
 * The OLD box needs no new consumer: the freeze phase rides the existing
 * decommission order verbatim. Its only migration-awareness is the
 * handoff-confirm poll below (`buildMigrationAwareHandoffConfirm`), which
 * keys the wipe-after-handoff gate off the migration session's take-over
 * instead of the replacement-eviction heuristic when a session exists.
 */

const HEX = /^[0-9a-f]+$/;

function hexToBytes(hexStr: string): Uint8Array {
  if (hexStr.length % 2 !== 0) throw new Error("hex must have even length");
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

// ──────────────────────────────────────────────────────────────────────
// Order decode + verify (mirrors decodeAndVerifyDecommissionOrder)
// ──────────────────────────────────────────────────────────────────────

export function decodeAndVerifyMigrationOrder(args: {
  orderJson: string;
  orderSignatureHex: string;
  ownerIrkPub: Uint8Array;
  adminRootPub?: Uint8Array;
  username?: string;
  activeGrants?: readonly AdminGrantView[];
}): ServerMigrationOrder {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.orderJson);
  } catch (e) {
    throw new Error(`migration order is not valid JSON: ${(e as Error).message}`);
  }
  const p = parsed as Partial<ServerMigrationOrder>;
  if (
    typeof p.serverDomain !== "string" ||
    typeof p.oldStkPubHex !== "string" ||
    !isMigrationDisposition(p.diskDisposition) ||
    typeof p.nonce !== "string" ||
    typeof p.issuedAt !== "number"
  ) {
    throw new Error("migration order is missing required fields");
  }
  const sigHex = args.orderSignatureHex.toLowerCase();
  if (!HEX.test(sigHex) || sigHex.length !== 128) {
    throw new Error("migration signature is not 64 bytes hex");
  }
  const order: ServerMigrationOrder = {
    serverDomain: p.serverDomain,
    oldStkPubHex: p.oldStkPubHex,
    diskDisposition: p.diskDisposition,
    nonce: p.nonce,
    issuedAt: p.issuedAt,
  };
  if (
    !authorizeSensitiveOrder({
      order,
      signature: hexToBytes(sigHex),
      verify: verifyServerMigrationOrder,
      ownerIrkPub: args.ownerIrkPub,
      adminRootPub: args.adminRootPub,
      username: args.username ?? "",
      activeGrants: args.activeGrants,
    })
  ) {
    throw new Error("migration order is not authorized (admin root / owner IRK)");
  }
  return order;
}

// ──────────────────────────────────────────────────────────────────────
// Marker store (idempotent resume)
// ──────────────────────────────────────────────────────────────────────

export type MigrationStage = "attached" | "pre-seeded" | "taken-over";

export interface MigrationMarker {
  serverDomain: string;
  stage: MigrationStage;
  updatedAt: number;
}

export interface MigrationMarkerStore {
  load(): Promise<MigrationMarker | null>;
  save(m: MigrationMarker): Promise<void>;
}

export function fileMigrationMarkerStore(
  path = "/var/flagship/migration-state.json",
): MigrationMarkerStore {
  return {
    async load() {
      try {
        const m = JSON.parse(await readFile(path, "utf-8")) as Partial<MigrationMarker>;
        if (
          typeof m.serverDomain !== "string" ||
          (m.stage !== "attached" && m.stage !== "pre-seeded" && m.stage !== "taken-over")
        ) {
          return null;
        }
        return {
          serverDomain: m.serverDomain.toLowerCase(),
          stage: m.stage,
          updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0,
        };
      } catch {
        return null;
      }
    },
    async save(m) {
      await writeFile(path, JSON.stringify(m), { mode: 0o600 });
    },
  };
}

export function memoryMigrationMarkerStore(): MigrationMarkerStore {
  let m: MigrationMarker | null = null;
  return {
    async load() {
      return m ? { ...m } : null;
    },
    async save(next) {
      m = { ...next };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// The consumer
// ──────────────────────────────────────────────────────────────────────

/** The `.com` session view both GETs serve (subset the consumer relies on). */
interface SessionView {
  serverDomain?: string;
  phase?: string;
  orderJson?: string;
  orderSignatureHex?: string;
  newServerDomain?: string | null;
  newStkPubHex?: string | null;
  finalDeltaAt?: number | null;
}

export interface MigrationRestoreResult {
  complete: boolean;
  detail?: string;
}

export interface RunMigrationConsumerOptions {
  /** THIS (new) box's own registered pod FQDN. */
  myServerDomain: string;
  /** THIS box's registered identity keypair — signs the attach + acks. */
  myStk: Keypair;
  /** Config-pinned owner IRK — the legacy order-verification anchor. */
  ownerIrkPub: Uint8Array;
  /** Config-pinned admin master root (Slice D) — when present, the order must
   *  carry master-admin authority; an owner-IRK order is refused. */
  adminRootPub?: Uint8Array;
  username?: string;
  activeGrants?: readonly AdminGrantView[];
  controlPlaneBaseUrl: string;
  /**
   * The peer-backup restore pass for the MIGRATING server's data (injected;
   * production wraps `runRestoreOnce` with the deposited SWK — which the
   * phone derived for the MIGRATING serverId — and a shard fetcher that
   * authenticates as THIS pod). Idempotent/resumable by construction, so the
   * pre-seed pass and the final-delta pass are the same call: the second run
   * only fetches what the final flush changed.
   */
  restore: (args: { serverId: string }) => Promise<MigrationRestoreResult>;
  /**
   * Fired ONCE when take-over is acked (or discovered already-acked after a
   * crash). Production writes the re-home marker for the migrated name and
   * restarts the daemon (cert re-mint + tunnel claim happen organically on
   * the re-homed boot). Failures are logged, never thrown; the marker still
   * records taken-over so a re-poll re-fires onTakeOver only via the
   * `alreadyTakenOver` recovery path below.
   */
  onTakeOver?: (args: { serverDomain: string }) => void | Promise<void>;
  markerStore: MigrationMarkerStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
}

export type MigrationConsumerOutcome =
  | { status: "no-assignment" }
  | { status: "not-mine"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "error"; reason: string }
  | { status: "attached" }
  | { status: "restoring"; detail?: string }
  | { status: "pre-seeded" }
  | { status: "waiting"; phase: string }
  | { status: "taken-over" }
  | { status: "aborted" }
  | { status: "done" };

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) return { status: res.status, body: null };
    return { status: res.status, body: await res.json() };
  } catch {
    return null;
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON body — status is what matters */
    }
    return { status: res.status, body: parsed };
  } catch {
    return null;
  }
}

/** One poll of the new-box migration driver. Never throws. */
export async function runMigrationConsumer(
  opts: RunMigrationConsumerOptions,
): Promise<MigrationConsumerOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const me = opts.myServerDomain.toLowerCase();
  const myStkHex = bytesToHex(opts.myStk.publicKey);

  let marker: MigrationMarker | null = null;
  try {
    marker = await opts.markerStore.load();
  } catch {
    marker = null;
  }
  if (marker?.stage === "taken-over") return { status: "done" };

  // 1. Locate the session: by the marker's pinned domain once attached,
  //    else via the assignment read keyed by MY OWN pod name.
  const url = marker
    ? `${base}/api/server/${encodeURIComponent(marker.serverDomain)}/migration`
    : `${base}/api/server/${encodeURIComponent(me)}/migration-assignment`;
  const res = await getJson(fetchImpl, url);
  if (!res) return { status: "error", reason: "control plane unreachable" };
  if (res.status === 404) return { status: "no-assignment" };
  const s = (res.body ?? {}) as SessionView;
  if (
    typeof s.serverDomain !== "string" ||
    typeof s.phase !== "string" ||
    typeof s.orderJson !== "string" ||
    typeof s.orderSignatureHex !== "string"
  ) {
    return { status: "error", reason: "malformed session" };
  }
  const domain = s.serverDomain.toLowerCase();
  if (domain === me) {
    // I AM the migrating server — this session is the OLD box's business
    // (its decommission consumer), never the new-box driver's.
    return { status: "not-mine", reason: "session targets this box itself" };
  }

  // 2. RE-VERIFY the admin-signed order under OUR pinned authority. A forged
  //    or `.com`-invented session must never make this box attach or restore.
  let order: ServerMigrationOrder;
  try {
    order = decodeAndVerifyMigrationOrder({
      orderJson: s.orderJson,
      orderSignatureHex: s.orderSignatureHex,
      ownerIrkPub: opts.ownerIrkPub,
      ...(opts.adminRootPub ? { adminRootPub: opts.adminRootPub } : {}),
      ...(opts.username ? { username: opts.username } : {}),
      ...(opts.activeGrants ? { activeGrants: opts.activeGrants } : {}),
    });
  } catch (e) {
    log(`[migration] order rejected: ${(e as Error).message}`);
    return { status: "rejected", reason: (e as Error).message };
  }
  if (order.serverDomain.toLowerCase() !== domain) {
    return { status: "rejected", reason: "order serverDomain does not match the session" };
  }

  if (s.phase === "aborted") {
    log(`[migration] session for ${domain} is aborted — standing down (old box stays authoritative)`);
    return { status: "aborted" };
  }

  // 3. Attached to someone else? Not my migration.
  if (s.newStkPubHex && s.newStkPubHex.toLowerCase() !== myStkHex) {
    return { status: "not-mine", reason: "another box is attached" };
  }

  // 4. Drive by the server-side phase (the marker only accelerates resume —
  //    the .com phase is authoritative, so a crash mid-phase self-heals).
  switch (s.phase) {
    case "initiated": {
      const attach: ServerMigrationAttach = {
        serverDomain: domain,
        newServerDomain: me,
        newStkPubHex: myStkHex,
        issuedAt: now(),
      };
      const sig = signServerMigrationAttach(attach, opts.myStk);
      const r = await postJson(
        fetchImpl,
        `${base}/api/server/${encodeURIComponent(domain)}/migration/attach`,
        { attach, signatureHex: bytesToHex(sig) },
      );
      if (!r) return { status: "error", reason: "attach failed: unreachable" };
      if (r.status === 409) return { status: "not-mine", reason: "another box attached first" };
      if (r.status !== 200) return { status: "error", reason: `attach failed: ${r.status}` };
      await saveMarker(opts, { serverDomain: domain, stage: "attached", updatedAt: now() }, log);
      log(`[migration] attached as the replacement for ${domain}`);
      return { status: "attached" };
    }

    case "provisioned": {
      // Pre-seed: restore the latest peer-backup while the old box serves.
      const out = await safeRestore(opts, domain, log);
      if (!out.complete) {
        return { status: "restoring", ...(out.detail !== undefined ? { detail: out.detail } : {}) };
      }
      const posted = await postAck(opts, fetchImpl, base, domain, "pre-seeded", now(), log);
      if (!posted.ok) return { status: "error", reason: posted.reason };
      await saveMarker(opts, { serverDomain: domain, stage: "pre-seeded", updatedAt: now() }, log);
      log(`[migration] pre-seed restore complete for ${domain}`);
      return { status: "pre-seeded" };
    }

    case "pre-seeded":
    case "ready":
      return { status: "waiting", phase: s.phase };

    case "freezing": {
      if (s.finalDeltaAt == null) {
        // The old box hasn't flushed the final delta yet — the write-frozen
        // window is open; keep the poll tight (the poller's active cadence).
        return { status: "waiting", phase: "freezing" };
      }
      const out = await safeRestore(opts, domain, log);
      if (!out.complete) {
        return { status: "restoring", ...(out.detail !== undefined ? { detail: out.detail } : {}) };
      }
      const posted = await postAck(opts, fetchImpl, base, domain, "take-over", now(), log);
      if (!posted.ok) return { status: "error", reason: posted.reason };
      await saveMarker(opts, { serverDomain: domain, stage: "taken-over", updatedAt: now() }, log);
      await fireTakeOver(opts, domain, log);
      log(`[migration] TAKE-OVER acked for ${domain} — re-homing`);
      return { status: "taken-over" };
    }

    case "taken-over": {
      // Crash-recovery: the ack landed but the marker (or the re-home) didn't
      // — a marker already at taken-over returned "done" at the top, so
      // reaching here means the local side never finished; finish it now.
      await saveMarker(opts, { serverDomain: domain, stage: "taken-over", updatedAt: now() }, log);
      await fireTakeOver(opts, domain, log);
      return { status: "done" };
    }

    default:
      return { status: "error", reason: `unknown phase ${s.phase}` };
  }
}

async function safeRestore(
  opts: RunMigrationConsumerOptions,
  serverId: string,
  log: (m: string) => void,
): Promise<MigrationRestoreResult> {
  try {
    return await opts.restore({ serverId });
  } catch (e) {
    log(`[migration] restore pass failed (will retry): ${(e as Error).message}`);
    return { complete: false, detail: (e as Error).message };
  }
}

async function postAck(
  opts: RunMigrationConsumerOptions,
  fetchImpl: typeof fetch,
  base: string,
  domain: string,
  phase: ServerMigrationAck["phase"],
  issuedAt: number,
  log: (m: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const ack: ServerMigrationAck = {
    serverDomain: domain,
    stkPubHex: bytesToHex(opts.myStk.publicKey),
    phase,
    issuedAt,
  };
  const sig = signServerMigrationAck(ack, opts.myStk);
  const path = phase === "pre-seeded" ? "pre-seeded" : "take-over";
  const r = await postJson(fetchImpl, `${base}/api/server/${encodeURIComponent(domain)}/migration/${path}`, {
    ack,
    signatureHex: bytesToHex(sig),
  });
  if (!r) return { ok: false, reason: `${phase} ack failed: unreachable` };
  if (r.status !== 200) {
    log(`[migration] ${phase} ack refused: ${r.status}`);
    return { ok: false, reason: `${phase} ack refused: ${r.status}` };
  }
  return { ok: true };
}

async function saveMarker(
  opts: RunMigrationConsumerOptions,
  m: MigrationMarker,
  log: (msg: string) => void,
): Promise<void> {
  try {
    await opts.markerStore.save(m);
  } catch (e) {
    // Never fatal: the .com phase is authoritative; the marker only speeds resume.
    log(`[migration] failed to write marker (continuing): ${(e as Error).message}`);
  }
}

async function fireTakeOver(
  opts: RunMigrationConsumerOptions,
  domain: string,
  log: (m: string) => void,
): Promise<void> {
  try {
    await opts.onTakeOver?.({ serverDomain: domain });
  } catch (e) {
    log(`[migration] onTakeOver hook failed: ${(e as Error).message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Poller (adaptive cadence: slow while idle, tight during the freeze window)
// ──────────────────────────────────────────────────────────────────────

export interface MigrationPoller {
  pollOnce(): Promise<MigrationConsumerOutcome>;
  start(): void;
  stop(): void;
}

const TERMINAL: ReadonlySet<MigrationConsumerOutcome["status"]> = new Set([
  "done",
  "taken-over",
  "aborted",
  "not-mine",
]);

export function buildMigrationPoller(
  opts: RunMigrationConsumerOptions & { idleIntervalMs?: number; activeIntervalMs?: number },
): MigrationPoller {
  const idleMs = opts.idleIntervalMs ?? 5 * 60_000;
  const activeMs = opts.activeIntervalMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  async function pollOnce(): Promise<MigrationConsumerOutcome> {
    const out = await runMigrationConsumer(opts);
    if (TERMINAL.has(out.status)) stop();
    return out;
  }
  function schedule(ms: number) {
    if (stopped) return;
    timer = setTimeout(() => void tick(), ms);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  }
  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    let out: MigrationConsumerOutcome | null = null;
    try {
      out = await pollOnce();
    } catch {
      /* runMigrationConsumer never throws; belt-and-braces */
    } finally {
      running = false;
    }
    if (stopped || (out && TERMINAL.has(out.status))) return;
    // Tight cadence while a session is actively progressing (esp. the
    // write-frozen freeze window); heartbeat cadence while nothing is up.
    const active =
      out &&
      (out.status === "attached" ||
        out.status === "restoring" ||
        out.status === "pre-seeded" ||
        out.status === "waiting");
    schedule(active ? activeMs : idleMs);
  }
  return {
    pollOnce,
    start() {
      if (timer || stopped) return;
      void tick();
      if (!timer && !stopped) schedule(idleMs);
    },
    stop,
  };
  function stop() {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// OLD-box handoff confirm (migration-aware wipe gate)
// ──────────────────────────────────────────────────────────────────────

/**
 * The old box's `wipe-after-handoff` confirm for a MIGRATION: poll the
 * migration session and confirm ONLY on `taken-over` (the successor restored
 * the final delta, acked, and the directory rebound); an `aborted` session
 * denies immediately (power off, KEEP the data). When no migration session
 * exists for this box, falls back to the injected replacement-restored poll
 * (the plain graceful-replacement heuristic). Never throws.
 */
export async function pollMigrationAwareHandoffConfirm(args: {
  serverDomain: string;
  myStkHex: string;
  controlPlaneBaseUrl: string;
  maxAttempts: number;
  intervalMs: number;
  /** The non-migration fallback (production: pollReplacementRestored). */
  fallback: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (m: string) => void;
}): Promise<boolean> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = args.onLog ?? (() => {});
  const base = args.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(args.serverDomain)}/migration`;
  const myStk = args.myStkHex.toLowerCase();

  for (let attempt = 0; attempt < args.maxAttempts; attempt++) {
    if (attempt > 0) await sleep(args.intervalMs);
    const res = await getJson(fetchImpl, url);
    if (!res) continue; // transient — retry within the budget
    if (res.status === 404) {
      // No migration session — this decommission is a plain replacement.
      log("[migration] no migration session; using the replacement-restored confirm");
      return args.fallback();
    }
    const s = (res.body ?? {}) as { phase?: string; oldStkPubHex?: string };
    if (typeof s.oldStkPubHex === "string" && s.oldStkPubHex.toLowerCase() !== myStk) {
      // A session for a different tenant of this name — not our handoff.
      return args.fallback();
    }
    if (s.phase === "taken-over") {
      log("[migration] take-over confirmed — successor is serving; safe to apply the disposition");
      return true;
    }
    if (s.phase === "aborted") {
      log("[migration] migration ABORTED — denying handoff confirm (data preserved)");
      return false;
    }
  }
  return false;
}
