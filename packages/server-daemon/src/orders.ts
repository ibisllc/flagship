import { verifyPhoneOrder, type AdminGrantView, type PhoneOrder } from "@flagship/protocol";
import { authorizeSensitiveOrder } from "./adminAuthorityLocal.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";

/**
 * Phone → server orders. Each request is signed by the per-server PSK
 * private key on the user's phone; the daemon verifies against the PSK
 * pubkey baked into its install trailer (passed in as `pskPub` here).
 *
 * The endpoint accepts a JSON envelope:
 *
 *   {
 *     "request": { "type": "noop" | "set-backup-policy" | ..., ...fields, "issuedAt": <ms> },
 *     "signature": "<hex>"
 *   }
 *
 * The handler:
 *   1. Validates body shape.
 *   2. Confirms `request.serverId` matches this daemon's serverFqdn.
 *   3. Re-builds the canonical bytes and verifies the Ed25519 signature
 *      against the trailer-pinned PSK pubkey.
 *   4. Confirms `issuedAt` is within the replay window (default 5 min).
 *   5. Dispatches to the matching method on the supplied `OrderExecutor`.
 *
 * The executor is the consumer-defined adapter to the daemon's actual
 * subsystems (data layer, peer-backup loop, OpenRC service, etc.).
 */

export interface OrderExecutor {
  noop?(): Promise<void> | void;
  setBackupPolicy?(args: { enabled: boolean }): Promise<void> | void;
  shutDown?(): Promise<void> | void;
  // NOTE: the `power-off` PhoneOrder no longer rides this path. It is
  // delivered via `POST /api/power` (deadManHttp.ts) and verified against
  // the OWNER IRK, because the PSK pubkey this orders endpoint verifies
  // against (`psk.pub.hex`) is never written on a real Debian box.
  revokeSelf?(args: { reason: string }): Promise<void> | void;
  rotateServerIdentity?(args: { newIdentityPubKey: Uint8Array }): Promise<void> | void;
  deliverBak?(args: { bakPubKey: Uint8Array }): Promise<void> | void;
  /**
   * Browser input from the phone (password / OTP / text) bound for a
   * specific tab. The daemon validates `tabId` ownership and dispatches
   * the value via CDP `Input.dispatchKeyEvent` into the focused field.
   * Wired by PhonePipe in the browser feature.
   */
  browserInputResponse?(args: {
    tabId: string;
    inputKind: "password" | "otp" | "text";
    value: string;
    screenshotRef: string;
  }): Promise<void> | void;
  addSubscriber?(args: { serviceId: string; fqdn: string }): Promise<void> | void;
  removeSubscriber?(args: { serviceId: string; fqdn: string }): Promise<void> | void;
  addPairedSession?(args: { token: string; label: string }): Promise<void> | void;
  removePairedSession?(args: { token: string }): Promise<void> | void;
  // (claimUrl / releaseUrl removed in N12d — claims now flow app →
  //  daemon → hub via FRAME_REQUEST_TRANSFER, not via PhoneOrder.)
  /**
   * Phone-driven app backup. The implementer bundles the app, optionally
   * encrypts with the password, and returns a one-shot fetch path. The
   * order's response (200 OK) carries the path the phone polls.
   *
   * For now the response shape is opaque from this dispatch path —
   * the daemon's executor reports back via console + the paired
   * session's HTTP fetch endpoint. Future revision may carry the
   * fetchPath + backupId in the order ack.
   */
  backupApp?(args: {
    creator: string;
    slug: string;
    includeUserData: boolean;
    password?: string;
  }): Promise<void> | void;
}

export interface OrdersHandlerOptions {
  /** This daemon's server FQDN. Orders for any other serverId are rejected. */
  serverFqdn: string;
  /** PSK pubkey baked into the install trailer. */
  pskPub: Uint8Array;
  executor: OrderExecutor;
  /** Slice D — the pinned admin master root (`ServerConfig.adminRootPub`);
   *  present ⇒ the DESTRUCTIVE order types (spec §2 row 10) are gated by
   *  `requireMasterAdmin`, absent ⇒ legacy pskPub verification (a strict
   *  no-op on pre-wipe boxes). */
  adminRootPub?: Uint8Array;
  /** This box's owner account (cfg.userId) — for the delegated-grant check. */
  username?: string;
  /** Slice D — box-local active admin grants (`[]` box-side today). */
  activeGrants?: readonly AdminGrantView[];
  maxAgeMs?: number;
  now?: () => number;
}

// Slice D (docs/device-admin-tier-spec.md §2 row 10, §9.3): the DESTRUCTIVE
// order types on this endpoint. The PSK path is dead on real boxes
// (psk.pub.hex is never written; the endpoint falls back to the owner IRK for
// pairing), but a revival must not skip the admin boundary — with a pinned
// admin root these are authorized ONLY by the admin master root / an
// admin-granted device, never the membership key. Pair-for-use orders
// (add/remove-paired-session, subscribers, browser input, noop) stay on the
// legacy verification key by design (spec rows 14-15: non-admins keep using
// the box).
const SENSITIVE_ORDER_TYPES: ReadonlySet<PhoneOrder["type"]> = new Set([
  "set-backup-policy",
  "shut-down",
  "revoke-self",
  "rotate-server-identity",
  "deliver-bak",
  "backup-app",
]);

interface PhoneOrderEnvelope {
  request?: Record<string, unknown>;
  signature?: unknown;
}

export function buildOrdersHandler(opts: OrdersHandlerOptions) {
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const now = opts.now ?? (() => Date.now());

  return async function handleOrder(req: HttpRequest): Promise<HttpResponse> {
    if (req.method !== "POST") {
      return { status: 405, body: JSON.stringify({ error: "method not allowed" }), headers: H };
    }
    let envelope: PhoneOrderEnvelope;
    try {
      envelope = JSON.parse(req.body.toString("utf8")) as PhoneOrderEnvelope;
    } catch {
      return { status: 400, body: JSON.stringify({ error: "invalid json" }), headers: H };
    }
    const r = envelope.request;
    if (!r || typeof r !== "object" || typeof envelope.signature !== "string") {
      return { status: 400, body: JSON.stringify({ error: "malformed body" }), headers: H };
    }
    if (typeof r.serverId !== "string" || r.serverId !== opts.serverFqdn) {
      return { status: 403, body: JSON.stringify({ error: "serverId mismatch" }), headers: H };
    }
    if (typeof r.issuedAt !== "number") {
      return { status: 400, body: JSON.stringify({ error: "issuedAt must be a number" }), headers: H };
    }
    if (Math.abs(now() - r.issuedAt) > maxAgeMs) {
      return { status: 403, body: JSON.stringify({ error: "stale request" }), headers: H };
    }

    const order = parseOrder(r);
    if (!order) {
      return { status: 400, body: JSON.stringify({ error: "unknown or malformed order" }), headers: H };
    }

    let sig: Uint8Array;
    try {
      sig = hexToBytes(envelope.signature);
    } catch {
      return { status: 400, body: JSON.stringify({ error: "invalid signature hex" }), headers: H };
    }
    const authorized = SENSITIVE_ORDER_TYPES.has(order.type)
      ? authorizeSensitiveOrder({
          order,
          signature: sig,
          verify: verifyPhoneOrder,
          ownerIrkPub: opts.pskPub,
          adminRootPub: opts.adminRootPub,
          username: opts.username ?? "",
          activeGrants: opts.activeGrants,
        })
      : verifyPhoneOrder(order, sig, opts.pskPub);
    if (!authorized) {
      return { status: 403, body: JSON.stringify({ error: "invalid signature" }), headers: H };
    }

    try {
      await dispatch(order, opts.executor);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        status: 500,
        body: JSON.stringify({ error: "executor failed", message: msg }),
        headers: H,
      };
    }
    return { status: 200, body: JSON.stringify({ ok: true, type: order.type }), headers: H };
  };
}

const H = { "content-type": "application/json" };

function parseOrder(r: Record<string, unknown>): PhoneOrder | null {
  if (typeof r.type !== "string" || typeof r.serverId !== "string" || typeof r.issuedAt !== "number") {
    return null;
  }
  switch (r.type) {
    case "noop":
      return { type: "noop", serverId: r.serverId, issuedAt: r.issuedAt };
    case "set-backup-policy":
      if (typeof r.enabled !== "boolean") return null;
      return {
        type: "set-backup-policy",
        serverId: r.serverId,
        enabled: r.enabled,
        issuedAt: r.issuedAt,
      };
    case "shut-down":
      return { type: "shut-down", serverId: r.serverId, issuedAt: r.issuedAt };
    case "revoke-self":
      if (typeof r.reason !== "string") return null;
      return { type: "revoke-self", serverId: r.serverId, reason: r.reason, issuedAt: r.issuedAt };
    case "rotate-server-identity": {
      if (typeof r.newIdentityPubKey !== "string") return null;
      try {
        return {
          type: "rotate-server-identity",
          serverId: r.serverId,
          newIdentityPubKey: hexToBytes(r.newIdentityPubKey),
          issuedAt: r.issuedAt,
        };
      } catch {
        return null;
      }
    }
    case "deliver-bak": {
      if (typeof r.bakPubKey !== "string") return null;
      try {
        return {
          type: "deliver-bak",
          serverId: r.serverId,
          bakPubKey: hexToBytes(r.bakPubKey),
          issuedAt: r.issuedAt,
        };
      } catch {
        return null;
      }
    }
    case "browser-input-response": {
      if (
        typeof r.tabId !== "string" ||
        typeof r.value !== "string" ||
        typeof r.screenshotRef !== "string" ||
        (r.inputKind !== "password" && r.inputKind !== "otp" && r.inputKind !== "text")
      ) {
        return null;
      }
      return {
        type: "browser-input-response",
        serverId: r.serverId,
        tabId: r.tabId,
        inputKind: r.inputKind,
        value: r.value,
        screenshotRef: r.screenshotRef,
        issuedAt: r.issuedAt,
      };
    }
    case "add-subscriber":
      if (typeof r.serviceId !== "string" || typeof r.fqdn !== "string") return null;
      return {
        type: "add-subscriber",
        serverId: r.serverId,
        serviceId: r.serviceId,
        fqdn: r.fqdn,
        issuedAt: r.issuedAt,
      };
    case "remove-subscriber":
      if (typeof r.serviceId !== "string" || typeof r.fqdn !== "string") return null;
      return {
        type: "remove-subscriber",
        serverId: r.serverId,
        serviceId: r.serviceId,
        fqdn: r.fqdn,
        issuedAt: r.issuedAt,
      };
    case "add-paired-session":
      if (typeof r.token !== "string" || typeof r.label !== "string") return null;
      return {
        type: "add-paired-session",
        serverId: r.serverId,
        token: r.token,
        label: r.label,
        issuedAt: r.issuedAt,
      };
    case "remove-paired-session":
      if (typeof r.token !== "string") return null;
      return {
        type: "remove-paired-session",
        serverId: r.serverId,
        token: r.token,
        issuedAt: r.issuedAt,
      };
    case "backup-app":
      if (
        typeof r.creator !== "string" ||
        typeof r.slug !== "string" ||
        typeof r.includeUserData !== "boolean"
      ) return null;
      if (r.password !== undefined && typeof r.password !== "string") return null;
      return {
        type: "backup-app",
        serverId: r.serverId,
        creator: r.creator,
        slug: r.slug,
        includeUserData: r.includeUserData,
        password: r.password as string | undefined,
        issuedAt: r.issuedAt,
      };
    default:
      return null;
  }
}

async function dispatch(order: PhoneOrder, ex: OrderExecutor): Promise<void> {
  switch (order.type) {
    case "noop":
      await ex.noop?.();
      return;
    case "set-backup-policy":
      if (!ex.setBackupPolicy) throw new Error("setBackupPolicy not implemented");
      await ex.setBackupPolicy({ enabled: order.enabled });
      return;
    case "shut-down":
      if (!ex.shutDown) throw new Error("shutDown not implemented");
      await ex.shutDown();
      return;
    case "power-off":
      throw new Error("power-off is delivered via /api/power, not this orders path");
    case "revoke-self":
      if (!ex.revokeSelf) throw new Error("revokeSelf not implemented");
      await ex.revokeSelf({ reason: order.reason });
      return;
    case "rotate-server-identity":
      if (!ex.rotateServerIdentity) throw new Error("rotateServerIdentity not implemented");
      await ex.rotateServerIdentity({ newIdentityPubKey: order.newIdentityPubKey });
      return;
    case "deliver-bak":
      if (!ex.deliverBak) throw new Error("deliverBak not implemented");
      await ex.deliverBak({ bakPubKey: order.bakPubKey });
      return;
    case "browser-input-response":
      if (!ex.browserInputResponse) throw new Error("browserInputResponse not implemented");
      await ex.browserInputResponse({
        tabId: order.tabId,
        inputKind: order.inputKind,
        value: order.value,
        screenshotRef: order.screenshotRef,
      });
      return;
    case "add-subscriber":
      if (!ex.addSubscriber) throw new Error("addSubscriber not implemented");
      await ex.addSubscriber({ serviceId: order.serviceId, fqdn: order.fqdn });
      return;
    case "remove-subscriber":
      if (!ex.removeSubscriber) throw new Error("removeSubscriber not implemented");
      await ex.removeSubscriber({ serviceId: order.serviceId, fqdn: order.fqdn });
      return;
    case "add-paired-session":
      if (!ex.addPairedSession) throw new Error("addPairedSession not implemented");
      await ex.addPairedSession({ token: order.token, label: order.label });
      return;
    case "remove-paired-session":
      if (!ex.removePairedSession) throw new Error("removePairedSession not implemented");
      await ex.removePairedSession({ token: order.token });
      return;
    case "backup-app":
      if (!ex.backupApp) throw new Error("backupApp not implemented");
      await ex.backupApp({
        creator: order.creator,
        slug: order.slug,
        includeUserData: order.includeUserData,
        password: order.password,
      });
      return;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
