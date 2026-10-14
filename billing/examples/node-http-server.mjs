// Central metering on a plain Node HTTP server, counters in SQLite.
//
//   npm run build
//   node examples/node-http-server.mjs              # serve on :8787
//   node examples/node-http-server.mjs --self-test  # serve, drive it, exit
//
// Routes (the report wire is docs/spec/http-v1.md):
//   POST /usage/report        an edge's batch → a lease per account
//   GET  /usage/:account      the account's verdict per resource
//
// Try it:
//   curl -s localhost:8787/usage/report -H 'authorization: Bearer dev-secret' \
//     -d '{"batchId":"0123456789abcdef0123456789abcdef",
//          "items":[{"account":"ann","resource":"api-calls","amount":40}]}'
//   curl -s localhost:8787/usage/ann

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { LeaseBook, meterCheck } from "@ibisllc/billing-metering";
import { bearerAuth, createReportHandler, sendBatch } from "@ibisllc/billing-metering/http";
import { SqliteMeterStore } from "@ibisllc/billing-store-sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite"); // Node 22.13+; or better-sqlite3
const SECRET = process.env.EDGE_SECRET ?? "dev-secret";

// Your catalog, your plan lookup. These two resources are only examples.
const catalog = {
  "api-calls": {
    unit: "calls",
    period: "day",
    plans: { free: { allowance: 100, over: "stop" }, pro: { allowance: 100_000, over: "allow" } },
  },
  "ai-tokens": {
    unit: "tokens",
    period: "month",
    plans: { free: { allowance: 50_000, over: "throttle" }, pro: { allowance: 5_000_000, over: "allow" } },
  },
};
const proAccounts = new Set(["acme"]);
const planOf = async (account) => (proAccounts.has(account) ? "pro" : "free");

const db = new DatabaseSync(process.env.METER_DB ?? ":memory:");
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
const store = new SqliteMeterStore(db);
store.migrate();
const deps = { catalog, store, planOf };

const report = createReportHandler({
  deps,
  lease: (resource) =>
    resource === "api-calls"
      ? { fraction: 0.25, minGrant: 1, maxGrant: 1_000, ttlMs: 60_000, overTtlMs: 30_000 }
      : { fraction: 0.25, minGrant: 1_000, maxGrant: 200_000, ttlMs: 10 * 60_000, overTtlMs: 60_000 },
  authorize: bearerAuth(SECRET),
  onError: (e) => console.error("report failed:", e),
});

async function route(request) {
  const url = new URL(request.url);
  if (url.pathname === "/usage/report") return report(request);
  const m = /^\/usage\/([^/]+)$/.exec(url.pathname);
  if (m && request.method === "GET") {
    const account = decodeURIComponent(m[1]);
    // need = 1: "may it use one more?", so an account at a stop allowance reads "stop".
    const verdicts = await Promise.all(Object.keys(catalog).map((r) => meterCheck(deps, account, r, 1)));
    return Response.json(verdicts);
  }
  return new Response("not found", { status: 404 });
}

// Node's http server speaks IncomingMessage; the handler speaks Request.
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])),
      body: chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined,
    });
    const response = await route(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end();
  }
});

const selfTest = process.argv.includes("--self-test");
server.listen(selfTest ? 0 : Number(process.env.PORT ?? 8787), async () => {
  const { port } = server.address();
  console.log(`metering on http://localhost:${port}`);
  if (!selfTest) return;

  // An edge in the same process: 150 API calls for a free account whose
  // daily allowance is 100, reported every 10 calls.
  const book = new LeaseBook({ initialGrant: 5, unknownPolicy: "stop" });
  const opts = {
    url: `http://localhost:${port}/usage/report`,
    resource: "api-calls",
    headers: { authorization: `Bearer ${SECRET}` },
  };
  let served = 0;
  let refused = 0;
  for (let i = 0; i < 150; i++) {
    if (book.action("ann") === "allow") {
      served++;
      book.use("ann", 1, Date.now());
    } else refused++;
    if (i % 10 === 9 || book.hasDue(Date.now())) {
      const batch = book.takeBatch(Date.now(), "all");
      if (batch) await sendBatch(book, batch, opts);
    }
  }
  const final = book.takeBatch(Date.now(), "all");
  if (final) await sendBatch(book, final, opts);
  const verdict = await (await fetch(`http://localhost:${port}/usage/ann`)).json();
  const calls = verdict.find((v) => v.resource === "api-calls");
  console.log(`served ${served}, refused ${refused}; central counted ${calls.used} of ${calls.allowance} (${calls.action})`);
  server.close();
  if (calls.used !== served || served !== 100) {
    console.error("self-test failed");
    process.exitCode = 1;
  }
});
