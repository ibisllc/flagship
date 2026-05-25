import type {
  AuthCodeStorage,
  ProvisionStatusStorage,
  PushTokenStorage,
} from "@flagship/storage";
import { malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";
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
  "downloading",
  "partitioning",
  "installing",
  "registering",
  "sealing",
  "pairing",
  "live",
  "error",
] as const;

export type ProvisionStatusPhase = (typeof PROVISION_STATUS_PHASES)[number];

const PHASE_SET: ReadonlySet<string> = new Set(PROVISION_STATUS_PHASES);

const MAX_DETAIL_LEN = 1024;

export async function handlePostProvisionStatus(
  deps: ProvisionStatusDeps,
  serial: string,
  body: PostStatusBody | undefined,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? (() => Date.now()))();
  // TODO(security): sign reports with the box identity once registered /
  // the recipe delegated key. v1 accepts the POST keyed by serial alone —
  // the serial is a capability the phone + installer share, but it is not
  // a signature, so a leaked serial lets a third party scribble phases.
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

  await deps.storage.putProvisionStatus(serial, {
    phase: body.phase,
    ...(body.detail !== undefined ? { detail: body.detail } : {}),
    ts: now,
  });

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
  registering: "Your server is checking in with Flagship.",
  sealing: "Sealing your encrypted disk key.",
  pairing: "Your server is pairing with your phone.",
  live: "Your server is live and ready to use.",
  error: "Setup ran into a problem.",
};

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
  try {
    const order = await deps.authCodes.get(serial);
    if (!order) return;
    const username = order.username;
    const tokens = await deps.pushTokens.listByUser(username);
    if (tokens.length === 0) return;
    const p = phase as ProvisionStatusPhase;
    const title = PHASE_TITLES[p] ?? phase;
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
