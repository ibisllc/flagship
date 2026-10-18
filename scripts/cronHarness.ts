// Cron budget harness: runs the REAL scheduled() handler of `.com` (and each of
// its jobs on its own) over the production D1 adapter on node:sqlite, with
// `fetch` and R2 stubbed and COUNTED, and reports what one cron invocation costs
// against the Workers Free limits (docs/runbooks/workers-cpu-budget.md):
//
//   d1     D1 round trips (each counts as a subrequest; 50 per invocation)
//   fetch  outbound fetch()es (subrequests too)
//   js     thread CPU minus sqlite, plus a flat per-D1-call overhead: compare
//          with the 10 ms a Free cron invocation may spend
//
// Library only; apps/com/test/cronBudget.test.ts asserts on it and
// `npx tsx scripts/cron-profile.ts` prints the table.

import { createSqliteD1 } from "../packages/storage/tests/support/sqliteD1.js";
import { D1Storage, type D1Database } from "@flagship/storage";
import { scheduled, type ScheduledEnv } from "../apps/com/src/scheduled.js";
import { cpuNowMs, DB_CALL_OVERHEAD_MS, DB_BATCHED_STATEMENT_MS } from "./cpuHarness.js";
import type { DbMeter } from "./cpuHarness.js";

export const FREE_CRON_CPU_MS = 10;
export const FREE_SUBREQUEST_LIMIT = 50;

export interface CronWorld {
  env: ScheduledEnv;
  meter: DbMeter;
  fetches: string[];
  close(): void;
}

function meterDb(db: D1Database, meter: DbMeter): D1Database {
  const wrapStmt = (stmt: ReturnType<D1Database["prepare"]>, sql: string) => {
    const w: Record<string, unknown> = {};
    const timed = <T>(f: () => Promise<T>, n = 1): Promise<T> => {
      const t = cpuNowMs();
      meter.calls++;
      meter.statements += n;
      meter.sql.push(sql);
      return f().finally(() => {
        meter.ms += cpuNowMs() - t;
      });
    };
    w.bind = (...v: unknown[]) => {
      stmt.bind(...v);
      return w;
    };
    w.first = () => timed(() => stmt.first());
    w.all = () => timed(() => stmt.all());
    w.run = () => timed(() => stmt.run());
    w.__inner = stmt;
    w.__sql = sql;
    return w as unknown as ReturnType<D1Database["prepare"]>;
  };
  return {
    prepare: (sql: string) => wrapStmt(db.prepare(sql), sql),
    async batch(stmts: never[]) {
      const t = cpuNowMs();
      meter.calls++;
      meter.statements += stmts.length;
      meter.sql.push("BATCH");
      try {
        return await db.batch(stmts.map((s) => (s as unknown as { __inner: never }).__inner ?? s));
      } finally {
        meter.ms += cpuNowMs() - t;
      }
    },
    exec: (db as { exec?: unknown }).exec as never,
  } as unknown as D1Database;
}

/** A catalog shaped like OpenRouter's: ~350 models with long descriptions. */
export function fakeOpenRouterCatalog(n = 350): string {
  const data = Array.from({ length: n }, (_, i) => ({
    id: `vendor${i % 40}/model-${i}`,
    name: `Vendor ${i % 40}: Model ${i}`,
    created: 1_700_000_000 + i,
    description: "A general purpose model. ".repeat(40),
    context_length: 32_000 + i,
    architecture: { modality: "text+image->text", input_modalities: ["text", "image"], output_modalities: ["text"], tokenizer: "Other" },
    pricing: { prompt: "0.0000005", completion: "0.0000015", request: "0", image: "0" },
    top_provider: { context_length: 32_000, max_completion_tokens: 4096, is_moderated: false },
    supported_parameters: ["tools", "tool_choice", "reasoning", "include_reasoning", "max_tokens", "temperature", "top_p", "stop"],
  }));
  return JSON.stringify({ data });
}

export interface CronWorldOptions {
  accounts?: number;
}

export async function buildCronWorld(opts: CronWorldOptions = {}): Promise<CronWorld> {
  const accounts = opts.accounts ?? 75;
  const raw = createSqliteD1();
  const meter: DbMeter = {
    calls: 0,
    statements: 0,
    ms: 0,
    sql: [],
    reset() {
      this.calls = 0;
      this.statements = 0;
      this.ms = 0;
      this.sql = [];
    },
  };
  const seed = new D1Storage(raw as unknown as D1Database);
  const now = Date.now();
  const hex = (n: number, len: number) => n.toString(16).padStart(len, "0");
  for (let i = 0; i < accounts; i++) {
    const username = `account-${hex(i, 3)}`;
    await seed.usernames.put({
      username,
      irkPubHex: hex(i + 1, 64),
      adminRootPubHex: hex(i + 1000, 64),
      claimedAt: now - 86_400_000,
    });
    const domain = `home.${username}.flagship.services`;
    await seed.servers.put({
      serverDomain: domain,
      username,
      identityPubKeyHex: hex(i + 5000, 64),
      registeredAt: now - 50_000_000,
    });
  }
  const fetches: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetches.push(url);
    if (url.includes("crt.sh")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("openrouter.ai")) return new Response(fakeOpenRouterCatalog(), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("api.cloudflare.com")) {
      return new Response(JSON.stringify({ success: true, result: [], result_info: { page: 1, total_pages: 1, count: 0 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("dns.google") || url.includes("cloudflare-dns.com") || url.includes("dns-query")) {
      return new Response(JSON.stringify({ Status: 3 }), { status: 200, headers: { "content-type": "application/dns-json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const env: ScheduledEnv = {
    DB: meterDb(raw as unknown as D1Database, meter),
    SERVICES_BASE_URL: "https://flagship-services.fly.dev:8443",
    SERVICES_CONTROL_SECRET: "cron-harness-secret",
    UPCLOUD_TOKEN: "cron-harness-upcloud",
    CLOUDFLARE_DNS_API_TOKEN: "cron-harness-cf",
    CLOUDFLARE_SERVICES_ZONE_ID: "zone",
    ADAPTERS_GITHUB_TOKEN: "cron-harness-gh",
    ADAPTERS_REPO: "ibisllc/flagship-adapters",
    ADAPTERS_BUCKET: { get: async () => null, put: async () => undefined, delete: async () => undefined, list: async () => ({ objects: [], truncated: false }) } as never,
    ISO_TEMP_BUCKET: { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined } as never,
  };
  return {
    env,
    meter,
    fetches,
    close() {
      globalThis.fetch = realFetch;
      (raw as unknown as { close(): void }).close();
    },
  };
}

export interface CronMeasure {
  label: string;
  d1: number;
  fetches: number;
  /** subrequests = d1 + fetches */
  subrequests: number;
  /** JS CPU in ms, sqlite excluded, plus the per-call overhead model. */
  jsMs: number;
}

/** Run `fn` once and report what it cost. */
export async function measure(w: CronWorld, label: string, fn: () => Promise<unknown>): Promise<CronMeasure> {
  w.meter.reset();
  w.fetches.length = 0;
  const t = cpuNowMs();
  await fn();
  const total = cpuNowMs() - t;
  const jsMs =
    Math.max(0, total - w.meter.ms) +
    w.meter.calls * DB_CALL_OVERHEAD_MS +
    Math.max(0, w.meter.statements - w.meter.calls) * DB_BATCHED_STATEMENT_MS;
  return { label, d1: w.meter.calls, fetches: w.fetches.length, subrequests: w.meter.calls + w.fetches.length, jsMs };
}

/** Drive scheduled() the way the platform does: one invocation, every waitUntil promise awaited. */
export async function runInvocation(env: ScheduledEnv, cron: string, scheduledTime: number): Promise<void> {
  const pending: Promise<unknown>[] = [];
  await scheduled({ cron, scheduledTime }, env, { waitUntil: (p) => void pending.push(p.catch(() => undefined)) });
  await Promise.all(pending);
}

/** Smallest of `runs` measurements (least disturbed by the machine), after a warm-up. */
export async function measureInvocation(
  w: CronWorld,
  label: string,
  cron: string,
  scheduledTime: number,
  runs = 5,
): Promise<CronMeasure> {
  await runInvocation(w.env, cron, scheduledTime);
  let best: CronMeasure | undefined;
  for (let i = 0; i < runs; i++) {
    const m = await measure(w, label, () => runInvocation(w.env, cron, scheduledTime));
    if (!best || m.jsMs < best.jsMs) best = m;
  }
  return best!;
}
