/**
 * N-CLOUD-1/2/3 — branded box serial activation, first-claim binding,
 * + LAN disambiguation rendezvous.
 *
 * Three endpoints:
 *   - `POST /api/serial/activate` — retailer-HMAC-authed PoS endpoint.
 *     Marks a pre-allocated serial activated. Idempotent.
 *   - `GET  /api/serial/:serial/status` — public read of activation +
 *     bind state. Per locked decision Q1 the "in-store-only" gate is
 *     left to the retailer's HMAC secret distribution; the public
 *     status surface is needed for first-boot phones to confirm what
 *     they're pairing with.
 *   - `GET  /api/rendezvous/:suffix6` — public disambiguation lookup.
 *     The phone tapped a box with PairHint.suffix6 = X; cloud returns
 *     every bound serial with that suffix so the phone can match
 *     against its NFC-captured stkPub.
 *
 * Plus an internal helper for register-server wiring:
 *   - `enforceActivated(deps, serial)` — call before binding stkPub on
 *     a first-claim from a branded box. Returns ok or a 403 reason.
 *
 * HMAC scheme (v1 — single shared secret per FLAGSHIP_RETAILER_HMAC_SECRET):
 *   canonical = `flagship/serial-activate/v1|${serial}|${sku}|${retailerId ?? ""}|${at}`
 *   Authorization: Flagship-Retailer-v1 <hex(HMAC-SHA256(secret, canonical))>
 *   ±5 min freshness on `at`.
 */

import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import type { BoxSerialsStorage } from "@flagship/storage";
import {
  forbidden,
  malformed,
  notFound,
  ok,
  type HandlerResponseWithHeaders,
} from "./types.js";

export interface SerialActivationDeps {
  serials: BoxSerialsStorage;
  /** Shared HMAC secret distributed to retailers. Required for activate. */
  retailerHmacSecret?: string;
  /** Replay window for HMAC `at` timestamps. Default 5 min. */
  maxAgeMs?: number;
  now?: () => number;
}

interface ActivateBody {
  serial?: string;
  sku?: string;
  retailerId?: string;
  /** ms epoch; signed for replay protection. */
  at?: number;
}

const ACTIVATE_TAG = "flagship/serial-activate/v1";

function canonicalActivate(b: { serial: string; sku: string; retailerId: string; at: number }): Uint8Array {
  return new TextEncoder().encode(
    [ACTIVATE_TAG, b.serial, b.sku, b.retailerId, b.at].join("|"),
  );
}

function hex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return acc === 0;
}

const AUTH_PREFIX = "Flagship-Retailer-v1 ";

function parseAuth(header: string | undefined): string | null {
  if (!header || !header.startsWith(AUTH_PREFIX)) return null;
  return header.slice(AUTH_PREFIX.length).trim().toLowerCase();
}

export async function handleSerialActivate(
  deps: SerialActivationDeps,
  body: ActivateBody | undefined,
  authHeader: string | undefined,
): Promise<HandlerResponseWithHeaders> {
  const secret = deps.retailerHmacSecret;
  if (!secret) {
    // Service must be configured. 503 is the right code for the
    // Worker, but our HandlerResponseWithHeaders helpers map "forbidden"
    // to 403 — use that as the closest available verdict; controlPlaneRoutes
    // dispatches accordingly.
    return forbidden("retailer activation not configured");
  }
  const now = (deps.now ?? (() => Date.now()))();
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;

  if (
    !body ||
    typeof body.serial !== "string" || body.serial.length === 0 ||
    typeof body.sku !== "string" || body.sku.length === 0 ||
    typeof body.at !== "number"
  ) {
    return malformed("malformed body");
  }
  if (Math.abs(now - body.at) > maxAgeMs) {
    return forbidden("activation timestamp outside freshness window");
  }
  const provided = parseAuth(authHeader);
  if (!provided) return forbidden("missing or invalid retailer authorization");

  const retailerId = typeof body.retailerId === "string" ? body.retailerId : "";
  const expected = hex(
    hmac(sha256, new TextEncoder().encode(secret), canonicalActivate({
      serial: body.serial,
      sku: body.sku,
      retailerId,
      at: body.at,
    })),
  );
  if (!constantTimeEquals(provided, expected)) {
    return forbidden("retailer HMAC mismatch");
  }

  const r = await deps.serials.activate({
    serial: body.serial,
    activatedBy: retailerId || null,
    at: body.at,
  });
  if (!r.ok) {
    if (r.reason === "unknown serial") return notFound("unknown serial");
    return malformed(r.reason);
  }
  return ok({
    ok: true,
    serial: body.serial,
    activatedAt: body.at,
    alreadyActivated: r.alreadyActivated,
  });
}

export async function handleSerialStatus(
  deps: SerialActivationDeps,
  serial: string,
): Promise<HandlerResponseWithHeaders> {
  if (typeof serial !== "string" || serial.length === 0) {
    return malformed("serial required");
  }
  const rec = await deps.serials.get(serial);
  if (!rec) return notFound("unknown serial");
  return ok({
    serial: rec.serial,
    sku: rec.sku,
    activated: rec.activatedAt !== null,
    activatedAt: rec.activatedAt,
    bound: rec.stkPubHex !== null,
    boundAt: rec.boundAt,
    suffix6: rec.suffix6,
  });
}

export async function handleRendezvousLookup(
  deps: SerialActivationDeps,
  suffix6: string,
): Promise<HandlerResponseWithHeaders> {
  if (!/^[0-9a-f]{6}$/i.test(suffix6)) return malformed("suffix6 must be 6 hex chars");
  const rows = await deps.serials.listBySuffix6(suffix6.toLowerCase());
  return ok({
    suffix6: suffix6.toLowerCase(),
    candidates: rows.map((r) => ({
      serial: r.serial,
      sku: r.sku,
      boundAt: r.boundAt,
      // Don't leak the full stkPub — the suffix6 is the disambiguation
      // key; the phone has the full key from the NFC tap.
    })),
  });
}

/**
 * Helper for the register-server hot path. Call when the incoming
 * registration carries a `serial` field (branded boxes do). Returns
 * `ok:true` to proceed with the bind, or `ok:false` with a 403-shaped
 * reason for the caller to surface.
 *
 * Not wired into `handleServerRegister` in this commit — N-CLOUD-2 in
 * the doc is the wire-in step; this commit lands the helper.
 */
export async function enforceActivated(
  deps: Pick<SerialActivationDeps, "serials">,
  args: { serial: string; stkPubHex: string; suffix6: string; at: number },
): Promise<{ ok: true; alreadyBound: boolean } | { ok: false; reason: string }> {
  return deps.serials.bindStk({
    serial: args.serial,
    stkPubHex: args.stkPubHex,
    suffix6: args.suffix6,
    at: args.at,
  });
}
