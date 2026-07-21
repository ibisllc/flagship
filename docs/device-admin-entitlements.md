# Device admin entitlements + "add a server" simplification

Status: Slices A–C are **cleared to build**; Slice D (the admin tier) is
**UNSOUND as written — do not build until redesigned** (see "Review outcome"
below). This file is the source of truth for this work; update it as slices land.

## ⚠️ Review outcome (2026-06-30)

A multi-agent adversarial review found the Slice-D design **not safe to commit
to as written**. The three blockers:

1. **Box-side enforcement is unwired.** ~15 daemon consumers in
   `packages/server-daemon/src` (`selfDeleteConsumer.ts`, `decommissionConsumer.ts`,
   `deadManHttp.ts`, `frontPage.ts`, membership, the deposit consumers) verify
   every destructive order against **one config-pinned owner IRK that *is*
   `deriveIRK(UMK)`** — with zero `DeviceCapabilityGrant`/admin awareness. The
   doc pointed only at `.com`'s `requireDeviceScope` fast path; tightening it
   does nothing for box-side wipe/decommission/power/front-page.
2. **`users.irk_pub_hex` *is* the UMK-derived key** (`keys.ts`, info
   `flagship.irk.v1`), so "admin = a master IRK not derived from the UMK" is
   self-contradictory: reuse it → still UMK-derivable → any non-admin recomputes
   it (split void); or rotate to a fresh random key → **breaks every deployed
   box's pinned owner IRK and the LUKS disk seal** → a fleet-wide root rotation +
   disk re-seal + reburn + golden-vector regeneration. Not "mostly wiring." The
   `per-user-cert-worklist:61` "sealed, not UMK-derived" quote was about the
   **ACME account key**, not the IRK — a miscite.
3. **Anti-theft / recovery / fork-detection break against reality.** Recovery
   adopts `.com`'s reported `newIrkPub` with no signature proof
   (`rePairWatcher.ts`) — `.com` must never be a trust anchor — and lags a ~5-min
   poll; the 14-day quarantine only limits *newly-admitted* devices, so a stolen
   *active* admin keeps full flat revoke power; and fork detection compares the
   account root (reconstituted identically from a UMK backup), so it never fires.
   Residual UMK-derived keys (SWK/CGK/BAK) also hand a non-admin service-platform
   key custody, undercutting the clean membership-vs-authority line.

**Corrected direction for D (when we build it):** keep `IRK = HKDF(UMK)`; express
admin as the already-shipped **`admin` `DeviceScope`** + custody of the sealed
**ACME account key** (not a new master-IRK envelope); make **box-side** sensitive-op
verification (a shared `requireMasterIrk`/scope predicate across daemon + `.com`)
the enforcement surface, guarded by a CI grep-gate; relay a **cryptographic
rotation proof** the box verifies (old-root-signs-new-root) instead of trusting
`.com`; and own an explicit migration (root rotation *as* an IRK rotation over the
transfer re-home rail, per-box ack + grace, LUKS re-seal, vector regeneration).
This is a real workstream, not a wiring change — it needs its own spec pass before
code. **Slices A/B/C below do not depend on D** and ride the shipped shared IRK.

**Build-ordering hazard (A vs C):** on **Android and webapp** the add-server
chooser is the *only* entry to the transfer-claim (acquirer) path, so **Slice A
removal there must land *after* Slice C** provides a standalone deep-link/camera
claim entry. (iOS is safe — its acquirer was never wired, so A orphaned nothing.)

## D decisions (2026-07-01) — owner-set

The owner resolved the four D forks. These make D buildable (they dissolve the
migration blocker) but D is still **deferred to its own dedicated spec pass**
after A/B/C:

1. **Clean-slate, not a migration.** We are pre-release and **may wipe all
   servers/accounts and start fresh**. So D is **not** a retroactive fleet
   rotation — instead, fresh burns bake in an **admin root that is NOT derived
   from the UMK** from day one. No dual-accept grace, no per-box ack, no LUKS
   re-seal-in-place: a wipe + reburn establishes the real boundary cleanly. This
   removes the review's single biggest blocker.
2. **Non-admin = full user minus admin ops.** Non-admins use every app/service
   (SWK/CGK stay UMK-derived — accepted); only **administrative/destructive** ops
   are gated: transfer-give, wipe, decommission, replace, promote-a-device,
   set-front-page, set-leader, revoke. The boundary is about *authority*, not
   data access.
3. **Flat revocation; recovery is the remedy.** No seniority/quorum. A stolen
   *active* admin is stopped only by credential recovery — which D must fix to
   relay a **cryptographic rotation proof** the box verifies (old-root-signs-new-
   root), not `.com`'s reported key.
4. **Timing:** build D **after A/B/C** land, as its own spec'd box-side +
   enforcement workstream (one shared `requireMasterIrk`/scope predicate across
   the daemon + `.com`, guarded by a CI grep-gate).

## Why

The iOS "Add a server" screen offered three cards — *Provision a new box*,
*Pair an existing box*, *Take over a transferred box* — of which only the first
did anything (pair was a toast, take-over a dead no-op). More fundamentally, the
three cards conflate three different verbs under one noun:

- **Provision** = create a brand-new box (a multi-step flow, not an ingestion).
- **Pair** = let another of *your own* devices control a box you already own
  (device scope; no ownership change).
- **Take over** = receive *someone else's* running box (ownership change; new
  keys; disk re-seal).

Only "provision" is really "add a server". Pairing should be automatic (every
control device already sees every server), and take-over is a QR/link ingestion
that belongs in the universal "process a link or code" path, not a top-level
menu item.

## The model

### Membership vs. authority (the core split)

- **UMK (account key) = membership + data + use.** Every device that is *in*
  the cloud holds the UMK, can decrypt account data, and can *use* every app and
  box. "Everyone is a full user." Unchanged from today. The UMK is what a backup
  restores.
- **Master IRK = admin authority.** The master signing key is **sealed only to
  admin devices — NOT derived from the UMK.** This is the one real change: today
  `IRK = HKDF(UMK, …)`, so every device that holds the UMK is implicitly an
  admin. Separating the master IRK from the UMK is what makes "non-admin"
  enforceable. (This was already the conclusion of
  `per-user-cert-worklist.md:61`: *"admin-held (sealed per admin device), NOT
  UMK-derived — UMK-derivation would hand it to every device including
  non-admins."*)
- **Per-device IRK = device identity.** Each physical device mints its own
  device keypair (v2 device-addressing). Never shipped in a backup — regenerated
  on restore, which is what makes fork detection possible (see below).

### Admin = holds the master IRK (flat)

- **Admin** = a device that holds the sealed master IRK. Admins are equal, with
  **no expiry**. The master IRK pubkey (`users.irk_pub_hex`) is already the
  account root pinned everywhere, so admin-signed grants are unforgeable by the
  server (it lacks the key) — no separate root anchor or delegation chain is
  needed.
- **Promote** = an existing admin seals the master IRK to the target device.
- **Non-admin member** = holds the UMK (data + use) + its own device IRK + an
  admin-signed `DeviceCapabilityGrant` scoping what it may do (`browse`,
  `install-service`, `vibe-code`, …). It does **not** hold the master IRK, so it
  **cannot sign security-sensitive orders**.
- **First device** is admin by default (it created the cloud and holds the
  master IRK).

We chose **flat** over a first-device-rooted delegation chain: the chain would
add real machinery (chain verification, down-the-tree revocation, root-recovery
semantics) to defend one narrow case (a stolen *junior* admin) that credential
recovery already covers, and it diverges from the documented
"credentials-are-the-gate" doctrine (`v1.2-security-cascade.md:172`).

### Sensitive-op enforcement

Security-sensitive orders — transfer-give, replace/decommission, wipe, promote a
device to admin, set-front-page, set-leader, revoke — require a **master-IRK
signature**. The box/`.com` must stop treating a bare UMK-derived signature as
owner authority for these ops; only the sealed master IRK counts. Non-sensitive
actions (browse, use apps, pair-for-use, build) remain available to all members
via their device grant. **Correction (per review):** the enforcement surface is
**box-side**, not just `.com`. `.com`'s `requireDeviceScope()`
(`deviceCapabilityGrants.ts:345`) is one point, but the destructive ops execute in
the daemon (`selfDeleteConsumer`, `decommissionConsumer`, `deadManHttp`,
`frontPage`, membership, the deposit consumers), each pinning a single owner IRK
with no grant awareness. D must introduce **one shared `requireMasterIrk`/scope
predicate** both runtimes call, mark sensitive `DeviceScope`s so the grant branch
hard-denies them, and add a CI grep-gate that fails if a sensitive handler verifies
against anything but that predicate. The "`signer == IRK → allow`" fast path
(`:358`) isn't "loose" — its defect is that the trusted root is UMK-derived.

## Anti-theft, revocation, recovery — mostly already shipped

The defenses the personal-cloud already ships map directly onto this model:

- **New-device quarantine (14 days) — the "don't let a new device lock me out"
  defense** (`v1.2-security-cascade.md:248`, `rePair.ts:301`). A newly-admitted
  device **cannot revoke anyone for 14 days**; existing devices can revoke *it*
  immediately. A promoted/admitted admin inherits this: no revoke power during
  quarantine. This is exactly the "thief with one device can't purge the others"
  protection.
- **Re-pair grace** — 3 days (single-device) / 24 h (multi-device + 2FA), with a
  push-alert timeline (T+0 / 1d / 3d / 6d / 7d).
- **Fork detection = Recovery Phase B.** On restore, the device compares its
  **recovered IRK vs. the registered IRK**. Match → instant pair. **Mismatch →
  the original is still alive** → 3-day re-pair grace + push alarm to every
  device ("a new device is taking over"). This *is* the answer to "someone
  hydrated a backup of a still-active device": alarm + grace, and the restoring
  device proposes a fresh key. Backend deployed; iOS/Android wiring of
  `recoveredKeyMatchesRegistered()` is the open piece.
- **Credential recovery = ultimate authority** (`login-and-account-redesign.md:49`,
  `v1.2-security-cascade.md:151`). Rotates the master IRK, invalidating a stolen
  device's signatures. This is the backstop for a stolen *active* admin device —
  consistent with the doctrine that device-theft and credential-theft are
  correlated, so the credential (not another device) is the gate.

### Revocation

- **Flat.** Any admin may revoke any device, subject to the 14-day quarantine on
  the *actor* if newly admitted. No seniority.
- **No expiry** on admin authority — revocation is the only removal path (plus
  credential recovery, which rotates the master IRK and drops everyone).
- If a determined attacker holds a genuine, unlocked admin device (passcode +
  biometric), revocation of *them* is best-effort; credential recovery is the
  real remedy. That trade-off is accepted.

### Recovery / losing admins

- **Lose the first admin, keep another** → the surviving admin is fully
  capable (all admins share the master IRK). Nothing special needed.
- **Lose all admin *devices* but keep the recovery credential** → recoverable
  (credential re-establishes/rotates the master IRK).
- **Lose all admins *and* the recovery credential** → the cloud is
  unrecoverable; the name stays reserved-but-unusable
  (`naming-recovery-and-name-change.md:258`). Accepted.

### Backups

- Back up the **UMK + credential-wrapped master IRK** (for admin devices).
- **Do not** ship the per-device identity key in a backup — regenerate it on
  each restore. Otherwise two live devices share a key (can't be told apart,
  targeted for revocation, or fork-detected). Regenerating per-device keys is
  what makes the registered-vs-recovered alarm work.

## UX slices

| Slice | Scope | Depends on D? |
|---|---|---|
| **A. Kill the chooser** | "Add a server" flows straight into create; remove the pair/take-over cards + the `AddServerChooserScreen`. | No |
| **B. Auto-pair** | A device self-provisions its per-box BFF session token for every pod it can see (one biometric, background). Remove the manual "Pair this device" requirement. Pairing-for-use is not sensitive, so it's admin-independent. | No |
| **C. Take-over via camera / deep link + tiered confirm** | Encode the (IRK-signed) transfer offer as a **universal-link QR** — `base64url(JSON)` in a **query param** (`o=`), NOT the `#fragment` (Android/webapp strip it); the offer is a signed non-secret, so `.com` seeing it is acceptable. The native Camera opens it → routes through `DeepLink`/`ProcessUrlScreen` → a **severe** confirmation sheet (danger color + type-to-confirm + biometric) → the existing `TransferAcquirerViewModel`. **The acquirer MUST verify the offer signature vs `giverIrkPub` + expiry BEFORE the claim biometric** — a deep-linked/scanned offer is attacker-supplied. Backend unchanged. | No |
| **D. Admin/entitlement tier** | Separate the master IRK from the UMK; adopt v2 per-device grants + an `admin` scope; gate sensitive ops on the master IRK; **reuse** the shipped quarantine, re-pair grace, fork detection, and credential recovery. No-expiry, flat authority. | — |

A, B, C do not depend on D. D layers admin-gating onto the sensitive ops
(including gating who may *initiate* a transfer-give from C). Slices are iOS-first
with Android/webapp parity as a follow-up.

### Tiered confirmation (built in C, reused everywhere)

One reusable sheet with two tiers, assembled from existing idioms:

- **Benign** (invite / knock / access — already lightweight): a colored callout
  ("here's what this grants you") + a single biometric button.
- **Severe** (transfer take-over, replace, wipe): danger color + **type-to-confirm**
  (reusing the AccountDeletion / TransferGiver "type the domain" pattern) +
  biometric.

Load-bearing rule — **what you see is what you sign**: the displayed effects must
be derived from the *same parsed bytes* the master/device key signs. No gap
between the preview and the signed payload. (Consistent with the repo's
"consent is load-bearing crypto" principle.)

## Related specs

- `v2-device-addressing-and-real-ticket.md` — per-device IRK + `DeviceCapabilityGrant` + scopes.
- `v1.2-security-cascade.md` — quarantine, re-pair grace, credentials-are-the-gate.
- `per-user-cert-worklist.md` — "admin-held, sealed per admin device, not UMK-derived".
- `naming-recovery-and-name-change.md` — credential-only recovery; lose-everything semantics.
- `multi-device.md`, `revocation-ui.md` — device revocation actions.
- `recipe-delivery-and-remote-install.md`, `account-deletion-and-name-reclaim.md` §4 — transfer-a-box mechanics.
