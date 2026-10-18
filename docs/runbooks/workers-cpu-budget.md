# Workers CPU budget (Free plan)

`.com` runs on the Cloudflare Workers Free plan (owner decision 2026-10-18). This
page is what that costs, how it is measured, what was changed to fit, and the
guard that keeps it fitting. The short version for a deploy is the last section of
`final-deploy.md` ("Free vs Paid").

## The limits that matter

| Limit (Free plan) | Value | Where we stand |
| --- | --- | --- |
| CPU per request | 10 ms (a killed request is HTTP 503 `error code: 1102`) | hot routes 1-5 ms warm (below), first request of a young isolate about 1.6x that |
| Requests per day, all Workers requests | 100,000 | boxes dominate: see "Requests a day" |
| Subrequests per request (D1 calls count) | 50 | the held `/stream` made 130 (now 8); the 6-hourly cron made 230 (now at most 14 a tick): see "Crons" |
| Cron triggers | 5 per account, 10 ms CPU and 50 subrequests per invocation | two schedules here, two in the gym Worker |
| D1 rows written / read per day | 100,000 / 5,000,000 | a heartbeat writes one row; not the limit |
| Durable Object requests per day | 100,000 | each rate-limited call is 1-3: not the limit |
| Script size | 3 MB gzip | 434 KiB (`wrangler deploy --dry-run`) |
| Static asset requests | free and unlimited **only when the Worker is not run for them** | listed static files and the whole webapp no longer run it: see "Static assets" |

Wall time spent waiting for D1 or `fetch` is free; only JavaScript is billed.

## What costs CPU, measured

Measured in real workerd (`wrangler dev --local`, see below), not guessed:

- **Each D1 binding call is about 0.5 ms of Worker CPU**, whatever it asks. A
  `batch()` is one call plus about 0.1 ms per further statement. This is the
  biggest cost: the directory read made 16 calls.
- Ed25519 verification with `@noble/ed25519` (pure JS, used everywhere because
  workerd has no synchronous Ed25519) is 1.2 ms warm and 2 to 3 ms cold. The
  platform's native check (WebCrypto `Ed25519`) is 0.05 ms.
- Noble builds a base-point table on first use: **20 ms**, once per isolate.
- The per-request floor of this Worker (routing, response headers) is small; the
  `wrangler dev` wrapper adds about 2.5 ms of its own to every request below, so the
  tables give both the raw figure and the figure net of `/api/health`.
- The first request an isolate serves runs cold code (lazy compilation, cold
  inline caches): about 1.5 to 2x the warm figure. On the Free plan most requests
  meet a young isolate, so the cold column is the one that meets the limit.

## Before and after

`scripts/cpu-workerd.ts`, 150 requests per scenario, smallest of three alternating
passes, ms of workerd CPU per request. "Net" subtracts the `/api/health` floor of
the same run (`wrangler dev`'s own overhead). D1 round trips are exact. "Cold" is
the first request in a fresh Node process, `scripts/cpu-profile.ts --cold`,
including the 0.5 ms per D1 call model; multiply by about 1.6 for workerd.

| Route | D1 calls | workerd raw before | after | net before | after | cold before | after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| GET account directory (Trusted devices), admin device | 16 to 4 | 9.0 | 4.7 | 6.7 | 1.9 | 11.0 | 4.7 |
| same, non-admin device | 14 to 4 | 7.8 | 4.6 | 5.5 | 1.8 | 8.9 | 4.6 |
| GET account profile | 8 to 4 | 5.8 | 4.1 | 3.5 | 1.3 | 5.2 | 2.8 |
| GET device-grants (read token) | 7 to 2 | 5.1 | 3.6 | 2.7 | 0.8 | 4.2 | 1.8 |
| GET /pods | 13 to 3 | 6.3 | 3.6 | 4.0 | 0.8 | 7.1 | 3.9 |
| GET /stream, first connect | 13 to 3 | 6.3 | 3.9 | 3.9 | 1.1 | 8.4 | 4.2 |
| GET /stream, stale cursor | 13 to 4 | 7.3 | 4.5 | 4.9 | 1.7 | 7.3 | 5.2 |
| **GET /stream held 25 s, nothing changes** | 130 to 8 | over 20 (Node: 19.6 ms, 130 calls) | 4.7 + 4 x 0.45 = 6.5 | n/a | 4.0 | n/a | 7.8 |
| GET /audit | 5 to 2 | 4.0 | 3.5 | 1.7 | 0.7 | 4.4 | 2.5 |
| GET apps/aliases (box) | 5 to 2 | 4.1 | 3.3 | 1.7 | 0.5 | 3.8 | 2.5 |
| POST daemon-status (box heartbeat) | 4 to 5 (adds the doorbell) | 4.5 to 5.1 | 4.7 to 4.9 | 2.1 | 2.0 | 4.0 | 3.7 |
| POST read-token mint (device / IRK / box) | 6 to 2 / 2 / 3 | (rate-limit DO in dev) | | | | 4.2 to 4.3 | 2.1 to 2.5 |
| box polls an empty lane (swk, cgk, pairing, update) | 3 | 3.5 | 3.3 to 3.9 | 1.2 | 0.5 to 1.1 | 1.8 | 2.0 |
| GET /api/notices | 0 | 2.3 | 2.5 | 0 | 0 | 1.5 | 2.1 |
| account resolve / users check / username lookup | 3 / 2 / 1 | unchanged | | | | | |

Two things the held `/stream` was doing: it rebuilt the whole pod inventory every
2 s for 25 s (12 rebuilds, 130 D1 calls: over the 50-subrequest limit before the CPU
limit), and each rebuild parsed every box's signed report. It now checks a light
inventory (one batch, nothing parsed) four times in 25 s (3, 8, 15, 25 s), and builds
the full one only to answer. A change shows up within 3 s early in the hold and 10 s
late in it; push and the approval UX do not depend on it.

## What was changed, and what each cache is keyed on

Nothing was removed from a check. Where a result is remembered, the rule for when it
stops being true is listed here.

| Change | What is remembered | Key | Lifetime / invalidation |
| --- | --- | --- | --- |
| `RequestD1` (`packages/storage/src/requestD1.ts`): reads started together leave as one `batch()` | a SELECT's rows | mode + SQL + binds, per request | dies with the request; any write except to `boot_nonces` / `rate_limit_log` empties it; a read in flight across a write is not kept; rows are copied out; the held stream uses `{ cache: false }` |
| Account routes start their reads together (`warmAccountReads`) | nothing new (fills the request's memory) | per request | per request |
| `buildPodInventory` starts independent reads together | nothing | | |
| Replay nonce claim is one `batch()` | nothing | | |
| `ed.verify` remembers a verified (signature, message, key) | the fact that it verified (pure function) | the exact bytes | process; 2048 entries, oldest out; failures in a separate 256-entry map so a flood of bad signatures cannot evict a good one. Revocation, expiry and rotation are judged by the callers on every call and are not part of the key |
| Native Ed25519 first (`edVerifyFast`) | imported public keys | public key hex | process, 256 keys; it only accepts (stricter than noble: it takes the cofactorless equation and canonical R and S), anything not accepted goes to the exact old check |
| Bearer read token whose MAC checked out | its claims | whole token string + the secret | process, 512 tokens; expiry (`exp`) and "is the signer still current" (device not revoked, IRK not rotated, server not revoked) are checked on every call |
| HMAC key for read tokens | the imported key | secret | process |
| CA public key | derived from the secret | secret + issuer | process |
| noble base-point table | built at module load (`warmCrypto.ts`) | | startup, billed separately from requests |
| Admin device directory read | nothing | | `administrator OR view-directory` is the same decision in either order; admin first spares a membership-root check its admin-root grant can never pass |

## The guard

`apps/com/test/cpuBudget.test.ts` runs every scenario in `scripts/cpuHarness.ts`
over the production D1 adapter on node:sqlite and fails when a route

- makes more D1 round trips than its budget (exact), or
- spends more JavaScript CPU (sqlite excluded) than its ratio of a calibration loop
  run in the same process (so a slow runner does not trip it; a restored noble
  verification would: it is 0.5 of the calibration).

Budgets today: D1 round trips equal to the "after" column (directory 4, pods 3,
stream 3 / 4 / 8 held, device-grants 2, audit 2, read-token 2 to 3, daemon-status 5,
lanes 0 to 3), JS ratio 0.3 for all and 0.4 for the held stream. A new route gets a
scenario and a line in `BUDGETS`; the test fails if a scenario has no budget.

Measure by hand:

```sh
npx tsc -b
npx tsx scripts/cpu-profile.ts [--only directory,pods] [--runs 60] [--cold 5] [--sql] [--json]
node --cpu-prof --cpu-prof-dir=/tmp/cpu --import tsx scripts/cpu-profile.ts --only directory --runs 300
# real workerd, offline (wrangler on PATH; state dir = `wrangler d1 migrations apply flagship-state --local --persist-to <dir>`):
npx tsx scripts/cpu-workerd.ts --state <dir> --runs 150
```

`cpu-workerd.ts` seeds the same account into wrangler's local D1, runs the signed
requests over HTTP and reads workerd's own CPU time from `ps`; its resolution is 10 ms
over the whole batch, so use 100 runs or more. Rate-limited routes (read-token,
account resolve) are skewed there by the local Durable Object. workerd's clock does
not advance during JavaScript, so there is no in-isolate timing: a number from a
deployed Worker comes from `wrangler tail` (`outcome: exceededCpu`).

## Requests a day

Boxes poll `.com`; the apps hold one long-poll while they are in the foreground.

| Source | Interval | Per day |
| --- | --- | --- |
| Box heartbeat (daemon-status) | 5 min | 288 |
| Box: alias list | 60 s | 1,440 |
| Box: admin-root rotations, self-delete, decommission, update order, transfer re-home, migration assignment | 5 min each | 6 x 288 = 1,728 |
| Box: invite revocations, share ends, device grants | 5 min each | 3 x 288 = 864 |
| Box: peer network | 10 min | 144 |
| Box: read-token mints, other | | about 5 |
| **A box before** | | **about 4,470** |
| App or webapp in the foreground | `/stream` held 25 s | 144 per hour of use |
| App launch (account read, directory, notices) | | about 3 to 5 each |
| Webapp shell install or update (about 190 files) | once per shell release per webapp user | 0 Worker requests since `webapp.` / `remote.` moved to a static-only project (it was about 190) |
| **A user** (25 min of use over 6 launches) | | **about 110** |

With the doorbell (below) a box asks only what its heartbeat reply says is waiting,
plus a safety poll of each lane and list once an hour, plus the three polls not yet
gated:

| A box after | | |
| --- | --- | --- |
| heartbeat 288, invite revocations 288, share ends 288, peer network 144 | | 1,008 |
| safety polls (update, self-delete, decommission, re-home, migration, aliases, device grants, rotations) hourly | 8 x 24 | 192 |
| **total** | | **about 1,200** |

Accounts that fit under 100,000 a day with one always-on box each:
100,000 / (1,200 + 110 x the share active that day) is **about 75**. Before the
doorbell it was 21. The alarm (70,000) is about 52 accounts. Webapp users used to add
about 190 requests each time the shell was released (the version moved almost daily);
that is gone: see "Static assets". The native apps do not load shell files.

### The doorbell

`packages/control-plane/src/boxDoorbell.ts` computes, on every heartbeat, which
lanes hold something for the box (the six mailbox lanes by the same rules their own
consume calls use, a migration naming it, a claimed transfer, a decommission order)
and a digest of the alias list, device grants and admin-root rotation chain (the
digest of the real handler's own answer). `packages/server-daemon/src/doorbell.ts`
wraps the pollers' `fetch`: a poll for an empty lane gets a local 404, a list whose
digest has not moved gets its last answer replayed, everything else goes to `.com`.
It never hides an order: every poll goes out while the doorbell is missing or older
than 12 minutes (an older `.com`, two lost beats), each lane and list is polled for
real at least hourly, and `FLAGSHIP_DOORBELL=0` turns it off. A lane that starts to
ring wakes its consumer at once. A device-book refresh a person waits on (an unknown
key signed, the members screen) always asks `.com`.

The doorbell adds up to one heartbeat (5 min) to the alias list, which used to be
polled every minute: a renamed app's new address can take up to 5 minutes to route.
The other lanes were already polled every 5 minutes.

The invite-revocation poll and the share-end poll still run every 5 minutes (576 a
day a box); both are cursor reads and want a "newest revoke / end" number in the
doorbell and an "unchanged since your cursor" local answer. That would take the
ceiling from about 75 to about 120 accounts.

## Static assets: which requests run the Worker

On Free, a request that **runs** the Worker counts against the 100,000 a day; a file
the assets layer answers on its own is free and unlimited. `run_worker_first = ["/*"]`
ran the Worker for every file. Measured with `scripts/worker-request-count.ts` against
a local `wrangler dev` (miniflare records one span per Worker invocation and none for
a file the assets layer answers):

| Page load | Worker requests before | after |
| --- | --- | --- |
| Webapp, first visit (page, service worker, every precached file; 205 requests) | 205 | 0 |
| Webapp, a new shell version (service worker + 204 precached files) | 204 | 0 |
| Webapp, a visit at the same version (service-worker update check) | 1 | 0 |
| Marketing page view of `/` (page + 9 stylesheets, scripts, fonts, icons) | 10 | 1 |
| `/docs/`, `/faq`, `/privacy`, `/status/` and the other listed pages | 1 + subresources | 0 |

How, and why in two parts:

1. **`webapp.` and `remote.` are a separate static-only project** (`apps/webapp-static`,
   Worker `flagship-webapp`). `run_worker_first` matches paths, not hosts, and these two
   hosts serve their files at the root (`/app.js`, `/lib/api.js`, `/`), so no list on
   flagship-com can free them without also freeing the marketing site's `/` the wrong
   way. The new project's assets directory IS the webapp (`npx tsx scripts/static-assets.ts
   build-webapp` copies `apps/web/public/webapp`, plus the site's `/fonts/` and
   `qrEncoder.js` the shell imports, plus a generated `_headers` with the shell CSP,
   `X-Frame-Options`, `nosniff`, `no-referrer` and HSTS from `apps/com/src/securityHeaders.ts`,
   the same function the Worker uses). A tiny script runs only for what no file answers
   and no navigation can be: a missing script or stylesheet gets a real 404 (not
   `index.html`: the old deploy-flash guard) and non-GET methods get 405. A navigation to
   a client route (`/join`) gets `index.html` from the assets layer, as before.
2. **flagship-com** keeps `run_worker_first = ["/*", "!/file", ...]`: 46 static
   files and folders (fonts, styles, scripts, images, the marketing pages, `/docs/`,
   `/status/`, `/security/`, `/downloads/`, the public key files) are answered by the
   assets layer, with their security headers from the generated
   `apps/web/public/_headers`. Everything not listed still runs the Worker, so the list
   fails safe: a new page works before anyone lists it, it just costs a request.

What still runs the Worker and must keep doing so (the toml comment lists them too):
`/api/*`, `/og`, `/qr-pipe/*`, `/builder-pipe/*`, `/build/iso/*`; the redirects
(`/me`, `/recovery*`, `/webapp*`, `/how-to`, `/ready`, `/build`, `/download*`, `/studio/`);
the app-link fallback page (`/join /share /transfer /remote /builder /access /invite
/invite-accept /app/*`); `/studio` (served at the slash-less URL); the AASA file (served
as JSON); `/` and `/index.html` (recovery.flagshipserver.com's page and the `www.`
redirect arrive on the same paths); voi.ci short links (any one-segment path);
recovery.'s own files (rewritten from `/recovery/`); and the coming-soon gate and
`/wip_` previews, **which are off** (`SITE_PUBLIC = "1"`; files served directly skip the
gate, so re-arming it means `run_worker_first = ["/*"]` alone; the guard refuses
otherwise).

Behaviour users could notice: none by design. Cache headers are the assets layer's
(`public, max-age=0, must-revalidate`) either way, so a returning visitor revalidates
and a new shell version is picked up exactly as before (the service worker still waits
for tabs to close). Two small differences: a **non-navigation** fetch of a missing
extensionless path on `webapp.` is a 404 now (it was `index.html`; nothing fetches one),
and a direct static file no longer gets the Worker's `Vary`/CORS handling (the Worker only
added CORS to `/api/*`).

Not fixed by this: `/` still costs one Worker request per page view, and the gym Worker
(`wrangler.gym.toml`) still runs first for everything and serves `webapp.gym.` itself, so
the gym does not exercise the static-only path (the unit tests and a local `wrangler dev`
smoke do).

The guard: `scripts/static-assets.ts check` runs in `scripts/predeploy-com.sh` and
`apps/com/test/staticAssets.test.ts` runs in CI. They fail when a negative pattern
shadows any path the Worker must see (a list of 59), when a pattern matches no file,
when `_headers` drifts from the list or the 100-rule limit is near, when a shared file
(a favicon) differs between the site and `recovery/`, when the SPA fallback or `/*` is
removed, when the gate would be armed, or when `webapp.` / `remote.` come back to
flagship-com.

## Crons

Free allows 10 ms of CPU and 50 subrequests per cron invocation, and 5 cron triggers per
account (the gym Worker has two). Everything a cron fired used to run in one invocation:
the 6-hourly one made 230 subrequests and about 36 ms (247 and 71 ms on Monday 00:00 UTC
with the adapter publish and model refresh), so on Free it never completed.
`apps/com/src/cronPlan.ts` now decides what each tick runs; `apps/com/test/cronBudget.test.ts`
walks a week of ticks over the real handlers (`scripts/cronHarness.ts`, 75 accounts) and
fails when a plan needs more than 40 subrequests or about 5 ms of CPU. `npx tsx
scripts/cron-profile.ts` prints the table.

| Job | What it does | D1 / fetch / CPU (75 accounts) | Decision |
| --- | --- | --- | --- |
| D1 backup | dump every table (one call each) to R2 | 89 / 0 / 44.6 ms | **moved**: `.github/workflows/d1-backup.yml` (daily, encrypted), `docs/runbooks/d1-restore.md`; Worker code removed |
| OpenRouter capability table | parse ~350 models, upsert them | 6 / 1 / 33.4 ms | **moved**: `.github/workflows/model-capabilities.yml` (same `refreshModelCapabilities`) |
| CT monitoring | crt.sh, 2 queries per user, owner push on an unexpected certificate | 76 / 150 / 35.6 ms (grows with users) | **windowed**: 4 users per even 10-minute tick (14 subrequests, 2.9 ms), all users in about 6 h at 75 accounts |
| Adapter publish (daily) | GitHub commit of the queued repo adapters | 10 / 0 / 4.6 ms idle, 25 subrequests with 4 new files | **alone at 00:30 UTC**, reads batched (idle 4 / 0 / 2.4 ms), at most 4 new files and 4 reviews a day (was 100 and 40) |
| Adapter insight (Monday) | private weekly note on retired adapters | 0 idle (AI call when there is something) | alone, Monday 01:30 UTC |
| Username suggestion refill | up to 64 candidate names, each a D1 read and a DoH lookup | 28 / 24 / 12.9 ms per 12 candidates | **capped**: 2 candidates a run, every 40 minutes (10 / 4 / 4.6 ms with its group) |
| Demo provisioning poller | promote provisioned demo servers | 1 / 0 / 0.5 ms | fits: every tick |
| Re-pair and quarantine alert ladders | schedule pushes at day/hour offsets | 1 + 1 / 0 / 1 ms | fits: every 40 minutes (was 10; thresholds are hours or days) |
| Eviction GC | drop acked decommission rows | 1 / 0 / 0.5 ms | fits: every 40 minutes |
| Stale ACME TXT sweep, legacy DNS sweep (off) | Cloudflare DNS API | 0 / 1 / 0 ms | fits: every 40 minutes (it removes records over an hour old) |
| Custom-domain verification, CA lease warning, rate-limit log and late-log pruning | | 3 / 0 / 1.4; 0 / 0 / 1.2; 1 / 0 / 0.5; one R2 list | fits: the 6-hourly invocation, 4 / 0 / 1.8 ms together |

Whole invocations after: `0 */6` 4 subrequests, 1.8 ms; `*/10` 4 to 14 subrequests,
1.4 to 4.6 ms; 00:30 UTC 4 (busy 25); Monday 01:30 0. The first request of a young
isolate is about 1.6x the CPU figures. A bigger fleet only lengthens the CT rotation
(the test checks a window stays at 13 subrequests with 400 accounts).

Not run in the Worker any more also means not visible in `wrangler tail`: the GitHub
workflows email the owner on failure, and `d1-backup.yml` fails when the newest backup is
over 36 hours old (it also notices a disabled schedule).

## Not fixed (cannot be, on the Free plan)

- Cold starts: the first request of a young isolate costs up to 2x the figures
  above; the directory read, the heaviest, is about 4.7 ms in the Node cold measure,
  so about 7.5 in workerd. Anything that adds a signature check or a round trip to it
  puts the first request over.
- `/stream` is a polling long-poll. Waking it from a write needs a Durable Object per
  account.
