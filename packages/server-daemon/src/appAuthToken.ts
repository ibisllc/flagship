/**
 * Per-app daemon-API auth tokens.
 *
 * App containers calling back to the daemon (e.g. `POST /api/browser/tabs`)
 * authenticate with `Authorization: Bearer <FLAGSHIP_APP_TOKEN>`. The
 * daemon mints a 32-byte random token at install time, injects it as the
 * `FLAGSHIP_APP_TOKEN` env var, and resolves the bearer back to an
 * appId on every request.
 *
 * This is a **separate boundary** from the existing daemon→app
 * identity-injection signature (X-Flagship-Signature, used to tell the
 * app *who the user is* on inbound traffic). Tokens here are about the
 * **app's own identity** when calling the daemon — answering "which
 * tenant is making this request?", which TabRegistry / DomainGate need
 * to enforce isolation.
 *
 * Tokens persist to disk so the daemon's lookup map survives restarts.
 * If the file is lost, the in-memory map can also be reseeded — but
 * the running container's env still holds the token, so a re-mint
 * would invalidate it. The persistence is therefore load-bearing.
 *
 * Tokens are revoked by deleting the entry — happens on uninstall and
 * on explicit revoke (rare; reserved for compromised-app scenarios).
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AppAuthTokens {
  /** Mint a new token for `appId`. Overwrites any existing token. */
  mint(appId: string): Promise<string>;
  /** Look up the appId behind a bearer token, or null if unknown. */
  resolve(token: string): Promise<string | null>;
  /** Drop the token for an app (called on uninstall). Idempotent. */
  forget(appId: string): Promise<void>;
  /** Read the current token for an app — useful for tests + env injection. */
  tokenForApp(appId: string): Promise<string | null>;
}

/**
 * In-memory implementation. Loses state across restarts; suitable for
 * tests and for ephemeral test daemons. Production should use the
 * file-backed variant below.
 */
export class InMemoryAppAuthTokens implements AppAuthTokens {
  private byToken = new Map<string, string>();
  private byAppId = new Map<string, string>();

  async mint(appId: string): Promise<string> {
    const existing = this.byAppId.get(appId);
    if (existing) {
      this.byToken.delete(existing);
    }
    const token = generateToken();
    this.byToken.set(token, appId);
    this.byAppId.set(appId, token);
    return token;
  }

  async resolve(token: string): Promise<string | null> {
    return this.byToken.get(token) ?? null;
  }

  async forget(appId: string): Promise<void> {
    const t = this.byAppId.get(appId);
    if (t) {
      this.byToken.delete(t);
      this.byAppId.delete(appId);
    }
  }

  async tokenForApp(appId: string): Promise<string | null> {
    return this.byAppId.get(appId) ?? null;
  }
}

/**
 * File-backed write-through cache. Production default. One file per app
 * under `<dir>/<appId>.token` containing just the token string. On
 * construction call `load()` to populate the in-memory maps.
 */
export class FileAppAuthTokens implements AppAuthTokens {
  private byToken = new Map<string, string>();
  private byAppId = new Map<string, string>();

  constructor(private readonly dir: string) {}

  /** Read all persisted tokens off disk into the cache. Call once on boot. */
  async load(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".token")) continue;
      const appId = f.slice(0, -".token".length);
      try {
        const token = (await readFile(join(this.dir, f), "utf8")).trim();
        if (token) {
          this.byToken.set(token, appId);
          this.byAppId.set(appId, token);
        }
      } catch {
        // ignore unreadable entries; missing tokens just mean the app
        // has to be reinstalled — better than refusing to boot.
      }
    }
  }

  async mint(appId: string): Promise<string> {
    if (!existsSync(this.dir)) await mkdir(this.dir, { recursive: true });
    const existing = this.byAppId.get(appId);
    if (existing) this.byToken.delete(existing);
    const token = generateToken();
    const file = join(this.dir, `${appId}.token`);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, token, { mode: 0o600 });
    await rename(tmp, file);
    this.byToken.set(token, appId);
    this.byAppId.set(appId, token);
    return token;
  }

  async resolve(token: string): Promise<string | null> {
    return this.byToken.get(token) ?? null;
  }

  async forget(appId: string): Promise<void> {
    const t = this.byAppId.get(appId);
    if (t) {
      this.byToken.delete(t);
      this.byAppId.delete(appId);
    }
    const file = join(this.dir, `${appId}.token`);
    await rm(file, { force: true });
  }

  async tokenForApp(appId: string): Promise<string | null> {
    return this.byAppId.get(appId) ?? null;
  }
}

function generateToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}
