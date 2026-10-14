# HTTP binding v1

Status: implemented by `@ibisllc/billing-metering/http` (unreleased, after
0.1.0). **Optional.** It is one way to carry
[reports and leases](./report-and-lease-v1.md) over HTTP; a host with its own
transport (a queue, RPC, a Durable Object stub) calls `meterReport`,
`meterLease` and `LeaseBook` directly and ignores this document.

## Request

```
POST <any path>
Authorization: Bearer <edge secret>          (or whatever `authorize` checks)
Content-Type: application/json

{
  "batchId": "9f86d081884c7d659a2feaa0c55ad015",
  "items": [
    { "account": "ann",  "resource": "bandwidth", "amount": 1048576 },
    { "account": "acme", "resource": "bandwidth", "amount": 52428800 }
  ]
}
```

- `batchId`: 16–128 characters of `[A-Za-z0-9_-]`; the reference edge sends
  128 random bits as 32 hex digits. Required unless the host turns
  `requireBatchId` off for edges that predate ids.
- `items`: at most `maxItems` (default 500). `account` is 1–256 characters,
  `resource` must be in the host's catalog, `amount` a finite non-negative
  number (fractions floor). Items for the same `(account, resource)` are
  summed.
- The body is at most `maxBodyBytes` (default 1 MiB).

## Response

`200`, the batch was counted now (`duplicate: false`) or before
(`duplicate: true`, verdicts on the current totals):

```
{
  "duplicate": false,
  "results": [
    {
      "account": "ann",
      "resource": "bandwidth",
      "action": "allow",               the verdict on the counted total
      "used": 734003200,
      "allowance": 1073741824,
      "resetsAt": 1793491200000,       ms since epoch; null for lifetime
      "lease": { "action": "allow", "grant": 67108864, "policy": "throttle", "ttlMs": 600000 }
    }
  ]
}
```

One result per distinct `(account, resource)`, in first-seen order. The
plan name is deliberately not sent: an edge needs the lease, not the
subscription.

| status | body                         | the edge                                  |
| ------ | ---------------------------- | ----------------------------------------- |
| 200    | as above                     | settles: applies each lease               |
| 400    | `{ "error": "<reason>" }`    | drops the batch (it will never be valid)  |
| 401    | `{ "error": "unauthorized" }`| drops the batch                           |
| 405    | `{ "error": … }`             | drops the batch                           |
| 413    | `{ "error": … }`             | drops the batch                           |
| 408, 429, 5xx, network error, timeout | –     | keeps the batch and resends it, same id   |

`500 { "error": "internal" }` is what the handler returns when the store or
the plan lookup throws; the cause goes to `onError`, never to the edge.

## Authentication

The handler calls `authorize(request)` before reading the body. `bearerAuth(
...secrets)` accepts `Authorization: Bearer <secret>` for any listed secret,
compared in constant time; list two while rotating. Edges are your
infrastructure, so a shared secret (or mTLS in front, with `authorize`
returning true) is the expected model; this binding is not for end-user
devices.

## Edge side

`sendBatch(book, batch, { url, resource, headers, fetch?, timeoutMs?, now? })`
POSTs one `LeaseBook` batch and feeds the answer back: `settle` on 200,
`failed(retry = true)` on 408 / 429 / 5xx / network error / timeout,
`failed(retry = false)` on any other status. It returns `"settled"`,
`"retry"` or `"dropped"` and never throws for transport errors. One
`LeaseBook` meters one resource; run one per resource.

## Compatibility

Additive changes (new optional request fields, new response fields) stay in
v1; edges ignore response fields they don't know. Anything else is a v2 on a
different path.
