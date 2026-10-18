// Refresh D1 `model_capabilities` from OpenRouter's public catalog, from a
// machine instead of the Worker (it needs ~33 ms of CPU; a Free cron has 10).
// The logic is the Worker's own: `refreshModelCapabilities` over the Worker's
// `D1ModelCapabilityStore`; only the database handle differs. Here it is a
// minimal D1Database that sends each statement through `wrangler d1 execute`.
//
//   npx tsx scripts/refresh-model-capabilities.ts --remote           (CI: model-capabilities.yml)
//   npx tsx scripts/refresh-model-capabilities.ts --local [--catalog-file models.json]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshModelCapabilities } from "@flagship/control-plane";
import type { D1Database, D1PreparedStatement } from "@flagship/storage";
import { inline } from "./refresh-model-capabilities-sql.js";
import { D1ModelCapabilityStore } from "../apps/com/src/inferenceModelRoutes.js";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
if (remote === args.includes("--local")) {
  console.error("usage: refresh-model-capabilities.ts (--remote | --local) [--catalog-file models.json] [--project-dir dir]");
  process.exit(2);
}
const catalogFile = args.includes("--catalog-file") ? args[args.indexOf("--catalog-file") + 1] : undefined;
const projectDir = args.includes("--project-dir") ? args[args.indexOf("--project-dir") + 1]! : join(import.meta.dirname, "..", "apps", "com");
const DB = "flagship-state";

function wrangler(extra: string[]): string {
  return execFileSync(
    "npx",
    ["--yes", "wrangler@4.151.0", "d1", "execute", DB, remote ? "--remote" : "--local", "--json", ...extra],
    { cwd: projectDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"] },
  );
}

function rows(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as { results?: Record<string, unknown>[] }[];
  return parsed.flatMap((r) => r.results ?? []);
}

function statement(sql: string): D1PreparedStatement & { text(): string } {
  let binds: unknown[] = [];
  const st = {
    bind(...v: unknown[]) {
      binds = v;
      return st;
    },
    text: () => inline(sql, binds),
    async first<T>() {
      return (rows(wrangler(["--command", inline(sql, binds)]))[0] ?? null) as T | null;
    },
    async all<T>() {
      return { results: rows(wrangler(["--command", inline(sql, binds)])) as T[], success: true, meta: {} };
    },
    async run() {
      wrangler(["--command", inline(sql, binds)]);
      return { results: [], success: true, meta: {} };
    },
  };
  return st as never;
}

const db = {
  prepare: (sql: string) => statement(sql),
  async batch(stmts: (D1PreparedStatement & { text(): string })[]) {
    const dir = mkdtempSync(join(tmpdir(), "model-caps-"));
    try {
      const file = join(dir, "batch.sql");
      writeFileSync(file, stmts.map((s) => `${s.text()};`).join("\n"));
      wrangler(["--file", file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return stmts.map(() => ({ results: [], success: true, meta: {} }));
  },
} as unknown as D1Database;

const result = await refreshModelCapabilities({
  store: new D1ModelCapabilityStore(db),
  fetch: catalogFile
    ? async () => new Response(readFileSync(catalogFile, "utf8"), { status: 200 })
    : (url) => fetch(url, { headers: { accept: "application/json" } }),
  now: Date.now(),
  log: (m) => console.log(m),
});
console.log(`[model-capabilities] refreshed ${result.total} models, ${result.added.length} new`);
