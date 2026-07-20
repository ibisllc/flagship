import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  verifyAdminRootTransfer,
  verifyRehomeAuthorization,
  type AdminRootTransfer,
  type RehomeAuthorization,
} from "@flagship/protocol";

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
 *
 * ADMIN AUTHORITY (Slice D §9.8 — docs/device-admin-tier-spec.md): the same
 * "never `.com`'s word" posture holds for the box's pinned ADMIN MASTER ROOT
 * (`cfg.adminRootPub`), and the proof is even stronger than the IRK story
 * above — the anchor re-pins ONLY on a giver-root-SIGNED
 * `flagship/admin-root-transfer/v1` proof this consumer verifies LOCALLY
 * against the root the box already pins (old giver root → new acquirer root,
 * bound to this box's OLD canonical + the offer's nonce). `.com` relays the
 * proof but cannot forge it (it holds no admin master root). A box WITH a
 * pinned admin root therefore REFUSES to write the re-home marker until a
 * valid proof arrives (`awaiting-admin-handoff` — the poller keeps polling so
 * a late giver deposit is picked up); a legacy box with no admin root re-homes
 * exactly as before, byte-identical marker included.
 */

const HEX64 = /^[0-9a-f]{64}$/;
const FQDN = /^[a-z0-9.-]{1,255}$/;

function hexToBytesLocal(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface ParsedAdminHandoff {
  giverUsername: string;
  acquirerUsername: string;
  oldAdminRootPub: string;
  newAdminRootPub: string;
  transferNonce: string;
  issuedAt: number;
  signatureHex: string;
}

/** Shape-validate the relayed admin handoff (all hex lowercased). Null on any
 *  malformation — the caller treats that as "no proof yet". */
function parseAdminHandoff(h: unknown): ParsedAdminHandoff | null {
  const HEX128 = /^[0-9a-f]{128}$/;
  const o = h as Partial<ParsedAdminHandoff> | undefined;
  if (
    !o ||
    typeof o.giverUsername !== "string" ||
    typeof o.acquirerUsername !== "string" ||
    typeof o.oldAdminRootPub !== "string" ||
    !HEX64.test(o.oldAdminRootPub.toLowerCase()) ||
    typeof o.newAdminRootPub !== "string" ||
    (o.newAdminRootPub !== "" && !HEX64.test(o.newAdminRootPub.toLowerCase())) ||
    typeof o.transferNonce !== "string" ||
    !HEX64.test(o.transferNonce.toLowerCase()) ||
    typeof o.issuedAt !== "number" ||
    typeof o.signatureHex !== "string" ||
    !HEX128.test(o.signatureHex.toLowerCase())
  ) {
    return null;
  }
  return {
    giverUsername: o.giverUsername.toLowerCase(),
    acquirerUsername: o.acquirerUsername.toLowerCase(),
    oldAdminRootPub: o.oldAdminRootPub.toLowerCase(),
    newAdminRootPub: o.newAdminRootPub.toLowerCase(),
    transferNonce: o.transferNonce.toLowerCase(),
    issuedAt: o.issuedAt,
    signatureHex: o.signatureHex.toLowerCase(),
  };
}

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
  /**
   * Slice D §9.8 — the acquirer's admin master root the box re-pins to, from
   * the LOCALLY-VERIFIED giver-root-signed handoff proof. "" = UNPIN (the
   * acquirer account has no admin root). ABSENT on a legacy re-home (the box
   * had no pinned admin root ⇒ marker byte-identical to pre-§9.8).
   */
  newAdminRootPubHex?: string;
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
    // The admin field is optional (absent on a legacy re-home) but if present
    // it must be well-formed — a corrupt admin field rejects the WHOLE marker
    // (fail-closed: never apply a re-home whose authority half is garbage).
    if (
      m.newAdminRootPubHex !== undefined &&
      (typeof m.newAdminRootPubHex !== "string" ||
        (m.newAdminRootPubHex !== "" && !HEX64.test(m.newAdminRootPubHex.toLowerCase())))
    ) {
      return null;
    }
    return {
      newServerDomain: m.newServerDomain.toLowerCase(),
      acquirerUsername: m.acquirerUsername.toLowerCase(),
      acquirerIrkPubHex: m.acquirerIrkPubHex.toLowerCase(),
      oldServerDomain: m.oldServerDomain.toLowerCase(),
      claimedAt: typeof m.claimedAt === "number" ? m.claimedAt : 0,
      ...(m.newAdminRootPubHex !== undefined
        ? { newAdminRootPubHex: m.newAdminRootPubHex.toLowerCase() }
        : {}),
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
  /**
   * Slice D §9.8 — the box's EFFECTIVE pinned admin master root (hex, after
   * admin-root-pin resolution), or null/absent when the box has no admin root.
   * When present, a re-home is REFUSED (`awaiting-admin-handoff`) until the
   * response carries a giver-root-signed `AdminRootTransfer` that verifies
   * against this pin — never `.com`'s word. Absent ⇒ legacy behavior,
   * byte-identical marker.
   */
  pinnedAdminRootPubHex?: string | null;
  /**
   * v1-sec GAP 3 — the box's config-pinned MEMBERSHIP owner IRK (hex, the
   * GIVER's until re-home). On the LEGACY path (no admin master root pinned) the
   * re-home is written ONLY when the response carries a giver-owner-IRK-signed
   * `RehomeAuthorization` that verifies against THIS key — never `.com`'s
   * unauthenticated word. Absent/malformed ⇒ the legacy re-home is REFUSED
   * (fail-closed): a rogue `.com` must not be able to move a legacy box's
   * FQDN/cert/routing. Ignored on the admin path (the AdminRootTransfer proof
   * is the stronger authority there).
   */
  pinnedOwnerIrkPubHex?: string | null;
  fetchImpl?: typeof fetch;
  onLog?: (m: string) => void;
}

export type RehomeOutcome =
  | {
      rehomed: false;
      reason:
        | "no-transfer"
        | "already-current"
        | "awaiting-admin-handoff"
        | "awaiting-owner-auth"
        | "error";
    }
  | { rehomed: true; marker: RehomeMarker };

/**
 * One poll: ask `.com` whether this box (its current canonical) was transferred.
 * On a completed transfer, persist the re-home marker. Never throws. The caller
 * (boot path) reads the marker and applies the override on the NEXT start; the
 * poller exists so a box that's already up when the transfer completes notices
 * it and writes the marker (it then re-homes on its next restart — the daemon
 * `Restart=always`/admin restart cycle).
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
    acquirerAdminRootPub?: string;
    adminHandoff?: {
      giverUsername?: string;
      acquirerUsername?: string;
      oldAdminRootPub?: string;
      newAdminRootPub?: string;
      transferNonce?: string;
      issuedAt?: number;
      signatureHex?: string;
    };
    /**
     * v1-sec GAP 3 — the giver-owner-IRK-signed re-home authorization
     * (`RehomeAuthorization`). The signature commits to (oldServerDomain,
     * newServerDomain, acquirerIrkPub, issuedAt); old/new/acquirerIrkPub are
     * reconstructed from the already-validated fields above.
     */
    rehomeAuth?: {
      issuedAt?: number;
      signatureHex?: string;
    };
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

  // ── Slice D §9.8 — admin-root handoff gate ────────────────────────────
  // A box with a pinned admin master root re-pins its AUTHORITY anchor only on
  // a proof SIGNED BY THAT PINNED ROOT — the giver's `AdminRootTransfer`. Any
  // absence/failure refuses the re-home (no marker) but keeps the poller alive
  // so a late giver deposit is picked up on a later poll. The canonical is
  // rebuilt with OUR old canonical as serverDomain, so a proof minted for a
  // different box can never verify here (instance binding).
  const pinned =
    typeof opts.pinnedAdminRootPubHex === "string" && HEX64.test(opts.pinnedAdminRootPubHex.toLowerCase())
      ? opts.pinnedAdminRootPubHex.toLowerCase()
      : null;
  let newAdminRootPubHex: string | undefined;
  if (pinned) {
    const h = parseAdminHandoff(body.adminHandoff);
    if (!h) {
      log(
        `[rehome] transfer reported for ${opts.serverDomain} but no valid admin-root ` +
          `handoff yet — REFUSING to re-home until the giver-root-signed proof arrives`,
      );
      return { rehomed: false, reason: "awaiting-admin-handoff" };
    }
    if (h.oldAdminRootPub !== pinned) {
      log(
        `[rehome] admin handoff's oldAdminRootPub (${h.oldAdminRootPub.slice(0, 12)}…) does not ` +
          `match our pinned admin root (${pinned.slice(0, 12)}…); refusing`,
      );
      return { rehomed: false, reason: "awaiting-admin-handoff" };
    }
    if (h.acquirerUsername !== body.acquirerUsername.toLowerCase()) {
      log("[rehome] admin handoff names a different acquirer than the transfer; refusing");
      return { rehomed: false, reason: "awaiting-admin-handoff" };
    }
    const transfer: AdminRootTransfer = {
      serverDomain: opts.serverDomain,
      giverUsername: h.giverUsername,
      acquirerUsername: h.acquirerUsername,
      oldAdminRootPubHex: h.oldAdminRootPub,
      newAdminRootPubHex: h.newAdminRootPub,
      transferNonce: h.transferNonce,
      issuedAt: h.issuedAt,
    };
    if (!verifyAdminRootTransfer(transfer, hexToBytesLocal(h.signatureHex), hexToBytesLocal(pinned))) {
      log(
        "[rehome] admin-root handoff signature does NOT verify against our pinned root " +
          "(forged / wrong box / tampered); refusing to re-home",
      );
      return { rehomed: false, reason: "awaiting-admin-handoff" };
    }
    newAdminRootPubHex = h.newAdminRootPub;
    log(
      `[rehome] admin-root handoff VERIFIED against the pinned root: ` +
        `${pinned.slice(0, 12)}… → ${newAdminRootPubHex === "" ? "(unpinned — acquirer has no admin root)" : `${newAdminRootPubHex.slice(0, 12)}…`}`,
    );
  } else {
    // ── v1-sec GAP 3 — LEGACY (no admin root pinned) owner-IRK gate ────────
    // A box with no admin master root re-homes ONLY on a giver-owner-IRK-signed
    // `RehomeAuthorization` verified against its config-pinned owner IRK (still
    // the giver's until re-home). This closes the "rogue `.com` re-homes a
    // legacy box on its unauthenticated word" hijack. Fail-closed: an
    // absent/malformed pinned IRK, or an absent/forged/mismatched auth, refuses
    // the re-home (no marker) and keeps the poller alive for a late deposit.
    const ownerIrk =
      typeof opts.pinnedOwnerIrkPubHex === "string" &&
      HEX64.test(opts.pinnedOwnerIrkPubHex.toLowerCase())
        ? opts.pinnedOwnerIrkPubHex.toLowerCase()
        : null;
    if (!ownerIrk) {
      log(
        "[rehome] legacy re-home reported but no pinned owner IRK is configured to " +
          "authorize it; REFUSING (never re-home on `.com`'s unsigned word)",
      );
      return { rehomed: false, reason: "awaiting-owner-auth" };
    }
    const auth = body.rehomeAuth;
    if (
      !auth ||
      typeof auth.issuedAt !== "number" ||
      typeof auth.signatureHex !== "string" ||
      !/^[0-9a-f]{128}$/.test(auth.signatureHex.toLowerCase())
    ) {
      log(
        `[rehome] legacy transfer reported for ${opts.serverDomain} but no valid ` +
          `giver-owner-IRK re-home authorization yet — REFUSING until it arrives`,
      );
      return { rehomed: false, reason: "awaiting-owner-auth" };
    }
    const authorization: RehomeAuthorization = {
      oldServerDomain: opts.serverDomain,
      newServerDomain: newDomain,
      acquirerIrkPub: hexToBytesLocal(body.acquirerIrkPub.toLowerCase()),
      issuedAt: auth.issuedAt,
    };
    if (
      !verifyRehomeAuthorization(
        authorization,
        hexToBytesLocal(auth.signatureHex.toLowerCase()),
        hexToBytesLocal(ownerIrk),
      )
    ) {
      log(
        "[rehome] re-home authorization signature does NOT verify against our pinned " +
          "owner IRK (forged / wrong box / wrong acquirer / tampered); refusing",
      );
      return { rehomed: false, reason: "awaiting-owner-auth" };
    }
    log(
      `[rehome] legacy re-home authorization VERIFIED against the pinned owner IRK ` +
        `(${ownerIrk.slice(0, 12)}…): ${opts.serverDomain} → ${newDomain}`,
    );
  }

  const marker: RehomeMarker = {
    newServerDomain: newDomain,
    acquirerUsername: body.acquirerUsername.toLowerCase(),
    acquirerIrkPubHex: body.acquirerIrkPub.toLowerCase(),
    oldServerDomain: opts.serverDomain.toLowerCase(),
    claimedAt: typeof body.claimedAt === "number" ? body.claimedAt : 0,
    ...(newAdminRootPubHex !== undefined ? { newAdminRootPubHex } : {}),
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

/* ────────────────────────────────────────────────────────────────────────
 * Boot-apply helpers (Slice D §9.8) — used by index.ts `main` when it applies
 * the persisted marker at the TOP of boot.
 * ──────────────────────────────────────────────────────────────────────── */

export type RehomeAdminOverride =
  | { kind: "none" } //  legacy marker — leave cfg.adminRootPub + the pin file untouched
  | { kind: "unpin" } // acquirer has no admin root — drop cfg.adminRootPub, remove the pin file
  | { kind: "repin"; adminRootPubHex: string };

/** PURE — what the marker says the box's admin anchor should become. */
export function rehomeAdminRootOverride(marker: RehomeMarker): RehomeAdminOverride {
  if (marker.newAdminRootPubHex === undefined) return { kind: "none" };
  if (marker.newAdminRootPubHex === "") return { kind: "unpin" };
  return { kind: "repin", adminRootPubHex: marker.newAdminRootPubHex };
}

/**
 * Reconcile the admin-root-pin store (`admin-root-pin.json`, the rotation
 * consumer's persisted re-pin) with a re-home marker — ONCE per transfer.
 *
 * WHY: the marker apply overrides `cfg.adminRootPub` (the SEED) BEFORE the
 * boot's pin resolution, but `resolvePinnedAdminRoot` prefers the PIN FILE over
 * the seed — so a stale GIVER-era pin (a rotation the giver applied before
 * handing the box over) would silently override the transferred root forever.
 * The pin file's format (adminRootPubHex/seq/updatedAt) has no lineage notion,
 * so we RESET it to the acquirer's root (seq 0 — the acquirer's rotation chain
 * is a fresh lineage; the rotation consumer matches hops by old-root equality,
 * not seq, so 0 is safe) or REMOVE it on an unpin.
 *
 * WHY ONCE (the sibling `.applied` receipt): the marker is re-applied on EVERY
 * boot (the baked FLAGSHIP_SUBDOMAIN never changes), but after this first
 * reconciliation the pin file belongs to the ACQUIRER's lineage — the acquirer
 * may legitimately rotate their admin root, and clobbering that rotation back
 * to the marker's (now-old) acquirer root on every reboot would reopen a
 * stolen-old-root window. The receipt records which transfer was reconciled;
 * a LATER transfer (different newServerDomain/claimedAt) reconciles again.
 */
export async function reconcileAdminRootPinOnRehome(args: {
  marker: RehomeMarker;
  /** The rotation consumer's pin file (`<dataDir>/admin-root-pin.json`). */
  pinPath: string;
  /** The one-time receipt (`<markerPath>.applied`). */
  appliedPath: string;
  now?: () => number;
  onLog?: (m: string) => void;
}): Promise<"repinned" | "unpinned" | "already-applied" | "legacy-no-op"> {
  const { marker, pinPath, appliedPath } = args;
  const log = args.onLog ?? (() => {});
  const override = rehomeAdminRootOverride(marker);
  if (override.kind === "none") return "legacy-no-op";

  interface AppliedReceipt {
    newServerDomain?: string;
    claimedAt?: number;
    newAdminRootPubHex?: string;
  }
  try {
    const receipt = JSON.parse(await readFile(appliedPath, "utf-8")) as AppliedReceipt;
    if (
      receipt.newServerDomain === marker.newServerDomain &&
      receipt.claimedAt === marker.claimedAt &&
      receipt.newAdminRootPubHex === marker.newAdminRootPubHex
    ) {
      return "already-applied";
    }
  } catch {
    /* no receipt yet — first apply for this transfer */
  }

  if (override.kind === "unpin") {
    await rm(pinPath, { force: true });
    log("[rehome] admin root UNPINNED (acquirer account has no admin root); pin file removed");
  } else {
    // Same atomic write-then-rename + modes as fileAdminRootPinStore.
    await mkdir(dirname(pinPath), { recursive: true, mode: 0o700 });
    const tmp = `${pinPath}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(
        {
          adminRootPubHex: override.adminRootPubHex,
          seq: 0,
          updatedAt: (args.now ?? Date.now)(),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(tmp, pinPath);
    log(
      `[rehome] admin-root pin RESET to the acquirer's root ` +
        `${override.adminRootPubHex.slice(0, 12)}… (giver-era pins can no longer override)`,
    );
  }

  await writeFile(
    appliedPath,
    JSON.stringify({
      newServerDomain: marker.newServerDomain,
      claimedAt: marker.claimedAt,
      newAdminRootPubHex: marker.newAdminRootPubHex,
      appliedAt: (args.now ?? Date.now)(),
    }),
    { mode: 0o600 },
  );
  return override.kind === "unpin" ? "unpinned" : "repinned";
}
