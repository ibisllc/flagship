// Counts how many requests of a page load actually RUN a Worker, against a local
// `wrangler dev` (miniflare records one span per Worker invocation and none for a
// file the assets layer answers on its own). The Workers Free plan allows 100,000
// Worker requests a day, so this is the number that matters.
//
//   wrangler dev --local --port 8792 (in apps/com)          the flagship-com Worker
//   wrangler dev --local --port 8791 (in apps/webapp-static) the static-only webapp Worker
//   npx tsx scripts/worker-request-count.ts site    http://localhost:8792
//   npx tsx scripts/worker-request-count.ts webapp  http://localhost:8791
//   npx tsx scripts/worker-request-count.ts webapp  http://localhost:8792 --host webapp.flagshipserver.com   (the old way)
//
// Scenarios: site (a page view of /), webapp-cold (first visit: the page, the service
// worker, every file it precaches), webapp-update (the same, when a new shell version
// ships), webapp-return (a visit at the same version: the service worker update check).
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [scenario, base, ...rest] = process.argv.slice(2);
const host = rest.includes("--host") ? rest[rest.indexOf("--host") + 1] : undefined;
if (!scenario || !base) {
  console.error("usage: worker-request-count.ts site|webapp-cold|webapp-update|webapp-return BASE_URL [--host HOST]");
  process.exit(2);
}
const swFile = join(import.meta.dirname, "..", "apps/web/public/webapp/service-worker.js");

let requests = 0;
async function get(path: string, nav = false): Promise<{ status: number; text: string; type: string }> {
  const headers: Record<string, string> = {};
  if (host) headers["x-flagship-effective-host"] = host;
  if (nav) headers["sec-fetch-mode"] = "navigate";
  // Every redirect hop is a request of its own, as it is for a browser.
  let r = await fetch(base + path, { headers, redirect: "manual" });
  for (let hop = 0; hop < 5 && r.status >= 300 && r.status < 400 && r.headers.get("location"); hop++) {
    requests++;
    const next = new URL(r.headers.get("location")!, base + path);
    r = await fetch(base + next.pathname + next.search, { headers, redirect: "manual" });
  }
  const type = r.headers.get("content-type") ?? "";
  const text = /text|javascript|json|xml|svg/.test(type) ? await r.text() : (await r.arrayBuffer(), "");
  return { status: r.status, text, type };
}

async function clear() {
  await fetch(`${base}/cdn-cgi/local/explorer/api/local/observability/clear`, { method: "POST" });
}
async function workerInvocations(): Promise<number> {
  const r = await fetch(`${base}/cdn-cgi/local/explorer/api/local/observability/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sql: "SELECT COUNT(*) AS n FROM spans WHERE parent_id IS NULL" }),
  });
  const j = (await r.json()) as { result: { rows: number[][] } };
  return j.result.rows[0]![0]!;
}

function shellPaths(): string[] {
  const src = readFileSync(swFile, "utf8");
  const out = new Set<string>();
  for (const name of ["ESSENTIAL_PATHS", "OPTIONAL_SHELL"]) {
    const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
    for (const s of m![1]!.matchAll(/"(\/[^"]*)"/g)) out.add(s[1]!);
  }
  return [...out];
}

function refs(html: string, from: string): string[] {
  const found = new Set<string>();
  // Subresources only (what a browser fetches on its own), not <a href> links.
  for (const m of html.matchAll(/<(?:link|script|img|source)\b[^>]*?\b(?:href|src)="([^"#?]+)(?:\?[^"]*)?"/g)) found.add(m[1]!);
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) found.add(m[1]!);
  return [...found]
    .filter((u) => !/^(https?:|data:|mailto:|\/\/)/.test(u))
    .map((u) => (u.startsWith("/") ? u : new URL(u, "http://x" + from).pathname));
}

async function fetchAll(paths: string[]) {
  for (const p of paths) {
    requests++;
    await get(p);
  }
}

await clear();
if (scenario === "site") {
  requests++;
  const page = await get("/", true);
  const seen = new Set<string>(["/"]);
  const queue = refs(page.text, "/");
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    requests++;
    const r = await get(p);
    if (r.type.includes("css")) queue.push(...refs(r.text, p));
  }
} else if (scenario === "webapp-cold" || scenario === "webapp-update") {
  if (scenario === "webapp-cold") {
    requests++;
    await get("/", true);
  }
  requests++;
  await get("/service-worker.js");
  await fetchAll(shellPaths());
} else if (scenario === "webapp-return") {
  requests++;
  await get("/service-worker.js");
} else {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
const invoked = await workerInvocations();
console.log(`${scenario} @ ${base}${host ? ` (host ${host})` : ""}: ${requests} requests, ${invoked} ran a Worker, ${requests - invoked} answered by static assets`);
