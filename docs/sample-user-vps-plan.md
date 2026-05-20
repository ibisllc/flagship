# Sample-user / Hetzner-VPS / on-connect provisioning — execution plan

**Goal.** Operator runs `create-sample-user demo-alice`. Anyone who types
that username on iOS / Android / webapp short-circuits into "demo mode"
and sees **one device** owned by demo-alice. Tapping that device's
"connect" causes `.com` to provision a real Hetzner VPS bound to
demo-alice in the background (re-using a pre-personalized ISO uploaded
at create time), waits for the install + ACME chain, then the client
connects normally. Idle for N minutes ⇒ VPS auto-destroyed; next
connection re-provisions. `delete-sample-user demo-alice` tears down
everything.

This is a **demo-environment** feature — it overlays a deterministic,
non-secret recovery path on top of the existing
`TEST_ACCOUNTS`+`DemoFixtures` infrastructure that already short-
circuits the real claim / WebAuthn / Secure-Enclave flow on every
mobile surface.

---

## Phase 0 — recon (DONE; this section is the record)

Already learned:

- **`TEST_ACCOUNTS` is the existing demo plumbing.** Worker secret
  (`apps/com/src/controlPlaneRoutes.ts:174`), JSON map of
  `{ <username>: { display, ttlHours } }`. `POST /api/users/check`
  returns a `testAccount` block when matched. iOS
  `apps/mobile/ios/Sources/FlagshipCore/DemoFixtures.swift` activates
  demo state with that signal. Android has a parallel mock-client.
- **Today's demo mode is pure fixtures.** Three fake pods
  (Home/Office/Music) materialised in-app; demo mode **never** calls
  `flagshipserver.com`, **never** talks to a real pod, **never** does
  APNs, **never** touches the Secure Enclave. (Documented in
  `DemoFixtures.swift` line 19-22.)
- **ISO personalization is local-only today.** `packages/iso-
  personalizer/` does `personalize.ts` + `trailer.ts`. The phone mints
  a build-ticket; `.com` streams a base ISO from R2; the browser
  personalizes on the way to the user's disk. There's no concept of
  a pre-built per-demo-user ISO sitting somewhere queued for VPS boot.
- **Hetzner provider has a fundamental ISO-attach gap.**
  `tools/vps-e2e/src/providers/hetzner.ts` calls `attach_iso` against
  an arbitrary name, but **Hetzner Cloud has no public custom-ISO
  upload API**. ISOs come from Hetzner's catalogue or your own
  snapshots. The realistic boot path is **rescue-mode netboot + `dd`**:
  call `POST /servers/{id}/actions/enable_rescue` → reset → SSH into
  the rescue system → `wget <our.iso> | dd of=/dev/sda` → reboot. The
  harness has none of this wiring.
- **`.com` admin auth pattern already exists.** `FLAGSHIP_ADMIN_SECRET`
  Worker secret + bearer-header check. Reuse for the demo CLI.

Open questions resolved (with explicit defaults, marked **DECIDED**
unless tagged **ASK**):

- **Demo username pattern:** no prefix required. Username is whatever
  the operator names it (`demo-alice`, `alice`, `reviewer`). The
  `TEST_ACCOUNTS` map is what makes it demo. **DECIDED**.
- **Provisioning timing:** **on first connect**, not on create. User's
  exact words: "rapidly provision that one-server-per-dummy-user
  whenever a its dummy-user connects". The ISO is built and stored at
  create-time; the VPS spins up on demand. **DECIDED**.
- **ISO storage:** **Cloudflare R2** (private bucket, signed-URL
  fetch from the rescue VPS over plain HTTPS). Hetzner snapshots
  would also work but R2 is one-keystroke from existing infra
  (`ISO_BUCKET` binding already in `wrangler.toml`). **DECIDED**.
- **Idle teardown:** **30 minutes** of `last_activity_at` silence ⇒
  destroy. Configurable per demo-user via `ttlIdleMinutes`. **DECIDED**.
- **Max concurrent demo VPSs:** **5** (a soft cap in the Worker; tuned
  later). Prevents a runaway from incurring real cost. **DECIDED**.
- **Auth on `/api/dev/sample-user/*`:** `FLAGSHIP_ADMIN_SECRET` bearer
  (existing pattern). **DECIDED**.
- **Hetzner region / size:** **`fsn1` (Falkenstein, Germany) + CX22**
  (€0.006/h, 2 vCPU, 4 GB RAM, 40 GB disk) — sufficient for the
  daemon + a few apps. **ASK** if you'd rather US-east (`ash`) or
  Hillsboro (`hil`) for lower-latency demos from US west coast.

---

## Phase A — true end-to-end smoke test (no demo-user yet)

**Goal.** Prove the existing personalize-+-install chain runs green on
a real Hetzner CX22 today. Fix the Hetzner ISO bridge as the first
substantive piece of new code.

### A.1 — Build a personalized ISO locally

Use existing tooling: `packages/iso-personalizer/`, the base ISO under
`apps/web/public/build/iso/`, and the existing build-ticket path.
Output: a self-contained `.iso` file on this Mac, ready for upload.

If `packages/iso-personalizer/` doesn't yet have a clean CLI that takes
"a username + a server-name + the base-ISO bytes" and produces a
personalized ISO, **build that** as part of A.1 (likely 50-150 lines
+ tests; the underlying `personalize.ts` function exists).

### A.2 — Bridge the Hetzner ISO gap (rescue-mode + dd)

This is the principal Phase A work. New provider behaviour:

1. `POST /v1/servers` with **`image: ubuntu-22.04`** (or any
   Hetzner-stock image) and **`ssh_keys: [<ours>]`** (Hetzner API
   requires a key for password-less rescue).
2. `POST /v1/servers/{id}/actions/enable_rescue` with
   `{ type: "linux64", ssh_keys: [...] }`. Hetzner returns a one-time
   root password (we don't need it since we use SSH key auth).
3. `POST /v1/servers/{id}/actions/reset` to reboot into rescue.
4. Wait for rescue SSH to be reachable (`nc -z <ip> 22`, ~30s).
5. **Serve the personalized ISO from a temp public URL.** Two options:
    - (a) Push the ISO bytes to R2 with a short-lived presigned read
      URL. Cleanest. Requires R2 SDK in the harness (or use the
      `wrangler r2 object put` CLI). Already have R2 in
      `wrangler.toml`.
    - (b) Use a local `python3 -m http.server` + `ngrok` / `cloudflared
      tunnel`. Hackier; OK for first run, not for prod.
   **Default to (a).**
6. SSH into rescue: `wget -O- <presigned> | dd of=/dev/sda bs=4M
   status=progress conv=fsync`.
7. `reboot` from rescue. Server boots from disk → Alpine + apkovl →
   `install.sh` runs.
8. The existing harness's `awaitInstallRegistered` + `awaitUnlock` +
   `probeGreenPadlock` stages then succeed against the live VPS.

New code: `tools/vps-e2e/src/providers/hetzner.ts` gets a
`rescueModeInstall(req, isoUrl)` helper; `provision()` is extended to
take an `isoUrl` (instead of a Hetzner-library name) and run the
rescue-dd dance.

Need to add an SSH client to `tools/vps-e2e/`. **`node-ssh`** is a
small, well-maintained option. Or shell out to `ssh` via `child_
process` for simplicity. **Default to the shell-out path** (no new
runtime dep; the harness only runs on dev machines).

### A.3 — Run the harness end-to-end

Build the harness with the new provider; mint a real-but-throwaway
build-code via `.com`'s existing `/dev/create-server`; run
`node tools/vps-e2e/dist/cli.js --iso <local-personalized.iso>
--upload-via r2`. Watch all 9 stages.

Acceptance: every stage in `runE2E.ts` reports `pass`; no `known-
gated`; `teardown` deletes the Hetzner server cleanly; total wall-clock
≤ 20 min.

### A.4 — Commit

A single Phase-A commit:
`feat(vps-e2e): rescue-mode + dd Hetzner bridge; first true e2e green`

with the green run output captured in `tools/vps-e2e/RUN-LOG.md` (or
embedded in the commit body).

---

## Phase B — design doc for sample-user-with-real-VPS

Write `docs/sample-users.md` capturing the concrete design every
subsequent phase implements against. Sections:

- **Demo username model** (entry in `TEST_ACCOUNTS` PLUS a row in a
  new D1 `demo_users` table).
- **Pre-built ISO storage**: R2 path `demo-isos/<username>-<sha8>.iso`.
- **Server lifecycle state machine**: `none → provisioning → up →
  idle-pending-teardown → none`. Triggers: client connect, idle
  timeout, manual delete.
- **Hetzner client in the Worker**: subset of `tools/vps-e2e/`'s
  provider, but Worker-side (uses `fetch()`, not `node-ssh`). The
  Worker can't SSH; rescue-mode-dd happens **once during create-
  sample-user**, on this Mac, when generating the per-demo-user ISO
  baseline. After that the Worker only does `POST /servers` +
  `DELETE /servers/{id}` per connect/idle cycle — using a Hetzner
  **snapshot** of an already-installed Flagship system bound to the
  demo user.
- **Snapshot model:** `create-sample-user` does Phase-A's rescue-mode-
  dd ONCE to get a clean Flagship install, then `POST /servers/{id}/
  actions/create_image` to make a Hetzner snapshot. Subsequent on-
  connect provisions use that snapshot (`POST /servers` with
  `image: <snapshot_id>`) — boots in ~30s vs ~5-10 min for fresh
  install. **DECIDED**.
- **`/api/users/check` extension**: when the matched test-account has
  a corresponding `demo_users` row, the response includes a
  `demoServer: { fqdn, status, snapshotId }` block. The client uses
  this to render the single device and to decide whether to call
  `/api/dev/sample-user/<name>/connect` (which provisions on demand).
- **`/api/dev/sample-user/<name>/connect`**: admin-or-demo-friendly
  endpoint (not strictly admin-gated; called by the client itself).
  Returns 200 with `{ fqdn, status }`. Provisions if not running;
  no-ops if running.
- **Idle-teardown cron**: existing `schedule: 0 */6 * * *` in
  `wrangler.toml` (every 6 hours is too slow). Add a new cron
  `*/10 * * * *` (every 10 min) that scans `demo_users` for
  `last_activity_at < now - 30min` ⇒ destroy.
- **`POST /api/dev/sample-user/create` shape**: body `{ username,
  display, region?, size?, ttlIdleMinutes? }`. Auth: admin secret.
- **`POST /api/dev/sample-user/delete` shape**: body `{ username }`.
  Auth: admin secret.

Commit: `docs: spec for sample-user / on-connect Hetzner provisioning`.

---

## Phase C — `.com` Worker + D1 schema

### C.1 — D1 migration

New table:

```sql
CREATE TABLE demo_users (
  username TEXT PRIMARY KEY,
  display TEXT NOT NULL,
  snapshot_id TEXT,                      -- Hetzner snapshot
  iso_r2_key TEXT,                       -- R2 object key (for snapshot rebuild)
  ttl_idle_minutes INTEGER NOT NULL DEFAULT 30,
  region TEXT NOT NULL DEFAULT 'fsn1',
  size TEXT NOT NULL DEFAULT 'cx22',
  active_server_id TEXT,                 -- Hetzner server ID when running
  active_server_fqdn TEXT,
  last_activity_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'none',    -- none | provisioning | up | idle-pending-teardown
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_demo_users_state ON demo_users(state);
CREATE INDEX idx_demo_users_last_activity ON demo_users(last_activity_at);
```

Migration file: `packages/storage/migrations/0027_demo_users.sql`.

### C.2 — Worker secrets

- `HCLOUD_TOKEN` — already in the operator's env per the message; new
  `wrangler secret put HCLOUD_TOKEN` from this Mac.
- `DEMO_PUBLIC_SSH_KEY` — SSH pubkey the Hetzner provisioning
  references (for rescue access on the initial install). Generated
  once: `ssh-keygen -t ed25519 -f .demo-ssh-key`. The private half
  stays on this Mac (used by Phase A.2 for rescue dd); only the public
  half goes into the Worker.
- `DEMO_R2_PRESIGN_KEY` — short-lived key for the Worker to mint
  presigned R2 URLs for in-Worker ISO operations.

### C.3 — Endpoints

| Method | Path | Auth | Body | Effect |
|---|---|---|---|---|
| POST | `/api/dev/sample-user/create` | admin secret | `{ username, display, region?, size?, ttlIdleMinutes? }` | Adds to `demo_users`, runs the Phase-A.2 install-and-snapshot via the harness (separate process; Worker just stores the resulting snapshot_id), updates `TEST_ACCOUNTS` |
| POST | `/api/dev/sample-user/delete` | admin secret | `{ username }` | Destroys server (if up), removes snapshot, removes R2 ISO, removes row |
| POST | `/api/dev/sample-user/<u>/connect` | client (rate-limited) | `{}` | Provisions if not up; updates last_activity_at; returns fqdn + status |
| POST | `/api/dev/sample-user/<u>/heartbeat` | client (rate-limited) | `{}` | Just updates last_activity_at; client calls every 5 min while interacting |

`POST /api/users/check` extended to embed the `demoServer` block when
the username matches a `demo_users` row.

### C.4 — Hetzner client (Worker-side)

`apps/com/src/hetzner.ts` — uses native `fetch()`, mints a Bearer-
authed call to `api.hetzner.cloud/v1/servers` etc. Subset of operations:
`POST /servers` with snapshot id, `DELETE /servers/{id}`, `POST
/servers/{id}/actions/create_image` (called from the CLI side, not
the live request path).

### C.5 — Idle cron

Add `crons = ["*/10 * * * *", "0 */6 * * *"]` in `wrangler.toml`. The
new 10-min cron picks `state == 'up'` rows where `last_activity_at <
now - ttl_idle_minutes * 60_000` and destroys the server.

### C.6 — Tests

Standard pattern: D1 migration tested in-memory; Hetzner client gets
a fake `fetch` injected (no real API calls in unit tests); cron
behaviour tested deterministically; endpoint tests at the route
level.

Commit: `feat(com): demo_users schema + provision/destroy endpoints + idle cron`.

---

## Phase D — mobile demo-mode upgrades

### D.1 — iOS

`DemoFixtures.activate(...)`: if the testAccount block on `/users/
check` includes `demoServer: { fqdn, status }`, the activate path
materialises **one** real PodInfo with that fqdn + that status, and
configures the client to call `/api/dev/sample-user/<u>/connect`
before opening the pod (waits for `status == 'up'`).

The pod's `/api/screens/*` interactions then go LIVE — no fixtures.

### D.2 — Android

Same shape against the Kotlin `MockScreensClient` + the live client.

### D.3 — Webapp PWA

Same.

### D.4 — Tests

Per-surface: 1 conformance test that asserts the demo-fork takes the
demoServer path when present, and the fixtures path when absent
(backward compatibility).

Commit: `feat(mobile): demo-mode renders one real device + provisions on connect`.

---

## Phase E — operator CLI

`scripts/sample-user.mjs` (and `.test.ts`) — wraps the admin endpoints:

```sh
node scripts/sample-user.mjs create demo-alice \
    --display "Demo Alice" --region fsn1 --size cx22 \
    --ttl-idle 30

node scripts/sample-user.mjs delete demo-alice

node scripts/sample-user.mjs list
node scripts/sample-user.mjs status demo-alice
```

`create` does:

1. POST `/api/dev/sample-user/create` → row in D1 + reserved username.
2. Build the personalized ISO locally (Phase A.1).
3. Upload ISO to R2 via wrangler (or via the Worker if there's a
   convenient endpoint).
4. Run the Phase-A rescue-mode-dd dance to provision **one
   temporary** Hetzner server, let it fully install + register +
   ACME, then call Hetzner `create_image` to snapshot it, then
   destroy the temporary server.
5. POST `/api/dev/sample-user/<u>/install-complete` with the
   `snapshot_id` → row updated to `state='none', snapshot_id=...`.

Commit: `feat(scripts): create-sample-user / delete-sample-user CLI`.

---

## Phase F — live end-to-end demo test

1. `HCLOUD_TOKEN=<your token>` in this Mac's env.
2. `node scripts/sample-user.mjs create demo-alice --display "Demo Alice"`.
   - Watch ISO build (~30s).
   - Watch R2 upload (~30s for a ~600 MB ISO).
   - Watch first Hetzner provision + install + ACME (~10 min).
   - Watch snapshot create (~3 min).
   - Watch temp server destroy.
   - Final: `demo-alice` ready; D1 row has `snapshot_id`; no server
     running.
3. Open `https://flagshipserver.com/dev/create-server` (or iOS
   simulator running locally), type `demo-alice`.
4. `/api/users/check` returns `testAccount` + `demoServer: { status:
   'none' }`. Mobile renders the single device.
5. Tap "connect". Client POSTs `/api/dev/sample-user/demo-alice/
   connect`. Worker calls Hetzner `POST /servers` with `image:
   <snapshot_id>`. Server boots from snapshot (~30s). Client polls
   `/api/users/check` until `demoServer.status == 'up'`.
6. Client connects to `home.demo-alice.flagship.services`, green
   padlock, real `/api/screens/*` interactions.
7. Leave it alone for 30 min. Cron destroys the server.
8. `node scripts/sample-user.mjs status demo-alice` → state: `none`.
9. Tap connect again → re-provisions from snapshot in ~30s.
10. `node scripts/sample-user.mjs delete demo-alice` → server
    destroyed (if up), snapshot deleted, R2 ISO removed, D1 row
    deleted.

Acceptance for Phase F: all 10 steps pass, total wall-clock for first
run ≤ 25 min; subsequent re-connects ≤ 60 s.

Commit: any final fixes that surface during live testing.

---

## Demo-user multi-device model (ratified)

Demo accounts use the **shared-deterministic-UMK** model: when any
device types a demo username, the client derives the **same** UMK from
`HKDF(public-salt, "demo-" + username)`. Each device gets its own
paired-session against the demo VPS; all devices share identity.

This is **non-secret by design** — that's the whole point of a demo.
Demos are public, copy-disposable sandboxes; the model would be wrong
for a real account. **Real-account multi-device + recovery is governed
by Plan B** (`docs/v1.2-security-cascade.md`) and is independent of
this plan.

What this lets a reviewer demonstrate:

- Type `demo-alice` on iPhone — pod provisions, green padlock.
- Type `demo-alice` on iPad — same identity; Trusted Devices shows
  two entries.
- Test Replace / Disconnect / Audit UI surfaces — operations are
  no-ops at the wire level on demo accounts (or scoped to the
  demo VPS only); UI shows believable state.

Concurrent paired-sessions per demo username: **3** (soft cap;
4th device displaces the LRU). Prevents N reviewers piling on a
single demo from blowing past the harness cap.

---

## Execution shape

Each phase runs in a separate sub-agent context (worktree-isolated),
sequentially. Between phases the orchestrator reviews the worktree
commit, merges to main, and dispatches the next.

| Phase | Owner | Approx. work |
|---|---|---|
| A | sub-agent, worktree | Hetzner rescue+dd bridge + green e2e |
| B | sub-agent, worktree | sample-users spec doc |
| C | sub-agent, worktree | Worker + D1 + Hetzner client |
| D | sub-agent, worktree | iOS + Android + webapp demo-mode |
| E | sub-agent, worktree | CLI scripts |
| F | orchestrator | live test against real Hetzner |

---

## Ratified decisions (final)

| # | Decision | Value |
|---|---|---|
| 1 | Hetzner region | `fsn1` (Falkenstein) |
| 2 | Hetzner size | `cx22` |
| 3 | Phase-A ISO transport | R2 presigned URL |
| 4 | Demo-user multi-device model | Shared deterministic UMK + multi-paired-session |
| 5 | Demo concurrent paired-sessions per username | 3 (soft cap) |
| 6 | Demo idle teardown | 30 min |
| 7 | Demo-user pattern | No prefix required; `TEST_ACCOUNTS` membership is the demo signal |
| 8 | Provisioning timing | On first connect (from snapshot, ~30s) |
| 9 | ISO storage (R2 path) | `demo-isos/<username>-<sha8>.iso` |
| 10 | Snapshot storage | Hetzner snapshot, created once during create-sample-user |
| 11 | Idle reaper cron | `*/10 * * * *` (every 10 min) |
| 12 | Max concurrent demo VPSs across all demos | 5 |
| 13 | Admin auth | Existing `FLAGSHIP_ADMIN_SECRET` bearer pattern |

Real-account hardening (grace-period extension, 2FA, quarantine, etc.)
is **out of scope** for this plan — see `docs/v1.2-security-cascade.md`.
