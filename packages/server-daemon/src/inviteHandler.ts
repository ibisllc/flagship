/**
 * Daemon-side invite + app-access plumbing (#80, #83).
 *
 * Three signed surfaces per app, all scoped under `/.flagship/app/:serviceId/`:
 *
 *   POST /.flagship/app/:serviceId/invite          ← PSK-signed issue
 *   POST /.flagship/app/:serviceId/invite/accept   ← consumer-IRK-signed acceptance
 *   POST /.flagship/app/:serviceId/access/:irk/revoke ← PSK-signed revoke
 *
 * Plus one unsigned surface on each app's domain (loaded in a browser by
 * the consumer):
 *
 *   GET  /invite                                ← static HTML; reads
 *                                                  `#k=<secret>&a=<serviceId>`
 *                                                  and triggers acceptance.
 *
 * Storage is an interface (`AppInviteStore`) so production can later wire
 * it to the per-app data layer's Postgres without touching the handler.
 * `InMemoryAppInviteStore` is enough for tests + early dev — the daemon
 * crash window for an in-memory store is bounded by the 24h TTL.
 *
 * Security model — see `docs/policy/no-kyc.md`:
 *  - `opaqueTag` is the only routing key for an invite issuance; the
 *    issuer's "John (work)" label NEVER reaches storage. The phone-side
 *    labelbook (#81) keeps that mapping local to the owner's devices.
 *  - Bearer model is the default (any IRK that holds the secret can
 *    redeem). Mitigations: 24h max TTL, single-use atomic consumption,
 *    `contextNote` rendered to the consumer before acceptance.
 *  - `expectedIrkPubKey` opt-in pre-binding: when the issuer already
 *    knows the recipient's IRK, the daemon enforces it on acceptance.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  ed,
  verifyServiceAccessAcceptance,
  type ServiceAccessAcceptance,
  type Bytes,
  type Keypair,
} from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "./runtime.js";

export type Role = "owner" | "admin" | "member" | "reader" | string;

export interface AppInviteRow {
  inviteId: string;
  serviceId: string;
  /** SHA-256 hex of the random share-secret. */
  secretHash: string;
  role: Role;
  /** 16-byte tag — opaque to the daemon; the phone holds the label map. */
  opaqueTag: Bytes;
  /** Pre-bind to a known IRK pubkey, when set. Bearer model when null. */
  expectedIrkPubKey: Bytes | null;
  /** Owner-supplied note the consumer sees before consenting to redeem. */
  contextNote: string | null;
  issuedAt: number;
  expiresAt: number;
  status: "pending" | "consumed" | "revoked";
  consumedByIrkHex?: string;
  consumedAt?: number;
}

export interface AppAccessRow {
  serviceId: string;
  irkPubHex: string;
  role: Role;
  opaqueTag: Bytes;
  grantedAt: number;
  revokedAt: number | null;
  /** Bearer session token for the consumer's subsequent app calls. */
  sessionToken: string;
}

/**
 * Storage interface. The handler does not assume any particular SQL
 * dialect — production swaps this for a Postgres-backed adapter on the
 * per-app data layer without touching the handler.
 *
 * Implementations MUST make `consumeAtomically()` race-safe: two
 * concurrent acceptances of the same invite must result in exactly one
 * success.
 */
export interface AppInviteStore {
  insertInvite(row: AppInviteRow): Promise<void>;
  findInviteBySecretHash(serviceId: string, secretHash: string): Promise<AppInviteRow | null>;
  /**
   * Atomically mark a pending invite as consumed by the supplied IRK.
   * Returns the consumed row on success; null if the invite was already
   * consumed, revoked, or doesn't exist.
   */
  consumeAtomically(args: {
    serviceId: string;
    secretHash: string;
    consumerIrkPubHex: string;
    consumedAt: number;
  }): Promise<AppInviteRow | null>;
  insertAccess(row: AppAccessRow): Promise<void>;
  findAccess(serviceId: string, irkPubHex: string): Promise<AppAccessRow | null>;
  findAccessByToken(token: string): Promise<AppAccessRow | null>;
  revokeAccess(args: { serviceId: string; irkPubHex: string; revokedAt: number }): Promise<boolean>;
  /** For #84's access-gate. */
  listActiveAccess(serviceId: string): Promise<AppAccessRow[]>;
}

export class InMemoryAppInviteStore implements AppInviteStore {
  private readonly invites = new Map<string, AppInviteRow>();
  private readonly access = new Map<string, AppAccessRow>();
  private readonly tokenIndex = new Map<string, string>();

  private invKey(serviceId: string, secretHash: string): string {
    return `${serviceId}|${secretHash}`;
  }
  private accKey(serviceId: string, irkHex: string): string {
    return `${serviceId}|${irkHex}`;
  }

  async insertInvite(row: AppInviteRow): Promise<void> {
    this.invites.set(this.invKey(row.serviceId, row.secretHash), { ...row });
  }
  async findInviteBySecretHash(serviceId: string, secretHash: string): Promise<AppInviteRow | null> {
    const r = this.invites.get(this.invKey(serviceId, secretHash));
    return r ? { ...r } : null;
  }
  async consumeAtomically(args: {
    serviceId: string;
    secretHash: string;
    consumerIrkPubHex: string;
    consumedAt: number;
  }): Promise<AppInviteRow | null> {
    const key = this.invKey(args.serviceId, args.secretHash);
    const r = this.invites.get(key);
    if (!r) return null;
    if (r.status !== "pending") return null;
    const updated: AppInviteRow = {
      ...r,
      status: "consumed",
      consumedByIrkHex: args.consumerIrkPubHex,
      consumedAt: args.consumedAt,
    };
    this.invites.set(key, updated);
    return { ...updated };
  }
  async insertAccess(row: AppAccessRow): Promise<void> {
    this.access.set(this.accKey(row.serviceId, row.irkPubHex), { ...row });
    this.tokenIndex.set(row.sessionToken, this.accKey(row.serviceId, row.irkPubHex));
  }
  async findAccess(serviceId: string, irkPubHex: string): Promise<AppAccessRow | null> {
    const r = this.access.get(this.accKey(serviceId, irkPubHex));
    return r ? { ...r } : null;
  }
  async findAccessByToken(token: string): Promise<AppAccessRow | null> {
    const key = this.tokenIndex.get(token);
    if (!key) return null;
    const r = this.access.get(key);
    return r ? { ...r } : null;
  }
  async revokeAccess(args: { serviceId: string; irkPubHex: string; revokedAt: number }): Promise<boolean> {
    const key = this.accKey(args.serviceId, args.irkPubHex);
    const r = this.access.get(key);
    if (!r || r.revokedAt !== null) return false;
    this.access.set(key, { ...r, revokedAt: args.revokedAt });
    return true;
  }
  async listActiveAccess(serviceId: string): Promise<AppAccessRow[]> {
    const out: AppAccessRow[] = [];
    for (const r of this.access.values()) {
      if (r.serviceId === serviceId && r.revokedAt === null) out.push({ ...r });
    }
    return out;
  }
}

export interface InviteHandlerDeps {
  serverFqdn: string;
  /** Owner's PSK pubkey — verifies issue + revoke calls. */
  pskPub: Bytes;
  /** Persistent store; pass `new InMemoryAppInviteStore()` for tests. */
  store: AppInviteStore;
  /** Reject signed requests older than this. Default 5 min. */
  maxAgeMs?: number;
  /**
   * Hard cap on invite TTL. Issuance requests are clamped to this; values
   * outside [60s, this] are rejected outright. Default 72h (#83).
   */
  maxInviteTtlMs?: number;
  /** Default TTL when issuance request omits one. Default 24h (#83). */
  defaultInviteTtlMs?: number;
  /** For tests. */
  now?: () => number;
  /** For tests. */
  randomBytes?: (n: number) => Uint8Array;
  /**
   * When set, restrict issue/revoke + accept to the supplied set of known
   * appIds. Returns 404 for any other. Production injects this with a
   * lookup into ServicePlatform. Default: no check (any non-empty serviceId works
   * — useful for unit tests that don't spin up ServicePlatform).
   */
  isKnownApp?: (serviceId: string) => boolean;
}

const J: Record<string, string> = { "content-type": "application/json" };

/**
 * Build the invite + access handler suitable for `runtime.addHandler()`.
 * Returns null for paths it doesn't match so the chain can fall through.
 */
export function buildInviteHandler(deps: InviteHandlerDeps) {
  const now = deps.now ?? (() => Date.now());
  const rand = deps.randomBytes ?? ((n: number) => new Uint8Array(randomBytes(n)));
  const maxAgeMs = deps.maxAgeMs ?? 5 * 60_000;
  const maxTtlMs = deps.maxInviteTtlMs ?? 72 * 60 * 60_000;
  const defaultTtlMs = deps.defaultInviteTtlMs ?? 24 * 60 * 60_000;

  return async function handle(req: HttpRequest): Promise<HttpResponse | null> {
    if (req.path === "/invite" && req.method === "GET") {
      return invitePage();
    }
    if (!req.path.startsWith("/.flagship/app/")) return null;
    // Strip a query string before path-segment matching; the preview
    // endpoint uses ?h=<sha256hex> as its sole input.
    const qIdx = req.path.indexOf("?");
    const pathOnly = qIdx === -1 ? req.path : req.path.slice(0, qIdx);
    const tail = pathOnly.slice("/.flagship/app/".length);
    const parts = tail.split("/");
    const serviceId = parts[0];
    if (!serviceId) return null;
    if (deps.isKnownApp && !deps.isKnownApp(serviceId)) {
      return jerr(404, "unknown app");
    }

    if (parts[1] === "invite" && parts.length === 2 && req.method === "POST") {
      return issueInvite(deps, serviceId, req, { now, rand, maxAgeMs, maxTtlMs, defaultTtlMs });
    }
    if (parts[1] === "invite" && parts[2] === "accept" && parts.length === 3 && req.method === "POST") {
      return acceptInvite(deps, serviceId, req, { now, rand, maxAgeMs });
    }
    if (parts[1] === "invite" && parts[2] === "preview" && parts.length === 3 && req.method === "GET") {
      // #83.3: serve the contextNote BEFORE the consumer is allowed to
      // accept, so the page can render the issuer's own pseudonym /
      // memo. The endpoint reads the secret hash from a query param
      // (`?h=<sha256hex>`) — the consumer's browser computes the hash
      // client-side from the secret in the URL fragment, so the secret
      // itself never crosses the wire to the daemon.
      const q = req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "";
      const params = new URLSearchParams(q);
      const h = params.get("h");
      if (!h || !/^[0-9a-f]{64}$/i.test(h)) return jerr(400, "h required (sha256 hex)");
      return previewInvite(deps, serviceId, h.toLowerCase(), now);
    }
    if (parts[1] === "access" && parts[3] === "revoke" && parts.length === 4 && req.method === "POST") {
      const irkHex = parts[2]!;
      return revokeAccess(deps, serviceId, irkHex, req, { now, maxAgeMs });
    }
    return null;
  };
}

async function previewInvite(
  deps: InviteHandlerDeps,
  serviceId: string,
  secretHash: string,
  now: () => number,
): Promise<HttpResponse> {
  const invite = await deps.store.findInviteBySecretHash(serviceId, secretHash);
  if (!invite) return jerr(404, "unknown invite");
  // Don't leak status (consumed/revoked vs pending) on preview — the
  // accept call surfaces that. We do gate on expiry so a stale preview
  // doesn't mislead the consumer into spending a redemption attempt.
  if (now() > invite.expiresAt) return jerr(410, "invite expired");
  return {
    status: 200,
    headers: J,
    body: JSON.stringify({
      serviceId,
      role: invite.role,
      contextNote: invite.contextNote,
      issuedAt: invite.issuedAt,
      expiresAt: invite.expiresAt,
      // Pre-binding boolean is safe to surface (it's already implied by
      // the rejection message on accept); we surface it on preview so
      // the page can tell the user "this link is bound to a specific
      // identity" before they fire the signed acceptance envelope.
      preBound: invite.expectedIrkPubKey !== null,
    }),
  };
}

interface RuntimeBits {
  now: () => number;
  rand: (n: number) => Uint8Array;
  maxAgeMs: number;
  maxTtlMs?: number;
  defaultTtlMs?: number;
}

interface IssueBody {
  request?: {
    serverId?: unknown;
    serviceId?: unknown;
    role?: unknown;
    opaqueTag?: unknown;
    expectedIrkPubKey?: unknown;
    contextNote?: unknown;
    ttlMs?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown;
}

/**
 * Issue an invite. The request body MUST be a fresh PSK-signed PhoneOrder
 * envelope — we reuse the order-style envelope (signed by PSK, contains
 * `serverId` + `issuedAt`) for symmetry with the other phone-driven
 * surfaces. We embed it inside a synthetic order type "issue-invite"
 * canonicalized exactly like a flagship/order-style line so the phone
 * doesn't need new signing code (it already builds these envelopes).
 *
 * The on-wire shape is:
 *
 *  {
 *    "request": {
 *      "serverId":   "<fqdn>",
 *      "serviceId":      "creator-slug",
 *      "role":       "reader",
 *      "opaqueTag":  "<32 hex>",       // 16 bytes
 *      "expectedIrkPubKey": "<64 hex>" | null,
 *      "contextNote": "from harry's phone — work" | null,
 *      "ttlMs":      86400000,         // optional, default 24h
 *      "issuedAt":   <ms>
 *    },
 *    "signature": "<hex of psk.sign(canonical)>"
 *  }
 */
async function issueInvite(
  deps: InviteHandlerDeps,
  serviceId: string,
  req: HttpRequest,
  rb: RuntimeBits,
): Promise<HttpResponse> {
  const body = safeJsonParse(req.body.toString("utf8")) as IssueBody | null;
  if (!body || typeof body.signature !== "string" || !body.request) {
    return jerr(400, "malformed body");
  }
  const r = body.request;
  if (typeof r.serverId !== "string" || r.serverId !== deps.serverFqdn) {
    return jerr(403, "serverId mismatch");
  }
  if (typeof r.serviceId !== "string" || r.serviceId !== serviceId) {
    return jerr(400, "serviceId mismatch");
  }
  if (typeof r.role !== "string" || r.role.length === 0 || r.role.length > 64) {
    return jerr(400, "role missing or invalid");
  }
  if (typeof r.opaqueTag !== "string") return jerr(400, "opaqueTag required");
  let opaqueTag: Uint8Array;
  try {
    opaqueTag = hexToBytes(r.opaqueTag);
  } catch {
    return jerr(400, "opaqueTag must be hex");
  }
  if (opaqueTag.length !== 16) return jerr(400, "opaqueTag must be 16 bytes");

  let expectedIrkPubKey: Uint8Array | null = null;
  if (r.expectedIrkPubKey !== null && r.expectedIrkPubKey !== undefined) {
    if (typeof r.expectedIrkPubKey !== "string") return jerr(400, "expectedIrkPubKey must be hex or null");
    try {
      expectedIrkPubKey = hexToBytes(r.expectedIrkPubKey);
    } catch {
      return jerr(400, "expectedIrkPubKey must be hex");
    }
    if (expectedIrkPubKey.length !== 32) return jerr(400, "expectedIrkPubKey must be 32 bytes");
  }

  let contextNote: string | null;
  if (r.contextNote === undefined || r.contextNote === null) {
    contextNote = null;
  } else if (typeof r.contextNote === "string") {
    // Reject (not silently clamp) overlong notes: clamping would break
    // signature verification — the issuer signed the original bytes,
    // not the truncated form. Keep the hard cap small enough that no
    // legitimate "from harry's phone — work" note ever hits it.
    if (r.contextNote.length > 280) return jerr(400, "contextNote too long (max 280 chars)");
    contextNote = r.contextNote;
  } else {
    return jerr(400, "contextNote must be a string or null");
  }

  if (typeof r.issuedAt !== "number") return jerr(400, "issuedAt must be a number");
  if (Math.abs(rb.now() - r.issuedAt) > rb.maxAgeMs) return jerr(403, "stale request");

  const ttlMs =
    typeof r.ttlMs === "number" && Number.isFinite(r.ttlMs) ? r.ttlMs : rb.defaultTtlMs!;
  if (ttlMs < 60_000) return jerr(400, "ttlMs too small (min 60s)");
  if (ttlMs > rb.maxTtlMs!) return jerr(400, `ttlMs exceeds cap of ${rb.maxTtlMs}ms`);

  // Reuse the PhoneOrder canonical surface — the phone already builds
  // these envelopes; we don't want to add another signing primitive
  // for what is effectively another order kind.
  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return jerr(400, "invalid signature hex");
  }
  // We canonicalize the issue-invite request as a deterministic line and
  // verify against PSK. The line covers every field the server enforces.
  const canonical = canonicalIssueInvite({
    serverId: deps.serverFqdn,
    serviceId,
    role: r.role,
    opaqueTag,
    expectedIrkPubKey,
    contextNote,
    ttlMs,
    issuedAt: r.issuedAt,
  });
  if (!verifyOver(canonical, sig, deps.pskPub)) {
    return jerr(403, "invalid signature");
  }

  const secret = rb.rand(32);
  const secretHash = sha256Hex(secret);
  const inviteId = bytesToHex(rb.rand(16));
  const issuedAt = rb.now();
  const expiresAt = issuedAt + ttlMs;
  const row: AppInviteRow = {
    inviteId,
    serviceId,
    secretHash,
    role: r.role,
    opaqueTag,
    expectedIrkPubKey,
    contextNote,
    issuedAt,
    expiresAt,
    status: "pending",
  };
  await deps.store.insertInvite(row);

  return {
    status: 200,
    headers: J,
    body: JSON.stringify({
      ok: true,
      inviteId,
      secret: bytesToHex(secret),
      secretHash,
      expiresAt,
      contextNote,
    }),
  };
}

interface AcceptBody {
  request?: {
    inviteId?: unknown;
    secretHash?: unknown;
    consumerIrkPubKey?: unknown;
    acceptedAt?: unknown;
    nonce?: unknown;
  };
  signature?: unknown;
}

async function acceptInvite(
  deps: InviteHandlerDeps,
  serviceId: string,
  req: HttpRequest,
  rb: RuntimeBits,
): Promise<HttpResponse> {
  const body = safeJsonParse(req.body.toString("utf8")) as AcceptBody | null;
  if (!body || typeof body.signature !== "string" || !body.request) {
    return jerr(400, "malformed body");
  }
  const r = body.request;
  if (typeof r.inviteId !== "string" || r.inviteId.length === 0) return jerr(400, "inviteId required");
  if (typeof r.secretHash !== "string") return jerr(400, "secretHash required");
  if (typeof r.consumerIrkPubKey !== "string") return jerr(400, "consumerIrkPubKey required");
  if (typeof r.acceptedAt !== "number") return jerr(400, "acceptedAt must be a number");
  if (typeof r.nonce !== "string") return jerr(400, "nonce required");

  let consumerIrk: Uint8Array;
  let nonce: Uint8Array;
  try {
    consumerIrk = hexToBytes(r.consumerIrkPubKey);
    nonce = hexToBytes(r.nonce);
  } catch {
    return jerr(400, "invalid hex");
  }
  if (consumerIrk.length !== 32) return jerr(400, "consumerIrkPubKey must be 32 bytes");
  if (nonce.length === 0) return jerr(400, "nonce must be non-empty");

  if (Math.abs(rb.now() - r.acceptedAt) > rb.maxAgeMs) return jerr(403, "stale request");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return jerr(400, "invalid signature hex");
  }
  const acceptance: ServiceAccessAcceptance = {
    inviteId: r.inviteId,
    secretHash: r.secretHash,
    consumerIrkPubKey: consumerIrk,
    acceptedAt: r.acceptedAt,
    nonce,
  };
  if (!verifyServiceAccessAcceptance(acceptance, sig, consumerIrk)) {
    return jerr(403, "invalid acceptance signature");
  }

  const invite = await deps.store.findInviteBySecretHash(serviceId, r.secretHash);
  if (!invite) return jerr(404, "unknown invite");
  if (invite.inviteId !== r.inviteId) return jerr(400, "inviteId / secretHash mismatch");
  if (rb.now() > invite.expiresAt) return jerr(410, "invite expired");
  if (invite.status !== "pending") return jerr(409, `invite already ${invite.status}`);
  if (invite.expectedIrkPubKey && !bytesEqual(invite.expectedIrkPubKey, consumerIrk)) {
    return jerr(403, "consumer IRK does not match expectedIrkPubKey");
  }

  const consumerHex = bytesToHex(consumerIrk);
  const consumed = await deps.store.consumeAtomically({
    serviceId,
    secretHash: r.secretHash,
    consumerIrkPubHex: consumerHex,
    consumedAt: rb.now(),
  });
  if (!consumed) {
    // Race: someone else won.
    return jerr(409, "invite already consumed");
  }

  const sessionToken = bytesToHex(rb.rand(32));
  const access: AppAccessRow = {
    serviceId,
    irkPubHex: consumerHex,
    role: consumed.role,
    opaqueTag: consumed.opaqueTag,
    grantedAt: rb.now(),
    revokedAt: null,
    sessionToken,
  };
  await deps.store.insertAccess(access);

  return {
    status: 200,
    headers: J,
    body: JSON.stringify({
      ok: true,
      serviceId,
      role: access.role,
      sessionToken,
      grantedAt: access.grantedAt,
    }),
  };
}

interface RevokeBody {
  request?: {
    serverId?: unknown;
    serviceId?: unknown;
    irkPubKey?: unknown;
    issuedAt?: unknown;
  };
  signature?: unknown;
}

async function revokeAccess(
  deps: InviteHandlerDeps,
  serviceId: string,
  irkHexInPath: string,
  req: HttpRequest,
  rb: { now: () => number; maxAgeMs: number },
): Promise<HttpResponse> {
  const body = safeJsonParse(req.body.toString("utf8")) as RevokeBody | null;
  if (!body || typeof body.signature !== "string" || !body.request) {
    return jerr(400, "malformed body");
  }
  const r = body.request;
  if (typeof r.serverId !== "string" || r.serverId !== deps.serverFqdn) {
    return jerr(403, "serverId mismatch");
  }
  if (typeof r.serviceId !== "string" || r.serviceId !== serviceId) return jerr(400, "serviceId mismatch");
  if (typeof r.irkPubKey !== "string" || r.irkPubKey.toLowerCase() !== irkHexInPath.toLowerCase()) {
    return jerr(400, "irkPubKey / path mismatch");
  }
  if (typeof r.issuedAt !== "number") return jerr(400, "issuedAt must be a number");
  if (Math.abs(rb.now() - r.issuedAt) > rb.maxAgeMs) return jerr(403, "stale request");

  let sig: Uint8Array;
  try {
    sig = hexToBytes(body.signature);
  } catch {
    return jerr(400, "invalid signature hex");
  }
  let irkPub: Uint8Array;
  try {
    irkPub = hexToBytes(r.irkPubKey);
  } catch {
    return jerr(400, "invalid irkPubKey hex");
  }
  if (irkPub.length !== 32) return jerr(400, "irkPubKey must be 32 bytes");

  const canonical = canonicalRevokeAccess({
    serverId: deps.serverFqdn,
    serviceId,
    irkPubKey: irkPub,
    issuedAt: r.issuedAt,
  });
  if (!verifyOver(canonical, sig, deps.pskPub)) return jerr(403, "invalid signature");

  const ok = await deps.store.revokeAccess({
    serviceId,
    irkPubHex: irkHexInPath.toLowerCase(),
    revokedAt: rb.now(),
  });
  return {
    status: 200,
    headers: J,
    body: JSON.stringify({ ok: true, alreadyRevoked: !ok }),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Canonical bytes for the two PSK-signed envelopes (issue + revoke).
// We intentionally keep these adjacent to the handler rather than in
// `@flagship/protocol` because the phone is expected to use the daemon's
// public OpenAPI doc to build them — they're parallel to PhoneOrder's
// own canonical lines.
// ──────────────────────────────────────────────────────────────────────

const TAG_ISSUE_INVITE = "flagship/app-invite-issue/v1";
const TAG_REVOKE_ACCESS = "flagship/app-access-revoke/v1";

interface IssueInviteFields {
  serverId: string;
  serviceId: string;
  role: string;
  opaqueTag: Bytes;
  expectedIrkPubKey: Bytes | null;
  contextNote: string | null;
  ttlMs: number;
  issuedAt: number;
}

export function canonicalIssueInvite(f: IssueInviteFields): Uint8Array {
  return new TextEncoder().encode(
    [
      TAG_ISSUE_INVITE,
      f.serverId,
      f.serviceId,
      f.role,
      bytesToHex(f.opaqueTag),
      f.expectedIrkPubKey ? bytesToHex(f.expectedIrkPubKey) : "",
      f.contextNote ?? "",
      f.ttlMs,
      f.issuedAt,
    ].join("|"),
  );
}

interface RevokeAccessFields {
  serverId: string;
  serviceId: string;
  irkPubKey: Bytes;
  issuedAt: number;
}

export function canonicalRevokeAccess(f: RevokeAccessFields): Uint8Array {
  return new TextEncoder().encode(
    [TAG_REVOKE_ACCESS, f.serverId, f.serviceId, bytesToHex(f.irkPubKey), f.issuedAt].join("|"),
  );
}

/**
 * Phone-side helpers (exported for tests + #87 integration). Sign
 * issue / revoke payloads with the PSK keypair.
 */
export function signIssueInvite(f: IssueInviteFields, psk: Keypair): Uint8Array {
  return ed.sign(canonicalIssueInvite(f), psk.privateKey);
}
export function signRevokeAccess(f: RevokeAccessFields, psk: Keypair): Uint8Array {
  return ed.sign(canonicalRevokeAccess(f), psk.privateKey);
}

function verifyOver(canonical: Uint8Array, sig: Uint8Array, pub: Bytes): boolean {
  try {
    return ed.verify(sig, canonical, pub);
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────
// HTML page served at GET /invite (#80.2 + #83.3).
// ──────────────────────────────────────────────────────────────────────

export function invitePage(): HttpResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: INVITE_HTML,
  };
}

const INVITE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>You've been invited · Flagship</title>
<meta name="robots" content="noindex">
<style>
  :root { --bg:#0a0a0a; --fg:#eee; --muted:#888; --accent:#7ad; --warn:#fbcc4a; --danger:#f87171; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: var(--bg); color: var(--fg); padding: 3rem 1.5rem; max-width: 560px; margin: 0 auto; line-height: 1.55; }
  h1 { font-size: 1.5rem; }
  .note { background: #1a1a1a; border-left: 3px solid var(--warn); padding: 1rem; margin: 1.5rem 0; color: #eee; }
  .caution { background: #1a0a0a; border-left: 3px solid var(--danger); padding: 1rem; margin: 1.5rem 0; }
  button { background: var(--accent); color: #001; border: 0; padding: .75rem 1.25rem; border-radius: 6px; font-weight: 600; font-size: 1rem; cursor: pointer; }
  button[disabled] { background: #333; color: #777; cursor: not-allowed; }
  .row { display: flex; gap: .75rem; margin-top: 1.5rem; }
  pre { background: #1a1a1a; padding: 1rem; border-radius: 6px; overflow-x: auto; font-size: .85rem; color: var(--muted); }
  .status { margin-top: 1rem; font-size: .9rem; }
  .status.ok { color: #6ee7a8; }
  .status.err { color: var(--danger); }
  #context-note { font-weight: 600; }
</style>
</head>
<body>
<h1>You've been invited.</h1>
<p id="lede">Loading invite details…</p>
<div id="context" class="note" hidden>
  <div>Issuer's note to you:</div>
  <div id="context-note"></div>
</div>
<div class="caution">
  <strong>Before you accept</strong>: only consume this invite if you got it
  from the person you trust. Anyone holding this link can claim access — the
  daemon enforces single-use, but bearer share-links are stronger than email
  in one direction (no provider in the middle) and weaker in another (no
  recovery if you accidentally consume the wrong one).
</div>
<div class="row">
  <button id="accept" disabled>Accept and continue</button>
  <button id="cancel" style="background:#333;color:#eee">Cancel</button>
</div>
<div class="status" id="status"></div>
<script>
(function(){
  const frag = new URLSearchParams(location.hash.slice(1));
  const secret = frag.get("k") || "";
  const serviceId = frag.get("a") || "";
  const status = document.getElementById("status");
  if (!secret || !serviceId) {
    document.getElementById("lede").textContent = "This invite link is missing required parameters.";
    return;
  }
  document.getElementById("cancel").onclick = () => {
    status.textContent = "Cancelled.";
  };
  async function sha256Hex(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i*2, i*2+2), 16);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // Fetch the issuer's contextNote from the daemon BEFORE allowing
  // the consumer to accept. The secret never leaves the browser —
  // we send only its SHA-256.
  (async () => {
    try {
      const h = await sha256Hex(secret);
      const r = await fetch("/.flagship/app/" + encodeURIComponent(serviceId) + "/invite/preview?h=" + h);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || ("HTTP " + r.status));
      }
      const j = await r.json();
      document.getElementById("lede").textContent = "You've been invited to " + j.serviceId + " as " + j.role + ".";
      if (j.contextNote) {
        document.getElementById("context-note").textContent = j.contextNote;
        document.getElementById("context").hidden = false;
      }
      document.getElementById("accept").disabled = false;
    } catch (e) {
      status.className = "status err";
      status.textContent = "Could not load invite: " + (e && e.message || e);
    }
  })();
  document.getElementById("accept").onclick = async () => {
    status.className = "status";
    status.textContent = "Computing acceptance…";
    document.getElementById("accept").disabled = true;
    const handoff = (window).flagshipSignAcceptance;
    if (typeof handoff !== "function") {
      status.className = "status err";
      status.textContent = "Open this link in your Flagship app to accept.";
      return;
    }
    try {
      const accept = await handoff({ secret: secret, serviceId: serviceId });
      const r = await fetch("/.flagship/app/" + encodeURIComponent(serviceId) + "/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(accept),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
      status.className = "status ok";
      status.textContent = "Accepted. You now have " + j.role + " access.";
      sessionStorage.setItem("flagship-session-" + serviceId, j.sessionToken);
    } catch (e) {
      status.className = "status err";
      status.textContent = String(e && e.message || e);
      document.getElementById("accept").disabled = false;
    }
  };
})();
</script>
</body>
</html>`;

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function jerr(status: number, error: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error }) };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function hexToBytes(s: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function sha256Hex(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
