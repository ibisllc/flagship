/**
 * The issuance service's DNS writer (0.4 item F6, docs/runbooks/issuance-migration.md §5).
 *
 * `.com`'s certificate issuance service answers DNS-01 for its own ACME account. It used to hold a Cloudflare token
 * with Zone:DNS:Edit on the whole services zone, so a `.com` compromise could rewrite the root wildcard, the CAA pair
 * or any name. This route is the only DNS write `.com` needs now, and it allows only that:
 *
 *   - `challenge.create`: one TXT record at `_acme-challenge.<user>.<apex>` or `_acme-challenge.<box>.<user>.<apex>`
 *     (the issuance classes' challenge names; one label more for the admin revoke of an old box certificate's app
 *     names), never at the apex, under a reserved label (`tunnel`, `gym`, ...) or deeper;
 *     the value is a DNS-01 digest (43 base64url characters); at most MAX_PER_NAME records at a name. When
 *     ACME_ACCOUNT_THUMBPRINTS is set, the caller also sends the challenge token and the value must be the digest of
 *     `<token>.<thumbprint>` for one of those accounts, so a record never validates an order of any other account.
 *   - `challenge.delete`: by record id, only a TXT record whose name is a challenge name under the apex.
 *   - `zone.list` / `zone.get`: read only (zone-health and the reap plan read the zone through these).
 *
 * The caller authenticates with DNS_BROKER_SECRET (a bearer secret both Workers hold). The hourly cron removes
 * challenge records older than an hour, as `.com`'s own cron did while it held the token.
 */

import { sha256 } from "@noble/hashes/sha256";
import { validateUserLabel } from "@flagship/services-zone";

const CF_API = "https://api.cloudflare.com/client/v4";
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
/** A wildcard and its base name share a challenge name; a renewal may overlap an order that is ending. */
export const MAX_PER_NAME = 4;
export const STALE_CHALLENGE_MS = 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;

export interface ServiceEnv {
  CLOUDFLARE_DNS_API_TOKEN?: string;
  CLOUDFLARE_SERVICES_ZONE_ID?: string;
  FLAGSHIP_APEX?: string;
  /** Bearer secret `.com` sends (`wrangler secret put DNS_BROKER_SECRET` on both Workers). */
  DNS_BROKER_SECRET?: string;
  /** Comma list of RFC 7638 thumbprints (base64url) of the ACME accounts whose challenges may be published. */
  ACME_ACCOUNT_THUMBPRINTS?: string;
}

export interface ZoneRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  created_on?: string;
  modified_on?: string;
}

/** The Cloudflare calls this route makes; tests pass a fake. */
export interface ZoneApi {
  list(opts?: { name?: string; type?: string }): Promise<ZoneRecord[]>;
  get(id: string): Promise<ZoneRecord | null>;
  createTxt(name: string, value: string): Promise<ZoneRecord>;
  delete(id: string): Promise<boolean>;
}

export type ChallengeCheck = { ok: true; recordName: string; value: string } | { ok: false; reason: string };

const norm = (s: string): string => s.toLowerCase().replace(/\.$/, "");

/** The host a challenge name answers for, or null when the name is not one this route may write. */
export function challengeHostOf(recordName: string, apex: string): string | null {
  const name = norm(recordName);
  const a = norm(apex);
  if (!name.startsWith("_acme-challenge.") || !name.endsWith(`.${a}`)) return null;
  const host = name.slice("_acme-challenge.".length);
  const labels = host.slice(0, -(a.length + 1)).split(".");
  if (labels.length < 1 || labels.length > 3 || labels.some((l) => !LABEL_RE.test(l))) return null;
  const user = labels[labels.length - 1]!;
  if (!validateUserLabel(user).ok) return null;
  return host;
}

function digest(input: string): string {
  const d = sha256(new TextEncoder().encode(input));
  let bin = "";
  for (const b of d) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function checkChallengeCreate(body: Record<string, unknown>, apex: string, thumbprints: readonly string[]): ChallengeCheck {
  const name = body.name;
  const value = body.value;
  if (typeof name !== "string" || typeof value !== "string") return { ok: false, reason: "name and value are required" };
  if (!challengeHostOf(name, apex)) return { ok: false, reason: `not a challenge name this broker writes: ${name}` };
  if (!DIGEST_RE.test(value)) return { ok: false, reason: "the value is not a DNS-01 digest" };
  if (thumbprints.length > 0) {
    const token = body.token;
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, reason: "the challenge token is missing" };
    if (!thumbprints.some((t) => digest(`${token}.${t}`) === value)) return { ok: false, reason: "the value is not for a pinned ACME account" };
  }
  return { ok: true, recordName: norm(name), value };
}

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function callerAuthorized(request: Request, env: ServiceEnv): boolean {
  const secret = env.DNS_BROKER_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return false;
  const got = request.headers.get("authorization") ?? "";
  return timingSafeEqual(got, `Bearer ${secret}`);
}

export function thumbprintsOf(env: ServiceEnv): string[] {
  return (env.ACME_ACCOUNT_THUMBPRINTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const refused = (status: number): Response => json({ ok: false }, status);

/** `POST /service`. Answers `{ ok:false }` with no reason on any refusal; the reason goes to the log. */
export async function handleServiceRequest(request: Request, env: ServiceEnv, api: ZoneApi): Promise<Response> {
  if (!callerAuthorized(request, env)) {
    console.warn("[dns-broker] service: caller not authorized");
    return refused(401);
  }
  let body: Record<string, unknown>;
  try {
    const b = (await request.json()) as unknown;
    if (!b || typeof b !== "object" || Array.isArray(b)) return refused(400);
    body = b as Record<string, unknown>;
  } catch {
    return refused(400);
  }
  const apex = norm(env.FLAGSHIP_APEX ?? "flagship.services");
  try {
    switch (body.op) {
      case "challenge.create": {
        const c = checkChallengeCreate(body, apex, thumbprintsOf(env));
        if (!c.ok) {
          console.warn(`[dns-broker] service: refused create: ${c.reason}`);
          return refused(403);
        }
        const existing = await api.list({ name: c.recordName, type: "TXT" });
        const same = existing.find((r) => r.content.replace(/^"|"$/g, "") === c.value);
        if (same) return json({ ok: true, recordId: same.id, idempotent: true });
        if (existing.length >= MAX_PER_NAME) {
          console.warn(`[dns-broker] service: refused create: ${existing.length} records already at ${c.recordName}`);
          return refused(429);
        }
        const r = await api.createTxt(c.recordName, c.value);
        return json({ ok: true, recordId: r.id });
      }
      case "challenge.delete": {
        const id = body.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id)) return refused(400);
        const r = await api.get(id);
        if (!r) return json({ ok: true, deleted: false, missing: true });
        if (r.type !== "TXT" || !norm(r.name).startsWith("_acme-challenge.") || !norm(r.name).endsWith(`.${apex}`)) {
          console.warn(`[dns-broker] service: refused delete of ${r.type} ${r.name}`);
          return refused(403);
        }
        return json({ ok: true, deleted: await api.delete(id) });
      }
      case "zone.list":
        return json({ ok: true, records: await api.list() });
      case "zone.get": {
        const id = body.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(id)) return refused(400);
        return json({ ok: true, record: await api.get(id) });
      }
      default:
        return refused(400);
    }
  } catch (e) {
    console.warn(`[dns-broker] service: cf call failed: ${String((e as Error).message ?? e)}`);
    return refused(502);
  }
}

/** Hourly: challenge TXT records older than an hour (an order that never cleaned up after itself). */
export async function deleteStaleChallenges(env: ServiceEnv, api: ZoneApi, nowMs: number): Promise<{ scanned: number; deleted: number }> {
  const apex = norm(env.FLAGSHIP_APEX ?? "flagship.services");
  const records = await api.list({ type: "TXT" });
  let deleted = 0;
  for (const r of records) {
    const name = norm(r.name);
    if (r.type !== "TXT" || !name.startsWith("_acme-challenge.") || !name.endsWith(`.${apex}`)) continue;
    const t = Date.parse(r.modified_on ?? r.created_on ?? "");
    if (!Number.isFinite(t) || t >= nowMs - STALE_CHALLENGE_MS) continue;
    if (await api.delete(r.id)) deleted += 1;
  }
  return { scanned: records.length, deleted };
}

/** The Cloudflare API with the broker's token. */
export function cloudflareZoneApi(env: ServiceEnv, fetchImpl: typeof fetch = fetch): ZoneApi {
  const zone = env.CLOUDFLARE_SERVICES_ZONE_ID!;
  const auth = { authorization: `Bearer ${env.CLOUDFLARE_DNS_API_TOKEN!}` };
  const base = `${CF_API}/zones/${zone}/dns_records`;
  const read = async <T>(resp: Response, what: string): Promise<T> => {
    const body = (await resp.json()) as { success?: boolean; result?: T; result_info?: { total_pages?: number }; errors?: unknown };
    if (!body.success) throw new Error(`cf ${what}: ${JSON.stringify(body.errors ?? body)}`);
    return body.result as T;
  };
  return {
    async list(opts = {}) {
      const out: ZoneRecord[] = [];
      for (let page = 1; page <= 20; page++) {
        const q = new URLSearchParams({ page: String(page), per_page: "500" });
        if (opts.name) q.set("name", opts.name);
        if (opts.type) q.set("type", opts.type);
        const resp = await fetchImpl(`${base}?${q}`, { headers: auth });
        const body = (await resp.json()) as { success?: boolean; result?: ZoneRecord[]; result_info?: { total_pages?: number }; errors?: unknown };
        if (!body.success) throw new Error(`cf list: ${JSON.stringify(body.errors ?? body)}`);
        const batch = body.result ?? [];
        out.push(...batch);
        const pages = body.result_info?.total_pages;
        if (typeof pages === "number" ? page >= pages : batch.length < 500) break;
      }
      return out.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl, created_on: r.created_on, modified_on: r.modified_on }));
    },
    async get(id) {
      const resp = await fetchImpl(`${base}/${encodeURIComponent(id)}`, { headers: auth });
      if (resp.status === 404) return null;
      return read<ZoneRecord>(resp, "get");
    },
    async createTxt(name, value) {
      const resp = await fetchImpl(base, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ type: "TXT", name, content: value, ttl: 60, proxied: false }),
      });
      return read<ZoneRecord>(resp, "create");
    },
    async delete(id) {
      const resp = await fetchImpl(`${base}/${encodeURIComponent(id)}`, { method: "DELETE", headers: auth });
      if (resp.status === 404) return false;
      await read<unknown>(resp, "delete");
      return true;
    },
  };
}
