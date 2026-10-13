# billing

Account metering, and next anonymous vouchers, that you can drop into any
service. Nothing here knows about the service it runs in: the host passes
in its plans, its account ids and its storage.

## Status

Developed in the Flagship monorepo. The plan is the same as for
[`maintainers`](https://github.com/ibisllc/maintainers): mirror it to its
own home at `github.com/ibisllc/billing` and publish the packages to npm
under `@ibisllc/`. **Neither has happened yet.** Until then Flagship
consumes the packages as npm workspaces (`billing/packages/*`). Nothing
here imports Flagship code.

## Packages

```
billing/
├── docs/
│   └── spec/
│       └── metering-v1.md     Metering model (canonical)
├── packages/
│   └── metering/              @ibisllc/billing-metering: counters, plans, verdicts
│       └── schema/            Portable SQL (SQLite/D1 + PostgreSQL)
└── (packages/vouchers/)       next, see below
```

### `@ibisllc/billing-metering`

Counts what each account uses, per resource and period, and judges it
against the account's plan: allowed, throttled or stopped. Pure
TypeScript, no runtime dependencies, ESM only. Ships an in-memory store
and a SQL schema; bring your own store for anything else. The model is
in [docs/spec/metering-v1.md](./docs/spec/metering-v1.md).

```ts
import { meterRecord, meterCheck, InMemoryMeterStore } from "@ibisllc/billing-metering";

const deps = {
  catalog: {
    bandwidth: { unit: "bytes", period: "month", plans: {
      free: { allowance: 25 * 2 ** 30, over: "throttle" },
      pro:  { allowance: 250 * 2 ** 30, over: "allow" },
    } },
  },
  store: new InMemoryMeterStore(),
  planOf: async (account: string) => "free" as const,
};

const v = await meterRecord(deps, "ann", "bandwidth", 4096);
if (v.action === "throttle") slowDown("ann");
```

## Next: vouchers

Anonymous prepaid credit: blind-signed $1 units (RSA blind signatures,
RFC 9474). A buyer's device makes random tokens, blinds them, the issuer
signs them blind after payment, and the device unblinds them, so a
redeemed voucher can't be linked to the purchase that paid for it. The
design lives in Flagship's `docs/anonymous-vouchers.md`; it will land
here as `packages/vouchers` with its own spec under `docs/spec/`. Not
built yet.

## License

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0. See [LICENSE](./LICENSE).
Copyright (c) 2026 Ibis LLC.
