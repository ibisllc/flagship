/**
 * voi.ci pages and Messages on the Worker (docs/voici-and-messages.md §3, §4, §8.3; handlers in
 * packages/control-plane/src/voiciPages.ts and voiciMailbox.ts, storage in packages/storage/src/voici.ts).
 *
 * Everything here answers 404 until `VOICI_ENABLED = "on"` (deploy order: migration 0123, `.com`, the store builds,
 * then the switch). Chunk B2's routes (attestations, reports, bans, takedowns) are voiciAbuseRoutes.ts, dispatched
 * just before these; its ban checks and account cleanup (voiciAbuse.ts) are called from here.
 *
 * Reply alerts (§8.3 "Alerts:", voiciAlerts.ts): `GET /api/voici/web/alert-key`, `POST /api/voici/web/alerts`, and a
 * content-free Web Push after an owner's reply is stored, sent after the answer (waitUntil) with the webapp's VAPID keys.
 *
 * CORS: exactly the voi.ci origin (`VOICI_WEB_ORIGIN`, gym "https://gym.voi.ci"), no credentials, on
 * `GET /api/username/<u>`, `GET /api/voici/pages/<u>`, `/api/voici/web/*` and `POST /api/voici/reports` (§4.4). The `/qr-pipe` upgrade is a
 * WebSocket and needs none.
 */
import {
  buildVoiciPush,
  buildWebPushSender,
  caKeypairFromEnv,
  handleMessagesStateGet,
  handleMessagesStatePut,
  handleVoiciAlerts,
  handleVoiciBlock,
  handleVoiciDraftConsume,
  handleVoiciDraftDeposit,
  handleVoiciDraftList,
  handleVoiciGetPage,
  handleVoiciInbox,
  handleVoiciPieceUpload,
  handleVoiciPublish,
  handleVoiciRemove,
  handleVoiciRevoke,
  handleVoiciSend,
  handleVoiciThread,
  resolveVoiciPath,
  appHome,
  runVoiciGc,
  sendVoiciReplyAlerts,
  voiciIndexKey,
  voiciListedPiece,
  voiciPieceKey,
  voiciRefusal,
  VOICI_PIECE_CACHE,
  type HandlerResponseWithHeaders,
  type VoiciBucket,
} from "@flagship/control-plane";
import { D1NonceStore } from "@flagship/boot-core";
import { D1Storage, RequestD1, type D1Database, type NameRegistryStorage } from "@flagship/storage";
import { workerCaTrustChain } from "./caTrustChainLoader.js";
import { buildOptionalPushForwarder, type ControlPlaneEnv } from "./controlPlaneRoutes.js";
import { checkRateLimit, clientIp, type RateLimitEndpoint, type RateLimitEnv, type WaitUntilLike } from "./rateLimit.js";
import { voiciErrorResponse, voiciShellResponse, voiciSiteFile } from "./voiciSite.js";
import { deriveUrlFragment } from "@flagship/protocol";
import { deleteVoiciAbuseAccount, isAccountBanned, isPseudonymBanned, pruneVoiciAbuse } from "./voiciAbuse.js";

export interface VoiciEnv extends RateLimitEnv {
  DB?: D1Database;
  /** R2 `flagship-voici` (gym `flagship-voici-gym`), served on files.voi.ci. */
  VOICI?: VoiciBucket;
  /** "on" turns the routes and the page shells on. */
  VOICI_ENABLED?: string;
  /** "https://voi.ci"; the gym sets "https://gym.voi.ci". */
  VOICI_WEB_ORIGIN?: string;
  /** files.voi.ci (gym files.gym.voi.ci) and its zone, for purging after a deletion (with CLOUDFLARE_PURGE_TOKEN). */
  VOICI_FILES_HOST?: string;
  VOICI_FILES_ZONE_ID?: string;
  CLOUDFLARE_PURGE_TOKEN?: string;
  CONTROL_APEX?: string;
  SERVICES_APEX?: string;
  /** "1": a link or code goes to its app's canonical address, worked out on each visit (docs/named-links.md §2.3). */
  VOICI_CANONICAL?: string;
  ACCOUNT_READ_TOKEN_SECRET?: string;
  FLAGSHIP_CA_PRIV_HEX?: string;
  /** The webapp's Web Push (VAPID) keys, reused for voi.ci reply alerts (pushBridge.ts). */
  WEBPUSH_VAPID_PRIVATE_KEY_PEM?: string;
  WEBPUSH_VAPID_PUBLIC_KEY_B64URL?: string;
  WEBPUSH_CONTACT?: string;
  ASSETS?: { fetch(req: Request): Promise<Response> };
}

export const voiciEnabled = (env: { VOICI_ENABLED?: string }) => env.VOICI_ENABLED === "on";
export const voiciWebOrigin = (env: { VOICI_WEB_ORIGIN?: string }) => env.VOICI_WEB_ORIGIN ?? "https://voi.ci";
const webHost = (env: VoiciEnv) => new URL(voiciWebOrigin(env)).hostname;
/** files.voi.ci (gym files.gym.voi.ci). */
export const voiciFilesOrigin = (env: VoiciEnv) => `https://${env.VOICI_FILES_HOST ?? `files.${webHost(env)}`}`;

/** Hosts that serve voi.ci: links, codes and pages. */
export function isVoiciHost(hostname: string, env: VoiciEnv): boolean {
  return hostname === "voi.ci" || hostname === "www.voi.ci" || hostname === webHost(env);
}

const ACCOUNT_VOICI = /^\/api\/accounts\/([^/]+)\/(voici-drafts|voici-drafts\/consume|messages-state)$/;
const PAGE_ROUTE = /^\/api\/voici\/pages\/([^/]+)(?:\/(pieces|publish|remove|inbox|block)(?:\/([0-9a-f]{64}))?)?$/;

/** The paths this file owns. */
export function isVoiciApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/voici/") || ACCOUNT_VOICI.test(pathname);
}

/** Paths the voi.ci site may call cross-origin (§4.4). */
export function isVoiciCorsPath(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" && /^\/api\/username\/[^/]+$/.test(pathname)) return true;
  if (m === "GET" && /^\/api\/voici\/pages\/[^/]+$/.test(pathname)) return true;
  if (m === "POST" && pathname === "/api/voici/reports") return true;
  return (m === "GET" || m === "POST") && pathname.startsWith("/api/voici/web/");
}

/**
 * CORS headers for a request from the voi.ci origin to a path it may call, or null (then no CORS headers at all).
 * A preflight must ask for GET or POST and at most the `content-type` header.
 */
export function voiciCorsHeaders(request: Request, url: URL, env: VoiciEnv): Headers | null {
  if (!voiciEnabled(env)) return null;
  const origin = request.headers.get("origin");
  if (!origin || origin !== voiciWebOrigin(env)) return null;
  const preflight = request.method.toUpperCase() === "OPTIONS";
  const method = preflight ? (request.headers.get("access-control-request-method") ?? "") : request.method;
  if (!isVoiciCorsPath(method, url.pathname)) return null;
  if (preflight) {
    const asked = (request.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").map((h) => h.trim()).filter(Boolean);
    if (asked.some((h) => h !== "content-type")) return null;
  }
  const h = new Headers({ "access-control-allow-origin": origin, vary: "origin" });
  if (preflight) {
    h.set("access-control-allow-methods", "GET, POST");
    h.set("access-control-allow-headers", "content-type");
    h.set("access-control-max-age", "600");
  }
  return h;
}

// ── dispatch ────────────────────────────────────────────────────────────────

function toResponse(r: HandlerResponseWithHeaders): Response {
  const headers = new Headers({ "content-type": "application/json", ...(r.headers ?? {}) });
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}

const notFound = () => toResponse(voiciRefusal(404, "not-found"));

async function limited(env: VoiciEnv, endpoint: RateLimitEndpoint, request: Request, subject: string | undefined, ctx?: WaitUntilLike): Promise<number | null> {
  const rl = await checkRateLimit(env, { endpoint, ip: clientIp(request), ...(subject ? { subject } : {}) }, ctx);
  return rl.limited ? rl.retryAfterSec : null;
}

const tooMany = (retryAfterSec: number) => {
  const r = toResponse(voiciRefusal(429, "rate-limited", { retryAfterSec }));
  r.headers.set("retry-after", String(retryAfterSec));
  return r;
};

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The CA keys an attestation may be signed by: the maintainer chain's at `now`, and `.com`'s own when it holds one. */
const chain = workerCaTrustChain();
let caCache: { at: number; priv: string | undefined; keys: string[] } | null = null;
function caKeys(env: VoiciEnv, now: number): string[] {
  if (caCache && caCache.priv === env.FLAGSHIP_CA_PRIV_HEX && now - caCache.at < 60_000) return caCache.keys;
  const keys = new Set<string>();
  try {
    for (const k of chain.authorizedCaKeys(now)) keys.add(k.toLowerCase());
  } catch {
    /* no live lease: only .com's own key */
  }
  if (env.FLAGSHIP_CA_PRIV_HEX && /^[0-9a-f]{64}$/i.test(env.FLAGSHIP_CA_PRIV_HEX)) {
    keys.add(hexOf(caKeypairFromEnv({ FLAGSHIP_CA_PRIV_HEX: env.FLAGSHIP_CA_PRIV_HEX }).keypair.publicKey));
  }
  caCache = { at: now, priv: env.FLAGSHIP_CA_PRIV_HEX, keys: [...keys] };
  return caCache.keys;
}

function directoryAuth(request: Request, accountId: string, path: string) {
  const deviceId = request.headers.get("x-flagship-device-id");
  const signerPubHex = request.headers.get("x-flagship-device-pub");
  const requestId = request.headers.get("x-flagship-request-id");
  const issuedAt = Number(request.headers.get("x-flagship-issued-at"));
  const signature = request.headers.get("x-flagship-signature");
  if (!deviceId || !signerPubHex || !requestId || !Number.isFinite(issuedAt) || !signature) return undefined;
  return {
    request: {
      accountId: accountId.toLowerCase(),
      deviceId: deviceId.toLowerCase(),
      signerPubHex: signerPubHex.toLowerCase(),
      method: request.method.toUpperCase(),
      path,
      requestId,
      issuedAt,
    },
    signature,
  };
}


/** Every `/api/voici/*`, `/api/admin/voici/*` and the account voi.ci lanes. */
export async function handleVoiciApi(request: Request, env: VoiciEnv, ctx?: WaitUntilLike): Promise<Response> {
  if (!voiciEnabled(env) || !env.DB) return notFound();
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const db = new RequestD1(env.DB);
  const storage = new D1Storage(db);
  const now = Date.now();
  let m: RegExpMatchArray | null;

  if (path.startsWith("/api/voici/web/")) {
    if (path === "/api/voici/web/alert-key" && method === "GET") {
      const key = env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL;
      if (!key || !webPushSender(env)) return toResponse(voiciRefusal(503, "unavailable"));
      return new Response(JSON.stringify({ key }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } });
    }
    if (method !== "POST") return notFound();
    const origin = voiciWebOrigin(env);
    if (path === "/api/voici/web/send") {
      const forwarder = buildOptionalPushForwarder(env as unknown as ControlPlaneEnv);
      const sender = webPushSender(env);
      const text = await request.text();
      return toResponse(
        await handleVoiciSend(
          {
            voici: storage.voici,
            origin,
            caKeys: (t) => caKeys(env, t),
            limitSend: () => limited(env, "voici-send", request, undefined, ctx),
            limitNewConversation: (pageId) => limited(env, "voici-new-conversation", request, pageId, ctx),
            isPseudonymBanned: (p) => isPseudonymBanned(db, p),
            ...(sender
              ? {
                  replyStored: (username: string, conv: string) => {
                    const job = sendVoiciReplyAlerts({ voici: storage.voici, send: sender }, username, conv).catch(() => undefined);
                    if (ctx) ctx.waitUntil(job);
                    else return job;
                  },
                }
              : {}),
            ...(forwarder
              ? {
                  push: buildVoiciPush({
                    usernames: storage.usernames,
                    grants: storage.deviceCapabilityGrants,
                    pushTokens: storage.pushTokens,
                    forward: forwarder,
                    ...(env.CONTROL_APEX ? { apex: env.CONTROL_APEX } : {}),
                  }),
                }
              : {}),
          },
          text,
        ),
      );
    }
    if (path === "/api/voici/web/alerts") {
      const wait = await limited(env, "voici-thread", request, undefined, ctx);
      if (wait !== null) return tooMany(wait);
      if (!webPushSender(env)) return toResponse(voiciRefusal(503, "unavailable"));
      return toResponse(
        await handleVoiciAlerts({ voici: storage.voici, origin, caKeys: (t: number) => caKeys(env, t), isPseudonymBanned: (p) => isPseudonymBanned(db, p) }, await readJson(request)),
      );
    }
    if (path === "/api/voici/web/thread" || path === "/api/voici/web/revoke") {
      const wait = await limited(env, path.endsWith("thread") ? "voici-thread" : "voici-owner", request, undefined, ctx);
      if (wait !== null) return tooMany(wait);
      const body = await readJson(request);
      const deps = { voici: storage.voici, origin, caKeys: (t: number) => caKeys(env, t) };
      return toResponse(path.endsWith("thread") ? await handleVoiciThread(deps, body) : await handleVoiciRevoke(deps, body));
    }
  }

  if ((m = path.match(PAGE_ROUTE))) {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    const tail = m[2];
    const piece = m[3];
    const pagesDeps = {
      voici: storage.voici,
      usernames: storage.usernames,
      bucket: env.VOICI ?? noBucket,
      isAccountBanned: (u: string) => isAccountBanned(db, u),
      // The owner's removal keeps the visitors' reply alerts: their conversations stay.
      removePageObjects: (u: string, pageId: string) => removeVoiciPageObjects(env, storage, u, pageId, { keepAlerts: true }),
    };
    if (!tail && method === "GET") {
      const wait = await limited(env, "voici-page-read", request, undefined, ctx);
      if (wait !== null) return tooMany(wait);
      return toResponse(await handleVoiciGetPage(pagesDeps, username));
    }
    if (tail === "pieces" && piece && (method === "GET" || method === "HEAD")) {
      const wait = await limited(env, "voici-page-read", request, undefined, ctx);
      if (wait !== null) return tooMany(wait);
      const got = env.VOICI ? await voiciListedPiece({ voici: storage.voici, bucket: env.VOICI }, username, piece) : null;
      if (!got) return notFound();
      return new Response(method === "HEAD" ? null : got.bytes, {
        headers: { "content-type": got.contentType, "cache-control": VOICI_PIECE_CACHE, "x-content-type-options": "nosniff" },
      });
    }
    if (piece) return notFound();
    if (tail === "pieces" && method === "POST") {
      const wait = await limited(env, "voici-piece", request, username, ctx);
      if (wait !== null) return tooMany(wait);
      if (!env.VOICI) return toResponse(voiciRefusal(503, "unavailable"));
      const body = new Uint8Array(await request.arrayBuffer());
      return toResponse(
        await handleVoiciPieceUpload(
          pagesDeps,
          username,
          {
            pageId: request.headers.get("x-flagship-page-id"),
            issuedAt: request.headers.get("x-flagship-issued-at"),
            signature: request.headers.get("x-flagship-signature"),
            sha256: request.headers.get("x-flagship-sha256"),
            size: request.headers.get("x-flagship-size"),
            signerPub: request.headers.get("x-flagship-signer-pub"),
          },
          body,
        ),
      );
    }
    if (tail === "publish" && method === "POST") {
      const wait = await limited(env, "voici-publish", request, username, ctx);
      if (wait !== null) return tooMany(wait);
      if (!env.VOICI) return toResponse(voiciRefusal(503, "unavailable"));
      return toResponse(await handleVoiciPublish(pagesDeps, username, await request.text()));
    }
    if (tail === "remove" && method === "POST") {
      const wait = await limited(env, "voici-publish", request, username, ctx);
      if (wait !== null) return tooMany(wait);
      if (!env.VOICI) return toResponse(voiciRefusal(503, "unavailable"));
      return toResponse(await handleVoiciRemove(pagesDeps, username, await request.text()));
    }
    if ((tail === "inbox" && method === "GET") || (tail === "block" && method === "POST")) {
      const wait = await limited(env, "voici-owner", request, undefined, ctx);
      if (wait !== null) return tooMany(wait);
      const owner = ownerDeps(env, storage);
      return toResponse(
        tail === "inbox"
          ? await handleVoiciInbox(owner, username, url.searchParams.get("since") ?? "", request.headers.get("authorization"))
          : await handleVoiciBlock(owner, username, await readJson(request)),
      );
    }
  }

  if ((m = path.match(ACCOUNT_VOICI))) {
    const username = decodeURIComponent(m[1]!).toLowerCase();
    const wait = await limited(env, "voici-owner", request, undefined, ctx);
    if (wait !== null) return tooMany(wait);
    const owner = ownerDeps(env, storage);
    if (m[2] === "messages-state") {
      if (method === "GET") return toResponse(await handleMessagesStateGet(owner, username, request.headers.get("authorization")));
      if (method === "PUT") return toResponse(await handleMessagesStatePut(owner, username, directoryAuth(request, username, path), await request.text()));
      return notFound();
    }
    const forwarder = buildOptionalPushForwarder(env as unknown as ControlPlaneEnv);
    const drafts = {
      voici: storage.voici,
      usernames: storage.usernames,
      directory: owner.directory,
      readTokens: owner.readTokens,
      ...(forwarder
        ? {
            notifyAdmins: buildVoiciPush({
              usernames: storage.usernames,
              grants: storage.deviceCapabilityGrants,
              pushTokens: storage.pushTokens,
              forward: forwarder,
              ...(env.CONTROL_APEX ? { apex: env.CONTROL_APEX } : {}),
            }).pageDrafts,
          }
        : {}),
    };
    if (m[2] === "voici-drafts/consume" && method === "POST") return toResponse(await handleVoiciDraftConsume(drafts, username, await readJson(request)));
    if (m[2] === "voici-drafts" && method === "GET") return toResponse(await handleVoiciDraftList(drafts, username, request.headers.get("authorization")));
    if (m[2] === "voici-drafts" && method === "POST") {
      return toResponse(await handleVoiciDraftDeposit(drafts, username, directoryAuth(request, username, path), await request.text()));
    }
    return notFound();
  }

  return notFound();
}

/** The one-subscription Web Push sender, when the Worker holds the VAPID keys (else reply alerts are off). */
function webPushSender(env: VoiciEnv) {
  if (!env.WEBPUSH_VAPID_PRIVATE_KEY_PEM || !env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL || !env.WEBPUSH_CONTACT) return null;
  return buildWebPushSender({
    webpush: { vapidPrivateKeyPem: env.WEBPUSH_VAPID_PRIVATE_KEY_PEM, vapidPublicKeyB64Url: env.WEBPUSH_VAPID_PUBLIC_KEY_B64URL, contact: env.WEBPUSH_CONTACT },
  });
}

function ownerDeps(env: VoiciEnv, storage: D1Storage) {
  const nonces = new D1NonceStore(env.DB!);
  return {
    voici: storage.voici,
    readTokens: {
      secret: env.ACCOUNT_READ_TOKEN_SECRET,
      usernames: storage.usernames,
      identities: storage.deviceIdentities,
      servers: storage.servers,
      demoUsers: storage.demoUsers,
      nonces,
    },
    directory: { identities: storage.deviceIdentities, nonces },
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const noBucket: VoiciBucket = {
  put: async () => {
    throw new Error("VOICI bucket not bound");
  },
  get: async () => null,
  delete: async () => undefined,
};

// ── the voi.ci host (§4.1) ──────────────────────────────────────────────────

/** Where the site's built files sit in the Worker assets (chunk C builds them; apps/voici-site). */
export const VOICI_SITE_ASSET_PREFIX = "/_voici";
export const VOICI_SITE_SHELL = `${VOICI_SITE_ASSET_PREFIX}/index.html`;

/** The voi.ci headers of §4.4, for a page shell or a site file. */
export function voiciSiteHeaders(env: VoiciEnv): [string, string][] {
  const apex = env.CONTROL_APEX ?? "flagshipserver.com";
  const files = voiciFilesOrigin(env);
  const services = env.SERVICES_APEX ?? "flagship.services";
  return [
    [
      "content-security-policy",
      // C: images are shown from blob: URLs of bytes the page already checked against the signed index (§4.2).
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; ` +
        `connect-src https://${apex} wss://${apex} ${files} https://*.${services}; frame-ancestors 'none'; base-uri 'none'; ` +
        "form-action 'none'; object-src 'none'",
    ],
    ["x-frame-options", "DENY"],
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "no-referrer"],
    ["strict-transport-security", "max-age=63072000; includeSubDomains"],
    ["cross-origin-opener-policy", "same-origin"],
    ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
  ];
}

// C: the shell comes from the generated build module and /_/ serves only this build's listed files (voiciSite.ts):
// an ASSETS fetch of `/_voici/index.html` is a 307 under the default html_handling, and a missing file would be the
// assets layer's single-page fallback.
async function serveSiteAsset(request: Request, env: VoiciEnv, assetPath: string, status = 200): Promise<Response> {
  if (assetPath === VOICI_SITE_SHELL) return voiciShellResponse(request, voiciSiteHeaders(env), status);
  return voiciSiteFile(request, env.ASSETS, assetPath.slice(VOICI_SITE_ASSET_PREFIX.length + 1), voiciSiteHeaders(env));
}

/** Where a link with an app goes: the app's canonical address (behind VOICI_CANONICAL), else the box that leads it. */
function linkTargets(env: VoiciEnv, storage: D1Storage) {
  const label = async (username: string, serviceId: string) =>
    (await storage.userServiceAliases.get(username, serviceId))?.displayLabel ?? deriveUrlFragment(serviceId, username);
  return {
    ...(env.VOICI_CANONICAL === "1"
      ? {
          resolveCanonical: async (username: string, serviceId: string) =>
            `https://${await label(username, serviceId)}.${username}.${env.SERVICES_APEX ?? "flagship.services"}`,
        }
      : {}),
    resolveAppUrl: async (username: string, serviceId: string) => {
      const home = await appHome({ servers: storage.servers, daemonStatus: storage.daemonStatus }, username, serviceId, await label(username, serviceId));
      return home.hasServer ? home.canonicalUrl : null;
    },
  };
}

/**
 * `voi.ci/<path>` (docs/voici-namespace-spec.md, Resolution): everything goes through resolveVoiciPath. A
 * non-canonical path 301s (lowercase, no trailing slash), `/-/…` is the site, `/@x` reaches usernames only, a live
 * link or code 302s, a retired one is 410, a published page is the shell, and everything else (unknown, reserved,
 * unpublished, a held name of a deleted account) is the same 404. Until `VOICI_ENABLED` is "on" no page, site file or
 * shell is served: links and codes still redirect, and refusals carry no body.
 */
export async function serveVoiciHost(request: Request, url: URL, env: VoiciEnv): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "private, no-store" } });
  }
  if (!env.DB) return new Response(null, { status: 503, headers: { "cache-control": "private, no-store" } });
  const on = voiciEnabled(env);
  const head = method === "HEAD";
  const storage = new D1Storage(new RequestD1(env.DB));
  // Before the switch voi.ci is the shortener it was: only links and codes resolve, people are not there yet.
  const linksOnly: Pick<NameRegistryStorage, "lookup" | "activeUsername"> = {
    lookup: async (name, kind) => {
      if (kind === "username") return undefined;
      const row = await storage.names.lookup(name);
      return row && (row.kind === "link" || row.kind === "code") ? row : undefined;
    },
    activeUsername: async () => undefined,
  };
  const answer = await resolveVoiciPath(
    {
      names: on ? storage.names : linksOnly,
      pages: on ? storage.voici : { getPage: async () => null },
      ...linkTargets(env, storage),
      origin: voiciWebOrigin(env),
    },
    url.pathname,
    url.search,
  );
  const plain = (status: number) => new Response(null, { status, headers: { "cache-control": "private, no-store" } });
  const refuse = (status: 404 | 410) => (on ? voiciErrorResponse(status, voiciSiteHeaders(env), head) : plain(status));
  switch (answer.kind) {
    case "system":
      return on ? serveSiteAsset(request, env, `${VOICI_SITE_ASSET_PREFIX}/${answer.rest}`) : plain(404);
    case "redirect":
      return new Response(null, { status: 301, headers: { location: answer.location, "cache-control": "private, no-store" } });
    case "link":
      return new Response(null, { status: 302, headers: { location: answer.target, "cache-control": "private, no-store" } });
    case "gone":
      return refuse(410);
    case "page":
      return serveSiteAsset(request, env, VOICI_SITE_SHELL);
    case "page-gone":
      return serveSiteAsset(request, env, VOICI_SITE_SHELL, 410);
    case "home":
    case "not-found":
      return refuse(404);
  }
}

// ── removal (takedown, account deletion) and upkeep ─────────────────────────

/** Purges files.voi.ci URLs (Cloudflare API, 30 a call). Without the token and zone nothing is purged. */
async function purgeFiles(env: VoiciEnv, paths: string[]): Promise<void> {
  if (!env.CLOUDFLARE_PURGE_TOKEN || !env.VOICI_FILES_ZONE_ID || paths.length === 0) return;
  const files = paths.map((p) => `${voiciFilesOrigin(env)}/${p}`);
  for (let i = 0; i < files.length; i += 30) {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${env.VOICI_FILES_ZONE_ID}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_PURGE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ files: files.slice(i, i + 30) }),
    }).catch(() => undefined);
  }
}

/**
 * Takes a page off voi.ci now (chunk B2's takedown, account deletion, the owner's removal): the R2 index and every
 * piece of the page are deleted and purged from files.voi.ci; the D1 piece rows are left marked for the cron (the
 * owner's removal then deletes them itself); its visitors' reply alerts are deleted unless `keepAlerts`.
 */
export async function removeVoiciPageObjects(
  env: VoiciEnv,
  storage: Pick<D1Storage, "voici">,
  username: string,
  pageId: string,
  opts: { keepAlerts?: boolean } = {},
): Promise<void> {
  const pieces = await storage.voici.listPagePieces(pageId);
  const keys = [voiciIndexKey(username), ...pieces.map((p) => voiciPieceKey(pageId, p.sha256))];
  if (env.VOICI) for (let i = 0; i < keys.length; i += 1000) await env.VOICI.delete(keys.slice(i, i + 1000));
  await Promise.all([storage.voici.unreferenceAllPieces(pageId, 0), opts.keepAlerts ? null : storage.voici.deleteAlertsForPage(pageId)]);
  await purgeFiles(env, keys);
}

/** Account deletion (§10.3). */
export async function deleteVoiciAccount(env: VoiciEnv, storage: Pick<D1Storage, "voici">, username: string): Promise<void> {
  const page = await storage.voici.getPage(username);
  if (page) await removeVoiciPageObjects(env, storage, username, page.pageId);
  await storage.voici.deleteAccount(username);
  if (env.DB) await deleteVoiciAbuseAccount(env.DB, username);
}

/** The cron step (cronPlan.ts "voici-gc"). */
export async function runVoiciGcCron(env: VoiciEnv, now: Date): Promise<unknown> {
  if (!env.DB) return null;
  const [gc] = await Promise.all([
    runVoiciGc({ voici: new D1Storage(env.DB).voici, ...(env.VOICI ? { bucket: env.VOICI } : {}) }, now.getTime()),
    pruneVoiciAbuse(env.DB, now.getTime()),
  ]);
  return gc;
}
