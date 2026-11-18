/**
 * voi.ci calls on the Worker (docs/voici-calls.md §6; handlers in packages/control-plane/src/voiciCalls.ts, the room
 * in voiciCallRoom.ts). Off (404) until `VOICI_CALLS = "on"` and the `VOICI_CALL_ROOM` binding exist, besides
 * `VOICI_ENABLED`.
 *
 *   POST /api/voici/calls                          the caller's signed request (CORS: the voi.ci origin)
 *   GET  /api/voici/calls/<callId>/caller?t=       the caller's room WebSocket (Origin: the voi.ci origin)
 *   GET  /api/voici/calls/<callId>/device          a ringing admin device's room WebSocket (device headers, or a locked
 *                                                  device's join signed by its bound call key: x-flagship-call-key-*).
 *                                                  The URL names only the call: the account is the live call's own
 *                                                  (privacy policy §2.12), and a `u` an older app still sends is ignored.
 *   POST /api/voici/rings/<ringId>                 the owner rings a caller back {ring, signature}: the account is
 *                                                  the page's (ring.pageId), never one the URL names (§2.12)
 *   POST /api/voici/web/ring-back                  the caller attaches or stops a conversation's ring-back channel;
 *                                                  from the caller's app the account is the one its signing device
 *                                                  belongs to (device headers), never one the URL names
 *   POST /api/voici/pages/<u>/ring                 older apps' form of /rings/<ringId> (same body, same checks)
 *   POST /api/voici/web/ring-back?u=<u>            older apps' form of the app's ring-back (same headers)
 *   POST /api/voici/pages/<u>/call-allow           the owner's call-allow order
 *   GET  /api/voici/pages/<u>/calls?since=         sealed missed calls (read token)
 *   POST /api/accounts/<u>/voici-call-key          an admin device binds its call-only key (device headers)
 *   POST /api/accounts/<u>/voici-call-key/revoke   a signed revocation (owner messages key or the call key)
 *   POST /api/accounts/<u>/voici-voip-token        an iPhone's / iPad's PushKit token (device headers)
 */
import {
  authorizeVoiciCallDevice,
  buildVoiciCallRinger,
  buildVoipPushSender,
  handleVoiciCallAllow,
  handleVoiciCallChallenge,
  handleVoiciCallRequest,
  handleVoiciRing,
  handleVoiciRingBack,
  handleVoiciAnonBlock,
  buildVoiciRingPusher,
  authorizeActiveDevice,
  voiciPowSecret,
  handleVoiciMissedCalls,
  handleVoiciVoipToken,
  voiciRefusal,
  type HandlerResponseWithHeaders,
  authorizeVoiciCallKeyDevice,
  handleVoiciCallKey,
  handleVoiciCallKeyRevoke,
  type VoiciCallKeyJoinAuth,
} from "@flagship/control-plane";
import { D1NonceStore } from "@flagship/boot-core";
import { D1Storage, RequestD1, type D1Database } from "@flagship/storage";
import { buildOptionalPushForwarder, type ControlPlaneEnv } from "./controlPlaneRoutes.js";
import { checkRateLimit, clientIp, type RateLimitEndpoint, type RateLimitEnv, type WaitUntilLike } from "./rateLimit.js";

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string | Request, init?: RequestInit): Promise<Response> };
}

export interface VoiciCallEnv extends RateLimitEnv {
  DB?: D1Database;
  VOICI_ENABLED?: string;
  VOICI_CALLS?: string;
  VOICI_CALL_ROOM?: DurableObjectNamespaceLike;
  VOICI_WEB_ORIGIN?: string;
  CONTROL_APEX?: string;
  ACCOUNT_READ_TOKEN_SECRET?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_PRIVATE_KEY_PEM?: string;
  APNS_BUNDLE_ID?: string;
  APNS_HOST?: string;
  /** 32 bytes hex: `.com`'s proof-of-work MAC key for anonymous calls (pages in "anyone" mode); unset = refused. */
  VOICI_CALL_POW_SECRET?: string;
}

const CALL_PATH = /^\/api\/voici\/calls\/([0-9a-f]{32})\/(caller|device)$/;
const PAGE_CALLS = /^\/api\/voici\/pages\/([^/]+)\/(call-allow|calls|call-challenge|ring|anon-block)$/;
const RING_BACK = "/api/voici/web/ring-back";
const RING = /^\/api\/voici\/rings\/([0-9a-f]{32})$/;
const VOIP_TOKEN = /^\/api\/accounts\/([^/]+)\/voici-voip-token$/;
const CALL_KEY = /^\/api\/accounts\/([^/]+)\/voici-call-key(\/revoke)?$/;

export const voiciCallsEnabled = (env: VoiciCallEnv) => env.VOICI_ENABLED === "on" && env.VOICI_CALLS === "on" && !!env.VOICI_CALL_ROOM && !!env.DB;

export function isVoiciCallPath(pathname: string): boolean {
  return pathname === "/api/voici/calls" || pathname === RING_BACK || RING.test(pathname) || CALL_PATH.test(pathname) || PAGE_CALLS.test(pathname) || VOIP_TOKEN.test(pathname) || CALL_KEY.test(pathname);
}

function toResponse(r: HandlerResponseWithHeaders): Response {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
}

async function wait(env: VoiciCallEnv, endpoint: RateLimitEndpoint, request: Request, subject: string | undefined, ctx?: WaitUntilLike) {
  const rl = await checkRateLimit(env, { endpoint, ip: clientIp(request), ...(subject ? { subject } : {}) }, ctx);
  return rl.limited ? rl.retryAfterSec : null;
}

function deviceAuth(request: Request, accountId: string, path: string) {
  const deviceId = request.headers.get("x-flagship-device-id");
  const signerPubHex = request.headers.get("x-flagship-device-pub");
  const requestId = request.headers.get("x-flagship-request-id");
  const issuedAt = Number(request.headers.get("x-flagship-issued-at"));
  const signature = request.headers.get("x-flagship-signature");
  if (!deviceId || !signerPubHex || !requestId || !Number.isFinite(issuedAt) || !signature) return undefined;
  return {
    request: { accountId: accountId.toLowerCase(), deviceId: deviceId.toLowerCase(), signerPubHex: signerPubHex.toLowerCase(), method: request.method.toUpperCase(), path, requestId, issuedAt },
    signature,
  };
}

/** A locked device's room join, signed by its bound call key (flagship/voici-call-join/v1). */
function callKeyJoin(request: Request): VoiciCallKeyJoinAuth | undefined {
  const deviceId = request.headers.get("x-flagship-call-key-device");
  const callKeyPub = request.headers.get("x-flagship-call-key-pub");
  const issuedAt = Number(request.headers.get("x-flagship-call-key-at"));
  const signature = request.headers.get("x-flagship-call-key-sig");
  if (!deviceId || !callKeyPub || !Number.isSafeInteger(issuedAt) || !signature) return undefined;
  return { deviceId, callKeyPub, issuedAt, signature };
}

async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

function voipSender(env: VoiciCallEnv) {
  if (!env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_PRIVATE_KEY_PEM || !env.APNS_BUNDLE_ID) return undefined;
  return buildVoipPushSender({
    apns: { keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, privateKeyPem: env.APNS_PRIVATE_KEY_PEM, bundleId: env.APNS_BUNDLE_ID, ...(env.APNS_HOST ? { host: env.APNS_HOST } : {}) },
  });
}

/**
 * Every call route. `caKeys` is the voi.ci routes' CA-key list (the maintainer chain's, plus `.com`'s own).
 */
export async function handleVoiciCallApi(request: Request, env: VoiciCallEnv, caKeys: (now: number) => string[], isPseudonymBanned: (p: string) => Promise<boolean>, ctx?: WaitUntilLike): Promise<Response> {
  if (!voiciCallsEnabled(env)) return toResponse(voiciRefusal(404, "not-found"));
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const storage = new D1Storage(new RequestD1(env.DB!));
  const nonces = new D1NonceStore(env.DB!);
  const directory = { identities: storage.deviceIdentities, nonces };
  const apex = env.CONTROL_APEX ?? "flagshipserver.com";
  const origin = env.VOICI_WEB_ORIGIN ?? "https://voi.ci";
  const room = (callId: string) => env.VOICI_CALL_ROOM!.get(env.VOICI_CALL_ROOM!.idFromName(callId));
  const powSecret = voiciPowSecret(env.VOICI_CALL_POW_SECRET);
  let m: RegExpMatchArray | null;

  if (path === RING_BACK && method === "POST") {
    const w = await wait(env, "voici-ring-back", request, undefined, ctx);
    if (w !== null) return toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec: w }));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    // From the caller's app, device headers name the account whose devices the ring push reaches; a browser's order
    // names none. Said to the caller in the pop-up: Flagship knows this conversation can ring them. The account is the
    // one the signing device belongs to (its active grant); an older app also sends it as ?u=<username>.
    let account: string | null = null;
    const legacyU = (url.searchParams.get("u") ?? "").toLowerCase();
    const devicePub = (request.headers.get("x-flagship-device-pub") ?? "").toLowerCase();
    const u = legacyU || (/^[0-9a-f]{64}$/.test(devicePub) ? ((await storage.deviceCapabilityGrants.getByDevicePub(devicePub))?.username.toLowerCase() ?? "") : "");
    if (legacyU || request.headers.has("x-flagship-device-id")) {
      const dev = u ? await authorizeActiveDevice(directory, deviceAuth(request, u, path), { accountId: u, method: "POST", path }) : null;
      if (!dev) return toResponse(voiciRefusal(403, "forbidden"));
      account = u;
    }
    return toResponse(await handleVoiciRingBack({ voici: storage.voici, calls: storage.voiciCalls, origin, caKeys }, body, account));
  }

  if (path === "/api/voici/calls" && method === "POST") {
    const forward = buildOptionalPushForwarder(env as unknown as ControlPlaneEnv) ?? undefined;
    const voip = voipSender(env);
    const ringer = buildVoiciCallRinger({
      usernames: storage.usernames,
      grants: storage.deviceCapabilityGrants,
      pushTokens: storage.pushTokens,
      calls: storage.voiciCalls,
      ...(forward ? { forward } : {}),
      ...(voip ? { voip } : {}),
      apex,
    });
    return toResponse(
      await handleVoiciCallRequest(
        {
          voici: storage.voici,
          calls: storage.voiciCalls,
          origin,
          caKeys,
          isPseudonymBanned,
          limitIp: () => wait(env, "voici-call", request, undefined, ctx),
          limitCaller: (p) => wait(env, "voici-call-caller", request, p, ctx),
          limitPage: (pageId) => wait(env, "voici-call-page", request, pageId, ctx),
          limitAnonPage: (pageId) => wait(env, "voici-call-anon-page", request, pageId, ctx),
          ...(powSecret ? { powSecret } : {}),
          openRoom: async (init) => (await room(init.callId).fetch("https://room/init", { method: "POST", body: JSON.stringify(init) })).ok,
          ring: ringer.ring,
          apex,
          sha256Hex,
        },
        await request.text(),
      ),
    );
  }

  if ((m = path.match(CALL_PATH)) && method === "GET") {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return toResponse(voiciRefusal(426, "websocket-only"));
    const callId = m[1]!;
    if (m[2] === "caller") {
      if (request.headers.get("origin") !== origin) return toResponse(voiciRefusal(403, "forbidden"));
      const t = url.searchParams.get("t") ?? "";
      return room(callId).fetch(new Request(`https://room/caller?t=${encodeURIComponent(t)}`, request));
    }
    // The account is the one this call rings, never one the URL names; a device of another account fails its
    // signature (the signed bytes name the device's own account).
    const u = await storage.voiciCalls.liveCallAccount(callId, Date.now());
    if (!u) return toResponse(voiciRefusal(403, "forbidden"));
    const join = callKeyJoin(request);
    const dev = join
      ? await authorizeVoiciCallKeyDevice({ voici: storage.voici, calls: storage.voiciCalls, usernames: storage.usernames, grants: storage.deviceCapabilityGrants, nonces }, u, callId, join, (code) =>
          console.log(`voici call join refused: call-key ${code}`),
        )
      : await authorizeVoiciCallDevice({ usernames: storage.usernames, grants: storage.deviceCapabilityGrants, directory }, u, callId, deviceAuth(request, u, path), (code) =>
          console.log(`voici call join refused: device-key ${code}`),
        );
    if (!dev) return toResponse(voiciRefusal(403, "forbidden"));
    const headers = new Headers(request.headers);
    headers.delete("x-voici-call-key-pub");
    headers.set("x-voici-device-ref", dev.deviceRef);
    if ("callKeyPub" in dev) headers.set("x-voici-call-key-pub", dev.callKeyPub);
    return room(callId).fetch(new Request("https://room/device", { method: "GET", headers }));
  }

  if ((m = path.match(PAGE_CALLS)) && m[2] === "call-challenge" && method === "GET") {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    return toResponse(await handleVoiciCallChallenge({ voici: storage.voici, ...(powSecret ? { powSecret } : {}), limitIp: () => wait(env, "voici-call-challenge", request, undefined, ctx) }, username));
  }

  if ((m = path.match(PAGE_CALLS)) && m[2] === "anon-block" && method === "POST") {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    const w = await wait(env, "voici-owner", request, undefined, ctx);
    if (w !== null) return toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec: w }));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return toResponse(await handleVoiciAnonBlock({ voici: storage.voici, calls: storage.voiciCalls }, username, body));
  }

  // The owner's ring: /rings/<ringId> names only the ring, and `.com` takes the account from the page the signed ring
  // names; /pages/<u>/ring is the older apps' form.
  const ringPath = method === "POST" ? path.match(RING) : null;
  const legacyRing = method === "POST" && (m = path.match(PAGE_CALLS)) && m[2] === "ring" ? decodeURIComponent(m[1]!).toLowerCase() : null;
  if (ringPath || legacyRing !== null) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    const b = body && typeof body === "object" ? (body as { ring?: { pageId?: unknown; ringId?: unknown } }) : {};
    let username = legacyRing ?? "";
    if (ringPath) {
      if (b.ring?.ringId !== ringPath[1] || typeof b.ring?.pageId !== "string") return toResponse(voiciRefusal(400, "malformed"));
      username = (await storage.voici.getPageById(b.ring.pageId))?.username.toLowerCase() ?? "";
      if (!username) return toResponse(voiciRefusal(404, "not-found"));
    }
    const w = await wait(env, "voici-ring", request, username, ctx);
    if (w !== null) return toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec: w }));
    const forward = buildOptionalPushForwarder(env as unknown as ControlPlaneEnv) ?? undefined;
    const voip = voipSender(env);
    const pushRing = buildVoiciRingPusher({ pushTokens: storage.pushTokens, calls: storage.voiciCalls, ...(forward ? { forward } : {}), ...(voip ? { voip } : {}), apex });
    return toResponse(await handleVoiciRing({ voici: storage.voici, calls: storage.voiciCalls, pushRing }, username, body));
  }

  if ((m = path.match(PAGE_CALLS))) {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    const w = await wait(env, "voici-owner", request, undefined, ctx);
    if (w !== null) return toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec: w }));
    if (m[2] === "call-allow" && method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = undefined;
      }
      return toResponse(await handleVoiciCallAllow({ voici: storage.voici, calls: storage.voiciCalls }, username, body));
    }
    if (m[2] === "calls" && method === "GET") {
      const readTokens = {
        secret: env.ACCOUNT_READ_TOKEN_SECRET,
        usernames: storage.usernames,
        identities: storage.deviceIdentities,
        servers: storage.servers,
        demoUsers: storage.demoUsers,
        nonces,
      };
      return toResponse(await handleVoiciMissedCalls({ voici: storage.voici, calls: storage.voiciCalls, readTokens }, username, url.searchParams.get("since") ?? "", request.headers.get("authorization")));
    }
  }

  if ((m = path.match(VOIP_TOKEN)) && method === "POST") {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    const w = await wait(env, "voici-owner", request, undefined, ctx);
    if (w !== null) return toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec: w }));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return toResponse(await handleVoiciVoipToken({ calls: storage.voiciCalls, directory }, username, deviceAuth(request, username, path), body));
  }

  if ((m = path.match(CALL_KEY)) && method === "POST") {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    const w = await wait(env, "voici-owner", request, undefined, ctx);
    if (w !== null) return toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec: w }));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    if (m[2]) return toResponse(await handleVoiciCallKeyRevoke({ voici: storage.voici, calls: storage.voiciCalls }, username, body));
    return toResponse(
      await handleVoiciCallKey(
        { voici: storage.voici, calls: storage.voiciCalls, usernames: storage.usernames, grants: storage.deviceCapabilityGrants, directory },
        username,
        deviceAuth(request, username, path),
        body,
      ),
    );
  }

  return toResponse(voiciRefusal(404, "not-found"));
}
