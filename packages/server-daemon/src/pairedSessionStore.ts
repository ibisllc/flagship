/**
 * Persistent paired-session token store. Replaces the in-memory
 * `TokenSetSessionGate` for production use; survives daemon restarts
 * so phone-paired browsers don't have to re-pair after a reboot.
 *
 * Tokens are minted by the phone (random 32-byte hex is the usual
 * choice) and added via the `add-paired-session` PhoneOrder. The
 * daemon stores them with a human-readable label and emit timestamp;
 * the host can list + revoke specific entries from the phone.
 *
 * On-disk layout: a single JSON file at `<dataDir>/paired-sessions.json`
 * holding `{[token]: {label, addedAt}}`. Atomic write-then-rename keeps
 * it crash-safe; concurrent writes from a single phone are serialized
 * by the orders handler so there's no contention.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HttpRequest, HttpResponse } from "./runtime.js";
import type { PairedSessionGate } from "./alertInboxHttp.js";

export interface PairedSession {
  label: string;
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
  /** Optional human label captured at redeem time (e.g. "Library iMac"). */
  companionLabel?: string;
  /** Best-effort User-Agent at redeem time, for the owner's list view. */
  companionUserAgent?: string;
}

export class FilePairedSessionStore implements PairedSessionGate {
  private byToken = new Map<string, PairedSession>();
  /**
   * Test seam — the gate consults this for the "is the companion still
   * within its 4-hour TTL?" question. Production leaves it as Date.now;
   * tests inject a controllable clock.
   */
  now: () => number = () => Date.now();

  constructor(private readonly path: string) {}

  /** Read on boot; safe to call multiple times. */
  async load(): Promise<void> {
    if (!existsSync(this.path)) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, PairedSession>;
      this.byToken.clear();
      for (const [tok, info] of Object.entries(parsed)) {
        if (typeof info?.label === "string" && typeof info.addedAt === "number") {
          const row: PairedSession = { label: info.label, addedAt: info.addedAt };
          if (info.companion === true) row.companion = true;
          if (typeof info.expiresAt === "number") row.expiresAt = info.expiresAt;
          if (typeof info.companionLabel === "string") row.companionLabel = info.companionLabel;
          if (typeof info.companionUserAgent === "string") {
            row.companionUserAgent = info.companionUserAgent;
          }
          this.byToken.set(tok, row);
        }
      }
    } catch {
      // Treat unreadable / malformed as empty — better than failing boot.
    }
  }

  async add(token: string, label: string, addedAt: number = Date.now()): Promise<void> {
    if (!token || token.length < 16) throw new Error("token too short");
    this.byToken.set(token, { label, addedAt });
    await this.flush();
  }

  /**
   * P14 — add a companion session. Same on-disk row shape as owner
   * sessions, but flagged + scoped with an `expiresAt`. The gate
   * `check()` rejects companion rows past their expiry.
   */
  async addCompanion(args: {
    token: string;
    label: string | null;
    addedAt: number;
    expiresAt: number;
    userAgent?: string | null;
  }): Promise<void> {
    if (!args.token || args.token.length < 16) throw new Error("token too short");
    const row: PairedSession = {
      // The label column is the human label rendered in the
      // paired-sessions list. We mirror the companion label here so
      // existing callers (UI / removeAll on recovery) keep working.
      label: args.label ?? "companion",
      addedAt: args.addedAt,
      companion: true,
      expiresAt: args.expiresAt,
    };
    if (args.label) row.companionLabel = args.label;
    if (args.userAgent) row.companionUserAgent = args.userAgent;
    this.byToken.set(args.token, row);
    await this.flush();
  }

  /** P14 — fetch the row for a token, including companion fields. */
  get(token: string): PairedSession | null {
    const r = this.byToken.get(token);
    return r ? { ...r } : null;
  }

  /**
   * P14 — list companion sessions only. Drops rows whose `expiresAt`
   * is in the past — the gate has already rejected them, but the list
   * view should never render a row the owner can't successfully
   * revoke. (Revoke still works on stale rows; they're harmless.)
   */
  listCompanions(nowMs: number = this.now()): Array<{
    token: string;
    label: string | null;
    addedAt: number;
    expiresAt: number;
    userAgent?: string;
  }> {
    const out: Array<{
      token: string;
      label: string | null;
      addedAt: number;
      expiresAt: number;
      userAgent?: string;
    }> = [];
    for (const [token, info] of this.byToken) {
      if (!info.companion) continue;
      if (typeof info.expiresAt !== "number") continue;
      if (info.expiresAt <= nowMs) continue;
      const row: {
        token: string;
        label: string | null;
        addedAt: number;
        expiresAt: number;
        userAgent?: string;
      } = {
        token,
        label: info.companionLabel ?? null,
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

  async remove(token: string): Promise<void> {
    if (this.byToken.delete(token)) {
      await this.flush();
    }
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
    this.byToken.clear();
    await this.flush();
    return n;
  }

  list(): Array<{ token: string; label: string; addedAt: number }> {
    return [...this.byToken.entries()].map(([token, info]) => ({
      token,
      label: info.label,
      addedAt: info.addedAt,
    }));
  }

  has(token: string): boolean {
    return this.byToken.has(token);
  }

  /** PairedSessionGate.check */
  check(req: HttpRequest): HttpResponse | null {
    const token = extractPairedSessionToken(req);
    if (!token) return jerr(401, "missing paired-session token");
    const row = this.byToken.get(token);
    if (!row) return jerr(401, "invalid paired-session token");
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
    const row = this.byToken.get(token);
    return row?.companion === true;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const obj: Record<string, PairedSession> = {};
    for (const [t, info] of this.byToken) obj[t] = { ...info };
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
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
