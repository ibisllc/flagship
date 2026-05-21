# Operator next steps — 2026-05-20 autonomous session checkpoint

**Read this first when you sit back down.** Everything below is the irreducible-human / credential / live-test work the agent could not do on its own. The `docs/SESSION-HANDOFF.md` §0 entry has the per-commit detail; this file is just the "what do I run, in what order" punch list.

## State at session end

- `main` HEAD: `9c26866` (or a later commit if the in-flight sub-agents land — see "Background sub-agents" below).
- prod-D1: migrations through 0032 applied.
  - 0031: `device_capability_grants` (v2 device-addressing).
  - 0032: `usernames.recovery_wipe_policy TEXT NOT NULL DEFAULT 'graceful'` (W6).
- prod-Worker: version `fe261337-808d-4f9b-9fb6-15953354465f`. **Stale** — does not yet have W1 (veto repurpose), W6 (per-cloud recovery wipe policy handler), or W7 (wipe-restart grant revocation). All landed on `main` but not deployed.
- prod-Worker secrets set: `HCLOUD_TOKEN`, `DEMO_PUBLIC_SSH_KEY`, `FLAGSHIP_ADMIN_SECRET`, `FLAGSHIP_TOTP_KEK`, `FLAGSHIP_CA_PRIV_HEX`, `DEMO_IRK_KEK`, `CA_ENDORSEMENT_ENFORCE=true`.
- `ibisllc/flagship` repo: public (verified 2026-05-20 22:30 UTC).

## What to run, in order

### 1. Redeploy Worker (mandatory before any live test)

```sh
cd apps/com && npx wrangler deploy
```

This picks up W1 + W6 + W7 + the v2 endpoints' final wiring. The Worker won't 503 without this — the existing routes still work — but the device-thief veto vector is still open and the recovery-wipe policy is unused until the Worker handler is updated.

### 2. Live Phase F test attempt #5 (W11 — laptop credentials shrunk)

**W11 update (2026-05-21):** the laptop no longer needs
`HCLOUD_TOKEN` or a Hetzner SSH key. The Worker handles every
Hetzner operation via cloud-init `user_data` — a `#!/bin/bash`
script Hetzner runs as root at first boot (no SSH involved). The
pre-W11 `export HCLOUD_TOKEN=…` step is GONE; only
`FLAGSHIP_ADMIN_SECRET` lives on the laptop now.

Required laptop env:

```sh
export FLAGSHIP_ADMIN_SECRET=<bearer>      # admin endpoint auth
# No HCLOUD_TOKEN, no DEMO_SSH_KEY_PATH.
```

Required Worker-side bindings (already set per "State at session
end" above):

- `wrangler secret put HCLOUD_TOKEN`
- `wrangler secret put DEMO_IRK_KEK`
- `wrangler.toml [vars] FLAGSHIP_R2_TEMP_PUBLIC_BASE`
  ⇒ enabled once via
  `wrangler r2 bucket dev-url enable flagship-iso-temp`
- `[[r2_buckets]] binding = "ISO_TEMP_BUCKET" bucket_name = "flagship-iso-temp"`

Now run:

```sh
node scripts/sample-user.mjs create demo-alice --display "Demo Alice"
```

Expected end state:
- Worker streams personalized ISO into the `flagship-iso-temp`
  bucket (~5s).
- Worker POSTs Hetzner `/servers` with `image: 'ubuntu-22.04'` +
  `user_data: '<bash wget+dd+reboot script>'`.
- Stock Ubuntu boots, cloud-init runs the script as root, dd's the
  ISO onto /dev/sda, reboots.
- Alpine boots from the now-written disk; bootstrap fetches
  install.sh from the public GitHub raw.
- install.sh sync+umounts /dev/sda (W2 fix), repartitions, LUKS-init,
  mkfs, grub-install.
- Daemon registers with `.com`; ACME runs.
- `/api/users/demo-alice/pods` shows
  `home.demo-alice.flagship.services`.
- The 10-minute cron snapshots the temp VPS + destroys it.
- CLI exits 0 with `{"username": "demo-alice", "ready": true,
  "snapshotId": "<numeric>"}`.

If anything fails: there is no laptop SSH key, so debugging is via
Hetzner's web console (or by setting `DEMO_PUBLIC_SSH_KEY` on the
Worker — the W11 handler attaches it to the temp VPS if present).
Tail `/var/log/flagship-cloud-init.log` for the wget/dd phase,
`/var/log/flagship-install.log` + `/var/log/flagship-bootstrap.log`
for the Alpine install phase.

### 3. Mint a reviewer sub-identity + smoke v2 device-addressing

```sh
node scripts/sample-user.mjs grant-device demo-alice reviewer --scopes browse
```

Then probe:

```sh
curl -X POST https://flagshipserver.com/api/users/check \
  -H 'content-type: application/json' \
  -d '{"username":"demo-alice.reviewer"}'
```

Expect HTTP 200 with both `demoServer` and `deviceCapability` blocks; `deviceCapability.scopes` is `["browse"]`.

### 4. Smoke test the mobile demo-mode rendering

- iOS: open the FlagshipUI scheme in simulator (or a real device). Type `demo-alice` → full demo UI. Type `demo-alice.reviewer` → reviewer chip below the username + Install/Vibe-code actions disabled with tooltip "Use a primary device."
- Webapp: `https://web.flagshipserver.com/` → same flow.
- Android: when you've got a JDK box (memory `reference_android_toolchain`).

### 5. Smoke test wipe-restart's v2 grant revocation

(After steps 1-4 work) — mint a couple of device grants for `demo-alice`, then call wipe-restart. Response should carry `revokedGrantIds: [...]` with both grant IDs. Probe `device_capability_grants` and confirm each row has `revoked_at IS NOT NULL`.

### 6. Iteration loop

If attempt #5 fails:
- The most likely failure modes have been front-loaded by this session's five bug fixes. Whatever's left is probably specific to the install chain on Hetzner (LUKS Argon2id timing? grub install on a hybrid-booted disk?).
- The CLI's `awaitDaemonReady` polls `/api/users/<u>/pods` for 15 min. Within that window you can `ssh root@<ip>` to the VPS BEFORE the rescue reboot, OR after the install completes you can hit `https://home.demo-alice.flagship.services/api/health` directly (port 443 once ACME runs).

## Background sub-agents (status at session end)

Two sub-agents launched late in the session:

- **W3+W8** — mobile multi-profile model + iCloud Keychain attribute split. Agent ID `a6e6b9112e462a296`. Worktree `/Users/harrywinner/flagship/.claude/worktrees/agent-a6e6b9112e462a296`. If completed before you returned, merged onto main; if not, the agent's transcript is in the harness logs.
- **W10** — vibe-code env-var UI + push-on-AI-ask. Agent ID `a8eeb329ded3cc2b3`. Worktree `/Users/harrywinner/flagship/.claude/worktrees/agent-a8eeb329ded3cc2b3`.

Check `git log --oneline -20` to see if either landed. If they did, gates were verified before merge (vitest, iOS xcodebuild, Android gradle). If they didn't, the worktrees may have raw work-in-progress; either resume them via SendMessage or pick up from the spec in the original Agent prompts.

## Deferred design decisions

The agent did NOT touch the following because they were either (a) flagged by the user for "when I'm back" or (b) too large for one autonomous turn:

1. **Full username → cloud vocabulary rename across UI strings.** Wire types stay; only user-facing copy in iOS/Android/webapp needs to flip "user" → "cloud" / "username" → "cloud name." The data model in W3 already uses `cloudName`; this is just string-table churn.
2. **Explicit `'admin'` DeviceScope.** The user proposed it then walked it back ("destroy was already what we were doing for un-vouched recovery"). The 7-scope set on `DEVICE_SCOPES` stands. If you want to add `'admin'` later it's purely additive.
3. **Daemon-side `requireDeviceScope` integration.** The helper exists in `packages/control-plane/src/deviceCapabilityGrants.ts` and is tested. Wiring it into `packages/server-daemon/src/servicePlatform.ts:install` so device-IRK-signed install requests get scope-checked is the next natural step but requires a substantial daemon-side cache + refresh mechanism for the grants.
4. **Multi-admin clouds.** v2 has ONE admin per cloud (the creator). Husband+wife both-admin requires sharing the cloud-root-key across two Apple IDs, which iCloud Keychain doesn't natively do. v3 design discussion.
5. **TestFlight / Play upload.** Always operator-driven (Apple/Google accounts).

## What was fixed this session (commit chain)

```
9c26866  fix(control-plane): wipe-restart revokes every DeviceCapabilityGrant
5035403  fix(control-plane): per-cloud recovery-wipe policy (W6)
5d27acb  fix(installer): quiesce TARGET before parted on single-disk VPS (W2)
6ccef63  fix(control-plane): /re-pair/object is self-cancel only (W1)
e94d705  fix(control-plane): release pending_re_pairs lock on dispute resolution
e4ce84b  docs: SESSION-HANDOFF — Plan A Phase F live test outcome
ee6446b  fix(installer): allow single-disk VPS in-place install on TRAILER_SRC
1f3dd4b  fix(provider/hetzner): preserve real newlines in dd command
cfc3b9c  fix(control-plane): admin-claim-and-issue returns blob as object
f355c7e  fix(apps/com): wire deviceCapabilityGrants into /users/check route
31ce5c6  ops: backfill 10 prod-D1 migrations (0006-0019 + 0023/0026)
```

Final autonomous-session gates:
- vitest **3103 passing** (was 2944 baseline; +159 across this and earlier sessions).
- `npx tsc -b` clean.
- iOS xcodebuild `-scheme FlagshipMobile-Package test` **275 passing** (pre-W3 baseline).
- Android `./gradlew test` BUILD SUCCESSFUL.

## TL;DR

```sh
# 1. Deploy Worker.
cd apps/com && npx wrangler deploy

# 2. Run live test.
cd /Users/harrywinner/flagship
node scripts/sample-user.mjs create demo-alice --display "Demo Alice"

# 3. If green: mint a reviewer + probe.
node scripts/sample-user.mjs grant-device demo-alice reviewer --scopes browse
curl -X POST https://flagshipserver.com/api/users/check \
  -H 'content-type: application/json' \
  -d '{"username":"demo-alice.reviewer"}'

# 4. Open iOS / webapp; type both demo-alice and demo-alice.reviewer.
```
