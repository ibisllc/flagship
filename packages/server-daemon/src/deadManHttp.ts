import { executeLockAndPower, type AutoUnlockSuppressor, type HostPowerRunner } from "./deadMan.js";
import type { DeadManController } from "./deadMan.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import {
  verifyPhoneOrder,
  type AdminGrantView,
  type DeadManAffirmation,
  type PhoneOrder,
  type SetDeadManPolicy,
} from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";

/**
 * Dead-man delivery surface — rides the same daemon HTTP plane as the
 * phone-order endpoint. Two routes, each an `{ request, signature }`
 * envelope verified inside the `DeadManController` against the box's
 * config-pinned owner IRK:
 *
 *   POST /api/deadman/policy   — IRK-signed `SetDeadManPolicy`
 *   POST /api/deadman/affirm   — IRK-signed `DeadManAffirmation`
 *
 * Returns null for any other path so it falls through the handler chain.
 */
const H = { "content-type": "application/json" };

export function buildDeadManHttp(controller: DeadManController) {
  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path !== "/api/deadman/policy" && req.path !== "/api/deadman/affirm") {
      return null;
    }
    if (req.method !== "POST") {
      return { status: 405, headers: H, body: JSON.stringify({ error: "method not allowed" }) };
    }
    let env: { request?: Record<string, unknown>; signature?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8"));
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid json" }) };
    }
    const r = env.request;
    if (!r || typeof r !== "object" || typeof env.signature !== "string") {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed body" }) };
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid signature hex" }) };
    }

    if (req.path === "/api/deadman/policy") {
      const policy = parsePolicy(r);
      if (!policy) {
        return { status: 400, headers: H, body: JSON.stringify({ error: "malformed policy" }) };
      }
      const ok = await controller.applyPolicy(policy, sig);
      if (!ok) {
        return { status: 403, headers: H, body: JSON.stringify({ error: "rejected" }) };
      }
      return { status: 200, headers: H, body: JSON.stringify({ ok: true, enabled: policy.enabled }) };
    }

    const affirm = parseAffirm(r);
    if (!affirm) {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed affirmation" }) };
    }
    const ok = await controller.affirm(affirm, sig);
    if (!ok) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "rejected" }) };
    }
    return {
      status: 200,
      headers: H,
      body: JSON.stringify({ ok: true, leaseExpiry: controller.leaseExpiry() }),
    };
  };
}

/**
 * Manual power surface — `POST /api/power`. Rides the same daemon HTTP
 * plane as the dead-man endpoints and verifies against the SAME box
 * config-pinned owner IRK (NOT the dead PSK/orders path: `psk.pub.hex` is
 * never written on a real Debian box, so `/api/orders-from-user` is inert
 * on metal). Body is an `{ request, signature }` envelope where `request`
 * is the existing `power-off` PhoneOrder
 * `{ type:"power-off", serverId, mode:"off"|"restart", issuedAt }`
 * (UNCHANGED canonical bytes). On a valid IRK signature within the replay
 * window it runs the SHARED `executeLockAndPower` primitive — suppress the
 * silent auto-unlock, THEN power off/restart — the same primitive the
 * dead-man timer fires.
 *
 * Returns null for any other path so it falls through the handler chain.
 */
export interface PowerHttpOptions {
  serverId: string;
  ownerIrkPub: Uint8Array;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the power order is gated by `requireMasterAdmin`, absent ⇒ legacy
   *  owner-IRK verification (a strict no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** This box's owner account (cfg.userId) — for the delegated-grant check. */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  suppressor: AutoUnlockSuppressor;
  runner: HostPowerRunner;
  now?: () => number;
  /** Replay window for `issuedAt`. Default 5 min — mirrors the dead-man. */
  maxAgeMs?: number;
}

export function buildPowerHttp(opts: PowerHttpOptions) {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path !== "/api/power") return null;
    if (req.method !== "POST") {
      return { status: 405, headers: H, body: JSON.stringify({ error: "method not allowed" }) };
    }
    let env: { request?: Record<string, unknown>; signature?: unknown };
    try {
      env = JSON.parse(req.body.toString("utf8"));
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid json" }) };
    }
    const r = env.request;
    if (!r || typeof r !== "object" || typeof env.signature !== "string") {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed body" }) };
    }
    if (typeof r.serverId !== "string" || r.serverId !== opts.serverId) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "serverId mismatch" }) };
    }
    if (typeof r.issuedAt !== "number") {
      return { status: 400, headers: H, body: JSON.stringify({ error: "issuedAt must be a number" }) };
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "stale request" }) };
    }
    const order = parsePowerOff(r);
    if (!order) {
      return { status: 400, headers: H, body: JSON.stringify({ error: "malformed power-off order" }) };
    }
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return { status: 400, headers: H, body: JSON.stringify({ error: "invalid signature hex" }) };
    }
    if (
      !authorizeSensitiveOrder({
        order,
        signature: sig,
        verify: verifyPhoneOrder,
        ownerIrkPub: opts.ownerIrkPub,
        adminRootPub: opts.adminRootPub,
        username: opts.username ?? "",
        activeGrants: opts.activeGrants,
      })
    ) {
      return { status: 403, headers: H, body: JSON.stringify({ error: "invalid signature" }) };
    }
    await executeLockAndPower({ mode: order.mode, suppressor: opts.suppressor, runner: opts.runner });
    return { status: 200, headers: H, body: JSON.stringify({ ok: true, mode: order.mode }) };
  };
}

function parsePowerOff(r: Record<string, unknown>): Extract<PhoneOrder, { type: "power-off" }> | null {
  if (
    r.type !== "power-off" ||
    typeof r.serverId !== "string" ||
    typeof r.issuedAt !== "number" ||
    (r.mode !== "off" && r.mode !== "restart")
  ) {
    return null;
  }
  return { type: "power-off", serverId: r.serverId, mode: r.mode, issuedAt: r.issuedAt };
}

function parsePolicy(r: Record<string, unknown>): SetDeadManPolicy | null {
  if (
    typeof r.serverId !== "string" ||
    typeof r.enabled !== "boolean" ||
    typeof r.windowMs !== "number" ||
    typeof r.graceMs !== "number" ||
    (r.lockoutMode !== "off" && r.lockoutMode !== "restart") ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return {
    serverId: r.serverId,
    enabled: r.enabled,
    windowMs: r.windowMs,
    graceMs: r.graceMs,
    lockoutMode: r.lockoutMode,
    issuedAt: r.issuedAt,
  };
}

function parseAffirm(r: Record<string, unknown>): DeadManAffirmation | null {
  if (typeof r.serverId !== "string" || typeof r.nonce !== "string" || typeof r.issuedAt !== "number") {
    return null;
  }
  try {
    return { serverId: r.serverId, nonce: hexToBytes(r.nonce), issuedAt: r.issuedAt };
  } catch {
    return null;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
