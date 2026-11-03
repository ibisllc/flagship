# Relay mesh runbook

How to run several relays as one data plane (design: `docs/architecture-v2/relay-mesh.md`). Every step here is an
owner step: nothing in the repo creates infrastructure by itself. Commands for prod use `FLAGSHIP_BASE_URL` unset
(`https://flagshipserver.com`); for the gym prefix them with `FLAGSHIP_BASE_URL=https://gym.flagshipserver.com` and
use the gym's `FLAGSHIP_ADMIN_SECRET`.

Names (§2): a relay `<relayId>` has the direct name `<relayId>.tunnel.<apex>` (plain A/AAAA, DNS only); boxes and
phones dial the balanced `tunnel.<apex>`; visitors reach `*.<apex>`. `tunnel` and `lb` are reserved labels: no account
can own them, `npm run zone-health` accepts every record under them, and the gym sweep never deletes them.

## 1. The encrypted feed (once per `.com`)

From §15.2 (prod names; gym in brackets):

1. `npx wrangler r2 bucket create flagship-relay-feed` [`flagship-relay-feed-gym`]. Before the next `.com` deploy: the
   `RELAY_FEED` binding is in both wrangler files and a deploy fails without its bucket.
2. Cloudflare dashboard: R2 > the bucket > Settings > Custom domain `feed.flagshipserver.com`
   [`feed.gym.flagshipserver.com`]. Then Rules > Cache Rules on that host: "Cache eligible", and under Cache key
   "Ignore query string" (so `?x=random` cannot bust the cache; §4.5). Respect the origin's Cache-Control.
3. `openssl rand -hex 32 | npx wrangler secret put RELAY_MESH_KEY_SEED` in `apps/com` [`--config wrangler.gym.toml`,
   a different value]. `SERVING_REVOCATION_SEED` (already set) is the log key.
4. Apply migration 0122 (prod and gym) and stamp the ledger; deploy `.com` (`npm run deploy`; the gym through
   `scripts/gym-refresh.sh`).
5. Admit the relays (section 2), `npm run relays -- backfill`, then set `RELAY_MESH = "on"` in the wrangler file and
   deploy, then `npm run relays -- mint-directory`: nothing writes `directory.json` while `RELAY_MESH` is off, so an
   admission made before the switch left none. The first alarm writes every page, the head and `log-key.json`.

Check: `curl -s https://feed.flagshipserver.com/v1/directory.json | jq '.directory.directoryVersion, [.directory.relays[].relayId]'`
and `curl -sI https://feed.flagshipserver.com/v1/head.json` (`cache-control: public, max-age=2`; the body is a
`RelayFeedSealed` ciphertext).

## 2. Admit a relay

One relay id runs on exactly one machine. Two machines with the same relay key replace each other's bridges every
second ("bridge down: … (1000 replaced)" in the logs, and `ops -- mesh` shows "no bridge to"). Fly makes two machines
on an app's first deploy: run `flyctl scale count 1` after it. More capacity is another relay with its own key.

1. Make its key (never reused, never replaced in place):
   `node scripts/relay-key.mjs new ~/.config/flagship/<relayId>.seed` prints the relay key;
   `node scripts/relay-key.mjs pub <file>` prints it again.
2. Admit it: `npm run relays -- add <relayId> <relayKey> full <region> --ipv4 <a,b> --ipv6 <a,b>`
   (`relayId` matches `^[a-z][a-z0-9-]{1,30}$`; the addresses are the ones phones test with the echo). A new
   directory version is minted and the mesh keys are sealed to it.
3. Give the relay its secrets: `FLAGSHIP_RELAY_KEY_SEED` (the seed file), `FLAGSHIP_RELAY_LOG_PUB`
   (`curl -s https://<control>/api/serving/revocation-key | jq -r .publicKey`), `USAGE_REPORT_SECRET` (the one `.com`
   has: usage reports, outbound checks and the relay's own `/api/stats` all use it). Env: `FLAGSHIP_MESH=on`,
   `FLAGSHIP_RELAY_ID`, `FLAGSHIP_RELAY_KIND=full`, `FLAGSHIP_RELAY_FEED_URL` (default `https://feed.<control>/v1`),
   `RELAY_ECHO_PORT`. The CA keys: the TS relay reads `FLAGSHIP_MESH_CA_KEYS` (the `.com` CA's hot public key; check it
   with `jq -r .directory.signedBy` on `directory.json`), the Rust relay reads the maintainer chain from the image's
   `/app/.maintainers` (`Dockerfile.relay` ships it; `FLAGSHIP_RELAY_MAINTAINER_PIN` only for a non-production chain).
4. Its certificate and DNS (section 4), then deploy it. It answers `/api/health` 503 with its reasons until it is
   mesh-ready: blessed, listed under its key, fresh, not draining, bridged to at least half of the other relays.
5. Add its pool to the load balancer (section 3) only once `npm run ops -- mesh` shows it ready.

## 3. Load balancing (Cloudflare)

Per §2: two balanced hostnames, both **DNS only** (grey cloud: TLS ends on the box or the relay, never at Cloudflare).

- Monitor: HTTPS, port 8443, path `/api/health`, header `Host: <relayId>.tunnel.<apex>` (one monitor per pool, or
  one monitor whose Host is set per origin), expected code 200, interval 15 s (or the plan's minimum), 2 retries.
- One pool per relay, its origin the relay's address (both families if it has both), the monitor above.
- `tunnel.<apex>`: every `full` relay's pool, proximity steering, every pool the fallback of the others.
- `*.<apex>`: every relay's pool (`full` and `entry`), same steering.

**Open point (§16 item 5): a DNS-only load balancer on a wildcard name.** Verify with Cloudflare before rollout step 4
that an LB hostname can be `*.<apex>` in DNS-only mode. If it cannot: create the LB on `lb.<apex>` and make the zone's
`*` a CNAME to `lb.<apex>` (DNS only). Note that `npm run zone-health` then reports the wildcard A/AAAA as missing and
the CNAME as a conflict (`rootWildcardStatus`, `packages/services-zone/src/rootWildcard.ts`): teach it the LB layout
in the same change. Also cost out pools, origins and health-check regions (§16 item 5).

## 4. Certificates for the tunnel names

- **Fly relays**: `flyctl certs add <relayId>.tunnel.<apex> -a <app>`; validation by DNS-01, a CNAME
  `_acme-challenge.<relayId>.tunnel.<apex>` → the target `flyctl certs show` prints (`*.flydns.net`). HTTP-01 and
  TLS-ALPN cannot work: `:443` is raw passthrough and the names may sit behind the LB. For the gym,
  `npx tsx tools/live-e2e/gym-mesh-dns.ts --apply` writes the CNAMEs from `flyctl certs show --json`.
- **`tunnel.<apex>` on several Fly apps: open.** A DNS-01 CNAME can point at one Fly app only, so only one Fly relay
  can hold a Fly-managed certificate for the shared name. To decide before rollout step 5 (second Fly relay): a
  non-Fly TLS front, or issuing the shared name ourselves. The gym avoids it: boxes dial `TUNNEL_HUB_URL` (gym-a's
  `flagship-services-gym.fly.dev`), so gym-a and gym-b carry only their direct names.
- **Non-Fly (UpCloud)**: Caddy in front of `:8443` (to the hub) and `:8444` (layer4: TLS, then PROXY v2 to the echo),
  certificates by Caddy's Cloudflare DNS-01 plugin (a token with Zone.DNS:Edit); raw `:443` straight to the relay.
  `scripts/gym-relay-c.sh` is the worked example (`tools/live-e2e/relay-c-cli.ts`). Keep NTP on (mesh checks allow
  60 s of skew).

## 5. Retire a relay

1. Drain it first so its boxes move by `retire` hints: SIGTERM (Fly: `flyctl machine stop`; UpCloud:
   `systemctl stop flagship-relay`). Remove its LB pools.
2. `npm run relays -- retire <relayId>`: a `relay-revoke` log entry (peers close its bridge and drop its attachments
   within one head), a new mesh-key epoch sealed to the others (it cannot read anything published after), a new
   directory without it. Its blessing is not renewed and lapses within 30 days. Boxes still on it leave within the
   hour (§9.4).
3. Remove its DNS (`<relayId>.tunnel.<apex>`, its challenge CNAME) and destroy the machine. The id and key are never
   reused.

## 6. Key rotation

- **A relay's key** (operator rotates): `node scripts/relay-key.mjs new <new seed file>`, then
  `npm run relays -- stage-key <relayId> <newKey> --deadline <ISO time>`. The operator restarts the relay with the
  new seed before the deadline; its first blessing request under the new key promotes it (new directory version, mesh
  keys re-sealed). Past the deadline the old key's blessing is not renewed (`relay-key-rotation-required`) and ends at
  its own expiry. `npm run relays -- key-deadline <relayId> <time|none>` sets or clears the deadline alone. To cut a
  relay off at once, retire it instead.
- **The mesh key**: `npm run relays -- rotate-mesh-key <reason>` (also automatic on retire): a new epoch, every
  active relay's key file re-sealed, the tail page and head rewritten under it. Replacing `RELAY_MESH_KEY_SEED` itself:
  set the secret, deploy, then `npm run relays -- republish`.

## 7. Rollback (§13.3)

Production at launch (one relay `iad1`, Rust, one machine of `flagship-services`): the ladder is in
`docs/runbooks/final-deploy.md` 8f (`fly.mesh.toml` = the TS hub with the mesh kept, then `fly.toml` + `flyctl scale count 2`
= mesh off); `bash scripts/release.sh --list` steps 23-28 are the bring-up.

- One relay misbehaving: retire it (section 5). Its boxes drain to the rest.
- Leave mesh mode: retire down to one relay; on it set `FLAGSHIP_MESH=off` (Fly: remove the env line, or deploy the
  non-mesh toml; the gym: `bash scripts/gym-refresh.sh` without `GYM_MESH`); point `.com`'s `TUNNEL_HUB_URL` back at its
  direct name. `.com`'s internal routes still exist for this release, so a mesh-off relay works as before. Boxes need
  nothing (a 0.3 box simply stops getting `relayId`).
- Stop publishing: `RELAY_MESH = "off"` in the wrangler file and deploy (the log is still appended and signed).

## 8. Watching it

- `npm run ops -- mesh`: every relay in the directory (from `https://feed.<control>/v1/directory.json`, else `.com`'s
  endpoints), its readiness and reasons, head age, log sequence, directory version, attachment store sizes, account
  moves, and per bridge: opens, refusals, rejected items, last heard. With `USAGE_REPORT_SECRET` set (the relays'
  `/api/stats` secret, header `x-usage-secret`) it reads the stats; without it, health only. Gym:
  `FLAGSHIP_BASE_URL=https://gym.flagshipserver.com USAGE_REPORT_SECRET=<gym value> npm run ops -- mesh`.
- **Canary**: Actions > "Mesh canary" (`.github/workflows/mesh-canary.yml`, manual): give the control host and a
  live canary box's name; it sends the box's TLS handshake to every relay's own address and checks `/api/health`, and
  names each relay that fails.
- `npm run zone-health` accepts the records under `tunnel.<apex>` and at `lb.<apex>`.

## 9. Gym: three relays

Relays (§14.1): `gym-a` (Fly app `flagship-services-gym`, iad, TS or Rust per `GYM_RELAY`), `gym-b` (Fly app
`flagship-services-gym-b`, ams, TS, IPv6-only), `gym-c` (Rust on an UpCloud VM in de-fra1, Caddy). The gym's boxes
keep dialling `TUNNEL_HUB_URL` (gym-a's fly.dev name); the live `relay-mesh` group pins its sim boxes and visitors to
each relay by its direct name and address, read from the gym `.com`'s `GET /api/services/endpoints` `relays`.

Files to have locally first:

| File | Contents |
|---|---|
| `~/.config/flagship/gym-relay-a.seed`, `-b.seed`, `-c.seed` | `node scripts/relay-key.mjs new <file>` for each |
| `~/.config/flagship/gym-dns-token` | Cloudflare token, Zone.DNS:Edit on `flagship.services` (DNS script; Caddy falls back to it) |
| `~/.config/flagship/gym-relay-c-cf-token` | optional: Caddy's own token (same scope) |
| `~/.config/flagship/upcloud-token` | the gym's UpCloud token (already there for the gym) |
| `.gym-secrets.env` | already holds `GYM_USAGE_REPORT_SECRET` and `GYM_SERVICES_CONTROL_SECRET` |

### Bring up (in order)

```sh
export GYM=https://gym.flagshipserver.com
# 0. the gym .com: feed bucket, custom domain feed.gym.flagshipserver.com + cache rule, RELAY_MESH_KEY_SEED,
#    migration 0122 (section 1, steps 1-4, gym names). The gym worktree must carry the mesh:
GYM_BASE_REF=origin/release/0.3 bash scripts/gym-refresh.sh --skip-fly-deploy

# 1. gym-c's VM first (admission wants its address)
bash scripts/gym-relay-c.sh up            # creates the VM, builds the Rust relay from the gym worktree, starts it + Caddy
bash scripts/gym-relay-c.sh status        # note the IP

# 2. gym-b's app and address (before any deploy: IPv6 only)
flyctl apps create flagship-services-gym-b
flyctl ips allocate-v6 -a flagship-services-gym-b
flyctl ips list -a flagship-services-gym      # gym-a's addresses

# 3. admit the three (relay keys from the seeds)
FLAGSHIP_BASE_URL=$GYM npm run relays -- add gym-a "$(node scripts/relay-key.mjs pub ~/.config/flagship/gym-relay-a.seed)" full iad --ipv4 <gym-a v4> --ipv6 <gym-a v6>
FLAGSHIP_BASE_URL=$GYM npm run relays -- add gym-b "$(node scripts/relay-key.mjs pub ~/.config/flagship/gym-relay-b.seed)" full ams --ipv6 <gym-b v6>
FLAGSHIP_BASE_URL=$GYM npm run relays -- add gym-c "$(node scripts/relay-key.mjs pub ~/.config/flagship/gym-relay-c.seed)" full fra --ipv4 <gym-c ip>
FLAGSHIP_BASE_URL=$GYM npm run relays -- backfill
# then RELAY_MESH = "on" in apps/com/wrangler.gym.toml and: bash scripts/gym-refresh.sh --skip-fly-deploy
FLAGSHIP_BASE_URL=$GYM npm run relays -- mint-directory     # directory.json is written only while the mesh is on

# 4. certificates and DNS
flyctl certs add gym-a.tunnel.gym.flagship.services -a flagship-services-gym
flyctl certs add gym-b.tunnel.gym.flagship.services -a flagship-services-gym-b
npx tsx tools/live-e2e/gym-mesh-dns.ts                 # dry run: read the plan
npx tsx tools/live-e2e/gym-mesh-dns.ts --apply         # direct names + Fly challenge CNAMEs (gym-c's included)

# 5. gym-b: secrets and deploy (from the gym worktree, ~/.cache/flagship/gym-worktree)
flyctl secrets set -a flagship-services-gym-b --stage \
  FLAGSHIP_RELAY_KEY_SEED="$(cat ~/.config/flagship/gym-relay-b.seed)" \
  FLAGSHIP_RELAY_LOG_PUB="$(curl -fsS $GYM/api/serving/revocation-key | jq -r .publicKey)" \
  USAGE_REPORT_SECRET="<GYM_USAGE_REPORT_SECRET>" SERVICES_CONTROL_SECRET="<GYM_SERVICES_CONTROL_SECRET>"
(cd ~/.cache/flagship/gym-worktree && flyctl deploy -c fly.gym.relay-b.toml -a flagship-services-gym-b --remote-only)
flyctl ips list -a flagship-services-gym-b             # only the v6: release any v4 it allocated
flyctl scale count 1 -a flagship-services-gym-b --yes  # a first deploy makes 2 machines; one relay id = one machine

# 6. gym-a onto the mesh profile
flyctl secrets set -a flagship-services-gym --stage \
  FLAGSHIP_RELAY_KEY_SEED="$(cat ~/.config/flagship/gym-relay-a.seed)" \
  FLAGSHIP_RELAY_LOG_PUB="$(curl -fsS $GYM/api/serving/revocation-key | jq -r .publicKey)"
GYM_MESH=on GYM_BASE_REF=origin/release/0.3 bash scripts/gym-refresh.sh      # add GYM_RELAY=rust for the Rust gym-a

# 7. all three ready?
FLAGSHIP_BASE_URL=$GYM USAGE_REPORT_SECRET=<GYM_USAGE_REPORT_SECRET> npm run ops -- mesh
```

### The live group

The group's rogue checks use a harness relay (`lib/meshSim.ts`) admitted as an **entry** relay for the run only
(entry: never a phone-ledger candidate, never a home), retired afterwards:

```sh
node scripts/relay-key.mjs new ~/.config/flagship/gym-0sim.seed
FLAGSHIP_BASE_URL=$GYM npm run relays -- add gym-0sim "$(node scripts/relay-key.mjs pub ~/.config/flagship/gym-0sim.seed)" entry test
GYM_MESH_SIM_ID=gym-0sim GYM_MESH_SIM_SEED="$(cat ~/.config/flagship/gym-0sim.seed)" \
GYM_MESH_RELAY_C_CONTROL=1 GYM_MESH_REBALANCE=1 GYM_RELAY_STATS_SECRET=<GYM_USAGE_REPORT_SECRET> \
  npx tsx tools/live-e2e/shared-run.ts --groups relay-mesh
FLAGSHIP_BASE_URL=$GYM npm run relays -- retire gym-0sim
```

- While `gym-0sim` is admitted but not bridged, every real relay counts it as a missing peer: with gym-c also drained
  (the group's "relay leaving"), gym-a and gym-b see two of three peers missing and answer `/api/health` 503
  (`bridges`). Expected during those checks; the group restarts gym-c (`gym-relay-c.sh start`) for "relay joining".
- `GYM_RELAY_STATS_SECRET` is the gym relays' `USAGE_REPORT_SECRET` (`/api/stats`, header `x-usage-secret`).
- `GYM_MESH_RELAY_C_CONTROL=1` lets the group run `bash scripts/gym-relay-c.sh drain|start`; `GYM_MESH_REBALANCE=1`
  says the relays run the shortened rebalance (`FLAGSHIP_MESH_REBALANCE_MS=60000`, set in every gym mesh profile).
- The gym sweep (`sweep-cli.ts --destroy`, and every run's leftover check) keeps gym-c's VM (`gym-relay-*`) and every
  record under `tunnel.gym.flagship.services`, so a run neither refuses to start nor tears the mesh down. To reap it
  too: `sweep-cli.ts --destroy --include-relays`, then `bash scripts/gym-relay-c.sh down` (clears its state and DNS).

### Tear down (reverse order)

```sh
bash scripts/gym-relay-c.sh down                       # its DNS, then the VM and the state file
bash scripts/gym-refresh.sh                            # gym-a back to the non-mesh profile (no GYM_MESH)
flyctl apps destroy flagship-services-gym-b --yes
npx tsx tools/live-e2e/gym-mesh-dns.ts --remove gym-a --remove gym-b --apply
# Optional, only if these relays never come back (an id is never reused): npm run relays -- retire gym-a|gym-b|gym-c
# Optional: RELAY_MESH = "off" in wrangler.gym.toml and redeploy the gym .com.
```

Keep the seed files: an admitted relay that comes back with the same seed needs no new admission.
