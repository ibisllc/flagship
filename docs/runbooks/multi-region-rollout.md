# Multi-region Fly rollout (iad + fra + syd)

**Status:** Planning. Trigger criterion documented; deploy commands
ready to execute when the trigger fires.

## Why multi-region

`flagship-services` currently runs in a single Fly region (`iad`). Every
user's tunnel WS, every `:443` SNI passthrough, every peer-backup
matchmaker connection routes through one machine in northern Virginia.
For a Sydney user, every HTTPS request pays ~200ms RTT just to talk to
their own pod. For an EU user, ~80ms.

The data plane is **stateless** (per `fly.toml`'s comment). The Fly app
holds no persistent state — tunnel registry is in-memory, peer-backup
matchmaker state is ephemeral. Multi-region is structurally trivial;
the question is when, not how.

## Trigger criterion

**Roll out fra + syd when monthly paid-tier revenue exceeds $50/month.**

At our pricing surface (LLM-promo bootstrap + dispatcher overage +
custom domains + reserved trademark names) and ~1% paid-conversion at
~$5 ARPU, that's roughly 1000 active users. The two new always-on
machines cost ~$15/mo combined; revenue covers ~3× the marginal
hardware cost at that threshold.

Don't roll out earlier. The Fly floor cost (currently ~$5/mo for one
shared-cpu-1x machine) is the existential-threat criterion that lets
Harry keep paying personally for years if needed. Tripling the floor
before revenue justifies it is a regression of that property.

## Deploy commands

When the trigger fires, execute in this order:

```sh
# 1. Scale the Fly app to three regions, two machines per region for
#    the in-region rolling deploy budget already documented in fly.toml.
flyctl scale count 6 --region iad,fra,syd \
  -a flagship-services

# 2. Bump the machine size on every region.
flyctl scale vm shared-cpu-1x --memory 1024 \
  -a flagship-services

# 3. (Optional) Tag the deploy.
flyctl deploy --remote-only --strategy=rolling \
  --build-arg REGION_HINT=multi \
  -a flagship-services
```

## Per-user DNS routing

Fly anycast IPs route inbound packets to the nearest healthy machine
automatically. So `*.flagship.services` continues to resolve to the
single anycast pair `(149.248.216.86, 2a09:8280:1::110:d2b6:0)`.
**Most users need no DNS changes.**

The exception is users whose home network has a stable preference
for one specific region (e.g., a US-East user whose ISP is closer to
the EU anycast point). For those, the Worker can write a per-user
A-record pointing at a region-specific Fly machine IP instead of the
global anycast pair.

Implementation hook in `apps/com/src/route.ts`:

```typescript
// At /api/server/register time, derive the user's optimal region
// from CF-Connecting-IP geo headers (cf-ipcountry, cf-ipcontinent)
// and write an A record pointing at a region-specific Fly hostname:
//   iad → flagship-services-iad.fly.dev → resolves to iad machine's IP
//   fra → flagship-services-fra.fly.dev
//   syd → flagship-services-syd.fly.dev
//
// Users can override via the webapp Settings → "request rebalance"
// flow which re-runs the geo derivation against their current IP.
```

We don't ship this code path until the regions actually exist. When
the deploy commands above run, the same commit (or a follow-up)
should add the per-user A-record routing — flag the work item in
`docs/build-tasks.md` so it lands in the same release as the scale-up.

## Observability after rollout

- Fly metrics: per-region latency histograms, per-region tunnel count.
- The Worker's `/api/_status/probe` should be extended to ping each
  regional hostname individually so the public `/status/` page can
  show per-region health.
- Alert on any region's tunnel count dropping to zero (probable
  routing issue).

## Cost rollback

If revenue drops below the trigger threshold after the scale-up,
scale back down via:

```sh
flyctl scale count 2 --region iad -a flagship-services
flyctl scale count 0 --region fra,syd -a flagship-services
```

Stop-not-destroy: machines can be re-launched in &lt;5min if revenue
recovers. Avoid full destroy + recreate to preserve the regional IP
allocations.

## Why not earlier

Common arguments to scale early — "it's just $15/mo," "global users
deserve good latency from day 1" — both ignore the path dependence.
Adding region-2 before there's enough traffic to fill region-1 means:
- Every user pays for redundant capacity that's only useful when the
  Fly machine count grows.
- The per-user-A-record routing code path becomes a maintenance
  burden before it's load-bearing.
- The cost line item in the README's "$20/mo floor" pitch slides up
  permanently. People notice.

Wait for the revenue.
