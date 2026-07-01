# Device admin entitlements + "add a server" simplification

Status: **locked design** (2026-06-30). Slices A–C are cleared to build; Slice D
(the admin tier) is spec-first and mostly *wires existing pieces*. This file is
the source of truth for this work; update it as slices land.

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
via their device grant. `requireDeviceScope()`
(`deviceCapabilityGrants.ts:345`) is the enforcement point; the current
"signer == IRK → allow" fast path (`:358`) is what must be tightened so that the
IRK it trusts is the *admin-only* master IRK, not a UMK-derived one every device
holds.

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
| **C. Take-over via camera / deep link + tiered confirm** | Encode the (IRK-signed) transfer offer as a **universal-link QR** — `base64url(JSON)` in the URL **fragment**, so the signature is preserved byte-for-byte and `.com` never sees it. The native Camera app opens it → routes through `DeepLink`/`ProcessUrlScreen` → a **severe** confirmation sheet (danger color + type-to-confirm + biometric) → the existing `TransferAcquirerViewModel` (unchanged backend). | No |
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
