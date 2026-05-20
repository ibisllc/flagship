# Next-session prompt — Plan A live e2e finish

Paste this verbatim (or near-verbatim) into the next Claude Code
session to pick up where 2026-05-20's session left off. Designed to
preserve the working style we've used:

- **Deep-think before edits** — recon current state before writing code.
- **Sequential sub-workers** — dispatch one focused sub-agent per
  phase, isolated in a worktree, merge to main when verified.
- **Logical commits** — one PR-sized commit per landed phase, with
  a body explaining WHY not just WHAT.
- **Verify before trust** — always re-run `npx tsc -b` + `npx vitest
  run` + mobile gates after each merge.

---

## The prompt to paste

> Continuing the v1-launch program from 2026-05-20's checkpoint. Read
> `docs/SESSION-HANDOFF.md` §0 (top entry, dated 2026-05-20) FIRST —
> that's the authoritative record of where we are. Then read
> `docs/sample-user-vps-plan.md` Phase F and `docs/v1.2-security-
> cascade.md` for the strategic backdrop.
>
> **Current state in one sentence**: Plan A Phases A-E + Plan B
> Phases 1-5 are all code-complete + tests-green on main (sha
> `4027246`); the live Phase F demo-alice run reached
> `awaiting daemon + ACME…` but the install never registered because
> we used the personalize CLI's `synthesizeBlob` (offline test) mode
> instead of `--blob-json` mode with a real `.com`-issued ticket.
> Separately, `/api/users/<u>/pods` is throwing HTTP 500 for ALL
> users — probable column-rename fallout from the App→Service
> rename.
>
> **The goal**: get `node scripts/sample-user.mjs create demo-alice
> --display "Demo Alice" --region fsn1` to land a working demo-alice
> snapshot on Hetzner that mobile clients can connect to via the
> demoServer block path, end-to-end live.
>
> **What's known broken** (see SESSION-HANDOFF §0 for the precise
> root causes):
>
> 1. `synthesizeBlob` → daemon never registers. The CLI needs to
>    mint a real auth-code + build-ticket against `.com` BEFORE
>    personalizing — derive a deterministic IRK from the demo
>    username (so mobile clients can compute the same one), claim
>    the username with that IRK, mint the chain, pass the install
>    blob to `personalize-iso --blob-json`. The harness in
>    `tools/vps-e2e/src/runE2E.ts:mintBuildCode` already does
>    exactly this for the e2e test; reuse the wire helpers in
>    `tools/vps-e2e/src/wire.ts`.
> 2. `/api/users/<u>/pods` HTTP 500. Probable cause: the
>    `daemon_status.apps_served` → `services_served_json` column
>    rename never reached prod D1; the Worker reads the new column
>    name + chokes on undefined. Probe with `wrangler d1 execute
>    flagship-state --remote --command "PRAGMA table_info(daemon_
>    status)"` and either add `0031_daemon_status_services_served
>    .sql` (rename / add the column on prod) or make
>    `handleGetUserPods` tolerant.
>
> **Working discipline this session**:
>
> 1. Start with `git log -20 --oneline` + read the §0 entry for
>    context (don't re-derive what's already known).
> 2. Address (1) and (2) as TWO separate phases — each its own
>    sub-agent in a worktree, each its own logical commit.
> 3. For (1), the substantial phase: write a `docs/sample-users-
>    real-ticket.md` spec FIRST (~200 lines, similar to how
>    docs/sample-users.md was bootstrapped), then dispatch a sub-
>    agent against the spec.
> 4. After both fixes, drive the LIVE e2e from the operator's
>    shell (HCLOUD_TOKEN + FLAGSHIP_ADMIN_SECRET both in env per
>    `~/.zshrc`). Don't try to do the live run yourself — agent
>    processes can't reach the operator's secrets.
> 5. Once `create-sample-user demo-alice` lands a snapshot, open
>    iOS or webapp (locally / on simulator) and type `demo-alice`
>    to verify the mobile demo-mode connect flow works end-to-end.
>
> **Constraints (per CLAUDE.md + prior session)**:
>
> - **No `Co-Authored-By: Claude` trailer** on commits — user
>   preference.
> - Imperative commit subjects; body explains WHY not WHAT.
> - `npx tsc -b` + `npx vitest run` + (when mobile is touched)
>   xcodebuild on iOS + `./gradlew test` on Android must all stay
>   green.
> - Apps-com isn't in the workspace `tsc -b` build references; if
>   you touch it, ALSO run `npx tsc -p apps/com/tsconfig.json
>   --noEmit` to catch the bugs `-b` misses (the Phase C
>   `authorizeAdmin` signature bug got past `tsc -b` for this
>   reason; we caught it post-deploy in `4bfbe2d`).
> - Wrangler 4.x has NO `r2 object presign` subcommand (only
>   get/put/delete on `r2 object`); use the bucket's r2.dev
>   public URL via `wrangler r2 bucket dev-url enable <bucket>`.
> - Operator-only state already live: `FLAGSHIP_ADMIN_SECRET`,
>   `FLAGSHIP_CA_PRIV_HEX`, `CA_ENDORSEMENT_ENFORCE='true'` on
>   the `flagship-com` Worker; `HCLOUD_TOKEN` is in operator's
>   shell env but NOT on the Worker (Worker only needs it once
>   on-connect provisioning starts — which is post-snapshot).
>
> **Reach + scope (NEW design item from 2026-05-20 session
> close)**: see `docs/v1.2-security-cascade.md` "Per-device
> addressing + permissions (corporate-deployment angle)" —
> `harry` vs `harry.ipad` mapping to `USERKEYHASH.*` vs
> `USERKEYHASH.DEVICEKEYHASH`. Defer to v2; mentioned here so a
> future agent doesn't lose the requirement.
>
> Walk slowly. Verify each step. Commit after each phase. Don't
> dispatch a sub-agent until you understand exactly what it
> needs to do.

---

## Hard requirements to satisfy before declaring Phase F done

1. `node scripts/sample-user.mjs create demo-alice --display "Demo Alice" --region fsn1`
   completes with stdout JSON: `{"username":"demo-alice","ready":true,"snapshotId":"<numeric>"}`.
2. `curl https://flagshipserver.com/api/users/demo-alice/pods`
   shows `home.demo-alice.flagship.services` in the response.
3. `curl https://flagshipserver.com/api/users/check -d '{"username":"demo-alice"}'`
   returns a `demoServer` block with `status: "none"` (post-snapshot,
   pre-connect).
4. Posting to `/api/dev/sample-user/demo-alice/connect` provisions a
   fresh VPS from the snapshot in <60s; the response says
   `status: "provisioning"` initially, then `status: "up"` after the
   poller cron promotes it.
5. iOS simulator or webapp, typed `demo-alice`, advances to the
   real-device path (NOT the legacy 3-fixtures path) and shows the
   green padlock against `home.demo-alice.flagship.services`.
6. Idle teardown (30 min default) destroys the VPS; the next
   `/connect` re-provisions from the snapshot.
7. `node scripts/sample-user.mjs delete demo-alice` tears down the
   snapshot + R2 ISO + D1 row cleanly.

## Recovery state if anything goes sideways

- The orphan-IP cleanup at start of every CLI invocation handles
  primary-IP quota debt automatically.
- The destroy-on-failure inside `HetznerProvider.provision` handles
  partial-VPS cleanup automatically.
- Heartbeat lines every 30s during `awaitDaemonReady` so the
  operator knows the CLI isn't frozen.
- The personalize-iso cache at `~/.cache/flagship-demo-isos/` is
  intact; first run after the --blob-json refactor will rebuild
  the cache entry (different bytes, different sha8 → different R2
  key, expected).
- If Hetzner has capacity issues in `fsn1`, `--region nbg1` or
  `--region hel1` are the proven EU alternatives. `ash`/`hil` are
  US-only with CCX (dedicated, needs quota grant) or CAX (ARM,
  incompatible ISO).
