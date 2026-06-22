# Account deletion, server transfer & username reclaim — DESIGN (decisions locked)

Status: **Design locked by owner 2026-06-20. Not yet implemented.** Sibling fix
already landed: iOS sign-out now actually erases the iCloud-synchronizable UMK
(`Keystore.keychainDelete` / `wipeAllProfiles`).

This spec covers three intertwined pieces:
1. A **no-backup deletion ceremony** that turns "remove the last device" into a
   deliberate, twice-confirmed **account deletion**.
2. **Username reclaim** — a deleted name is freed immediately; long-inactive names
   are reclaimable by a sysadmin tool (not an auto-cron).
3. **Server transfer-a-box** — hand a running box (and its contents) to another
   account via a QR, which doubles as the "Pair an existing box" acquirer flow.

---

## 0. Architecture finding that shaped this (device roster)

`.com` has a per-account device roster **only for *added* devices**:
`device_capability_grants` (table) → `GET /api/users/:u/device-grants`
(`listForUser`). Re-pair issues these grants; "remove device" revokes one
(`deviceDisconnect`, IRK-signed). **The *founding* device is NOT in the roster** —
it is implicit, identified by `usernames.irk_pub_hex`. Account creation writes no
self-grant. Consequences:

- Full device set = `{founding IRK holder}` ∪ `{active grants}`.
- A single-device account has **zero** grant rows, so "no active grants" tells us
  nothing.
- **Nothing records that the founding device wiped itself** — the username row
  keeps `irk_pub_hex` forever; there is no account-level "deviceless/dead" state.

⇒ Today `.com` cannot know an account has no devices left. The deletion ceremony
must create that signal. (We chose: **hard-delete the username row** — §1.)

---

## 1. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| Keychain wipe | sign-out must erase the synced key | ✅ DONE (`Keystore` fix) |
| Death record | how account death is recorded | **Hard-delete the `usernames` row** |
| Reclaim timing | when a deleted name frees | **Immediately** (grace-for-undo is cryptographically impossible without KYC / retaining the key) |
| Multi-device delete | whole-account delete on N devices | **Last device out kills it** (remove each device; the last removal deletes the account). No separate "delete-all" command. |
| Inactive reclaim | dormant-but-undeleted names | **Sysadmin manual tool**, allowed for ≥3 months inactive (expectation: wait longer). NOT an automatic GC. |
| Servers on delete | orphan vs transfer | **Orphan + lapse**, PLUS an opt-in **"ask all servers to delete their content"** checkbox; build a real **transfer-a-box** flow (§4). |
| Orphaned online box | reclaiming a live box's name | **Orphan + lapse** — tear down routing/DNS/cert; box keeps sealed data but goes dark and lapses at cert expiry. New claimant can't reach old data (different IRK). |
| Self-delete bundling | content-wipe is never standalone | **`.com` accepts/records the "servers self-delete" order ONLY when it arrives atomically bundled with the last-device account self-delete order. Absent that, the WHOLE bundle is rejected — neither order is recorded or forwarded.** |

---

## 2. The deletion ceremony (client, all surfaces)

Trigger: removing the **last** device of an account (Sign out / Remove device when
`trustedDeviceCount <= 1` and `hasCloudRecovery == false`). With recovery or
another device it's a normal Tier-2/3 action (the key survives elsewhere), not
death.

Three escalating steps:
1. **Confirm popup** (as today).
2. **Full-page irreversible warning** (NEW — a screen, not a dialog):
   - **Username `<name>` is permanently lost** and may be claimed by someone else.
   - **Your servers stop being reachable/manageable.** If you want to keep one,
     **transfer it first** (§4) — link out.
   - **No recovery** — no passkey, no other device, no reset.
   - **Optional checkbox: "Ask all my servers to delete their content"** (default
     OFF) — issues the self-delete order (§5).
   - Affirmative gate: **type the username** + **biometric**, not a tap.
3. **Execute:** submit the owner-IRK self-revoke that **hard-deletes the username
   row** (and tears down routing/DNS/cert — §6). If the content-delete box was
   checked, it rides as **one atomic bundle** with that self-revoke (§5 invariant)
   — never on its own. Then `Keystore.wipeAllProfiles()` and drop to Welcome. The
   name is free immediately.

Mirror on iOS / Android / webapp. Fold the lock-screen sign-out under the same
gate (today it only warns) so the ceremony is consistent everywhere.

---

## 3. Username reclaim

- **Deliberate deletion → immediate free.** Hard-deleting the row makes the name
  pass `handleUsernameClaim` availability again at once. No grace (see §1).
- **Inactive accounts → sysadmin tool, not a cron.** Add **`last_active`** to the
  username/identity (coarse, ~daily bump on any authenticated/IRK-signed call).
  Provide an admin-gated command that can revoke + free a name **inactive ≥ 3
  months** (policy allows it; operators are expected to wait longer). Dry-run +
  audit-logged; never bulk-free silently.
- No automatic background reclaim of inactive names in v1.

---

## 4. Transfer-a-box (and the "Pair an existing box" acquirer flow)

A first-class **cross-account ownership handoff** — the missing piece behind
Home → Add a server → **"Pair an existing box"** (today a dead toast/no-op).

**Giver (current owner), on the server's detail page:**
1. Bottom action **"Transfer to another account."**
2. **Dedicated warning page:** "This hands `<server>` and **all its contents** to
   another account. You will lose control of it." Type-to-confirm + **biometric**.
3. Show a **QR code** carrying a one-time, short-TTL transfer authorization.

**Acquirer:** Home → Add a server → **"Pair an existing box"** → **camera
viewfinder** → scan the QR → take ownership.

**Crypto / build considerations:**
- The box's LUKS key is sealed to the giver's owner IRK; transfer means the disk
  key is **re-sealed to the acquirer's IRK** and `.com`'s server-ownership +
  routing records move to the acquirer. The box must be **online** to complete.
- The QR carries an **ephemeral transfer token** (giver-IRK-signed), not the
  acquirer's identity (unknown in advance). On scan, the acquirer presents their
  IRK; `.com` (brokering) binds ownership to it, one-time.
- This reuses/extends `usernameHandover` / `serverRevocation` plumbing + the
  pairing-deposit pattern; it is NOT the same as adding a device to the *same*
  account.
- Sequencing: ship the **deletion ceremony first** (warn "transfer first"), then
  build transfer-a-box as the immediate follow-on (owner: important, not
  deferred).

**Protocol contract — LANDED (2026-06-21).** Two owner-IRK-signed envelopes,
byte-identical across TS / Swift (`FlagshipCore.ServerTransferOfferOrder` /
`…ClaimOrder`) / Kotlin (`core.ServerTransferOfferOrder` / `…ClaimOrder`),
pinned by cross-platform vectors:
```
flagship/server-transfer-offer/v1|<serverDomain>|<transferNonce>|<issuedAt>|<expiresAt>
flagship/server-transfer-claim/v1|<serverDomain>|<transferNonce>|<acquirerUsername>|<acquirerIrkPubHex>|<issuedAt>
```
The OFFER (giver IRK) is the QR; it names the box + a one-time short-TTL nonce,
NOT the acquirer. The CLAIM (acquirer IRK) binds the acquirer's username + IRK
pub to the offer's nonce. `.com` verifies the offer under the box's CURRENT
owner IRK and the claim under the acquirer's registered IRK.

**⚠️ Broker is a NAMESPACE MIGRATION, not a username swap — design finding (the
remaining build).** The box's identity is bound to the OWNER's namespace at
every layer: the canonical FQDN (`<server>.<oldowner>.flagship.services`), the
LE cert SANs (`[<server>.<owner>, *.<server>.<owner>]`), the per-box DNS records,
the RootEntitlement `podCanonical`, and routing. So moving ownership
`alice`→`bob` is NOT `UPDATE servers SET username='bob'` — it re-homes the box to
`<server>.bob.…`, which requires, atomically at the `.com` broker + then box-side:
1. **`.com`**: verify offer (under current-owner IRK) + claim (under acquirer's
   registered IRK) + offer liveness (stored, unexpired, unclaimed); then move the
   `servers` row + `routing` record to the acquirer's namespace, publish new
   per-box DNS, mark the offer claimed (one-time), audit.
2. **Box**: re-issue its LE cert for the NEW SANs (its existing per-box ACME, on
   the new podCanonical), pick up a fresh acquirer-minted RootEntitlement via the
   existing entitlement-relay/deposit lane, and reseat routing.
3. **Disk key**: only the GIVER's phone can unseal the LUKS key (it holds the
   giver IRK; the box holds only the sealed blob). So the re-seal is a
   GIVER-PHONE step — on seeing the acquirer's claim, the giver's phone unseals
   the current disk key and deposits a NEW box-sealed lease sealed to the
   ACQUIRER IRK (reusing `handlePostBoxSealedLease`). The "box re-seals itself"
   phrasing above is therefore inaccurate; the box never holds the giver IRK.
   Until that deposit lands the acquirer cannot unlock an encrypted box (the
   accepted handshake — both phones participate, giver first).

   Build order for the remainder: (a) `.com` broker — offer-deposit lane (IRK
   mailbox-auth) + claim handler doing the namespace move; (b) the giver-phone
   re-seal-on-claim deposit; (c) box-side cert re-issue + entitlement re-pickup
   on a podCanonical change; (d) clients — giver "Transfer to another account"
   warning + QR render, acquirer "Pair an existing box" camera scan + claim POST.
   The native camera/QR + the box cert/namespace migration need a reburn to
   validate e2e (cannot be hardware-validated in CI).

### Implementation status (2026-06-21, on `feat/transfer-a-box`)

**BUILT + TESTED (the `.com` broker + storage + webapp):**

- **Storage (`packages/storage`)** — a dedicated `server_transfers` store
  (`ServerTransferStorage`, InMemory + D1, migration **0059**): one offer per
  box (`putOffer`, INSERT-OR-REPLACE so a re-issue overwrites), `getOffer`
  (GCs an unclaimed expired row but KEEPS a claimed one so the giver's phone can
  still complete the re-seal after expiry), and `claim` (atomic one-time CAS on
  `claimed_at IS NULL`). D1↔InMemory parity tests (+5).
- **`.com` broker (`packages/control-plane/src/serverTransfer.ts`)** — wired in
  `apps/com/src/controlPlaneRoutes.ts`:
  - `POST /api/server/:domain/transfer/offer` — giver IRK mailbox-auth (reuses
    the `DeviceEndpointClaim` credential); verifies the `ServerTransferOffer`
    under the box's CURRENT registered owner IRK (servers.get → usernames.get);
    one-time short-TTL (15 min) offer, re-issue replaces.
  - `POST /api/server/:domain/transfer/claim` — verifies the
    `ServerTransferClaim` under the acquirer's REGISTERED IRK (and that the
    claim's bound IRK equals it); one-time CAS; then the **`.com`-half NAMESPACE
    MIGRATION**: re-homes the `servers` + `routing` records from
    `<server>.<giver>` to `<server>.<acquirer>` (SAME box identity key),
    publishes the acquirer's per-box DNS (apex + wildcard, registration posture),
    revokes the old domain, audits BOTH account feeds (`server-transfer-offered`
    / `server-transfer-claimed`).
  - `POST /api/server/:domain/transfer/claim-poll` — giver IRK mailbox-auth; the
    giver's phone learns the acquirer IRK for the disk-key re-seal. (POST not GET
    because the IRK mailbox-auth rides the body; mirrors the secret-requests
    POST-alias idiom.)
  - 12 broker tests (happy path moves servers+routing+DNS; forged / wrong-key /
    non-owner / stale / absent / nonce-mismatch / expired offers rejected;
    one-time; giver-only claim poll; re-issue replaces; can't transfer to self).
- **Webapp (`apps/web/public/webapp/lib/serverTransfer.js` + views)** — the
  giver "Transfer to another account" card on server-detail (irreversible
  warning + type-to-confirm the FQDN → sign + deposit → render a paste-able
  claim code) and the acquirer "Take over a transferred box" entry on the
  add-server chooser (paste → sign + POST the claim). 5 tests incl. a FULL
  giver-offer → acquirer-claim → giver-poll round-trip against the real broker
  handlers, plus canonical-byte pins against `@flagship/protocol`.

**LANDED (2026-06-21 follow-on — Layers A, B, C):**

1. **Box-side cert + entitlement re-home on a podCanonical change (Layer A —
   DONE, unit-tested).** `packages/server-daemon/src/transferRehomeConsumer.ts`
   (modelled on `selfDeleteConsumer`): polls a new PUBLIC `.com` read
   `GET /api/server/:old/transfer/rehome` (`handleGetTransferRehome` — the
   transfer row, keyed by the OLD canonical, holds the acquirer username + IRK
   pub after a claim). On a completed transfer it persists a re-home MARKER
   (`/var/flagship/transfer-rehome.json`) with the new canonical + acquirer IRK.
   The daemon `main()` applies the marker at the TOP of boot (before runtime /
   entitlement load): it overrides `env.serverFqdn` + `cfg.irkPublicKey` to the
   acquirer's, so the EXISTING A′ cert path re-derives `boxCertSans` for the new
   SANs and re-issues, and the EXISTING entitlement self-heal discards the stale
   giver-signed bundle and picks up a fresh acquirer-minted one — no new cert/ACME
   code. The box never trusts `.com` as a key authority: the acquirer IRK only
   becomes load-bearing once a fresh acquirer-IRK-signed entitlement verifies
   under it at HELLO (same check the hub runs). Tests: `transferRehomeConsumer`
   (7) + broker rehome read (+2). **Live e2e still needs a reburn** (the
   kernel/ACME/tunnel path isn't CI-exercised).
2. **Giver-phone re-seal-on-claim deposit (Layer B — DONE, unit-tested).** A
   disk-key handoff column on the claimed transfer row (migration **0060** +
   `putDiskKeyHandoff`, D1↔InMemory parity). Broker:
   `POST .../transfer/disk-key` (giver IRK mailbox-auth — deposits the disk key
   RE-SEALED to the ACQUIRER IRK; claimed-row + giver-account guarded) and
   `POST .../transfer/disk-key-claim` (acquirer IRK mailbox-auth — consume).
   `.com` stays content-blind (only the acquirer IRK opens the blob). Webapp
   `lib/serverTransfer.js`: `resealDiskKeyForAcquirer` (open the giver-sealed
   disk key with the giver IRK → re-seal to the acquirer IRK via
   `ed25519PubToX25519` + `sealForBrowserKey` → deposit) + `claimResealedDiskKey`
   (fetch + open with the acquirer IRK). NOTE: this re-seals to the ACQUIRER IRK
   (a two-phone handshake — the acquirer then completes the standard
   box-sealed-lease deposit), NOT a giver-signed `handlePostBoxSealedLease`
   directly: after the namespace migration the lease-v2 handler verifies under the
   acquirer's registered IRK, which the giver's phone doesn't hold. Tests: a wire
   round-trip through the real broker + a crypto round-trip pinned against
   `@flagship/protocol` `openSealedFromEd25519Recipient`.
3. **Native iOS/Android giver-QR render + acquirer camera (Layer C — code-complete,
   awaits an xcodebuild/gradle compile).** Clients: `ServerTransferClient`
   (protocol + Live + Mock) on iOS (`FlagshipAPI`) and Android (`api`), reusing
   `MailboxAuthEnvelope`; pure flow builders `ServerTransferFlow` (offer/claim/QR
   codec/disk-key re-seal) in `FlagshipCore` (Swift, `swift test`-green) +
   `core` (Kotlin, JVM unit tests). VMs: `TransferGiverViewModel` (sign offer →
   deposit → QR → poll → re-seal on claim) + `TransferAcquirerViewModel` (parse
   QR → sign claim → POST) on both. Screens: `TransferServerScreens` (giver
   type-confirm + biometric + QR render via the existing `PairingQRView` /
   `qrImageBitmap`; acquirer camera via the existing `QRScannerView` / `QRScanner`).
   Entry: a "Take over a transferred box" card on `AddServerChooserScreen` (both).
   Tests: Swift `ServerTransferFlowTests` (5, swift-test-green) + iOS
   `TransferViewModelTests` (XCTest, **NOT compiled here** — needs xcodebuild);
   Android `ServerTransferFlowTest` + `TransferViewModelTest` (**NOT compiled
   here** — needs gradle). The server-detail "Transfer to another account" entry
   wiring + nav route into `TransferGiverScreen` is the small remaining UI hookup
   to do during the native compile pass.

---

## 5. Self-delete-content order (opt-in) + attacker analysis

The deletion warning's optional checkbox issues an **owner-IRK-signed
self-delete** order; boxes that receive it wipe their content. Offline boxes get
it as a best-effort **pending** order executed on next boot. Default OFF (a plain
deletion just orphans-and-lapses; sealed data stays on disk, unreachable).

**Delivery (locked, with code evidence).** The order reaches the box via the
existing **mailbox deposit rail** (the `pairing`/`entitlement` deposit pattern):
`.com` writes the signed `servers-self-delete` order into the `secret_mailbox`
under a new **`self-delete`** purpose lane, keyed by server domain, **during the
bundle commit BEFORE teardown** (one per owned server). The daemon consumes it
on its heartbeat poll (≤5-min window), **owner-IRK-verifies** it, then runs the
data-services wipe — best-effort + idempotent. **Critical:** unlike the
entitlement consume (which 403s on `reg.revokedAt`), the `self-delete` consume
endpoint must be **revoke-tolerant** — the ceremony revokes the server during
teardown, so a revoked-guard would make the order undeliverable. It is safe to
serve post-revoke because the order is owner-IRK-signed and self-verifying (a
relay can't forge it). **Offline boxes** never poll ⇒ orphan-and-lapse (data
stays sealed, unreachable) — the accepted model.

**Bundling invariant (locked):** the content-wipe is **never a standalone
order**. `.com` accepts/records the "servers self-delete" order ONLY when it
arrives as one **atomic bundle** with the **last-device account self-delete**
(the hard-delete-row self-revoke). If that companion order is absent — or the
issuing device is NOT the account's last device — `.com` rejects the **entire
bundle** and records/forwards **neither** order. Enforcement lives at `.com`'s
bundle-ingest: verify (1) both orders present and owner-IRK-signed, (2) the
issuer is the last remaining device (account goes to zero devices), (3) all-or-
nothing commit. This guarantees content can only be wiped as an inseparable side
effect of irreversible account death — there is no "wipe my servers but keep my
account" path, and a stray/replayed content-delete on its own is inert.

**Threat: attacker with a compromised phone uses this to nuke boxes.** Accepted
reasoning: the order is only issuable inside the deletion ceremony, which only
runs on the **last device** behind biometric + typed confirm. An attacker there
already holds the unlocked phone + owner IRK and can issue **any** owner order
(power-off, re-pair, wipe-restart) — so the checkbox grants **no new power**. The
phone lock is the real defense. Hardening kept: opt-in default-off, biometric +
typed confirm, fires only on full deletion. Caveat: offline boxes can't be
reached live.

---

## 6. Primitives to reuse / extend

- `Keystore.wipeAllProfiles()` — synchronizable-aware (landed).
- `SignOutPolicy.evaluate` — recovery/other-device gate (extend to lock-screen).
- `deviceDisconnect` — revoke an added device's grant (Tier-3).
- `serverRevocation.handleServerReleaseName` — ordered name/routing/DNS/cert
  teardown (basis for both delete and transfer).
- `usernameHandover` — name reassignment plumbing.
- `device_capability_grants` / `GET /api/users/:u/device-grants` — added-device
  roster + sibling/admin discovery.
- Pairing-deposit / secret-mailbox pattern — for delivering the transfer token +
  pending self-delete order to a box.

---

## 7. Build plan (proposed order)

1. ✅ **Deletion ceremony** (3 surfaces): full-page warning + type/biometric gate +
   hard-delete-row self-revoke + immediate name free + lock-screen gate
   consolidation. SHIPPED (+ iOS dedicated XCTest, 2026-06-21).
2. ✅ **`last_active` + sysadmin reclaim tool** for ≥3-month-inactive names. SHIPPED.
4. ✅ **Self-delete-content** — `.com` bundle-ingest enforcing the §5 invariant +
   **box-side delivery + execution SHIPPED (2026-06-21)**: a `self-delete`
   mailbox lane, deposit-on-commit, the revoke-tolerant box consume, and the
   daemon `selfDeleteConsumer` (heartbeat poll → owner-IRK re-verify →
   data-services wipe, idempotent). Needs a reburn for live e2e.
3. ⏳ **Transfer-a-box**: ✅ protocol contract (offer + claim, 3 platforms, pinned),
   ✅ `.com` namespace-migration broker + storage, ✅ webapp client, ✅ box-side
   cert/entitlement re-home consumer (Layer A), ✅ giver-phone disk-key re-seal
   (Layer B), ✅ native iOS/Android clients + VMs + screens (Layer C,
   code-complete). REMAINING: the native xcodebuild/gradle compile + on-device
   test, the server-detail "Transfer to another account" entry hookup, and a
   reburn for the box-side cert/entitlement re-home + disk-key handshake live e2e
   (none CI-validatable).

Open build-time questions: exact transfer-token format + who brokers the re-seal
(`.com` vs direct); whether `last_active` lives on `usernames` or
`user_identity_records`; webapp equivalents of the camera scan.
