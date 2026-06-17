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

## Sequencing constraint (do not violate)

App "refuse to boot / halt" and box lockdown only ship AFTER 0a (live lease) +
0b (chain exposed). Shipping enforcement against today's expired lease bricks
every app and locks down every box immediately.
