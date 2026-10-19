/**
 * GET /api/relay-hints: the maintainer-signed list of the relay's well-known
 * addresses, docs/relay-hints.md. An advisory the apps use only when DNS fails;
 * a box is still authenticated by TLS to its own name, so `.com` carrying a
 * wrong list can at worst make the fallback fail, never read anyone's traffic.
 *
 * One static document for everybody, like /api/notices: no auth, no username,
 * device id or version in the request, no cookie, nothing logged per caller
 * (not even a counter: apps fetch it at most daily and it is cacheable).
 * The response carries the public ca-track mandate log the app needs to find
 * the current authority; it authenticates itself against the baked pin.
 *
 * Nothing signed answers 204.
 */

// The committed hint: a signed object, or null. Bundled at build time, so
// publishing one is a commit plus a deploy.
import committedHint from "../../../.maintainers/relay-hints/current.json";
import { caTrustChainPublicMaterial } from "./caTrustChainLoader.js";

export const RELAY_HINTS_PATH = "/api/relay-hints";

export function isRelayHintsPath(pathname: string): boolean {
  return pathname === RELAY_HINTS_PATH;
}

const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";

export interface RelayHintsDeps {
  /** Tests inject a hint; production serves the committed one. */
  hint?: unknown;
  mandates?: readonly unknown[];
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

async function build(deps: RelayHintsDeps): Promise<Built> {
  const hint = "hint" in deps ? deps.hint : (committedHint as unknown);
  if (hint === null || hint === undefined) return { status: 204, body: "", etag: '"none"' };
  const mandates = deps.mandates ?? caTrustChainPublicMaterial().mandates;
  const body = JSON.stringify({ version: 1, hint, mandates });
  return { status: 200, body, etag: `"${(await sha256Hex(body)).slice(0, 32)}"` };
}

function built(deps: RelayHintsDeps): Promise<Built> {
  if ("hint" in deps || "mandates" in deps) return build(deps);
  builtDefault ??= build({});
  return builtDefault;
}

/** Test seam: forget the built default. */
export function resetRelayHintsState(): void {
  builtDefault = null;
}

export async function handleRelayHints(request: Request, deps: RelayHintsDeps = {}): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, HEAD" },
    });
  }
  const b = await built(deps);
  const headers: Record<string, string> = { "cache-control": CACHE_CONTROL, etag: b.etag };
  // The only request header read. It is the same for every caller of one deploy.
  if (request.headers.get("if-none-match") === b.etag) return new Response(null, { status: 304, headers });
  if (b.status === 204) return new Response(null, { status: 204, headers });
  headers["content-type"] = "application/json; charset=utf-8";
  return new Response(method === "HEAD" ? null : b.body, { status: 200, headers });
}
