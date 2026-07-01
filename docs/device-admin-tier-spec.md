# Slice D — device admin / entitlement tier (implementation spec)

## Locked decisions (owner, 2026-07-01) — these OVERRIDE any conflicting default below

The four open questions this spec flagged are now resolved:

- **D-1 — admin-root delivery:** the account's `admin_root_pub_hex` rides **inside
  the signed `AuthCode`** (signature-covered + registration-gated, like
  `ownerAidPubHex`), NOT loose on the `InstallBlob`. ✅ as the spec drafted.
- **D-2 — service-collaborator membership is SENSITIVE (admin-only).** OVERRIDE:
  the spec drafted `membership.ts` invite/mutation as a non-sensitive full-user
  capability; the owner ruled it **admin-gated**. Move those rows (server-daemon
  `membership.ts:72,140` and the matching `.com` grant-issuance rows) into the
  SENSITIVE set behind `requireMasterAdmin`. Only *reading* membership stays
  non-sensitive. (Non-admins can still USE a service; they just can't change who
  else may access it.)
- **D-3 — escrow the admin root under the WebAuthn-PRF recovery credential.** ✅
  Credential recovery can mint a new admin root and sign the `admin-root-rotation/v1`
  proof, so losing every admin device is still recoverable. Implication recorded:
  whoever holds the recovery credential effectively holds admin.
- **D-4 — promote-at-add-time is ASSURANCE-GATED.** "Also make this device an
  admin" is offered ONLY on high-assurance joins, never low-assurance ones, and
  is **default-OFF** with a hard warning ("this device will be able to wipe /
  transfer / decommission your cloud") wherever shown.

### D-4 — the join user-stories, classified by assurance

| # | User story | Path | Assurance | Offer promote-at-add? |
|---|---|---|---|---|
| 1 | Owner adds their OWN 2nd device | Phase 3b cross-device QR: admin mints QR → new device scans → SAS match → `DeviceAdmit` (`AddDeviceViewModel`) | **HIGH** (admin-initiated, synchronous, SAS-confirmed) | **Yes** (default-off + warning) |
| 2 | Owner adds another PERSON present with them | same QR+SAS ceremony, different human's device | **HIGH channel**, but grants a *different person* admin | **Yes** (default-off + stronger warning) |
| 3 | Remote / async "request to join" the owner approves later | any approval path with no synchronous SAS ("someone tried to log into our cloud and we approve") | **LOW** | **No** — device starts non-admin; promotion is a separate explicit action |
| 4 | Owner recovers onto a new device | WebAuthn-PRF credential recovery; admin root is escrowed under the credential (D-3) | **HIGH** (credential-proven) | device re-establishes admin from the escrowed root |

**Discriminator to implement:** the promote-at-add toggle appears ONLY in the
synchronous admin-initiated SAS ceremony (`AddDeviceViewModel`, stories 1–2) and
the credential-recovery path (story 4); it is never offered on an async
approve-a-request join (story 3). Default OFF everywhere.

---

Status: **spec only, not yet built.** This is the dedicated spec pass the
`docs/device-admin-entitlements.md` review (§"⚠️ Review outcome (2026-06-30)")
demanded before any D code lands. It honors the owner-set "D decisions
(2026-07-01)" exactly:

- `IRK = HKDF(UMK)` stays the **membership** root — every device derives it and
  keeps using it for `add-paired-session` pairing, deposits, and USERKEYHASH
  addressing. **Unchanged.**
- A **separate admin master root** (a fresh random Ed25519 keypair minted at
  account creation, held only by admin devices, NOT UMK-derived) becomes the
  **authority** root. Only administrative/destructive ops verify against it.
- **Clean-slate:** we are pre-release; we wipe + reburn. No retroactive
  migration, no dual-accept grace, no in-place LUKS re-seal — fresh burns pin
  BOTH roots from day one.
- Non-admin = full user minus admin/destructive ops. SWK/CGK stay UMK-derived
  (accepted). Only admin ops are gated.
- Flat revocation (no seniority/quorum); credential recovery is the remedy, via
  a cryptographic rotation proof the box verifies.

Cross-refs: `device-admin-entitlements.md` (the model + slices A/B/C),
`v2-device-addressing-and-real-ticket.md` (the `DeviceCapabilityGrant` +
`admin` scope, already shipped), `v1.2-security-cascade.md` (quarantine,
credentials-are-the-gate), `per-user-cert-worklist.md` (admin-held sealed key
precedent).

---

## 1. Key model — two roots

### 1.1 The split

| Root | Derivation | Held by | Purpose | Pinned as |
|---|---|---|---|---|
| **Membership IRK** | `HKDF(UMK, "flagship.irk.v1")` — `packages/protocol/src/keys.ts:7,28-38` (`deriveIRK`) | **Every** device (derivable from the UMK a backup restores) | Pairing (`add-paired-session`), deposits, USERKEYHASH addressing, app membership, "use everything" | `usernames.irk_pub_hex` (`migrations/0001_initial.sql:3`); box `ServerConfig.irkPublicKey` (`server-daemon/src/config.ts:8`) |
| **Admin master root** | Fresh **random** Ed25519 keypair at **account creation** (NOT UMK-derived) | **Admin devices only** (sealed per admin device to `.deviceLocal` keychain) | Signs sensitive/destructive orders; signs `admin`-scope device grants | NEW `usernames.admin_root_pub_hex`; box NEW `ServerConfig.adminRootPub` |

The membership IRK stays exactly what it is today. Because it is UMK-derivable,
every device that holds the UMK can recompute it — which is precisely why it can
**not** be the authority root (any non-admin recomputes it). The admin master
root is the one new secret; it is never derived from the UMK, never shipped in a
backup as a UMK derivation, and is sealed device-local to each admin device.

### 1.2 Where the master root is generated, sealed, pinned

- **Generated** on the **first device** at account creation, immediately after
  UMK generation:
  - iOS: `apps/mobile/ios/Sources/Flagship/Keystore.swift` (`generateUMK` /
    `installUMK`, lines ~131-150) — add `generateAdminRoot()` alongside.
  - Android: `.../app/keystore/Keystore.kt` (`generateUMK`, line ~157) — add
    `generateAdminRoot()`.
  - Webapp: `apps/web/public/webapp/keystore.js` (IRK derivation at line ~240)
    + `apps/web/public/webapp/lib/openAccount.js` (`openAccount`, lines ~89-118).
- **Sealed** device-local (NOT iCloud-synced, unlike the membership account key):
  iOS Keychain without `kSecAttrSynchronizable`; Android EncryptedSharedPreferences
  / StrongBox; webapp non-exportable IndexedDB CryptoKey. This is the
  "sealed per admin device" custody the cert worklist already assumes
  (`per-user-cert-worklist.md:61`). Contrast the membership account key, which
  IS synced — that's the membership-vs-authority line in custody terms.
- **Pinned** at two anchors, both written at account-creation / burn time:
  1. `.com`: `usernames.admin_root_pub_hex`, set at `handleUsernameClaim`
     (`control-plane/src/usernameClaim.ts:102-107`, next to `irk_pub_hex`).
  2. Box: `ServerConfig.adminRootPub`, delivered in the recipe (see §1.3) and
     loaded in `configFromInstallBlob` (`server-daemon/src/index.ts:210-241`) +
     `parseConfig` (`config.ts:24-49`).

### 1.3 How a fresh burn receives `admin_root_pub` (trace)

The recipe/InstallBlob already carries the membership IRK pubkey; we add the
admin root pubkey as a **signed sibling field**, exactly mirroring the existing
optional pinned pubkey `ownerAidPubHex`.

Trace, phone → box:

1. Phone mints the recipe. `AuthCode` (`protocol/src/installBlob.ts:22-32`)
   holds `userPubKey` (membership IRK). Add `adminRootPubKey: Bytes` to
   `AuthCode` (or to `InstallBlob` as a top-level signed field — see decision D-1
   below), so the phone signs over it (the blob is signed:
   `installBlob.authCodeUserSignature`). Signing over it stops a compromised
   `.com`/network from swapping the admin anchor in transit — same defense the
   blob already gives `bootUnlockMode` / `diskEncryption`
   (`installBlob.ts:91-125`).
2. Burner parses it: `flagship-burner/src/preseedEngine.ts:41-70`
   (`optionsFromRecipeJson` → `parseInstallBlob`) and `pair.ts:328`
   (`ownerIrkPub = loaded.blob.authCode.userPubKey`) — add the parallel
   `adminRootPub = loaded.blob.authCode.adminRootPubKey`.
3. Burner writes it into the box's install-blob JSON (the same file the daemon
   reads at `/var/flagship/install-blob.json`). For the cloud-init/demo path the
   field threads through `buildCloudConfigUserData`
   (`control-plane/src/demoUsersAdminCloudInit.ts:204-216`) exactly like
   `ownerAidPubHex` (`,"adminRootPubHex":"<hex>"`).
4. Daemon boot reads it: `configFromInstallBlob`
   (`server-daemon/src/index.ts:210-241`) already extracts `ownerAidPubHex`
   (line 230, 236) — add the identical `adminRootPubHex` extraction into
   `ServerConfig.adminRootPub`. `parseConfig` (`config.ts:38-47`) mirrors it for
   the `FLAGSHIP_CONFIG` path.

**Decision D-1 (made here):** put `adminRootPubKey` **inside `AuthCode`**, not
loose on `InstallBlob`. `AuthCode` is what `.com` validates at
`/api/server/register` (`ServerRegisterRequest`, `installBlob.ts:128-134`) and
is re-signed as `authCodeUserSignature`, so the admin anchor is covered by the
existing signature and by `.com`'s registration gate with zero new plumbing.
This is optional/back-compat additive at the type level, but for a clean-slate
burn it is **required present** (see §7 gate).

---

## 2. Enforcement surface — every sensitive chokepoint

Today **every** destructive order verifies against a single config-pinned owner
IRK that **is** `deriveIRK(UMK)` — with zero admin/grant awareness. The fix:
**sensitive** handlers verify against the **admin master root** (or a device
holding a master-root-signed `admin` grant) via one shared predicate (§3);
**non-sensitive** handlers keep verifying against the membership IRK unchanged.

Legend: **Box** = user's daemon (`packages/server-daemon/src`); **Com** =
`packages/control-plane/src`. "Sensitive?" = does D re-point it to the master
root.

| # | Op | file:line | Runtime | Verifies today vs | Sensitive? |
|---|---|---|---|---|---|
| 1 | Self-delete / content wipe | `selfDeleteConsumer.ts:106` | Box | ownerIrkPub | **YES** |
| 2 | Decommission (retire + wipe/power-off) | `decommissionConsumer.ts:109` | Box | ownerIrkPub | **YES** |
| 3 | Dead-man policy set | `deadMan.ts:222` (`applyPolicy`) | Box | `this.irkPub` | **YES** |
| 4 | Dead-man affirmation (lease keep-alive) | `deadMan.ts:252` (`affirm`) | Box | `this.irkPub` | **YES** |
| 5 | Dead-man policy HTTP | `deadManHttp.ts:54` → #3 | Box | (delegates) | **YES** |
| 6 | Dead-man affirm HTTP | `deadManHttp.ts:65` → #4 | Box | (delegates) | **YES** |
| 7 | Manual power-off/restart | `deadManHttp.ts:140` (`buildPowerHttp`) | Box | `opts.ownerIrkPub` | **YES** |
| 8 | Set front-page (apex redirect) | `frontPage.ts:150` (`handleSet`) | Box | `opts.ownerIrkPub` | **YES** |
| 9 | Set-leader vote (preferred server) | `setLeaderConsumer.ts:97` | Box | `args.ownerIrkPub` | **YES** |
| 10 | Phone orders (PSK path: shut-down, revoke-self, rotate-identity, deliver-bak…) | `orders.ts:129` | Box | `opts.pskPub` (dead on real boxes) | **YES** (rewire to admin root if revived) |
| 11 | RootEntitlement verify (bring box online) | `entitlementRelay.ts:154-158` | Box | `args.ownerIrkPub` | **YES** |
| 12 | On-disk entitlement self-heal anchor | `index.ts:1282` | Box | `cfg.irkPublicKey` | **YES** |
| 13 | Owner-IRK swap on recovery | `postRecovery/rePairWatcher.ts:268,303` | Box | **nothing** (trusts `.com`) | **YES — §5** |
| 14 | Add-paired-session (relay) | `pairingDepositConsumer.ts:149` | Box | ownerIrkPub | no (pair-for-use) |
| 15 | Add-paired-session (offline embed) | `pairingDepositConsumer.ts:269` | Box | ownerIrkPub | no (pair-for-use) |
| 16 | SWK delivery | `swkDepositConsumer.ts:70` | Box | ownerIrkPub | no (UMK-derived, accepted) |
| 17 | CGK delivery | `cgkDepositConsumer.ts:60` | Box | ownerIrkPub | no (UMK-derived, accepted) |
| 18 | App invite redeem | `membership.ts:72` | Box | ownerIrkPub | no (full-user cap — see D-2) |
| 19 | App membership mutation | `membership.ts:140` | Box | ownerIrkPub | no (full-user cap — see D-2) |
| 20 | Set custom domain | `customDomain.ts:132` | Com | `userRec.irkPubHex` | **YES** |
| 21 | Deposit auto-unlock lease | `luksKeys.ts:291` | Com | `userRec.irkPubHex` | **YES** |
| 22 | Revoke auto-unlock lease | `luksKeys.ts:359` | Com | `userRec.irkPubHex` | **YES** |
| 23 | Cert soft-revoke | `certRevocation.ts:153` | Com | irkPub | **YES** |
| 24 | Cert hard-revoke + re-mint | `certRevocation.ts:219` | Com | irkPub | **YES** |
| 25 | Account self-delete | `accountDeletion.ts:322` | Com | irkPub | **YES** |
| 26 | Servers self-delete (content wipe) | `accountDeletion.ts:366` | Com | irkPub | **YES** |
| 27 | Server decommission (eviction) | `serverDecommission.ts:133` | Com | irkPub | **YES** |
| 28 | Transfer offer (give a box) | `serverTransfer.ts:249` | Com | giver irkPub | **YES** |
| 29 | Transfer claim (receive a box) | `serverTransfer.ts:376` | Com | acquirer irkPub | **YES** (acquirer's admin root) |
| 30 | Release server name | `serverRevoke.ts:207` | Com | `userRec.irkPubHex` | **YES** |
| 31 | Wipe-restart (immediate IRK rotation) | `wipeRestart.ts:248` | Com | oldIrkPub | **YES — §5** |
| 32 | Watch delegate-key grant | `watchDelegates.ts:180` | Com | irkPub | **YES** |
| 33 | Watch delegate revoke | `watchDelegates.ts:324` | Com | irkPub | **YES** |
| 34 | Entitlement revocation list | `entitlementRevocations.ts:87` | Com | irkPub | **YES** |
| 35 | Re-pair initiate (recovery) | `rePair.ts:510` | Com | newIrkPub | **YES — §5** |
| 36 | Mint device grant | `deviceCapabilityGrants.ts:195` | Com | `userRec.irkPubHex` | **YES for `admin`-scope grants** (§3, §4) |
| 37 | Device-grant fast path | `deviceCapabilityGrants.ts:358` | Com | `userRec.irkPubHex` | **YES — must NOT satisfy a sensitive scope** (§3) |

**Row count: 37** (13 Box, 24 Com; **31 sensitive**, 6 non-sensitive: rows
14–19).

Non-sensitive rows stay verifying against the membership IRK — that is the whole
point of "non-admin = full user": pairing-for-use, deposits, and app membership
remain available to every member.

**Decision D-2 (made here):** app-membership invite/mutation (rows 18–19) are
classified **non-sensitive** — they are app-level access management, not in the
owner's enumerated sensitive set (transfer-give, wipe, decommission, replace,
promote, set-front-page, set-leader, revoke). Flagged in §9 as a residual
judgment call; if the owner wants "who can access my box" to be admin-gated,
flip these two rows to the predicate — no other change.

**Row 11/12 note:** issuing a `RootEntitlement` is "authorize this box under my
account," which is administrative. Under D it verifies against the admin root, so
only an admin device can bring a box online. The **first device is admin by
default** (§4), so first-boot provisioning still works with one device.

---

## 3. Shared predicate + CI gate

### 3.1 `requireMasterAdmin(signerPub, username)`

ONE predicate both runtimes call, mirroring the existing `requireDeviceScope`
(`deviceCapabilityGrants.ts:345-414`) but rooted in the **admin master root**,
not the membership IRK. Pseudocode (place the canonical copy in
`packages/control-plane/src/adminAuthority.ts`; the daemon imports the same
module — both runtimes already share `@flagship/control-plane` /
`@flagship/protocol`):

```
requireMasterAdmin(deps, signerPubHex, username):
  user = usernames.get(username);           if !user -> deny "unregistered"
  adminRoot = user.adminRootPubHex;          if !adminRoot -> deny "no admin root"
  # 1. bare master root signs directly
  if equalHex(signerPubHex, adminRoot): return ok
  # 2. a device holding a master-root-signed `admin` grant
  g = storage.getByDevicePub(signerPubHex)
  if !g || g.revokedAt != null: deny "no active admin grant"
  if g.username != username: deny "username mismatch"
  if now >= g.expiresAt: deny "grant expired"
  if g.signerRoot != 'admin-root': deny "grant not admin-root-signed"   # (§3.3)
  if !verifyDeviceCapabilityGrant(g, g.sig, adminRoot): deny "grant sig"  # verify vs ADMIN ROOT
  if !g.scopes.includes('admin'): deny "missing admin scope"
  if g.quarantineUntil > now: deny "quarantine"                          # (§4)
  return ok
```

Box-side, the daemon holds `cfg.adminRootPub` (§1.3) and calls a **local**
`requireMasterAdmin` that takes the pinned pubkey directly (no `.com` round-trip):

```
requireMasterAdminLocal(adminRootPub, adminGrants, signerPub, order):
  if equalHex(signerPub, adminRootPub): return ok
  # else: signerPub must present an admin grant refreshed from .com
  #       (/api/users/:u/device-grants), verified vs adminRootPub
```

Every sensitive handler in §2 changes from
`verify<Order>(order, sig, ownerIrkPub)` to first resolving the signer, then
`requireMasterAdmin(signerPub, username)` **and** verifying the order signature
against that same `signerPub`. Concretely, for box row 1
(`selfDeleteConsumer.ts:106`): replace the `verifyServersSelfDelete(order, sig,
args.ownerIrkPub)` call with `verifyServersSelfDelete(order, sig, signerPub)`
gated by `requireMasterAdminLocal(cfg.adminRootPub, …, signerPub)`.

### 3.2 `sensitive` flag on DeviceScope → hard-deny in the grant branch

Two changes so a **non-admin device can never reach a sensitive op**:

1. Add `SENSITIVE_SCOPES` to `packages/protocol/src/deviceCapability.ts`
   (alongside `DEVICE_SCOPES:55-64`): `const SENSITIVE_SCOPES = new Set(['admin'])`.
   Add `isSensitiveScope(s: DeviceScope): boolean`.
2. `requireDeviceScope` (`deviceCapabilityGrants.ts:345`) grows a guard: **if the
   requested scope is sensitive, the legacy fast path at `:358`
   (`signer == membership IRK → allow`) MUST NOT satisfy it.** A sensitive scope
   is satisfiable ONLY through `requireMasterAdmin` (i.e. an `admin` grant signed
   by the admin root, or the bare admin root). Non-sensitive scopes keep the
   existing behavior. This closes the "the trusted root is UMK-derived" defect
   the review named (`device-admin-entitlements.md:152`): the fast path is not
   loosened, it is **fenced off from sensitive scopes**.

### 3.3 Grant signer discriminator

`admin`-scope grants must be signed by the **admin master root**, not the
membership IRK — otherwise `.com` (or any UMK holder) could forge them. Add a
`signer_root TEXT NOT NULL DEFAULT 'membership'` column to
`device_capability_grants` (migration 0064, §7): values `'membership'` |
`'admin-root'`. The mint handler
(`deviceCapabilityGrants.ts:138-231`) verifies an `admin`-scope grant against
`admin_root_pub_hex` and stamps `signer_root='admin-root'`; non-admin grants
verify against `irk_pub_hex` as today. `.com` **serves** these grants
(`handleListDeviceGrants:232`) but cannot forge an `admin-root` one — it lacks
the master root. That unforgeability is what lets the box trust a relayed admin
grant.

### 3.4 CI grep-gate

Model on `scripts/release-guard.sh` + `.github/workflows/release-guard.yml`
(the shipped Bucket-C item-4 gate). Add `scripts/admin-authority-guard.sh` +
`scripts/admin-authority-guard.test.ts` + a `.github/workflows/` job. Unlike the
release guard (which fails only under `RELEASE=1`), **this gate fails on every
PR** — it is a correctness invariant, not a pre-GA disarm.

What it enforces: for the set of sensitive handler files/functions enumerated in
§2 (encoded as an explicit allowlist of `file:function` in the script), the
verify call MUST route through `requireMasterAdmin` / `requireMasterAdminLocal`.
It **fails** if any sensitive handler still passes `ownerIrkPub`, `irkPublicKey`,
`cfg.irkPublicKey`, `userRec.irkPubHex`, or `this.irkPub` as the trusted key to a
`verify*` call. Mechanics: `grep -rInE` over `packages/server-daemon/src` +
`packages/control-plane/src`, exclude tests/dist/worktrees (copy the
`exclude_path` helper from `release-guard.sh:60-78`), and for each sensitive
callsite assert the presence of a `requireMasterAdmin` guard in the same
function body (a two-pass check: collect sensitive `verify*` lines, then confirm
a guard token within N lines). A NEW sensitive handler added without the guard
trips the gate. Keep the sensitive-op allowlist in this script the single source
of truth, cross-checked against the §2 table in a unit test.

---

## 4. Admin scope + promote / demote ceremony

### 4.1 What "admin" is

Admin = a device that either **holds the sealed admin master root**, OR holds a
**master-root-signed `admin` `DeviceCapabilityGrant`** for its own device key.
The `admin` scope already exists in the protocol
(`deviceCapability.ts:40-47,63`) — D makes it load-bearing by (a) requiring the
grant be admin-root-signed and (b) fencing it off from the membership-IRK fast
path (§3.2). Admins are **flat + no-expiry** (grant `expiresAt` is a refresh
horizon, not an authority horizon — renew like ServiceGrant).

**First device = admin by default.** At account creation the first device mints
the master root (§1.2) and holds it, so it is a bare-master-root admin with no
grant needed.

### 4.2 Promote a device

Two equivalent mechanisms (owner picks per the device's storage capability):

- **Seal the master root** to the new device (the new device becomes a bare-root
  admin, indistinguishable from the first). Uses the existing device-seal
  pattern (the same box-identity/device-seal machinery already used to seal
  SWK/CGK to a box). Envelope: reuse the sealed-delivery shape; the new device
  decrypts and stores the master root device-local.
- **Sign an `admin` grant** for the new device's device key. Existing admin
  signs a `DeviceCapabilityGrant{ scopes:['admin'], devicePubKey:<new device> }`
  with the **master root**, POSTs it to `.com`
  (`handleMintDeviceGrant:138`, extended per §3.3 to accept/stamp
  `admin-root`-signed grants). `.com` stores + serves it; the box refreshes it
  from `/api/users/:u/device-grants` and `requireMasterAdmin` accepts it. This
  path keeps the master root on fewer devices (least-privilege) while still
  granting admin authority.

Storage/envelopes:
- `.com`: `device_capability_grants` (+ `signer_root` col, §3.3);
  `usernames.admin_root_pub_hex` (§7).
- New canonical envelope for the sealed-root promote is not strictly needed if
  we reuse the existing sealed-delivery + `DeviceCapabilityGrant` envelopes; the
  ONLY genuinely new signed envelope D introduces is the rotation proof (§5).

### 4.3 Demote / revoke (flat)

- **Revoke** = reuse `RevokeDeviceCapabilityGrant`
  (`v2-device-addressing:117-134`; `handleRevokeDeviceGrant`
  `deviceCapabilityGrants.ts:261`) against the target's `admin` grant. `.com`
  writes `revoked_at`; the box's periodic grant refresh drops it. Any admin may
  revoke any device — **flat, no seniority**.
- **Newly-admitted admins inherit the shipped 14-day quarantine**
  (`v1.2-security-cascade.md:240-252`, `rePair.ts` quarantine): a device promoted
  to admin cannot revoke anyone until its `quarantine_until` passes; existing
  admins can revoke *it* immediately. `requireMasterAdmin` enforces the
  quarantine on the actor for the `revoke` op (the `quarantineUntil` check in
  §3.1). This is the "a thief's one new device can't purge the others" defense.
- **A bare-master-root admin cannot be grant-revoked** (it holds the key, not a
  grant). Removing such a device is credential recovery (§5) — the accepted
  trade-off (`device-admin-entitlements.md:185-187`).

---

## 5. Recovery rotation proof (the box must not trust `.com`)

The review's blocker #3: the box adopts `.com`'s reported new root with no
signature proof (`rePairWatcher.ts:268,303`) and `.com` must never be a trust
anchor. D fixes this for the **admin master root** with an old-root-signs-new-root
proof the box verifies against its pinned `adminRootPub`.

### 5.1 The rotation envelope (new)

```ts
// packages/protocol/src/adminRootRotation.ts
export interface AdminRootRotation {
  username: string;
  oldAdminRootPub: Bytes;   // must equal the box's pinned adminRootPub
  newAdminRootPub: Bytes;   // freshly minted during recovery
  issuedAt: number;
}
// canonical tag: flagship/admin-root-rotation/v1
// signed by the OLD admin master root:
//   signAdminRootRotation(r, oldAdminRoot: Keypair)
//   verifyAdminRootRotation(r, sig, oldAdminRootPub)
```

Canonical bytes: tag | username | hex(oldAdminRootPub) | hex(newAdminRootPub) |
issuedAt, `|`-separated, field-guarded (`canonicalBase.ts:37-53`).

### 5.2 Flow

1. **Credential recovery** (WebAuthn-PRF cloud recovery / the credential gate —
   `v1.2-security-cascade.md:145-175`) authorizes the recovering device to mint a
   **new admin master root** AND — because recovery re-establishes the UMK —
   to reconstruct the **old** admin master root **only if it was itself escrowed
   under the recovery credential** (see D-3 below). The old root signs an
   `AdminRootRotation{ old→new }`.
2. `.com` records the new `admin_root_pub_hex` (its report remains advisory) and
   relays the signed `AdminRootRotation` to each box via a new mailbox lane
   (reuse the `secretMailbox` / deposit-consumer pattern).
3. The box's rotation consumer (new, box-side, replacing the blind
   `rePairWatcher.handleCompletedSwap` trust at `rePairWatcher.ts:303`):
   - fetches the rotation order,
   - checks `oldAdminRootPub == cfg.adminRootPub` (its pinned anchor),
   - `verifyAdminRootRotation(order, sig, cfg.adminRootPub)` — **proof against
     the pinned old root, not `.com`'s word**,
   - on success re-pins `cfg.adminRootPub = newAdminRootPub` (persist to the
     install-blob/config) and only then treats new-root-signed orders as valid.
   - **The membership IRK swap** (`rePairWatcher` today) stays as-is for
     membership continuity but is no longer the authority anchor.

### 5.3 Decision D-3 (made here): escrow the master root under the recovery credential

For recovery to sign `old→new`, the OLD master root must be recoverable from the
recovery credential (it is NOT UMK-derived, so a UMK backup alone can't
reconstruct it). **Back up the master root wrapped under the WebAuthn-PRF /
recovery credential** (`device-admin-entitlements.md:201` already says "back up
the credential-wrapped master IRK"). Then:

- **Lose all admin devices, keep the recovery credential** → unwrap the old
  master root, mint the new one, sign the rotation proof → boxes re-pin
  cryptographically. `.com` is never trusted.
- **Lose the recovery credential too** → unrecoverable (accepted,
  `device-admin-entitlements.md:195-197`).

### 5.4 Acknowledged residual: the poll window

Boxes learn the rotation on the next mailbox poll (minutes). During that window
a stolen *active* admin device's signatures still verify against the not-yet-
rotated pinned root. This is the accepted flat-revocation trade-off (§4.3): the
proof shrinks the trust surface from "`.com` says so" to "the old root
cryptographically authorized this new root," but it cannot make rotation
instantaneous across an offline fleet. Document it; do not pretend otherwise.

---

## 6. Non-admin BFF access (explicit)

**Non-admins reach the box and use every service — unchanged.** Pairing-for-use
is the `add-paired-session` order signed by the **membership IRK**
(`pairingDepositConsumer.ts:149` / `:269`, rows 14–15, **non-sensitive**). Slice
B auto-pairs each device's per-box BFF session token off that same membership-IRK
pairing. So:

- Every member (admin or not) derives the membership IRK from the UMK, signs an
  `add-paired-session`, reaches the box BFF, browses, installs services (via the
  non-sensitive `install-service` scope), builds, uses apps.
- SWK/CGK stay membership-derived (rows 16–17), so the service platform comes up
  for the account without any admin action.
- **Only** the sensitive ops in §2 (transfer-give, wipe, decommission, replace,
  power, set-front-page, set-leader, revoke, cert/domain/lease/entitlement
  administration, promote) require the master root.

The authority boundary is about *administrative control*, not data access — a
non-admin is a full user who simply cannot destroy or re-home the cloud.

---

## 7. Clean-slate rollout

No retroactive migration. Sequence:

1. **Land the code** on a merge branch (protocol envelopes + `SENSITIVE_SCOPES`;
   `adminRootPub` in `AuthCode`/`ServerConfig`; `requireMasterAdmin`; re-point
   the 31 sensitive handlers; the rotation consumer; the mint-grant
   `signer_root` change; clients per §8; the CI gate §3.4).
2. **D1 migration `0064_admin_root.sql`** (next number after
   `0063_server_evictions.sql`):
   - `ALTER TABLE usernames ADD COLUMN admin_root_pub_hex TEXT;` (nullable for
     the ALTER; the claim handler requires it present for new claims).
   - `ALTER TABLE device_capability_grants ADD COLUMN signer_root TEXT NOT NULL
     DEFAULT 'membership';`
   Apply to prod D1 **before** the Worker deploy (the predeploy drift gate blocks
   on migration drift — CLAUDE.md).
3. **Wipe** — `WIPE_CONFIRM=prod bash scripts/wipe-all-users.sh --yes` (the
   guarded tolerant runner; NOT the raw `--file` .sql). Removes all accounts +
   servers so no box carries a UMK-derived-only authority anchor.
4. **Redeploy** — `npx tsc -b && (cd apps/com && npm run deploy)` for the Worker;
   `flyctl deploy … -a flagship-services` for the hub if the mailbox lane touches
   it.
5. **Rebuild + re-sign the Mac burner** (it now writes `adminRootPubHex` into the
   install-blob) and rebuild iOS/Android/webapp (they now mint + seal the master
   root at account creation).
6. **Reburn** every box. Fresh burns pin BOTH `irkPublicKey` (membership) and
   `adminRootPub` (authority) from day one — the boundary exists cleanly with no
   in-place re-seal.

### Golden vectors to regenerate

- **Unaffected:** IRK derivation is unchanged (`keys.ts:36-38`), so SWK
  (`keys.ts:107`) and CGK (`cloudGossip.ts:57`) golden vectors and the
  `preseed-vectors.json` / `preseed-engine.js` contract
  (`flagship-burner/engine/golden/`) do NOT change.
- **New vectors required:** the `AdminRootRotation` canonical bytes (§5.1) — add
  to `tools/test-vectors.ts` (→ `test-vectors/canonical-bytes.json`) so all four
  engines (TS/Swift/Kotlin/webapp) agree. `DeviceCapabilityGrant` canonical bytes
  are unchanged (only the signing key differs for `admin` grants, not the byte
  shape), so no new grant vector — but add a cross-engine vector proving an
  `admin`-scope grant **verifies under the admin root and fails under the
  membership IRK**.

---

## 8. Client changes (iOS / Android / webapp)

### 8.1 Generate + seal the master root at account creation (first device)

- iOS: `apps/mobile/ios/Sources/Flagship/Keystore.swift` — add
  `generateAdminRoot()` + `installAdminRoot()` beside `generateUMK`/`installUMK`
  (~131-150); seal device-local (Keychain, NO `kSecAttrSynchronizable`).
- Android: `.../app/keystore/Keystore.kt` — add `generateAdminRoot()` beside
  `generateUMK` (~157); EncryptedSharedPreferences / StrongBox.
- Webapp: `apps/web/public/webapp/keystore.js` (beside IRK at ~240) +
  `apps/web/public/webapp/lib/openAccount.js` (`openAccount` ~89-118) — mint the
  master root, store non-exportable in IndexedDB, POST `admin_root_pub_hex` in
  the username claim body (`usernameClaim.ts:28-40` `UsernameClaimBody` gains
  `adminRootPub?: string`, set at `:102-107`).
- All three: include `adminRootPubKey` in the recipe's `AuthCode` at box-create
  time and sign over it (§1.3).

### 8.2 Promote-a-device UI

- The device-management surfaces that already list devices + scopes
  (`v2-device-addressing:401-415`) gain a "Make this device an admin" action →
  the promote ceremony (§4.2): seal the master root to the target OR mint a
  master-root-signed `admin` grant. Reuse the tiered-confirm **severe** sheet
  (`device-admin-entitlements.md:220-233`): danger color + type-to-confirm +
  biometric; what-you-see-is-what-you-sign over the same parsed grant bytes.
- Only a device that currently holds the master root can drive this (the UI greys
  it out otherwise).

### 8.3 Sign admin ops with the master root

Every client callsite that today signs a sensitive order with the membership IRK
must sign with the **admin master root** instead (and be greyed out on a
non-admin device). These are the client twins of the §2 sensitive rows:
transfer-give, replace/decommission, wipe, account-delete, power, set-front-page,
set-leader, custom-domain, cert-revoke, lease deposit/revoke, watch-delegate,
promote, revoke. Find them by grepping each platform for the order-signing calls
that pair with the §2 handlers (e.g. the transfer-giver, account-deletion,
power, front-page, set-leader signers). Non-sensitive signers (pairing,
deposits, invites) keep using the membership IRK.

### 8.4 Recovery rotation

The recovery flow (WebAuthn-PRF / credential recovery clients) gains: unwrap the
old master root from the recovery-credential escrow, mint the new master root,
sign `AdminRootRotation{ old→new }` (§5.1), submit it for relay. Wire alongside
the existing `recoveredKeyMatchesRegistered()` membership-IRK fork-detection
piece (`device-admin-entitlements.md:171-172`).

---

## 9. Open questions / residual risks

1. **App-membership classification (D-2).** Rows 18–19 (invite/mutation) are
   treated non-sensitive (full-user capability). If "who can access my box" is
   deemed administrative, flip them to `requireMasterAdmin` — one-line change per
   handler, no other impact. **Owner decision needed.**
2. **Poll-window exposure (§5.4).** A stolen active admin remains effective until
   each box polls the rotation. Accepted, but if any op needs instant fleet-wide
   authority cut, it must be gated at the routing/hub layer, not the box.
3. **`orders.ts` PSK path (row 10).** `psk.pub.hex` is never written on real
   Debian boxes, so the destructive orders there are already dead. If that path
   is ever revived, it must rewire to the admin root — the CI gate should include
   it in the sensitive allowlist now so a revival can't skip the boundary.
4. **RootEntitlement bootstrap (rows 11–12).** Moving the entitlement anchor to
   the admin root means only an admin device brings a box online. First-device-
   is-admin covers the common case; confirm no non-admin-only provisioning flow
   exists (e.g. a household member provisioning while the admin is absent). If it
   must, that member needs an `admin` grant first.
5. **Master-root escrow trust (D-3).** Escrowing the master root under the
   WebAuthn-PRF credential is what makes cryptographic recovery possible, but it
   binds admin-recoverability to the credential's security. This is consistent
   with credentials-are-the-gate, but note the master root now has the same
   blast radius as the credential.
6. **Two synced-vs-device-local key stores.** The membership account key is
   iCloud-synced; the master root must be device-local. A client bug that syncs
   the master root would silently hand authority to every device (re-collapsing
   the split). Add a test asserting the master root is stored without the
   synchronizable attribute on each platform.
7. **Grant refresh latency box-side.** `requireMasterAdminLocal` depends on the
   box's periodic `/api/users/:u/device-grants` refresh to see a new `admin`
   grant or a revocation. A freshly-promoted admin can't sign box-side ops until
   the box refreshes; a revoked admin keeps signing until refresh. Bound the
   refresh interval and document it.
8. **Transfer re-home authority (row 29).** On a transfer, the acquirer's box is
   re-homed to the acquirer's account — it must re-pin the **acquirer's** admin
   root, not the giver's. Confirm the transfer re-home handshake
   (`transferRehomeConsumer.ts`) carries + pins the acquirer `adminRootPub`
   (mirrors the disk-key handshake); otherwise a transferred box has no valid
   admin anchor.
