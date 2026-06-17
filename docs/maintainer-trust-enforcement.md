# Maintainer-trust enforcement — apps + boxes actually verify the blessing

Status: **design locked 2026-06-16**, implementation in progress on branch
`feat/maintainer-trust` (flagship) + `feat/maintainer-trust` (maintainers).

## Why this exists

We built the whole maintainer→CA authority chain (`@ibisllc/maintainers`,
the `.com` chokepoint, the CaEndorsement lease) but **nothing at the edges
verifies it**. As of 2026-06-16 the live `.com` lease is *expired* (lapsed
2026-06-02) and the system runs fine — the blessing is decorative. This spec
makes the blessing load-bearing: clients refuse an unblessed `.com`, and boxes
refuse to be relayed by an unblessed `.services`.

The anchor is already baked: `MAINTAINER_PINNED_MANDATE_HASH`
(`packages/protocol/src/maintainerCa.ts`) = sha256 of the ca-track origin
mandate. Everything verifies forward from that pin.

## Trust model (the locked decisions)

- **Root of trust = the pinned ca-track mandate hash**, hardcoded into every
  surface (already in TS; to be mirrored into Swift/Kotlin and the daemon).
  Verifiers walk `pin → verifyMandateChainFromPin → authorizedCaKeys(now)` and
  require the key `.com`/`.services` actually serves to be in that set, live now.

- **Two failure classes, two cert-hash slugs:**
  - **Control-server blessing** — the maintainer→CA lease that authorizes
    `.com`'s hot CA key. Failure UI: `Control server certificate expired · <slug>`.
  - **Relay blessing** — `.com`'s CA-signature over the `.services` hub's own
    key (see below). Failure UI: `Relay certificate expired · <slug>`.

- **Apps: `isServerTrusted` + halt + override.** A single app-scope boolean is
  the foundation. While false, **all backend interaction is short-circuited**
  (not just the boot screen). Override is a deliberate, **biometric/passcode-
  gated** user action. Even after override, a **persistent alarming-red top
  sliver** stays pinned (a higher, red, non-dismissible variant of the
  `ActiveOperationsCenter`/`GlobalOperationsBar` push-down pattern). At most
  **one sliver line per failing cert**, slugged by cert-hash, deduped across
  all of a user's devices.

- **`.services` relay = fail-open dumb pipe.** It keeps serving its expired
  blessing and only ever carries encrypted, authenticated messages. It is
  content-blind; staying up just lets trust messages (SOS, exception grants,
  fresh blessings) flow. A rogue relay can at most *refuse* to carry messages →
  the box looks offline → owner investigates. No out-of-band SOS hardening
  beyond phone/box-key encryption+auth.

- **Box = fail-closed lockdown.** On a broken trust situation (control- or
  relay-blessing expired/invalid) with no valid owner exception, the box
  **stops serving and processing user traffic** and enters lockdown — but keeps
  a *minimal trust channel* up (to emit the SOS and receive the exception /
  fresh blessing; otherwise it could never recover). Lockdown ⇒ the box appears
  offline to users by construction (tunnel data plane down).

- **Recovery = owner-signed, per-cert exception.** Face/passphrase-gated,
  **signed by the granting phone's device key**, scoped to exactly one
  cert-hash, propagated via `.com` (it is safe to route through a possibly-rogue
  `.com` because it is device-key-signed and cert-hash-scoped — `.com` can drop
  or replay it but cannot forge it, and replaying "accept cert X" is harmless).
  Verified against the **IRK-anchored device set**, never a `.com`-asserted
  roster. One acceptance per cert, fleet-wide; the red sliver line persists
  after override so the degraded state stays visible.

- **SOS transport.** Box→phone SOS rides `.com`'s existing push/relay,
  end-to-end encrypted + authenticated with phone/box keys; `.com` is an
  untrusted carrier. Suppression is benign (box already locked down + appears
  offline → investigation). The box ALSO surfaces its untrusted state on any
  direct phone contact (box-detail, list refresh), so suppression only delays.

- **The accepted systemic risk.** Box-lockdown-on-control-blessing-expiry makes
  the maintainer's renewal a fleet-wide kill-switch-by-neglect: if the global
  maintainer→CA lease lapses, every box locks down at once. Tolerable only
  because the **owner exception** un-sticks a box with no maintainer dependency.
  Mitigations: generous lease duration, the ceremony app, renewal alerts.

## The relay blessing (`.services` self-keys, `.com` blesses daily)

1. `.services` generates its **own** keypair (persisted on the Fly app).
2. It asks `.com` to bless its pubkey; `.com` signs a short-lived
   `ServiceBlessing{ hubKeyPubkey, hubHost, nonce, issuedAt, expiresAt }` with
   the live hot CA key. Re-requested ~daily. Operator evicts a rogue Fly by
   telling `.com` to stop blessing → expires within a day.
3. The box's daemon verifies the blessing (`pin → chain → CA key authorized now
   → blessing not expired`) **before** connecting to the tunnel, and the hub
   presents it (or the box challenges it) so the box knows the relay it's
   talking to holds a `.com`-blessed key. Fail → lockdown + relay-class SOS.

New protocol artifact: `ServiceBlessing` + `verifyCaSignedServiceBlessing`
alongside `verifyCaSignedUserPubKeyBinding` in `packages/protocol/maintainerCa.ts`
(reuses the existing `CaTrustChain` injection).

## Phased work (see the tracked task list)

0. **Re-establish + expose the blessing (unblocks all).**
   - 0a *(owner, hardware)* run the backdated CA-endorsement ceremony — the
     `ca-endorsement --not-before/--issued-at` overrides now exist
     (`@ibisllc/maintainers` `feat/maintainer-trust`). Pristine-past:
     `--not-before 2026-06-02T22:40:29.858Z --issued-at <same> --duration 90d`,
     keeping the existing hot key `230ad9ed…`.
   - 0b *(code)* `GET /api/maintainer-blessing` on `.com` — returns the ca-track
     mandate chain + endorsement bundle + served CA pubkey so clients run the
     full pin→chain→authorizedCaKeys(now) check themselves.

1. **Shared verify primitive.** TS helper in `packages/protocol` + hand-mirrored
   Swift (`MaintainersTrust.swift`) and Kotlin ports, pinned by cross-platform
   vectors (mirror the `daemonStatus` pattern). Heaviest item.

2. **App boot gate.** `isServerTrusted` + halt-all-backend + biometric override
   + red persistent sliver, on iOS / Android / webapp. Offline = "no verdict
   yet" (do not brick on a network error; only on a *valid response that fails
   verification*).

3. **Box ↔ relay blessing.** `ServiceBlessing` envelope + verify; `.com` issuer
   endpoint; `.services` self-key + daily refresh; daemon pre-connect gate +
   lockdown + SOS + exception store; exception sync via `.com` directory.

4. **Ceremony app (deferred; iOS-native).** iPhone NFC drives PIV-Ed25519 over
   Core NFC ISO7816 (PIV AID `A000000308…`) — confirmed viable; needs a
   YubiKey 5 **NFC** fw≥5.7. Sequenced last, behind the enforcement that makes
   the blessing matter; the CLI covers ceremonies meanwhile. Canonical home =
   the maintainers repo (generic OSS app, spec §11–12 of
   `maintainer-ca-endorsement.md`). Optional keyless commit-writer Worker.

5. **Flip enforcement + ops.** `CA_ENDORSEMENT_ENFORCE=true` on `.com` once the
   ceremony is live + verifying clients are shipped; renewal alerts; runbook.

## MAJOR future workstream — direct LAN / box-AP channel

A physical-LAN or box-hosted Wi-Fi path between box and owner-phone when
physically close, giving a fully `.com`-independent channel for trust decisions
+ local admin. The clean long-term answer to the "forced through `.com`"
dilemma. Tracked separately; not required for the above.

## Integration status (2026-06-17)

The ceremony is LIVE (backdated 90d lease, `caPubkeyAuthorizedNow: true`,
`CA_ENDORSEMENT_ENFORCE=true`), and the three worker branches are merged into
`feat/maintainer-trust` (conflict-free):

- **Backend (mt-core):** `ServiceBlessing`/`TrustException` envelopes + verify,
  `verifyComBlessing`, authoritative cross-platform fixture
  (`packages/protocol/tests/fixtures/maintainerTrust.vectors.json`), `.com`
  `POST /api/services/hub-blessing` issuer + trust-exception sync endpoints +
  storage migration `0055`, and a PURE `shouldRelayThroughHub` daemon gate.
- **Webapp (mt-webapp):** browser-JS chain verify, `isServerTrusted` global
  fetch chokepoint, red push-down sliver, PIN-gated override → signed
  `TrustException`. Byte-identity cross-checked directly against the
  authoritative fixture.
- **Mobile (mt-mobile):** Swift + Kotlin `MaintainersTrust` ports
  (`authorizedCaKeys`/`verifyComBlessing`), iOS + Android trust gates (halt +
  red sliver + biometric override). Android 829 unit tests green; **iOS needs an
  Xcode build by the owner.**

Gates on the integrated branch: `npx tsc -b` clean · `npx vitest run` **5420
pass / 8 skip / 413 files**.

**Cross-platform reconciliation finding:** the surfaces emit *byte-identical*
canonical bytes (each port verified against `@ibisllc/maintainers`; the webapp
is additionally pinned to the authoritative fixture). The only divergence is the
internal `verifyComBlessing` *reason label* ("trusted"/"pin-mismatch" in TS vs
"ok"/"no-authorized-ca-keys" in the webapp) — the gating *verdict* and the
user-facing sliver (driven by verdict + certClass) agree. Unifying the reason
vocabulary + embedding the authoritative strings in the Swift/Kotlin vector
tests is a minor owner-verifiable hygiene follow-up, not a correctness gap.

**SUPERVISED — deliberately NOT in the workers (need careful live-tunnel
integration before they ship):** wire `shouldRelayThroughHub` into the daemon
tunnel pre-connect path + drive lockdown/SOS on failure; `.services` self-key
generation + daily blessing refresh + HELLO presentation; the box lockdown
runtime state machine. Per the sequencing constraint, these ship only after the
relay-blessing path is wired + tested end to end.

**Status flip already done:** `CA_ENDORSEMENT_ENFORCE=true` is live, so `.com`
itself refuses to sign without a live lease (task 5's `.com` half). The remaining
task-5 work is renewal alerts polish + the box-side lockdown wiring above.

## Sequencing constraint (do not violate)

App "refuse to boot / halt" and box lockdown only ship AFTER 0a (live lease) +
0b (chain exposed). Shipping enforcement against today's expired lease bricks
every app and locks down every box immediately.

## Live box↔relay wiring — what shipped + the enforce-flip rollout (task #5)

The box↔relay trust path is now wired end to end, but in **OBSERVE** mode —
the verify + lockdown/SOS MECHANISM is fully built and the enforcement is
gated behind a flag that is OFF by default, mirroring `CA_ENDORSEMENT_ENFORCE`.
There are real boxes on the live tunnel and **no box has a validated blessing
flow yet**, so fail-closed-by-default would brick the fleet.

### What's on the wire

- **HELLO_ACK** carries an optional `serviceBlessing` (the `.com`-CA-signed
  `ServiceBlessing` over the hub's own key) + `hubSig` (the hub's signature,
  with the blessed key, over the box's HELLO nonce — proof-of-possession,
  defeats blessing replay by a MITM). Both fields are OPTIONAL: an old hub
  omits them, an old box ignores them — fully backward-compatible frame.
- **`.services` hub** self-generates an Ed25519 key on boot (ephemeral-per-boot
  unless `FLAGSHIP_HUB_KEY_PATH` points at a mounted Fly volume), fetches a
  blessing from `.com POST /api/services/hub-blessing` and refreshes every ~12h
  (TTL ~26h). If it has no blessing yet (startup race / `.com` down) it omits
  it — OBSERVE-safe.
- **Box daemon** verifies on every HELLO_ACK: fetch the maintainer chain
  (`GET /api/maintainer-blessing`), build a `CaTrustChain` at the BAKED pin,
  run `shouldRelayThroughHub` (chain + TTL), verify `hubSig` over the box
  nonce. It emits a structured `[relay-trust]` log line. Chain fetch errors
  yield NO verdict (never bricks on a blip).

### The enforce flag

- **Env flag:** `FLAGSHIP_RELAY_TRUST_ENFORCE`. **Default OFF.** ON only for
  the exact string `"true"` (`relayTrustEnforceFromEnv`). Set on the box
  daemon's environment.
- **OBSERVE (default):** verify + structured-log the verdict; KEEP RELAYING
  regardless. `RelayLockdownController.isRelayAllowed()` is always `true`. No
  SOS. This is what deploying task #5 ships.
- **ENFORCE (`true`):** on a concrete `verified === false` verdict with no
  covering owner `TrustException` for the relay cert-hash, the box enters
  LOCKDOWN — `resolveBackend` returns null so new streams are refused (the WS /
  control channel stays UP so a fresh blessing or owner exception can lift it)
  — and emits an SOS via the owner-notify hook (log-only by default; production
  swaps in the `.com` push relay). A `verified === undefined` verdict (no
  blessing presented / chain unreachable) NEVER locks down, under either flag.
  A fresh valid blessing or a valid owner exception lifts lockdown.

### Live-validation steps BEFORE flipping `FLAGSHIP_RELAY_TRUST_ENFORCE=true`

Do these against the live fleet, in order; do NOT flip until all pass:

1. **`.com` lease is live.** `GET /api/maintainer-blessing` returns
   `caPubkeyAuthorizedNow: true` (the backdated CA-endorsement ceremony, task
   0a). If the lease has lapsed, EVERY box would lock down on flip.
2. **`.services` is serving a blessing.** After a `.services` deploy, confirm
   the hub log shows `relay-blessing refreshed expiresAt=… signedBy=…` and that
   the `signedBy` matches `.com`'s served `caPubkey`.
3. **Boxes are OBSERVING a PASS.** On real boxes (rebuilt daemon), confirm the
   journal shows `[relay-trust] verified=true reason=ok … mode=observe` on
   connect — across a daemon restart and a hub redeploy (re-blessed key). A
   single `verified=false` or persistent `chain-fetch-error` in the fleet means
   DO NOT flip.
4. **Soak.** Let the fleet run in OBSERVE for at least one full blessing-refresh
   cycle (>26h) so a near-expiry refresh is exercised; watch for spurious
   `artifact-expired` from clock skew or a missed refresh.
5. **Exception sync wired.** Before flip, wire `resolveTrustExceptions` on the
   box (read owner-signed relay `TrustException`s from `.com`'s directory +
   the IRK-anchored device roster) and validate the owner-exception recovery
   path on a test box: force a fail, confirm lockdown under ENFORCE, sign a
   relay `TrustException` on the phone, confirm the box lifts lockdown. Until
   this is wired a failing verdict under ENFORCE has no recovery but a fresh
   valid blessing.
6. **SOS transport.** Replace the log-only `sos` hook with the real STK-signed
   `flagship/push-relay/v1` fan-out (category trust-alert) and confirm the
   phone receives the SOS from a test lockdown.
7. **Flip on ONE box first.** Set `FLAGSHIP_RELAY_TRUST_ENFORCE=true` on a
   single canary box, exercise a real failure + recovery, THEN roll to the
   fleet. Keep the flag flippable (no redeploy needed to revert).

Rollback: unset / set the flag to anything but `"true"` and the box returns to
OBSERVE on the next read (the lockdown controller honors the flag at
construction; a daemon restart re-reads it).
