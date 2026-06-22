import { readFile, writeFile } from "node:fs/promises";

/**
 * Box-side re-home consumer for transfer-a-box
 * (docs/account-deletion-and-name-reclaim.md §4, Layer A).
 *
 * When the owner hands a box to another account, `.com`'s broker performs the
 * NAMESPACE MIGRATION (it moves the `servers` + `routing` records + per-box DNS
 * from `<server>.<giver>` to `<server>.<acquirer>`). But the box's own canonical
 * FQDN is baked at install time (`FLAGSHIP_SUBDOMAIN`), and its config-pinned
 * owner IRK is still the GIVER's — so on its next boot the daemon must learn
 * that ownership moved and re-home.
 *
 * This module is the detection + persistence half. It polls a PUBLIC `.com`
 * read keyed by the box's OLD canonical (`GET /api/server/:old/transfer/rehome`):
 *   - 404 ⇒ never transferred (the common case); do nothing.
 *   - 200 ⇒ a completed transfer; write a small on-disk REHOME MARKER recording
 *     the new canonical FQDN + the acquirer's owner-IRK pub.
 *
 * The marker is consumed at the TOP of daemon boot (index.ts `main`), BEFORE the
 * runtime / entitlement load:
 *   - it overrides `env.serverFqdn` to the new canonical ⇒ `boxCertSans` is
 *     re-derived for `[<server>.<acquirer>, *.<server>.<acquirer>]`, and the
 *     existing A′ "SANs changed at startup ⇒ discard + re-mint" logic re-issues
 *     the LE cert (no new cert code — the per-box ACME just runs on the new name);
 *   - it overrides `cfg.irkPublicKey` to the acquirer IRK ⇒ the existing
 *     entitlement self-heal discards the stale giver-signed bundle (its
 *     podCanonical / signer no longer match) and the relay/deposit lane picks up
 *     a fresh ACQUIRER-minted RootEntitlement, exactly like first-boot.
 *
 * The box does NOT treat `.com` as a key authority here. The acquirer-IRK pub it
 * reads only becomes load-bearing once a fresh acquirer-IRK-SIGNED entitlement
 * verifies under it at HELLO (the hub runs the same check) — a rogue `.com`
 * pointing the box at an attacker IRK still can't produce an entitlement signed
 * by the real acquirer. The marker is idempotent: once the box's live FQDN
 * already equals the marker's target there is nothing more to do.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const FQDN = /^[a-z0-9.-]{1,255}$/;

export interface RehomeMarker {
  /** The NEW canonical FQDN to serve under (`<server>.<acquirer>.<apex>`). */
  newServerDomain: string;
  /** The acquirer's account name (the new owner). */
  acquirerUsername: string;
  /** The acquirer's owner-IRK pubkey, hex — the new config owner IRK. */
  acquirerIrkPubHex: string;
  /** The OLD canonical the re-home was observed against (audit + idempotency). */
  oldServerDomain: string;
  /** When the broker recorded the claim (ms). */
  claimedAt: number;
}

/** Read the persisted re-home marker, or null when absent/unparseable. */
export async function readRehomeMarker(markerPath: string): Promise<RehomeMarker | null> {
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const m = JSON.parse(raw) as Partial<RehomeMarker>;
    if (
      typeof m.newServerDomain !== "string" ||
      !FQDN.test(m.newServerDomain.toLowerCase()) ||
      typeof m.acquirerUsername !== "string" ||
      typeof m.acquirerIrkPubHex !== "string" ||
      !HEX64.test(m.acquirerIrkPubHex.toLowerCase()) ||
      typeof m.oldServerDomain !== "string"
    ) {
      return null;
    }
    return {
      newServerDomain: m.newServerDomain.toLowerCase(),
      acquirerUsername: m.acquirerUsername.toLowerCase(),
      acquirerIrkPubHex: m.acquirerIrkPubHex.toLowerCase(),
      oldServerDomain: m.oldServerDomain.toLowerCase(),
      claimedAt: typeof m.claimedAt === "number" ? m.claimedAt : 0,
    };
  } catch {
    return null;
  }
}

async function writeRehomeMarker(markerPath: string, m: RehomeMarker): Promise<void> {
  await writeFile(markerPath, JSON.stringify(m), { mode: 0o600 });
}

export interface CheckRehomeOptions {
  /** This box's CURRENT live canonical (env.serverFqdn). */
  serverDomain: string;
  /** `.com` base URL. */
  controlPlaneBaseUrl: string;
  /** Where the re-home marker is persisted. */
  markerPath: string;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type RehomeOutcome =
  | { rehomed: false; reason: "no-transfer" | "already-current" | "error" }
  | { rehomed: true; marker: RehomeMarker };

/**
 * One poll: ask `.com` whether this box (its current canonical) was transferred.
 * On a completed transfer, persist the re-home marker. Never throws. The caller
 * (boot path) reads the marker and applies the override on the NEXT start; the
 * poller exists so a box that's already up when the transfer completes notices
 * it and writes the marker (it then re-homes on its next restart — the daemon
 * `Restart=on-failure`/admin restart cycle).
 */
export async function checkAndRecordRehome(opts: CheckRehomeOptions): Promise<RehomeOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.onLog ?? (() => {});
  const base = opts.controlPlaneBaseUrl.replace(/\/+$/, "");
  const url = `${base}/api/server/${encodeURIComponent(opts.serverDomain)}/transfer/rehome`;

  let body: {
    rehomed?: boolean;
    newServerDomain?: string | null;
    acquirerUsername?: string;
    acquirerIrkPub?: string;
    claimedAt?: number;
  };
  try {
    const res = await fetchImpl(url, { method: "GET" });
    if (res.status === 404) return { rehomed: false, reason: "no-transfer" };
    if (!res.ok) {
      log(`[rehome] GET ${res.status}; ignoring`);
      return { rehomed: false, reason: "error" };
    }
    body = (await res.json()) as typeof body;
  } catch (e) {
    log(`[rehome] GET failed: ${(e as Error).message}`);
    return { rehomed: false, reason: "error" };
  }

  if (
    !body.rehomed ||
    typeof body.newServerDomain !== "string" ||
    !FQDN.test(body.newServerDomain.toLowerCase()) ||
    typeof body.acquirerUsername !== "string" ||
    typeof body.acquirerIrkPub !== "string" ||
    !HEX64.test(body.acquirerIrkPub.toLowerCase())
  ) {
    log("[rehome] response missing/malformed fields; ignoring");
    return { rehomed: false, reason: "error" };
  }

  const newDomain = body.newServerDomain.toLowerCase();
  // Idempotent: if we're already serving the new canonical there's nothing to do
  // (a marker may have already been applied and consumed on a prior boot).
  if (newDomain === opts.serverDomain.toLowerCase()) {
    return { rehomed: false, reason: "already-current" };
  }

  const marker: RehomeMarker = {
    newServerDomain: newDomain,
    acquirerUsername: body.acquirerUsername.toLowerCase(),
    acquirerIrkPubHex: body.acquirerIrkPub.toLowerCase(),
    oldServerDomain: opts.serverDomain.toLowerCase(),
    claimedAt: typeof body.claimedAt === "number" ? body.claimedAt : 0,
  };
  try {
    await writeRehomeMarker(opts.markerPath, marker);
  } catch (e) {
    log(`[rehome] failed to write marker: ${(e as Error).message}`);
    return { rehomed: false, reason: "error" };
  }
  log(
    `[rehome] transfer detected: ${opts.serverDomain} → ${newDomain} ` +
      `(new owner ${marker.acquirerUsername}); marker written, re-home on next restart`,
  );
  return { rehomed: true, marker };
}

export interface RehomePoller {
  pollOnce(): Promise<RehomeOutcome>;
  start(): void;
  stop(): void;
}

/**
 * Poll the re-home read on the heartbeat cadence (default 5 min). Stops itself
 * once a marker is written (the box re-homes on its next restart — nothing more
 * for the live process to do). Mirrors buildSelfDeletePoller's shape; the timer
 * is unref'd so it never keeps the process alive on its own.
 */
export function buildRehomePoller(opts: CheckRehomeOptions & { intervalMs?: number }): RehomePoller {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function pollOnce(): Promise<RehomeOutcome> {
    const out = await checkAndRecordRehome(opts);
    if (out.rehomed) stop();
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
