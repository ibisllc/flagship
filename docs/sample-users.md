# Sample users — on-connect Hetzner provisioning spec

**Status:** ratified. Source of truth for Phases C / D / E / F of Plan A
(`docs/sample-user-vps-plan.md`).

**Scope:** the engineering contract every downstream PR is implemented
against. Every section ends with concrete, implementation-ready bullets
a sub-agent can open the file at and start coding from.

**Out-of-scope:** real-account multi-device + recovery hardening lives
in Plan B (`docs/v1.2-security-cascade.md`). The two plans are
independent.

---

## 1. Overview

The operator runs `node scripts/sample-user.mjs create demoalice
--display "Demo Alice"` from their laptop. The CLI builds a
personalized Flagship ISO, uploads it to R2, provisions **one**
temporary Hetzner CX22, lets the daemon install + register + obtain a
real Let's Encrypt cert end-to-end, snapshots the booted disk via
Hetzner's `create_image` action, destroys the temp server, and stores
the snapshot id in D1.

From that point on, any iOS / Android / webapp client that types
`demoalice` short-circuits into demo mode and sees **one** device.
Tapping that device fires `POST /api/dev/sample-user/demoalice/connect`;
the Worker calls Hetzner `POST /servers` with `image: <snapshot_id>`,
which restores the snapshot in roughly 30 seconds. The client polls
`/api/users/check` until the response carries
`demoServer.status: "up"`, then connects to `home.demoalice.flagship.
services` over the real ACME-issued cert. All `/api/screens/*`
interactions are LIVE — no fixtures.

After `ttlIdleMinutes` (default 30) of `last_activity_at` silence, the
every-10-min cron destroys the Hetzner server (the snapshot is kept).
The next client connect re-restores the snapshot in roughly 30 seconds.
`delete-sample-user` tears down everything: server if up, snapshot,
R2 ISO, and the D1 row.

The whole feature is a strict superset of today's `TEST_ACCOUNTS` +
`DemoFixtures` plumbing — `/api/users/check` continues to return a
`testAccount` block for backward compatibility, plus a new
`demoServer` block when the matched username has a `demo_users` row.

Implementation-ready bullets:

- Three new tables of work — D1 schema (§8), Worker endpoints (§10),
  client demo-mode upgrades (§D in `sample-user-vps-plan.md`).
- One new Worker module `apps/com/src/hetzner.ts` (§7).
- One new operator CLI `scripts/sample-user.mjs` (§14).
- One new D1 migration `0027_demo_users.sql` (§8).
- Two new Worker secrets `HCLOUD_TOKEN` + `DEMO_PUBLIC_SSH_KEY` (§9).
- One new cron entry alongside the existing 6-hour one (§11).

---

## 2. Demo username model

### 2.1 No required prefix

Username is a normal-looking string. Operator picks whatever they want:
`demoalice`, `alice-prog`, `reviewer`, `officetour`. There is **no**
mandatory `demo-` prefix and no namespace separation from real
usernames at the label-validation layer.

What makes a username "a demo" is the presence of a row in the new
`demo_users` D1 table (§8). That is the **only** authoritative signal.

### 2.2 Relationship to `TEST_ACCOUNTS`

`TEST_ACCOUNTS` (Worker secret, JSON map) is the **legacy display-
metadata** hook. It exists today in
`apps/com/src/controlPlaneRoutes.ts:176` (the `TEST_ACCOUNTS?: string`
env field), with the parser
`parseTestAccountsEnv` consumed at
`apps/com/src/controlPlaneRoutes.ts:285` and the handler
`handleUsersCheck` in
`packages/control-plane/src/usersCheck.ts:79-167`.

Phase C **extends** the existing `handleUsersCheck` so that when a
username matches a `demo_users` row, the response carries both the
existing `testAccount` block (for backward compatibility with already-
shipped iOS/Android binaries) **and** a new `demoServer` block (§10).
`TEST_ACCOUNTS` continues to carry the display string + ttlHours; the
`demo_users` row is the source of truth for VPS state.

The `create-sample-user` CLI writes to **both**: it appends the
username to `TEST_ACCOUNTS` and inserts a row into `demo_users`.
`delete-sample-user` removes both. The Worker treats absence of a
`demo_users` row as "not a live demo, fall back to fixtures" — i.e.
backward-compatible with the today behaviour for usernames that exist
only in `TEST_ACCOUNTS`.

### 2.3 Username uniqueness

A username in `demo_users` AND in the real-account `usernames` table is
a conflict. The `create-sample-user` endpoint MUST reject with a clean
error before writing either row:

- Read `usernames` first; if a row exists, return
  `{ "error": "username already claimed by a real account" }`
  with HTTP 409.
- Write to `demo_users` second; on a primary-key collision return
  `{ "error": "demo username already exists" }` with HTTP 409.

The reverse path — real-account claim of a username that's a live
demo — is already blocked by the existing claim handler because
`/api/users/check` returns `available: false` for any test-account
match (see `usersCheck.ts:109`).

### 2.4 Demo username naming convention

Enforce a strict pattern on `create-sample-user`. The CLI rejects
locally before calling the Worker; the Worker enforces again
defensively:

```
^[a-z0-9-]{3,32}$
```

with a small reserved-words guard list rejected even when otherwise
syntactically valid:

```
admin, flagship, support, www, api, dev
```

These overlap with the existing `validateUserLabel` reserved list
(see `packages/control-plane/src/labels.ts`); the create-sample-user
endpoint MUST run `validateUserLabel` first, then apply the demo-
specific length cap (32 chars; tighter than the general label cap to
keep the FQDN compact: `home.<u>.flagship.services` is 32 + 26 = 58
chars, well under the 63-char DNS label limit).

Implementation-ready bullets:

- Phase C: add a `demo_users.username` `PRIMARY KEY` constraint (§8).
- Phase C: extend the existing `handleUsersCheck` to merge in the
  `demoServer` block from a new `DemoUsersStorage` interface. Don't
  remove the `testAccount` block — old clients depend on it.
- Phase C: add `parseDemoUsername(s: string): { ok: true } | { ok:
  false, reason: string }` in `apps/com/src/demoUsers.ts` that runs
  `validateUserLabel` + the 32-char + reserved-words checks.
- Phase E: CLI rejects malformed usernames before the HTTP call so
  the operator gets an immediate error.

---

## 3. Multi-device model for demos

### 3.1 Shared deterministic UMK

Demo accounts use a **shared, public-salt UMK**:

```
UMK = HKDF(
  salt = "flagship-demo-v1",            // public, constant
  ikm  = "demo-" + username,            // public
  info = empty,
  length = 32                            // bytes
)
```

The `IRK` is derived from this UMK using the same KDF the real
identity path uses (`HKDF-Expand(UMK, "irk-v1", 32)`). Every device
that types `demoalice` derives the same UMK and therefore the same
IRK, so all demo devices share an identity.

This is **non-secret by design**. A demo account is a public, copy-
disposable sandbox — leak of the UMK is meaningless because the entire
identity is reproducible by anyone with the username. The model would
be wrong for a real account; that's why Plan B exists.

The salt string MUST be `"flagship-demo-v1"` exactly (bumped only on a
breaking demo-protocol change). The username is lowercased before
HKDF.

### 3.2 Per-device paired-session

Each device that joins a demo account creates its own paired-session
against the demo VPS, using the shared UMK + IRK to sign the pairing
envelope. The demo VPS daemon accepts the envelope normally because
the IRK matches the one it was provisioned with.

Multiple paired-sessions per demo username are explicit + welcomed —
the whole point is that an iPhone + an iPad + a desktop browser can
all join `demoalice` and see the same one device.

### 3.3 Concurrent-paired-session cap

**Cap: 3 active paired-sessions per demo username.** When a 4th device
joins, the daemon displaces the LRU session (oldest `last_used_at`).
This prevents N reviewers from piling on a single demo and blowing
past the daemon's per-pod session table.

The cap is enforced in the daemon's paired-session admission path
(reuses the existing per-pod cap mechanism with a demo-mode override:
`maxPairedSessions = 3` when `daemon.isDemo == true`).

### 3.4 Destructive-op scoping on demo accounts

The mobile / web UIs surface "Replace device", "Disconnect", "Wipe &
restart", "Self-revoke", etc. On demo accounts these MUST be scoped to
the demo VPS only — never let a demo user accidentally affect a real
account's state.

Defence in depth:
- Demo and real accounts live in different D1 tables (`demo_users` vs
  `usernames` + `paired_sessions`); a demo destructive op physically
  cannot find a real row to mutate.
- The daemon's wipe-restart handler is reachable only on the demo
  VPS's FQDN — destroying the demo VPS does not affect any other
  pod.
- The mobile demo-mode renderer (Phase D) tags destructive ops with
  `isDemo: true`; the per-op handlers route to a `demoRestoreOrNoop`
  path that either re-provisions the demo VPS from snapshot or returns
  a believable success without changing identity.

Implementation-ready bullets:

- Phase D (iOS/Android/webapp): in the wipe / disconnect / replace
  surfaces, when `AppState.isDemo == true`, dispatch to a
  demo-specific handler that calls `POST /api/dev/sample-user/<u>/
  connect` (re-provision) instead of the real `wipe-restart` /
  `replace` endpoints.
- Phase D: a per-platform conformance test asserting that the demo
  destructive-op handlers do **not** invoke any real-account RPC.
- Phase C: server-daemon's paired-session admission path adds a
  `maxPairedSessions: 3` cap when `Daemon.isDemo` is set (a new
  boot-time flag picked up from the apkovl trailer — Phase A's ISO
  personalizer is extended to emit the flag).

---

## 4. Server lifecycle state machine

### 4.1 States

| State | Meaning |
|---|---|
| `none` | No Hetzner server provisioned for this demo user. Either never connected, or last server was reaped by the idle cron. |
| `provisioning` | Hetzner `POST /servers` returned an ID. Awaiting `status == 'running'` AND daemon registration with `.com` (the existing `install_events` path). |
| `up` | Server fully booted; client `/api/screens/*` interactions go through. |
| `idle-pending-teardown` | `last_activity_at < now - ttl_idle_minutes` AND the cron pass has identified this row. Transient state during the destroy call. |

The row stays in the table at all times; the `state` column moves.
`active_server_id` and `active_server_fqdn` are populated when state
is `provisioning` or `up`, NULL when state is `none` or
`idle-pending-teardown` (after a successful destroy).

### 4.2 Transitions

```
                     POST /connect (first time)
       none ─────────────────────────────────────────► provisioning
        ▲                                                   │
        │                                                   │ Hetzner status=running
        │                                                   │ AND daemon registered
        │                                                   ▼
        │                                                  up
        │                                                   │
        │                                                   │ cron pass:
        │                                                   │ last_activity_at
        │                                                   │ < now - ttl_idle_minutes
        │                                                   ▼
        │                                          idle-pending-teardown
        │                                                   │
        └───── Hetzner DELETE /servers/{id} 2xx OR 404 ─────┘
```

### 4.3 Transition triggers — precise

| From | To | Trigger | Side-effect |
|---|---|---|---|
| `none` | `provisioning` | `POST /api/dev/sample-user/{u}/connect` and current state is `none` | `POST hetzner /servers` with `image=snapshot_id`; persist `active_server_id`; `last_activity_at = now` |
| `provisioning` | `up` | Cron poll observes `hetzner GET /servers/{id}.status == 'running'` AND `install_events` for the demo FQDN includes a `registered` event | Persist `active_server_fqdn` |
| `provisioning` | `provisioning` | `POST /connect` arrives while still provisioning | No-op: return 200 with current `{ fqdn: null \| <fqdn>, status: "provisioning" }`; do NOT bump `last_activity_at` |
| `up` | `up` | `POST /connect` OR `POST /heartbeat` arrives | `last_activity_at = now` |
| `up` | `idle-pending-teardown` | Cron pass observes `last_activity_at < now - ttl_idle_minutes * 60_000` | Issue `hetzner DELETE /servers/{id}` |
| `idle-pending-teardown` | `none` | DELETE returns 2xx OR 404 | Clear `active_server_id`, `active_server_fqdn` |
| `idle-pending-teardown` | `idle-pending-teardown` | DELETE returns non-2xx-non-404 | Leave row as-is; next cron pass retries the DELETE |

### 4.4 Concurrent-request semantics

- **`POST /connect` on `provisioning`** → no-op, 200 with current
  status. Do NOT bump `last_activity_at` (otherwise a flaky client
  poll loop holds the server forever).
- **`POST /connect` on `up`** → updates `last_activity_at` only. The
  Hetzner client is NOT called.
- **`POST /heartbeat` on `up`** → updates `last_activity_at` only.
- **`POST /heartbeat` on `none` / `provisioning`** → 409 with
  `{ error: "no active server; call /connect" }`. Heartbeat is for
  keep-alive, not provision.
- **Two concurrent `POST /connect` on `none`** → resolve by writing
  `state='provisioning'` with a `D1` `UPDATE ... WHERE state='none'
  RETURNING ...`. The losing writer reads the now-`provisioning` row
  and returns the same 200 the winner does.

### 4.5 Idempotency invariants

- `Hetzner DELETE /servers/{id}` 404 is treated as success — the
  server might already be gone (manual op via Hetzner console;
  earlier cron pass partially succeeded). The Worker collapses 404 to
  2xx in `apps/com/src/hetzner.ts:destroyServer`.
- `Hetzner POST /servers` is not natively idempotent. The Worker
  guards by checking `demo_users.state` first; only state=`none`
  transitions to provisioning. A duplicate `POST /servers` due to a
  Worker retry within the same request is acceptable risk (Cloudflare
  doesn't retry POSTs) and not specifically defended against.

Implementation-ready bullets:

- Phase C: `apps/com/src/demoUsers.ts` exports a `transition(db,
  username, action): NextState` pure-ish function that's the single
  arbiter of legal transitions.
- Phase C: the `connect` handler calls `transition` then dispatches
  `hetzner.ts:createServer` only if the next state is `provisioning`.
- Phase C: state-machine unit tests cover every cell in the §4.3
  table including the concurrent-`/connect` race (two parallel calls
  end with exactly one `POST hetzner /servers`).

---

## 5. Pre-built artifacts (ISO + snapshot)

### 5.1 Create flow (`create-sample-user`)

This runs **on the operator's laptop**, not in the Worker. The Worker
is consulted only for the D1 write at the start (and to confirm via
`/install-complete` at the end).

1. **Build a personalized ISO locally.** Use
   `packages/iso-personalizer/bin/personalize-iso.mjs` (Phase A
   deliverable). Inputs: username, server name (default `home`), base-
   ISO bytes from `apps/web/public/build/iso/flagship-base-alpine-
   3.21.0-x86_64.iso`. Output: `<temp>/flagship-demo-<username>-
   <sha8>.iso` on the operator's laptop.

2. **Upload to R2** at `demo-isos/<username>-<sha8>.iso` in bucket
   `flagship-iso-temp`. Use the existing `wrangler r2 object put`
   pipeline so the operator's normal Cloudflare auth applies; no R2
   token in the CLI. Object metadata MUST include:
   - `created_at` — ISO-8601 UTC of the upload moment
   - `created_by` — `git config user.email` from the operator's repo
   - `flagship_username` — the demo username

3. **Provision one temp Hetzner CX22** from the ISO using Phase A's
   `HetznerProvider.provision()` (rescue-mode + dd, R2 presigned URL).
   The harness mints the presigned URL with a 1-hour TTL.

4. **Wait for the daemon to fully install + register + ACME.** ≤10
   min budget. The harness uses its existing `awaitInstallRegistered`
   + `awaitUnlock` + `probeGreenPadlock` stages from
   `tools/vps-e2e/src/stages/`. Acceptance: a green padlock on
   `https://home.<username>.flagship.services/`.

5. **Snapshot.** `POST /servers/{id}/actions/create_image` with
   `type: "snapshot"`, `description: "flagship-demo-<username>"`. Poll
   `GET /images/{image_id}` until `status: "available"` (Hetzner
   nomenclature: an in-progress image is `creating`, then `available`).
   Capture the `image_id` (numeric) — that's the `snapshot_id`.

6. **Destroy the temp server.** `DELETE /servers/{id}`. 2xx or 404
   both count as success.

7. **Persist `snapshot_id` in D1.** The CLI calls `POST /api/dev/
   sample-user/<u>/install-complete` (admin-auth) with body `{
   snapshot_id, iso_r2_key }`. The Worker writes both columns and
   transitions the row from `state='none'` (which it's been since
   create) — no state change, just persistence.

### 5.2 On-connect flow (per request, per demo user)

This runs **in the Worker**:

1. **Verify state.** Read `demo_users` by username. If state ≠
   `none`, return early (see §4.4 concurrent semantics).

2. **`POST hetzner /servers`** with:
   ```json
   {
     "name": "demo-<username>-<short-uuid>",
     "image": <snapshot_id>,
     "location": "<region>",
     "server_type": "<size>",
     "ssh_keys": [<demo_ssh_key_id>],
     "start_after_create": true,
     "labels": { "flagship-demo": "<username>" }
   }
   ```
   Hetzner restores the snapshot in ~30 seconds. The server boots
   directly into the fully-installed Flagship system — no rescue mode,
   no dd, no install.sh.

3. **Update D1.** `state='provisioning'`, `active_server_id =
   <server_id>`, `last_activity_at = now`.

4. **Return** `{ fqdn: "home.<username>.flagship.services", status:
   "provisioning" }` to the client.

5. **Client polls `/api/users/check`** every ~3 seconds. The Worker
   side has a cheap cron-driven status poller (§11 details) that
   transitions `provisioning → up` once Hetzner reports `running` AND
   `install_events` shows a recent `registered` event for the FQDN.

6. **Daemon startup.** On boot the daemon notices its FQDN already
   resolves to the (new) public IPv4 — the routing DNS publish from
   the original install is idempotent. The tunnel-hub WebSocket
   reconnects automatically. The Let's Encrypt cert in the daemon's
   sealed LUKS volume is reused (still valid — snapshots persist disk
   state including `/var/lib/flagship/`). No new ACME run is needed
   unless the cert is within 30 days of expiry, in which case the
   daemon's renewer kicks in naturally.

### 5.3 What is in the snapshot

A fully-installed Flagship system, post-ACME, post-registration. This
includes:
- LUKS-encrypted root volume with the sealed unlock key already in
  place (the daemon picks it up via the existing
  `/api/server/{fqdn}/unlock-key/lease` path on first boot).
- The Let's Encrypt cert + private key under `/var/lib/flagship/
  caddy/`.
- The daemon's identity binding to the demo username's IRK.

What is **not** in the snapshot:
- Any per-session state — those are reconstructed on first daemon
  boot.
- DNS records — those live on Cloudflare and are re-published
  idempotently on daemon startup.

Implementation-ready bullets:

- Phase A (already done): `personalize-iso.mjs` CLI.
- Phase E: `scripts/sample-user.mjs` orchestrates steps 1-7.
- Phase E: `scripts/sample-user.mjs` reuses
  `tools/vps-e2e/src/providers/hetzner.ts` for steps 3-6; the
  snapshot step adds a new `HetznerProvider.snapshot(serverId,
  description): Promise<{ snapshotId: string }>` method.
- Phase C: Worker-side `apps/com/src/hetzner.ts` implements
  `createServerFromSnapshot(snapshotId, name, region, size,
  sshKeyId)` and `destroyServer(serverId)` — narrower than the
  harness's HetznerProvider, no SSH client.
- Phase C: `POST /api/dev/sample-user/<u>/install-complete` endpoint
  takes `{ snapshot_id, iso_r2_key }` and writes both columns.

---

## 6. R2 storage

- **Bucket:** `flagship-iso-temp`. **Phase C reserves the binding**
  via `apps/com/wrangler.toml` even though the Worker's live request
  path does not read from it (the snapshot replaces the ISO). The
  binding lets the cron / admin endpoints clean up R2 objects on
  `delete-sample-user`. Bucket creation (one-time): `npx wrangler r2
  bucket create flagship-iso-temp`.

- **Path:** `demo-isos/<username>-<sha8>.iso` where `<sha8>` is the
  first 8 hex chars of the personalized ISO's SHA-256 (computed
  locally during the build step, before upload).

- **Retention:** keep until `delete-sample-user` runs. No TTL, no
  lifecycle rule. The ISO is also retained for diagnostics ("what
  exact bytes built this snapshot") and for snapshot-rebuild
  scenarios (re-personalize + re-run the create flow without going
  back to the operator's laptop).

- **Worker access during live requests:** none. The on-connect path
  only consumes the Hetzner snapshot; R2 is touched only by
  `create-sample-user` (upload) and `delete-sample-user` (cleanup).
  This avoids any R2 read-budget concern for the live demo system.

- **Worker R2 binding name:** `ISO_TEMP_BUCKET` (separate from the
  existing `ISO_BUCKET` binding for the base-ISO marketing serve, so
  blast-radius on one bucket can't reach the other).

Implementation-ready bullets:

- Phase C: append to `apps/com/wrangler.toml`:
  ```toml
  [[r2_buckets]]
  binding = "ISO_TEMP_BUCKET"
  bucket_name = "flagship-iso-temp"
  ```
- Phase C: in `apps/com/src/controlPlaneRoutes.ts` extend
  `ControlPlaneEnv` with `ISO_TEMP_BUCKET?: R2Bucket`.
- Phase E: CLI uses `npx wrangler r2 object put flagship-iso-temp/
  demo-isos/<u>-<sha8>.iso --file <path>` for upload; no R2 SDK in
  the CLI itself.
- Phase C: `delete-sample-user` calls `env.ISO_TEMP_BUCKET.delete(
  iso_r2_key)` before deleting the D1 row.

---

## 7. Hetzner client (Worker-side)

File: `apps/com/src/hetzner.ts`. Native `fetch()` — no library. Mirrors
the **subset** of `tools/vps-e2e/src/providers/hetzner.ts` that's
needed for snapshot-based provisioning. The Worker can never SSH, so
the rescue+dd path is excluded from this client by construction.

### 7.1 Exported surface

```ts
export interface HetznerClient {
  createServerFromSnapshot(args: {
    name: string;
    snapshotId: string;
    location: string;
    serverType: string;
    sshKeyId: number;
  }): Promise<{ serverId: string; ipv4: string | null }>;

  getServerStatus(serverId: string): Promise<{
    status: "initializing" | "starting" | "running" | "stopping"
            | "off" | "deleting" | "migrating" | "rebuilding" | "unknown";
    ipv4: string | null;
  }>;

  destroyServer(serverId: string): Promise<void>;
}

export function createHetznerClient(token: string): HetznerClient;
```

### 7.2 Mapping to Hetzner REST

| Method | Endpoint | Notes |
|---|---|---|
| `createServerFromSnapshot` | `POST /v1/servers` | Body: `{ name, image: <snapshotId>, location, server_type, ssh_keys: [<sshKeyId>], start_after_create: true, labels: { "flagship-demo": <username> } }` |
| `getServerStatus` | `GET /v1/servers/{id}` | Parses `server.status` and `server.public_net.ipv4.ip` |
| `destroyServer` | `DELETE /v1/servers/{id}` | 2xx → success; 404 → success (idempotent); other → throw |

Bearer auth: `Authorization: Bearer <HCLOUD_TOKEN>`.

### 7.3 What is NOT in this client

- **No** rescue-mode helpers (`enable_rescue`, `reset`, `wget|dd`) —
  those happen on the operator's laptop during `create-sample-user`,
  not in the Worker.
- **No** SSH key management — the Worker assumes the SSH key already
  exists (idempotently uploaded by Phase A's harness during the first
  `create-sample-user`). The Worker reads the SSH key id from the
  `DEMO_PUBLIC_SSH_KEY_ID` Worker var (§9; set after first create).
- **No** snapshot creation (`create_image`) — that's also operator-
  side.
- **No** ISO uploads — same reason.

### 7.4 Error model

- HTTP 4xx (other than 404 on DELETE) → throw `HetznerClientError`
  with the status code and the first 240 chars of the response body.
- HTTP 5xx → same.
- Network failures → the Worker's outbound `fetch` throws; let it
  propagate to the handler, which returns 502 to the client with
  `{ error: "hetzner upstream unavailable" }`.

### 7.5 Tests

`apps/com/src/hetzner.test.ts`: inject a fake `fetch` via constructor
parameter and assert:
- `createServerFromSnapshot` sends the correct body shape.
- `destroyServer` collapses 404 to success.
- `getServerStatus` correctly parses every status enum value.
- A 5xx propagates as a typed error.

No real Hetzner API calls in CI.

Implementation-ready bullets:

- Phase C: new file `apps/com/src/hetzner.ts` (~150 lines).
- Phase C: new file `apps/com/src/hetzner.test.ts` (~100 lines).
- Phase C: the `apps/com/src/index.ts` wiring threads
  `createHetznerClient(env.HCLOUD_TOKEN)` into the
  `ControlPlaneEnv` passed to the demo-users handlers.

---

## 8. D1 schema

New migration `packages/storage/migrations/0027_demo_users.sql`.
Numbering follows the existing sequence
(`0026_rename_app_to_service.sql` is the latest as of 2026-05-19).

```sql
-- Plan A — sample users (on-connect Hetzner provisioning).
--
-- A demo user is a TEST_ACCOUNTS entry PLUS one row in this table.
-- The row carries the durable artifacts of the create-sample-user
-- flow (the personalized ISO key in R2 + the Hetzner snapshot id)
-- plus the transient state of the currently-or-recently-provisioned
-- Hetzner server.
--
-- States (see docs/sample-users.md §4):
--   'none'                    — no Hetzner server is provisioned
--   'provisioning'            — POST /servers issued; awaiting running+registered
--   'up'                      — server fully booted; serving /api/screens/*
--   'idle-pending-teardown'   — cron identified the row; DELETE issued or pending
--
-- last_activity_at is wall-clock ms (Date.now()). The idle reaper
-- runs every 10 minutes (see apps/com/wrangler.toml crons).

CREATE TABLE IF NOT EXISTS demo_users (
  username           TEXT PRIMARY KEY,
  display            TEXT NOT NULL,
  snapshot_id        TEXT,                    -- Hetzner snapshot/image id; populated after create
  iso_r2_key         TEXT,                    -- R2 object key under flagship-iso-temp
  ttl_idle_minutes   INTEGER NOT NULL DEFAULT 30,
  region             TEXT NOT NULL DEFAULT 'fsn1',
  size               TEXT NOT NULL DEFAULT 'cx22',
  active_server_id   TEXT,                    -- Hetzner server id when state in (provisioning, up, idle-pending-teardown)
  active_server_fqdn TEXT,                    -- e.g. home.demoalice.flagship.services
  last_activity_at   INTEGER NOT NULL DEFAULT 0,
  state              TEXT NOT NULL DEFAULT 'none',
  created_at         INTEGER NOT NULL,
  CHECK (state IN ('none', 'provisioning', 'up', 'idle-pending-teardown'))
);

CREATE INDEX IF NOT EXISTS idx_demo_users_state         ON demo_users(state);
CREATE INDEX IF NOT EXISTS idx_demo_users_last_activity ON demo_users(last_activity_at);
```

### 8.1 Storage interface

`packages/storage/src/demoUsers.ts`:

```ts
export interface DemoUser {
  username: string;
  display: string;
  snapshotId: string | null;
  isoR2Key: string | null;
  ttlIdleMinutes: number;
  region: string;
  size: string;
  activeServerId: string | null;
  activeServerFqdn: string | null;
  lastActivityAt: number;
  state: "none" | "provisioning" | "up" | "idle-pending-teardown";
  createdAt: number;
}

export interface DemoUsersStorage {
  insert(row: DemoUser): Promise<void>;
  get(username: string): Promise<DemoUser | null>;
  list(): Promise<DemoUser[]>;
  update(username: string, patch: Partial<DemoUser>): Promise<void>;
  delete(username: string): Promise<void>;
  /** Atomically transition state if current state matches `from`.
   *  Returns the new row, or null if the row's state was not `from`. */
  transition(
    username: string,
    from: DemoUser["state"],
    to: DemoUser["state"],
    patch?: Partial<DemoUser>,
  ): Promise<DemoUser | null>;
  /** Idle-reaper query. Returns rows in state in (up, provisioning)
   *  whose last_activity_at < cutoffMs. */
  findIdle(cutoffMs: number): Promise<DemoUser[]>;
}
```

Both the in-memory adapter (for tests) and the D1 adapter implement
this interface, following the pattern in `packages/storage/src/d1.ts`.

### 8.2 D1 binding

The existing `[[d1_databases]]` binding `DB` (database name
`flagship-state`) is reused. No new database; this is one more table
in the same D1.

Apply with:
```sh
cd apps/com && npx wrangler d1 execute flagship-state \
  --file=../../packages/storage/migrations/0027_demo_users.sql --remote
```

Implementation-ready bullets:

- Phase C: write the migration verbatim from §8.
- Phase C: extend `packages/storage/src/` with `DemoUsersStorage`,
  the D1 implementation, and the in-memory implementation.
- Phase C: 3-4 unit tests around `transition()`'s atomicity and
  `findIdle()`'s WHERE clause.

---

## 9. Worker secrets

Two new Worker secrets, one new Worker var.

### 9.1 `HCLOUD_TOKEN` (Worker secret)

The Hetzner Cloud API token. Project scoping recommended (create a
dedicated `flagship-demos` Hetzner project; scope the token to that
project so the demo system cannot reach production Hetzner resources
if any exist).

Set via:
```sh
cd apps/com && npx wrangler secret put HCLOUD_TOKEN
```

### 9.2 `DEMO_PUBLIC_SSH_KEY` (Worker secret)

The **public-half** SSH key that Hetzner attaches to provisioned
demo servers. This is not strictly required for snapshot restore
(the snapshot already has whatever authorized_keys was baked at
create time), but keeping it consistent across re-restores allows the
operator to SSH in for diagnostic purposes without surprises.

Generated once on the operator's laptop:
```sh
ssh-keygen -t ed25519 -f ~/.ssh/flagship-demo-ssh -N "" -C "flagship-demo"
```
Then:
```sh
cd apps/com && npx wrangler secret put DEMO_PUBLIC_SSH_KEY < ~/.ssh/flagship-demo-ssh.pub
```

The private half stays on the operator's laptop (used by Phase A's
rescue+dd path during `create-sample-user`).

### 9.3 `DEMO_PUBLIC_SSH_KEY_ID` (Worker var, not secret)

The numeric Hetzner SSH key id, captured the first time the operator
runs `create-sample-user` (the CLI uploads the public key and surfaces
the id). Set as a `[vars]` entry in `apps/com/wrangler.toml`:

```toml
[vars]
DEMO_PUBLIC_SSH_KEY_ID = "<numeric-id>"
```

This is checked into the repo because the id is not sensitive — it's
the Hetzner-side numeric handle for a public key.

Implementation-ready bullets:

- Phase C: extend `ControlPlaneEnv` in
  `apps/com/src/controlPlaneRoutes.ts` with `HCLOUD_TOKEN?: string`,
  `DEMO_PUBLIC_SSH_KEY?: string`, `DEMO_PUBLIC_SSH_KEY_ID?: string`.
  Document each next to the existing `TEST_ACCOUNTS?: string` block
  (currently line 176).
- Phase E: CLI prints the `DEMO_PUBLIC_SSH_KEY_ID` after first
  upload and instructs the operator to add it to `wrangler.toml`.
- Operator runbook: `docs/runbooks/demo-users-bootstrap.md` (a small
  ops doc the Phase E CLI generates).

---

## 10. Endpoints

All under `/api/dev/sample-user`. Admin endpoints reuse the existing
`FLAGSHIP_ADMIN_SECRET` bearer pattern (same as
`POST /api/admin/republish-server-dns`).

### 10.1 Endpoint table

| Method | Path | Auth | Idempotency | Rate-limit |
|---|---|---|---|---|
| `POST` | `/api/dev/sample-user/create` | admin secret | idempotent on `username` (returns existing row if present) | none (admin) |
| `POST` | `/api/dev/sample-user/{u}/install-complete` | admin secret | idempotent on `(username, snapshot_id)` | none (admin) |
| `POST` | `/api/dev/sample-user/delete` | admin secret | idempotent | none (admin) |
| `POST` | `/api/dev/sample-user/{u}/connect` | none | not idempotent on Hetzner side, idempotent on state | 10/min/IP, 30/min/u |
| `POST` | `/api/dev/sample-user/{u}/heartbeat` | none | trivially idempotent | 30/min/IP |
| `GET` | `/api/dev/sample-user/{u}` | admin secret | n/a | none (admin) |
| `GET` | `/api/dev/sample-user` | admin secret | n/a | none (admin) |

### 10.2 `POST /api/dev/sample-user/create`

**Request:**
```json
{
  "username": "demoalice",
  "display": "Demo Alice",
  "region": "fsn1",
  "size": "cx22",
  "ttlIdleMinutes": 30
}
```

`region`, `size`, `ttlIdleMinutes` are optional; defaults are
`fsn1` / `cx22` / `30`.

**Effect (Worker-side):**
1. Validate `username` per §2.4.
2. Read `usernames` table; reject 409 if real-account claim exists.
3. `INSERT INTO demo_users (...)`; `state='none'`, `snapshot_id=NULL`,
   `created_at=now`. Idempotent: a duplicate-key error returns the
   existing row with HTTP 200 (the CLI's `--force` flag is the only
   path to re-do the row).
4. Atomically append `username` to the `TEST_ACCOUNTS` JSON
   structure. Implementation note: the Worker can't write its own
   secrets at runtime; instead the CLI is responsible for the
   `wrangler secret put TEST_ACCOUNTS` update separately. The Worker
   endpoint just writes `demo_users`.

**Response 200:**
```json
{
  "username": "demoalice",
  "display": "Demo Alice",
  "state": "none",
  "createdAt": 1736000000000
}
```

**Response 409:**
```json
{ "error": "username already claimed by a real account" }
```

### 10.3 `POST /api/dev/sample-user/{u}/install-complete`

Called by the operator's CLI after step 5-6 of §5.1.

**Request:**
```json
{
  "snapshot_id": "12345678",
  "iso_r2_key": "demo-isos/demoalice-a1b2c3d4.iso"
}
```

**Effect:**
- `UPDATE demo_users SET snapshot_id=?, iso_r2_key=? WHERE
  username=?` — state remains `none`.

**Response 200:**
```json
{ "username": "demoalice", "snapshotId": "12345678", "ready": true }
```

### 10.4 `POST /api/dev/sample-user/delete`

**Request:**
```json
{ "username": "demoalice" }
```

**Effect:**
1. Read `demo_users` row.
2. If `state in ('provisioning', 'up', 'idle-pending-teardown')` and
   `active_server_id` is set, call `hetzner.destroyServer(id)`.
3. If `snapshot_id` is set, call Hetzner `DELETE /v1/images/{id}`.
4. If `iso_r2_key` is set, call `env.ISO_TEMP_BUCKET.delete(key)`.
5. `DELETE FROM demo_users WHERE username=?`.
6. Audit-log `demo-user-deleted`.

**Response 200:**
```json
{ "username": "demoalice", "deleted": true }
```

Idempotent: a `delete` on an absent row returns 200 with `deleted:
false`.

### 10.5 `POST /api/dev/sample-user/{u}/connect`

**Request:** `{}` (empty body OK).

**Effect (state-machine driven):**

| Current state | Effect | Response |
|---|---|---|
| Row absent | reject | 404 `{ error: "no such demo user" }` |
| `none` (no `snapshot_id`) | reject | 409 `{ error: "demo user not yet provisioned; call create+install" }` |
| `none` (with `snapshot_id`) | `hetzner.createServerFromSnapshot(...)`; transition to `provisioning`; `last_activity_at=now` | 200 `{ fqdn: "home.<u>.flagship.services", status: "provisioning" }` |
| `provisioning` | no-op | 200 `{ fqdn, status: "provisioning" }` |
| `up` | `last_activity_at=now` | 200 `{ fqdn, status: "up" }` |
| `idle-pending-teardown` | no-op | 200 `{ fqdn, status: "provisioning" }` — wait for the cron to finish teardown; client retries |

**Global concurrency cap.** Before transitioning `none →
provisioning`, count `SELECT COUNT(*) FROM demo_users WHERE state IN
('provisioning', 'up', 'idle-pending-teardown')`. If ≥
`MAX_CONCURRENT_DEMO_VPS` (= 5), return 429 with `Retry-After: 60`
and audit-log `demo-connect-rate-limited`.

### 10.6 `POST /api/dev/sample-user/{u}/heartbeat`

**Request:** `{}`.

**Effect:** `UPDATE demo_users SET last_activity_at=now WHERE
username=? AND state='up'`. If the row is not in state `up`, return
409.

**Response 200:** `{ "ok": true }`.

### 10.7 `GET /api/dev/sample-user/{u}`

Returns the full row plus a live Hetzner state poll (calls
`getServerStatus` if `active_server_id` is set).

**Response 200:**
```json
{
  "username": "demoalice",
  "display": "Demo Alice",
  "state": "up",
  "snapshotId": "12345678",
  "isoR2Key": "demo-isos/demoalice-a1b2c3d4.iso",
  "activeServerId": "98765432",
  "activeServerFqdn": "home.demoalice.flagship.services",
  "lastActivityAt": 1736000123456,
  "ttlIdleMinutes": 30,
  "region": "fsn1",
  "size": "cx22",
  "createdAt": 1736000000000,
  "hetznerLive": { "status": "running", "ipv4": "5.x.y.z" }
}
```

### 10.8 `GET /api/dev/sample-user`

Returns an array of all rows (no Hetzner live poll — bulk).

### 10.9 `/api/users/check` extension

Today's behaviour (per `usersCheck.ts:101-112`): if the username
matches a `TEST_ACCOUNTS` key, return `testAccount: { display,
ttlHours }` + `available: false, reason: "test account"`.

Extended behaviour: ALSO read `demo_users` (when `DemoUsersStorage`
is wired in `UsersCheckDeps`). If a row exists, the response also
includes:

```json
{
  "demoServer": {
    "fqdn": "home.demoalice.flagship.services",
    "status": "none" | "provisioning" | "up",
    "ttlIdleMinutes": 30
  }
}
```

Mapping `state → status` in the response:
- `none` → `"none"`
- `provisioning` → `"provisioning"`
- `up` → `"up"`
- `idle-pending-teardown` → `"provisioning"` (clients treat it as
  "wait, the system is busy")

The `testAccount` block is kept for backward compatibility — already-
shipped iOS/Android binaries branch on it; new binaries branch on
`demoServer` when present and fall back to `testAccount` when only
the legacy block is set.

### 10.10 Route additions

Append to `ROUTE_RE` in `apps/com/src/controlPlaneRoutes.ts`:

```ts
DEMO_USER_CREATE:          /^\/api\/dev\/sample-user\/create$/,
DEMO_USER_DELETE:          /^\/api\/dev\/sample-user\/delete$/,
DEMO_USER_INSTALL_COMPLETE:/^\/api\/dev\/sample-user\/([^/]+)\/install-complete$/,
DEMO_USER_CONNECT:         /^\/api\/dev\/sample-user\/([^/]+)\/connect$/,
DEMO_USER_HEARTBEAT:       /^\/api\/dev\/sample-user\/([^/]+)\/heartbeat$/,
DEMO_USER_GET:             /^\/api\/dev\/sample-user\/([^/]+)$/,
DEMO_USER_LIST:            /^\/api\/dev\/sample-user$/,
```

Implementation-ready bullets:

- Phase C: each endpoint gets one handler in
  `packages/control-plane/src/demoUsers.ts` following the existing
  pattern (deps-injected, returns `HandlerResponse`).
- Phase C: routes wired in `apps/com/src/controlPlaneRoutes.ts`,
  threaded through `tryControlPlane`.
- Phase C: `handleUsersCheck` in
  `packages/control-plane/src/usersCheck.ts` accepts a new optional
  `demoUsers?: DemoUsersStorage` dep and folds in the `demoServer`
  block.

---

## 11. Idle teardown cron

### 11.1 Schedule

Extend `apps/com/wrangler.toml`:

```toml
[triggers]
crons = ["*/10 * * * *", "0 */6 * * *"]
```

The existing `0 */6 * * *` cron (D1 → R2 backup) stays. The new
`*/10 * * * *` runs every 10 minutes.

### 11.2 Handler

In `apps/com/src/index.ts` extend the `scheduled` handler:

```ts
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (event.cron === "*/10 * * * *") {
      await runDemoIdleReaper(env);
      await runDemoProvisioningPoller(env);
      return;
    }
    if (event.cron === "0 */6 * * *") {
      await runD1Backup(env);
      return;
    }
  },
};
```

### 11.3 `runDemoIdleReaper`

```ts
async function runDemoIdleReaper(env: Env) {
  const storage = new D1DemoUsersStorage(env.DB);
  const hetzner = createHetznerClient(env.HCLOUD_TOKEN);
  const now = Date.now();
  const candidates = await storage.findIdle(now);
  for (const row of candidates) {
    const cutoff = now - row.ttlIdleMinutes * 60_000;
    if (row.lastActivityAt >= cutoff) continue;
    const claimed = await storage.transition(
      row.username,
      row.state,
      "idle-pending-teardown",
    );
    if (!claimed || !claimed.activeServerId) continue;
    try {
      await hetzner.destroyServer(claimed.activeServerId);
      await storage.transition(
        row.username,
        "idle-pending-teardown",
        "none",
        { activeServerId: null, activeServerFqdn: null },
      );
      await auditLog(env, "demo-vps-idle-reaped", { username: row.username });
    } catch (e) {
      // Leave in idle-pending-teardown; next cron pass retries.
      console.error(`demo-vps-idle-reap-failed`, row.username, e);
    }
  }
}
```

The query inside `findIdle`:

```sql
SELECT * FROM demo_users
WHERE state IN ('up', 'provisioning', 'idle-pending-teardown')
  AND last_activity_at < ?1
ORDER BY last_activity_at ASC
LIMIT 50
```

The `?1` parameter is the largest possible cutoff (`now`); the
per-row check `lastActivityAt < now - ttl*60_000` is applied in JS
so per-row `ttl_idle_minutes` is honoured. The 50-row cap keeps a
single cron tick bounded; with the 5-VPS concurrency cap the
practical worst case is 5.

### 11.4 `runDemoProvisioningPoller`

Lifts `provisioning → up` rows whose Hetzner status has flipped to
`running` AND whose daemon has registered:

```ts
async function runDemoProvisioningPoller(env: Env) {
  const storage = new D1DemoUsersStorage(env.DB);
  const hetzner = createHetznerClient(env.HCLOUD_TOKEN);
  const rows = await storage.list();
  for (const row of rows) {
    if (row.state !== "provisioning") continue;
    if (!row.activeServerId) continue;
    const live = await hetzner.getServerStatus(row.activeServerId);
    if (live.status !== "running") continue;
    const fqdn = `home.${row.username}.flagship.services`;
    const registered = await env.DB
      .prepare("SELECT 1 FROM install_events WHERE fqdn=? AND event='registered' AND created_at > ? LIMIT 1")
      .bind(fqdn, row.createdAt)
      .first();
    if (!registered) continue;
    await storage.transition(
      row.username,
      "provisioning",
      "up",
      { activeServerFqdn: fqdn, lastActivityAt: Date.now() },
    );
    await auditLog(env, "demo-vps-provisioned", { username: row.username });
  }
}
```

### 11.5 Retry semantics

- DELETE 404 = success → state goes to `none` immediately.
- DELETE 5xx or network failure → stays `idle-pending-teardown`; the
  next 10-minute cron retries. No exponential back-off (the cron
  cadence is the back-off).
- A row that's been in `idle-pending-teardown` for > 1 hour is logged
  as a warning (`demo-vps-stuck`) so the operator can intervene
  manually if Hetzner has a sustained outage.

Implementation-ready bullets:

- Phase C: extend `apps/com/wrangler.toml` `crons` array (one-line
  diff).
- Phase C: extend `apps/com/src/index.ts` `scheduled` handler
  (branch on `event.cron`).
- Phase C: 4 unit tests around the reaper (no real Hetzner): one
  row idle past cutoff, one row idle but inside cutoff, one row not
  in `up`, one row that fails DELETE and stays pending.

---

## 12. Rate-limit + abuse model

### 12.1 Per-endpoint limits

| Endpoint | Per-IP | Per-username |
|---|---|---|
| `POST /connect` | 10 / min | 30 / min |
| `POST /heartbeat` | 30 / min | (n/a; heartbeat needs paired session) |

Reuses the existing `RATE_LIMITER` binding (`apps/com/wrangler.toml`
line 88-92), composing keys as
`demo-connect|ip|<ip>` and `demo-connect|u|<username>` (the existing
4-axis pattern in `apps/com/src/rateLimit.ts`).

Rationale:
- 30/min/username because the legitimate client polls during
  `provisioning` every ~3s for up to a minute, plus normal
  interaction — a generous bound.
- 10/min/IP because a single IP shouldn't span many demo usernames
  concurrently. That's the abuse signature.

### 12.2 Global concurrency cap

`MAX_CONCURRENT_DEMO_VPS = 5`. Before transitioning `none →
provisioning`, count
```sql
SELECT COUNT(*) FROM demo_users
WHERE state IN ('provisioning', 'up', 'idle-pending-teardown')
```
If ≥ 5, return HTTP 429 with `Retry-After: 60` and audit-log
`demo-connect-attempt-rate-limited`. The cap is a code constant in
`apps/com/src/demoUsersHandler.ts`; raising it is a one-line PR.

### 12.3 Storage budget

ISO objects in R2 are static across users (one per demo user, not
one per session); snapshot data sits on Hetzner side. No Worker
storage budget is consumed by the demo system at request time. The
`demo_users` D1 table holds at most a few dozen rows in any
realistic deployment.

### 12.4 Cost ceiling

A worst-case scenario where all 5 demo VPSs are spun up
simultaneously and held for 30 minutes:

- 5 × CX22 = 5 × €0.006/h × 0.5h ≈ **€0.015 per provisioning round**.
- Plus snapshot storage at €0.0119/GB/month for ~4 GB per snapshot ≈
  **€0.05/month per demo user**.

This is the rationale for the soft cap: prevent runaway from
incurring real cost while leaving headroom for legitimate reviewer
demos.

Implementation-ready bullets:

- Phase C: extend `apps/com/src/rateLimit.ts` with
  `demo-connect|ip|<ip>` and `demo-connect|u|<username>` axes.
- Phase C: `MAX_CONCURRENT_DEMO_VPS = 5` constant in
  `apps/com/src/demoUsersHandler.ts`.
- Phase C: 3 unit tests: per-IP burst, per-username burst, global
  cap.

---

## 13. Audit log entries

The Worker already has an `audit_events` table
(migration `0018_audit_events.sql`). Demo system extends it with the
following event types. All entries carry `{ username, timestamp,
ip?, requestId? }` as the common columns; per-type extras are
documented inline.

| Event type | Emitted from | Extras |
|---|---|---|
| `demo-user-created` | `POST /create` (admin) | `display`, `region`, `size` |
| `demo-user-deleted` | `POST /delete` (admin) | (none) |
| `demo-vps-provisioned` | provisioning poller (`provisioning → up`) | `serverId`, `fqdn` |
| `demo-vps-destroyed` | reaper (`idle-pending-teardown → none`) or delete handler | `serverId`, `reason: "idle"\|"delete"` |
| `demo-vps-idle-reaped` | reaper (logical alias of `destroyed` for the idle path) | `idleMinutes` |
| `demo-connect-attempt-rate-limited` | `/connect` global-cap or per-axis rate-limit hit | `axis: "ip"\|"username"\|"global"` |
| `demo-vps-stuck` | reaper observes row > 1h in `idle-pending-teardown` | `serverId`, `stuckMinutes` |

Existing audit-log infra (handler at
`packages/control-plane/src/auditLog.ts`, get-endpoint at
`/api/users/{u}/audit`) is reused. Demo audit events MUST NOT be
returned from `/api/users/{u}/audit` for non-demo users — the demo
events are filtered to admin-only via `/api/dev/sample-user/{u}/audit`
(new endpoint, admin-auth) OR by joining with `demo_users` membership
in the existing handler.

Implementation-ready bullets:

- Phase C: add the 7 event-type literals to a new
  `packages/control-plane/src/demoUsersAudit.ts` enum.
- Phase C: each handler in `demoUsers.ts` calls
  `auditLog(env, type, payload)` with the appropriate payload.

---

## 14. CLI shape (recap)

File: `scripts/sample-user.mjs`. Pure Node ESM; no framework. Wraps
the admin endpoints + drives the operator-side ISO build and
snapshot flow.

```sh
# Create a new demo user. The CLI now drives a REAL `.com`-issued
# install ticket end-to-end (see §14.4 below):
#   1. POST /api/dev/sample-user/create (reserve D1 row)
#   2. POST /api/dev/sample-user/admin-claim-and-issue (mint
#      AuthCode + signed InstallBlob + primary DeviceCapabilityGrant)
#   3. personalize-iso --blob-json (NOT --seed-hex)
#   4. R2 upload + Hetzner rescue+dd + ACME + snapshot
#   5. POST /api/dev/sample-user/<u>/install-complete
node scripts/sample-user.mjs create <username> \
    --display "<display string>" \
    [--region fsn1] \
    [--size cx22] \
    [--ttl-idle 30]

# Tear down everything: server (if up), snapshot, R2 ISO, D1 row, AND
# every DeviceCapabilityGrant for that user.
node scripts/sample-user.mjs delete <username>

# List all demo users.
node scripts/sample-user.mjs list

# Show one demo user, including a live Hetzner status poll.
node scripts/sample-user.mjs status <username>

# Mint a DeviceCapabilityGrant for a NEW device under an existing
# demo user. Pure-Worker call (no Hetzner side-effect; needs only
# FLAGSHIP_ADMIN_SECRET). The Worker validates the scopes — a typo
# surfaces as a 400 with the offending string in the body.
node scripts/sample-user.mjs grant-device <username> <device-label> \
    --scopes <comma-list>

# Examples:
node scripts/sample-user.mjs grant-device demoalice reviewer --scopes browse
node scripts/sample-user.mjs grant-device demoalice work-laptop \
    --scopes browse,install-service,vibe-code

# (Optional internal helper — used during create-sample-user; not for
# direct operator use.) Upload a pre-built ISO to R2.
node scripts/sample-user.mjs upload-iso <username> <iso-path>
```

### 14.1 Env vars the CLI reads

As of W11 (2026-05-21), **the laptop no longer needs `HCLOUD_TOKEN`
or a Hetzner SSH key**. The Worker handles every Hetzner operation
end-to-end via cloud-init `user_data` (a `#!/bin/bash` script Hetzner
runs as root at first boot — no SSH involved). The only remaining
laptop secret is the admin bearer; replacing that with a
YubiKey-signed envelope is tracked separately as the v3 admin-auth
refactor.

- `FLAGSHIP_ADMIN_SECRET` — required for ALL subcommands (admin
  bearer the Worker checks via `x-admin-secret`).
- `FLAGSHIP_BASE_URL` — defaults to `https://flagshipserver.com`;
  overridable for local-dev (`http://localhost:8787`).

Worker-side secrets (set once via `wrangler secret put`, NOT in any
operator shell):

- `HCLOUD_TOKEN` — Hetzner API token. Now lives ONLY on the Worker.
- `DEMO_PUBLIC_SSH_KEY` — OPTIONAL after W11. Useful only if the
  operator wants to ssh into a temp VPS to debug a stuck cloud-init.
  The W11 happy path does not depend on SSH.
- `DEMO_IRK_KEK` — 32-byte hex KEK; unchanged.
- `FLAGSHIP_R2_TEMP_PUBLIC_BASE` (var) — public dev-url host for the
  `flagship-iso-temp` bucket.

### 14.2 Exit codes

- `0` — success.
- `1` — generic failure (network, malformed args).
- `2` — admin auth failure.
- `3` — Hetzner API failure.
- `4` — D1 conflict (e.g. real-account username clash).

### 14.3 Output

Each step prints a single line to stderr (`[create] uploading
ISO…`). Final result line is on stdout as JSON for piping into other
tools:
```
{"username":"demoalice","ready":true,"snapshotId":"12345678"}
```

`grant-device` writes a single JSON line to stdout containing the
full `{grant, signature, devicePubHex}` envelope returned by the
Worker, and a one-line summary ("`Granted reviewer device with
scopes: browse`") to stderr for human eyeballing.

### 14.4 Real-ticket install flow (v2; supersedes synthesizeBlob)

The `create` subcommand uses a real `.com`-issued install blob so
the trailer's `AuthCode.serial` lines up with the `auth_codes` row
on the Worker. First-boot `/api/server/register` then succeeds and
the install actually completes.

This replaces the previous offline `personalize-iso --seed-hex`
path (the `synthesizeBlob` mode of the iso-personalizer CLI), which
produced a self-signed install blob whose serial `.com` had no
record of — the 2026-05-20 Phase F regression. The
`synthesizeBlob` mode of `personalize-iso` is now DEPRECATED for
demo flows; it remains in the CLI only for unit/integration tests
that need an ISO without a Worker round-trip. See
`docs/v2-device-addressing-and-real-ticket.md` §4 for the full
spec.

Call sequence executed by `node scripts/sample-user.mjs create
<u>`:

1. `POST /api/dev/sample-user/create` — reserve / re-attach the
   demo_users row (idempotent on `reused: true`).
2. `POST /api/dev/sample-user/admin-claim-and-issue` — Worker
   derives the deterministic user IRK from `DEMO_IRK_KEK` + the
   username, claims the username, mints a signed `AuthCode` +
   `InstallBlob`, persists a build-ticket, and writes the primary
   `DeviceCapabilityGrant` (full demo-primary scopes per §2.2 of
   the v2 spec). Returns `{code, blob, blobSignature,
   primaryGrant}`.
3. The CLI writes `{blob, blobSignature}` to a temp `blob.json`
   and invokes `personalize-iso --base-iso <cached> --output
   <out.iso> --blob-json <blob.json>` (NOT `--seed-hex`,
   `--username`, or `--server-name` — those are the deprecated
   path).
4. R2 upload + Hetzner provision + rescue+dd + `awaitDaemonReady`
   on `/api/users/<u>/pods` (unchanged from Phase A).
5. `POST /api/dev/sample-user/<u>/install-complete` —
   persist `snapshot_id` + `iso_r2_key` on the demo_users row.

`grant-device <u> <label> --scopes <comma-list>` is a one-step
wrapper around `POST /api/dev/sample-user/<u>/admin-mint-device-
grant`. Use it to add reviewer / corporate / work-laptop sub-
identities to an existing demo user. The grant is a real
`DeviceCapabilityGrant` envelope (same shape Plan A consumes for
two-level addressing), signed by the demo user's IRK
Worker-side.

Implementation-ready bullets:

- Phase E: new file `scripts/sample-user.mjs`.
- Phase E: new file `scripts/sample-user.test.ts` — tests parse the
  arg surface and stub the network calls; no real Hetzner.
- Phase E: extends `tools/vps-e2e/src/providers/hetzner.ts` with
  `HetznerProvider.snapshot(serverId, description)` and
  `HetznerProvider.destroyImage(imageId)` (used by the CLI's
  `delete` path).
- S3.4: `scripts/sample-user.mjs` refactored to call
  `admin-claim-and-issue` and `personalize-iso --blob-json` (per
  this section); new `grant-device` subcommand added.

---

## 15. End-to-end test plan

Acceptance for Phase F. Reuse the Phase F outline from
`docs/sample-user-vps-plan.md`, expanded with concrete assertion
points.

### Step 1 — Operator env

```sh
export HCLOUD_TOKEN=<token>
export FLAGSHIP_ADMIN_SECRET=<existing-secret>
ssh-keygen -t ed25519 -f ~/.ssh/flagship-demo-ssh -N "" -C "flagship-demo"
```

Assertion: `~/.ssh/flagship-demo-ssh` and `.pub` both exist.

### Step 2 — Create demo user

```sh
node scripts/sample-user.mjs create demoalice --display "Demo Alice"
```

Assertions (stderr-observed, in order):
- `[create] inserted row in demo_users (state=none)` within 2 s.
- `[create] building personalized ISO…` within 5 s.
- `[create] ISO sha8 = <8-hex>; uploading to r2://flagship-iso-temp/
  demo-isos/demoalice-<sha8>.iso` within 60 s.
- `[create] provisioning temp Hetzner CX22 in fsn1…` within 5 s.
- `[create] rescue mode + dd…` within 90 s.
- `[create] awaiting daemon registration + ACME…` within 600 s.
- `[create] snapshotting…` within 30 s.
- `[create] snapshot status=available (id=<n>)` within 180 s.
- `[create] destroying temp server` within 10 s.
- `[create] persisting snapshot_id` within 2 s.
- stdout JSON: `{"username":"demoalice","ready":true,"snapshotId":
  "<n>"}`.

D1 assertion: `SELECT state, snapshot_id, iso_r2_key FROM demo_users
WHERE username='demoalice'` returns `('none', '<n>', 'demo-isos/
demoalice-<sha8>.iso')`.

Hetzner assertion: `GET /v1/images?type=snapshot` lists the snapshot
with `description='flagship-demo-demoalice'`.

Wall-clock budget: ≤ 25 min.

### Step 3 — `/api/users/check`

```sh
curl https://flagshipserver.com/api/users/check \
  -d '{"username":"demoalice"}' -H 'content-type: application/json'
```

Assertions:
- `available: false`.
- `testAccount: { display: "Demo Alice", ttlHours: <existing> }`.
- `demoServer: { fqdn: "home.demoalice.flagship.services", status:
  "none", ttlIdleMinutes: 30 }`.

### Step 4 — Type the username on iOS

(Run on simulator or device.) Type `demoalice` in the username
field. iOS submits `/api/users/check`, observes `demoServer.status:
"none"`, renders the single device card for `home.demoalice.
flagship.services` with a "Connect" CTA.

### Step 5 — Tap connect

iOS POSTs `/api/dev/sample-user/demoalice/connect`.

Worker assertions:
- D1: `state` flips to `provisioning`, `active_server_id` populated.
- Hetzner: `GET /v1/servers?name=demo-demoalice-<short>` shows one
  server with `image: <snapshot_id>`.

iOS assertions:
- Response body: `{ fqdn, status: "provisioning" }`.
- Client polls `/api/users/check` every 3 s.

Within ≤ 60 s, the 10-min poller flips state to `up` (faster than the
cron in practice because `/connect` triggers an immediate poll). iOS
observes `demoServer.status: "up"` on the next `/api/users/check`.

### Step 6 — Real `/api/screens/*` round-trip

iOS opens the home pod. Network log shows requests to
`https://home.demoalice.flagship.services/api/screens/home` etc.,
NOT to the Worker's mock-fixtures path.

Assertions:
- Green padlock (Let's Encrypt cert, issuer="Let's Encrypt
  Authority X3" or successor).
- Real daemon response (parseable Screen JSON).

### Step 7 — Idle for 30 min

Stop interacting. Wait 35 minutes.

Assertions (every 10 min):
- Cron pass 1 (t+10m): row still `up` (last_activity_at within
  cutoff).
- Cron pass 2 (t+20m): row still `up`.
- Cron pass 3 (t+30m): row transitions `up → idle-pending-teardown →
  none`. Hetzner DELETE returns 2xx.
- `active_server_id` cleared.

### Step 8 — Status check

```sh
node scripts/sample-user.mjs status demoalice
```

Assertion: `state: "none"`, `hetznerLive` block absent (no server
to query).

### Step 9 — Re-connect

iOS taps connect again. Same flow as Step 5, but the snapshot
already exists so:
- Provisioning takes ~30 s (snapshot restore) instead of 10 min.
- Total time from tap to `up` ≤ 60 s.

### Step 10 — Delete

```sh
node scripts/sample-user.mjs delete demoalice
```

Assertions:
- If a server was up, Hetzner DELETE returns 2xx.
- Hetzner image `delete` returns 2xx.
- R2 object `demo-isos/demoalice-<sha8>.iso` deleted.
- D1 row deleted.
- `/api/users/check demoalice` no longer carries `demoServer`.

Wall-clock budget for Step 10: ≤ 60 s.

### Phase F overall acceptance

- All 10 steps pass.
- First-create end-to-end ≤ 25 min.
- Re-connect from snapshot ≤ 60 s.
- No human intervention required between steps.

Implementation-ready bullets:

- Phase F: `tools/vps-e2e/PHASE-F-RUN-LOG.md` captures the live
  output. The orchestrator (human) verifies and commits the log
  alongside any small fixes that surface.

---

## 16. Out-of-scope (and where it lives)

| Concern | Where it's handled |
|---|---|
| Real-account 2FA / multi-device hardening | `docs/v1.2-security-cascade.md` (Plan B) |
| iOS App Store reviewer flow | The existing `TEST_ACCOUNTS` + `DemoFixtures` path stays available for reviewers who don't care about the live pod — this spec extends it, not replaces it. New reviewers who want a live demo use the `demoServer` path. |
| Maintainers + CA ceremony | Unrelated. Demo VPSs run the same per-pod ACME chain real servers run; they consume the same CA chain off the same maintainer pin (`5016749377de07fd3296e8207539bbe52b40fb58f971d946f4cc8990c7e801ae`). |
| Reproducible-build CI | `.github/workflows/build-iso.yml` is unchanged. Demo ISOs are personalized from the same reproducible base. |
| Peer-backup distribution | Demos do not enrol in peer-backup. The snapshot is the backup. |
| WebAuthn-PRF recovery | Demos use the existing `is_demo` flag's `useMockRecovery` directive path (migration `0021_is_demo.sql`), so a recovery UI test on a demo account routes through the Mock provider. Unchanged by this spec. |
| Webapp PWA UI surfaces | Phase D ships demo-mode parity on the webapp; same `/api/users/check` extension drives both. |
| Marketplace + scanner | Demos can install marketplace apps because they're real daemons with real cert + tunnel. The scanner grade is per-app, not per-pod; unaffected. |

---

## Appendix A — File-by-file change inventory for Phase C

| File | Action | Approx. LOC |
|---|---|---|
| `packages/storage/migrations/0027_demo_users.sql` | new | 25 |
| `packages/storage/src/demoUsers.ts` | new | 120 |
| `packages/storage/src/demoUsers.test.ts` | new | 80 |
| `packages/storage/src/index.ts` | export `DemoUsersStorage` etc. | +5 |
| `apps/com/src/hetzner.ts` | new | 150 |
| `apps/com/src/hetzner.test.ts` | new | 100 |
| `apps/com/src/demoUsersHandler.ts` | new | 250 |
| `apps/com/src/demoUsersHandler.test.ts` | new | 200 |
| `packages/control-plane/src/demoUsers.ts` | new | 200 (pure handlers) |
| `packages/control-plane/src/demoUsers.test.ts` | new | 150 |
| `packages/control-plane/src/usersCheck.ts` | extend with `demoServer` block | +20 |
| `packages/control-plane/src/usersCheck.test.ts` | new test cases | +60 |
| `apps/com/src/controlPlaneRoutes.ts` | new `ROUTE_RE.DEMO_*` entries + tryControlPlane wiring + env extension | +80 |
| `apps/com/src/index.ts` | extend `scheduled` handler with cron branch | +20 |
| `apps/com/wrangler.toml` | new R2 binding + cron entry + `DEMO_PUBLIC_SSH_KEY_ID` var | +6 |
| `apps/com/src/rateLimit.ts` | new axes for `demo-connect` | +15 |

Total Phase C diff: ~1500 LOC including tests.

## Appendix B — File-by-file change inventory for Phase D

| File | Action |
|---|---|
| `apps/mobile/ios/Sources/FlagshipCore/DemoFixtures.swift` | extend `activate(_:username:)` to check the `demoServer` block; if present, materialise ONE pod with that fqdn + status and call `/connect` |
| `apps/mobile/ios/Sources/FlagshipAPI/UsersCheckResponse.swift` | add optional `demoServer` field |
| `apps/mobile/android/.../DemoFixtures.kt` | parallel changes |
| `apps/mobile/android/.../MockScreensClient.kt` | branch on `demoServer` presence |
| `apps/web/public/webapp/src/.../demo.ts` | parallel changes |
| Per-platform conformance test | one test asserting demo destructive-ops don't hit real RPCs |

## Appendix C — Phase E inventory

| File | Action |
|---|---|
| `scripts/sample-user.mjs` | new |
| `scripts/sample-user.test.ts` | new |
| `tools/vps-e2e/src/providers/hetzner.ts` | add `snapshot()` + `destroyImage()` |
| `tools/vps-e2e/src/providers/hetzner.test.ts` | new fixtures |
| `docs/runbooks/demo-users-bootstrap.md` | new (one-time setup: SSH key, secrets, Hetzner project) |

---

End of spec.
