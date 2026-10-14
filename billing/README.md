# billing

Usage metering you can drop into any service, and next, anonymous prepaid
vouchers. You bring your plans, your account ids and your database; the
library counts usage per account, judges it against the plan (allow,
throttle or stop), and keeps many edge servers within budget without asking
central about every request.

- **Generic.** Accounts are opaque strings, resources and plans are names
  you choose, periods are month / ISO week / day / lifetime in UTC.
- **Edge-friendly.** Edges count locally with a `LeaseBook`, report batches
  with ids (each counted at most once), and enforce the budget lease central
  sends back. The hot path is a map update.
- **Aggregates only.** Stores hold an account id and a number per resource
  and period. No event log.
- **Bring your store.** In-memory, SQLite, PostgreSQL and Cloudflare D1
  stores ship here; any other store passes the same conformance suite.
- **Small.** TypeScript, ESM, zero runtime dependencies; runs on Node 22+,
  Workers, Deno and Bun.

## Packages

| package                                                        | what                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`@ibisllc/billing-metering`](./packages/metering)             | the core: plans, verdicts, reports, leases, `LeaseBook`, in-memory store; `/conformance`, `/http` |
| [`@ibisllc/billing-store-sqlite`](./packages/store-sqlite)     | `node:sqlite`, better-sqlite3, bun:sqlite                                                        |
| [`@ibisllc/billing-store-postgres`](./packages/store-postgres) | `pg`, PGlite, or any `query(text, values)` client                                                |
| [`@ibisllc/billing-store-d1`](./packages/store-d1)             | Cloudflare D1                                                                                    |
| `@ibisllc/billing-vouchers` (planned)                          | blind-signed prepaid vouchers: [draft spec](./docs/spec/vouchers-v1-draft.md), not built          |

## Quick start

```sh
npm install @ibisllc/billing-metering @ibisllc/billing-store-sqlite
```

**1. Define plans.** Per resource: a unit (display only), a period, and per
plan an allowance and what happens past it. The names are yours.

```ts
import { meterCheck, meterRecord, type MeterDeps } from "@ibisllc/billing-metering";
import { SqliteMeterStore } from "@ibisllc/billing-store-sqlite";
import { DatabaseSync } from "node:sqlite";

type Plan = "free" | "pro";
type Resource = "api-calls" | "ai-tokens";

const store = new SqliteMeterStore(new DatabaseSync("meter.db"));
store.migrate();

const deps: MeterDeps<Resource, Plan> = {
  catalog: {
    "api-calls": { unit: "calls", period: "day", plans: {
      free: { allowance: 1_000, over: "stop" },        // refused until tomorrow
      pro:  { allowance: 100_000, over: "allow" },     // billed past it
    } },
    "ai-tokens": { unit: "tokens", period: "month", plans: {
      free: { allowance: 50_000, over: "throttle" },   // served slowly
      pro:  { allowance: 5_000_000, over: "allow" },
    } },
  },
  store,
  planOf: async (account) => ((await subscriptions.isPro(account)) ? "pro" : "free"),
};
```

**2. Record** usage where you observe it, and act on the verdict's `action`.

```ts
const v = await meterRecord(deps, accountId, "ai-tokens", usage.totalTokens);
if (v.action === "throttle") queue.deprioritise(accountId);
```

**3. Check** before handing out something that consumes the resource.
`need = 1` asks "may it use one more?".

```ts
const v = await meterCheck(deps, accountId, "api-calls", 1);
if (v.action === "stop") return new Response("daily limit reached", { status: 429 });
```

**4. Leases at the edge.** When usage is observed on many machines, don't
call central per request. Each edge keeps a `LeaseBook`, reports batches,
and enforces the lease central answers with:

```ts
// central: any runtime with Request/Response (Workers, Deno, Bun, Node)
import { bearerAuth, createReportHandler } from "@ibisllc/billing-metering/http";

export const handleReport = createReportHandler({
  deps,
  lease: { fraction: 0.25, minGrant: 10, maxGrant: 1_000, ttlMs: 60_000, overTtlMs: 30_000 },
  authorize: bearerAuth(process.env.EDGE_SECRET!),
});

// edge: one LeaseBook per resource
import { LeaseBook } from "@ibisllc/billing-metering";
import { sendBatch } from "@ibisllc/billing-metering/http";

const book = new LeaseBook({ initialGrant: 10, unknownPolicy: "stop" });

// per request, no I/O
if (book.action(accountId) !== "allow") return tooManyRequests();
book.use(accountId, 1, Date.now());

// in the background
const report = async (mode: "due" | "all") => {
  const batch = book.takeBatch(Date.now(), mode);
  if (batch) await sendBatch(book, batch, { url: CENTRAL_URL, resource: "api-calls",
    headers: { authorization: `Bearer ${process.env.EDGE_SECRET}` } });
};
setInterval(() => book.hasDue(Date.now()) && report("due"), 500);   // accounts near their grant
setInterval(() => report("all"), 60_000);                           // everyone else
```

Run [`examples/`](./examples) to see all of it working.

## Concepts

- **Counter**: a whole number per `(account, resource, period)`. It only
  grows within a period; a new period starts a new counter.
- **Catalog**: per resource, a period kind and, per plan, an `allowance` and
  an over-allowance policy: `allow` (keep serving, bill the overage),
  `throttle` (serve slowly; you decide how slow) or `stop`.
- **Verdict**: `used`, `allowance`, `remaining`, `over`, `resetsAt`, and the
  `action` you must take: `allow` unless over, else the policy.
- **Batch**: an edge's usage for many accounts under a random id, counted at
  most once, so a lost answer can be retried safely.
- **Lease**: central's answer per account: how much more the edge may serve
  before reporting again, for how long, and what to do if it runs out.
  Grants shrink near the allowance, so one edge can never carry an account
  past it.

Specs: [metering-v1](./docs/spec/metering-v1.md) (counters, plans,
verdicts), [report-and-lease-v1](./docs/spec/report-and-lease-v1.md)
(batches, leases, bounds), [http-v1](./docs/spec/http-v1.md) (an optional
HTTP binding). Growing past one database: [scaling](./docs/scaling.md).

## Stores and the conformance suite

| store                | driver                                     | `addBatch`                        | tested against                                                   |
| -------------------- | ------------------------------------------ | --------------------------------- | ---------------------------------------------------------------- |
| `InMemoryMeterStore` | none                                       | in process                        | conformance                                                      |
| `SqliteMeterStore`   | node:sqlite, better-sqlite3 (+ bun:sqlite) | one `BEGIN IMMEDIATE` transaction | conformance on both drivers; two connections on one file         |
| `PostgresMeterStore` | pg, PGlite, anything with `query()`        | one statement                     | conformance on PGlite and on PostgreSQL servers (CI: 16 and 18)  |
| `D1MeterStore`       | Cloudflare D1 binding                      | one `batch()`                     | conformance on a node:sqlite D1 stand-in                         |

Writing a store for another database (Redis, DynamoDB, MySQL …)? Run the
same suite: [docs/adapters.md](./docs/adapters.md).

```ts
import { meterStoreConformance } from "@ibisllc/billing-metering/conformance";

for (const c of meterStoreConformance({ make: () => new MyStore() })) it(c.name, c.run);
```

## Examples

```sh
npm ci && npm run build
node examples/edge-simulation.mjs           # 3 edges, 4 accounts, 20 simulated minutes
node examples/node-http-server.mjs          # central on node:http + SQLite, port 8787
node bench/report-load.mjs                  # throughput per store
```

## Developing

```sh
npm ci            # this folder is its own npm workspace root
npm run build     # tsc -b over every package
npm test          # vitest; set BILLING_TEST_PG_URL to include a PostgreSQL server
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CHANGELOG.md](./CHANGELOG.md).

## Versioning

[Semantic versioning](https://semver.org), per package; the specs are
versioned on their own:

- **0.x (now):** a minor release (0.1 → 0.2) may break the API; a patch
  never does. Depend on `~0.1.0` or an exact version until 1.0.
- **From 1.0:** breaking changes to exports, types or behaviour only in a
  major release. A store interface may gain optional methods in a minor
  release. The conformance suite gains cases in a minor release only when a
  correct store already passes them; anything stricter is major.
- **Wire and storage formats** are named by spec (`metering-v1`,
  `report-and-lease-v1`, `http-v1`) and change only additively within a
  version. A schema change always comes with a migration note in the
  CHANGELOG.
- The packages here release together at the same version and depend on
  each other with `^` ranges.

## Status

Developed inside another project's monorepo and planned to be mirrored to
`github.com/ibisllc/billing` and published to npm under `@ibisllc/`, like
[`maintainers`](https://github.com/ibisllc/maintainers). **Neither has
happened yet** ([docs/publishing.md](./docs/publishing.md)). Nothing here
imports or depends on the project it is developed in.

## License

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0. See [LICENSE](./LICENSE).
Copyright (c) 2026 Ibis LLC.
