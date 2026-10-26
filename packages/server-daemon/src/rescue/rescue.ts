/**
 * Rescue session (docs/data-sovereignty.md): the owner's phone proves itself
 * to its own box and takes a backup off it with no call to `.com` or
 * `.services`, on the LAN or through the relay.
 *
 *   POST /api/rescue/hello    {clientNonce}                         -> the box's STK-signed hello (+ its hybrid half)
 *   POST /api/rescue/session  {order, signatureHex, pqSignature?}   -> {token, expiresAt}
 *   GET  /api/rescue/server                                         -> status and the apps, with their state
 *   POST /api/rescue/control  {order, signatureHex, pqSignature?}   -> start/stop/restart an app, restart/shut down
 *   ...  /api/rescue/archive/<route>                                -> the backup routes below
 *
 * The session order is signed by the sensitive-order key (the pinned admin
 * root, else the IRK on a box that pins none), names a nonce this box issued
 * a moment ago, and names this box's own certificate, so it opens exactly one
 * session and cannot be replayed or relayed to another connection. Nothing
 * here reads a clock or a record from anywhere but this machine.
 *
 * The token it returns opens ONLY the routes listed in `ARCHIVE_ROUTES`: make
 * a backup, watch it, download it, delete it; plus the server's status and the
 * offline controls. It is not a paired session, so it reaches no other screens
 * route, and it lives in memory (a restart ends it, and so does an hour).
 *
 * Offline control ("basic offline control", owner 2026-10-25): every action is
 * its own owner-signed `flagship/offline-control/v1` order, checked here like
 * the session order (same authority, same post-quantum gate), bound to this
 * session's box nonce, fresh and spent once. The token alone starts nothing.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  RESCUE_HELLO_TTL_MS,
  offlineControlCanonicalBytes,
  parseOfflineControl,
  parseRescueExchange,
  rescueHelloCanonicalBytes,
  rescueSessionCanonicalBytes,
  signRescueHello,
  type Bytes,
  type OfflineControlAction,
  type OfflineControlOrder,
  type RescueExchange,
  type RevokeDeviceCapabilityGrant,
} from "@flagship/protocol";
import type { AppRunState } from "../appStatus.js";
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
  /**
   * The STK's hybrid (Ed25519 + ML-DSA-65) signer, where this box holds an ML-DSA key (keyd). The
   * hello then carries `pqSignature` too, so a phone that holds the box's PQ binding and treats
   * it as strict can check the box post-quantum as well.
   */
  signHybridAsBox?: ((msg: Bytes) => Bytes) | null;
  /** SHA-256 of the leaf certificate this box is presenting, or null if it has none. */
  certSha256: () => string | null;
  /**
   * Who signed these canonical bytes (a session or an offline-control order) under the box's
   * pinned authority (the admin root, an admin device with a grant, or the IRK on a box that pins
   * none) and passed the post-quantum gate with `pqSignature`, or null.
   */
  authorize: (canonical: Uint8Array, signature: Uint8Array, pqSignature?: unknown) => RescueSigner | null;
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
  /** Each app's run state (appStatus.ts); absent: every app reads `unknown`. */
  appStates?: ((ids: readonly string[]) => Promise<Map<string, AppRunState>>) | null;
  /** A snapshot of the server for the status card (version, uptime, disk, certificate); never anything `.com` says. */
  status?: (() => Promise<Record<string, unknown>>) | null;
  /** The offline controls; absent: `/control` answers 503. */
  control?: OfflineControls | null;
  note?: (kind: string, detail: string, ok?: boolean) => void;
  /** A rescue session just opened: who, and the acting phone's own nonce. The daemon alerts the admin devices. */
  onExport?: (e: { stage: "rescue-opened"; by: string; ref: string }) => void;
  now?: () => number;
  random?: (n: number) => Buffer;
  log?: (m: string) => void;
}

export interface OfflineControls {
  /** Start, stop or restart one installed app. */
  app: (action: "app-start" | "app-stop" | "app-restart", serviceId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Restart or power off the machine (called after the reply has gone out). */
  power: (mode: "restart" | "off") => Promise<void>;
}

/** The Activity line for each offline action, in the owner's words. */
const CONTROL_NOTES: Record<OfflineControlAction, { kind: string; detail: (target: string) => string }> = {
  "app-start": { kind: "server.offline.app-started", detail: (t) => `${t} was started from the owner's phone on the local network.` },
  "app-stop": { kind: "server.offline.app-stopped", detail: (t) => `${t} was stopped from the owner's phone on the local network.` },
  "app-restart": { kind: "server.offline.app-restarted", detail: (t) => `${t} was restarted from the owner's phone on the local network.` },
  "server-restart": { kind: "server.offline.restart", detail: () => "The server was restarted from the owner's phone on the local network." },
  "server-shutdown": { kind: "server.offline.shutdown", detail: () => "The server was shut down from the owner's phone on the local network." },
};

/** How many spent offline-order nonces are remembered (they are only good for `RESCUE_HELLO_TTL_MS` anyway). */
const MAX_SPENT_CONTROL_NONCES = 1024;

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
  /** sha256(token) -> expiry, who opened it, and the box nonce its order answered (what offline orders name). */
  const sessions = new Map<string, { exp: number; signer: RescueSigner; sessionNonce: string }>();
  /** Offline-control nonces already spent, with when, so a signed order acts once. */
  const spentControl = new Map<string, number>();
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
    for (const [k, at] of spentControl) if (t - at > 2 * RESCUE_HELLO_TTL_MS) spentControl.delete(k);
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
    let pqSignature: { suite: string; signature: string } | undefined;
    if (deps.signHybridAsBox) {
      try {
        pqSignature = { suite: "hybrid-ed25519-mldsa65/v1", signature: Buffer.from(deps.signHybridAsBox(rescueHelloCanonicalBytes(h))).toString("hex") };
      } catch (e) {
        log(`[rescue] the hello's hybrid half couldn't be signed: ${(e as Error).message}`);
      }
    }
    return json(200, { hello: h, signatureHex: Buffer.from(signRescueHello(h, deps.signAsBox)).toString("hex"), ...(pqSignature ? { pqSignature } : {}) });
  }

  function refuse(why: string, status = 403, code = "rescue-refused"): HttpResponse {
    if (now() - lastRefusalNote >= NOTE_REFUSALS_EVERY_MS) {
      lastRefusalNote = now();
      note("server.rescue.refused", `A rescue session was refused: ${why}.`, false);
    }
    return err(status, `the rescue session was refused: ${why}`, code);
  }

  function session(req: HttpRequest): HttpResponse {
    let b: { order?: unknown; signatureHex?: unknown; pqSignature?: unknown };
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
    const signer = deps.authorize(rescueSessionCanonicalBytes(order), Buffer.from(b.signatureHex, "hex"), b.pqSignature);
    if (!signer) return refuse("not signed by this server's owner key, or not with the post-quantum signature this server requires");
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
    sessions.set(sha(token), { exp: expiresAt, signer, sessionNonce: order.boxNonce });
    const who = signer.kind === "root" ? "the admin key" : `admin device ${signer.deviceId.slice(0, 8)}`;
    note("server.rescue.opened", `A rescue session was opened with ${who}: it can make and download a backup of this server.`);
    try {
      deps.onExport?.({ stage: "rescue-opened", by: who, ref: order.clientNonce });
    } catch {
      /* an alert never fails a rescue */
    }
    log("[rescue] session opened");
    return json(200, { token, expiresAt });
  }

  async function revoke(req: HttpRequest): Promise<HttpResponse> {
    if (!deps.revocations) return err(404, "not available");
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

  async function control(req: HttpRequest, row: { signer: RescueSigner; sessionNonce: string }): Promise<HttpResponse> {
    if (!deps.control) return err(503, "this server can't be controlled offline", "offline-control-unavailable");
    let b: { order?: unknown; signatureHex?: unknown; pqSignature?: unknown };
    try {
      b = JSON.parse(req.body.toString("utf8")) as typeof b;
    } catch {
      return err(400, "invalid json");
    }
    const order: OfflineControlOrder | null = parseOfflineControl(b.order);
    if (!order || typeof b.signatureHex !== "string" || !/^[0-9a-f]{128}$/.test(b.signatureHex)) return refuseControl("malformed order", 400);
    if (order.sessionNonce !== row.sessionNonce) return refuseControl("signed for another session");
    if (order.serverDomain !== deps.serverFqdn) return refuseControl("another server");
    if (Math.abs(now() - order.issuedAt) > RESCUE_HELLO_TTL_MS) return refuseControl("stale");
    // Spent on first sight, right or wrong: a signature can act once.
    if (spentControl.has(order.nonce)) return refuseControl("already used");
    if (spentControl.size >= MAX_SPENT_CONTROL_NONCES) {
      const oldest = spentControl.keys().next().value;
      if (oldest !== undefined) spentControl.delete(oldest);
    }
    spentControl.set(order.nonce, now());
    const signer = deps.authorize(offlineControlCanonicalBytes(order), Buffer.from(b.signatureHex, "hex"), b.pqSignature);
    if (!signer) return refuseControl("not signed by this server's owner key, or not with the post-quantum signature this server requires");
    if (signer.kind === "device" && cooling > 0 && now() - signer.grantIssuedAt < cooling) return refuseControl("this device became an admin too recently");
    const n = CONTROL_NOTES[order.action];
    if (order.action === "server-restart" || order.action === "server-shutdown") {
      note(n.kind, n.detail(order.target));
      const mode = order.action === "server-restart" ? "restart" : "off";
      // The reply goes out first; the machine goes down a moment later.
      setTimeout(() => void deps.control!.power(mode).catch((e) => log(`[rescue] ${mode} failed: ${(e as Error).message}`)), 500).unref?.();
      return json(202, { ok: true, action: order.action });
    }
    const app = deps.apps().find((a) => a.serviceId === order.target);
    if (!app) return err(404, "that app isn't on this server", "no-such-app");
    const r = await deps.control.app(order.action, order.target);
    if (!r.ok) return err(409, `${app.name} couldn't be ${order.action === "app-stop" ? "stopped" : order.action === "app-start" ? "started" : "restarted"}: ${r.reason}`, "app-control-failed");
    note(n.kind, n.detail(app.name));
    return json(200, { ok: true, action: order.action, serviceId: order.target });
  }

  function refuseControl(why: string, status = 403): HttpResponse {
    if (now() - lastRefusalNote >= NOTE_REFUSALS_EVERY_MS) {
      lastRefusalNote = now();
      note("server.offline.refused", `An offline order was refused: ${why}.`, false);
    }
    return err(status, `the order was refused: ${why}`, "offline-order-refused");
  }

  function tokenOf(req: HttpRequest): string | null {
    const h = req.headers["x-flagship-rescue"] ?? req.headers["X-Flagship-Rescue"];
    return typeof h === "string" && /^[0-9a-f]{64}$/.test(h) ? h : null;
  }

  function authed(req: HttpRequest): { signer: RescueSigner; sessionNonce: string; exp: number } | null {
    const t = tokenOf(req);
    if (!t) return null;
    const row = sessions.get(sha(t));
    // The map is keyed by a hash of the token, so the lookup leaks nothing a guess could use.
    return row !== undefined && row.exp > now() ? row : null;
  }

  async function server(row: { exp: number; sessionNonce: string }): Promise<HttpResponse> {
    const apps = deps.apps();
    let states: Map<string, AppRunState> | null = null;
    try {
      states = deps.appStates ? await deps.appStates(apps.map((a) => a.serviceId)) : null;
    } catch {
      states = null;
    }
    let status: Record<string, unknown> = {};
    try {
      status = deps.status ? await deps.status() : {};
    } catch {
      status = {};
    }
    return json(200, {
      serverDomain: deps.serverFqdn,
      apps: apps.map((a) => ({ ...a, state: states?.get(a.serviceId) ?? "unknown" })),
      status,
      controls: deps.control ? ["app-start", "app-stop", "app-restart", "server-restart", "server-shutdown"] : [],
      sessionNonce: row.sessionNonce,
      sessionEndsAt: row.exp,
    });
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
      const row = authed(req);
      if (!row) return err(401, "open a rescue session first", "rescue-session-required");
      if (method === "GET" && rest === "server") return server(row);
      if (method === "POST" && rest === "control") return control(req, row);
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
