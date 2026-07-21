import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  verifyAdminRootRotation,
  type AdminRootRotation,
} from "@flagship/protocol";

/**
 * Box-side admin master-root ROTATION consumer
 * (docs/device-admin-tier-spec.md §5 — "the box must not trust `.com`").
 *
 * When credential recovery mints a fresh admin master root, the OLD admin root
 * signs a `flagship/admin-root-rotation/v1` proof (old → new). `.com` records
 * the new root and relays the SIGNED chain, but its report is ADVISORY only.
 * This consumer replaces the blind adoption `rePairWatcher` does for the
 * membership IRK (rePairWatcher.ts:303 — it trusts `.com`'s reported new key):
 * it fetches the account's rotation chain and, for each hop, verifies the proof
 * against the root the box CURRENTLY pins — re-pinning ONLY on a signature that
 * chains from that pinned anchor. `.com` holds no admin master root, so it can
 * relay a new authority root but can never FORGE one; the stored proof, not
 * `.com`'s word, is what re-pins.
 *
 * Persistence (survives restart + feeds the Phase-1 gate):
 *   The box boots pinning `ServerConfig.adminRootPub` (the SEED, from the recipe
 *   AuthCode). A successful re-pin is written to a box-local JSON pin file
 *   (`<dataDir>/admin-root-pin.json`, atomic write-then-rename, 0600). At boot,
 *   `resolvePinnedAdminRoot(seedHex, store)` returns the persisted pin if
 *   present (else the seed); the daemon overrides `cfg.adminRootPub` with it
 *   BEFORE wiring the sensitive-order handlers, so `authorizeSensitiveOrder`
 *   (Phase 1) reads the rotated root. After a re-pin we RESTART (mirroring the
 *   SWK/CGK consumers) so every already-wired handler re-binds to the new
 *   anchor.
 *
 * Safety / self-healing:
 *   - Runs ONLY when the box has a pinned admin root (the caller gates on this);
 *     a legacy box with no admin root is unaffected.
 *   - We re-pin ONLY on a proof that (a) chains from the currently-pinned root
 *     and (b) verifies under it. A rotation NOT signed by the current root — a
 *     fork/junk/`.com`-forged entry — is rejected and the pin is left untouched.
 *   - The chain is replayed old→…→new in one pass, so a box offline across
 *     several rotations catches up fully.
 *   - Idempotent: already-applied leading hops (whose `new` we already pinned)
 *     are skipped; re-polling an unchanged chain is a no-op (no persist, no
 *     restart).
 */

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** One entry of the served rotation chain (GET .../admin-root-rotations). */
export interface RotationChainEntry {
  seq: number;
  oldAdminRootPub: string;
  newAdminRootPub: string;
  issuedAt: number;
  signatureHex: string;
}

/** The persisted box-local re-pin. */
export interface AdminRootPin {
  adminRootPubHex: string;
  /** seq of the last applied rotation (observability + progress). */
  seq: number;
  updatedAt: number;
}

export interface AdminRootPinStore {
  read(): Promise<AdminRootPin | null>;
  write(pin: AdminRootPin): Promise<void>;
}

/** Default file-backed pin store (atomic write-then-rename, 0600). */
export function fileAdminRootPinStore(pinPath: string): AdminRootPinStore {
  return {
    async read() {
      if (!existsSync(pinPath)) return null;
      try {
        const raw = await readFile(pinPath, "utf8");
        const p = JSON.parse(raw) as Partial<AdminRootPin>;
        if (typeof p.adminRootPubHex !== "string" || !HEX64.test(p.adminRootPubHex.toLowerCase())) {
          return null;
        }
        return {
          adminRootPubHex: p.adminRootPubHex.toLowerCase(),
          seq: typeof p.seq === "number" ? p.seq : 0,
          updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
        };
      } catch {
        return null;
      }
    },
    async write(pin) {
      await mkdir(dirname(pinPath), { recursive: true, mode: 0o700 });
      const tmp = `${pinPath}.tmp`;
      await writeFile(tmp, JSON.stringify(pin, null, 2), { mode: 0o600 });
      await rename(tmp, pinPath);
    },
  };
}

/**
 * The effective pinned admin root for this boot: the persisted re-pin if one
 * exists (and is at least as advanced), else the config SEED. Returns lowercase
 * hex, or null when the box has no admin root at all.
 */
export async function resolvePinnedAdminRoot(
  seedAdminRootHex: string | null,
  store: AdminRootPinStore,
): Promise<string | null> {
  const seed = seedAdminRootHex && HEX64.test(seedAdminRootHex.toLowerCase())
    ? seedAdminRootHex.toLowerCase()
    : null;
  const pin = await store.read();
  if (pin && HEX64.test(pin.adminRootPubHex)) return pin.adminRootPubHex;
  return seed;
}

export interface ApplyChainResult {
  /** The pinned root after replaying the chain (unchanged if nothing applied). */
  pinnedHex: string;
  /** Number of hops re-pinned this pass. */
  applied: number;
  /** seq of the last applied hop (0 if none applied). */
  lastSeq: number;
}

/**
 * PURE — replay the rotation chain from `pinnedHex`, verifying each hop against
 * the currently-held root and re-pinning forward. Never throws. Re-pins ONLY on
 * a proof that (a) chains from the held root and (b) verifies under it; the
 * first hop that fails to chain/verify STOPS the replay (we never adopt a root
 * we can't prove). Already-applied leading hops are skipped.
 */
export function applyRotationChain(args: {
  pinnedHex: string;
  username: string;
  chain: readonly RotationChainEntry[];
}): ApplyChainResult {
  let currentHex = args.pinnedHex.toLowerCase();
  let applied = 0;
  let lastSeq = 0;
  let started = false;

  for (const entry of args.chain) {
    const oldHex = String(entry.oldAdminRootPub ?? "").toLowerCase();
    const newHex = String(entry.newAdminRootPub ?? "").toLowerCase();
    const sigHex = String(entry.signatureHex ?? "").toLowerCase();

    if (!started) {
      // Skip historical hops we've already applied (they precede our pinned
      // position in the linear chain). We begin at the hop that departs from
      // the root we currently hold.
      if (oldHex !== currentHex) continue;
      started = true;
    }
    // Once we've started, every subsequent hop MUST depart from where we are;
    // a gap/fork stops the replay.
    if (oldHex !== currentHex) break;
    if (!HEX64.test(newHex) || !HEX128.test(sigHex) || newHex === currentHex) break;

    const rotation: AdminRootRotation = {
      username: args.username,
      oldAdminRootPub: hexToBytes(currentHex),
      newAdminRootPub: hexToBytes(newHex),
      issuedAt: entry.issuedAt,
    };
    // Verify against the PINNED root (== this hop's declared old). A proof not
    // signed by the current root does not re-pin.
    if (!verifyAdminRootRotation(rotation, hexToBytes(sigHex), hexToBytes(currentHex))) break;

    currentHex = newHex;
    applied += 1;
    lastSeq = typeof entry.seq === "number" ? entry.seq : lastSeq;
  }

  return { pinnedHex: currentHex, applied, lastSeq };
}

export interface ClaimAdminRootRotationOptions {
  /** Account name (used in the canonical bytes + the `.com` URL). */
  username: string;
  /**
   * The config-pinned admin root SEED (`ServerConfig.adminRootPub`, hex) — the
   * fallback anchor when no re-pin is persisted. Null ⇒ no admin root; no-op.
   */
  seedAdminRootHex: string | null;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Persisted re-pin store. */
  pinStore: AdminRootPinStore;
  /**
   * Restart the daemon so every sensitive-order handler re-binds to the newly
   * pinned admin root on the next boot. Injected; the daemon wires `process.exit`.
   */
  restart: () => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onLog?: (m: string) => void;
}

export type AdminRootRotationOutcome =
  | { rotated: false; reason: "no-admin-root" | "no-rotation" | "error" }
  | { rotated: true; from: string; to: string; applied: number; seq: number };

/** Fetch the served rotation chain. Returns [] on 404 / any error. */
export async function fetchRotationChain(
  baseUrl: string,
  username: string,
  fetchImpl: typeof fetch,
  onLog: (m: string) => void,
): Promise<RotationChainEntry[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/users/${encodeURIComponent(username)}/admin-root-rotations`;
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return [];
    if (!res.ok) {
      onLog(`[admin-root-rotation] GET ${res.status}; ignoring`);
      return [];
    }
    const body = (await res.json()) as { rotations?: unknown };
    const rows = Array.isArray(body?.rotations) ? body.rotations : [];
    const out: RotationChainEntry[] = [];
    for (const raw of rows) {
      const r = raw as Partial<RotationChainEntry>;
      if (
        typeof r.oldAdminRootPub === "string" &&
        typeof r.newAdminRootPub === "string" &&
        typeof r.signatureHex === "string" &&
        typeof r.issuedAt === "number" &&
        typeof r.seq === "number"
      ) {
        out.push({
          seq: r.seq,
          oldAdminRootPub: r.oldAdminRootPub,
          newAdminRootPub: r.newAdminRootPub,
          issuedAt: r.issuedAt,
          signatureHex: r.signatureHex,
        });
      }
    }
    // Enforce chain order regardless of server ordering.
    out.sort((a, b) => a.seq - b.seq);
    return out;
  } catch (e) {
    onLog(`[admin-root-rotation] GET failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * One poll: fetch the chain, replay it from the box's effective pinned root, and
 * (on a verified advance) persist the new pin + restart. Never throws.
 */
export async function claimAdminRootRotations(
  opts: ClaimAdminRootRotationOptions,
): Promise<AdminRootRotationOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  const now = (opts.now ?? (() => Date.now()))();

  const current = await resolvePinnedAdminRoot(opts.seedAdminRootHex, opts.pinStore);
  if (!current) return { rotated: false, reason: "no-admin-root" };

  const chain = await fetchRotationChain(opts.controlPlaneBaseUrl, opts.username, fetchImpl, log);
  if (chain.length === 0) return { rotated: false, reason: "no-rotation" };

  const result = applyRotationChain({
    pinnedHex: current,
    username: opts.username.toLowerCase(),
    chain,
  });
  if (result.applied === 0 || result.pinnedHex === current) {
    return { rotated: false, reason: "no-rotation" };
  }

  try {
    await opts.pinStore.write({
      adminRootPubHex: result.pinnedHex,
      seq: result.lastSeq,
      updatedAt: now,
    });
  } catch (e) {
    // Do NOT restart if we couldn't persist — a restart would re-read the old
    // seed and re-apply, never converging. Surface + keep polling.
    log(`[admin-root-rotation] persist failed (${(e as Error).message}); keep polling`);
    return { rotated: false, reason: "error" };
  }

  log(
    `[admin-root-rotation] verified re-pin ${current.slice(0, 12)} → ${result.pinnedHex.slice(0, 12)} ` +
      `(${result.applied} hop(s), seq ${result.lastSeq}); restarting to re-bind the admin anchor`,
  );
  opts.restart();
  return {
    rotated: true,
    from: current,
    to: result.pinnedHex,
    applied: result.applied,
    seq: result.lastSeq,
  };
}

export interface AdminRootRotationPoller {
  pollOnce(): Promise<AdminRootRotationOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the rotation lane on the daemon heartbeat cadence (default 5 min). Stops
 * itself after a verified re-pin (the restart is imminent). Mirrors
 * buildSwkDepositPoller's shape; the timer is unref'd. The first tick fires
 * immediately so a box that missed a rotation while offline catches up on boot.
 */
export function buildAdminRootRotationPoller(
  opts: ClaimAdminRootRotationOptions & { intervalMs?: number },
): AdminRootRotationPoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<AdminRootRotationOutcome> {
    const out = await claimAdminRootRotations(opts);
    if (out.rotated) stop();
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
      void pollOnce().catch(() => {});
      timer = setInterval(() => {
        void pollOnce().catch(() => {});
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop,
  };
}
