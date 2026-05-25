import type { ProvisionStatusStorage } from "@flagship/storage";
import { malformed, notFound, ok, type HandlerResponseWithHeaders } from "./types.js";

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
 */
export interface ProvisionStatusDeps {
  storage: ProvisionStatusStorage;
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

  // TODO: push status change to the order owner's subscription.

  return ok({ ok: true });
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
