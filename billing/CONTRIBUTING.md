# Contributing

## Setup

```sh
npm ci
npm run build
npm test
```

Node 22 or later. `npm test` runs every package's tests; the PostgreSQL
store runs on PGlite (in process) and, when `BILLING_TEST_PG_URL` is set,
on a real server too:

```sh
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:18
BILLING_TEST_PG_URL=postgres://postgres:pw@localhost:5432/postgres npm test
```

CI also sets `BILLING_REQUIRE_ALL_DRIVERS=1`, which fails the run if
better-sqlite3 or the PostgreSQL server could not be tested.

## Rules

- **Generic only.** No product, plan, resource or account names from any
  host in code, tests or docs, except as obvious examples ("bandwidth",
  "api-calls", "ai-tokens", "free", "pro"). Hosts pass their catalog in.
- **Self-contained.** Nothing outside this folder may be referenced: no
  relative paths out of it, no host packages, no host tooling. CI builds it
  from a copy in an empty directory.
- **No runtime dependencies** in the core; stores take a duck-typed driver
  and list real drivers only as devDependencies.
- **Aggregates only.** Never add a field that records what was metered
  (content, hosts, addresses, prompts) or a per-request log.
- **Every store runs the conformance suite** against the real engine. A new
  rule a store must follow is a new conformance case.
- **Specs before code** for anything on the wire or in storage: update
  `docs/spec/`, then the code, then the CHANGELOG.
- TypeScript strict with `noUncheckedIndexedAccess`; ESM; tests next to each
  package in `tests/`. Comments say why, not what.

## Releasing

See [docs/publishing.md](./docs/publishing.md).
