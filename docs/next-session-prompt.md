# Next-session prompt — Plan A Phase F (with v2 device-addressing pulled in)

Paste this verbatim into the next Claude Code session. Designed to
preserve the working style we've used:

- **Deep-think before edits** — recon current state before writing code.
- **Sequential sub-workers** — dispatch one focused sub-agent per
  phase, isolated in a worktree, merge to main when verified.
- **Logical commits** — one PR-sized commit per landed phase, with
  a body explaining WHY not just WHAT.
- **Verify before trust** — always re-run `npx tsc -b` + `npx vitest
  run` + mobile gates after each merge.
- **Cloud-first** — push as much as possible into the Worker; minimize
  laptop dependence.
- **No mid-session pauses for "ready for next phase?"** — flow
  continuously across sub-agents. Only stop for genuine design
  ambiguity.

---

## OPERATOR PREREQS (done ONCE, before pasting this prompt)

These move the demo system's runtime to the Worker so future demos
don't need the operator's laptop:

```sh
# 1. Push HCLOUD_TOKEN to the Worker (currently only in operator shell;
#    Worker can't provision on-connect without it)
cd /Users/harrywinner/flagship/apps/com
printf '%s' "$HCLOUD_TOKEN" | npx wrangler secret put HCLOUD_TOKEN

# 2. Push the demo SSH public key to the Worker (for completeness;
#    Worker uses it only to label provisioned snapshots, never SSHes)
cat ~/.ssh/flagship-demo-ssh.pub | npx wrangler secret put DEMO_PUBLIC_SSH_KEY

# 3. Re-deploy the Worker so the new secrets land
npx wrangler deploy

cd /Users/harrywinner/flagship
```

After these run ONCE, the only ongoing laptop work is the one-time
`create-sample-user demo-alice` per demo user (the rescue+dd dance
can't run in the Worker — no SSH). Everything else — on-connect
provisioning, idle teardown, status polls — runs Worker-side.

---

## The prompt to paste

> Continuing the v1-launch program from 2026-05-20's checkpoint. Read
> `docs/SESSION-HANDOFF.md` §0 (top entry, dated 2026-05-20) FIRST —
> that's the authoritative record of where we are. Then read
> `docs/sample-user-vps-plan.md` Phase F, `docs/v1.2-security-
> cascade.md` (esp. the corporate-device-addressing v2 section we
> just added), and this file's "Locked Decisions" section below.
>
> **Current state in one sentence**: Plan A Phases A-E + Plan B
> Phases 1-5 are all code-complete + tests-green on main (sha
> `d15cd1d`); the live Phase F demo-alice run reached `awaiting
> daemon + ACME…` but the install never registered because we used
> the personalize CLI's `synthesizeBlob` (offline test) mode instead
> of `--blob-json` mode with a real `.com`-issued ticket. Separately,
> `/api/users/<u>/pods` is throwing HTTP 500 for ALL users —
> probable column-rename fallout from the App→Service rename.
>
> **The owner has decided** (steered at session close 2026-05-20):
> 1. SSH-runner stays on operator laptop (one-time per demo user).
> 2. Demo accounts get the per-device IRK + corporate-style
>    scopes from Plan B's v2 hardening list. The `harry` vs
>    `harry.ipad` two-level addressing must be in PLACE before
>    Phase F is declared green — demos are the first use site.
> 3. Phase G (§S v1-launch live exercises) is queued after Phase F.
>
> **Work plan, sequential and continuous** (no pauses between):
>
> **S1 — fix /api/users/<u>/pods 500** (~30 min, one sub-agent,
> one commit). Probe prod D1's `daemon_status` table schema via
> `wrangler d1 execute flagship-state --remote --command "PRAGMA
> table_info(daemon_status)"`. If the column rename
> `apps_served` → `services_served_json` (migration 0015 edited
> in-place during the App→Service rename) never reached prod,
> author a `0031_daemon_status_services_served.sql` migration that
> ALTER TABLE RENAMEs the column on prod, apply it, redeploy
> `apps/com`. Verify with a `curl` probe to `/api/users/harry11911a/pods`
> showing HTTP 200. Commit + push.
>
> **S2 — DESIGN: spec the combined real-ticket + per-device-IRK
> architecture** (~1 hour, in-context, no sub-agent). Write
> `docs/v2-device-addressing-and-real-ticket.md` (~400 lines)
> capturing:
> - Per-device IRK derivation: each device gets its own IRK as
>   a child of the user's master IRK (or a stand-alone IRK signed
>   by the user IRK). `<user>` addresses the user-level IRK;
>   `<user>.<device-label>` addresses the device-level IRK.
> - DeviceCapabilityGrant envelope: signed by the user IRK, lists
>   `device_label` + allowed scopes (`install-service`,
>   `vibe-code`, `add-device`, `browse`, plus the demo-specific
>   `demo-provision`).
> - Schema additions: `paired_sessions.device_label` +
>   `device_capability_grants` table.
> - Real-ticket integration: at `create-sample-user` time,
>   derive a deterministic user IRK from `HKDF(salt='flagship-
>   demo-v1', info='demo-' + username)`, claim the username with
>   that IRK, mint auth-code + build-ticket against `.com`, pass
>   the install blob to `personalize-iso --blob-json`.
> - Demo flow integration: mobile clients typing `demo-alice` get
>   the user IRK from the deterministic derivation; clients
>   typing `demo-alice.ipad` get a device-scoped sub-identity
>   with reviewer-friendly capability restrictions (read-only
>   browse vs full install).
> - File-by-file appendix listing every touch site for the
>   downstream sub-agents (similar to `docs/sample-users.md`'s
>   structure).
>
> Use the open design questions at the bottom of this prompt to
> guide the spec; resolve them by writing your best-judgment
> answer with a note flagging where the operator should sanity-
> check before implementation. Don't ask mid-spec — capture
> uncertainty in the doc + flag for owner review at the end.
>
> Single commit `docs: spec for v2 per-device addressing + real-ticket
> integration (Plan A Phase F live blocker)`.
>
> **S3+ — implement the spec** (parallel sub-agents allowed for
> non-overlapping surface areas; sequential for layered ones).
> Suggested phase decomposition:
> - S3.1: Protocol envelopes + canonical-bytes (`packages/protocol`).
>   Single sub-agent, single commit.
> - S3.2: Storage schema + adapters (D1 migration 0032 + InMemory).
>   Single sub-agent, single commit.
> - S3.3: Worker — username claim, auth-code, build-ticket admin
>   endpoints + capability checks at every privileged route.
>   Single sub-agent, single commit.
> - S3.4: CLI refactor — `scripts/sample-user.mjs` mints real
>   ticket via the new admin endpoints + calls `personalize-iso
>   --blob-json`. Single sub-agent, single commit.
> - S3.5: Mobile surfaces — iOS/Android/webapp render device-
>   label + capability badges; reviewer-friendly demo UI.
>   Single sub-agent, single commit.
>
> Between S3.x sub-agents, merge to main + re-verify gates. Don't
> dispatch the next sub-agent until the previous one's verifier
> is green on main.
>
> **S4 — live e2e** (operator-driven; agent can't run the SSH
> dance). The operator runs `node scripts/sample-user.mjs create
> demo-alice --display "Demo Alice" --region fsn1` ONCE; the
> snapshot lands; from then on the Worker handles everything.
> Agent verifies the green-padlock + mobile demo-mode probe via
> automated checks.
>
> **Acceptance for Phase F done** (matches the original Phase F
> bar from `docs/sample-user-vps-plan.md`, expanded for the new
> device-addressing requirement):
> 1. `node scripts/sample-user.mjs create demo-alice --display
>    "Demo Alice"` completes with stdout JSON `{"username":
>    "demo-alice","ready":true,"snapshotId":"<numeric>"}`.
> 2. `curl /api/users/demo-alice/pods` shows the daemon.
> 3. `/api/users/check` returns `demoServer` block.
> 4. `/api/dev/sample-user/demo-alice/connect` provisions from
>    snapshot in <60s.
> 5. iOS / webapp, type `demo-alice`, advances to real-device
>    path with green padlock at `home.demo-alice.flagship.services`.
> 6. iOS / webapp, type `demo-alice.reviewer`, advances to a
>    device-scoped sub-identity with restricted capabilities
>    visible in the UI (e.g. "this device cannot install
>    services").
> 7. Idle teardown destroys VPS; re-connect re-provisions.
> 8. `delete-sample-user` cleans up snapshot + R2 + D1.
>
> **Constraints (per CLAUDE.md + prior session)**:
> - No `Co-Authored-By: Claude` trailer on commits — user
>   preference.
> - Imperative commit subjects; body explains WHY not WHAT.
> - `npx tsc -b` + `npx vitest run` + (when mobile is touched)
>   xcodebuild + `./gradlew test` must stay green.
> - `apps/com` isn't in workspace `tsc -b` references; also run
>   `npx tsc -p apps/com/tsconfig.json --noEmit` to catch the
>   bugs `-b` misses.
> - Wrangler 4.x has NO `r2 object presign` (use dev-url
>   public bucket).
> - The operator's `HCLOUD_TOKEN` + `FLAGSHIP_ADMIN_SECRET` are
>   in `~/.zshrc` (per session close); the Worker now has
>   `HCLOUD_TOKEN` too (per the prereqs above).
>
> Walk slowly. Verify each step. Commit after each phase. Use
> sub-agents in worktrees for the implementation phases (S3.x),
> in-context for the spec phase (S2) and the small /pods fix
> (S1).

---

## Locked Decisions (do not re-litigate)

1. **SSH-runner location**: operator laptop, one-time per demo
   user. Acceptable because each `create-sample-user` is rare
   (one per demo user, ever) and the Worker handles every
   subsequent operation without the laptop.

2. **Demo IRK model**: per-device IRK with corporate-style
   scopes. The `harry` vs `harry.ipad` two-level addressing is
   implemented as part of Phase F (not deferred). Demos
   showcase the capability surface.

3. **Post-Phase F priority**: Phase G — the §S live exercises
   from `docs/build-tasks.md`. NOT polish, NOT marketing.

---

## Open design questions (S2 spec phase should resolve)

1. **Device label assignment**: at pairing time the user types a
   label (`ipad`, `work-laptop`)? Or auto-derived from a stable
   hardware identifier? Or both (auto-suggest + editable)?

2. **Default capability set for a fresh device**: when a new
   device is admitted, does it default to FULL capabilities
   (user explicitly restricts later) or RESTRICTED (user
   explicitly grants)? Trade-off: usability vs corporate
   security posture.

3. **Demo-account scoping**: when multiple reviewers type
   `demo-alice` simultaneously, do they share state (one VPS,
   one set of installed apps) or each get a sub-identity
   `demo-alice.<reviewer-derived-label>` with isolated state?
   The Hetzner-snapshot architecture currently supports ONE
   server per demo user; isolated sub-sandboxes would require
   per-device snapshots (multiplies cost + complexity).

4. **DeviceCapabilityGrant revocation**: how is a grant
   revoked? Mint a new grant with smaller scope and the daemon
   honors most-recent? Explicit revocation envelope? CAS on
   D1?

5. **Pre-rename pivot decision**: should we ALSO refactor the
   existing user-key model to use the explicit two-level
   addressing for ALL accounts (not just demos), even
   single-device ones? Long-term tax of dual-mode logic
   vs short-term refactor cost. Probably defer to v2 proper.

---

## Hard requirements to satisfy before declaring Phase F done

(Same list as the original prompt, expanded for the new
device-addressing acceptance criteria.)

1. `node scripts/sample-user.mjs create demo-alice --display
   "Demo Alice" --region fsn1` completes with stdout JSON:
   `{"username":"demo-alice","ready":true,"snapshotId":"<numeric>"}`.
2. `curl https://flagshipserver.com/api/users/demo-alice/pods`
   shows `home.demo-alice.flagship.services` in the response
   (HTTP 200, not 500).
3. `curl -X POST https://flagshipserver.com/api/users/check
   -H 'content-type: application/json'
   -d '{"username":"demo-alice"}'` returns a `demoServer`
   block with `status: "none"` (post-snapshot, pre-connect).
4. POSTing to `/api/dev/sample-user/demo-alice/connect`
   provisions a fresh VPS from the snapshot in <60s; status
   transitions `provisioning` → `up`.
5. iOS simulator or webapp, typed `demo-alice`, advances to
   the real-device path (NOT legacy 3-fixtures) and shows the
   green padlock at `home.demo-alice.flagship.services`.
6. iOS simulator or webapp, typed `demo-alice.reviewer`,
   advances to a device-scoped sub-identity with restricted
   capabilities visible in the UI ("this device cannot
   install services" or similar).
7. Idle teardown (30 min default) destroys the VPS; the next
   `/connect` re-provisions from the snapshot in <60s.
8. `node scripts/sample-user.mjs delete demo-alice` tears down
   the snapshot + R2 ISO + D1 row cleanly.

## Recovery state if anything goes sideways

- The orphan-IP cleanup at start of every CLI invocation
  handles primary-IP quota debt automatically.
- The destroy-on-failure inside `HetznerProvider.provision`
  handles partial-VPS cleanup automatically.
- Heartbeat lines every 30s during `awaitDaemonReady` so the
  operator knows the CLI isn't frozen.
- The personalize-iso cache at `~/.cache/flagship-demo-isos/`
  is intact; first run after the --blob-json refactor will
  rebuild the cache entry (different bytes, different sha8 →
  different R2 key, expected).
- If Hetzner has capacity issues in `fsn1`, `--region nbg1` /
  `hel1` are the proven EU alternatives. `ash`/`hil` are
  US-only with CCX (dedicated; needs quota grant) or CAX
  (ARM; ISO incompatible).
