/**
 * Rescue session (docs/data-sovereignty.md): the owner's phone proves itself
 * to its own box and takes a backup off it with no call to `.com` or
 * `.services`, on the LAN or through the relay.
 *
 *   POST /api/rescue/hello    {clientNonce}            -> the box's STK-signed hello
 *   POST /api/rescue/session  {order, signatureHex}    -> {token, expiresAt}
 *   GET  /api/rescue/server                            -> what this box holds
 *   ...  /api/rescue/archive/<route>                   -> the backup routes below
 *
 * The session order is signed by the sensitive-order key (the pinned admin
 * root, else the IRK on a box that pins none), names a nonce this box issued
 * a moment ago, and names this box's own certificate, so it opens exactly one
 * session and cannot be replayed or relayed to another connection. Nothing
 * here reads a clock or a record from anywhere but this machine.
 *
 * The token it returns opens ONLY the routes listed in `ARCHIVE_ROUTES`: make
 * a backup, watch it, download it, delete it. It is not a paired session, so
 * it reaches no other screens route, and it lives in memory (a restart ends
 * it, and so does an hour).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  RESCUE_HELLO_TTL_MS,
  parseRescueExchange,
  signRescueHello,
  type Bytes,
  type RescueExchange,
  type RevokeDeviceCapabilityGrant,
} from "@flagship/protocol";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { ARCHIVE_PATH } from "../serverArchive/service.js";

export const RESCUE_PATH = "/api/rescue";
export const RESCUE_SESSION_TTL_MS = 60 * 60_000;
/** A device that became an admin by a grant (not by holding the admin root) may not open a rescue session until its grant is this old. */
export const RESCUE_NEW_ADMIN_COOLING_MS = 24 * 60 * 60_000;

/** Who signed a rescue order: the admin root itself, or an admin device by its own key and grant. */
export type RescueSigner = { kind: "root" } | { kind: "device"; grantId: string; deviceId: string; grantIssuedAt: number };
/**
 * Everything on the local network reaches the app as one loopback source, so
 * there is no per-caller limit to be had. A guess cannot succeed (a signature
 * is needed), so these caps only bound memory and log noise; a flood can slow
 * the owner down (the oldest pending hello is dropped) but never lock them
 * out, and never gets anyone in.
 */
const MAX_OUTSTANDING_NONCES = 256;
const MAX_SESSIONS = 4;
const WINDOW_MS = 60_000;
const MAX_HELLOS_PER_WINDOW = 300;
const NOTE_REFUSALS_EVERY_MS = 10_000;

/** The only backup routes a rescue token opens: method, rescue-relative path. */
const ARCHIVE_ROUTES: ReadonlySet<string> = new Set([
  "GET ",
  "POST start",
  "GET backup-file",
  "GET chunk",
  "GET bundle",
  "DELETE ",
]);

export interface RescueDeps {
  serverFqdn: string;
  /** Sign with the box's STK (the key the owner's phone derives for this server). */
  signAsBox: (msg: Bytes) => Bytes;
  /** SHA-256 of the leaf certificate this box is presenting, or null if it has none. */
  certSha256: () => string | null;
  /** Who signed this order under the box's pinned authority (the admin root, an admin device with a grant, or the IRK on a box that pins none), or null. */
  authorize: (order: RescueExchange, signature: Uint8Array) => RescueSigner | null;
  /** Default 24 h; 0 turns the cooling period off. Applies to device signers only. */
  coolingMs?: number;
  /** Root-signed device revocations delivered straight to this box (deviceRevocations.ts). */
  revocations?: {
    accept: (r: RevokeDeviceCapabilityGrant, sig: Uint8Array) => Promise<string | null>;
    subscribe: (fn: (grantId: string) => void) => void;
  } | null;
  /** Rotation proofs delivered straight to this box (adminRootRotationConsumer.applyDeliveredRotations). */
  rotations?: ((entries: RotationEntry[]) => Promise<{ rotated: boolean; reason?: string }>) | null;
  /** The backup routes (serverArchive.handle). */
  archive: {
    handle: (path: string, method: string, req: HttpRequest, ctx: { companion: boolean }) => Promise<HttpResponse | null>;
  } | null;
  /** What the owner may see once in: the apps this box runs. */
  apps: () => Array<{ serviceId: string; name: string }>;
  note?: (kind: string, detail: string, ok?: boolean) => void;
  now?: () => number;
  random?: (n: number) => Buffer;
  log?: (m: string) => void;
}

export interface RotationEntry {
  seq: number;
  oldAdminRootPub: string;
  newAdminRootPub: string;
  issuedAt: number;
  signatureHex: string;
}

const J = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } as const;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: { ...J }, body: JSON.stringify(body) });
const err = (status: number, error: string, code?: string): HttpResponse => json(status, { error, ...(code ? { code } : {}) });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function isRescuePath(path: string): boolean {
  const p = path.split("?")[0]!;
  return p === RESCUE_PATH || p.startsWith(`${RESCUE_PATH}/`);
}

export function buildRescue(deps: RescueDeps) {
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const log = deps.log ?? (() => {});
  const note = (kind: string, detail: string, ok = true) => {
    try {
      deps.note?.(kind, detail, ok);
    } catch {
      /* the activity log never fails a request */
    }
  };

  /** boxNonce -> the client nonce it was issued for, until it is spent or ages out. */
  const nonces = new Map<string, { clientNonce: string; issuedAt: number }>();
  /** sha256(token) -> expiry and who opened it. */
  const sessions = new Map<string, { exp: number; signer: RescueSigner }>();
  const cooling = deps.coolingMs ?? RESCUE_NEW_ADMIN_COOLING_MS;
  deps.revocations?.subscribe((grantId) => {
    for (const [k, v] of sessions) if (v.signer.kind === "device" && v.signer.grantId === grantId) sessions.delete(k);
  });
  let hellos: number[] = [];
  let lastRefusalNote = -Infinity;

  const sweep = () => {
    const t = now();
    for (const [k, v] of nonces) if (t - v.issuedAt > RESCUE_HELLO_TTL_MS) nonces.delete(k);
    for (const [k, v] of sessions) if (v.exp <= t) sessions.delete(k);
    hellos = hellos.filter((x) => t - x < WINDOW_MS);
  };

  function hello(req: HttpRequest): HttpResponse {
    let b: { clientNonce?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (typeof b.clientNonce !== "string" || !/^[0-9a-f]{32}$/.test(b.clientNonce)) return err(400, "clientNonce must be 16 bytes of lowercase hex");
    const cert = deps.certSha256();
    if (!cert) return err(503, "this server has no certificate yet", "no-certificate");
    if (hellos.length >= MAX_HELLOS_PER_WINDOW) return err(429, "too many tries: wait a minute", "rate-limited");
    hellos.push(now());
    if (nonces.size >= MAX_OUTSTANDING_NONCES) {
      const oldest = nonces.keys().next().value;
      if (oldest !== undefined) nonces.delete(oldest);
    }
    const boxNonce = random(16).toString("hex");
    const h: RescueExchange = { serverDomain: deps.serverFqdn, clientNonce: b.clientNonce, boxNonce, certSha256: cert, issuedAt: now() };
    nonces.set(boxNonce, { clientNonce: b.clientNonce, issuedAt: h.issuedAt });
    return json(200, { hello: h, signatureHex: Buffer.from(signRescueHello(h, deps.signAsBox)).toString("hex") });
  }

  function refuse(why: string, status = 403, code = "rescue-refused"): HttpResponse {
    if (now() - lastRefusalNote >= NOTE_REFUSALS_EVERY_MS) {
      lastRefusalNote = now();
      note("server.rescue.refused", `A rescue session was refused: ${why}.`, false);
    }
    return err(status, `the rescue session was refused: ${why}`, code);
  }

  function session(req: HttpRequest): HttpResponse {
    let b: { order?: unknown; signatureHex?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const order = parseRescueExchange(b.order);
    if (!order || typeof b.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(b.signatureHex)) return refuse("malformed order", 400);
    // The nonce is spent by the first order that names it, right or wrong.
    const issued = nonces.get(order.boxNonce);
    nonces.delete(order.boxNonce);
    if (!issued) return refuse("unknown or already used nonce");
    if (now() - issued.issuedAt > RESCUE_HELLO_TTL_MS) return refuse("the hello is too old");
    if (issued.clientNonce !== order.clientNonce) return refuse("not the nonce this hello was for");
    if (order.serverDomain !== deps.serverFqdn) return refuse("another server");
    const cert = deps.certSha256();
    if (!cert || order.certSha256 !== cert) return refuse("another certificate");
    if (Math.abs(now() - order.issuedAt) > RESCUE_HELLO_TTL_MS) return refuse("stale");
    const signer = deps.authorize(order, Buffer.from(b.signatureHex, "hex"));
    if (!signer) return refuse("not signed by this server's owner key");
    if (signer.kind === "device" && cooling > 0 && now() - signer.grantIssuedAt < cooling) {
      const hours = Math.ceil((signer.grantIssuedAt + cooling - now()) / 3_600_000);
      return refuse(
        `this device became an admin less than ${Math.round(cooling / 3_600_000)} hours ago and may take a backup in about ${hours} more; the admin key itself can take one now`,
        403,
        "admin-too-new",
      );
    }
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, c) => a[1].exp - c[1].exp)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    const token = random(32).toString("hex");
    const expiresAt = now() + RESCUE_SESSION_TTL_MS;
    sessions.set(sha(token), { exp: expiresAt, signer });
    const who = signer.kind === "root" ? "the admin key" : `admin device ${signer.deviceId.slice(0, 8)}`;
    note("server.rescue.opened", `A rescue session was opened with ${who}: it can make and download a backup of this server.`);
    log("[rescue] session opened");
    return json(200, { token, expiresAt });
  }

  /** Both intake routes are self-authenticating (a signature under the pinned admin root) and only ever remove authority. */
  function intakeAllowed(): boolean {
    if (hellos.length >= MAX_HELLOS_PER_WINDOW) return false;
    hellos.push(now());
    return true;
  }

  async function revoke(req: HttpRequest): Promise<HttpResponse> {
    if (!deps.revocations) return err(404, "not available");
    if (!intakeAllowed()) return err(429, "too many tries: wait a minute", "rate-limited");
    let b: { revoke?: Partial<RevokeDeviceCapabilityGrant>; signatureHex?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const r = b.revoke;
    if (!r || typeof r.grantId !== "string" || typeof r.username !== "string" || typeof r.reason !== "string" || typeof r.issuedAt !== "number" || typeof b.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(b.signatureHex)) {
      return err(400, "malformed revocation");
    }
    let why: string | null;
    try {
      why = await deps.revocations.accept(r as RevokeDeviceCapabilityGrant, Buffer.from(b.signatureHex, "hex"));
    } catch {
      why = "that revocation couldn't be read";
    }
    if (why) return err(403, why, "revocation-refused");
    note("server.device.revoked", "A device of the account was revoked by the admin key, and this server stopped trusting it.");
    return json(200, { ok: true });
  }

  async function rotate(req: HttpRequest): Promise<HttpResponse> {
    if (!deps.rotations) return err(404, "not available");
    if (!intakeAllowed()) return err(429, "too many tries: wait a minute", "rate-limited");
    let b: { rotations?: Array<Partial<RotationEntry>> };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    if (!Array.isArray(b.rotations) || b.rotations.length === 0 || b.rotations.length > 16) return err(400, "malformed rotation");
    const entries: RotationEntry[] = [];
    for (const [i, r] of b.rotations.entries()) {
      if (typeof r.oldAdminRootPub !== "string" || typeof r.newAdminRootPub !== "string" || typeof r.signatureHex !== "string" || typeof r.issuedAt !== "number") return err(400, "malformed rotation");
      entries.push({ seq: typeof r.seq === "number" ? r.seq : i + 1, oldAdminRootPub: r.oldAdminRootPub, newAdminRootPub: r.newAdminRootPub, issuedAt: r.issuedAt, signatureHex: r.signatureHex });
    }
    const out = await deps.rotations(entries);
    if (!out.rotated) return err(403, "that doesn't continue the admin key this server trusts", "rotation-refused");
    note("server.admin.rotated", "The account's admin key was replaced, and this server now trusts the new one. The old key can no longer act here.");
    return json(200, { ok: true, restarting: true });
  }

  function tokenOf(req: HttpRequest): string | null {
    const h = req.headers["x-flagship-rescue"] ?? req.headers["X-Flagship-Rescue"];
    return typeof h === "string" && /^[0-9a-f]{64}$/.test(h) ? h : null;
  }

  function authed(req: HttpRequest): boolean {
    const t = tokenOf(req);
    if (!t) return false;
    const row = sessions.get(sha(t));
    // The map is keyed by a hash of the token, so the lookup leaks nothing a guess could use.
    return row !== undefined && row.exp > now();
  }

  return {
    /** Mount this OUTSIDE the paired-session gate. null: not a rescue path. */
    async handle(req: HttpRequest): Promise<HttpResponse | null> {
      if (!isRescuePath(req.path)) return null;
      sweep();
      const path = req.path.split("?")[0]!;
      const method = req.method.toUpperCase();
      const rest = path.slice(RESCUE_PATH.length).replace(/^\//, "");
      if (method === "POST" && rest === "hello") return hello(req);
      if (method === "POST" && rest === "session") return session(req);
      if (method === "POST" && rest === "revoke") return revoke(req);
      if (method === "POST" && rest === "admin-root-rotation") return rotate(req);
      if (!authed(req)) return err(401, "open a rescue session first", "rescue-session-required");
      if (method === "GET" && rest === "server") {
        return json(200, { serverDomain: deps.serverFqdn, apps: deps.apps(), sessionEndsAt: sessions.get(sha(tokenOf(req)!))?.exp });
      }
      if (rest === "archive" || rest.startsWith("archive/")) {
        const sub = rest === "archive" ? "" : rest.slice("archive/".length);
        if (!ARCHIVE_ROUTES.has(`${method} ${sub}`)) return err(404, "that is not a rescue route", "not-a-rescue-route");
        if (!deps.archive) return err(503, "backups aren't available on this server");
        const target = sub === "" ? ARCHIVE_PATH : `${ARCHIVE_PATH}/${sub}`;
        const query = req.path.includes("?") ? req.path.slice(req.path.indexOf("?")) : "";
        const r = await deps.archive.handle(target, method, { ...req, path: target + query }, { companion: false });
        return r ?? err(404, "not found");
      }
      return err(404, "not found");
    },
    /** For tests and the heartbeat: how many sessions are open. */
    openSessions: (): number => {
      sweep();
      return sessions.size;
    },
  };
}

export type Rescue = ReturnType<typeof buildRescue>;
