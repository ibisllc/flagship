# Runbook — stand up the `gym.` UI-test environment

> **What this is.** The exact, ordered commands to deploy the isolated test
> environment for the UI gym (`docs/ui-test-gym.md` §6.5 + §12-G6): a parallel
> control plane at **`gym.flagshipserver.com`** + data plane at
> **`gym.flagship.services`**, on the EXISTING two Cloudflare zones (no new
> domain — rev4), with its OWN D1 / R2 / Durable Object / rate-limit namespaces.
> Test boxes are UpCloud servers labelled `flagship-env=gym`, named
> `<server>.<user>.gym.flagship.services`.
>
> **Isolation is by ZEROING, not secrecy** (§4): the `gym.` apex is
> public/knowable; the env runs against its own DB and is **wiped between runs**.
> The username `gym` is banned (prod + test) so a test cert under
> `*.gym.flagship.services` can never collide with a registered prod user or trip
> the prod CT monitor (already enforced in `packages/control-plane/src/labels.ts` —
> see step 0).
>
> **Config artifacts this runbook deploys** (already in-repo):
> - `apps/com/wrangler.gym.toml` — the `flagship-com-gym` Worker (own D1/R2/DO/RL;
>   apex `[vars]` flipped to `gym.`; `CA_ENDORSEMENT_ENFORCE` left OFF).
> - `fly.gym.toml` — the `flagship-services-gym` Fly app (same Dockerfile;
>   `FLAGSHIP_SERVICES_APEX = "gym.flagship.services"`).
>
> Both have `REPLACE_WITH_…` placeholders the steps below fill in (the new D1
> `database_id`, the gym Fly anycast IPs, the gym temp-bucket public dev-url).
>
> **Prod is untouched.** Every command here is scoped to the gym config/app by
> `--config wrangler.gym.toml` / `-c fly.gym.toml -a flagship-services-gym`. The
> prod default `apps/com/wrangler.toml` + root `fly.toml` are never opened.

---

## Running the gym (2026-10)

```sh
bash scripts/gym-refresh.sh          # bring the env current (idempotent; run before every run)
npm run gym:weekly                   # refresh → wipe → mock matrix → live run → sweep
# or just the live half, on one shared fleet, torn down at the end:
set -a; . ./.gym-secrets.env; set +a
npx tsx tools/live-e2e/shared-run.ts                          # every group
npx tsx tools/live-e2e/shared-run.ts --groups core,gating     # a subset (--list shows them)
npx tsx tools/live-e2e/shared-run.ts --all-boxes --keep       # leave the fleet up…
npx tsx tools/live-e2e/shared-run.ts --reuse gym-results/<run>/fleet.json --groups runtimes   # …and reuse it
npx tsx tools/live-e2e/fleet-cli.ts sweep [--destroy]         # list / destroy every gym server + gym DNS left
```

- **`scripts/gym-refresh.sh`** rebases the `gym` branch (main + the gym-only
  trust pin and app adoption seams) onto `origin/main` in its own worktree
  (`~/.cache/flagship/gym-worktree`) and pushes it, builds it, applies and
  stamps the gym D1 migrations, gives the gym Worker its own value for every
  secret prod has (it fails naming any it can't), deploys the gym Worker from
  the gym branch through `npm run deploy` (migration gate pointed at the gym
  D1), deploys and scales the gym Fly app, and health-checks both. A rebase
  conflict stops it: resolve on the gym branch by hand (keep main's behaviour
  plus the gym seams), then `git push --force-with-lease origin gym`.
  `GYM_BASE_REF=<branch>` deploys the gym on unlanded work (never pushed).
- **The fleet**: account A (`ga…`) gets `home` through the demo flow and
  `home2` through `/api/gym/provision` (signed with A's demo keys, including the
  admin root, since demo accounts are admin-pinned); account B (`gb…`) gets
  `home`. Groups run in phases; each writes `gym-results/live-run-<ts>/<group>.json`
  and the run writes `summary.json` (including any gym server still on UpCloud).
- **Teardown** never calls a cloud API from the laptop: the demo cleanup
  (`/api/dev/sample-user/cleanup`, force) plus the gym-only, admin-gated
  `/api/gym/teardown` (servers carrying the `flagship-env=gym` label only, plus
  the run's DNS: the boxes' records and each gym user's whole zone).
- **DNS budget**: the `flagship.services` zone is shared with prod and capped at
  200 records; a fleet uses ~20. Leftover gym records once filled it and every
  new box (prod too) failed DNS-01 with "Record quota exceeded". Always tear down.
- **Debugging a box** that won't come up: set the debug-only
  `UPCLOUD_SSH_PUBLIC_KEY` secret on the gym Worker, add a box
  (`fleet-cli.ts add-box <user> dbg`), and `tools/live-e2e/box-bringup-debug.sh <ip>`;
  delete the secret afterwards. `tools/live-e2e/journal-cli.ts <user> <server>`
  reads a serving box's daemon log.
- **Costs**: STARTER-4xCPU-8GB in de-fra1 is about €0.036/h per box (plus
  storage); a full run is three boxes for under an hour.

## First-time stand-up

## Prerequisites (operator hand — agent cannot do these)

- A shell authenticated to **Cloudflare** (`wrangler whoami` succeeds) on the
  account that owns the `flagshipserver.com` + `flagship.services` zones.
- `flyctl auth login` (Fly is NOT authed in the agent env).
- The UpCloud API token at `~/.config/flagship/upcloud-token` (the same
  account as prod's demos; the gym's servers carry `flagship-env=gym`, and the
  account must be upgraded past the trial, which blocks the hub port 8443).
- `node ≥ 20`, repo at `/Users/harrywinner/flagship`.

---

## Step 0 — confirm the `gym` reserved-username ban (already in code)

The ban is a permanent product invariant in-repo (not a rotating secret), so it
ships on `main` and is live the moment the gym Worker deploys. Confirm:

```sh
cd /Users/harrywinner/flagship
npx vitest run packages/control-plane/tests/labels.test.ts packages/services-zone/tests/validation.test.ts
# Expect: validateUserLabel("gym").ok === false (+ test/e2e/qa/ci/staging).
```

No action needed if green — `gym` is unclaimable in BOTH planes (prod's CT
monitor can therefore never false-positive on a `*.gym.flagship.services` cert).

---

## Step 1 — control plane: create the gym D1, R2, then deploy the Worker

All from `apps/com`, all scoped to the gym config.

```sh
cd /Users/harrywinner/flagship/apps/com

# 1a. Create the gym D1 database. Copy the printed `database_id`.
npx wrangler d1 create flagship-state-gym

# 1b. Paste that id into apps/com/wrangler.gym.toml, replacing
#     database_id = "REPLACE_WITH_flagship-state-gym_DATABASE_ID".

# 1c. Apply the SAME migrations dir prod uses (idempotent). Two equivalent ways:
npx wrangler d1 migrations apply flagship-state-gym --config wrangler.gym.toml --remote
#   …or apply a specific file like the CLAUDE.md examples:
#   npx wrangler d1 execute flagship-state-gym --config wrangler.gym.toml \
#       --file=../../packages/storage/migrations/0001_init.sql --remote

# 1d. Create the three gym R2 buckets (mirroring prod's flagship-iso/-temp/-backups).
npx wrangler r2 bucket create flagship-iso-gym
npx wrangler r2 bucket create flagship-iso-temp-gym
npx wrangler r2 bucket create flagship-backups-gym

# 1e. Enable the temp bucket's PUBLIC dev-url, copy the printed `pub-…r2.dev`
#     host into FLAGSHIP_R2_TEMP_PUBLIC_BASE in wrangler.gym.toml.
npx wrangler r2 bucket dev-url enable flagship-iso-temp-gym

# 1f. Set the gym Worker's OWN secrets (NEVER reuse a prod secret). Each is set
#     against the gym config so it lands on flagship-com-gym, not prod:
npx wrangler secret put FLAGSHIP_ADMIN_SECRET        --config wrangler.gym.toml
npx wrangler secret put UPCLOUD_TOKEN                --config wrangler.gym.toml   # < ~/.config/flagship/upcloud-token
npx wrangler secret put DEMO_PUBLIC_SSH_KEY          --config wrangler.gym.toml
npx wrangler secret put DEMO_PUBLIC_SSH_KEY_ID       --config wrangler.gym.toml
npx wrangler secret put DEMO_IRK_KEK                 --config wrangler.gym.toml   # openssl rand -hex 32
npx wrangler secret put SERVICES_HMAC_KEY            --config wrangler.gym.toml   # match the gym Fly app (step 2)
npx wrangler secret put CLOUDFLARE_DNS_API_TOKEN     --config wrangler.gym.toml   # Zone:DNS:Edit on flagship.services
npx wrangler secret put WEBPUSH_VAPID_PRIVATE_KEY_PEM --config wrangler.gym.toml  # mint FRESH (npx tsx scripts/generate-vapid.ts)
npx wrangler secret put WEBPUSH_VAPID_PUBLIC_KEY_B64URL --config wrangler.gym.toml
npx wrangler secret put WEBPUSH_CONTACT              --config wrangler.gym.toml
# CA_ENDORSEMENT_ENFORCE is "true" in wrangler.gym.toml: the gym branch serves its
# own chain (gymTrustMaterial.ts), whose key K must be this Worker's
# FLAGSHIP_CA_PRIV_HEX. scripts/gym-refresh.sh sets every other secret prod has.

# 1g. Build the control-plane dist FIRST (the Worker bundles the BUILT
#     @flagship/control-plane dist/ — a deploy without a rebuild ships stale
#     handler logic, per CLAUDE.md), then deploy the gym Worker. Custom domains
#     in wrangler.gym.toml self-provision DNS + edge cert for gym./webapp.gym./
#     recovery.gym./boot.gym.flagshipserver.com.
cd /Users/harrywinner/flagship && npx tsc -b
cd apps/com && npx wrangler deploy --config wrangler.gym.toml
```

Verify the control plane:

```sh
curl -s https://gym.flagshipserver.com/api/health
# Expect 200 with surface/service reflecting flagship-com-gym.
```

---

## Step 2 — data plane: create + deploy the gym Fly app, allocate IPs

```sh
cd /Users/harrywinner/flagship
export PATH="$HOME/.fly/bin:$PATH"
flyctl auth login                                  # operator hand

# 2a. Create the app (no deploy yet). The name matches fly.gym.toml.
flyctl apps create flagship-services-gym

# 2b. Set the Worker↔Fly shared secret on the Fly side (match step 1f's value).
flyctl secrets set SERVICES_HMAC_KEY="<same value as the gym Worker>" -a flagship-services-gym

# 2c. Deploy from the gym Fly config (same Dockerfile, FLAGSHIP_SERVICES_APEX set).
flyctl deploy -c fly.gym.toml -a flagship-services-gym --remote-only --strategy=rolling --yes

# 2d. Allocate the gym app's OWN anycast IPs and copy them into wrangler.gym.toml
#     (SERVICES_PASSTHROUGH_IPV4 / _IPV6 — the per-box A/AAAA target).
flyctl ips allocate-v4 -a flagship-services-gym
flyctl ips allocate-v6 -a flagship-services-gym
flyctl ips list -a flagship-services-gym

# 2e. Re-deploy the gym Worker so it publishes per-box DNS at the new IPs +
#     proxies to the gym Fly app (it already points at flagship-services-gym.fly.dev).
cd apps/com && npx wrangler deploy --config wrangler.gym.toml
```

Verify the data plane:

```sh
curl -s https://flagship-services-gym.fly.dev:8443/api/health   # Fly direct, 200
```

---

## Step 3 — DNS records (what to add; mostly auto-provisioned)

The gym reuses the SAME two zones under the `gym.` label — **no new zone**.

| Record | Type | Target | Who creates it |
|---|---|---|---|
| `gym.flagshipserver.com` | (custom domain) | flagship-com-gym Worker | **wrangler auto** (custom domain in `wrangler.gym.toml`) |
| `webapp.gym.flagshipserver.com` | (custom domain) | flagship-com-gym Worker | **wrangler auto** |
| `recovery.gym.flagshipserver.com` | (custom domain) | flagship-com-gym Worker | **wrangler auto** |
| `boot.gym.flagshipserver.com` | (custom domain) | flagship-com-gym Worker | **wrangler auto** |
| `gym.flagship.services` | A / AAAA | the gym Fly anycast IPs (step 2d) | **operator** (one manual proxied/grey A+AAAA in the `flagship.services` zone) |
| `*.gym.flagship.services` | A / AAAA | the gym Fly anycast IPs | **operator** (one manual wildcard A+AAAA) — OR rely on the Worker's per-box publish (below) |
| `<server>.<user>.gym.flagship.services` | A / AAAA | the gym Fly anycast IPs | **gym Worker auto** (publishes per registered box via `CLOUDFLARE_DNS_API_TOKEN`) |

Notes:
- The four `*.flagshipserver.com` custom domains are provisioned by `wrangler
  deploy --config wrangler.gym.toml` (DNS record + edge cert) — the same
  mechanism prod's `boot.`/`recovery.` use. No manual step.
- For `flagship.services`: the gym Worker publishes per-box A/AAAA at registration
  time (like prod). Add the apex `gym.flagship.services` + (optionally) the
  `*.gym.flagship.services` wildcard A/AAAA by hand if you want the apex/wildcard
  to resolve before any box registers; per-box records do not need the wildcard.
- **`_acme-challenge.<server>.<user>.gym.flagship.services` (DNS-01) is handled at
  RUNTIME by the gym Worker's `CLOUDFLARE_DNS_API_TOKEN`** — the gym box mints its
  own per-box Let's Encrypt cert exactly like a prod box, fenced to its own
  subdomain (`packages/control-plane/src/dns01.ts` takes the apex). No record to
  pre-create. Same zone, no new zone.

---

## Step 4 — first gym demo user (smoke the live chain)

The gym admin surface mirrors prod's `/api/dev/sample-user/*`, gated on the gym
`FLAGSHIP_ADMIN_SECRET`; boxes are UpCloud servers labelled `flagship-env=gym`.

```sh
cd /Users/harrywinner/flagship
export FLAGSHIP_ADMIN_SECRET="<the gym Worker's admin secret>"   # cached in .gym-secrets.env (GYM_ADMIN_SECRET)
# Point the CLI at the gym control plane. sample-user.mjs already honours the
# FLAGSHIP_BASE_URL env var (apps/com talks to whatever it's set to; default
# https://flagshipserver.com), so no new flag is needed — just set it:
export FLAGSHIP_BASE_URL="https://gym.flagshipserver.com"

node scripts/sample-user.mjs create gymdemo --account-name "Gym Demo"
# → {"username":"gymdemo","ready":true,...}  (a TEST box under gym.flagship.services)

curl -s https://gymdemo.gym.flagship.services/api/health 2>/dev/null || true
node scripts/sample-user.mjs cleanup gymdemo --force   # tear the demo box down
```

> `sample-user.mjs` honours `FLAGSHIP_BASE_URL` (set above) — no CLI change is
> needed to point it at the gym apex (the Worker holds UPCLOUD_TOKEN + DEMO_IRK_KEK,
> so the laptop needs only the gym admin secret). Until the env is up, the live
> gym slice in the harness detects it and SKIPS cleanly (see "the harness live
> slice" below) — `gym:total` stays green regardless.

---

## Step 5 — wipe between runs (isolation by zeroing — §4)

Re-zero the gym D1 before each gym run so there is no cross-run state. The
existing tolerant wipe runner targets a D1 binding; for the gym, run it against
the gym DB. Two ways:

**A. One-off, by command (no script edit):**
```sh
cd /Users/harrywinner/flagship/apps/com
# List the tables the canonical wipe .sql covers, then DELETE each independently
# against the gym DB (skips tables absent in the gym, like the prod runner does):
for t in $(grep -oiE 'DELETE FROM [a-z_]+' ../../scripts/wipe-all-users-prerelease-2026-06-02.sql \
            | sed -E 's/DELETE FROM //I' | sort -u); do
  npx wrangler d1 execute flagship-state-gym --config wrangler.gym.toml --remote \
      --command "DELETE FROM $t;" </dev/null >/dev/null 2>&1 \
    && echo "  wiped  $t" || echo "  skip   $t (absent in gym)"
done
```

**B. Via the guarded runner with the DB override** (the preferred path — ONE
table list, parsed from the canonical .sql; no duplication):
```sh
cd /Users/harrywinner/flagship
WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1=flagship-state-gym \
    WIPE_WRANGLER_CONFIG=wrangler.gym.toml \
    bash scripts/wipe-all-users.sh --yes
```
The runner HARD-REFUSES a non-prod `WIPE_ENV` pointed at the prod
`flagship-state` (even by default/omission), so the gym path is structurally
incapable of wiping prod. PRESERVES `marketplace_listings` + CF/SQLite
internals, same as prod.

> NEVER run the prod `scripts/wipe-all-users.sh` (it targets `flagship-state`)
> as part of a gym run — the gym wipe MUST name `flagship-state-gym`.

---

## The harness live slice (how it detects-and-skips)

The gym harness (`tools/gym`) carries a `live` vertical slice
(`tools/gym/src/live.ts`) — onboarding → create a demo server → online → approve
unlock → install a service, asserting the real D6 effects. Its adapter pings
`<CONTROL_APEX>/api/health` (default `gym.flagshipserver.com`) and **SKIPS
cleanly** (never fails) when the env isn't deployed, so `gym:total` is green
today. Once the env above is live, run it:

```sh
cd /Users/harrywinner/flagship
# Default target is the gym apex; override if you used different hosts:
export GYM_LIVE_CONTROL_APEX="gym.flagshipserver.com"
export GYM_LIVE_SERVICES_APEX="gym.flagship.services"
npm run gym -- live                 # the live vertical slice (iOS, Tier-2)
# or fold it into a full run:
npm run gym:total
```

- **iOS** launches in live mode pointed at the gym apex via the G2 seam —
  `-apex-host gym.flagshipserver.com` launch arg (sets the live-client base +
  `flagship.dev.useLiveClient`). The cert-pinning test build either carries the
  `gym.` LE chain's SPKI pin or disables pinning in the debug/test build (§12-G2).
- **webapp** runs live by serving from / pointing Playwright at the gym origin
  (`https://webapp.gym.flagshipserver.com`) instead of the static server — the
  webapp derives its apex from `window.location.origin` (§12-G2), so it talks to
  `gym.flagship.services` automatically.
- The **demo-only destructive guardrail** (§7-G) still applies: the live slice's
  create/install run against the gym demo user only.

---

## Android instrumentation — provision an AVD (one-time, optional)

The Android gym leg (`npm run gym -- total --surface android`) runs Compose UI
Test + Espresso on an emulator. The harness adapter **detects-and-skips** when no
emulator is reachable, so `gym:total` is green without one — but to actually RUN
the Android UI scenarios you need an AVD. This machine has `sdkmanager` +
`avdmanager` (Homebrew) and the SDK at `~/Library/Android/sdk` but no emulator
image yet. Provision one (the app targets API 35 / arm64):

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "emulator" "platform-tools" \
  "system-images;android-35;google_apis;arm64-v8a"
avdmanager create avd -n flagship_gym -k "system-images;android-35;google_apis;arm64-v8a" --device pixel_7
# boot headless, wait for it, then run the Android leg:
"$ANDROID_HOME/emulator/emulator" -avd flagship_gym -no-window -no-audio -no-snapshot &
"$ANDROID_HOME/platform-tools/adb" wait-for-device
npm run gym -- total --surface android      # now RUNS (was a clean skip)
```

> **Disk caveat:** the emulator + a system image are ~2 GB. This Mac was ~95 %
> full (~10 GB free) at gym build-out time — free space first (old Xcode
> DerivedData, `gym-results/`, stale git worktrees) or the install/boot will
> ENOSPC. The Robolectric JVM suite (`:app:testDebugUnitTest`) needs no emulator
> and stays the fast per-merge Android path.

---

## Teardown

Tear the gym down when not in use (it bills UpCloud + Fly while up):

```sh
# Boxes (each run tears its own fleet down; sweep any orphans + their DNS):
set -a; . ./.gym-secrets.env; set +a
npx tsx tools/live-e2e/fleet-cli.ts sweep --destroy

# Data plane (stop machines; the app + IPs persist for the next run):
export PATH="$HOME/.fly/bin:$PATH"
flyctl scale count 0 -a flagship-services-gym
# …or destroy entirely:
flyctl apps destroy flagship-services-gym

# Control plane: the Worker + its D1/R2 persist cheaply (D1/R2 are pay-per-use).
# To fully remove:
cd /Users/harrywinner/flagship/apps/com
npx wrangler delete --config wrangler.gym.toml          # removes the gym Worker + custom domains
npx wrangler d1 delete flagship-state-gym
npx wrangler r2 bucket delete flagship-iso-gym
npx wrangler r2 bucket delete flagship-iso-temp-gym
npx wrangler r2 bucket delete flagship-backups-gym
```

The manual `gym.flagship.services` / `*.gym.flagship.services` A+AAAA records (if
you added them in step 3) are the only DNS to remove by hand; the four
`*.flagshipserver.com` custom-domain records are torn down by `wrangler delete`.

---

## The weekly unattended run — `npm run gym:weekly`

`scripts/gym-weekly.sh` is the ONE command a weekly CI job runs. It wraps
`gym:total` with the warm-up / wipe / simulator / cleanup ceremony this runbook
otherwise describes by hand:

1. **Phase 0** — `scripts/gym-refresh.sh` (branch, build, D1, secrets, both
   deploys, Fly scaled to 1, health). `--skip-refresh` uses the env as deployed.
2. **Phase 0b** — re-zero `flagship-state-gym` via the guarded
   `wipe-all-users.sh` runner (step 5B above; the prod DB is hard-refused).
3. **Phase 0c** — boot the newest available iPhone simulator (if none booted)
   and the `flagship_gym` AVD headless (if no adb device). Skippable:
   `--skip-ios-sim` / `--skip-avd` / `--skip-sims`.
4. **Phase 1** — `scripts/gym-total.sh` (mock matrix → the live run on one
   shared fleet). **Weekly means FULL**: gym-total's exit 3 ("cloud skipped") and
   a live run that SKIPPED a group both FAIL the weekly run.
5. **Phase 2** (trap EXIT — always runs) — destroy every gym-labelled server and
   gym DNS record still left, scale the gym Fly app back to 0
   (`--no-scale-down` keeps it up), and shut the AVD down if the script booted it.

It ends with a one-screen report: mock / live / gating verdicts, the
`gym-results/<ts>/` dir, and duration. Exit 0 only when everything that must
run ran green. Secrets come from `.gym-secrets.env` as in `gym:total`
(required — weekly fails without the cloud half).

Self-test without touching anything: `GYM_WEEKLY_DRY_RUN=1 npm run gym:weekly`
(or `--dry-run`) walks every phase, executes nothing external, and exits 0 —
pinned by `scripts/gym-weekly.test.ts`.

---

## Operator deploy checklist (the short version)

1. **Cloudflare**: `wrangler whoami` ok; **Fly**: `flyctl auth login`; **UpCloud**:
   the token at `~/.config/flagship/upcloud-token`.
2. **Control plane** (from `apps/com`): `wrangler d1 create flagship-state-gym`
   → paste id into `wrangler.gym.toml` → `wrangler d1 migrations apply … --config
   wrangler.gym.toml --remote` → `wrangler r2 bucket create flagship-iso-gym`
   (+`-temp-gym`,`-backups-gym`) → `wrangler r2 bucket dev-url enable
   flagship-iso-temp-gym` (paste host) → `wrangler secret put …  --config
   wrangler.gym.toml` (the secret set) → `(cd repo && npx tsc -b)` →
   `wrangler deploy --config wrangler.gym.toml`.
3. **Data plane**: `flyctl apps create flagship-services-gym` → `flyctl secrets
   set SERVICES_HMAC_KEY=…` → `flyctl deploy -c fly.gym.toml -a
   flagship-services-gym` → `flyctl ips allocate-v4/-v6` → paste IPs into
   `wrangler.gym.toml` → re-`wrangler deploy --config wrangler.gym.toml`.
4. **DNS**: the four `*.flagshipserver.com` custom domains auto-provision; add
   the `gym.flagship.services` (+ optional `*.gym.flagship.services`) A/AAAA →
   the gym Fly IPs by hand; per-box + `_acme-challenge` records are runtime-auto.
5. **Verify**: `curl https://gym.flagshipserver.com/api/health` 200 +
   `curl https://flagship-services-gym.fly.dev:8443/api/health` 200.
6. **Wipe between runs**: the gym-DB loop in step 5 (names `flagship-state-gym`).
7. **Run**: `npm run gym:total` (the live slice auto-detects + uses the env;
   skips cleanly if down). **Teardown** when idle (scale to 0 / destroy).
