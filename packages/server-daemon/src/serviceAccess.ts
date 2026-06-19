/**
 * Per-service access gating on the box (docs/service-access-gating.md).
 *
 * Each installed service has an `access.mode ∈ {open, restricted}` (default
 * `open` — no behavior change for existing services). A `restricted` service
 * serves only visitors who present an AID-signed visit proof whose stable AID
 * (`deriveAccountId(UMK)`) is in the service's allow-list. The allow-list is
 * populated when a friend REDEEMS a capability invite against the box:
 *
 *   friend → box  POST /api/service-invites/redeem { secretHash, visitorAID, aidSig, redeemedAt }
 *     1. box verifies the friend's AID signature over the redeem,
 *     2. box calls `.com` POST /api/service-invites/redeem (first-bind /
 *        same-AID-idempotent / reject-different-AID — `.com` is the authority
 *        on the binding), and on success
 *     3. box adds boundAID to the local allow-list for the returned serviceRef.
 *
 * The mode + allow-list persist in one atomically-replaced JSON file (the
 * deadman.json / front-page.json pattern). The owner sets the mode with an
 * IRK-signed `set-service-access-mode` envelope over the box's OWN pinned pipe
 * (the `/api/power` shape — NOT the dead PSK orders surface); flagshipserver.com
 * is never in that path.
 *
 * Enforcement is exposed two ways: `decide(serviceRef, req)` for the serve path
 * to consult (a restricted service with no/invalid/foreign proof is denied),
 * and a pre-handler (`enforcementHandler`) that fronts the per-service reverse
 * proxy. The household-key bundle decrypt is a box-side helper, available only
 * when the household key has been provisioned to the box.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  openInviteBundle,
  serviceInviteSecretHash,
  verifyRedeemServiceInvite,
  verifyRemoveServiceAllow,
  verifyServiceVisitProof,
  verifySetServiceAccessMode,
  type InviteBundle,
  type RemoveServiceAllow,
  type ServiceAccessMode,
  type ServiceVisitProof,
  type SetServiceAccessMode,
} from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "./runtime.js";

const H = { "content-type": "application/json" };

/** Header a restricted-service visitor presents the AID-signed proof under. */
export const VISIT_PROOF_HEADER = "x-flagship-visit";

interface ServiceAccessEntry {
  mode: ServiceAccessMode;
  /** Lower-hex bound AIDs allowed to reach a restricted service. */
  allow: string[];
}

type PersistShape = Record<string, ServiceAccessEntry>;

/**
 * Persisted per-service access state — mode + AID allow-list. Default mode is
 * `open`, so a service with no row behaves exactly as before this feature.
 */
export class ServiceAccessStore {
  private byService = new Map<string, ServiceAccessEntry>();
  private readonly statePath: string;

  constructor(statePath = "/var/flagship/service-access.json") {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as PersistShape;
      this.byService.clear();
      for (const [ref, e] of Object.entries(raw ?? {})) {
        if (!e || (e.mode !== "open" && e.mode !== "restricted")) continue;
        const allow = Array.isArray(e.allow)
          ? e.allow.filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase())
          : [];
        this.byService.set(ref, { mode: e.mode, allow: [...new Set(allow)] });
      }
    } catch {
      // Absent / corrupt → everything defaults to open (fail-open: this
      // feature must never make an existing OPEN service unreachable).
      this.byService.clear();
    }
  }

  mode(serviceRef: string): ServiceAccessMode {
    return this.byService.get(serviceRef)?.mode ?? "open";
  }

  isAllowed(serviceRef: string, visitorAidHex: string): boolean {
    const e = this.byService.get(serviceRef);
    if (!e) return false; // only relevant when restricted; no row ⇒ no allow-list
    return e.allow.includes(visitorAidHex.toLowerCase());
  }

  allowList(serviceRef: string): string[] {
    return [...(this.byService.get(serviceRef)?.allow ?? [])];
  }

  private entry(serviceRef: string): ServiceAccessEntry {
    let e = this.byService.get(serviceRef);
    if (!e) {
      e = { mode: "open", allow: [] };
      this.byService.set(serviceRef, e);
    }
    return e;
  }

  async setMode(serviceRef: string, mode: ServiceAccessMode): Promise<void> {
    this.entry(serviceRef).mode = mode;
    await this.persist();
  }

  /** Add an AID to a service's allow-list (idempotent). Returns whether it was new. */
  async addAllowed(serviceRef: string, visitorAidHex: string): Promise<boolean> {
    const e = this.entry(serviceRef);
    const aid = visitorAidHex.toLowerCase();
    if (e.allow.includes(aid)) return false;
    e.allow.push(aid);
    await this.persist();
    return true;
  }

  /** Remove an AID from a service's allow-list (idempotent). */
  async removeAllowed(serviceRef: string, visitorAidHex: string): Promise<boolean> {
    const e = this.byService.get(serviceRef);
    if (!e) return false;
    const aid = visitorAidHex.toLowerCase();
    const before = e.allow.length;
    e.allow = e.allow.filter((x) => x !== aid);
    if (e.allow.length === before) return false;
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    const out: PersistShape = {};
    for (const [ref, e] of this.byService) out[ref] = { mode: e.mode, allow: e.allow };
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

/**
 * Cookie a browser carries the box-issued session under. Mirrors the existing
 * `Flagship-App-Session` bearer cookie (`serviceAccessGate.ts`, #84): the box
 * mints an OPAQUE random token (NOT a self-validating MAC — there is no new MAC
 * scheme) and looks it up server-side. A browser cannot set the AID-signed
 * `x-flagship-visit` header, so once a friend has redeemed (over their app/web)
 * the box hands them this cookie to reach the restricted service's WEBSITE.
 */
export const SESSION_COOKIE = "Flagship-App-Session";

/** Default browser-session lifetime — short-lived; re-issued via establish-session / a fresh redeem. */
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60_000;

interface SessionEntry {
  /** `<creator>-<slug>` this session is scoped to. A token reaches ONLY its service. */
  serviceRef: string;
  /** Lower-hex bound AID — re-checked against the allow-list on every request (so a revoke kills the cookie). */
  aid: string;
  /** Epoch-ms expiry. */
  expiresAt: number;
  /**
   * Phone-held opaque handle for the QR-login flow (docs "Web-experience
   * gating"). The PHONE authorizes a SEPARATE browser's session and holds THIS
   * id; it queries status + closes by it. Absent for sessions the friend's own
   * browser established (redeem / establish-session — no phone correlation).
   */
  secretId?: string;
  /** Browser UA recorded when the knock page was served — shown in "Open secured sessions". */
  browserAgent?: string;
  /** Session start (epoch-ms) — defaults to issue time. */
  startedAt?: number;
  /** Phone-initiated close: kills the browser cookie regardless of expiry. */
  closed?: boolean;
}

/** A phone-facing view of a session, addressed by its secretId. */
export interface SessionView {
  serviceRef: string;
  aid: string;
  browserAgent: string;
  startedAt: number;
  expiresAt: number;
  closed: boolean;
}

type SessionPersistShape = Record<string, SessionEntry>;

/**
 * Box-local browser-session store: an opaque token → { serviceRef, AID, expiry }.
 * Same atomically-replaced mode-0600 JSON file as `ServiceAccessStore`; reloaded
 * on boot so an in-flight browser session survives a daemon restart. Expired
 * rows are pruned lazily on lookup + eagerly on issue.
 */
export class ServiceSessionStore {
  private byToken = new Map<string, SessionEntry>();
  /** secretId → cookie token (the phone addresses a session by its secretId). */
  private bySecretId = new Map<string, string>();
  private readonly statePath: string;

  constructor(statePath = "/var/flagship/service-sessions.json") {
    this.statePath = statePath;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as SessionPersistShape;
      this.byToken.clear();
      this.bySecretId.clear();
      for (const [tok, e] of Object.entries(raw ?? {})) {
        if (
          !e ||
          typeof e.serviceRef !== "string" ||
          typeof e.aid !== "string" ||
          typeof e.expiresAt !== "number"
        ) {
          continue;
        }
        const entry: SessionEntry = {
          serviceRef: e.serviceRef,
          aid: e.aid.toLowerCase(),
          expiresAt: e.expiresAt,
        };
        if (typeof e.secretId === "string" && e.secretId.length > 0) entry.secretId = e.secretId;
        if (typeof e.browserAgent === "string") entry.browserAgent = e.browserAgent;
        if (typeof e.startedAt === "number") entry.startedAt = e.startedAt;
        if (e.closed === true) entry.closed = true;
        this.byToken.set(tok, entry);
        if (entry.secretId) this.bySecretId.set(entry.secretId, tok);
      }
    } catch {
      this.byToken.clear();
      this.bySecretId.clear();
    }
  }

  /**
   * Mint + persist a session token for an AID scoped to a service. Returns the
   * opaque cookie token. `extra` carries the QR-login fields — a `secretId`
   * (the phone's handle for the session) + the recorded `browserAgent`.
   */
  async issue(
    serviceRef: string,
    aidHex: string,
    now: number,
    ttlMs: number,
    extra?: { secretId?: string; browserAgent?: string; startedAt?: number },
  ): Promise<string> {
    this.pruneExpired(now);
    const token = bytesToHex(randomBytes(32));
    const entry: SessionEntry = {
      serviceRef,
      aid: aidHex.toLowerCase(),
      expiresAt: now + ttlMs,
      startedAt: extra?.startedAt ?? now,
    };
    if (extra?.secretId) entry.secretId = extra.secretId;
    if (extra?.browserAgent !== undefined) entry.browserAgent = extra.browserAgent;
    this.byToken.set(token, entry);
    if (entry.secretId) this.bySecretId.set(entry.secretId, token);
    await this.persist();
    return token;
  }

  /** Look up a live session for a cookie token, or null if absent/expired/closed. Does NOT check the allow-list. */
  lookup(token: string, now: number): { serviceRef: string; aid: string } | null {
    const e = this.byToken.get(token);
    if (!e) return null;
    if (e.closed || e.expiresAt <= now) {
      if (e.expiresAt <= now) this.drop(token);
      return null;
    }
    return { serviceRef: e.serviceRef, aid: e.aid };
  }

  /** A phone-facing view of the session a secretId addresses, or null if unknown. */
  lookupBySecretId(secretId: string): SessionView | null {
    const token = this.bySecretId.get(secretId);
    if (!token) return null;
    const e = this.byToken.get(token);
    if (!e) return null;
    return {
      serviceRef: e.serviceRef,
      aid: e.aid,
      browserAgent: e.browserAgent ?? "",
      startedAt: e.startedAt ?? 0,
      expiresAt: e.expiresAt,
      closed: e.closed === true,
    };
  }

  /** Phone-initiated close — kills the browser cookie. Idempotent; returns whether a session was closed. */
  async closeBySecretId(secretId: string): Promise<boolean> {
    const token = this.bySecretId.get(secretId);
    if (!token) return false;
    this.drop(token);
    await this.persist();
    return true;
  }

  private drop(token: string): void {
    const e = this.byToken.get(token);
    this.byToken.delete(token);
    if (e?.secretId) this.bySecretId.delete(e.secretId);
  }

  private pruneExpired(now: number): void {
    for (const [tok, e] of this.byToken) {
      if (e.expiresAt <= now) this.drop(tok);
    }
  }

  private async persist(): Promise<void> {
    const out: SessionPersistShape = {};
    for (const [tok, e] of this.byToken) out[tok] = e;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(out), { mode: 0o600 });
    await rename(tmp, this.statePath);
  }
}

export type AccessDecision =
  | { allow: true; reason: "open" | "allow-listed" | "cookie" }
  | { allow: false; reason: "no-proof" | "bad-proof" | "not-allowed" | "stale-proof" };

export interface ServiceAccessHttpOptions {
  /** The box fqdn — the `serverId` the owner/visitor envelopes are bound to. */
  serverId: string;
  ownerIrkPub: Uint8Array;
  store: ServiceAccessStore;
  /** Resolve `serviceRef` (`<creator>-<slug>`) → installed? Guards set-mode (422 if not). */
  serviceInstalled: (serviceRef: string) => boolean;
  /** Base URL of the control plane the box redeems against. */
  controlPlaneBaseUrl: string;
  /** Injectable fetch (defaults to global). */
  fetchImpl?: typeof fetch;
  /**
   * Household key provisioned to the box over its pinned pipe (UMK-derived;
   * flagshipserver.com never holds it). When present, the box can decrypt the
   * invite bundle (`{name, photo?}`) it stores as ciphertext. Optional — when
   * absent, `decryptBundle` returns null (the feature degrades, like SWK).
   */
  householdKey?: Uint8Array;
  /**
   * Browser-session store for the `Flagship-App-Session` cookie seam. When
   * present, a successful redeem (and `POST /api/service-access/establish-session`)
   * issues a cookie, and `decide` accepts it as well as the signed header — so a
   * friend who redeemed can reach the restricted service's WEBSITE in a plain
   * browser. Optional: absent ⇒ header-only enforcement (no behavior change).
   */
  sessions?: ServiceSessionStore;
  now?: () => number;
  /** Replay window for owner + visit + redeem envelopes. Default 5 min. */
  maxAgeMs?: number;
  /** Browser-session lifetime. Default 12h. */
  sessionTtlMs?: number;
}

/**
 * The serve-path decision: is this request allowed to reach `serviceRef`?
 * `open` ⇒ always; `restricted` ⇒ the request MUST carry EITHER a fresh
 * AID-signed visit proof (header `x-flagship-visit`, for app/web clients that
 * can sign) OR a live box-issued `Flagship-App-Session` cookie (for a plain
 * BROWSER, which cannot set the header). Either path must resolve to an AID
 * that is STILL in the service's allow-list (so a `.com` revoke kills both).
 */
export function decideServiceAccess(
  opts: Pick<ServiceAccessHttpOptions, "serverId" | "store"> & {
    sessions?: ServiceSessionStore;
    now?: () => number;
    maxAgeMs?: number;
  },
  serviceRef: string,
  req: HttpRequest,
): AccessDecision {
  if (opts.store.mode(serviceRef) === "open") return { allow: true, reason: "open" };
  const now = (opts.now ?? (() => Date.now()))();
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;

  const header = req.headers[VISIT_PROOF_HEADER];
  if (typeof header !== "string" || header.length === 0) {
    // No signed header — try a browser session cookie before denying.
    if (opts.sessions) {
      const token = readSessionCookie(req.headers.cookie);
      if (token) {
        const sess = opts.sessions.lookup(token, now);
        if (sess && sess.serviceRef === serviceRef && opts.store.isAllowed(serviceRef, sess.aid)) {
          return { allow: true, reason: "cookie" };
        }
      }
    }
    return { allow: false, reason: "no-proof" };
  }
  let parsed: { proof: ServiceVisitProof; sig: Uint8Array } | null;
  try {
    parsed = parseVisitHeader(header);
  } catch {
    parsed = null;
  }
  if (!parsed) return { allow: false, reason: "bad-proof" };
  const { proof, sig } = parsed;
  if (proof.serverId !== opts.serverId || proof.serviceRef !== serviceRef) {
    return { allow: false, reason: "bad-proof" };
  }
  if (Math.abs(now - proof.issuedAt) > maxAgeMs) return { allow: false, reason: "stale-proof" };
  if (!verifyServiceVisitProof(proof, sig, proof.visitorAID)) {
    return { allow: false, reason: "bad-proof" };
  }
  if (!opts.store.isAllowed(serviceRef, bytesToHex(proof.visitorAID))) {
    return { allow: false, reason: "not-allowed" };
  }
  return { allow: true, reason: "allow-listed" };
}

export interface ServiceAccessHttp {
  /** Pre-handler chain entry: serves `/api/service-access` + `/api/service-invites/redeem`. */
  handle: (req: HttpRequest) => Promise<HttpResponse | null>;
  /** Serve-path guard the per-service proxy calls before forwarding. */
  decide: (serviceRef: string, req: HttpRequest) => AccessDecision;
  /**
   * Decrypt an invite's `{name, photo?}` bundle with the provisioned household
   * key, or null when no household key is provisioned / the ciphertext is bad.
   */
  decryptBundle: (encryptedBundleHex: string, inviteId: string) => InviteBundle | null;
  store: ServiceAccessStore;
  /** The browser-session store, when the cookie seam is enabled (else undefined). */
  sessions?: ServiceSessionStore;
}

export function buildServiceAccessHttp(opts: ServiceAccessHttpOptions): ServiceAccessHttp {
  const now = opts.now ?? (() => Date.now());
  const maxAgeMs = opts.maxAgeMs ?? 5 * 60_000;
  const sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const decide = (serviceRef: string, req: HttpRequest): AccessDecision =>
    decideServiceAccess(
      { serverId: opts.serverId, store: opts.store, sessions: opts.sessions, now, maxAgeMs },
      serviceRef,
      req,
    );

  const decryptBundle = (encryptedBundleHex: string, inviteId: string): InviteBundle | null => {
    if (!opts.householdKey) return null;
    try {
      return openInviteBundle(encryptedBundleHex, opts.householdKey, inviteId);
    } catch {
      return null;
    }
  };

  async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path === "/api/service-access" && req.method === "POST") {
      return handleSetMode(req);
    }
    // Owner-IRK prune of a single AID from a service's allow-list (revoke /
    // "delete a friend"). `decide` re-checks the allow-list per request, so this
    // also kills any live browser cookie bound to that AID.
    if (req.path === "/api/service-access/allow-remove" && req.method === "POST") {
      return handleRemoveAllow(req);
    }
    // Friend's app/web establishes a browser cookie from an AID-signed proof.
    if (req.path === "/api/service-access/establish-session" && req.method === "POST") {
      return handleEstablishSession(req);
    }
    // Access-state read: GET /api/service-access/<serviceRef>. Unauthenticated
    // (the mode is already behaviorally observable; only the AID COUNT, never
    // the AIDs themselves, is exposed) so every client renders the true toggle
    // without a signature on a plain refresh.
    if (req.path.startsWith("/api/service-access/") && req.method === "GET") {
      const serviceRef = decodeURIComponent(req.path.slice("/api/service-access/".length));
      if (serviceRef.length === 0 || serviceRef.includes("/")) return bad(404, "not found");
      return jsonResponse(200, {
        serviceRef,
        mode: opts.store.mode(serviceRef),
        allowCount: opts.store.allowList(serviceRef).length,
      });
    }
    if (req.path === "/api/service-invites/redeem" && req.method === "POST") {
      return handleRedeem(req);
    }
    return null;
  }

  /**
   * POST /api/service-access/establish-session — a friend who already redeemed
   * (their AID is allow-listed) presents the SAME AID-signed `ServiceVisitProof`
   * the `x-flagship-visit` header carries (base64 body); the box mints a browser
   * cookie so a plain browser can then reach the restricted service. 400 on an
   * unparseable proof; 403 on a serverId/stale/signature failure; 401 if the AID
   * is not allow-listed for that restricted service; 404 when sessions are off.
   */
  async function handleEstablishSession(req: HttpRequest): Promise<HttpResponse> {
    if (!opts.sessions) return bad(404, "sessions not enabled");
    let parsed: { proof: ServiceVisitProof; sig: Uint8Array } | null;
    try {
      parsed = parseVisitHeader(req.body.toString("utf8"));
    } catch {
      parsed = null;
    }
    if (!parsed) return bad(400, "malformed visit proof");
    const { proof, sig } = parsed;
    if (proof.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - proof.issuedAt) > maxAgeMs) return bad(403, "stale request");
    if (!verifyServiceVisitProof(proof, sig, proof.visitorAID)) return bad(403, "invalid signature");
    const aidHex = bytesToHex(proof.visitorAID);
    // A cookie is only useful for a RESTRICTED service whose allow-list holds
    // this AID — issuing one otherwise would be a bearer token to nothing.
    if (opts.store.mode(proof.serviceRef) !== "restricted" || !opts.store.isAllowed(proof.serviceRef, aidHex)) {
      return bad(401, "not allow-listed for this service");
    }
    const token = await opts.sessions.issue(proof.serviceRef, aidHex, now(), sessionTtlMs);
    return {
      status: 200,
      headers: { ...H, "set-cookie": sessionSetCookie(token, sessionTtlMs) },
      body: JSON.stringify({ established: true, serviceRef: proof.serviceRef, expiresInMs: sessionTtlMs }),
    };
  }

  async function handleSetMode(req: HttpRequest): Promise<HttpResponse> {
    const env = parseEnvelope(req);
    if (!env) return bad(400, "malformed body");
    const order = parseSetMode(env.request);
    if (!order) return bad(400, "malformed set-service-access-mode order");
    if (order.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - order.issuedAt) > maxAgeMs) return bad(403, "stale request");
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return bad(400, "invalid signature hex");
    }
    if (!verifySetServiceAccessMode(order, sig, opts.ownerIrkPub)) {
      return bad(403, "invalid signature");
    }
    if (!opts.serviceInstalled(order.serviceRef)) {
      return bad(422, "unknown service");
    }
    await opts.store.setMode(order.serviceRef, order.mode);
    return jsonResponse(200, {
      ok: true,
      serviceRef: order.serviceRef,
      mode: opts.store.mode(order.serviceRef),
    });
  }

  async function handleRemoveAllow(req: HttpRequest): Promise<HttpResponse> {
    const env = parseEnvelope(req);
    if (!env) return bad(400, "malformed body");
    const order = parseRemoveAllow(env.request);
    if (!order) return bad(400, "malformed remove-allow order");
    if (order.serverId !== opts.serverId) return bad(403, "serverId mismatch");
    if (Math.abs(now() - order.issuedAt) > maxAgeMs) return bad(403, "stale request");
    let sig: Uint8Array;
    try {
      sig = hexToBytes(env.signature);
    } catch {
      return bad(400, "invalid signature hex");
    }
    if (!verifyRemoveServiceAllow(order, sig, opts.ownerIrkPub)) {
      return bad(403, "invalid signature");
    }
    const removed = await opts.store.removeAllowed(order.serviceRef, order.aid);
    // Idempotent: a no-op prune (AID already absent) still returns ok. The next
    // request from that AID is denied regardless (decide re-checks the list).
    return jsonResponse(200, { ok: true, removed });
  }

  async function handleRedeem(req: HttpRequest): Promise<HttpResponse> {
    let body: {
      secret?: unknown;
      secretHash?: unknown;
      visitorAID?: unknown;
      aidSig?: unknown;
      redeemedAt?: unknown;
    };
    try {
      body = JSON.parse(req.body.toString("utf8"));
    } catch {
      return bad(400, "invalid json");
    }
    // The box accepts EITHER the raw 32-byte secret (then hashes it) or the
    // hash directly. The friend's AID sig is over { secretHash, visitorAID,
    // redeemedAt } regardless.
    let secretHash: string;
    if (typeof body.secret === "string" && /^[0-9a-f]{64}$/i.test(body.secret)) {
      secretHash = serviceInviteSecretHash(hexToBytes(body.secret));
    } else if (typeof body.secretHash === "string" && /^[0-9a-f]{64}$/i.test(body.secretHash)) {
      secretHash = body.secretHash.toLowerCase();
    } else {
      return bad(400, "secret or secretHash required");
    }
    if (
      typeof body.visitorAID !== "string" ||
      !/^[0-9a-f]{64}$/i.test(body.visitorAID) ||
      typeof body.aidSig !== "string" ||
      !/^[0-9a-f]{128}$/i.test(body.aidSig) ||
      typeof body.redeemedAt !== "number"
    ) {
      return bad(400, "malformed redeem body");
    }
    if (Math.abs(now() - body.redeemedAt) > maxAgeMs) return bad(403, "stale request");

    const visitorAID = body.visitorAID.toLowerCase();
    // Verify the friend controls visitorAID BEFORE calling .com (so the box is
    // not a confused deputy binding a victim's AID to a held secret).
    const proofOk = verifyServiceVisitRedeem(secretHash, visitorAID, body.redeemedAt, body.aidSig);
    if (!proofOk) return bad(403, "invalid AID signature");

    // Delegate the binding decision to `.com` (the authority on first-bind /
    // same-AID-idempotent / reject-different-AID).
    let comRes: Response;
    try {
      comRes = await fetchImpl(`${opts.controlPlaneBaseUrl}/api/service-invites/redeem`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secretHash, visitorAID, aidSig: body.aidSig, redeemedAt: body.redeemedAt }),
      } as RequestInit);
    } catch {
      return bad(502, "control plane unreachable");
    }
    if (comRes.status === 404) return bad(404, "unknown invite");
    if (comRes.status === 409) return bad(409, "already bound to another account");
    if (comRes.status === 403) return bad(403, "invite revoked");
    if (!comRes.ok) return bad(502, "redeem rejected upstream");

    let comBody: { serviceRef?: unknown; boundAID?: unknown; firstBind?: unknown };
    try {
      comBody = (await comRes.json()) as typeof comBody;
    } catch {
      return bad(502, "bad upstream response");
    }
    if (typeof comBody.serviceRef !== "string" || typeof comBody.boundAID !== "string") {
      return bad(502, "incomplete upstream response");
    }
    // The bound AID is the authority's answer; add IT (not the request's claim)
    // to the allow-list, so a `.com` that bound a different AID can't be tricked
    // here. They match on the happy path.
    await opts.store.addAllowed(comBody.serviceRef, comBody.boundAID);
    // Hand the redeemer a browser cookie bound to their AID + this service, so
    // they can reach the restricted service's WEBSITE in a plain browser (which
    // can't set the signed `x-flagship-visit` header). Harmless on an OPEN
    // service — `decide` short-circuits to "open" before ever reading a cookie.
    const responseHeaders: Record<string, string> = { ...H };
    if (opts.sessions) {
      const token = await opts.sessions.issue(comBody.serviceRef, comBody.boundAID, now(), sessionTtlMs);
      responseHeaders["set-cookie"] = sessionSetCookie(token, sessionTtlMs);
    }
    return {
      status: 200,
      headers: responseHeaders,
      body: JSON.stringify({
        redeemed: true,
        firstBind: comBody.firstBind === true,
        serviceRef: comBody.serviceRef,
        boundAID: comBody.boundAID,
      }),
    };
  }

  return { handle, decide, decryptBundle, store: opts.store, sessions: opts.sessions };

  // Local: verify the AID sig over the redeem tuple (mirrors .com's check; the
  // box does it first so it never relays a forged binding request upstream).
  function verifyServiceVisitRedeem(
    secretHash: string,
    visitorAID: string,
    redeemedAt: number,
    aidSigHex: string,
  ): boolean {
    try {
      // Re-verify the friend's AID sig over the SAME RedeemServiceInvite shape
      // `.com` will check, so the box never relays a forged binding upstream.
      return verifyRedeemServiceInvite(
        { secretHash, visitorAID: hexToBytes(visitorAID), redeemedAt },
        hexToBytes(aidSigHex),
        hexToBytes(visitorAID),
      );
    } catch {
      return false;
    }
  }
}

/**
 * Build the enforcement pre-handler for a given service-label resolver. It
 * intercepts requests to a RESTRICTED service and denies (403) those without a
 * valid allow-listed proof; OPEN services + unknown labels fall through
 * (returns null) so the normal serve path handles them.
 *
 * `resolveServiceRef(req)` maps an inbound request to its `<creator>-<slug>`
 * service id (e.g. via the Host/url-label → installed-service lookup), or null
 * if the request isn't targeting a gated service.
 */
export function buildAccessEnforcementHandler(
  access: Pick<ServiceAccessHttp, "decide" | "store">,
  resolveServiceRef: (req: HttpRequest) => string | null,
  /**
   * Web-experience hook: on a DENY, this gets first refusal. For a top-level
   * browser navigation it returns the QR-login knock page (200 HTML); for an
   * API/asset request it returns null and the 403 JSON below is used. Absent ⇒
   * always 403 (no behavior change).
   */
  maybeServeKnock?: (serviceRef: string, req: HttpRequest) => HttpResponse | null,
): (req: HttpRequest) => Promise<HttpResponse | null> {
  return async (req: HttpRequest): Promise<HttpResponse | null> => {
    const serviceRef = resolveServiceRef(req);
    if (!serviceRef) return null;
    if (access.store.mode(serviceRef) === "open") return null;
    const decision = access.decide(serviceRef, req);
    if (decision.allow) return null;
    const knock = maybeServeKnock?.(serviceRef, req);
    if (knock) return knock;
    return {
      status: 403,
      headers: H,
      body: JSON.stringify({ error: "access restricted", reason: decision.reason }),
    };
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function parseEnvelope(req: HttpRequest): { request: Record<string, unknown>; signature: string } | null {
  let env: { request?: unknown; signature?: unknown };
  try {
    env = JSON.parse(req.body.toString("utf8"));
  } catch {
    return null;
  }
  if (!env.request || typeof env.request !== "object" || typeof env.signature !== "string") {
    return null;
  }
  return { request: env.request as Record<string, unknown>, signature: env.signature };
}

function parseSetMode(r: Record<string, unknown>): SetServiceAccessMode | null {
  if (
    typeof r.serverId !== "string" ||
    typeof r.serviceRef !== "string" ||
    (r.mode !== "open" && r.mode !== "restricted") ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return { serverId: r.serverId, serviceRef: r.serviceRef, mode: r.mode, issuedAt: r.issuedAt };
}

function parseRemoveAllow(r: Record<string, unknown>): RemoveServiceAllow | null {
  if (
    typeof r.serverId !== "string" ||
    typeof r.serviceRef !== "string" ||
    typeof r.aid !== "string" ||
    !/^[0-9a-f]{64}$/i.test(r.aid) ||
    typeof r.issuedAt !== "number"
  ) {
    return null;
  }
  return { serverId: r.serverId, serviceRef: r.serviceRef, aid: r.aid.toLowerCase(), issuedAt: r.issuedAt };
}

/** The visit header is `base64(JSON({ proof, sig }))`. */
function parseVisitHeader(header: string): { proof: ServiceVisitProof; sig: Uint8Array } | null {
  const json = Buffer.from(header, "base64").toString("utf8");
  const obj = JSON.parse(json) as { proof?: Record<string, unknown>; sig?: unknown };
  const p = obj.proof;
  if (
    !p ||
    typeof p.serverId !== "string" ||
    typeof p.serviceRef !== "string" ||
    typeof p.visitorAID !== "string" ||
    !/^[0-9a-f]{64}$/i.test(p.visitorAID) ||
    typeof p.issuedAt !== "number" ||
    typeof obj.sig !== "string" ||
    !/^[0-9a-f]{128}$/i.test(obj.sig)
  ) {
    return null;
  }
  return {
    proof: {
      serverId: p.serverId,
      serviceRef: p.serviceRef,
      visitorAID: hexToBytes(p.visitorAID),
      issuedAt: p.issuedAt,
    },
    sig: hexToBytes(obj.sig),
  };
}

/**
 * Extract the `Flagship-App-Session` token from a Cookie header (RFC-loose,
 * same parsing shape as `serviceAccessGate.ts`). Returns null if absent.
 */
function readSessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const t = part.trim();
    if (t.startsWith(`${SESSION_COOKIE}=`)) {
      const v = t.slice(SESSION_COOKIE.length + 1);
      return v.length > 0 ? v : null;
    }
  }
  return null;
}

/**
 * Build the `Set-Cookie` value for a freshly issued browser session. HttpOnly
 * (no JS read), Secure (the box is HTTPS-only), SameSite=Lax (the friend lands
 * on the service from the redeem/deep-link), Path=/ (whole service origin),
 * Max-Age = the session lifetime.
 */
function sessionSetCookie(token: string, ttlMs: number): string {
  const maxAgeSec = Math.floor(ttlMs / 1000);
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function bad(status: number, error: string): HttpResponse {
  return { status, headers: H, body: JSON.stringify({ error }) };
}

function jsonResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: H, body: JSON.stringify(body) };
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
