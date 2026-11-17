/**
 * voi.ci calls on `.com` (docs/voici-calls.md §1, §5, §6): `.com` arranges a call and never carries it.
 *
 *   handleVoiciCallRequest   POST /api/voici/calls {request}: checks cheapest first (size, shape, page, calls on,
 *                            blocked / banned, revoked, limits, signatures, the owner's "Who can call", the page's daily
 *                            count, one live call per account), then opens the call's room and rings the admin devices
 *   VoiciCallRoomCore        the room as a pure state machine (the Durable Object in apps/com/src/voiciCallRoom.ts feeds
 *                            it WebSocket messages and alarms): relays signed set-up messages, compare-and-sets the
 *                            first answer, mints the CA receipt for the winning device, ends on hang-up, ring timeout
 *                            (45 s) or the 60-minute limit (D3), and records a missed call
 *   buildVoiciCallRinger     VoIP pushes (iOS PushKit) and high-priority pushes (FCM, UnifiedPush; a plain alert on an
 *                            iPhone without VoIP ringing, the China storefront), the caller sealed to the inbox key
 *   handleVoiciCallAllow     POST /api/voici/pages/<u>/call-allow: the owner's signed allow / disallow for one conversation
 *   handleVoiciVoipToken     POST /api/accounts/<u>/voici-voip-token: a device's PushKit token (device headers)
 *   authorizeVoiciCallDevice the room WebSocket of a ringing device: an active admin device of the account
 *   handleVoiciMissedCalls   GET /api/voici/pages/<u>/calls?since=: sealed missed calls (read token)
 *   handleVoiciCallKey       POST /api/accounts/<u>/voici-call-key: an admin device binds its call-only key (device headers)
 *   handleVoiciCallKeyRevoke POST /api/accounts/<u>/voici-call-key/revoke: a signed revocation (owner key or the call key)
 *   authorizeVoiciCallKeyDevice the room WebSocket of a ringing device that is locked: a join signed by its bound call key
 *
 * What `.com` learns: that pseudonym P rang page X, when, and whether someone answered; never audio or frame keys
 * (the X-Wing secret is the caller's and the answering phone's; `.com` relays only its ciphertext).
 */
import {
  b64Encode,
  checkVoiciCallAnswer,
  checkVoiciCallEnd,
  checkVoiciCallRequest,
  parseVoiciCallKeyProof,
  parseVoiciCallKeyRevoke,
  verifyVoiciCallJoin,
  verifyVoiciCallKeyBinding,
  verifyVoiciCallKeyRevoke,
  isVoiciCallKeyPub,
  parseVoiciCallAllow,
  parseVoiciCallRequest,
  parseVoiciPageIndex,
  sealVoiciCallPush,
  sealVoiciMissedCall,
  signVoiciCallReceipt,
  verifyVoiciCallAllow,
  voiciCallDeviceRef,
  voiciPageAcceptsCalls,
  VOICI_CALL_MAX_MS,
  VOICI_CALL_MAX_REQUEST_BYTES,
  VOICI_CALL_RECEIPT_TTL_MS,
  VOICI_CALL_RING_MS,
  VOICI_CALL_SKEW_MS,
  VOICI_CALL_CAMERA_STATES,
  type VoiciCallAnswer,
  type VoiciCallEnd,
  type VoiciCallRequest,
  type VoiciMissedCallReason,
  type VoiciCallsFrom,
  type VoiciCallRequestAnon,
} from "@flagship/protocol";
import type { DeviceCapabilityGrantStorage, PushTokenStorage, UsernameStorage, VoiciCallStorage, VoiciPageRecord, VoiciStorage } from "@flagship/storage";
import { requireAccountRead, ACCOUNT_KEY_HOLDERS_ONLY, ACCOUNT_READ_HEADERS, type AccountReadTokenDeps } from "./accountReadToken.js";
import { authorizeActiveDevice, type AccountDirectoryDeps, type DirectoryAuthorization } from "./accountDirectory.js";
import { hexToBytes } from "./hex.js";
import { adminDeviceIds, type InviteNoticeForward } from "./inviteNotice.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { voiciRefusal } from "./voiciPages.js";
import { checkAnonymousCall, voiciHasRingBack } from "./voiciCallModes.js";
export { dropVoiciCallKeysOfRevokedDevices } from "./voiciCallKeyCleanup.js";

/** A page's rings per UTC day (D1 counter; the rate-limit buckets hold the per-hour and per-caller budgets). */
export const VOICI_CALL_PAGE_DAILY_MAX = 100;
export const VOICI_MISSED_FETCH_LIMIT = 100;
export const VOICI_MISSED_RETENTION_MS = 180 * 86_400_000;
export const VOICI_CALL_PUSH_CATEGORY = "voici-call";
export const VOICI_CALL_ICE_MAX = 1024;
const NO_STORE = { "cache-control": "private, no-store" };
const ok = (body: unknown): HandlerResponseWithHeaders => ({ status: 200, body, headers: { ...NO_STORE } });
const CURSOR = /^(0|[1-9][0-9]{0,15})?$/;
const CALL_ID = /^[0-9a-f]{32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const callDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The calls setting a stored page carries: v2 index acceptsCalls / callsFrom; a v1 index takes no calls. */
export function voiciPageCalls(page: Pick<VoiciPageRecord, "indexJson" | "takenDownAt" | "removedAt">): { on: boolean; from: VoiciCallsFrom; inboxPub: string | null } {
  if (page.takenDownAt !== null || page.removedAt !== null) return { on: false, from: "accepted", inboxPub: null };
  const idx = parseVoiciPageIndex(page.indexJson);
  if (!idx) return { on: false, from: "accepted", inboxPub: null };
  return { on: voiciPageAcceptsCalls(idx), from: idx.callsFrom ?? "accepted", inboxPub: idx.inboxPub };
}

/**
 * The owner's "Who can call" rule (D1): with `accepted`, a conversation the owner replied in, accepted (an unblock
 * order) or allowed by a call-allow order; with `signed-in`, anyone signed in. A newer `disallow` refuses either way.
 */
export async function voiciCallerAllowed(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage },
  page: { pageId: string },
  from: VoiciCallsFrom,
  conv: string,
  pseudonymPub: string,
  now: number,
): Promise<boolean> {
  const allow = await deps.calls.getCallAllow(page.pageId, conv);
  if (allow?.op === "disallow") return false;
  // "anyone" and "callback" take every signed-in caller ("callback" also needs the conversation's ring-back
  // channel, checked by the request route).
  if (allow?.op === "allow" || from === "signed-in" || from === "anyone" || from === "callback") return true;
  const [block, stats] = await Promise.all([deps.voici.getBlock(page.pageId, pseudonymPub), deps.voici.convStats(page.pageId, conv, now - 3_600_000, now - 86_400_000)]);
  return block?.op === "unblock" || stats.replies > 0;
}

// ── the request ─────────────────────────────────────────────────────────────

export interface VoiciCallRoomInit {
  callId: string;
  username: string;
  pageId: string;
  ownerSignPub: string;
  inboxPub: string;
  request: VoiciCallRequest | VoiciCallRequestAnon;
  callerPub: string;
  callerTokenHash: string;
  ringingAt: number;
}

export interface VoiciCallRequestDeps {
  voici: VoiciStorage;
  calls: VoiciCallStorage;
  origin: string;
  caKeys: (now: number) => string[];
  isPseudonymBanned: (pseudonymPub: string) => Promise<boolean>;
  /** Rate limits: seconds to wait, or null. */
  limitIp: () => Promise<number | null>;
  limitCaller: (pseudonymPub: string) => Promise<number | null>;
  limitPage: (pageId: string) => Promise<number | null>;
  /** Anonymous calls (pages in "anyone" mode): the page's budget, and `.com`'s proof-of-work secret (absent = off). */
  limitAnonPage?: (pageId: string) => Promise<number | null>;
  powSecret?: Uint8Array;
  /** Creates the room; false when one exists under this callId. */
  openRoom: (init: VoiciCallRoomInit) => Promise<boolean>;
  ring: (username: string, call: { callId: string; pageId: string; conv: string; from: string; inboxPub: string; issuedAt: number }) => Promise<number>;
  /** The control apex the room's WebSocket lives on ("flagshipserver.com"). */
  apex: string;
  random?: (n: number) => Uint8Array;
  sha256Hex: (b: Uint8Array) => Promise<string>;
  now?: () => number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Records a missed call sealed to the inbox key; best effort. */
export async function recordVoiciMissedCall(
  calls: VoiciCallStorage,
  o: { pageId: string; inboxPub: string; request: VoiciCallRequest | VoiciCallRequestAnon; ringingAt: number; endedAt: number; reason: VoiciMissedCallReason },
): Promise<boolean> {
  try {
    const sealed = sealVoiciMissedCall(hexToBytes(o.inboxPub), { request: o.request, ringingAt: o.ringingAt, endedAt: o.endedAt, reason: o.reason });
    return await calls.putMissedCall({ pageId: o.pageId, conv: o.request.conv, callId: o.request.callId, sealed: b64Encode(sealed), storedAt: o.endedAt });
  } catch {
    return false;
  }
}

/**
 * POST /api/voici/calls, body {request}. Answers {callId, room, token, ringMs}; refusals `calls-off`, `not-allowed`,
 * `busy` (a missed call is recorded), `rate-limited` + retryAfterSec, and the request check's codes. A blocked or
 * banned caller is told `calls-off` (no oracle).
 */
export async function handleVoiciCallRequest(deps: VoiciCallRequestDeps, bodyText: string): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  if (new TextEncoder().encode(bodyText).length > VOICI_CALL_MAX_REQUEST_BYTES + 64) return voiciRefusal(413, "too-large");
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  const rawRequest = isObj(raw) ? raw.request : undefined;
  if (isObj(rawRequest) && rawRequest.kind === "voici-call-request-anon") return handleAnonymousCallRequest(deps, rawRequest, now);
  const r = parseVoiciCallRequest(rawRequest);
  if (!r) return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPageById(r.pageId);
  if (!page) return voiciRefusal(404, "not-found");
  const calls = voiciPageCalls(page);
  if (!calls.on || !calls.inboxPub) return voiciRefusal(403, "calls-off");
  const [block, banned] = await Promise.all([deps.voici.getBlock(page.pageId, r.from), deps.isPseudonymBanned(r.from)]);
  if (block?.op === "block" || banned) return voiciRefusal(403, "calls-off");
  const delegatePub = isObj(r.cred) && isObj(r.cred.delegation) ? r.cred.delegation.delegatePub : undefined;
  if (typeof delegatePub === "string" && (await deps.voici.isRevoked(delegatePub, r.from, now))) return voiciRefusal(403, "revoked");
  for (const wait of [await deps.limitIp(), await deps.limitCaller(r.from), await deps.limitPage(page.pageId)]) {
    if (wait !== null) return voiciRefusal(429, "rate-limited", { retryAfterSec: wait });
  }
  const checked = checkVoiciCallRequest(r, { pageId: page.pageId, acceptsCalls: true, origin: deps.origin, caKeys: deps.caKeys(now), now });
  if (!checked.ok) return voiciRefusal(checked.code === "malformed" || checked.code === "too-large" ? 400 : 403, checked.code);
  if (!(await voiciCallerAllowed(deps, page, calls.from, r.conv, r.from, now))) return voiciRefusal(403, "not-allowed");
  // "Callback accounts only": calling is consent to a ring-back, so the conversation's channel must be attached.
  if (calls.from === "callback" && !(await voiciHasRingBack(deps.calls, page.pageId, r.conv, now))) return voiciRefusal(403, "ring-back-required");
  if (!(await deps.calls.countRing(page.pageId, callDay(now), VOICI_CALL_PAGE_DAILY_MAX))) return voiciRefusal(429, "rate-limited", { retryAfterSec: 3600 });
  if (!(await deps.calls.claimLiveCall(page.username, r.callId, now, now + VOICI_CALL_RING_MS + 15_000))) {
    await recordVoiciMissedCall(deps.calls, { pageId: page.pageId, inboxPub: calls.inboxPub, request: r, ringingAt: now, endedAt: now, reason: "busy" });
    return voiciRefusal(409, "busy");
  }
  const token = hex((deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32));
  const init: VoiciCallRoomInit = {
    callId: r.callId,
    username: page.username,
    pageId: page.pageId,
    ownerSignPub: page.ownerSignPub,
    inboxPub: calls.inboxPub,
    request: r,
    callerPub: checked.delegation.delegatePub,
    callerTokenHash: await deps.sha256Hex(new TextEncoder().encode(token)),
    ringingAt: now,
  };
  if (!(await deps.openRoom(init))) {
    await deps.calls.releaseLiveCall(page.username, r.callId);
    return voiciRefusal(409, "malformed");
  }
  await deps.ring(page.username, { callId: r.callId, pageId: page.pageId, conv: r.conv, from: r.from, inboxPub: calls.inboxPub, issuedAt: now });
  return ok({ callId: r.callId, room: `wss://${deps.apex}/api/voici/calls/${r.callId}/caller`, token, ringMs: VOICI_CALL_RING_MS });
}

/** The anonymous branch: no account, a proof of work, the page's own budget; then the same room and ringing. */
async function handleAnonymousCallRequest(deps: VoiciCallRequestDeps, raw: Record<string, unknown>, now: number): Promise<HandlerResponseWithHeaders> {
  if (typeof raw.pageId !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPageById(raw.pageId);
  if (!page) return voiciRefusal(404, "not-found");
  const calls = voiciPageCalls(page);
  if (!calls.on || !calls.inboxPub) return voiciRefusal(403, "calls-off");
  const ipWait = await deps.limitIp();
  if (ipWait !== null) return voiciRefusal(429, "rate-limited", { retryAfterSec: ipWait });
  const checked = await checkAnonymousCall(
    { calls: deps.calls, ...(deps.powSecret ? { powSecret: deps.powSecret } : {}), limitAnonPage: deps.limitAnonPage ?? (async () => null), sha256Hex: deps.sha256Hex },
    page,
    raw,
    now,
  );
  if (!checked.ok) return checked.response;
  const r = checked.request;
  if (!(await deps.calls.countRing(page.pageId, callDay(now), VOICI_CALL_PAGE_DAILY_MAX))) return voiciRefusal(429, "rate-limited", { retryAfterSec: 3600 });
  if (!(await deps.calls.claimLiveCall(page.username, r.callId, now, now + VOICI_CALL_RING_MS + 15_000))) {
    await recordVoiciMissedCall(deps.calls, { pageId: page.pageId, inboxPub: calls.inboxPub, request: r, ringingAt: now, endedAt: now, reason: "busy" });
    return voiciRefusal(409, "busy");
  }
  const token = hex((deps.random ?? ((n) => crypto.getRandomValues(new Uint8Array(n))))(32));
  const init: VoiciCallRoomInit = {
    callId: r.callId,
    username: page.username,
    pageId: page.pageId,
    ownerSignPub: page.ownerSignPub,
    inboxPub: calls.inboxPub,
    request: r,
    callerPub: r.browserPub,
    callerTokenHash: await deps.sha256Hex(new TextEncoder().encode(token)),
    ringingAt: now,
  };
  if (!(await deps.openRoom(init))) {
    await deps.calls.releaseLiveCall(page.username, r.callId);
    return voiciRefusal(409, "malformed");
  }
  await deps.ring(page.username, { callId: r.callId, pageId: page.pageId, conv: r.conv, from: r.browserPub, inboxPub: calls.inboxPub, issuedAt: now });
  return ok({ callId: r.callId, room: `wss://${deps.apex}/api/voici/calls/${r.callId}/caller`, token, ringMs: VOICI_CALL_RING_MS });
}

// ── ringing ─────────────────────────────────────────────────────────────────

export interface VoiciCallRingerDeps {
  usernames: Pick<UsernameStorage, "get">;
  grants: Pick<DeviceCapabilityGrantStorage, "listForUser">;
  pushTokens: Pick<PushTokenStorage, "listByUser">;
  calls: VoiciCallStorage;
  /** The standard forwarder (FCM high priority, UnifiedPush urgency high, an APNs alert). */
  forward?: (args: InviteNoticeForward) => Promise<unknown>;
  /** iOS VoIP pushes (pushBridge.ts buildVoipPushSender). */
  voip?: (tokens: string[], call: Record<string, string>, expiresAtSec: number, gone?: (token: string) => void) => Promise<number>;
  apex: string;
  now?: () => number;
  eseed?: () => Uint8Array;
}

/**
 * Rings every admin device (owner decisions: every admin device rings, iPads too): a VoIP push where the device
 * registered a PushKit token, else its ordinary push token (never a browser's Web Push: the webapp does not answer).
 * Every push carries the call id, the room host and the caller sealed to the inbox key.
 */
export function buildVoiciCallRinger(deps: VoiciCallRingerDeps) {
  return {
    async ring(username: string, call: { callId: string; pageId: string; conv: string; from: string; inboxPub: string; issuedAt: number }): Promise<number> {
      try {
        const now = (deps.now ?? Date.now)();
        const user = await deps.usernames.get(username);
        if (!user?.adminRootPubHex) return 0;
        const admins = await adminDeviceIds(deps.grants, username, user.adminRootPubHex, now);
        const sealed = b64Encode(sealVoiciCallPush(hexToBytes(call.inboxPub), { callId: call.callId, pageId: call.pageId, conv: call.conv, from: call.from }, call.issuedAt, ...(deps.eseed ? [deps.eseed()] : [])));
        const payload = { kind: "voici-call", callId: call.callId, room: deps.apex, sealed, issuedAt: String(call.issuedAt) };
        const voip = (await deps.calls.listVoipTokens(username)).filter((t) => admins.has(t.deviceId));
        const voipDevices = new Set(voip.map((t) => t.deviceId));
        let n = 0;
        if (voip.length && deps.voip) {
          n += await deps.voip(
            voip.map((t) => t.token),
            payload,
            Math.floor((call.issuedAt + VOICI_CALL_RING_MS) / 1000),
            (gone) => void Promise.all(voip.filter((t) => t.token === gone).map((t) => deps.calls.deleteVoipToken(username, t.deviceId))),
          );
        }
        const rest = (await deps.pushTokens.listByUser(username)).filter((t) => admins.has(t.deviceId) && !voipDevices.has(t.deviceId) && t.platform !== "webpush");
        if (rest.length && deps.forward) {
          await deps.forward({
            targets: rest.map((t) => ({ tokenId: t.tokenId, platform: t.platform, providerToken: t.providerToken })),
            category: VOICI_CALL_PUSH_CATEGORY,
            sealedPayloadHex: "",
            displayData: payload,
          });
          n += rest.length;
        }
        return n;
      } catch {
        return 0;
      }
    },
  };
}

// ── the room ────────────────────────────────────────────────────────────────

/** A device peer joined with a bound call key carries it (the answer and its end orders must be signed by it). */
export type VoiciCallRoomPeer = { role: "caller" } | { role: "device"; deviceRef: string; callKeyPub?: string };

export type VoiciCallRoomAction =
  | { kind: "send"; to: "caller" | "devices" | { deviceRef: string } | { notDeviceRef: string }; msg: Record<string, unknown> }
  | { kind: "close-all" }
  | { kind: "alarm"; at: number }
  | { kind: "missed"; reason: VoiciMissedCallReason; endedAt: number }
  | { kind: "release" }
  | { kind: "extend"; until: number };

export interface VoiciCallRoomState {
  init: VoiciCallRoomInit;
  phase: "ringing" | "answered" | "ended";
  winner: string | null;
  answeredAt: number | null;
  endReason: string | null;
  /** The winner's call key when it answered while locked. */
  winnerCallKeyPub?: string | null;
}

/**
 * The room's rules, free of transport. Every input returns the actions the Durable Object performs; the state is
 * plain JSON, so the object stores it between hibernations.
 */
export class VoiciCallRoomCore {
  constructor(
    public state: VoiciCallRoomState,
    private readonly ca: { seed: Uint8Array },
  ) {}

  static start(init: VoiciCallRoomInit): { state: VoiciCallRoomState; actions: VoiciCallRoomAction[] } {
    return { state: { init, phase: "ringing", winner: null, answeredAt: null, endReason: null }, actions: [{ kind: "alarm", at: init.ringingAt + VOICI_CALL_RING_MS }] };
  }

  joined(peer: VoiciCallRoomPeer): VoiciCallRoomAction[] {
    const s = this.state;
    if (peer.role === "caller") {
      if (s.phase === "ended") return [{ kind: "send", to: "caller", msg: { t: "ended", reason: s.endReason } }];
      return [{ kind: "send", to: "caller", msg: { t: s.phase === "ringing" ? "ringing" : "connecting", ringUntil: s.init.ringingAt + VOICI_CALL_RING_MS } }];
    }
    const to = { deviceRef: peer.deviceRef };
    if (s.phase === "ended") return [{ kind: "send", to, msg: { t: "ended", reason: s.endReason } }];
    if (s.phase === "answered" && s.winner !== peer.deviceRef) return [{ kind: "send", to, msg: { t: "answered-elsewhere" } }];
    return [{ kind: "send", to, msg: { t: "request", request: s.init.request, ringingAt: s.init.ringingAt } }];
  }

  message(peer: VoiciCallRoomPeer, msg: unknown, now: number): VoiciCallRoomAction[] {
    if (!isObj(msg) || typeof msg.t !== "string") return [];
    const s = this.state;
    if (s.phase === "ended") return [];
    if (msg.t === "ice") {
      const c = msg.candidate;
      if (c !== null && (typeof c !== "string" || c.length > VOICI_CALL_ICE_MAX)) return [];
      if (s.phase !== "answered") return [];
      if (peer.role === "caller") return [{ kind: "send", to: { deviceRef: s.winner! }, msg: { t: "ice", candidate: c } }];
      return peer.deviceRef === s.winner ? [{ kind: "send", to: "caller", msg: { t: "ice", candidate: c } }] : [];
    }
    if (msg.t === "camera") {
      // What a side's camera is doing (voici-calls-v2.md §1.4): UI only, relayed between the caller and the winner.
      if (s.phase !== "answered" || typeof msg.state !== "string" || !(VOICI_CALL_CAMERA_STATES as readonly string[]).includes(msg.state)) return [];
      if (peer.role === "caller") return [{ kind: "send", to: { deviceRef: s.winner! }, msg: { t: "camera", state: msg.state } }];
      return peer.deviceRef === s.winner ? [{ kind: "send", to: "caller", msg: { t: "camera", state: msg.state } }] : [];
    }
    if (msg.t === "end") {
      const e = checkVoiciCallEnd(msg.end, {
        callId: s.init.callId,
        callerPub: s.init.callerPub,
        ownerSignPub: s.init.ownerSignPub,
        ...(s.winnerCallKeyPub ? { ownerCallKeyPub: s.winnerCallKeyPub } : {}),
      });
      if (!e || Math.abs(e.issuedAt - now) > VOICI_CALL_SKEW_MS) return [];
      if (peer.role === "caller" && e.side !== "caller") return [];
      if (peer.role === "device" && (e.side !== "owner" || (s.phase === "answered" && peer.deviceRef !== s.winner))) return [];
      return this.end(e.reason, now, e);
    }
    if (peer.role !== "device") return [];
    if (msg.t === "decline") return s.phase === "ringing" ? this.end("decline", now) : [];
    if (msg.t === "answer") {
      const to = { deviceRef: peer.deviceRef };
      if (s.phase !== "ringing") return [{ kind: "send", to, msg: { t: "answered-elsewhere" } }];
      const a = checkVoiciCallAnswer(msg.answer, {
        request: s.init.request,
        ownerSignPub: s.init.ownerSignPub,
        now,
        username: s.init.username,
        ...(peer.callKeyPub ? { callKeyPub: peer.callKeyPub } : {}),
      });
      if (!a.ok) return [{ kind: "send", to, msg: { t: "error", code: a.code } }];
      if (a.answer.deviceRef !== peer.deviceRef) return [{ kind: "send", to, msg: { t: "error", code: "wrong-device" } }];
      s.phase = "answered";
      s.winner = peer.deviceRef;
      s.answeredAt = now;
      s.winnerCallKeyPub = peer.callKeyPub ?? null;
      const receipt = signVoiciCallReceipt({ account: s.init.username, callId: s.init.callId, deviceRef: peer.deviceRef, issuedAt: now, expiresAt: now + VOICI_CALL_RECEIPT_TTL_MS }, this.ca.seed);
      return [
        { kind: "send", to, msg: { t: "won", receipt } },
        { kind: "send", to: { notDeviceRef: peer.deviceRef }, msg: { t: "answered-elsewhere" } },
        { kind: "send", to: "caller", msg: { t: "answer", answer: a.answer as VoiciCallAnswer } },
        { kind: "extend", until: now + VOICI_CALL_MAX_MS + 60_000 },
        { kind: "alarm", at: now + VOICI_CALL_MAX_MS },
      ];
    }
    return [];
  }

  /** The caller's room connection dropped: before an answer that is a cancel; after one the media path decides. */
  callerLeft(now: number): VoiciCallRoomAction[] {
    return this.state.phase === "ringing" ? this.end("cancel", now) : [];
  }

  /**
   * A device's room connection dropped. The answering device ends its call whenever its room connection closes (a
   * give-up while connecting, a hang-up whose signed end was lost, the app ending), so after an answer the winner
   * leaving ends the call; otherwise the account would stay "on another call" until the 60-minute limit.
   */
  deviceLeft(deviceRef: string, now: number): VoiciCallRoomAction[] {
    const s = this.state;
    return s.phase === "answered" && s.winner === deviceRef ? this.end("hangup", now) : [];
  }

  alarm(now: number): VoiciCallRoomAction[] {
    const s = this.state;
    if (s.phase === "ringing" && now >= s.init.ringingAt + VOICI_CALL_RING_MS) return this.end("no-answer", now);
    if (s.phase === "answered" && s.answeredAt !== null && now >= s.answeredAt + VOICI_CALL_MAX_MS) return this.end("limit", now);
    if (s.phase === "ringing") return [{ kind: "alarm", at: s.init.ringingAt + VOICI_CALL_RING_MS }];
    if (s.phase === "answered" && s.answeredAt !== null) return [{ kind: "alarm", at: s.answeredAt + VOICI_CALL_MAX_MS }];
    return [];
  }

  private end(reason: string, now: number, signed?: VoiciCallEnd): VoiciCallRoomAction[] {
    const s = this.state;
    const wasRinging = s.phase === "ringing";
    s.phase = "ended";
    s.endReason = reason;
    const msg = { t: "ended", reason, ...(signed ? { end: signed } : {}) };
    const out: VoiciCallRoomAction[] = [
      { kind: "send", to: "caller", msg },
      { kind: "send", to: "devices", msg },
    ];
    if (wasRinging && (reason === "no-answer" || reason === "cancel" || reason === "decline" || reason === "busy")) {
      out.push({ kind: "missed", reason: reason as VoiciMissedCallReason, endedAt: now });
    }
    out.push({ kind: "release" }, { kind: "close-all" });
    return out;
  }
}

// ── owner routes ────────────────────────────────────────────────────────────

/** Body {allow:{pageId, conv, op, issuedAt}, signature} by the page's current ownerSignPub. */
export async function handleVoiciCallAllow(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; now?: () => number },
  username: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const now = (deps.now ?? Date.now)();
  const b = isObj(body) ? body : {};
  const order = parseVoiciCallAllow(b.allow);
  if (!order || typeof b.signature !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page || page.pageId !== order.pageId) return voiciRefusal(404, "not-found");
  if (Math.abs(now - order.issuedAt) > VOICI_CALL_SKEW_MS) return voiciRefusal(403, "stale");
  if (!verifyVoiciCallAllow(order, b.signature, page.ownerSignPub)) return voiciRefusal(403, "bad-signature");
  await deps.calls.setCallAllow({ ...order, signature: b.signature }, now);
  return ok({ ok: true });
}

const VOIP_TOKEN = /^[0-9a-f]{64,200}$/;

/** Body {token} (hex PushKit token) or {token: null} to remove; the device headers name the device. */
export async function handleVoiciVoipToken(
  deps: { calls: VoiciCallStorage; directory: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">; now?: () => number },
  username: string,
  auth: DirectoryAuthorization | undefined,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "POST", path: `/api/accounts/${u}/voici-voip-token` });
  if (!caller) return voiciRefusal(403, "forbidden");
  const token = isObj(body) ? body.token : undefined;
  if (token === null) {
    await deps.calls.deleteVoipToken(u, caller.deviceId);
    return ok({ ok: true });
  }
  if (typeof token !== "string" || !VOIP_TOKEN.test(token)) return voiciRefusal(400, "malformed");
  await deps.calls.putVoipToken({ username: u, deviceId: caller.deviceId, devicePub: caller.signerPubHex.toLowerCase(), token, registeredAt: (deps.now ?? Date.now)() });
  return ok({ ok: true });
}

/** A ringing device's room WebSocket: an active admin device of the account. Answers its deviceRef. */
export async function authorizeVoiciCallDevice(
  deps: {
    usernames: Pick<UsernameStorage, "get">;
    grants: Pick<DeviceCapabilityGrantStorage, "listForUser">;
    directory: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">;
    now?: () => number;
  },
  username: string,
  callId: string,
  auth: DirectoryAuthorization | undefined,
): Promise<{ deviceRef: string } | null> {
  const u = username.toLowerCase();
  if (!CALL_ID.test(callId)) return null;
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "GET", path: `/api/voici/calls/${callId}/device` });
  if (!caller) return null;
  const user = await deps.usernames.get(u);
  if (!user?.adminRootPubHex) return null;
  const admins = await adminDeviceIds(deps.grants, u, user.adminRootPubHex, (deps.now ?? Date.now)());
  if (!admins.has(caller.deviceId)) return null;
  return { deviceRef: voiciCallDeviceRef(caller.signerPubHex.toLowerCase()) };
}

/** The page's missed calls since a cursor, sealed to its inbox key: {items:[{id, callId, conv, sealed, storedAt}], cursor, more}. */
export async function handleVoiciMissedCalls(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; readTokens: AccountReadTokenDeps },
  username: string,
  since: string,
  authorization: string | null,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const read = await requireAccountRead(deps.readTokens, u, authorization, ACCOUNT_KEY_HOLDERS_ONLY);
  if (!read.ok) return read.response;
  if (!CURSOR.test(since)) return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(u);
  if (!page) return voiciRefusal(404, "not-found");
  const after = since === "" ? 0 : Number(since);
  const rows = await deps.calls.listMissedCalls(page.pageId, after, VOICI_MISSED_FETCH_LIMIT + 1);
  const out = rows.slice(0, VOICI_MISSED_FETCH_LIMIT);
  return {
    status: 200,
    body: {
      pageId: page.pageId,
      items: out.map((m) => ({ id: m.id, callId: m.callId, conv: m.conv, sealed: m.sealed, storedAt: m.storedAt })),
      cursor: out.length ? String(out[out.length - 1]!.id) : since,
      more: rows.length > VOICI_MISSED_FETCH_LIMIT,
    },
    headers: { ...ACCOUNT_READ_HEADERS },
  };
}

// ── call keys: answering while locked ───────────────────────────────────────

type CallKeyDirectory = Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">;

/**
 * Body {binding, signature}: an active admin device binds its own call-only key, signed by the page's current
 * ownerSignPub. One key per device; a revoked key never binds again.
 */
export async function handleVoiciCallKey(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; usernames: Pick<UsernameStorage, "get">; grants: Pick<DeviceCapabilityGrantStorage, "listForUser">; directory: CallKeyDirectory; now?: () => number },
  username: string,
  auth: DirectoryAuthorization | undefined,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const now = (deps.now ?? Date.now)();
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "POST", path: `/api/accounts/${u}/voici-call-key` });
  if (!caller) return voiciRefusal(403, "forbidden");
  const proof = parseVoiciCallKeyProof(body);
  if (!proof) return voiciRefusal(400, "malformed");
  if (proof.binding.username !== u || proof.binding.deviceId !== caller.deviceId) return voiciRefusal(403, "wrong-device");
  if (Math.abs(proof.binding.createdAt - now) > VOICI_CALL_SKEW_MS) return voiciRefusal(403, "stale");
  const user = await deps.usernames.get(u);
  if (!user?.adminRootPubHex) return voiciRefusal(403, "forbidden");
  if (!(await adminDeviceIds(deps.grants, u, user.adminRootPubHex, now)).has(caller.deviceId)) return voiciRefusal(403, "not-admin");
  const page = await deps.voici.getPage(u);
  if (!page) return voiciRefusal(404, "not-found");
  if (!verifyVoiciCallKeyBinding(proof.binding, proof.signature, { ownerSignPub: page.ownerSignPub, username: u })) return voiciRefusal(403, "bad-signature");
  if (!(await deps.calls.putCallKey({ ...proof.binding, signature: proof.signature, registeredAt: now }))) return voiciRefusal(403, "revoked");
  return ok({ ok: true });
}

/** Body {revoke, signature}: signed by the page's ownerSignPub or by the call key itself. No device needed. */
export async function handleVoiciCallKeyRevoke(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage },
  username: string,
  body: unknown,
): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const b = isObj(body) ? body : {};
  const r = parseVoiciCallKeyRevoke(b.revoke);
  if (!r || typeof b.signature !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(u);
  // A page that is gone still lets the key revoke itself.
  if (!verifyVoiciCallKeyRevoke(r, b.signature, { ownerSignPub: page?.ownerSignPub ?? "", username: u })) return voiciRefusal(403, "bad-signature");
  await deps.calls.revokeCallKey({ ...r, signature: b.signature });
  return ok({ ok: true });
}

/** The join a locked device sends as headers on the room WebSocket. */
export interface VoiciCallKeyJoinAuth {
  deviceId: string;
  callKeyPub: string;
  issuedAt: number;
  signature: string;
}

/**
 * A ringing device's room WebSocket while its account key is locked: a join signed by the call key `.com` holds for
 * that device, not revoked, whose binding still verifies under the page's current ownerSignPub, on an active admin
 * device. Answers the deviceRef (H(callKeyPub)) and the key the answer must be signed by.
 */
export async function authorizeVoiciCallKeyDevice(
  deps: { voici: VoiciStorage; calls: VoiciCallStorage; usernames: Pick<UsernameStorage, "get">; grants: Pick<DeviceCapabilityGrantStorage, "listForUser">; now?: () => number },
  username: string,
  callId: string,
  join: VoiciCallKeyJoinAuth | undefined,
  /** Told which check refused (a reason code, never a key), for the operator's log. */
  refused?: (code: string) => void,
): Promise<{ deviceRef: string; callKeyPub: string } | null> {
  const u = username.toLowerCase();
  const now = (deps.now ?? Date.now)();
  const no = (code: string) => (refused?.(code), null);
  if (!join || !CALL_ID.test(callId) || !isVoiciCallKeyPub(join.callKeyPub)) return no("malformed");
  if (!verifyVoiciCallJoin({ username: u, callId, deviceId: join.deviceId, callKeyPub: join.callKeyPub, issuedAt: join.issuedAt }, join.signature, now)) return no("join-signature-or-time");
  const rec = await deps.calls.getCallKey(u, join.deviceId);
  if (!rec) return no("no-bound-key-for-device");
  if (rec.callKeyPub !== join.callKeyPub) return no("key-differs-from-bound");
  if (await deps.calls.isCallKeyRevoked(rec.callKeyPub)) return no("key-revoked");
  const page = await deps.voici.getPage(u);
  if (!page) return no("no-page");
  if (!verifyVoiciCallKeyBinding({ username: rec.username, deviceId: rec.deviceId, callKeyPub: rec.callKeyPub, createdAt: rec.createdAt }, rec.signature, { ownerSignPub: page.ownerSignPub, username: u })) return no("binding-not-under-page-key");
  const user = await deps.usernames.get(u);
  if (!user?.adminRootPubHex) return no("no-admin-root");
  if (!(await adminDeviceIds(deps.grants, u, user.adminRootPubHex, now)).has(join.deviceId)) return no("not-admin-device");
  return { deviceRef: voiciCallDeviceRef(join.callKeyPub), callKeyPub: join.callKeyPub };
}

