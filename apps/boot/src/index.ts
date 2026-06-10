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
  /**
   * Service binding to the identity-plane worker (flagship-com in the
   * reference deployment). REQUIRED when the identity plane is a Worker on
   * the SAME zone as this one — a same-zone Worker→Worker call over the
   * public hostname is not re-dispatched to the target worker (it returns a
   * CF error page), so the directory + notify HTTP reads must go through this
   * binding instead. Absent ⇒ fall back to the global fetch + IDENTITY_PLANE_URL
   * (correct only when the identity plane is on a different zone / origin).
   */
  IDENTITY_PLANE?: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
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
    // Same-zone identity plane → call it through the service binding (the
    // public-hostname fetch is not re-dispatched to the worker). Different-zone
    // clones leave IDENTITY_PLANE unset and use the global fetch.
    const planeFetch: typeof fetch | undefined = env.IDENTITY_PLANE
      ? ((input: RequestInfo | URL, init?: RequestInit) => env.IDENTITY_PLANE!.fetch(input, init)) as typeof fetch
      : undefined;
    const directory = new HttpDirectoryClient({ identityPlaneUrl: env.IDENTITY_PLANE_URL, apex, fetchImpl: planeFetch });
    const notify: NotifyPipe = env.NOTIFY_SHARED_SECRET
      ? new HttpNotifyPipe({ identityPlaneUrl: env.IDENTITY_PLANE_URL, sharedSecret: env.NOTIFY_SHARED_SECRET, fetchImpl: planeFetch })
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
