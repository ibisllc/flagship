/**
 * voi.ci reply alerts (the "Alerts:" note in docs/voici-and-messages.md §8.3; migration 0125):
 *
 *   GET  /api/voici/web/alert-key   the VAPID public key the browser subscribes with (the webapp's key)
 *   POST /api/voici/web/alerts      {conv, op:"on"|"off", endpoint, issuedAt, sig, cred, subscription?}
 *
 * A visitor who has sent a message may turn on a content-free Web Push for the owner's replies in THAT conversation.
 * The order is authorised exactly like a thread fetch: the browser key B signs
 * `flagship/voici-alerts/v1|<conv>|<op>|<SHA-256(endpoint)>|<issuedAt>` and the cred's delegation binds B to the
 * pseudonym whose conversation `conv` is, so nobody can add (or remove) a subscription on someone else's
 * conversation. Nothing names an account. When an owner's reply is stored, `sendVoiciReplyAlerts` pushes
 * `{kind:"voici-reply", u:<page username>}` (RFC 8291-encrypted to the browser, so the push service sees nothing),
 * at most once per conversation an hour; the service worker shows a fixed sentence and opens voi.ci/<u>.
 */
import { b64Decode, canonicalVoiciAlerts, isLowerHex, sha256Hex, type VoiciAlertsOrder } from "@flagship/protocol";
import type { VoiciStorage } from "@flagship/storage";
import type { WebPushOutcome } from "./pushBridge.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { authorizeBrowserKey, type VoiciThreadDeps } from "./voiciMailbox.js";
import { voiciRefusal } from "./voiciPages.js";

/** Browsers (subscriptions) one conversation may alert; the oldest goes first. */
export const VOICI_ALERTS_PER_CONV = 5;
/** At most one alert per conversation in this long. */
export const VOICI_ALERT_INTERVAL_MS = 3_600_000;
export const VOICI_ALERT_ENDPOINT_MAX = 1024;

/**
 * Hosts of the browsers' push services. `.com` POSTs to the endpoint a visitor hands it, so only these are taken:
 * an arbitrary URL would let anyone aim `.com`'s requests at a host of their choosing.
 */
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/, // Chrome, Edge on Android, Brave, Opera, Samsung Internet
  /^android\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari (macOS 13+, iOS 16.4+ home-screen apps)
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge on Windows (WNS)
];

/** A browser push service endpoint `.com` may POST to: https, a known push host, no port, no credentials. */
export function isWebPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > VOICI_ALERT_ENDPOINT_MAX) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.port !== "" || u.username !== "" || u.password !== "" || u.href !== endpoint) return false;
  return PUSH_HOSTS.some((h) => h.test(u.hostname));
}

function b64UrlBytes(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,200}={0,2}$/.test(s)) return null;
  try {
    const t = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
    return b64Decode(t + "=".repeat((4 - (t.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** `{endpoint, keys:{p256dh, auth}}` with a 65-byte uncompressed P-256 key and a 16-byte auth secret, normalised. */
function subscriptionOf(raw: unknown, endpoint: string): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (r.endpoint !== endpoint || !r.keys || typeof r.keys !== "object") return null;
  const p = b64UrlBytes(r.keys.p256dh);
  const a = b64UrlBytes(r.keys.auth);
  if (!p || p.length !== 65 || p[0] !== 4 || !a || a.length !== 16) return null;
  return JSON.stringify({ endpoint, keys: { p256dh: r.keys.p256dh, auth: r.keys.auth } });
}

export interface VoiciAlertsDeps extends VoiciThreadDeps {
  /** Chunk B2: Flagship banned this pseudonym (§9.3). */
  isPseudonymBanned?: (pseudonymPub: string) => Promise<boolean>;
}

const ok = (body: unknown): HandlerResponseWithHeaders => ({ status: 200, body, headers: { "cache-control": "private, no-store" } });

/**
 * Turns one browser's reply alerts on or off for one conversation. On needs: the conversation to hold a message
 * (the offer comes after the visitor has sent one), its page published and not taken down, B not signed out. A
 * blocked or banned pseudonym is answered as if it worked and nothing is stored (no oracle, like a blocked send).
 * Off deletes the row and always answers ok.
 */
export async function handleVoiciAlerts(deps: VoiciAlertsDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const b = (body ?? {}) as Record<string, unknown>;
  const cred = b.cred as Record<string, unknown> | undefined;
  if (
    !isLowerHex(b.conv, 32) ||
    (b.op !== "on" && b.op !== "off") ||
    typeof b.issuedAt !== "number" ||
    typeof b.sig !== "string" ||
    !cred ||
    typeof cred !== "object" ||
    typeof b.endpoint !== "string"
  ) {
    return voiciRefusal(400, "malformed");
  }
  if (!isWebPushEndpoint(b.endpoint)) return voiciRefusal(400, "bad-endpoint");
  const endpoint = b.endpoint;
  const subscription = b.op === "on" ? subscriptionOf(b.subscription, endpoint) : null;
  if (b.op === "on" && !subscription) return voiciRefusal(400, "bad-endpoint");
  const order: VoiciAlertsOrder = { conv: b.conv, op: b.op === "on" ? "on" : "off", endpointHash: sha256Hex(endpoint), issuedAt: b.issuedAt };
  let bytes: Uint8Array;
  try {
    bytes = canonicalVoiciAlerts(order);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  const auth = await authorizeBrowserKey(deps, { conv: order.conv, issuedAt: order.issuedAt, sig: b.sig, cred, bytes: () => bytes });
  if (!auth.ok) return auth.response;
  if (order.op === "off") {
    await deps.voici.deleteAlert(order.conv, order.endpointHash);
    return ok({ ok: true, alerts: "off" });
  }
  const d = auth.delegation;
  const [revoked, page, thread, block, banned] = await Promise.all([
    deps.voici.isRevoked(d.delegatePub, now),
    deps.voici.getPageById(d.audience),
    deps.voici.listThread(order.conv, 0, 1),
    deps.voici.getBlock(d.audience, d.principalPub),
    deps.isPseudonymBanned?.(d.principalPub) ?? false,
  ]);
  if (revoked) return voiciRefusal(403, "revoked");
  if (!page || page.takenDownAt !== null) return voiciRefusal(404, "not-found");
  if (thread.length === 0) return voiciRefusal(409, "no-conversation");
  if (block?.op === "block" || banned) return ok({ ok: true, alerts: "on" });
  await deps.voici.putAlert(
    { conv: order.conv, endpointHash: order.endpointHash, pageId: page.pageId, subscription: subscription!, delegatePub: d.delegatePub, createdAt: now, expiresAt: d.expiresAt },
    VOICI_ALERTS_PER_CONV,
  );
  return ok({ ok: true, alerts: "on" });
}

export interface VoiciReplyAlertDeps {
  voici: Pick<VoiciStorage, "claimAlertPush" | "deleteAlert">;
  /** One Web Push (pushBridge's `buildWebPushSender`). */
  send: (subscription: string, payload: Uint8Array) => Promise<WebPushOutcome>;
  now?: () => number;
}

/** The push payload: which page to open, nothing about the message. */
export function voiciReplyAlertPayload(username: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ kind: "voici-reply", u: username }));
}

/**
 * After an owner's reply is stored in `conv`: one content-free push to each browser that asked, unless the
 * conversation was alerted in the last hour. A subscription its push service calls gone (404/410) is deleted.
 */
export async function sendVoiciReplyAlerts(deps: VoiciReplyAlertDeps, username: string, conv: string): Promise<{ sent: number; gone: number; failed: number }> {
  const now = (deps.now ?? Date.now)();
  const out = { sent: 0, gone: 0, failed: 0 };
  const rows = await deps.voici.claimAlertPush(conv, now, now - VOICI_ALERT_INTERVAL_MS);
  if (rows.length === 0) return out;
  const payload = voiciReplyAlertPayload(username);
  await Promise.all(
    rows.map(async (r) => {
      const res = await deps.send(r.subscription, payload).catch(() => "failed" as const);
      out[res]++;
      if (res === "gone") await deps.voici.deleteAlert(conv, r.endpointHash);
    }),
  );
  return out;
}
