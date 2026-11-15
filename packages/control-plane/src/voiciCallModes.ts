/**
 * Who may call a page, and ringing a caller back, on `.com` (docs/voici-calls.md, owner-approved 2026-11-15).
 *
 *   handleVoiciCallChallenge  GET  /api/voici/pages/<u>/call-challenge: a proof-of-work challenge for an anonymous call
 *                             (pages in "anyone" mode only)
 *   checkAnonymousCall        the anonymous branch of POST /api/voici/calls (handleVoiciCallRequest calls it)
 *   handleVoiciRingBack       POST /api/voici/web/ring-back: the caller attaches or stops the conversation's ring-back
 *                             channel (sealed push tokens only)
 *   handleVoiciRing           POST /api/voici/pages/<u>/ring: the owner rings a caller back; the channel's sealed
 *                             targets go to the push relay (when the PUSH_RELAY switch is on) with a content-free
 *                             payload, and the caller's open tab or app sees the ring in its thread fetch
 *
 * What `.com` learns: which conversation allowed a ring-back and when the owner rang it; never a push token (they are
 * sealed to the relay), never who the caller is.
 */
import {
  checkVoiciCallPowChallenge,
  checkVoiciCallRequestAnon,
  checkVoiciRingBackOrder,
  issueVoiciCallPow,
  parseVoiciCallPow,
  parseVoiciRing,
  verifyVoiciRing,
  VOICI_CALL_POW_BITS,
  VOICI_CALL_POW_TTL_MS,
  VOICI_CALL_SKEW_MS,
  VOICI_RING_BACK_TTL_MS,
  VOICI_RING_TTL_MS,
  type VoiciCallRequestAnon,
} from "@flagship/protocol";
import type { VoiciCallStorage, VoiciStorage } from "@flagship/storage";
import { hexToBytes } from "./hex.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { voiciRefusal } from "./voiciPages.js";

const NO_STORE = { "cache-control": "private, no-store" };
const ok = (body: unknown): HandlerResponseWithHeaders => ({ status: 200, body, headers: { ...NO_STORE } });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The push relay `.com` hands sealed targets to (built in the push-relay branch); absent while PUSH_RELAY is off. */
export interface VoiciPushRelay {
  deliver(items: { sealed: string; payload: Record<string, string>; kind: "call" | "alert" | "silent"; expiresAt: number }[]): Promise<number>;
}

/** The calls settings of a stored page, with the new modes. */
function pageMode(indexJson: string): string | null {
  try {
    const v = JSON.parse(indexJson) as Record<string, unknown>;
    return v.version === 2 && v.acceptsCalls === 1 && typeof v.callsFrom === "string" ? v.callsFrom : null;
  } catch {
    return null;
  }
}

// ── proof of work ─────────────────────────────────────────────────────────

export async function handleVoiciCallChallenge(
  deps: { voici: VoiciStorage; powSecret?: Uint8Array; limitIp: () => Promise<number | null>; random?: (n: number) => Uint8Array; now?: () => number; bits?: number },
  username: string,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const wait = await deps.limitIp();
  if (wait !== null) return voiciRefusal(429, "rate-limited", { retryAfterSec: wait });
  if (!deps.powSecret) return voiciRefusal(503, "unavailable");
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page || page.takenDownAt !== null || page.removedAt !== null) return voiciRefusal(404, "not-found");
  if (pageMode(page.indexJson) !== "anyone") return voiciRefusal(403, "not-allowed");
  const rand = Array.from((deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(16), (x) => x.toString(16).padStart(2, "0")).join("");
  const bits = deps.bits ?? VOICI_CALL_POW_BITS;
  return ok({ challenge: issueVoiciCallPow({ pageId: page.pageId, issuedAt: now, bits, rand }, deps.powSecret), bits, expiresAt: now + VOICI_CALL_POW_TTL_MS });
}

/**
 * The anonymous branch of the request route, cheapest first: page and mode, a blocked browser key, the page's
 * anonymous budget, the request (shape, conv, SDP, work, signature, freshness), the challenge's MAC and window, and
 * spending it once. Answers the request, or a refusal.
 */
export async function checkAnonymousCall(
  deps: {
    calls: VoiciCallStorage;
    powSecret?: Uint8Array;
    limitAnonPage: (pageId: string) => Promise<number | null>;
    sha256Hex: (b: Uint8Array) => Promise<string>;
  },
  page: { pageId: string; indexJson: string },
  raw: unknown,
  now: number,
): Promise<{ ok: true; request: VoiciCallRequestAnon } | { ok: false; response: HandlerResponseWithHeaders }> {
  const no = (status: number, code: string, extra?: Record<string, unknown>) => ({ ok: false as const, response: voiciRefusal(status, code, extra) });
  const mode = pageMode(page.indexJson);
  if (mode !== "anyone") return no(403, mode ? "not-allowed" : "calls-off");
  if (!deps.powSecret) return no(503, "unavailable");
  const conv = isObj(raw) && typeof raw.conv === "string" ? raw.conv : "";
  if (conv && (await deps.calls.isAnonBlocked(page.pageId, conv, now))) return no(403, "calls-off");
  const wait = await deps.limitAnonPage(page.pageId);
  if (wait !== null) return no(429, "rate-limited", { retryAfterSec: wait });
  const r = checkVoiciCallRequestAnon(raw, { pageId: page.pageId, acceptsCalls: true, callsFrom: "anyone", now });
  if (!r.ok) return no(r.code === "malformed" || r.code === "too-large" ? 400 : 403, r.code);
  const pow = checkVoiciCallPowChallenge(r.request.pow.challenge, { secret: deps.powSecret, pageId: page.pageId, now });
  if (pow !== "ok") return no(403, "bad-pow");
  const c = parseVoiciCallPow(r.request.pow.challenge)!;
  if (!(await deps.calls.spendPow(await deps.sha256Hex(new TextEncoder().encode(r.request.pow.challenge)), c.issuedAt + VOICI_CALL_POW_TTL_MS + 60_000))) return no(403, "bad-pow");
  return { ok: true, request: r.request };
}

// ── the ring-back channel ─────────────────────────────────────────────────

/** Body: the signed order (pushTokenSeal / voiciCallModes `checkVoiciRingBackOrder`). Answers {ok, expiresAt?}. */
export async function handleVoiciRingBack(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; origin: string; caKeys: (now: number) => string[]; now?: () => number },
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const order = isObj(body) && isObj(body.order) ? body.order : null;
  if (!order || typeof order.pageId !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPageById(order.pageId);
  if (!page) return voiciRefusal(404, "not-found");
  const delegatePub = isObj(body) && isObj(body.cred) && isObj(body.cred.delegation) ? body.cred.delegation.delegatePub : undefined;
  const from = isObj(body) && typeof body.from === "string" ? body.from : "";
  const revoked = new Set<string>();
  if (typeof delegatePub === "string" && from && (await deps.voici.isRevoked(delegatePub, from, now))) revoked.add(delegatePub);
  const r = checkVoiciRingBackOrder(body, { pageId: page.pageId, origin: deps.origin, caKeys: deps.caKeys(now), now, revoked });
  if (!r.ok) return voiciRefusal(r.code === "malformed" ? 400 : 403, r.code);
  if (r.order.op === "stop") {
    await deps.calls.deleteRingBack(page.pageId, r.order.conv);
    return ok({ ok: true });
  }
  const expiresAt = now + VOICI_RING_BACK_TTL_MS;
  if (!(await deps.calls.putRingBack({ pageId: page.pageId, conv: r.order.conv, targets: r.order.targets, issuedAt: r.order.issuedAt, expiresAt }))) return voiciRefusal(409, "stale");
  return ok({ ok: true, expiresAt });
}

/** Whether the conversation has a live ring-back channel (a "callback" page takes a signed-in call only then). */
export async function voiciHasRingBack(calls: VoiciCallStorage, pageId: string, conv: string, now: number): Promise<boolean> {
  return !!(await calls.getRingBack(pageId, conv, now));
}

// ── the ring ──────────────────────────────────────────────────────────────

/**
 * Body {ring, signature} by the page's ownerSignPub. The conversation must have a ring-back channel. Stores the ring
 * (the caller's thread fetch shows it while it rings) and hands each sealed target to the push relay with
 * {kind:"voici-ring", ringId, hint}: the relay sees the ring id and the hint's ciphertext, never the conversation.
 * Answers {ok, ringId, pushed, expiresAt}.
 */
export async function handleVoiciRing(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; pushRelay?: VoiciPushRelay; now?: () => number },
  username: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const b = isObj(body) ? body : {};
  const ring = parseVoiciRing(b.ring);
  if (!ring || typeof b.signature !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page || page.pageId !== ring.pageId) return voiciRefusal(404, "not-found");
  if (!pageMode(page.indexJson)) return voiciRefusal(403, "calls-off");
  if (Math.abs(now - ring.issuedAt) > VOICI_CALL_SKEW_MS) return voiciRefusal(403, "stale");
  if (!verifyVoiciRing(ring, b.signature, page.ownerSignPub)) return voiciRefusal(403, "bad-signature");
  const channel = await deps.calls.getRingBack(page.pageId, ring.conv, now);
  if (!channel) return voiciRefusal(404, "no-ring-back");
  const expiresAt = now + VOICI_RING_TTL_MS;
  await deps.calls.putRing({ pageId: page.pageId, conv: ring.conv, ringId: ring.ringId, hint: ring.hint, media: ring.media, issuedAt: ring.issuedAt, expiresAt });
  let pushed = 0;
  if (deps.pushRelay && channel.targets.length) {
    try {
      pushed = await deps.pushRelay.deliver(channel.targets.map((sealed) => ({ sealed, payload: { kind: "voici-ring", ringId: ring.ringId, hint: ring.hint }, kind: "call" as const, expiresAt })));
    } catch {
      pushed = 0;
    }
  }
  return ok({ ok: true, ringId: ring.ringId, pushed, expiresAt });
}

/** What the caller's thread fetch carries while the owner's ring rings: {ringId, hint, media, until}, or nothing. */
export async function voiciRingForThread(calls: Pick<VoiciCallStorage, "getRing">, pageId: string, conv: string, now: number) {
  const r = await calls.getRing(pageId, conv, now);
  return r ? { ringId: r.ringId, hint: r.hint, media: r.media, until: r.expiresAt } : null;
}

export const voiciPowSecret = (hex: string | undefined): Uint8Array | undefined => (hex && /^[0-9a-f]{64}$/.test(hex) ? hexToBytes(hex) : undefined);
