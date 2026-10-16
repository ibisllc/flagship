/**
 * Installer logs: `/api/dev/late-log/<label>` (W12 debug, GA close-out 5).
 *
 * Installers POST log tails here before they hold any credential (the
 * initramfs Wi-Fi bring-up, a failed bootstrap, the netboot post-log), so a
 * write stays unauthenticated. Those logs name a box's network and serial,
 * so only the operator reads them (x-admin-secret). Writes are bounded:
 * route.ts budgets them per address and per label, each chunk is capped,
 * a label keeps only its newest MAX_CHUNKS_PER_LABEL chunks, and the
 * 6-hourly cron deletes chunks older than LATE_LOG_TTL_DAYS.
 */

import { authorizeAdmin } from "@flagship/control-plane";

export const LATE_LOG_PREFIX = "late-log/";
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_CHUNKS_PER_LABEL = 50;
export const LATE_LOG_TTL_DAYS = 7;

export interface LateLogBucket {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | Uint8Array | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  list(options: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated?: boolean; cursor?: string }>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  delete(keys: string | string[]): Promise<void>;
}

export interface LateLogEnv {
  ISO_TEMP_BUCKET?: LateLogBucket;
  FLAGSHIP_ADMIN_SECRET?: string;
}

const LABEL_RE = /^[A-Za-z0-9._-]{1,128}$/;
const KEY_RE = /^late-log\/[A-Za-z0-9._-]{1,128}\/(\d{13})-[a-z0-9]+\.txt$/;

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

async function listLabel(bucket: LateLogBucket, label: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${LATE_LOG_PREFIX}${label}/`, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const o of page.objects ?? []) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export async function handleLateLog(
  request: Request,
  env: LateLogEnv,
  rawLabel: string,
  now: number = Date.now(),
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "GET") return text("method not allowed\n", 405);
  if (method === "GET") {
    const denied = authorizeAdmin({
      expected: env.FLAGSHIP_ADMIN_SECRET,
      provided: request.headers.get("x-admin-secret"),
    });
    if (denied) return new Response(JSON.stringify(denied.body), { status: denied.status, headers: { "content-type": "application/json" } });
  }
  const bucket = env.ISO_TEMP_BUCKET;
  if (!bucket) return text("ISO_TEMP_BUCKET unbound\n", 503);
  let label: string;
  try {
    label = decodeURIComponent(rawLabel);
  } catch {
    return text("invalid label\n", 400);
  }
  if (!LABEL_RE.test(label)) return text("invalid label\n", 400);

  if (method === "GET") {
    const keys = await listLabel(bucket, label);
    const chunks: string[] = [];
    for (const k of keys) {
      const obj = await bucket.get(k);
      if (obj) chunks.push(`# ── ${k} ──\n${await obj.text()}\n`);
    }
    return text(chunks.length > 0 ? chunks.join("") : `no entries for ${label}\n`, 200);
  }

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CHUNK_BYTES) return text("chunk too large\n", 413);
  const body = await readCapped(request, MAX_CHUNK_BYTES);
  if (body === null) return text("chunk too large\n", 413);

  const existing = await listLabel(bucket, label);
  const excess = existing.length - (MAX_CHUNKS_PER_LABEL - 1);
  if (excess > 0) await bucket.delete(existing.slice(0, excess));
  const key = `${LATE_LOG_PREFIX}${label}/${now}-${Math.random().toString(36).slice(2, 8)}.txt`;
  await bucket.put(key, body, { httpMetadata: { contentType: "text/plain" } });
  return text(`stored ${body.length}B\n`, 200);
}

/** The body as text, or null once it passes `max` bytes (stops reading there). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Delete installer-log chunks older than the TTL. Returns how many went. */
export async function pruneLateLogs(bucket: LateLogBucket, now: Date): Promise<number> {
  const cutoff = now.getTime() - LATE_LOG_TTL_DAYS * 86_400_000;
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: LATE_LOG_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
    const stale = (page.objects ?? [])
      .map((o) => o.key)
      .filter((k) => {
        const m = k.match(KEY_RE);
        return m ? Number(m[1]) < cutoff : false;
      });
    if (stale.length > 0) {
      await bucket.delete(stale);
      deleted += stale.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
