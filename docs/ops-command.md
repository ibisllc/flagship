# `npm run ops`: is it healthy, and where is it slow

A stand-in for a dashboard. It reads; it changes nothing.

```
npm run ops                              health + relay counters + Worker numbers (whatever it can reach)
npm run ops -- health                    .com, .services and the relay-address answer: up? how fast?
npm run ops -- services                  the relay's counters since it started
npm run ops -- workers --hours 24        Cloudflare's own numbers for the Worker
npm run ops -- slow --seconds 60         live CPU per route (use the app while it runs)
npm run ops -- limits                    rate limits (npm run rate-limits)
npm run ops -- outbound                  outbound AI hosts (npm run outbound-hosts)
```

It ends with "Worth a look:" lines and exits 3 when there are any, so a script can use it.

| command | needs | shows |
|---|---|---|
| `health` | nothing | up or DOWN, milliseconds, uptime |
| `services` | `USAGE_REPORT_SECRET` | connections routed to a box, waited for a claim (recovered or dropped: a **missed redirection**), names with no box or no account, and the last names that missed |
| `workers` | `CLOUDFLARE_API_TOKEN` (Account Analytics: Read), `CLOUDFLARE_ACCOUNT_ID` | requests per outcome (including `exceededCpu`, the 10 ms Free limit, error 1102), errors, CPU p50/p99 and wall p99 |
| `slow` | `wrangler login` | per route CPU p50/p95/max over the window, and the routes over 10 ms |

`--script flagship-com-gym` points `workers` and `slow` at the gym Worker.

The relay counters are in memory on the Fly machine (reset when it restarts, which the command
says). They are read from `GET /api/stats` on `.services`, which needs the same shared secret as
the usage pipe (`x-usage-secret`) and answers 503 without one. The `workers` query is Cloudflare's
GraphQL `workersInvocationsAdaptive`; if its field names change the command prints Cloudflare's
message rather than guessing.
