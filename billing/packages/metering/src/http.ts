// An optional HTTP binding of reports and leases (docs/spec/http-v1.md):
// a central handler (Request → Response, so it runs on Workers, Deno, Bun,
// Node 18+ via any adapter) and the edge side that sends a LeaseBook batch.
// Hosts with their own wire use meterReport / meterLease / LeaseBook directly.

import type { EdgeBatch, EdgeLease, LeaseBook } from "./edge.js";
import { meterLease, type MeterLease, type MeterLeasePolicy } from "./lease.js";
import type { MeterAction, MeterDeps } from "./meter.js";
import { METER_BATCH_ID_RE, meterReport } from "./report.js";

/** One account's answer on the wire. */
export interface ReportResultWire<Resource extends string = string> {
  account: string;
  resource: Resource;
  /** What the edge must do now (the verdict on the counted total). */
  action: MeterAction;
  used: number;
  allowance: number;
  /** ms since epoch, or null for a lifetime counter. */
  resetsAt: number | null;
  lease: Pick<MeterLease, "action" | "grant" | "policy" | "ttlMs">;
}

export interface ReportResponseWire<Resource extends string = string> {
  duplicate: boolean;
  results: ReportResultWire<Resource>[];
}

export interface ReportHandlerOptions<Resource extends string, Plan extends string> {
  deps: MeterDeps<Resource, Plan>;
  /** Lease sizing, for every resource or per resource. */
  lease: MeterLeasePolicy | ((resource: Resource) => MeterLeasePolicy);
  /** Is this request from one of your edges? See `bearerAuth`. */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Most items in one report. Default 500. */
  maxItems?: number;
  /** Largest request body in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Refuse reports without a batchId (they double-count on retry).
   *  Default true; turn it off only while old edges are still reporting. */
  requireBatchId?: boolean;
  /** How long batch ids are remembered (default DEFAULT_BATCH_KEEP_MS). */
  keepMs?: number;
  /** Called with any unexpected error before the 500 goes out. */
  onError?: (error: unknown) => void;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** An `authorize` that accepts `Authorization: Bearer <secret>` for any of
 *  `secrets` (several, so a secret can be rotated without downtime). */
export function bearerAuth(...secrets: string[]): (request: Request) => boolean {
  const live = secrets.filter((s) => s.length > 0);
  if (live.length === 0) throw new RangeError("bearerAuth needs a non-empty secret");
  return (request) => {
    const h = request.headers.get("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return false;
    let ok = false;
    for (const s of live) ok = constantTimeEqual(m[1]!, s) || ok;
    return ok;
  };
}

class Malformed extends Error {}

/** The central report endpoint: `POST` a report, get a lease per account.
 *
 *    200 { duplicate, results }   counted (or already counted: duplicate)
 *    400 { error }                malformed; the edge drops the batch
 *    401 / 405 / 413              likewise refused
 *    500 { error: "internal" }    the edge retries the same batch
 */
export function createReportHandler<R extends string, P extends string>(
  opts: ReportHandlerOptions<R, P>,
): (request: Request) => Promise<Response> {
  const maxItems = opts.maxItems ?? 500;
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const requireBatchId = opts.requireBatchId ?? true;
  const policyFor = typeof opts.lease === "function" ? opts.lease : () => opts.lease as MeterLeasePolicy;

  return async (request) => {
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: 405,
        headers: { ...JSON_HEADERS, allow: "POST" },
      });
    }
    if (!(await opts.authorize(request))) return json(401, { error: "unauthorized" });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > maxBodyBytes) return json(413, { error: "report too large" });

    let report: { batchId?: string; items: Array<{ account: string; resource: R; amount: number }> };
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > maxBodyBytes) return json(413, { error: "report too large" });
      report = parseReport(text, opts.deps.catalog as Record<string, unknown>, maxItems, requireBatchId) as typeof report;
    } catch (e) {
      if (e instanceof Malformed) return json(400, { error: e.message });
      throw e;
    }

    try {
      const now = opts.deps.now ? opts.deps.now() : Date.now();
      const deps = { ...opts.deps, now: () => now };
      const { duplicate, verdicts } = await meterReport(deps, report, { keepMs: opts.keepMs });
      const results: ReportResultWire<R>[] = verdicts.map((v) => {
        const l = meterLease(v, policyFor(v.resource), now);
        return {
          account: v.account,
          resource: v.resource,
          action: v.action,
          used: v.used,
          allowance: v.allowance,
          resetsAt: v.resetsAt,
          lease: { action: l.action, grant: l.grant, policy: l.policy, ttlMs: l.ttlMs },
        };
      });
      return json(200, { duplicate, results } satisfies ReportResponseWire<R>);
    } catch (e) {
      opts.onError?.(e);
      return json(500, { error: "internal" });
    }
  };
}

function parseReport(text: string, catalog: Record<string, unknown>, maxItems: number, requireBatchId: boolean) {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Malformed("body is not JSON");
  }
  if (typeof body !== "object" || body === null) throw new Malformed("body must be an object");
  const { batchId, items } = body as { batchId?: unknown; items?: unknown };
  if (batchId === undefined) {
    if (requireBatchId) throw new Malformed("batchId required");
  } else if (typeof batchId !== "string" || !METER_BATCH_ID_RE.test(batchId)) {
    throw new Malformed("batchId must be 16–128 characters of [A-Za-z0-9_-]");
  }
  if (!Array.isArray(items)) throw new Malformed("items[] required");
  if (items.length > maxItems) throw new Malformed(`at most ${maxItems} items per report`);
  const out: Array<{ account: string; resource: string; amount: number }> = [];
  for (const raw of items) {
    const it = (raw ?? {}) as { account?: unknown; resource?: unknown; amount?: unknown };
    if (typeof it.account !== "string" || it.account.length === 0 || it.account.length > 256) {
      throw new Malformed("each item needs an account (1–256 characters)");
    }
    if (typeof it.resource !== "string" || !Object.hasOwn(catalog, it.resource)) {
      throw new Malformed(`unknown resource: ${String(it.resource)}`);
    }
    if (typeof it.amount !== "number" || !Number.isFinite(it.amount) || it.amount < 0) {
      throw new Malformed("each item needs a finite, non-negative amount");
    }
    out.push({ account: it.account, resource: it.resource, amount: it.amount });
  }
  return batchId === undefined ? { items: out } : { batchId: batchId as string, items: out };
}

// ── The edge side ─────────────────────────────────────────────────────

export interface SendBatchOptions {
  /** The central report endpoint. */
  url: string;
  /** The resource this LeaseBook meters. */
  resource: string;
  /** Extra headers, e.g. { authorization: `Bearer ${secret}` }. */
  headers?: Record<string, string>;
  /** Default: globalThis.fetch. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Abort a send after this long and retry later. Default 10 s. */
  timeoutMs?: number;
  /** Default Date.now. */
  now?: () => number;
}

/** What became of a batch: answered and settled, kept for a retry, or
 *  refused by central and dropped. */
export type SendBatchOutcome = "settled" | "retry" | "dropped";

/** POST one LeaseBook batch and feed the answer back into the book: leases on
 *  200; a retry of the same batch on a network error, a timeout, 5xx, 408 or
 *  429; dropped on any other status. Never throws for transport errors. */
export async function sendBatch(book: LeaseBook, batch: EdgeBatch, opts: SendBatchOptions): Promise<SendBatchOutcome> {
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
  const body = JSON.stringify({
    batchId: batch.id,
    items: batch.items.map((i) => ({ account: i.account, resource: opts.resource, amount: i.amount })),
  });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
  let res: Response;
  let answer: ReportResponseWire | undefined;
  try {
    res = await doFetch(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body,
      signal: ctl.signal,
    });
    if (res.status === 200) answer = (await res.json()) as ReportResponseWire;
  } catch {
    book.failed(batch, now(), true);
    return "retry";
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 200 && answer && Array.isArray(answer.results)) {
    const leases = new Map<string, EdgeLease>();
    for (const r of answer.results) if (r && r.resource === opts.resource && r.lease) leases.set(r.account, r.lease);
    book.settle(batch, leases, now());
    return "settled";
  }
  const retry = res.status === 200 || res.status >= 500 || res.status === 408 || res.status === 429;
  book.failed(batch, now(), retry);
  return retry ? "retry" : "dropped";
}
