# demo-users bootstrap (one-pager)

One-time setup the operator runs on this Mac so `scripts/sample-user.mjs
create demoalice` works end-to-end. Reference for the live Phase F
exercise.

## Prerequisites

- Cloudflare auth (operator is already logged in for `wrangler deploy`)
- Hetzner Cloud project with API access
- Repo cloned at `/Users/harrywinner/flagship` (or wherever)
- Node ≥ 20 (`node --version`)

## Steps

### 1. SSH keypair

Generate the keypair `flagship-demo-ssh` (Ed25519). The private half
stays on this Mac and is used by the rescue+dd step inside the Phase A
harness; the public half is mirrored to Hetzner once and re-uploaded
into the Worker so it can be passed to `POST /servers` on every
on-connect provision.

```sh
ssh-keygen -t ed25519 -f ~/.ssh/flagship-demo-ssh -N "" -C "flagship-demo"
test -f ~/.ssh/flagship-demo-ssh.pub && echo "ok"
```

### 2. Hetzner project + token

Create a project + API token in https://console.hetzner.cloud/projects.
The token needs `read+write`. Stash it:

```sh
export HCLOUD_TOKEN="<your-hetzner-api-token>"
```

Upload the SSH pubkey to that project. The Phase A harness does this
idempotently the first time you `node tools/vps-e2e/dist/cli.js`
runs in non-`--plan` mode, but for clarity:

```sh
HCLOUD_TOKEN=$HCLOUD_TOKEN \
node tools/vps-e2e/dist/cli.js --plan  # smoke the chain (no I/O)
```

### 3. Worker secrets

The Worker needs three pieces wired before `/api/dev/sample-user/*`
will respond with anything but 503:

```sh
cd apps/com
npx wrangler secret put HCLOUD_TOKEN          # paste the token
npx wrangler secret put DEMO_PUBLIC_SSH_KEY   # paste the .pub
# DEMO_PUBLIC_SSH_KEY_ID — set ONCE the public key is uploaded to
# Hetzner; copy the numeric `id` from `GET /v1/ssh_keys?name=flagship-vps-e2e`
npx wrangler secret put DEMO_PUBLIC_SSH_KEY_ID
```

The existing `FLAGSHIP_ADMIN_SECRET` is already set; the same bearer
gates `/api/dev/sample-user/*`.

### 4. Operator shell

```sh
export FLAGSHIP_ADMIN_SECRET="<existing>"
export HCLOUD_TOKEN="<from step 2>"
# DEMO_SSH_KEY_PATH defaults to ~/.ssh/flagship-demo-ssh — only set
# this if you used a different path in step 1.
```

### 5. Smoke `--help`

```sh
node scripts/sample-user.mjs --help
```

Exit code 0. Prints usage. NO env required for `--help`.

### 6. First demo user (Phase F)

```sh
node scripts/sample-user.mjs create demoalice --account-name "Demo Alice"
```

End-of-run line on stdout, JSON for piping:

```json
{"username":"demoalice","ready":true,"snapshotId":"<numeric>","isoR2Key":"demo-isos/demoalice-<sha8>.iso"}
```

D1 row: `state='none'`, `snapshot_id=<numeric>`. Subsequent
`/connect` calls boot from the snapshot in ~30s.

## Teardown

```sh
node scripts/sample-user.mjs delete demoalice
```

Removes the snapshot, the R2 ISO, and the D1 row. If a temp Hetzner
server is still running (e.g. you ctrl-C'd in the middle of a `create`),
this also destroys it.

## Exit codes (`docs/sample-users.md` §14.2)

- 0 success
- 1 generic failure (network, malformed args, partial rollback)
- 2 admin auth failure
- 3 Hetzner API failure
- 4 D1 conflict (username already claimed by a real account)

## Where things live

- `scripts/sample-user.mjs` — this CLI
- `tools/vps-e2e/src/providers/hetzner.ts` — rescue+dd + snapshot()
- `packages/iso-personalizer/bin/personalize-iso.mjs` — ISO build
- `packages/control-plane/src/demoUsers.ts` — Worker handlers
- `apps/com/src/hetzner.ts` — Worker-side Hetzner client
- `docs/sample-users.md` — full spec
- `docs/sample-user-vps-plan.md` — execution plan (Phases A–F)
