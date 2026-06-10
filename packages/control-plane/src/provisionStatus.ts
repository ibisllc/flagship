import type {
  AuthCodeStorage,
  DemoUsersStorage,
  ProvisionStatusStorage,
  PushTokenStorage,
} from "@flagship/storage";
import { forbidden, malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";
import type { V12PushFanout } from "./totp.js";

/**
 * Provisioning-status channel — per-order install progress.
 *
 * Keyed by the auth-code SERIAL (the order id): the phone app knows it
 * from the order it created; the installer has it in the recipe. The box
 * POSTs a named PHASE checkpoint at each install step; the phone polls the
 * latest phase + the append-only history to render a live timeline.
 *
 *   POST /api/order/:serial/status   body { phase, detail? }
 *   GET  /api/order/:serial/status   → the record, or 404 when none yet
 *
 * On a successful POST we ALSO fan out a native push to the order owner's
 * registered devices so the phone updates in real time without polling.
 * The owner is resolved SERIAL → auth-code record → username, then
 * username → push tokens. Push is best-effort: a missing subscription or
 * a provider failure never fails the status write.
 */
export interface ProvisionStatusDeps {
  storage: ProvisionStatusStorage;
  /** Resolves SERIAL → owner (the auth-code records who created the order).
   *  Absent ⇒ no owner lookup, so no push (dev / partial wiring). */
  authCodes?: AuthCodeStorage;
  /** Resolves owner username → registered push subscriptions. */
  pushTokens?: PushTokenStorage;
  /**
   * Demo-server mirror. When present, a status POST whose owner maps to a
   * `provisioning` demo_users row also stamps that row's latest phase, so the
   * demo install-progress timeline reads off the SAME canonical channel (the
   * demo VPS bootstrap posts here). Unifies demo + real provisioning onto one
   * vocabulary. Best-effort: a mirror failure never fails the status write.
   */
  demoUsers?: DemoUsersStorage;
  /** Native push fan-out (APNs / FCM / Web Push RFC 8291). Absent ⇒ the
   *  phase is stored but no push fires (no provider secrets configured). */
  pushFanout?: V12PushFanout;
  now?: () => number;
}

interface PostStatusBody {
  phase?: string;
  detail?: string;
}

/** The same serial shape the install-events + auth-code channels use. */
const SERIAL_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Allowlisted phases. A box reports one of these as it walks the install;
 * `error` is the terminal failure state (carry the reason in `detail`).
 */
export const PROVISION_STATUS_PHASES = [
  "booting",
  "partitioning",
  "installing",
  // The flagship bootstrap (git clone + apt + nodejs) runs AFTER the base OS
  // install — the base ISO is already on the USB, so `downloading` is the
  // post-install software fetch, NOT an early/base-ISO step. It follows
  // `installing` on the wire.
  "downloading",
  "registering",
  "sealing",
  // The d-i install finished + the box has registered + sealed: it powered off
  // awaiting the user to unplug the USB and power it back on. NOT live yet —
  // the daemon serves on the first real boot (→ `live`). This is the final
  // pre-poweroff checkpoint, so it sorts AFTER sealing.
  "installed",
  "pairing",
  "live",
  "error",
] as const;

export type ProvisionStatusPhase = (typeof PROVISION_STATUS_PHASES)[number];

const PHASE_SET: ReadonlySet<string> = new Set(PROVISION_STATUS_PHASES);

/**
 * The minimal set of phases that fire a NATIVE PUSH banner — the milestones
 * worth waking a device for. Every phase still updates the polled stream (the
 * phone's foregrounded install-progress view sees them all via GET), but only
 * these four ring a notification, so we don't "blast" a banner per rung. Kept
 * identical across consumers (iOS / Android / webapp parse the same payload —
 * the gate is here, on the producer).
 */
const PUSH_PHASES: ReadonlySet<ProvisionStatusPhase> = new Set([
  // `installed` IS a push milestone: the box has powered off and the user MUST
  // act (unplug the USB, power on) before it can register — alert even when the
  // app is backgrounded.
  "installed",
  "registering",
  "sealing",
  "live",
  "error",
]);

const MAX_DETAIL_LEN = 1024;

export async function handlePostProvisionStatus(
  deps: ProvisionStatusDeps,
  serial: string,
  body: PostStatusBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  // NOTE(security): the serial is a capability the phone + installer share, not
  // a signature, so a leaked serial would let a third party scribble phases. We
  // narrow that surface the same way install-events does: when an AuthCodeStorage
  // is wired (production), the POST is gated on the serial mapping to a real,
  // randomly-issued auth-code. Without one, an attacker can't grow the table on
  // fabricated serials. (Signing the report with the box identity is the next
  // step; the gate is the v1 floor.)
  if (!SERIAL_RE.test(serial)) return malformed("malformed serial");
  if (!body || typeof body.phase !== "string") {
    return malformed("phase required");
  }
  if (!PHASE_SET.has(body.phase)) {
    return malformed("unknown phase");
  }
  if (body.detail !== undefined) {
    if (typeof body.detail !== "string" || body.detail.length > MAX_DETAIL_LEN) {
      return malformed("invalid detail");
    }
  }
  if (deps.authCodes) {
    const order = await deps.authCodes.get(serial);
    if (!order) return forbidden("unknown serial");
  }

  await deps.storage.putProvisionStatus(serial, {
    phase: body.phase,
    ...(body.detail !== undefined ? { detail: body.detail } : {}),
    ts: now,
  });

  // Mirror onto the demo_users row (if any) so the demo install-progress
  // timeline reads off this SAME canonical channel — one vocabulary for both
  // demo + real boxes. Best-effort + scoped to a still-`provisioning` row so a
  // replayed serial can't rewind a live demo's phase.
  await mirrorToDemoRow(deps, serial, body.phase, body.detail, now);

  // Push the change to the order owner's devices so the phone's
  // install-progress view updates in real time. Best-effort: any failure
  // (no owner record, no subscription, provider error) is swallowed — the
  // status write has already succeeded and the phone also polls GET.
  await fanOutStatusPush(deps, serial, body.phase, body.detail);

  return ok({ ok: true });
}

/** Human-facing copy for each phase, used in the push notification. */
const PHASE_TITLES: Record<ProvisionStatusPhase, string> = {
  booting: "Booting up",
  downloading: "Downloading",
  partitioning: "Partitioning disk",
  installing: "Installing",
  // ACTION-NEEDED, not success: the push title is the short "Install complete";
  // the in-ladder step title spells out the action.
  installed: "Install complete — unplug the USB",
  registering: "Registering with Flagship",
  sealing: "Sealing your disk key",
  pairing: "Pairing with your phone",
  live: "Your server is live",
  error: "Setup hit a problem",
};

const PHASE_BODIES: Record<ProvisionStatusPhase, string> = {
  booting: "Your server has booted and started setting itself up.",
  downloading: "Downloading the server software.",
  partitioning: "Preparing the disk.",
  installing: "Installing the server software.",
  installed: "Unplug the USB stick, then power the box back on.",
  registering: "Your server is checking in with Flagship.",
  sealing: "Sealing your encrypted disk key.",
  pairing: "Your server is pairing with your phone.",
  live: "Your server is live and ready to use.",
  error: "Setup ran into a problem.",
};

/**
 * Mirror a canonical phase onto the owner's demo_users row, so the demo
 * install-progress timeline (rendered off `demoServer.phase`) reads off this
 * single canonical channel. SERIAL → auth-code → username → demo row. Only
 * stamps a row that is still `provisioning` (a replayed serial can't rewind a
 * live demo). Never throws — the canonical status write has already succeeded.
 */
async function mirrorToDemoRow(
  deps: ProvisionStatusDeps,
  serial: string,
  phase: string,
  detail: string | undefined,
  now: number,
): Promise<void> {
  if (!deps.authCodes || !deps.demoUsers) return;
  try {
    const order = await deps.authCodes.get(serial);
    if (!order) return;
    const row = await deps.demoUsers.get(order.username);
    if (!row || row.state !== "provisioning") return;
    await deps.demoUsers.setProvisionPhase(
      order.username,
      phase,
      phase === "error" && detail ? detail : null,
      now,
    );
  } catch {
    // The mirror is a convenience for the demo timeline; never fail the write.
  }
}

/**
 * Resolve the order owner (SERIAL → auth-code → username), then fan out a
 * native push to every device they have registered. Never throws.
 */
async function fanOutStatusPush(
  deps: ProvisionStatusDeps,
  serial: string,
  phase: string,
  detail: string | undefined,
): Promise<void> {
  if (!deps.authCodes || !deps.pushTokens || !deps.pushFanout) return;
  // Minimal-transition gate: only milestone phases ring a banner. The rest
  // update the polled stream silently. Foregrounded apps still see every phase
  // via GET .../status.
  if (!PUSH_PHASES.has(phase as ProvisionStatusPhase)) return;
  try {
    const order = await deps.authCodes.get(serial);
    if (!order) return;
    const username = order.username;
    const tokens = await deps.pushTokens.listByUser(username);
    if (tokens.length === 0) return;
    const p = phase as ProvisionStatusPhase;
    // The push banner uses the short milestone title; the ladder/step title in
    // PHASE_TITLES is the longer in-app copy (`installed` spells out the action
    // in the ladder, but the banner says "Install complete").
    const title = phase === "installed" ? "Install complete" : PHASE_TITLES[p] ?? phase;
    const baseBody = PHASE_BODIES[p] ?? "";
    const body =
      phase === "error" && detail ? `Setup failed: ${detail}` : baseBody;
    await deps.pushFanout({
      username,
      targets: tokens.map((t) => ({
        tokenId: t.tokenId,
        platform: t.platform,
        providerToken: t.providerToken,
      })),
      payload: {
        category: "provision-status",
        title,
        body,
        deepLink: "flagship://install-progress",
        meta: {
          kind: "provision-status",
          serial,
          phase,
          ...(detail ? { detail } : {}),
        },
      },
    });
  } catch {
    // Push is a convenience; the phone also polls GET .../status.
  }
}

export async function handleGetProvisionStatus(
  deps: ProvisionStatusDeps,
  serial: string,
): Promise<HandlerResponseWithHeaders> {
  if (!SERIAL_RE.test(serial)) return malformed("malformed serial");
  const rec = await deps.storage.getProvisionStatus(serial);
  if (!rec) return notFound("no status");
  return ok(rec);
}
