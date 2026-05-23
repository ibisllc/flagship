/**
 * boot.flagshipserver.com — the dedicated, cloneable boot worker.
 *
 * Owns the BOOT operations (auto-unlock lease release + the phone-gated
 * approval relay) that were previously served by the identity plane. The
 * identity plane keeps identity/state (push tokens, APNs/FCM/VAPID keys,
 * the canonical id-cert directory, the phone-sealed-luks-key set at
 * install); the boot worker holds only ciphertext leases/responses + a
 * single-use nonce store, and reaches the phone via the NOTIFY PIPE — an
 * authenticated server-to-server call to the identity plane that does
 * hold the push secrets.
 *
 * Cloneable: an enterprise sets IDENTITY_PLANE_URL + NOTIFY_SHARED_SECRET
 * + a D1 binding, deploys, and points its boxes/phones at this worker.
 * No flagship-specific value is hardcoded.
 */

import { D1BoxSealedLeaseStorage, D1SecretMailboxStorage, type D1Database } from "@flagship/storage";
import { HttpDirectoryClient } from "./directory.js";
import { HttpNotifyPipe, NoopNotifyPipe, type NotifyPipe } from "./notify.js";
import { D1NonceStore, InMemoryNonceStore, type NonceStore } from "./nonceStore.js";
import { routeBoot, type BootRouteDeps } from "./routes.js";
import { AUTH_HEADER } from "./gate.js";

export interface BootEnv {
  /** D1 binding for the box-sealed leases + secret mailbox + nonce store. */
  DB?: D1Database;
  /**
   * Base URL of the identity plane (flagshipserver.com in the reference
   * deployment). Used for the canonical id-cert reads + the notify pipe.
   * REQUIRED — without it the worker can't bind principals or push.
   */
  IDENTITY_PLANE_URL?: string;
  /**
   * Shared secret for the server-to-server notify call to
   * {IDENTITY_PLANE_URL}/api/internal/notify-owner. Set on BOTH this
   * worker and the identity plane (matching values). When unset the
   * worker still serves lease/relay traffic, but no push fires.
   */
  NOTIFY_SHARED_SECRET?: string;
  /**
   * The apex this deployment serves under, e.g. "flagship.services".
   * Used to derive the account username from a box FQDN
   * (`<server>.<user>.<apex>`). Defaults to "flagship.services".
   */
  FLAGSHIP_APEX?: string;
}

export default {
  async fetch(request: Request, env: BootEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health") {
      return json({ ok: true, service: "flagship-boot" }, 200);
    }
    if (!path.startsWith("/api/boot/")) {
      return json({ error: "not found" }, 404);
    }
    if (!env.IDENTITY_PLANE_URL) {
      return json({ error: "boot worker not configured (IDENTITY_PLANE_URL)" }, 503);
    }
    if (!env.DB) {
      return json({ error: "boot worker not configured (DB)" }, 503);
    }

    const apex = env.FLAGSHIP_APEX ?? "flagship.services";
    const directory = new HttpDirectoryClient({ identityPlaneUrl: env.IDENTITY_PLANE_URL, apex });
    const notify: NotifyPipe = env.NOTIFY_SHARED_SECRET
      ? new HttpNotifyPipe({ identityPlaneUrl: env.IDENTITY_PLANE_URL, sharedSecret: env.NOTIFY_SHARED_SECRET })
      : new NoopNotifyPipe();
    const nonces: NonceStore = env.DB ? new D1NonceStore(env.DB) : new InMemoryNonceStore();

    const deps: BootRouteDeps = {
      boxSealedLeases: new D1BoxSealedLeaseStorage(env.DB),
      secretMailbox: new D1SecretMailboxStorage(env.DB),
      directory,
      notify,
      gate: { directory, nonces },
    };

    const authHeader = request.headers.get(AUTH_HEADER);
    const body = await readJson(request);
    const result = await routeBoot(deps, request.method, path, authHeader, body);
    if (!result) return json({ error: "not found" }, 404);
    return json(result.body, result.status);
  },
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Rule 5 — never cache a boot response (leases/responses are
      // single-use and account-scoped).
      "cache-control": "no-store",
    },
  });
}

async function readJson(request: Request): Promise<unknown> {
  const m = request.method.toUpperCase();
  if (m === "GET" || m === "HEAD") return undefined;
  const text = await request.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
