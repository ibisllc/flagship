/**
 * GET /api/notices: the maintainer-signed security notice, docs/security-notices.md.
 *
 * One static document for everybody, so a caller is nobody: no auth, no
 * username, device id or app version in the request, no cookie read or set,
 * nothing logged per caller. The only thing recorded is a daily total
 * (D1 `meter_counters`, account `_system`, resource `notice-fetch`), written
 * in batches. The apps decide locally whether a notice applies to them.
 *
 * `.com` only CARRIES the notice. The signature is the cold ca-track
 * maintainer's (scripts/security-notice.mjs), checked by every app against
 * its baked pin, so a compromised `.com` can drop the notice or replay an
 * old one (fail open, and expiry caps a replay at 30 days) but cannot forge
 * a lock. The response includes the public ca-track mandate log the app
 * needs to find the current authority; it authenticates itself against the
 * pin, as `/api/maintainer-blessing` does.
 *
 * Nothing in force answers 204.
 */

import type { D1Database } from "@flagship/storage";
// The committed notice: a signed notice object, or null for none. Bundled
// at build time, so publishing one is a commit plus a deploy.
import committedNotice from "../../../.maintainers/notices/current.json";
import { caTrustChainPublicMaterial } from "./caTrustChainLoader.js";
import type { WaitUntilLike } from "./adapterIndex.js";

export const SECURITY_NOTICES_PATH = "/api/notices";

export function isSecurityNoticesPath(pathname: string): boolean {
  return pathname === SECURITY_NOTICES_PATH;
}

const CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=3600";
const COUNTER_FLUSH_MS = 60_000;

export interface SecurityNoticesEnv {
  DB?: D1Database;
}

export interface SecurityNoticesDeps {
  /** Tests inject a notice; production serves the committed one. */
  notice?: unknown;
  mandates?: readonly unknown[];
  now?: () => number;
}

interface Built {
  status: 200 | 204;
  body: string;
  etag: string;
}

let builtDefault: Promise<Built> | null = null;

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

async function build(deps: SecurityNoticesDeps): Promise<Built> {
  const notice = "notice" in deps ? deps.notice : (committedNotice as unknown);
  if (notice === null || notice === undefined) {
    return { status: 204, body: "", etag: '"none"' };
  }
  const mandates = deps.mandates ?? caTrustChainPublicMaterial().mandates;
  const body = JSON.stringify({ version: 1, notice, mandates });
  return { status: 200, body, etag: `"${(await sha256Hex(body)).slice(0, 32)}"` };
}

function built(deps: SecurityNoticesDeps): Promise<Built> {
  if ("notice" in deps || "mandates" in deps) return build(deps);
  builtDefault ??= build({});
  return builtDefault;
}

let pending = 0;
let lastFlush = 0;

/** Day bucket, UTC. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Count one fetch. Totals only: in-memory, flushed to D1 at most once a
 * minute per isolate. Never throws, never blocks the response.
 */
export function countNoticeFetch(
  db: D1Database | undefined,
  ctx: WaitUntilLike | undefined,
  now: number,
): void {
  pending += 1;
  if (!db || now - lastFlush < COUNTER_FLUSH_MS) return;
  const n = pending;
  pending = 0;
  lastFlush = now;
  try {
    const write = db
      .prepare(
        "INSERT INTO meter_counters (account, resource, period, amount, updated_at) VALUES ('_system', 'notice-fetch', ?, ?, ?) " +
          "ON CONFLICT(account, resource, period) DO UPDATE SET amount = amount + excluded.amount, updated_at = excluded.updated_at",
      )
      .bind(dayOf(now), n, now)
      .run()
      .catch((err: unknown) => {
        console.warn("securityNotices: counter write failed", (err as Error).message);
      });
    ctx?.waitUntil(write);
  } catch (err) {
    console.warn("securityNotices: counter write failed", (err as Error).message);
  }
}

/** Test seam: forget the in-memory counter and the built default. */
export function resetSecurityNoticesState(): void {
  pending = 0;
  lastFlush = 0;
  builtDefault = null;
}

export async function handleSecurityNotices(
  request: Request,
  env: SecurityNoticesEnv,
  ctx?: WaitUntilLike,
  deps: SecurityNoticesDeps = {},
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, HEAD" },
    });
  }
  if (method === "GET") countNoticeFetch(env.DB, ctx, (deps.now ?? Date.now)());

  const b = await built(deps);
  const headers: Record<string, string> = {
    "cache-control": CACHE_CONTROL,
    etag: b.etag,
  };
  // The only request header read. It is the same for every caller of one deploy.
  if (request.headers.get("if-none-match") === b.etag) return new Response(null, { status: 304, headers });
  if (b.status === 204) return new Response(null, { status: 204, headers });
  headers["content-type"] = "application/json; charset=utf-8";
  return new Response(method === "HEAD" ? null : b.body, { status: 200, headers });
}
