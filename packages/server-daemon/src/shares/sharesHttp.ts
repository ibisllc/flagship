/**
 * Share this server, box side (docs/share-a-server.md §5–§7).
 *
 *  - Public: `GET /api/shares/nonce`, `POST /api/shares/session` (the other
 *    account signs in with its per-share key), `POST /api/shares/leave`, and
 *    over a share session `GET /api/shares/me` and `POST /api/shares/update`
 *    (a co-manager moves the box to an endorsed release, shareUpdate.ts).
 *  - Owner (behind the paired-session gate): `GET/POST /api/screens/shares`,
 *    `POST /api/screens/shares/revoke`, `GET /api/screens/activity`.
 *  - `gate(paired)`: the screens gate. An owner session passes as before; a
 *    share session passes only routes its level allows (default deny), and
 *    the request is tagged with the caller so signed actions verify against
 *    its per-share key.
 *  - `withActivity(handler)`: writes each write to the activity log under the
 *    owner or the share's label.
 *  - A poller reads ended shares back from `.com` and verifies each itself.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { keepCorruptAside, writeFileDurable } from "../durableFile.js";
import { join } from "node:path";
import {
  parseServerShareAccept,
  parseServerShareGrant,
  parseServerShareLeave,
  parseServerShareRevoke,
  parseServerShareSession,
  verifyServerShareLeave,
  verifyServerShareSession,
  type ServerShareGrant,
  type ServerShareRevoke,
  type ShareLevel,
} from "@flagship/protocol";
import type { PairedSessionGate } from "../alertInboxHttp.js";
import { extractPairedSessionToken } from "../pairedSessionStore.js";
import type { HttpRequest, HttpResponse } from "../runtime.js";
import { ActivityLog, type ActivityActor } from "./activityLog.js";
import { isServerArchivePath } from "../serverArchive/service.js";
import { shareRefusal, shareRouteNeed } from "./shareRoutes.js";
import { hexBytes, type HeldShare, type ShareStore } from "./shareStore.js";
import type { ShareUpdateOrder } from "./shareUpdate.js";

export interface ShareCaller {
  shareId: string;
  label: string;
  level: ShareLevel;
  seeAppData: boolean;
  unlockAtBoot: boolean;
  memberPubHex: string;
  /** The owner-signed grant, kept with anything this share signs. */
  grant: ServerShareGrant;
  grantSignature: string;
}

const callers = new WeakMap<HttpRequest, ShareCaller>();

/** The share behind this request, when a share session made it. */
export function shareCallerOf(req: HttpRequest): ShareCaller | null {
  return callers.get(req) ?? null;
}

function callerFrom(h: HeldShare): ShareCaller {
  return {
    shareId: h.grant.shareId,
    label: h.grant.label,
    level: h.grant.level,
    seeAppData: h.grant.seeAppData,
    unlockAtBoot: h.grant.unlockAtBoot,
    memberPubHex: h.grant.memberPubHex,
    grant: h.grant,
    grantSignature: h.signature,
  };
}

const SESSION_TTL_MS = 12 * 3600_000;
const NONCE_TTL_MS = 2 * 60_000;
const SESSION_SKEW_MS = 5 * 60_000;
const MAX_NONCES = 1000;

/** Share-session bearer tokens: `<dataDir>/share-sessions.json`, mode 0600. */
export class ShareSessionStore {
  private byToken = new Map<string, { shareId: string; expiresAt: number }>();

  constructor(
    private readonly path: string | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async load(): Promise<void> {
    if (!this.path) return;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Record<string, { shareId?: unknown; expiresAt?: unknown }>;
      for (const [t, v] of Object.entries(raw)) {
        if (typeof v?.shareId === "string" && typeof v.expiresAt === "number" && v.expiresAt > this.now()) {
          this.byToken.set(t, { shareId: v.shareId, expiresAt: v.expiresAt });
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      // No session is the closed side (co-managers sign in again), not a crash loop.
      this.byToken.clear();
      await keepCorruptAside(this.path, e, "People you shared this server with have to open it again from their app.");
    }
  }

  async mint(shareId: string): Promise<{ token: string; expiresAt: number }> {
    const token = `fss_${randomBytes(32).toString("hex")}`;
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.byToken.set(token, { shareId, expiresAt });
    await this.save();
    return { token, expiresAt };
  }

  lookup(token: string): string | null {
    const row = this.byToken.get(token);
    if (!row) return null;
    if (row.expiresAt <= this.now()) {
      this.byToken.delete(token);
      return null;
    }
    return row.shareId;
  }

  async dropShare(shareId: string): Promise<number> {
    let n = 0;
    for (const [t, v] of this.byToken) {
      if (v.shareId === shareId) {
        this.byToken.delete(t);
        n++;
      }
    }
    if (n > 0) await this.save();
    return n;
  }

  private save(): Promise<void> {
    if (!this.path) return Promise.resolve();
    const path = this.path;
    const now = this.now();
    const body = JSON.stringify(Object.fromEntries([...this.byToken].filter(([, v]) => v.expiresAt > now)));
    // Queued per path; one failed write no longer blocks every later one.
    return writeFileDurable(path, body);
  }
}

export function defaultShareSessionPath(dataDir: string): string {
  return join(dataDir, "share-sessions.json");
}

export interface SharesDeps {
  serverDomain: string;
  store: ShareStore;
  sessions: ShareSessionStore;
  activity: ActivityLog;
  /** The owner's sensitive key signed this revoke. */
  verifyOwnerRevoke: (r: ServerShareRevoke, sig: Uint8Array) => boolean;
  /** Is this owner session a companion (read-only browser)? */
  isCompanion?: (req: HttpRequest) => boolean;
  /** A co-manager's update order; absent where the box can't update itself. */
  serverUpdate?: ShareUpdateOrder | null;
  now?: () => number;
  log?: (m: string) => void;
}

const J = { "content-type": "application/json", "cache-control": "no-store" } as const;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: J, body: JSON.stringify(body) });
const err = (status: number, error: string, extra: Record<string, unknown> = {}): HttpResponse => json(status, { error, ...extra });

export function buildShares(deps: SharesDeps) {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(m));
  const nonces = new Map<string, number>();

  function body(req: HttpRequest): Record<string, unknown> | null {
    try {
      const v = JSON.parse(req.body.toString("utf8")) as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  function sweepNonces(): void {
    const t = now();
    for (const [n, exp] of nonces) if (exp <= t) nonces.delete(n);
  }

  /** The live share behind a request's token, if it carries a share session. */
  function resolve(req: HttpRequest): ShareCaller | null {
    const token = extractPairedSessionToken(req);
    if (!token || !token.startsWith("fss_")) return null;
    const shareId = deps.sessions.lookup(token);
    if (!shareId) return null;
    const held = deps.store.get(shareId);
    return held ? callerFrom(held) : null;
  }

  async function endShare(shareId: string, reason: "revoked" | "left", actor: ActivityActor): Promise<boolean> {
    const ended = await deps.store.end(shareId, reason);
    await deps.sessions.dropShare(shareId);
    if (ended) {
      deps.activity.record({ actor, action: reason === "left" ? "share.left" : "share.revoked", target: ended.label, ok: true });
      log(`[shares] ${shareId.slice(0, 8)} ${reason}`);
    }
    return ended !== null;
  }

  async function handlePublic(req: HttpRequest): Promise<HttpResponse | null> {
    const path = req.path.split("?")[0]!;
    const method = req.method.toUpperCase();
    if (!path.startsWith("/api/shares/")) return null;

    if (path === "/api/shares/nonce" && method === "GET") {
      sweepNonces();
      if (nonces.size >= MAX_NONCES) return err(429, "try again shortly");
      const nonce = randomBytes(32).toString("hex");
      nonces.set(nonce, now() + NONCE_TTL_MS);
      return json(200, { nonce });
    }

    if (path === "/api/shares/session" && method === "POST") {
      const b = body(req);
      const s = parseServerShareSession(b?.session);
      const sig = typeof b?.signature === "string" ? hexBytes(b.signature) : null;
      if (!s || !sig || sig.length !== 64) return err(400, "malformed session request");
      if (s.serverDomain !== deps.serverDomain) return err(403, "wrong server");
      if (Math.abs(now() - s.issuedAt) > SESSION_SKEW_MS) return err(403, "stale request");
      const exp = nonces.get(s.nonceHex);
      if (exp === undefined || exp <= now()) return err(403, "unknown or used nonce");
      if (!verifyServerShareSession(s, sig, hexBytes(s.memberPubHex)!)) return err(403, "invalid signature");
      nonces.delete(s.nonceHex);
      if (deps.store.isEnded(s.shareId)) return err(403, "share-ended", { code: "share-ended" });
      const held = deps.store.get(s.shareId);
      if (!held || held.grant.memberPubHex !== s.memberPubHex) return err(403, "not-shared", { code: "not-shared" });
      const { token, expiresAt } = await deps.sessions.mint(s.shareId);
      await deps.store.touch(s.shareId);
      deps.activity.record({ actor: actorOf(callerFrom(held)), action: "share.signed-in", ok: true });
      return json(200, {
        token,
        expiresAt,
        level: held.grant.level,
        unlockAtBoot: held.grant.unlockAtBoot,
        seeAppData: held.grant.seeAppData,
      });
    }

    if (path === "/api/shares/leave" && method === "POST") {
      const b = body(req);
      const l = parseServerShareLeave(b?.leave);
      const sig = typeof b?.signature === "string" ? hexBytes(b.signature) : null;
      if (!l || !sig || sig.length !== 64) return err(400, "malformed leave");
      if (l.serverDomain !== deps.serverDomain) return err(403, "wrong server");
      if (!verifyServerShareLeave(l, sig, hexBytes(l.memberPubHex)!)) return err(403, "invalid signature");
      const held = deps.store.get(l.shareId);
      if (!held) return json(200, { ok: true, alreadyEnded: true });
      if (held.grant.memberPubHex !== l.memberPubHex) return err(403, "not this share's key");
      await endShare(l.shareId, "left", actorOf(callerFrom(held)));
      return json(200, { ok: true });
    }

    if (path === "/api/shares/update" && method === "POST") {
      const c = resolve(req);
      if (!c) return err(401, "share session ended or expired", { code: "share-session" });
      if (c.level !== "manage") return err(403, "manage-only", { code: "manage-only" });
      if (!deps.serverUpdate) return err(503, "this server can't update itself", { code: "no-self-update" });
      const r = await deps.serverUpdate(c, body(req));
      return json(r.status, r.body);
    }

    if (path === "/api/shares/me" && method === "GET") {
      const c = resolve(req);
      if (!c) return err(401, "share session required");
      return json(200, {
        shareId: c.shareId,
        level: c.level,
        unlockAtBoot: c.unlockAtBoot,
        seeAppData: c.seeAppData,
        serverDomain: deps.serverDomain,
        canUpdate: c.level === "manage" && !!deps.serverUpdate,
      });
    }
    return err(404, "share route not found");
  }

  /** Owner routes under /api/screens (the screens gate already passed an owner session). */
  async function handleOwner(path: string, method: string, req: HttpRequest): Promise<HttpResponse | null> {
    if (path === "/api/screens/activity" && method === "GET") {
      const q = new URLSearchParams(req.path.includes("?") ? req.path.slice(req.path.indexOf("?") + 1) : "");
      const limit = Number(q.get("limit") ?? "200");
      const beforeRaw = q.get("before");
      const before = beforeRaw === null ? undefined : Number(beforeRaw);
      const entries = deps.activity.recent(
        Number.isFinite(limit) ? limit : 200,
        before !== undefined && Number.isFinite(before) ? before : undefined,
      );
      return json(200, { entries });
    }
    if (path === "/api/screens/shares" && method === "GET") {
      return json(200, {
        shares: deps.store.list().map((h) => ({
          shareId: h.grant.shareId,
          label: h.grant.label,
          level: h.grant.level,
          unlockAtBoot: h.grant.unlockAtBoot,
          seeAppData: h.grant.seeAppData,
          memberPubHex: h.grant.memberPubHex,
          issuedAt: h.grant.issuedAt,
          sharedAt: h.sharedAt,
          lastSeenAt: h.lastSeenAt,
        })),
        ended: deps.store.listEnded().slice(0, 50),
      });
    }
    if (path === "/api/screens/shares" && method === "POST") {
      if (deps.isCompanion?.(req)) return err(403, "companion-write-not-allowed");
      const b = body(req);
      const grant = parseServerShareGrant(b?.grant);
      if (!grant || typeof b?.signature !== "string") return err(400, "malformed grant");
      const accept = b.accept === undefined ? undefined : parseServerShareAccept(b.accept);
      if (accept === null) return err(400, "malformed acceptance");
      const acceptSignature = typeof b.acceptSignature === "string" ? b.acceptSignature : undefined;
      // Sessions look the share up on every request, so a change applies at once.
      const r = await deps.store.put(grant, b.signature, accept ?? undefined, acceptSignature);
      if (!r.ok) return err(r.status, r.error);
      deps.activity.record({
        actor: { kind: "owner" },
        action: r.created ? "share.granted" : "share.changed",
        target: grant.label,
        ok: true,
      });
      return json(200, { ok: true, created: r.created, share: { shareId: grant.shareId, level: grant.level } });
    }
    if (path === "/api/screens/shares/revoke" && method === "POST") {
      if (deps.isCompanion?.(req)) return err(403, "companion-write-not-allowed");
      const b = body(req);
      const r = parseServerShareRevoke(b?.revoke);
      const sig = typeof b?.signature === "string" ? hexBytes(b.signature) : null;
      if (!r || !sig || sig.length !== 64) return err(400, "malformed revoke");
      if (r.serverDomain !== deps.serverDomain) return err(403, "revoke is for a different server");
      if (!deps.verifyOwnerRevoke(r, sig)) return err(403, "invalid signature");
      const ended = await endShare(r.shareId, "revoked", { kind: "owner" });
      return json(200, { ok: true, ...(ended ? {} : { alreadyEnded: true }) });
    }
    return null;
  }

  /**
   * The screens gate: owner sessions exactly as before; share sessions only
   * where their level reaches, tagged with the caller.
   */
  function gate(paired: PairedSessionGate): PairedSessionGate {
    return {
      check(req: HttpRequest): HttpResponse | null {
        const token = extractPairedSessionToken(req);
        if (!token || !token.startsWith("fss_")) return paired.check(req);
        const caller = resolve(req);
        if (!caller) return err(401, "share session ended or expired", { code: "share-session" });
        const refusal = shareRefusal(caller, shareRouteNeed(req.method, req.path, req.body));
        if (refusal) return err(403, refusal, { code: refusal });
        callers.set(req, caller);
        return null;
      },
    };
  }

  /** Write every write to the activity log, and share reads of app data. */
  function withActivity(handler: (req: HttpRequest) => Promise<HttpResponse | null>) {
    return async (req: HttpRequest): Promise<HttpResponse | null> => {
      const res = await handler(req);
      if (!res) return res;
      const path = req.path.split("?")[0]!;
      const method = req.method.toUpperCase();
      if (!path.startsWith("/api/screens/") || path.startsWith("/api/screens/shares") || res.status === 401) return res;
      // Backups and imports record their own events; their chunk uploads would
      // otherwise fill the log with one line per 4 MiB.
      if (isServerArchivePath(path)) return res;
      const caller = shareCallerOf(req);
      const need = shareRouteNeed(method, path, req.body);
      if (method === "GET" && !(caller && need?.action)) return res;
      if (caller && res.status === 403 && !need) return res;
      deps.activity.record({
        actor: caller ? actorOf(caller) : { kind: "owner" },
        action: need?.action ?? `${method.toLowerCase()} ${templatePath(path)}`,
        ...(need?.target ? { target: need.target } : {}),
        ok: res.status < 400,
      });
      return res;
    };
  }

  return { handlePublic, handleOwner, gate, withActivity, resolve, endShare };
}

export type Shares = ReturnType<typeof buildShares>;

function actorOf(c: ShareCaller): ActivityActor {
  return { kind: "share", shareId: c.shareId, label: c.label };
}

/** `/api/screens/services/abc/env/set` → `services/:id/env/set` (ids stay out of the action). */
function templatePath(path: string): string {
  const parts = path.replace(/^\/api\/screens\//, "").split("/");
  return parts.map((p, i) => (i > 0 && ["services", "app-detail", "sessions", "vibe-code", "paired-sessions", "api-keys"].includes(parts[i - 1]!) ? ":id" : p)).join("/");
}

export interface ShareEndsPollerDeps {
  serverDomain: string;
  controlPlaneBaseUrl: string;
  store: ShareStore;
  shares: Shares;
  verifyOwnerRevoke: (r: ServerShareRevoke, sig: Uint8Array) => boolean;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  log?: (m: string) => void;
}

/** Reads ended shares from `.com` and ends each one that verifies here. */
export async function pollShareEndsOnce(d: ShareEndsPollerDeps): Promise<number> {
  const f = d.fetchImpl ?? fetch;
  const url = `${d.controlPlaneBaseUrl.replace(/\/$/, "")}/api/server/${encodeURIComponent(d.serverDomain)}/share-ends?since=${d.store.cursor()}`;
  const res = await f(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`share-ends ${res.status}`);
  const body = (await res.json()) as { ends?: Array<Record<string, unknown>> };
  let ended = 0;
  let cursor = d.store.cursor();
  for (const e of body.ends ?? []) {
    if (typeof e.endedAt === "number") cursor = Math.max(cursor, e.endedAt);
    const sig = typeof e.signature === "string" ? hexBytes(e.signature) : null;
    if (!sig || sig.length !== 64) continue;
    if (e.kind === "revoke") {
      const r = parseServerShareRevoke(e.revoke);
      if (!r || r.serverDomain !== d.serverDomain || !d.verifyOwnerRevoke(r, sig)) continue;
      if (await d.shares.endShare(r.shareId, "revoked", { kind: "owner" })) ended++;
    } else if (e.kind === "leave") {
      const l = parseServerShareLeave(e.leave);
      if (!l || l.serverDomain !== d.serverDomain) continue;
      const held = d.store.get(l.shareId);
      if (!held || held.grant.memberPubHex !== l.memberPubHex) continue;
      if (!verifyServerShareLeave(l, sig, hexBytes(l.memberPubHex)!)) continue;
      if (await d.shares.endShare(l.shareId, "left", { kind: "share", shareId: l.shareId, label: held.grant.label })) ended++;
    }
  }
  await d.store.setCursor(cursor);
  return ended;
}

export function startShareEndsPoller(d: ShareEndsPollerDeps): { stop(): void } {
  const log = d.log ?? ((m: string) => console.log(m));
  const tick = () =>
    pollShareEndsOnce(d)
      .then((n) => {
        if (n > 0) log(`[shares] ended ${n} share(s) from .com`);
      })
      .catch((e: Error) => log(`[shares] share-ends poll failed: ${e.message}`));
  void tick();
  const t = setInterval(tick, d.intervalMs ?? 5 * 60_000);
  t.unref?.();
  return { stop: () => clearInterval(t) };
}
