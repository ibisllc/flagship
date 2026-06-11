import type { DeadManController } from "./deadMan.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { DeadManAffirmation, SetDeadManPolicy } from "@flagship/protocol";

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
