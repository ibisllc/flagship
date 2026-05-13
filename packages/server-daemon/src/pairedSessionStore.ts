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
}

export class FilePairedSessionStore implements PairedSessionGate {
  private byToken = new Map<string, PairedSession>();

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
          this.byToken.set(tok, { label: info.label, addedAt: info.addedAt });
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
    if (!this.byToken.has(token)) return jerr(401, "invalid paired-session token");
    return null;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const obj: Record<string, PairedSession> = {};
    for (const [t, info] of this.byToken) obj[t] = info;
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
