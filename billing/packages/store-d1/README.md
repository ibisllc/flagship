# @ibisllc/billing-store-d1

A Cloudflare D1 `MeterStore` for [`@ibisllc/billing-metering`](../metering).
The binding is duck-typed (`prepare` / `bind` / `first` / `batch`), so the
package needs no Workers types and has no dependencies of its own.

```ts
import { D1MeterStore, d1MeterSchema } from "@ibisllc/billing-store-d1";

export default {
  async fetch(request: Request, env: { DB: D1Database }) {
    const store = new D1MeterStore(env.DB);           // { tables: { counters, batches } } to rename
    // …
  },
};
```

Create the tables with a migration (preferred):

```sh
node -e 'import("@ibisllc/billing-store-d1").then(m => console.log(m.d1MeterSchema()))' \
  > migrations/0001_metering.sql
```

or once at startup with `await store.migrate()`.

- `add` / `get` are one statement each; `addBatch` is one `batch()` (one
  transaction, one round trip) whatever the batch size. Keep reports within
  your Worker's per-invocation query limit (one statement per account plus
  two).
- Passes the full conformance suite on a node:sqlite stand-in for D1.

BUSL-1.1, Change Date 2030-05-03 → Apache 2.0.
