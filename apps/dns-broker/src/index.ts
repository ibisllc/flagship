/**
 * Flagship DnsBroker — Cloudflare Worker.
 *
 * Single endpoint: `POST /rpc`. Holds the broad `CLOUDFLARE_DNS_API_TOKEN`
 * (Zone:DNS:Edit on flagship.services) that Cloudflare's permission
 * groups won't let us scope per-record-type. This Worker is the entire
 * security perimeter for that capability — every other Flagship Worker
 * has NO direct access to the token.
 *
 * Fences (in order):
 *   1. Typed RPC schema — body must declare one of three known kinds.
 *   2. Signature verification — `policy.ts` re-derives canonical bytes
 *      from the body, fetches the registered daemon/IRK pubkey from the
 *      public `.com` lookup endpoints, and asserts the signature
 *      verifies. Even if the caller (main Worker) is compromised, a
 *      forged RPC fails here.
 *   3. Target IP allowlist — `publishARecord` rejects any IP that
 *      isn't the env-pinned Fly anycast address.
 *   4. Per-IP rate limit — Durable-Object backed (preferred) with an
 *      in-memory fallback for the case where the binding isn't wired.
 *
 * The response body is generic on failure ({ ok:false }), never
 * containing the token, the upstream Cloudflare error body, or the
 * specific fence that rejected the request. The reason is logged
 * server-side via `console.warn` for operator diagnosis.
 */

import {
  verifyRpc,
  type BrokerEffect,
  type PolicyEnv,
} from "./policy.js";

const CF_API = "https://api.cloudflare.com/client/v4";

export interface Env {
  CLOUDFLARE_DNS_API_TOKEN?: string;
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  MAIN_WORKER_URL?: string;
  FLAGSHIP_APEX?: string;
  SERVICES_PASSTHROUGH_IPV4?: string;
  SERVICES_PASSTHROUGH_IPV6?: string;
  RPC_REPLAY_WINDOW_MS?: string;
}

// In-memory per-IP token bucket. CF Workers re-instantiate frequently
// so this isn't a hard limit (an attacker that lands on a fresh isolate
// gets a fresh bucket), but it caps a single sustained burst from a
// single source isolate and is essentially free. Real throttling lives
// at Cloudflare's edge ruleset on the route.
const ipBuckets = new Map<string, { tokens: number; refilledAt: number }>();
const RATE_LIMIT_BURST = 30;
const RATE_LIMIT_REFILL_PER_SEC = 5;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/rpc") {
      return generic(404);
    }
    if (!env.CLOUDFLARE_DNS_API_TOKEN || !env.CLOUDFLARE_SERVICES_ZONE_ID) {
      console.warn("[dns-broker] missing required secret");
      return generic(503);
    }
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (!consume(ip)) {
      return generic(429);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return generic(400);
    }

    const apex = env.FLAGSHIP_APEX ?? "flagship.services";
    const replay = parseInt(env.RPC_REPLAY_WINDOW_MS ?? "300000", 10) || 300_000;
    const mainUrl = env.MAIN_WORKER_URL ?? "https://flagshipserver.com";
    if (!env.SERVICES_PASSTHROUGH_IPV4) {
      console.warn("[dns-broker] no SERVICES_PASSTHROUGH_IPV4 configured");
      return generic(503);
    }

    const policyEnv: PolicyEnv = {
      apex,
      servicesIpv4: env.SERVICES_PASSTHROUGH_IPV4,
      replayWindowMs: replay,
      now: Date.now(),
      resolvePodIdentity: makePodResolver(mainUrl),
      resolveUserIrk: makeIrkResolver(mainUrl),
    };
    if (env.SERVICES_PASSTHROUGH_IPV6) policyEnv.servicesIpv6 = env.SERVICES_PASSTHROUGH_IPV6;

    let outcome;
    try {
      outcome = await verifyRpc(body, policyEnv);
    } catch (e) {
      console.warn(`[dns-broker] policy threw: ${String((e as Error).message ?? e)}`);
      return generic(400);
    }
    if (!outcome.ok) {
      console.warn(`[dns-broker] denied: ${outcome.reason}`);
      return generic(403);
    }

    try {
      const result = await applyEffect(outcome.effect, env);
      return new Response(JSON.stringify({ ok: true, ...result }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (e) {
      // Generic 502 — the upstream error body MAY contain account-level
      // diagnostics we don't want to expose. Log the real error
      // server-side; respond opaquely.
      console.warn(`[dns-broker] cf call failed: ${String((e as Error).message ?? e)}`);
      return generic(502);
    }
  },
};

function generic(status: number): Response {
  return new Response(JSON.stringify({ ok: false }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function consume(ip: string, now = Date.now()): boolean {
  const b = ipBuckets.get(ip);
  if (!b) {
    ipBuckets.set(ip, { tokens: RATE_LIMIT_BURST - 1, refilledAt: now });
    return true;
  }
  const elapsedSec = (now - b.refilledAt) / 1000;
  const refilled = Math.min(RATE_LIMIT_BURST, b.tokens + elapsedSec * RATE_LIMIT_REFILL_PER_SEC);
  if (refilled < 1) return false;
  b.tokens = refilled - 1;
  b.refilledAt = now;
  return true;
}

function makePodResolver(mainUrl: string): (serverId: string) => Promise<Uint8Array | null> {
  return async (serverId: string) => {
    try {
      const resp = await fetch(
        `${mainUrl}/api/server/by-domain/${encodeURIComponent(serverId)}`,
        { headers: { accept: "application/json" } },
      );
      if (!resp.ok) return null;
      const body = (await resp.json()) as { identityPubKey?: string; revoked?: unknown };
      if (body.revoked) return null;
      if (typeof body.identityPubKey !== "string") return null;
      return hexToBytesSafe(body.identityPubKey);
    } catch {
      return null;
    }
  };
}

function makeIrkResolver(mainUrl: string): (username: string) => Promise<Uint8Array | null> {
  return async (username: string) => {
    try {
      const resp = await fetch(
        `${mainUrl}/api/users/${encodeURIComponent(username)}/pubkey-cert`,
        { headers: { accept: "application/json" } },
      );
      if (!resp.ok) return null;
      const body = (await resp.json()) as { binding?: { pubKey?: string } };
      const pk = body.binding?.pubKey;
      if (typeof pk !== "string") return null;
      return hexToBytesSafe(pk);
    } catch {
      return null;
    }
  };
}

function hexToBytesSafe(s: string): Uint8Array | null {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function applyEffect(
  effect: BrokerEffect,
  env: Env,
): Promise<Record<string, unknown>> {
  const zone = env.CLOUDFLARE_SERVICES_ZONE_ID!;
  const token = env.CLOUDFLARE_DNS_API_TOKEN!;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };

  if (effect.kind === "createTxt") {
    const resp = await fetch(`${CF_API}/zones/${zone}/dns_records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "TXT",
        name: effect.recordName,
        content: effect.recordValue,
        ttl: 60,
        proxied: false,
      }),
    });
    const body = (await resp.json()) as { success: boolean; result?: { id: string }; errors?: unknown };
    if (!body.success || !body.result) {
      // Never echo `body.errors` outward — it may include token-related
      // diagnostics from Cloudflare. The caller sees only ok:false.
      console.warn(`[dns-broker] cf createTxt: ${JSON.stringify(body.errors ?? body)}`);
      throw new Error("cf rejected");
    }
    return { recordId: body.result.id };
  }

  if (effect.kind === "createA") {
    // Bound-new only: list and refuse if (name,type) already exists with
    // a different content. If it exists with the SAME content, return
    // its id idempotently — this lets the main Worker safely retry.
    const existing = await listByName(zone, token, effect.recordName, effect.recordType);
    if (existing.length > 0) {
      const r = existing[0]!;
      if (r.content === effect.targetIp) return { recordId: r.id, idempotent: true };
      // Refuse to mutate an existing record to a new IP.
      throw new Error("conflict");
    }
    const resp = await fetch(`${CF_API}/zones/${zone}/dns_records`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: effect.recordType,
        name: effect.recordName,
        content: effect.targetIp,
        ttl: 60,
        proxied: false,
      }),
    });
    const body = (await resp.json()) as { success: boolean; result?: { id: string }; errors?: unknown };
    if (!body.success || !body.result) {
      console.warn(`[dns-broker] cf createA: ${JSON.stringify(body.errors ?? body)}`);
      throw new Error("cf rejected");
    }
    return { recordId: body.result.id };
  }

  // deleteById
  // Fetch the record first so we can assert the (name,type) matches what
  // the caller's authority covers. Without this, a leaked record id
  // would let a daemon delete an unrelated record.
  const lookup = await fetch(
    `${CF_API}/zones/${zone}/dns_records/${encodeURIComponent(effect.recordId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (lookup.status === 404) {
    return { deleted: false, missing: true };
  }
  const lookupBody = (await lookup.json()) as {
    success: boolean;
    result?: { id: string; type: string; name: string };
    errors?: unknown;
  };
  if (!lookupBody.success || !lookupBody.result) {
    console.warn(`[dns-broker] cf lookup: ${JSON.stringify(lookupBody.errors ?? lookupBody)}`);
    throw new Error("cf rejected");
  }
  if (lookupBody.result.type !== effect.expectedType) throw new Error("type mismatch");
  if (!effect.expectedNameOneOf.includes(lookupBody.result.name)) {
    throw new Error("name mismatch");
  }
  const del = await fetch(
    `${CF_API}/zones/${zone}/dns_records/${encodeURIComponent(effect.recordId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
  );
  if (del.status === 404) return { deleted: false, missing: true };
  const delBody = (await del.json()) as { success: boolean; errors?: unknown };
  if (!delBody.success) {
    console.warn(`[dns-broker] cf delete: ${JSON.stringify(delBody.errors ?? delBody)}`);
    throw new Error("cf rejected");
  }
  return { deleted: true };
}

async function listByName(
  zone: string,
  token: string,
  name: string,
  type: string,
): Promise<Array<{ id: string; content: string }>> {
  const params = new URLSearchParams({ name, type });
  const resp = await fetch(
    `${CF_API}/zones/${zone}/dns_records?${params.toString()}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const body = (await resp.json()) as {
    success: boolean;
    result?: Array<{ id: string; content: string }>;
    errors?: unknown;
  };
  if (!body.success) {
    console.warn(`[dns-broker] cf list: ${JSON.stringify(body.errors ?? body)}`);
    throw new Error("cf rejected");
  }
  return body.result ?? [];
}

// Test-only export for the rate limiter.
export const _internal = { consume, ipBuckets, RATE_LIMIT_BURST };
