/**
 * The voi.ci Messages mailbox on `.com` (docs/voici-and-messages.md §6.4, §7, §8.3, §9.1, §9.4, §10.1):
 *
 *   POST /api/voici/web/send                 the envelope (voici-message or voici-reply)
 *   POST /api/voici/web/thread               a browser key's signed fetch of its own conversation
 *   POST /api/voici/web/revoke               a pseudonym signs one of its browser keys out
 *   GET  /api/voici/pages/<u>/inbox?since=   read token of <u>: envelopes, blocks, revoked browser keys
 *   POST /api/voici/pages/<u>/block          signed by the page's ownerSignPub
 *   GET|PUT /api/accounts/<u>/messages-state read token / device headers: the sealed state blob
 *
 * `.com` never opens a body. Send checks run cheapest first; filters on the claimed `from` only ever drop (a blocked
 * sender is told `accepted`). Signatures are checked with the platform's Ed25519 and P-256 where it has them (the
 * pure-JS P-256 verify costs a millisecond of the request's CPU); the verdicts and their order are those of
 * `checkVoiciMessage` (packages/protocol/src/voiciMessages.ts), which the tests hold this to over the shared vectors.
 */
import {
  b64Decode,
  canonicalJson,
  canonicalMessagesKeyAttestation,
  canonicalVoiciThreadFetch,
  canonicalVoiciThreadStatement,
  canonicalWebDelegation,
  canonicalWebEnvelope,
  checkMessagesKeyAttestation,
  checkVoiciReply,
  checkWebDelegation,
  ed25519VerifyHex,
  edVerifyFast,
  hexToBytes,
  isLowerHex,
  p256VerifyP1363,
  parseMessagesKeyAttestation,
  parseVoiciBlock,
  parseVoiciSealedBody,
  parseVoiciThreadStatement,
  parseWebDelegation,
  parseWebDelegationRevoke,
  parseWebEnvelope,
  verifyVoiciBlock,
  verifyWebDelegationRevoke,
  voiciConv,
  VOICI_SEND_SKEW_MS,
  VOICI_STATE_MAX_BYTES,
  WEB_ENVELOPE_MAX_BYTES,
  type Bytes,
  type VoiciCheckRefusal,
  type VoiciMessageCred,
  type WebDelegation,
  type WebEnvelope,
} from "@flagship/protocol";
import type { DeviceCapabilityGrantStorage, PushTokenStorage, UsernameStorage, VoiciStorage } from "@flagship/storage";
import { authorizeActiveDevice, type AccountDirectoryDeps, type DirectoryAuthorization } from "./accountDirectory.js";
import { requireAccountRead, ACCOUNT_KEY_HOLDERS_ONLY, ACCOUNT_READ_HEADERS, type AccountReadTokenDeps } from "./accountReadToken.js";
import { appRouteLink } from "./appLink.js";
import { adminDeviceIds, type InviteNoticeForward } from "./inviteNotice.js";
import type { HandlerResponseWithHeaders } from "./types.js";
import { voiciRefusal, VOICI_DRAFT_TTL_MS, VOICI_UNREFERENCED_TTL_MS, voiciPieceKey, type VoiciBucket } from "./voiciPages.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Mailbox retention (D6). */
export const VOICI_MESSAGE_TTL_MS = 180 * DAY;
/** Messages a sender may leave before the owner replies or accepts (§9.4, D11). */
export const VOICI_AWAITING_REPLY_CAP = 3;
export const VOICI_CONV_PER_HOUR = 30;
export const VOICI_CONV_PER_DAY = 200;
/** Envelopes one inbox or thread fetch returns. */
export const VOICI_FETCH_LIMIT = 200;

const nowOf = (d: { now?: () => number }) => (d.now ?? Date.now)();
const okNoStore = (body: unknown): HandlerResponseWithHeaders => ({ status: 200, body, headers: { "cache-control": "private, no-store" } });

// ── the message check ───────────────────────────────────────────────────────

type Fail = { ok: false; code: VoiciCheckRefusal };
const no = (code: VoiciCheckRefusal): Fail => ({ ok: false, code });

export interface VoiciFastCheckContext {
  pageId: string;
  acceptsMessages: boolean;
  origin: string;
  caKeys: readonly string[];
  now: number;
  /** The page blocked this pseudonym, or Flagship banned it. */
  isBlocked?: (pseudonymPub: string) => Promise<boolean>;
  isRevoked?: (delegatePub: string) => Promise<boolean>;
  rateLimit?: (env: WebEnvelope) => Promise<VoiciCheckRefusal | null>;
}

function exactKeys(r: Record<string, unknown>, keys: string[]): boolean {
  const ks = Object.keys(r);
  return keys.every((k) => k in r) && ks.every((k) => keys.includes(k));
}

type NativeKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const p256Keys = new Map<string, Promise<NativeKey>>();
let p256NativeBroken = false;

/** ECDSA P-256 / SHA-256 over `msg`, IEEE P1363 signature: the platform's, else the pure-JS check (same verdict). */
export async function p256VerifyFast(sigHex: string, msg: Bytes, pubHex: string): Promise<boolean> {
  if (!isLowerHex(sigHex, 64) || !isLowerHex(pubHex, 65) || !pubHex.startsWith("04")) return false;
  if (!p256NativeBroken && typeof crypto !== "undefined" && crypto.subtle) {
    try {
      let k = p256Keys.get(pubHex);
      if (!k) {
        if (p256Keys.size >= 256) p256Keys.delete(p256Keys.keys().next().value!);
        k = crypto.subtle.importKey("raw", hexToBytes(pubHex), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        p256Keys.set(pubHex, k);
        k.catch(() => p256Keys.delete(pubHex));
      }
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await k, hexToBytes(sigHex), msg);
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      if (name === "NotSupportedError") p256NativeBroken = true;
      else return false;
    }
  }
  return p256VerifyP1363(sigHex, msg, pubHex);
}

/** Starts the Ed25519 checks the sync verdicts below will ask for, natively, so they answer from memory. */
async function warmCred(c: Record<string, unknown>): Promise<void> {
  const jobs: Promise<boolean>[] = [];
  const att = parseMessagesKeyAttestation(c.attestation);
  if (att) jobs.push(edVerifyFast(att.signature, canonicalMessagesKeyAttestation(att), att.signedBy));
  const del = parseWebDelegation(c.delegation);
  if (del && typeof c.delegationSig === "string" && isLowerHex(c.delegationSig, 64)) {
    jobs.push(edVerifyFast(c.delegationSig, canonicalWebDelegation(del), del.principalPub));
  }
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (ts && typeof c.threadSig === "string" && isLowerHex(c.threadSig, 64)) {
    jobs.push(edVerifyFast(c.threadSig, canonicalVoiciThreadStatement(ts), ts.pseudonymPub));
  }
  await Promise.all(jobs.map((j) => j.catch(() => false)));
}

/** The outer shape of a voici-message (no context): the first checks of `checkVoiciMessage`. */
export function parseVoiciMessageOuter(input: unknown, byteLength: number): { ok: true; envelope: WebEnvelope } | Fail {
  if (byteLength > WEB_ENVELOPE_MAX_BYTES) return no("too-large");
  const env = parseWebEnvelope(input);
  if (!env) return no("malformed");
  if (env.kind !== "voici-message" || env.sigAlg !== "p256") return no("wrong-kind");
  if (!isLowerHex(env.from, 32) || !isLowerHex(env.conv, 32)) return no("malformed");
  if (!parseVoiciSealedBody(b64Decode(env.bodyB64)!)) return no("malformed");
  if (!exactKeys(env.cred, ["attestation", "delegation", "delegationSig", "threadStmt", "threadSig"])) return no("malformed");
  return { ok: true, envelope: env };
}

/**
 * `checkVoiciMessage` with async filters and the platform's signature checks: size, outer schema, kind, audience,
 * accepting, blocked / banned, revoked, rate limits, attestation, delegation, thread statement, conv, the envelope's
 * P-256 signature, freshness. `byteLength` is the envelope's size on the wire.
 */
export async function checkVoiciMessageFast(
  input: unknown,
  byteLength: number,
  ctx: VoiciFastCheckContext,
  parsed?: WebEnvelope,
): Promise<{ ok: true; envelope: WebEnvelope; cred: VoiciMessageCred } | Fail> {
  const outer = parsed ? { ok: true as const, envelope: parsed } : parseVoiciMessageOuter(input, byteLength);
  if (!outer.ok) return outer;
  const env = outer.envelope;
  const c = env.cred;
  if (env.audience !== ctx.pageId) return no("wrong-audience");
  if (!ctx.acceptsMessages) return no("not-accepting");
  if (ctx.isBlocked && (await ctx.isBlocked(env.from))) return no("blocked");
  const delegatePub = c.delegation && typeof c.delegation === "object" ? (c.delegation as Record<string, unknown>).delegatePub : undefined;
  if (typeof delegatePub === "string" && ctx.isRevoked && (await ctx.isRevoked(delegatePub))) return no("revoked");
  const limited = ctx.rateLimit ? await ctx.rateLimit(env) : null;
  if (limited) return no(limited);
  await warmCred(c);
  const att = checkMessagesKeyAttestation(c.attestation, { caKeys: ctx.caKeys, now: ctx.now, pseudonymPub: env.from });
  if (!att.ok) return no("bad-attestation");
  const del = checkWebDelegation(c.delegation, c.delegationSig, {
    scope: "voici-messages",
    origin: ctx.origin,
    audience: ctx.pageId,
    principalPub: env.from,
    now: ctx.now,
    notAfter: att.attestation.expiresAt,
  });
  if (!del.ok) return no("bad-delegation");
  const ts = parseVoiciThreadStatement(c.threadStmt);
  if (!ts || ts.pageId !== ctx.pageId || ts.pseudonymPub !== env.from || typeof c.threadSig !== "string") return no("bad-thread");
  if (!ed25519VerifyHex(c.threadSig, canonicalVoiciThreadStatement(ts), env.from)) return no("bad-thread");
  if (env.conv !== voiciConv(ctx.pageId, env.from)) return no("wrong-conv");
  let signed: Bytes;
  try {
    signed = canonicalWebEnvelope(env);
  } catch {
    return no("bad-signature");
  }
  if (!(await p256VerifyFast(env.sig, signed, del.delegation.delegatePub))) return no("bad-signature");
  if (Math.abs(env.sentAt - ctx.now) > VOICI_SEND_SKEW_MS) return no("stale");
  return {
    ok: true,
    envelope: env,
    cred: { attestation: att.attestation, delegation: del.delegation, delegationSig: c.delegationSig as string, threadStmt: ts, threadSig: c.threadSig },
  };
}

// ── push ────────────────────────────────────────────────────────────────────

export const MESSAGES_PUSH_CATEGORY = "messages";
export const PAGE_DRAFTS_PUSH_CATEGORY = "page-drafts";

export interface VoiciPushDeps {
  usernames: Pick<UsernameStorage, "get">;
  grants: Pick<DeviceCapabilityGrantStorage, "listForUser">;
  pushTokens: Pick<PushTokenStorage, "listByUser">;
  forward: (args: InviteNoticeForward) => Promise<unknown>;
  apex?: string;
  now?: () => number;
}

export interface VoiciPush {
  /** Every device of the owner with a push token: `message` (an accepted conversation) or `message-request`. */
  message(username: string, kind: "message" | "message-request"): Promise<number>;
  /** The account's admin devices: a draft op is waiting for one to publish. */
  pageDrafts(username: string): Promise<number>;
}

/** Content-free pushes (§8.3): a fixed category, kind and app link; never a name, a page or a word of a message. */
export function buildVoiciPush(deps: VoiciPushDeps): VoiciPush {
  const send = async (username: string, category: string, kind: string, route: string, onlyAdmins: boolean) => {
    try {
      let tokens = await deps.pushTokens.listByUser(username);
      if (onlyAdmins) {
        const user = await deps.usernames.get(username);
        if (!user?.adminRootPubHex) return 0;
        const admins = await adminDeviceIds(deps.grants, username, user.adminRootPubHex, (deps.now ?? Date.now)());
        tokens = tokens.filter((t) => admins.has(t.deviceId));
      }
      if (tokens.length === 0) return 0;
      const displayData = { kind, deepLink: appRouteLink(route, {}, deps.apex) };
      await deps.forward({
        targets: tokens.map((t) => ({ tokenId: t.tokenId, platform: t.platform, providerToken: t.providerToken })),
        category,
        sealedPayloadHex: "",
        webpushPayloadBytes: new TextEncoder().encode(JSON.stringify({ category, ...displayData })),
        displayData,
      });
      return tokens.length;
    } catch {
      return 0;
    }
  };
  return {
    message: (username, kind) => send(username, MESSAGES_PUSH_CATEGORY, kind, "messages", false),
    pageDrafts: (username) => send(username, PAGE_DRAFTS_PUSH_CATEGORY, PAGE_DRAFTS_PUSH_CATEGORY, "page-editor", true),
  };
}

// ── send ────────────────────────────────────────────────────────────────────

export interface VoiciMailboxDeps {
  voici: VoiciStorage;
  /** "https://voi.ci" (gym "https://gym.voi.ci"): the origin a delegation must name. */
  origin: string;
  /** The CA keys an attestation may be signed by (the maintainer chain's, at `now`). */
  caKeys: (now: number) => readonly string[];
  /** Chunk B2: Flagship banned this pseudonym (§9.3). */
  isPseudonymBanned?: (pseudonymPub: string) => Promise<boolean>;
  /** Per-IP and per-page counters (rateLimit.ts). A non-null answer refuses with `rate-limited` and that delay. */
  limitSend?: () => Promise<number | null>;
  limitNewConversation?: (pageId: string) => Promise<number | null>;
  push?: VoiciPush;
  /** A reply was stored in `conv`: the visitor's opt-in reply alerts (voiciAlerts.ts). The Worker runs it after the
   *  answer (waitUntil), so it never delays or fails the send. */
  replyStored?: (pageUsername: string, conv: string) => void | Promise<unknown>;
  now?: () => number;
}

type SendBody = { envelope: unknown; direct: boolean };

function sendBody(raw: unknown): SendBody {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "envelope" in raw) {
    const r = raw as { envelope: unknown; direct?: unknown };
    return { envelope: r.envelope, direct: r.direct === true };
  }
  return { envelope: raw, direct: false };
}

const accepted = (msgId: string, storedAt: number | null) => okNoStore({ ok: true, status: "accepted", msgId, ...(storedAt !== null ? { storedAt } : {}) });

const SEND_STATUS: Partial<Record<VoiciCheckRefusal, number>> = {
  "too-large": 413,
  malformed: 400,
  "wrong-kind": 400,
  "wrong-audience": 404,
  "not-accepting": 403,
  revoked: 403,
  "rate-limited": 429,
};

export async function handleVoiciSend(deps: VoiciMailboxDeps, bodyText: string): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const byteLength = new TextEncoder().encode(bodyText).length;
  if (byteLength > WEB_ENVELOPE_MAX_BYTES + 64) return voiciRefusal(413, "too-large");
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  const body = sendBody(raw);
  const envBytes = body.envelope === raw ? byteLength : new TextEncoder().encode(JSON.stringify(body.envelope)).length;
  const kind = body.envelope && typeof body.envelope === "object" ? (body.envelope as { kind?: unknown }).kind : undefined;
  if (kind === "voici-reply") return sendReply(deps, body, envBytes, now);
  const outer = parseVoiciMessageOuter(body.envelope, envBytes);
  if (!outer.ok) return voiciRefusal(SEND_STATUS[outer.code] ?? 400, outer.code);
  const page = await deps.voici.getPageById(outer.envelope.audience);
  if (!page || page.takenDownAt !== null) return voiciRefusal(404, "not-found");
  let retryAfterSec = 0;
  let isNew = false;
  let stats: Awaited<ReturnType<VoiciStorage["convStats"]>> | null = null;
  let acceptedConv = false;
  const verdict = await checkVoiciMessageFast(body.envelope, envBytes, {
    pageId: page.pageId,
    acceptsMessages: page.acceptsMessages === 1,
    origin: deps.origin,
    caKeys: deps.caKeys(now),
    now,
    isBlocked: async (from) => {
      const [block, banned] = await Promise.all([deps.voici.getBlock(page.pageId, from), deps.isPseudonymBanned?.(from) ?? false]);
      acceptedConv = block?.op === "unblock";
      return block?.op === "block" || banned;
    },
    isRevoked: (dp) => deps.voici.isRevoked(dp, now),
    rateLimit: async (env) => {
      const existing = await deps.voici.getMessage(env.conv, env.msgId);
      if (existing) return null;
      const [ip, s] = await Promise.all([deps.limitSend?.() ?? null, deps.voici.convStats(env.conv, now - HOUR, now - DAY)]);
      stats = s;
      if (ip !== null) {
        retryAfterSec = ip;
        return "rate-limited";
      }
      isNew = s.messages === 0 && s.replies === 0;
      if (s.replies === 0 && !acceptedConv && s.messages >= VOICI_AWAITING_REPLY_CAP) return "awaiting-reply" as VoiciCheckRefusal;
      if (s.messagesLastHour >= VOICI_CONV_PER_HOUR) {
        retryAfterSec = 3600;
        return "rate-limited";
      }
      if (s.messagesLastDay >= VOICI_CONV_PER_DAY) {
        retryAfterSec = 86_400;
        return "rate-limited";
      }
      if (isNew && deps.limitNewConversation) {
        const busy = await deps.limitNewConversation(page.pageId);
        if (busy !== null) {
          retryAfterSec = busy;
          return "page-busy" as VoiciCheckRefusal;
        }
      }
      return null;
    },
  }, outer.envelope);
  if (!verdict.ok) {
    if (verdict.code === "blocked") return accepted(outer.envelope.msgId, null);
    const code = verdict.code as string;
    if (code === "rate-limited" || code === "page-busy") return voiciRefusal(429, code, { retryAfterSec: retryAfterSec || 60 });
    if (code === "awaiting-reply") return voiciRefusal(429, code);
    return voiciRefusal(SEND_STATUS[verdict.code] ?? 403, verdict.code);
  }
  const env = verdict.envelope;
  const s = stats as Awaited<ReturnType<VoiciStorage["convStats"]>> | null;
  const request = !acceptedConv && (s?.replies ?? 0) === 0;
  const push = !body.direct && (!request || s?.lastPushedAt == null || s.lastPushedAt <= now - HOUR);
  const stored = await deps.voici.insertMessage({
    pageId: page.pageId,
    conv: env.conv,
    msgId: env.msgId,
    kind: "voici-message",
    fromPub: env.from,
    delegatePub: verdict.cred.delegation.delegatePub,
    sentAt: env.sentAt,
    envelope: body.envelope === raw ? bodyText : JSON.stringify(env),
    size: envBytes,
    direct: body.direct,
    pushed: push,
    storedAt: now,
  });
  if (!stored.ok) return accepted(env.msgId, null);
  if (push && deps.push) await deps.push.message(page.username, request ? "message-request" : "message");
  return accepted(env.msgId, now);
}

async function sendReply(deps: VoiciMailboxDeps, body: SendBody, envBytes: number, now: number): Promise<HandlerResponseWithHeaders> {
  if (envBytes > WEB_ENVELOPE_MAX_BYTES) return voiciRefusal(413, "too-large");
  const env = parseWebEnvelope(body.envelope);
  if (!env) return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPageById(env.audience);
  if (!page || page.takenDownAt !== null) return voiciRefusal(404, "not-found");
  const [prior, retry] = await Promise.all([deps.voici.getMessage(env.conv, env.msgId), deps.limitSend?.() ?? null]);
  if (retry !== null) return voiciRefusal(429, "rate-limited", { retryAfterSec: retry });
  await edVerifyFast(env.sig, safeCanonical(env), page.ownerSignPub).catch(() => false);
  const r = checkVoiciReply(body.envelope, { pageId: page.pageId, ownerSignPub: page.ownerSignPub, freshAt: now });
  if (!r.ok) return voiciRefusal(SEND_STATUS[r.code] ?? 403, r.code);
  if (prior) return accepted(env.msgId, null);
  const stats = await deps.voici.convStats(env.conv, now - HOUR, now - DAY);
  if (stats.messages === 0) return voiciRefusal(404, "not-found");
  const stored = await deps.voici.insertMessage({
    pageId: page.pageId,
    conv: env.conv,
    msgId: env.msgId,
    kind: "voici-reply",
    fromPub: env.from,
    delegatePub: null,
    sentAt: env.sentAt,
    envelope: JSON.stringify(r.envelope),
    size: envBytes,
    direct: false,
    pushed: false,
    storedAt: now,
  });
  if (stored.ok && deps.replyStored) await deps.replyStored(page.username, env.conv);
  return accepted(env.msgId, stored.ok ? now : null);
}

function safeCanonical(env: WebEnvelope): Bytes {
  try {
    return canonicalWebEnvelope(env);
  } catch {
    return new Uint8Array(0);
  }
}

// ── the visitor's thread ────────────────────────────────────────────────────

export interface VoiciThreadDeps {
  voici: VoiciStorage;
  origin: string;
  /** The CA keys an attestation may be signed by; absent, the thread fetch does not look at the attestation. */
  caKeys?: (now: number) => readonly string[];
  now?: () => number;
}

const CURSOR = /^[A-Za-z0-9_-]{0,64}$/;
const cursorId = (since: string) => (since === "" ? 0 : /^[0-9]{1,15}$/.test(since) ? Number(since) : -1);

const wireMessage = (m: { id: number; envelope: string; storedAt: number; fetchedAt: number | null; direct: boolean }) => ({
  id: String(m.id),
  envelope: JSON.parse(m.envelope) as unknown,
  storedAt: m.storedAt,
  fetchedAt: m.fetchedAt,
  direct: m.direct,
});

/**
 * The browser key B's authority over one conversation, as a thread fetch proves it (and a reply-alert order, see
 * voiciAlerts.ts): `issuedAt` within the send window; cred's attestation still holds (when CA keys are given); its
 * delegation (by P, for voi.ci, not expired) binds B to P; `conv` is P's conversation with the delegation's page;
 * `sig` is B's P-256 signature over `bytes`. Refusals are `.com` answers. The caller checks B is not signed out
 * (`voici.isRevoked(delegation.delegatePub)`, refusal `revoked`), alongside its own read so they leave as one batch.
 */
export async function authorizeBrowserKey(
  deps: VoiciThreadDeps,
  o: { conv: string; issuedAt: number; sig: unknown; cred: Record<string, unknown>; bytes: () => Bytes },
): Promise<{ ok: true; delegation: WebDelegation } | { ok: false; response: HandlerResponseWithHeaders }> {
  const now = nowOf(deps);
  const refuse = (status: number, code: string) => ({ ok: false as const, response: voiciRefusal(status, code) });
  if (typeof o.sig !== "string") return refuse(400, "malformed");
  const d = parseWebDelegation(o.cred.delegation);
  if (!d || typeof o.cred.delegationSig !== "string") return refuse(400, "malformed");
  if (Math.abs(now - o.issuedAt) > VOICI_SEND_SKEW_MS) return refuse(403, "stale");
  await warmCred(o.cred);
  let notAfter: number | undefined;
  if (deps.caKeys) {
    const att = checkMessagesKeyAttestation(o.cred.attestation, { caKeys: deps.caKeys(now), now, pseudonymPub: d.principalPub });
    if (!att.ok) return refuse(403, "bad-attestation");
    notAfter = att.attestation.expiresAt;
  }
  const del = checkWebDelegation(d, o.cred.delegationSig, {
    scope: "voici-messages",
    origin: deps.origin,
    audience: d.audience,
    principalPub: d.principalPub,
    now,
    ...(notAfter !== undefined ? { notAfter } : {}),
  });
  if (!del.ok) return refuse(403, "bad-delegation");
  if (!/^[0-9a-f]{32}$/.test(d.audience) || o.conv !== voiciConv(d.audience, d.principalPub)) return refuse(403, "wrong-conv");
  if (!(await p256VerifyFast(o.sig, o.bytes(), d.delegatePub))) return refuse(403, "bad-signature");
  return { ok: true, delegation: d };
}

/**
 * Body {conv, since, issuedAt, sig, cred} (also {fetch:{conv, since, issuedAt}, signature, cred}): the browser key B
 * signs the fetch (`authorizeBrowserKey`). Answer {items:[{id, envelope, storedAt, fetchedAt, direct}], next, more}:
 * `next` is the cursor for the following call.
 */
export async function handleVoiciThread(deps: VoiciThreadDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const b = (body ?? {}) as Record<string, unknown>;
  const f = (b.fetch && typeof b.fetch === "object" ? b.fetch : b) as { conv?: unknown; since?: unknown; issuedAt?: unknown };
  const sig = b.fetch ? b.signature : b.sig;
  const cred = b.cred as Record<string, unknown> | undefined;
  if (
    !isLowerHex(f.conv, 32) ||
    typeof f.since !== "string" ||
    !CURSOR.test(f.since) ||
    typeof f.issuedAt !== "number" ||
    typeof sig !== "string" ||
    !cred ||
    typeof cred !== "object"
  ) {
    return voiciRefusal(400, "malformed");
  }
  const since = cursorId(f.since);
  if (since < 0) return voiciRefusal(400, "malformed");
  const fetch = { conv: f.conv, since: f.since, issuedAt: f.issuedAt };
  const auth = await authorizeBrowserKey(deps, { conv: f.conv, issuedAt: f.issuedAt, sig, cred, bytes: () => canonicalVoiciThreadFetch(fetch) });
  if (!auth.ok) return auth.response;
  const [revoked, rows] = await Promise.all([deps.voici.isRevoked(auth.delegation.delegatePub, nowOf(deps)), deps.voici.listThread(f.conv, since, VOICI_FETCH_LIMIT + 1)]);
  if (revoked) return voiciRefusal(403, "revoked");
  const page = rows.slice(0, VOICI_FETCH_LIMIT);
  return okNoStore({
    items: page.map(wireMessage),
    next: page.length ? String(page[page.length - 1]!.id) : f.since,
    more: rows.length > VOICI_FETCH_LIMIT,
  });
}

// ── revoke a browser key (§6.4) ─────────────────────────────────────────────

/**
 * Body {revoke:{delegatePub, issuedAt}, signature} with either {delegation, delegationSig} (the delegation proves
 * which pseudonym the browser key belongs to) or {principalPub} (then a stored message of that pseudonym signed with
 * that key does, or nothing ties the key to a page and it is refused page-less). Only that pseudonym may sign it out.
 * Kept until the delegation's expiry (30 days when `.com` never saw the delegation).
 */
export async function handleVoiciRevoke(deps: VoiciThreadDeps, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { revoke?: unknown; signature?: unknown; delegation?: unknown; delegationSig?: unknown; principalPub?: unknown };
  const r = parseWebDelegationRevoke(b?.revoke);
  if (!r || typeof b.signature !== "string") return voiciRefusal(400, "malformed");
  if (Math.abs(now - r.issuedAt) > VOICI_SEND_SKEW_MS) return voiciRefusal(403, "stale");
  let principalPub: string;
  let pageId = "";
  let expiresAt = now + 30 * DAY;
  if (b.delegation !== undefined) {
    const d = parseWebDelegation(b.delegation);
    if (!d || typeof b.delegationSig !== "string" || d.delegatePub !== r.delegatePub || !/^[0-9a-f]{32}$/.test(d.audience)) return voiciRefusal(400, "malformed");
    if (!ed25519VerifyHex(b.delegationSig, canonicalWebDelegation(d), d.principalPub)) return voiciRefusal(403, "bad-delegation");
    principalPub = d.principalPub;
    pageId = d.audience;
    expiresAt = d.expiresAt;
  } else {
    if (!isLowerHex(b.principalPub, 32)) return voiciRefusal(400, "malformed");
    principalPub = b.principalPub;
  }
  if (!verifyWebDelegationRevoke(r, b.signature, principalPub)) return voiciRefusal(403, "bad-signature");
  if (!pageId) pageId = (await deps.voici.delegatePage(principalPub, r.delegatePub)) ?? "";
  await Promise.all([
    expiresAt > now ? deps.voici.revokeDelegate({ delegatePub: r.delegatePub, pageId, principalPub, expiresAt, revokedAt: now }) : null,
    // Only a key proven to be this pseudonym's (its delegation, or a stored message) takes its reply alerts with it.
    pageId ? deps.voici.deleteAlertsForDelegate(r.delegatePub) : null,
  ]);
  return okNoStore({ ok: true });
}

// ── the owner's side ────────────────────────────────────────────────────────

export interface VoiciOwnerDeps {
  voici: VoiciStorage;
  readTokens: AccountReadTokenDeps;
  directory: Pick<AccountDirectoryDeps, "identities" | "nonces" | "now" | "freshnessMs">;
  now?: () => number;
}

/** The owner's conversations since a cursor, the page's blocks and its signed-out browser keys; marks what it returns delivered. */
export async function handleVoiciInbox(deps: VoiciOwnerDeps, username: string, since: string, authorization: string | null): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  const read = await requireAccountRead(deps.readTokens, u, authorization, ACCOUNT_KEY_HOLDERS_ONLY);
  if (!read.ok) return read.response;
  if (!CURSOR.test(since) || cursorId(since) < 0) return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(u);
  if (!page) return voiciRefusal(404, "not-found");
  const after = cursorId(since);
  const [rows, blocks, revoked] = await Promise.all([
    deps.voici.listInbox(page.pageId, after, VOICI_FETCH_LIMIT + 1),
    deps.voici.listBlocked(page.pageId),
    deps.voici.listRevoked(page.pageId, now),
  ]);
  const out = rows.slice(0, VOICI_FETCH_LIMIT);
  if (out.length) await deps.voici.markFetched(page.pageId, after, out[out.length - 1]!.id, now);
  return {
    status: 200,
    body: {
      pageId: page.pageId,
      items: out.map(wireMessage),
      cursor: out.length ? String(out[out.length - 1]!.id) : since,
      more: rows.length > VOICI_FETCH_LIMIT,
      blocks,
      revoked,
    },
    headers: { ...ACCOUNT_READ_HEADERS },
  };
}

/** Body {block:{pageId, pseudonymPub, op, issuedAt}, signature}, by the page's current ownerSignPub. `unblock` also accepts. */
export async function handleVoiciBlock(deps: Pick<VoiciOwnerDeps, "voici" | "now">, username: string, body: unknown): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const b = body as { block?: unknown; signature?: unknown };
  const order = parseVoiciBlock(b?.block);
  if (!order || typeof b.signature !== "string") return voiciRefusal(400, "malformed");
  const page = await deps.voici.getPage(username.toLowerCase());
  if (!page || page.pageId !== order.pageId) return voiciRefusal(404, "not-found");
  if (Math.abs(now - order.issuedAt) > VOICI_SEND_SKEW_MS) return voiciRefusal(403, "stale");
  if (!verifyVoiciBlock(order, b.signature, page.ownerSignPub)) return voiciRefusal(403, "bad-signature");
  await deps.voici.setBlock({ ...order, signature: b.signature }, now);
  return okNoStore({ ok: true });
}

export async function handleMessagesStateGet(deps: VoiciOwnerDeps, username: string, authorization: string | null): Promise<HandlerResponseWithHeaders> {
  const u = username.toLowerCase();
  const read = await requireAccountRead(deps.readTokens, u, authorization, ACCOUNT_KEY_HOLDERS_ONLY);
  if (!read.ok) return read.response;
  const s = await deps.voici.getState(u);
  if (!s) return { ...voiciRefusal(404, "not-found"), headers: { ...ACCOUNT_READ_HEADERS } };
  return { status: 200, body: JSON.parse(s.blob) as unknown, headers: { ...ACCOUNT_READ_HEADERS } };
}

/** Body {version, nonce, ct} (or {state:{...}}): `version` = stored + 1, else 409 `version-conflict` with the stored blob. */
export async function handleMessagesStatePut(
  deps: VoiciOwnerDeps,
  username: string,
  auth: DirectoryAuthorization | undefined,
  bodyText: string,
): Promise<HandlerResponseWithHeaders> {
  const now = nowOf(deps);
  const u = username.toLowerCase();
  if (bodyText.length > Math.ceil(((VOICI_STATE_MAX_BYTES + 16) * 4) / 3) + 256) return voiciRefusal(413, "too-large");
  const caller = await authorizeActiveDevice(deps.directory, auth, { accountId: u, method: "PUT", path: `/api/accounts/${u}/messages-state` });
  if (!caller) return voiciRefusal(403, "forbidden");
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return voiciRefusal(400, "malformed");
  }
  const s = (raw && typeof raw === "object" && "state" in raw ? (raw as { state: unknown }).state : raw) as Record<string, unknown> | undefined;
  if (
    !s ||
    typeof s !== "object" ||
    !exactKeys(s, ["version", "nonce", "ct"]) ||
    typeof s.version !== "number" ||
    !Number.isSafeInteger(s.version) ||
    s.version < 1 ||
    !isLowerHex(s.nonce, 12) ||
    !b64Decode(s.ct)
  ) {
    return voiciRefusal(400, "malformed");
  }
  const blob = canonicalJson({ version: s.version, nonce: s.nonce, ct: s.ct });
  if (!(await deps.voici.putState(u, s.version, blob, now))) {
    const cur = await deps.voici.getState(u);
    return voiciRefusal(409, "version-conflict", { state: cur ? JSON.parse(cur.blob) : null });
  }
  return okNoStore({ ok: true, version: s.version });
}

// ── upkeep (cron) ───────────────────────────────────────────────────────────

/** Rows of each kind one pass removes. */
export const VOICI_GC_ROWS_PER_RUN = 1000;

/**
 * One budgeted pass, one D1 round trip: pieces no index has listed for 30 days (the rows, then their R2 objects in one
 * call), mailbox rows past 180 days, drafts past 30 days, revoked browser keys past their delegation's expiry.
 */
export async function runVoiciGc(deps: { voici: VoiciStorage; bucket?: VoiciBucket }, now: number) {
  const out = await deps.voici.collect({
    piecesBefore: deps.bucket ? now - VOICI_UNREFERENCED_TTL_MS : 0,
    messagesBefore: now - VOICI_MESSAGE_TTL_MS,
    draftsBefore: now - VOICI_DRAFT_TTL_MS,
    now,
    limit: VOICI_GC_ROWS_PER_RUN,
  });
  if (out.pieces.length && deps.bucket) await deps.bucket.delete(out.pieces.map((p) => voiciPieceKey(p.pageId, p.sha256)));
  return { pieces: out.pieces.length, messages: out.messages, drafts: out.drafts, revoked: out.revoked, alerts: out.alerts };
}

