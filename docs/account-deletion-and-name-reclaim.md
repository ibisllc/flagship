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
3. **Execute:** issue the owner-IRK self-revoke that **hard-deletes the username
   row** (and tears down routing/DNS/cert — §6), fire the optional content-delete
   order to online boxes, then `Keystore.wipeAllProfiles()` and drop to Welcome.
   The name is free immediately.

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

**Crypto / build considerations (to spec at build time):**
- The box's LUKS key is sealed to the giver's owner IRK; transfer means the box
  **re-seals its disk key to the acquirer's IRK** and `.com`'s server-ownership +
  routing records move to the acquirer. The box must be **online** to complete.
- The QR carries an **ephemeral transfer token** (giver-IRK-signed), not the
  acquirer's identity (unknown in advance). On scan, the acquirer presents their
  IRK; the box (or `.com` brokering) binds ownership to it, one-time.
- This reuses/extends `usernameHandover` / `serverRevocation` plumbing + the
  pairing-deposit pattern; it is NOT the same as adding a device to the *same*
  account.
- Sequencing: ship the **deletion ceremony first** (warn "transfer first"), then
  build transfer-a-box as the immediate follow-on (owner: important, not
  deferred).

---

## 5. Self-delete-content order (opt-in) + attacker analysis

The deletion warning's optional checkbox issues an **owner-IRK-signed
self-delete** order; boxes that receive it wipe their content. Offline boxes get
it as a best-effort **pending** order executed on next boot. Default OFF (a plain
deletion just orphans-and-lapses; sealed data stays on disk, unreachable).

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

1. **Deletion ceremony** (3 surfaces): full-page warning + type/biometric gate +
   hard-delete-row self-revoke + immediate name free + lock-screen gate
   consolidation. (Warn "transfer first"; checkbox wired to a stubbed self-delete
   until §5 box-side lands.)
2. **`last_active` + sysadmin reclaim tool** for ≥3-month-inactive names.
3. **Transfer-a-box**: giver flow + QR + acquirer "Pair an existing box" camera
   scan + box-side re-seal/ownership move.
4. **Self-delete-content** box-side order handling (online + pending).

Open build-time questions: exact transfer-token format + who brokers the re-seal
(`.com` vs direct); whether `last_active` lives on `usernames` or
`user_identity_records`; webapp equivalents of the camera scan.
