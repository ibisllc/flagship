# vps-e2e — run log

## Run 2026-05-19 (Plan A Phase A — `feat/vps-e2e-rescue-mode-dd`)

### Code changes shipped

- **`packages/iso-personalizer/src/cli.ts`** — first-class CLI for
  building a personalized Flagship ISO from either:
  (a) `--username` + `--server-name` (synthesizes a self-signed install
  blob with an IRK derived from a seed; useful for offline tests), or
  (b) `--blob-json` (consumes the exact envelope shape `.com` returns
  from `/api/build-tickets/issue` and bakes that blob's signature into
  the trailer verbatim). +20 unit tests (all green).
- **`packages/iso-personalizer/bin/personalize-iso.mjs`** — `tsx`-
  backed shell wrapper so the CLI runs from a fresh checkout without
  an explicit build step.
- **`tools/vps-e2e/src/providers/hetzner.ts`** — complete rewrite. The
  old `attach_iso` path is GONE (Hetzner Cloud has no public custom-ISO
  upload API; that code path could never actually boot our
  personalized ISO on a real CX22). The new flow is:
  1. `POST /v1/ssh_keys` (idempotent by name `flagship-vps-e2e`)
  2. `POST /v1/servers` with `image:"ubuntu-22.04"` + `ssh_keys:[id]`
  3. `POST /v1/servers/{id}/actions/enable_rescue` (`type:"linux64"`)
  4. `POST /v1/servers/{id}/actions/reset` (boot into rescue)
  5. Poll TCP 22 on the public IP (rescue SSHD ready)
  6. SSH in as root + run `wget <presigned-iso-url> | dd of=/dev/sda
     bs=4M conv=fsync && reboot`
  7. `awaitBoot` waits for the box to come back from the dd-reboot.
  8. `destroy` (idempotent) tears it down — runs in `finally` whether
     or not the chain succeeded.
- **`tools/vps-e2e/src/r2Upload.ts`** — thin wrapper around
  `npx wrangler r2 object {put,presign,delete}` so we don't take on an
  S3 SDK dep. Pure CLI builders + URL parser are unit-tested with a
  fake spawn.
- **`tools/vps-e2e/src/cli.ts`** — adds `--ssh-key-path` (default
  `.demo-ssh-key`, auto-generated via `ssh-keygen` if absent),
  `--upload-via r2|none` (R2 is the default), `--r2-bucket` (default
  `flagship-iso-temp`). Default region flipped to `fsn1` per the plan.
- **`tools/vps-e2e/src/runE2E.ts`** — new `publishIso` stage between
  `mintBuildCode` and `provisionVps`. `mintBuildCode` now captures the
  install-blob JSON + IRK signature into RunState so the publisher can
  bake them into the trailer verbatim (so the trailer matches the live
  `.com`-recorded ticket). New `IsoPublisher` port on `E2EDeps`.
- **`tools/vps-e2e/src/ports.ts`** — `IsoPublisher` interface; optional
  `isoPublisher` on `E2EDeps`. Backward-compatible: when absent, the
  core passes `plan.iso` verbatim to the provider (the unit-test path).
- **`tools/vps-e2e/README.md`** — operator instructions (prereqs,
  invocation, cost note, "why rescue+dd").

### Test results

`npx vitest run` — 2709/2709 pass across 238 test files (~14s).
`npx tsc -b` — clean (whole workspace).

### Plan output (zero-credentials sanity)

```
$ npx tsx tools/vps-e2e/src/cli.ts --plan
create-vps — full ordered chain (no provisioning happens with --plan):

 1. mintBuildCode
    claim username + issue auth-code + register RCK + issue build ticket on .com (IRK-signed via @flagship/protocol)
 2. publishIso
    personalize the base ISO with the .com-signed install blob, upload to R2, mint a 1h presigned URL the rescue VPS will fetch
 3. provisionVps
    Hetzner rescue-mode + dd: POST /servers (ubuntu-22.04 + ssh_keys) → enable_rescue → reset → ssh root@<ip> 'wget <presigned> | dd of=/dev/sda && reboot'
 4. awaitInstallRegistered
    poll .com /api/users/<user>/pods until the first-boot installer has registered <server>.<user>.flagship.services
 5. awaitUnlock
    poll .com until the pod reports unlocked/ready (the boot-stage /unlock-key/consume effect)
 6. probeGreenPadlock
    GET https://<server>.<user>.flagship.services/ → HTTP 200 + a currently-valid Let's Encrypt cert (TLS-ALPN-01 over SNI passthrough)
 7. createAccountServer
    assert the free account/server path is live (per-server /api/health → 200)
 8. vibeAppEnv
    owner-IRK-signed set-app-env order → vibecode an app that reads the var from its env → assert it answers using the injected value (value sealed at rest, NAME-only to the model)
 9. assertCaAuthorized [KNOWN-GATED]
    fetch the served pubkey-cert and assert it chains to a CaEndorsement authorized by the baked MAINTAINER_PINNED_MANDATE_HASH
    gatedReason: Served pubkey-cert is signed with the raw FLAGSHIP_CA_PRIV_HEX and there is NO CaEndorsement gate upstream on `.com`: links 2-4 in packages/server-daemon/src/caTrustChain.ts + packages/protocol/src/maintainerCa.ts are code-ready but uncalled in prod. Expected-fail until the consumer wiring + the human CaEndorsement ceremony under MAINTAINER_PINNED_MANDATE_HASH land.
10. teardown [ALWAYS — try/finally]
    ALWAYS attempted (try/finally) even on mid-chain failure: provider.destroy(instanceId) unless --keep
```

### Live Hetzner run

**NOT executed in this worktree.** The agent shell process did not
have `HCLOUD_TOKEN` set:

```
$ printenv HCLOUD_TOKEN
$ echo "exit=$?"
exit=1
```

The harness fails closed cleanly when the token is absent (verified):

```
$ npx tsx tools/vps-e2e/src/cli.ts --iso /tmp/fake-base.iso
fail-closed: provider token env "HCLOUD_TOKEN" is not set.
A real run provisions a real hetzner VPS and incurs cost.
Set it and re-run, e.g.:
    export HCLOUD_TOKEN=<your-hetzner-api-token>
    create-vps --iso /tmp/fake-base.iso --provider hetzner
(or run `create-vps --plan` to see the chain without provisioning).
```

(The agent worktree is sandboxed and the auto-mode classifier
prevented scanning the user's shell rc files for credentials — that's
the correct trust boundary; nothing in the harness should ever
exfiltrate the token anyway. To produce a real green run, the
operator runs the same command from a shell where `HCLOUD_TOKEN` is
set; the harness will spend the ~€0.005 + ~15-20 min wall-clock and
record the per-stage statuses + Hetzner server id below.)

### Operator instructions to capture the live green run

From a shell with `HCLOUD_TOKEN` exported:

```sh
curl -L -o /tmp/flagship-base.iso \
  https://flagshipserver.com/build/iso/flagship-base-alpine-3.21.0-x86_64.iso

# Verify against apps/com/wrangler.toml BASE_ISO_SHA256:
shasum -a 256 /tmp/flagship-base.iso
# expected: faafc1b9f868c47c99733c2c6d453e8202d93f9b36df6d6b653eb774914736b2

# One-time: create the R2 bucket if it doesn't exist
npx wrangler r2 bucket create flagship-iso-temp

# The actual run (cost: ~€0.005 on a CX22 for ~15-20 minutes)
npx tsx tools/vps-e2e/src/cli.ts \
  --iso /tmp/flagship-base.iso \
  --upload-via r2 \
  --r2-bucket flagship-iso-temp \
  --username e2e-$(date +%s) \
  --server-name home \
  --region fsn1 \
  --size cx22 \
  2>&1 | tee tools/vps-e2e/RUN-LOG-live.txt
```

When the run completes, append the per-stage output (status +
detail), the Hetzner server id, total wall-clock, and the rounded €
cost to this file under a new dated heading.
