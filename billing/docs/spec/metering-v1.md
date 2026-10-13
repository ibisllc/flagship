# Metering v1

Status: implemented by `@ibisllc/billing-metering` 0.1.0.

## Model

A **counter** is a whole, non-negative number keyed by
`(account, resource, period)`:

- **account**: an opaque id chosen by the host. The library never changes
  it; normalise case (or anything else) before calling.
- **resource**: what is counted, named by the host (`"bandwidth"`,
  `"tokens"`, …).
- **period**: the window the counter belongs to, derived from the
  resource's period kind and the current time, in UTC:

  | kind       | key          | resets               |
  | ---------- | ------------ | -------------------- |
  | `month`    | `YYYY-MM`    | 00:00 on the 1st     |
  | `day`      | `YYYY-MM-DD` | 00:00 the next day   |
  | `lifetime` | `all`        | never                |

Counters only grow within a period. A new period starts a new counter at
zero; old counters stay as history.

## Catalog

The host declares, per resource, a unit (display only), a period kind and
one **plan entry** per plan name it uses:

- `allowance`: the included amount per period;
- `over`: the policy once the account is past it.

| policy     | past the allowance, the account is…                     |
| ---------- | ------------------------------------------------------- |
| `allow`    | still served; the host may bill the overage             |
| `throttle` | served slowly; the host decides how slow                |
| `stop`     | given nothing new until the period resets               |

The host also supplies `planOf(account, now)`, its subscription lookup.
It is consulted on every judgement, so an upgrade or a lapse applies at
once.

## Verdict

Every operation returns a verdict for one account and resource:

```
used       the counter after the operation
need       (input) how much more the caller is about to consume, default 0
over       used + need > allowance
remaining  max(0, allowance − used)
action     over ? policy : "allow"
resetsAt   end of the period in ms, or null for lifetime
```

`over` alone is not a refusal (an `allow` policy is over and allowed);
callers act on `action`. Passing `need = 1` asks whether anything is left,
which is how a `stop` resource refuses a new grant at exactly its
allowance.

## Operations

- **record(account, resource, amount, need)**: atomically add `amount` to
  the current period's counter, then judge the new total. For where usage
  is observed.
- **check(account, resource, need)**: judge without recording. For before
  handing out something that consumes the resource.

Amounts and needs must be finite and non-negative; fractions floor. A
resource missing from the catalog, or a plan missing from a resource, is a
host bug and throws.

## Storage

A store implements `add` (atomic increment returning the new total) and
`get`. The reference SQL (`packages/metering/schema/meter_counters.sql`)
is one table keyed by `(account, resource, period)` with a single-statement
upsert, portable across SQLite 3.35+ (including Cloudflare D1) and
PostgreSQL. Amounts are 64-bit (a month of bytes exceeds 32).

## Accuracy and failure

The library assumes the host batches and reports usage; a report that is
lost under-counts, and a counter is never decremented. Hosts should fail
open on a metering outage for `throttle` resources (serving at full speed
beats cutting a user off) and decide for themselves for `stop` resources.
A `stop` check before a grant cannot see usage not yet reported, so grants
outstanding at the moment of the check can overshoot by their own size.

## Privacy

A counter holds an account id and a number. Nothing about what was
metered (content, hosts, addresses, prompts) belongs in a store.
