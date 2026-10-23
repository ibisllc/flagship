/**
 * Persistent paired-session token store. Replaces the in-memory
 * `TokenSetSessionGate` for production use; survives daemon restarts
 * so phone-paired browsers don't have to re-pair after a reboot.
 *
 * Tokens are minted by the phone (random 32-byte hex is the usual
 * choice) and added via the `add-paired-session` PhoneOrder. The
 * daemon stores them with an emit timestamp;
 * the host can list + revoke specific entries from the phone.
 *
 * On-disk layout: a single JSON file at `<dataDir>/paired-sessions.json`
 * holding `{v: 2, sessions: {[sha256(token)]: {addedAt}}}`: the bearer itself is never
 * stored (SECURITY-HARDENING-PLAN.md 18.6), only its hash, and lists show an opaque id. A file
 * from before (`{[token]: …}`) is read once and rewritten hashed. Atomic write-then-rename keeps
 * it crash-safe; concurrent writes from a single phone are serialized
 * by the orders handler so there's no contention.
 */

import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileDurable } from "./durableFile.js";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { PairedSessionGate } from "./alertInboxHttp.js";
import { type TokenFamily } from "./authority/index.js";

export interface PairedSession {
  addedAt: number;
  /**
   * P14 — companion-browser dock. When `true`, this session was minted
   * via `/api/companion/redeem` (NOT via the phone-signed
   * add-paired-session order). Companions:
   *   - have an `expiresAt` (4-hour TTL) the gate enforces;
   *   - are read-only — any signed-write endpoint that gates on the
   *     paired-session token returns 403 `companion-write-not-allowed`.
   * Legacy owner sessions leave this `false`/undefined.
   */
  companion?: boolean;
  /** Hard-expiry unix-ms for companion sessions. Unused on owner sessions. */
  expiresAt?: number;
  /** Best-effort User-Agent at redeem time, for the owner's list view. */
  companionUserAgent?: string;
}

/** The opaque id a bearer token is known by: its SHA-256. The token itself is never stored or listed. */
export function pairedSessionId(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class FilePairedSessionStore implements PairedSessionGate {
  private byToken = new Map<string, PairedSession>(); // keyed by sha256(token), hex
  /**
   * Test seam — the gate consults this for the "is the companion still
   * within its 4-hour TTL?" question. Production leaves it as Date.now;
   * tests inject a controllable clock.
   */
  now: () => number = () => Date.now();

  constructor(private readonly path: string) {}

  /**
   * N05 — owner and companion sessions join the authority index: a session the index does not
   * know, or has revoked, is refused, and revoking its parent device removes it here.
   */
  private authority: { owner: TokenFamily; companion: TokenFamily; parentOf: () => string[] } | null = null;

  async attachAuthority(a: { owner: TokenFamily; companion: TokenFamily; parentOf: () => string[] }): Promise<void> {
    this.authority = a;
    for (const [id, row] of this.byToken) await this.issueGrant(id, row);
    const drop = async (ref: string) => {
      for (const [id] of [...this.byToken]) {
        if (id.slice(0, 32) === ref) {
          this.byToken.delete(id);
          await this.flush();
        }
      }
    };
    a.owner.onRevoked(drop);
    a.companion.onRevoked(drop);
  }

  /** The opaque id a bearer is known by: its SHA-256. The bearer itself is never kept. */
  static idOf(token: string): string {
    return pairedSessionId(token);
  }

  private async issueGrant(id: string, row: PairedSession): Promise<void> {
    const a = this.authority;
    if (!a) return;
    const fam = row.companion ? a.companion : a.owner;
    await fam.adopt({
      ref: id.slice(0, 32),
      parents: a.parentOf(),
      capability: row.companion ? "read" : "owner",
      expiresAt: row.companion ? row.expiresAt ?? null : null,
      issuedAt: row.addedAt,
    });
  }

  /** Read on boot; safe to call multiple times. */
  async load(): Promise<void> {
    if (!existsSync(this.path)) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const legacy = parsed.v !== 2;
      const rows = (legacy ? parsed : parsed.sessions) as Record<string, PairedSession>;
      this.byToken.clear();
      for (const [key, info] of Object.entries(rows ?? {})) {
        if (typeof info?.addedAt === "number") {
          const row: PairedSession = { addedAt: info.addedAt };
          if (info.companion === true) row.companion = true;
          if (typeof info.expiresAt === "number") row.expiresAt = info.expiresAt;
          if (typeof info.companionUserAgent === "string") {
            row.companionUserAgent = info.companionUserAgent;
          }
          // A file from before kept the bearer itself as the key: hash it now and rewrite.
          this.byToken.set(legacy ? FilePairedSessionStore.idOf(key) : key, row);
        }
      }
      if (legacy && this.byToken.size > 0) await this.flush();
    } catch {
      // Treat unreadable / malformed as empty — better than failing boot.
    }
  }

  async add(token: string, addedAt: number = Date.now()): Promise<void> {
    if (!token || token.length < 16) throw new Error("token too short");
    const id = FilePairedSessionStore.idOf(token);
    this.byToken.set(id, { addedAt });
    await this.issueGrant(id, { addedAt });
    await this.flush();
  }

  /**
   * P14 — add a companion session. Same on-disk row shape as owner
   * sessions, but flagged + scoped with an `expiresAt`. The gate
   * `check()` rejects companion rows past their expiry.
   */
  async addCompanion(args: {
    token: string;
    addedAt: number;
    expiresAt: number;
    userAgent?: string | null;
  }): Promise<void> {
    if (!args.token || args.token.length < 16) throw new Error("token too short");
    const row: PairedSession = {
      addedAt: args.addedAt,
      companion: true,
      expiresAt: args.expiresAt,
    };
    if (args.userAgent) row.companionUserAgent = args.userAgent;
    const id = FilePairedSessionStore.idOf(args.token);
    this.byToken.set(id, row);
    await this.issueGrant(id, row);
    await this.flush();
  }

  /** P14 — fetch the row for a token, including companion fields. */
  get(token: string): PairedSession | null {
    const r = this.byToken.get(FilePairedSessionStore.idOf(token));
    return r ? { ...r } : null;
  }

  /**
   * P14 — list companion sessions only. Drops rows whose `expiresAt`
   * is in the past — the gate has already rejected them, but the list
   * view should never render a row the owner can't successfully
   * revoke. (Revoke still works on stale rows; they're harmless.)
   */
  listCompanions(nowMs: number = this.now()): Array<{
    /** Opaque id (hash prefix); revoke with {@link removeByIdPrefix}. */
    id: string;
    addedAt: number;
    expiresAt: number;
    userAgent?: string;
  }> {
    const out: Array<{
      id: string;
      addedAt: number;
      expiresAt: number;
      userAgent?: string;
    }> = [];
    for (const [id, info] of this.byToken) {
      if (!info.companion) continue;
      if (typeof info.expiresAt !== "number") continue;
      if (info.expiresAt <= nowMs) continue;
      const row: {
        id: string;
        addedAt: number;
        expiresAt: number;
        userAgent?: string;
      } = {
        id: id.slice(0, 16),
        addedAt: info.addedAt,
        expiresAt: info.expiresAt,
      };
      if (info.companionUserAgent) row.userAgent = info.companionUserAgent;
      out.push(row);
    }
    // Newest companions first; the owner mostly cares about recent docks.
    out.sort((a, b) => b.addedAt - a.addedAt);
    return out;
  }

  /** Revoke the index grants for sessions being removed, so work running under them stops too. */
  private async revokeGrants(rows: Array<[string, PairedSession]>, reason: string): Promise<void> {
    const a = this.authority;
    if (!a) return;
    for (const [id, row] of rows) {
      await (row.companion ? a.companion : a.owner).revoke(id.slice(0, 32), reason).catch(() => {});
    }
  }

  async remove(token: string): Promise<void> {
    await this.removeId(FilePairedSessionStore.idOf(token));
  }

  private async removeId(id: string): Promise<void> {
    const row = this.byToken.get(id);
    if (this.byToken.delete(id)) {
      await this.flush();
      if (row) await this.revokeGrants([[id, row]], "session removed");
    }
  }

  /** Remove the one session whose opaque id starts with `prefix`; reports how many matched. */
  async removeByIdPrefix(prefix: string): Promise<"removed" | "none" | "ambiguous"> {
    const matches = [...this.byToken.keys()].filter((id) => id.startsWith(prefix));
    if (matches.length === 0) return "none";
    if (matches.length > 1) return "ambiguous";
    await this.removeId(matches[0]!);
    return "removed";
  }

  /**
   * Drop every paired session. Used by the J.3 re-pair watcher after a
   * successful IRK swap — paired sessions were authorized by the OLD
   * phone, so a recovered/replaced phone must re-pair every browser
   * before it can act again. Returns the count of removed entries so
   * the watcher can include it in its report.
   */
  async removeAll(): Promise<number> {
    const n = this.byToken.size;
    if (n === 0) return 0;
    const rows = [...this.byToken];
    this.byToken.clear();
    await this.flush();
    await this.revokeGrants(rows, "every paired session removed");
    return n;
  }

  /** Drop every companion (Remote) session, keeping the owner's. Returns how many went. */
  async removeCompanions(): Promise<number> {
    let n = 0;
    const gone: Array<[string, PairedSession]> = [];
    for (const [id, row] of this.byToken) {
      if (row.companion === true) {
        this.byToken.delete(id);
        gone.push([id, row]);
        n++;
      }
    }
    if (n > 0) {
      await this.flush();
      await this.revokeGrants(gone, "remote sessions removed");
    }
    return n;
  }

  list(): Array<{ id: string; addedAt: number; companion?: true; expiresAt?: number }> {
    return [...this.byToken.entries()].map(([id, info]) => ({
      id: id.slice(0, 16),
      addedAt: info.addedAt,
      ...(info.companion ? { companion: true as const } : {}),
      ...(typeof info.expiresAt === "number" ? { expiresAt: info.expiresAt } : {}),
    }));
  }

  /** The grant ref of a live Remote session by the id the owner's session list shows, else null. */
  companionRefByListedId(listedId: string): { ref: string; expiresAt: number | null } | null {
    for (const [id, info] of this.byToken) {
      if (info.companion && id.slice(0, 16) === listedId) return { ref: id.slice(0, 32), expiresAt: typeof info.expiresAt === "number" ? info.expiresAt : null };
    }
    return null;
  }

  has(token: string): boolean {
    return this.byToken.has(FilePairedSessionStore.idOf(token));
  }

  /** PairedSessionGate.check */
  check(req: HttpRequest): HttpResponse | null {
    const token = extractPairedSessionToken(req);
    if (!token) return jerr(401, "missing paired-session token");
    const id = FilePairedSessionStore.idOf(token);
    const row = this.byToken.get(id);
    if (!row) return jerr(401, "invalid paired-session token");
    if (this.authority) {
      const fam = row.companion ? this.authority.companion : this.authority.owner;
      if (!fam.isLive(id.slice(0, 32))) return jerr(401, "paired-session token revoked");
    }
    // P14 — companion sessions hard-expire at `expiresAt`. The gate
    // surfaces a recognisable 401 reason so the webapp can prompt the
    // user to re-dock instead of treating it like an invalid token.
    if (row.companion === true && typeof row.expiresAt === "number") {
      if (row.expiresAt <= this.now()) {
        return jerr(401, "companion session expired");
      }
    }
    return null;
  }

  /**
   * P14 — companion-write enforcement: returns true when `req` is
   * carrying a paired-session token that resolves to a companion row.
   * Handlers that perform signed-envelope writes (release-server,
   * revoke-server, set-env, etc.) check this and return 403 with the
   * `companion-write-not-allowed` code.
   *
   * NOTE: this is "is the *caller* a companion?" — it has NOTHING to
   * do with whether the request body itself is signed. The gate
   * already authenticated the request; this is a write-scope check on
   * top of that.
   */
  isCompanionRequest(req: HttpRequest): boolean {
    const token = extractPairedSessionToken(req);
    if (!token) return false;
    const row = this.byToken.get(FilePairedSessionStore.idOf(token));
    return row?.companion === true;
  }

  private flushing: Promise<void> = Promise.resolve();

  /** Writes run one at a time: two at once shared the .tmp file, and the
   *  second rename failed with ENOENT (a 500 on a concurrent pairing). */
  private flush(): Promise<void> {
    const run = this.flushing.then(
      () => this.flushNow(),
      () => this.flushNow(),
    );
    this.flushing = run.catch(() => {});
    return run;
  }

  private async flushNow(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const sessions: Record<string, PairedSession> = {};
    for (const [id, info] of this.byToken) sessions[id] = { ...info };
    await writeFileDurable(this.path, JSON.stringify({ v: 2, sessions }, null, 2));
  }
}

/**
 * Extract a paired-session token from any of three carriers:
 *   - `Authorization: Flagship-Session <token>` — original phone-side
 *     scheme.
 *   - `x-flagship-session: <token>` — easier for the webapp / fetch
 *     callers; can't be set on `new WebSocket()`.
 *   - `?sessionToken=<token>` — required for browser-initiated
 *     WebSocket upgrades (which can't carry custom request headers).
 *
 * Returns the raw token string or null if none was supplied.
 */
export function extractPairedSessionToken(req: HttpRequest): string | null {
  const auth = req.headers["authorization"] ?? req.headers["Authorization"];
  if (typeof auth === "string" && auth.startsWith("Flagship-Session ")) {
    const t = auth.slice("Flagship-Session ".length).trim();
    if (t) return t;
  }
  const x = req.headers["x-flagship-session"] ?? req.headers["X-Flagship-Session"];
  if (typeof x === "string" && x.length > 0) return x;
  const qIdx = req.path.indexOf("?");
  if (qIdx >= 0) {
    const sp = new URLSearchParams(req.path.slice(qIdx + 1));
    const t = sp.get("sessionToken");
    if (t) return t;
  }
  return null;
}

const J = { "content-type": "application/json" } as const;
function jerr(status: number, message: string): HttpResponse {
  return { status, headers: J, body: JSON.stringify({ error: message }) };
}

export function defaultPairedSessionPath(dataDir: string): string {
  return join(dataDir, "paired-sessions.json");
}
