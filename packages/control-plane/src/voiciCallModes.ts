/**
 * Who may call a page, and ringing a caller back, on `.com` (docs/voici-calls.md, owner-approved 2026-11-15).
 *
 *   handleVoiciCallChallenge  GET  /api/voici/pages/<u>/call-challenge: a proof-of-work challenge for an anonymous call
 *                             (pages in "anyone" mode only)
 *   checkAnonymousCall        the anonymous branch of POST /api/voici/calls (handleVoiciCallRequest calls it)
 *   handleVoiciRingBack       POST /api/voici/web/ring-back: the caller attaches or stops the conversation's ring-back
 *                             channel; from the caller's app, the device headers' account (found by the route from the
 *                             signing device, never the URL) is the one whose devices the ring push reaches
 *   handleVoiciRing           POST /api/voici/rings/<ringId> (older apps: /pages/<u>/ring; the route finds the account
 *                             from the page the ring names): the owner rings a caller back: a content-free push to
 *                             the caller's devices (today's push path), and the caller's open tab or app sees the ring
 *                             in its thread fetch
 *
 * What `.com` learns (said plainly to the caller in the pop-up): which conversation can ring which account's phone,
 * and when the owner rang it. Policy, not cryptography: no log of who called whom; the channel goes on "Stop
 * call-backs", when the owner blocks the caller, removes the page or the caller's account goes, and after 90 days.
 */
import {
  checkVoiciCallPowChallenge,
  checkVoiciCallRequestAnon,
  b64Decode,
  canonicalJson,
  checkVoiciConvDelete,
  parseVoiciAnonBlock,
  verifyVoiciAnonBlock,
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
import type { PushTokenStorage, VoiciCallStorage, VoiciStorage } from "@flagship/storage";
import type { InviteNoticeForward } from "./inviteNotice.js";
import { requireAccountRead, ACCOUNT_KEY_HOLDERS_ONLY, ACCOUNT_READ_HEADERS, type AccountReadTokenDeps } from "./accountReadToken.js";
import { authorizeActiveDevice, type AccountDirectoryDeps, type DirectoryAuthorization } from "./accountDirectory.js";
import { hexToBytes } from "./hex.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { voiciRefusal } from "./voiciPages.js";

const NO_STORE = { "cache-control": "private, no-store" };
const ok = (body: unknown): HandlerResponseWithHeaders => ({ status: 200, body, headers: { ...NO_STORE } });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Pushes a ring to every device of the caller's account (today's push path); answers how many got it. */
export type VoiciRingPusher = (username: string, payload: { kind: "voici-ring"; ringId: string; hint: string }, expiresAt: number) => Promise<number>;

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

/**
 * Body: the signed order (`checkVoiciRingBackOrder`). `account` is the caller's account when the route authorized the
 * caller's app's device headers (a pseudonym-signed order only); a browser's order names no account. Answers
 * {ok, expiresAt?}.
 */
export async function handleVoiciRingBack(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; origin: string; caKeys: (now: number) => string[]; now?: () => number },
  body: unknown,
  account: string | null = null,
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
  if (account !== null && isObj(body) && body.signer !== "pseudonym") return voiciRefusal(400, "malformed");
  if (r.order.op === "stop") {
    await deps.calls.deleteRingBack(page.pageId, r.order.conv);
    return ok({ ok: true });
  }
  const expiresAt = now + VOICI_RING_BACK_TTL_MS;
  if (!(await deps.calls.putRingBack({ pageId: page.pageId, conv: r.order.conv, username: account, issuedAt: r.order.issuedAt, expiresAt }))) return voiciRefusal(409, "stale");
  return ok({ ok: true, expiresAt });
}

/** Whether the conversation has a live ring-back channel (a "callback" page takes a signed-in call only then). */
export async function voiciHasRingBack(calls: VoiciCallStorage, pageId: string, conv: string, now: number): Promise<boolean> {
  return !!(await calls.getRingBack(pageId, conv, now));
}

// ── the ring ──────────────────────────────────────────────────────────────

/**
 * Body {ring, signature} by the page's ownerSignPub. The conversation must have a ring-back channel. Stores the ring
 * (the caller's thread fetch shows it while it rings) and, when the caller's app attached the channel, pushes
 * {kind:"voici-ring", ringId, hint} to that account's devices: no text, the hint sealed to the caller's thread key.
 * Answers {ok, ringId, pushed, expiresAt}.
 */
export async function handleVoiciRing(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; pushRing?: VoiciRingPusher; now?: () => number },
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
  if (deps.pushRing && channel.username) {
    try {
      pushed = await deps.pushRing(channel.username, { kind: "voici-ring", ringId: ring.ringId, hint: ring.hint }, expiresAt);
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

/**
 * The ring push (today's push path): every device of the caller's account, VoIP pushes where a device registered a
 * PushKit token (the call must ring through CallKit), else its ordinary push token; never a browser's Web Push. The
 * payload is {kind:"voici-ring", ringId, hint, room}: no text; the hint is sealed to the caller's thread key.
 */
export function buildVoiciRingPusher(deps: {
  pushTokens: Pick<PushTokenStorage, "listByUser">;
  calls: Pick<VoiciCallStorage, "listVoipTokens" | "deleteVoipToken">;
  forward?: (args: InviteNoticeForward) => Promise<unknown>;
  voip?: (tokens: string[], call: Record<string, string>, expiresAtSec: number, gone?: (token: string) => void) => Promise<number>;
  apex: string;
}): VoiciRingPusher {
  return async (username, payload, expiresAt) => {
    const data = { kind: payload.kind, ringId: payload.ringId, hint: payload.hint, room: deps.apex };
    const voip = await deps.calls.listVoipTokens(username);
    const voipDevices = new Set(voip.map((t) => t.deviceId));
    let n = 0;
    if (voip.length && deps.voip) {
      n += await deps.voip(
        voip.map((t) => t.token),
        data,
        Math.floor(expiresAt / 1000),
        (gone) => void Promise.all(voip.filter((t) => t.token === gone).map((t) => deps.calls.deleteVoipToken(username, t.deviceId))),
      );
    }
    const rest = (await deps.pushTokens.listByUser(username)).filter((t) => !voipDevices.has(t.deviceId) && t.platform !== "webpush");
    if (rest.length && deps.forward) {
      await deps.forward({ targets: rest.map((t) => ({ tokenId: t.tokenId, platform: t.platform, providerToken: t.providerToken })), category: VOICI_RING_PUSH_CATEGORY, sealedPayloadHex: "", displayData: data });
      n += rest.length;
    }
    return n;
  };
}

export const VOICI_RING_PUSH_CATEGORY = "voici-ring";

// ── delete = forget ───────────────────────────────────────────────────────

/**
 * POST /api/voici/web/conv-delete: a signed delete by either side (docs/voici-calls.md, owner 2026-11-16). Drops the
 * conversation's mailbox rows, reply alerts, ring-back channel, ring, call allow and missed calls at once; keeps no
 * archive and no tombstone, and logs nothing. Answers {ok}. `calls` is absent while calls are off (their tables may
 * not exist yet).
 */
export async function handleVoiciConvDelete(
  deps: { voici: VoiciStorage; calls?: VoiciCallStorage; origin: string; caKeys: (now: number) => string[]; now?: () => number },
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const del = isObj(body) && isObj(body.del) ? body.del : null;
  if (!del || typeof del.pageId !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPageById(del.pageId);
  if (!page) return voiciRefusal(404, "not-found");
  const revoked = new Set<string>();
  const delegatePub = isObj(body) && isObj(body.cred) && isObj(body.cred.delegation) ? body.cred.delegation.delegatePub : undefined;
  const from = isObj(body) && typeof body.from === "string" ? body.from : "";
  if (typeof delegatePub === "string" && from && (await deps.voici.isRevoked(delegatePub, from, now))) revoked.add(delegatePub);
  const r = checkVoiciConvDelete(body, { pageId: page.pageId, ownerSignPub: page.ownerSignPub, origin: deps.origin, caKeys: deps.caKeys(now), now, revoked });
  if (!r.ok) return voiciRefusal(r.code === "malformed" ? 400 : 403, r.code);
  // The conversation's block (or accept) goes with it: a caller who writes again arrives as a new request. The
  // caller's pseudonym is the signer's, or, for the owner's delete, the sender of the conversation's mail.
  const pseudonym = isObj(body) && body.signer !== "owner" ? from : (await deps.voici.listThread(page.pageId, r.del.conv, 0, 50)).find((m) => m.kind === "voici-message")?.fromPub;
  if (pseudonym) await deps.voici.deleteBlock(page.pageId, pseudonym);
  await deps.voici.deleteConversation(page.pageId, r.del.conv);
  await deps.calls?.deleteConversationCalls(page.pageId, r.del.conv);
  return ok({ ok: true });
}

/**
 * POST /api/voici/pages/<u>/anon-block {block:{pageId, conv, op, issuedAt}, signature} by the page's ownerSignPub
 * (flagship/voici-anon-block/v1): an anonymous caller's conversation (its browser key, the identity its proof of work
 * was for) can't call again until the owner unblocks it or deletes the conversation.
 */
export async function handleVoiciAnonBlock(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; now?: () => number },
  username: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const b = isObj(body) ? body : {};
  const order = parseVoiciAnonBlock(b.block);
  if (!order || typeof b.signature !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page || page.pageId !== order.pageId) return voiciRefusal(404, "not-found");
  if (Math.abs(now - order.issuedAt) > VOICI_CALL_SKEW_MS) return voiciRefusal(403, "stale");
  if (!verifyVoiciAnonBlock(order, b.signature, page.ownerSignPub)) return voiciRefusal(403, "bad-signature");
  if (order.op === "block") await deps.calls.blockAnon(page.pageId, order.conv, Number.MAX_SAFE_INTEGER);
  else await deps.calls.unblockAnon(page.pageId, order.conv);
  return ok({ ok: true });
}

// ── the owner's call hours, synced and sealed (owner decision 2026-11-16, option c) ─────

const SETTINGS_MAX_BODY = 8 * 1024;

/** GET /api/accounts/<u>/voici-call-settings: the sealed blob (read token of a device of the account), or 404. */
export async function handleVoiciCallSettingsGet(
  deps: { calls: Pick<VoiciCallStorage, "getCallSettings">; readTokens: AccountReadTokenDeps },
  username: string,
  authorization: string | null,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const read = await requireAccountRead(deps.readTokens, u, authorization, ACCOUNT_KEY_HOLDERS_ONLY);
  if (!read.ok) return read.response;
  const s = await deps.calls.getCallSettings(u);
  if (!s) return { ...voiciRefusal(404, "not-found"), headers: { ...ACCOUNT_READ_HEADERS } };
  return { status: 200, body: JSON.parse(s.blob) as unknown, headers: { ...ACCOUNT_READ_HEADERS } };
}

/**
 * PUT /api/accounts/<u>/voici-call-settings {version, nonce, ct} from a device of the account (device headers):
 * `version` = stored + 1, else 409 `version-conflict` with the stored blob. `.com` checks only the shape: it can't open
 * the blob, so it never sees the hours or the time zone.
 */
export async function handleVoiciCallSettingsPut(
  deps: { calls: Pick<VoiciCallStorage, "getCallSettings" | "putCallSettings">; directory: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">; now?: () => number },
  username: string,
  auth: DirectoryAuthorization | undefined,
  bodyText: string,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const u = username.toLowerCase();
  if (bodyText.length > SETTINGS_MAX_BODY) return voiciRefusal(413, "too-large");
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "PUT", path: `/api/accounts/${u}/voici-call-settings` });
  if (!caller) return voiciRefusal(403, "forbidden");
  let s: unknown;
  try {
    s = JSON.parse(bodyText);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  if (!isObj(s) || Object.keys(s).length !== 3 || !Number.isSafeInteger(s.version) || (s.version as number) < 1 || typeof s.nonce !== "string" || !/^[0-9a-f]{24}$/.test(s.nonce) || typeof s.ct !== "string" || !b64Decode(s.ct)) {
    return voiciRefusal(400, "malformed");
  }
  const blob = canonicalJson({ version: s.version, nonce: s.nonce, ct: s.ct });
  if (!(await deps.calls.putCallSettings(u, s.version as number, blob, now))) {
    const cur = await deps.calls.getCallSettings(u);
    return voiciRefusal(409, "version-conflict", { settings: cur ? JSON.parse(cur.blob) : null });
  }
  return ok({ ok: true, version: s.version });
}
