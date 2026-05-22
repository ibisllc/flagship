# Login & account model redesign — account-name-first access control

**Status:** plan. Supersedes the ad-hoc onboarding paths. Owner-driven
design (2026-05-22 session).

## The principle

The sign-in / join space is **access-control evaluation, not a web
fetch**. It reads *what credentials and factors are present for the
named account* and routes accordingly. A raw `404` in this space is a
category error — it means we wired login as "GET the envelope" instead
of a pre-flight decision. **Login must never surface an HTTP error for
a missing-state; every "absent" is a node in the decision tree.**

Three corollaries drive the whole redesign:

1. **An account is an identity, not a server.** Creating an account =
   reserve a username + bind it to a fresh device key + the user's
   crypto keys → the account opens. A *server* (pod) is a separate,
   later, possibly-plural resource. You can have zero servers, one, or
   many.
2. **"Join an existing account" is one account-name-first flow** that
   branches on `account_type`. "Takeover" and "backup" are outcomes of
   that one flow, not separate buttons.
3. **A demo account is just a special case of recovery, and its crypto
   checks are no-ops.** When a join targets a demo account (flagged in
   `demo_users`), **anyone who knows the username gets in** — no
   passkey, no TOTP, no IRK/grant signature verification (all skipped
   server-side). The username *is* the capability. The only protections
   are **obscurity** (demo accounts are hidden — never listed/advertised)
   and a **short TTL** (they're auto-deleted). This is by design: demo
   accounts are throwaway sandboxes for small teams to trial Flagship,
   and intentionally route around the security model
   (`v1.2-security-cascade.md:12-13`).
4. **The only thing you type is a username; every install is a new
   device.** The login/join field holds *only* a username — a person or
   company handle (e.g. `harry`, `hilton`), letters/digits, **no special
   characters and no dots**. You first attach to the *user key*; only
   *after* that cryptographic attachment does the device get a name or a
   scope. The stable device id `userkeyhash.devicekeyhash` is **derived,
   never typed**. Recovery is **not** a way to reclaim a past name or
   restore an old device — each install generates a fresh device key,
   even on the physically same phone. (This retires the typed
   `<user>.<label>` dot-form as a *login input*; addressing/labeling is a
   post-attachment, server-side concern.)
5. **You can never be locked out if you hold iCloud (or equivalent).** A
   full takeover produces an **`admin`** device whose authority reaches
   the entire user namespace and overrides any private/restricted scope
   any other device set. Credentials are the ultimate authority — no
   lock another device creates can survive a credentialed takeover.
6. **Everyone is addressed as a device, and every device has a human-
   readable name.** There is no separate "user" address — the user is
   the set of devices under the user key. Each device is `ukey.dkey` plus
   a friendly self-chosen name (e.g. "Harry's iPhone", "admin",
   "reviewer"). Naming happens at create (your first device) and at join
   (the new device, post-attachment).

## Account types & what's optional

| Type | 2FA | Cloud (iCloud) backup | Recovery means | Add a 2nd device |
|---|---|---|---|---|
| **single** | none | **optional** (opt-in) | **takeover after 7-day grace** (no "keep-both" — there's only one device) | enroll 2FA → becomes **multi**, then add |
| **multi** | **required** | optional | existing device vouches → **backup** (+14d quarantine), OR no working device → passkey + TOTP/recovery-code → **takeover after 24h grace** | existing device vouches + 14d quarantine |
| **demo** | none | n/a | type the username (crypto no-op) | type the username |

Invariants: `multi ⇒ totpEnrolled`. Cloud backup is independent and
opt-in for every type (`recovery.present`). With **no** cloud backup and
no working device, there is no cloud recovery path — that's the user's
informed choice (single) or recovery-codes-only (multi).

### Cross-device sets (collaborators, no shared iCloud)

Multi-device normally syncs the credential via a **shared iCloud**
(one person's iPhone + iPad). But you can run multi-device **without** a
shared iCloud — a **cross-device set** spanning ecosystems (a
collaborator's own iPhone/Android, their own Apple ID). This is the
**business-adding-collaborators** case. It still **requires 2FA**.

Because iCloud can't carry the credential across ecosystems, keys move
**out-of-band via QR**:

```
Admin phone:  Settings → Devices → Add device → shows a pairing QR
Incoming phone: scans the QR → it is the doorway that shares the keys
                → device attaches as a peer (BACKUP add) + 14-day quarantine
```

The QR both **proves the admin vouches** (you must physically scan the
admin's screen) and **transfers the key material** iCloud would
otherwise sync. So the multi-device "an existing device vouches" branch
has two carriers: **iCloud sync** (same ecosystem) or **scan the admin's
add-device QR** (cross-device). QR-payload + exact key-share crypto are a
Phase 3/4 design detail; the existing `QrRelayClient` is the transport
starting point. The scanned QR likely embeds the username, so the
incoming device may join *without typing* — scanning is an alternate
doorway to the typed-username entry, resolving to the same "attach this
device to that user key."

## What's wrong today (the five gaps)

| # | Gap | Evidence |
|---|---|---|
| 1 | Account identity is welded to server provisioning | iOS claim only fires in `mintInstallBlob()`/`confirmAndDeliver()` (`CreateServerViewModel.swift:149,193-199`); Android claim in `registerControlPlane()` post-QR (`CreateServerScreen.kt:482`); webapp claim inside `create-server.js:365`. ChooseUsername copy: "becomes the middle of your server's domain." |
| 2 | Join never asks for the account name | iOS `RecoverFromWelcomeContainer` runs `assertAny()` first (`:52-66`); Android only does same-device BlockStore restore (`RecoverFromWelcomeContainer.kt:90-91`). Webapp is the exception — it *does* ask username first (`bootstrap.js:32-41`). |
| 3 | Join is a naive fetch that 404s | iOS `fetchRecoveryEnvelope` throws `404 "no envelope"`; live Worker returns `404 "no recovery record"`. Surfaces as the "Couldn't recover account — HTTP 404" card. |
| 4 | None of the v1.2 access-control model is wired into login | `account_type`/TOTP/grace/quarantine exist server-side (`migrations/0028`, `totp.ts`) and in *settings* UIs, but grep of every login/onboarding client returns nothing. |
| 5 | Backup-vs-takeover is a post-hoc menu, not the decision | iOS `PostRecoveryChoiceScreen` shows only after a successful unwrap; `completeRecoveryPair` is a stub (`username:"recovered-user"`, empty pods, `Keystore.installUMK` TODO — `OnboardingFlow.swift:142-152`). |

Server building blocks that already exist (so most of this is client work):

- `handleUsernameClaim` — **standalone, idempotent, no server needed** (`usernameClaim.ts`).
- `GET /api/users/:u` → `accountType`, `totpEnrolledAt`.
- `GET /api/recovery/by-username/:u` → `{ present, credentialId, wrappedUmkHash, hasFetchTokenGate }` (200) / `404 "no recovery record"`.
- `POST /api/recovery/by-username/:u/fetch` → passphrase/fetchToken-gated ciphertext release.
- `GET /api/users/:u/devices` → trusted devices + `quarantineUntil`.
- `POST /api/users/:u/re-pair` (+ `/object`, `/complete`) → IRK rotation + grace.
- `POST /api/users/check` → demo `demoServer` + `deviceCapability` (dot-form).
- Demo: `demo_users` + `deviceCapabilityGrants` (anyone-can-join sandbox).

## The unified login decision tree

```
JOIN  →  enter username   (handle only — letters/digits, no dots)
            │
            ▼
   GET /api/account/resolve/<username>          ← single preflight; ALWAYS 200
            │   { exists, kind, recovery, totpEnrolled, trustedDeviceCount,
            │     demoServer?, graceModel }
            ▼
   switch (kind)
   ├─ "unknown"  → STATE: "No Flagship account by that name."   (not a 404)
   │
   ├─ "demo"     → SKIP all credentials → attach a NEW device → open account
   │                (DemoFixtures.activate + demoServer; default demo scopes;
   │                 device label/scope assigned post-attach, never typed)
   │
   ├─ "single"   → needs cloud backup (recovery.present); passkey-PRF unwrap
   │                → TAKEOVER: 7-day grace, alert the old device
   │                  → new device becomes `admin` (ukey.*)
   │                (no "keep-both" in single — enroll 2FA → "multi" to add a peer)
   │
   ├─ "multi"  (2FA mandatory)
   │                ├─ an existing device vouches → BACKUP add (keep-both) + 14d quarantine
   │                │     carrier: iCloud sync (same ecosystem) OR scan admin's
   │                │              add-device QR (cross-device collaborator)
   │                └─ no working device → passkey-PRF AND recovery-TOTP / recovery-code
   │                     (.com requires BOTH to mutate a device key on multi)
   │                     → 24h grace → TAKEOVER → becomes `admin` (ukey.*)
   │
   └─ recovery.present == false (single/multi, no working device)
                 → STATE (not a 404):
                    single → "No cloud backup. Use a device that still has access."
                    multi  → "Use another device, or one of your recovery codes."
```

`graceModel` (`"instant" | "7d" | "24h-totp" | "none"`) is derived
server-side so every client renders identical copy without re-deriving
the matrix.

## The `admin` label & the no-lockout guarantee

A **takeover** (the credential-proven branch, after its grace period)
doesn't just rotate the IRK — its new device is labeled **`admin`**:

- **Stable id** stays normal: `ukey.dkey` (the admin is one device under
  the user). *Reach*, not id, is what's special.
- **Reach = `ukey.*`** — the whole user namespace. An admin can
  **override any private/restricted scope on any resource** another
  device set. No device-set lock survives a credentialed takeover.
- This is the operational form of W1 ("credentials are the sole gate",
  `v1.2-security-cascade.md:149-176`): the grace period is the only
  brake; once it elapses the takeover is inevitable AND total.
- **Guarantee:** you can always recover → take over → become admin →
  override everything, so you're **never permanently locked out** — with
  one tier difference: **single** needs iCloud (or equivalent) **alone**;
  **multi** needs iCloud **+ the recovery TOTP** (or a recovery code).
  The second factor is the price of multi's stronger model (it's what
  defeats an iCloud-only attacker).

## Recovery TOTP (multi-device second factor)

On a **multi-device** account the **.com server gates the device-key
mutation** — the old→new device-key re-pair that recovery/takeover
performs — on **two** proofs, not one:

1. **Platform recovery** of the user key (Apple/Android passkey-PRF
   unwrap of the cloud-stored UMK), AND
2. a valid **recovery TOTP** proof (or a single-use recovery code).

Neither alone is accepted. The **TOTP seed is issued at initial join**
(shown once; the user stores it on paper or in an authenticator app) —
deliberately *out of Apple's/Google's reach*, so an iCloud-only
compromise cannot complete a device-key mutation on a multi account
(`v1.2-security-cascade.md` "Defense vs iCloud-only compromise").

Server-side this is the existing re-pair gate: `RePairInitiate.totpProof`
is **required when `account_type === 'multi'`**, validated alongside the
IRK signature before the CAS swap. Design detail for Phase 3: whether the
recovery TOTP is account-level (one secret) or per-device, and exactly
when the seed is surfaced at join.

Interaction with the 14-day quarantine: quarantine constrains a device
*added by vouching* (backup), to blunt a stolen-device-piles-on attack.
A takeover-`admin` is **not** quarantined — the grace period was its
anti-abuse brake, so post-grace it has full reach immediately.

Details to nail in Phase 3/4: whether a takeover demotes previously-
existing devices' admin status (single-admin vs multi-admin), and the
exact resource-scope override check site (daemon + Worker + UI).

## The keystone: a consolidated preflight endpoint

**New:** `GET /api/account/resolve/<username>` — `<username>` is a bare
handle (letters/digits, no dots). Returns **200 always**; existence and
every factor are *fields*, not status codes. Aggregates `demo_users`
(checked first) → `users.account_type` → `webauthn_recovery` presence →
`paired_sessions`/devices count. Rate-limited like `/api/users/check`.

It does **not** carry a per-device capability: at preflight time the
joining device key doesn't exist yet, so scope/label is resolved
*during* attachment (see "Open decisions" — grant→device-key binding),
not returned here.

Shared response type (mirrored in TS / Swift / Kotlin / webapp per the
lockstep rule and the iOS-Mock-matches-Worker-wire invariant):

```ts
interface AccountResolution {
  username: string;             // normalized handle
  exists: boolean;
  kind: "demo" | "single" | "multi" | "unknown";
  recovery: { present: boolean; hasFetchGate: boolean; credentialId?: string };
  totpEnrolled: boolean;
  trustedDeviceCount: number;
  demoServer?: DemoServerBlock;              // demo accounts
  graceModel: "instant" | "7d" | "24h-totp" | "none";
}
```

> **Enumeration note.** This is a username-existence + account-type
> oracle. Existence is already exposed by `/api/users/check`; the new
> fields (account_type, recovery-presence) are mildly more sensitive.
> For **demo** accounts the username *is* the access capability, so a
> correct lookup returning `kind:"demo"` is by-design — the protection
> there is name obscurity + short TTL, not the resolve endpoint.
> Mitigation: reuse the existing per-IP + per-username-hash rate-limit
> buckets to make brute-forcing demo names impractical, and return
> `kind:"unknown"` with zeroed factors for non-existent names so
> timing/shape don't distinguish a miss. Acceptable because the threat
> model already treats real usernames as semi-public (DNS labels) and
> demo accounts as throwaway.

## Phased plan

Each phase ends green (`vitest` + `tsc -b` + iOS XCTest + Android
Gradle), commits, and pushes. Phases are sequenced so the **cheapest,
highest-value slice (demo join + never-404) lands first** and doesn't
depend on the still-Mock live WebAuthn providers.

### Phase 0 — Preflight primitive + shared types (server + protocol)

- `packages/control-plane/src/accountResolve.ts`: `handleAccountResolve`
  aggregating the sources above; `demo_users` first, then `users`.
- Wire route `ACCOUNT_RESOLVE: /^\/api\/account\/resolve\/([^/]+)$/` in
  `apps/com/src/controlPlaneRoutes.ts` + a rate-limit bucket.
- Shared `AccountResolution` + `graceModel` derivation in
  `@flagship/protocol` (or control-plane shared types).
- Tests: vitest covering unknown / demo / single(no-recovery) /
  single(with-recovery, device / no-device) / multi.
- **No client changes yet.** Acceptance: live `curl` of each kind.

### Phase 1 — Demo = special-case recovery (the first user-visible win)

Re-route demo join from the *create* path into the *join* path; no live
WebAuthn needed.

- iOS: new `LoginViewModel` (username input → `accountResolve` →
  branch). Demo branch generates a fresh device key, attaches to the
  user key, and activates the sandbox via `DemoFixtures.activate(...)`
  with the `demoServer` block. Replace the `assertAny`-first
  `RecoverFromWelcomeContainer` entry with the username screen.
- Android: same shape; demo branch reuses `DemoFixtures.activate`.
- Webapp: extend `bootstrap.js` recover → call `accountResolve`; demo
  branch activates the profile without the recovery popup.
- Remove demo/`deviceCapability` activation from `ChooseUsername*`
  (create path becomes create-only) and drop the typed dot-form entirely.
  Typing a bare demo **username** under **Join** is the only demo entry.
- Mock clients return `AccountResolution` matching the Worker wire.
- Acceptance: in-simulator, "I already have an account" → type a demo
  username → land in the sandbox as a freshly-attached device; **no 404
  anywhere**.

### Phase 2 — Decouple account creation from server provisioning

- Extract **open-account** from server-mint on all three:
  - generate UMK + IRK, call standalone `claimUsername`, bind device,
    `completeOnboarding(pods: [])`.
  - iOS: pull the claim out of `mintInstallBlob`; Android: split
    `registerControlPlane`; webapp: split `wizard` step 2 from step 5.
- New **serverless Home empty-state**: "Your account is ready — add your
  first server." `CreateServer*` becomes a reusable **Add a server**
  flow (1st or Nth), reachable from Home and from create-success.
- `ChooseUsername` copy: identity-first, not "your server's domain."
- Acceptance: create an account, land on Home with zero servers, then
  add one (and a second) from Home. Claim is idempotent on retry.

### Phase 3 — Real-account login state machine (single/multi branches)

- Replace the recovery containers with the `LoginViewModel` branches for
  `single`/`multi`: account-name → preflight → passkey-PRF unwrap →
  (multi) TOTP/recovery-code → backup-vs-takeover driven by
  `trustedDeviceCount` + `graceModel`.
- Every absent factor renders a **state**, not an error card.
- Wire `Keystore.installUMK(seed:)` so `completeRecoveryPair` stops
  being a stub; resolve the real username from preflight (kill the
  `"recovered-user"` placeholder).
- Android: finally implement **cross-device** recovery (today it only
  restores from local BlockStore).
- **Multi-device recovery TOTP gate:** the `multi` takeover branch must
  collect the recovery TOTP (or a recovery code) and the Worker re-pair
  must enforce `totpProof` required when `account_type === 'multi'`
  before the device-key CAS swap. Surface the **seed at join** (shown
  once; "store on paper / in an authenticator app").
- **Cross-device add (collaborators):** admin **Settings → Devices → Add
  device** generates a pairing QR; the incoming phone scans it to receive
  the key material out-of-band and attach as a peer (BACKUP + 14d
  quarantine). Reuse/extend `QrRelayClient`. Both surfaces (admin
  generator + incoming scanner) on iOS/Android; webapp at least the
  scanner + a desktop-shown QR.
- Acceptance (Mock WebAuthn): each branch reaches the correct outcome;
  conformance tests assert identical branching across iOS/Android/webapp.

### Phase 4 — Grace-period takeover UX + notifications

- Wire `/api/re-pair` initiate→`complete()` polling into the takeover
  branch (the VMs have `complete()` but it's not in any UI). Surface
  "this device takes over in N days; your other devices are alerted."
- Render the 7-day (single) / 24h+TOTP (multi) timeline; consume the
  T+0/+1d/+3d/+6d/urgent push alerts already fanned out server-side.
- Surface the 14-day **quarantine** on the newly-added device.
- Acceptance: a single-device account recovery shows the 7-day timeline;
  push alerts deep-link to the audit view.

### Phase 5 — Never-404 audit + parity hardening

- Sweep every login/onboarding network call; convert any error-shaped
  "absent" into a rendered state. Mock parity with the Worker wire.
- Cross-platform conformance tests on the full decision matrix.

## Recommended sequencing

**Phase 0 → Phase 1 first.** Together they fix the exact pain that
started this (testers can't join; raw 404), prove the account-name-first
+ preflight + never-404 architecture end-to-end on the easy path, and
need no live WebAuthn. Phases 2–4 are heavier and partly gated on the
live `WebAuthnProvider` wrappers (still Mock on all platforms).

## Decisions (locked 2026-05-22)

- **Login input is a bare username** (handle only, no dots). The typed
  `<user>.<label>` dot-form is retired from login. Device label/scope is
  a post-attachment concern; stable id `userkeyhash.devicekeyhash` is
  derived, never typed.
- **Each install is a new device.** No device-restore; recovery never
  reclaims a past name — it attaches a fresh device key to an existing
  user key once credentials prove control.
- **Fast "backup" requires an existing device to vouch.** Credential-only
  joins fall through to takeover-with-grace (matches the v1.2 matrix + W1).
- **Preflight returns `200 + kind:"unknown"`** for non-existent accounts
  (rate-limited, zeroed factors) — login never 404s.

- **Demo crypto is a no-op; the username is the capability.** Knowing
  the demo username = entry. No grant→device-key matching, no signature
  verification on a demo join — the server accepts the freshly-attached
  device because the account is flagged demo. Operator-minted scoped
  grants are NOT part of the demo trial entry path (they belong to the
  real corporate per-device-scope story, v2). Protection = obscurity +
  short TTL.

## No open decisions remain

All forks are locked. Real corporate per-device scoping (grants bound to
device keys) is explicitly deferred to v2 and is out of scope here.

## Dependencies / risks

- **Live WebAuthn providers** are still Mock on iOS + Android (per
  `project-v11-security-shipped`). Phases 1 (demo) and the Mock-driven
  tests are unaffected; Phases 3–4 real-credential branches need the
  `ASAuthorizationController` / `CredentialManager` wrappers for
  on-device exercise.
- Three surfaces must move in lockstep (iOS, Android, webapp) per repo
  convention; each phase budgets all three.
