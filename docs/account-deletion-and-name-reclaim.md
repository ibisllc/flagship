# Account deletion ceremony + username reclaim (GC) — design for discussion

Status: **DRAFT for owner review.** Not implemented. Sibling fix already landed:
the iOS Keychain wipe now actually erases the synchronizable UMK on sign-out
(see `Keystore.swift` `keychainDelete` / `wipeAllProfiles`). This doc covers the
two follow-ons the owner asked to design first:

1. A **no-backup deletion ceremony** — make "sign out / remove device" with no
   recovery and no other device an explicit, twice-confirmed *account deletion*.
2. A **garbage collector** that frees usernames with no registered device so the
   name becomes available again.

---

## 0. Why this is delicate

The phone is the trust root. For a **single-device, no-cloud-recovery** account
the device key (UMK→IRK) is the *only* copy of the account identity. So:

- Erasing it with no backup is **unrecoverable** — there is no server-side reset
  (by design; `.com` is content-blind and cannot mint a user's IRK). Today the
  Settings sign-out is gated by `SignOutPolicy` (blocks Tier-2 without recovery),
  but the **lock-screen** sign-out only *warns* ("Sign out anyway") — inconsistent.
- The user's **box keeps running** after the phone forgets the account. Servers
  keep serving until their cert/lease machinery lapses, but the owner can no
  longer authorize anything (power, re-pair, front-page, deploys). So deletion
  should *offer to deal with the servers first*, not silently orphan them.
- The **name** is a scarce public identifier (`<user>.flagship.services`). Once
  reclaimable, freeing it must be safe against accidental loss and against
  reassigning a name whose box/data still exists.

Guiding principle: **deletion is a deliberate ceremony, never a side effect of
"leave the app."** Reclaim is **conservative** — only free a name we are
confident is truly abandoned.

---

## 1. The deletion ceremony (client)

Trigger: the user chooses **Sign out** or **Remove this device** AND
`hasCloudRecovery == false` AND `trustedDeviceCount <= 1` (this is the only
device). With recovery or another device, the existing Tier-2/Tier-3 flow stands
(the key returns via recovery / another device, so it is not account death).

Three steps, escalating:

1. **Confirm popup** (as today) — "Sign out without recovery?" Cancel / Continue.
2. **Full-page irreversible warning** (NEW) — a dedicated screen, not a dialog,
   so it cannot be dismissed by reflex. It states plainly that this **deletes the
   account**, and lists the consequences:
   - **Your username `<name>` is lost** and may be **claimed by someone else**.
   - **Your servers stop being reachable / manageable** — you will not be able to
     power, re-pair, or deploy to them. Consider **transferring them away first**
     (link to the transfer/handover flow — see §3) before continuing.
   - **There is no recovery** — no passkey, no other device, no reset.
   - Requires an explicit affirmative (type the username, or a hold-to-confirm),
     not just a tap.
3. **Execute** — on final confirm, do BOTH:
   - **Remove the device server-side** (`deviceDisconnect` / self-revoke, the
     Tier-3 path) so the account has no registered device, and
   - **Wipe local key material** (`Keystore.wipeAllProfiles()` — now synchronizable-
     aware) and drop to Welcome.
   The account is now **deviceless** — the GC (§2) will free the name.

Notes:
- Mirror on all three surfaces (iOS / Android / webapp). The webapp tier-1 lock
  is a PIN; the ceremony applies to its Tier-2/3 equivalents.
- Keep the **non-destructive** path prominent at step 1 for users who actually
  have recovery — most should never see steps 2–3.
- Copy must distinguish **"lock"** (reversible) from **"delete account"**
  (irreversible) unambiguously.

---

## 2. The garbage collector (server / `.com`)

Goal: a username with **no registered device** becomes **available again** after
a safe grace period.

### 2.1 What does "no registered device" mean?

Today device-presence is proxied by **push tokens** (`accountResolve.ts` derives
`trustedDeviceCount` from `pushTokens.listByUser`). That is too weak (push tokens
need TestFlight/Play; not yet shipped) and too easily zero for a live account. We
need a **first-class device roster** signal. Options:

- **(a) Count `device_capability_grants` / paired sessions** for the account
  (already a table) — a device that paired has a grant; a removed device's grant
  is revoked. "No active grant" ⇒ deviceless.
- **(b) Explicit `deviceless_since` stamp** written by the deletion ceremony's
  server-side remove-device step, cleared on any new pairing/claim. Most reliable
  because it is set by the deliberate act, not inferred.

Recommendation: **(b) as the authority, (a) as a cross-check.** The ceremony's
remove-device call stamps `deviceless_since`; a later pairing clears it.

### 2.2 Activity tracking (`last_active`)

`usernames` has only `claimed_at` (set once). Add a **`last_active`** (epoch-ms),
updated cheaply on authenticated account activity (e.g. a daily-resolution bump on
`/api/users/:u/pods` or any IRK-signed call) so we can also catch **silently
abandoned** accounts (device lost, never formally deleted) — distinct from the
deliberate-deletion path. Keep the write coarse (once/day) to avoid hot-row churn.

### 2.3 Reclaim policy

Free a name when **either**:
- **Deliberate:** `deviceless_since` set AND older than a short grace (e.g. 7d) —
  the user explicitly deleted; grace guards against "I changed my mind / re-pair."
- **Abandoned:** `last_active` older than a long horizon (e.g. 12 months) AND no
  active device grant — guards against reclaiming a name whose owner is merely
  dormant. (Exact horizon = owner decision; err long.)

"Free" = the `usernames` row is released so the name passes
`handleUsernameClaim` availability again. Reuse / extend the existing
**`serverRevocation` (release-name)** + **`usernameHandover`** primitives rather
than a raw delete, so DNS/routing/cert records are torn down in order.

### 2.4 The box-still-exists risk (must address before reclaiming)

A freed name could still have a **running box** with the old owner's data, and a
new claimant of the name must NEVER inherit access to it. Safeguards:

- Reclaim **revokes routing/RCK + per-name DNS + cert authority** for the old
  identity first, so a new claim starts with a clean, unrouted name.
- A new box under a reclaimed name mints a **fresh identity/cert**; the old box's
  data stays sealed on its disk (LUKS, owner-IRK-sealed) and is **not** reachable
  by the new owner — the new owner has a different IRK, and the old box won't
  unlock/serve for them.
- Decide: should reclaim **attempt to notify / decommission** a still-online box
  (it can't without the owner's IRK), or simply orphan it (it lapses when its
  cert/lease expires)? Lean **orphan + document**; active decommission needs the
  owner key we just deleted.

### 2.5 Mechanism

A scheduled Worker cron (there is already a `*/10` + `0 */6` cron surface) runs
the GC: select candidates by the §2.3 policy, release each via the ordered
teardown, audit-log every reclaim. Dry-run + per-run cap first; never bulk-free
silently (log counts, like the wipe script).

---

## 3. Server transfer-away (referenced by the ceremony)

The deletion warning should link to a way to **hand a server to another account**
before deleting, so the user doesn't lose a running box they care about. Check
whether `usernameHandover` / a server-level transfer already covers this or if a
new "transfer server to <username>" flow is needed. (Likely a gap — today the
flows are re-pair/recover, not "give my server to someone else.") This is its own
mini-design; for v1 the ceremony can simply *warn* ("transfer first if you care")
and link to manual guidance, with the real transfer flow as a follow-on.

---

## 4. Reused primitives (don't rebuild)

- `Keystore.wipeAllProfiles()` — now synchronizable-aware (the landed fix).
- `SignOutPolicy.evaluate` — recovery/other-device gate (extend to the lock-screen
  sign-out for consistency).
- `deviceDisconnect` (Tier-3 remove device) — the server-side "kill the device".
- `serverRevocation.handleServerReleaseName` — ordered name/routing teardown.
- `usernameHandover` — name reassignment plumbing.
- `accountResolve.trustedDeviceCount` — device-count signal (upgrade per §2.1).

---

## 5. Open questions for the owner

1. **Grace windows:** deliberate-delete grace (7d?) and abandoned horizon (12mo?).
2. **Abandoned reclaim at all,** or only reclaim deliberately-deleted names? (The
   abandoned path is higher-risk; we could ship deliberate-only first.)
3. **`last_active` granularity** + which calls bump it.
4. **Transfer-away:** build a real server-transfer flow now, or warn-and-defer?
5. **Still-online orphaned box:** orphan-and-lapse (recommended) vs. attempt
   decommission.
6. **Reclaim notification:** do we ever tell the old owner (no device, no push) —
   probably impossible, so reclaim is silent-but-audited.
7. Should **Remove device** on a *multi*-device account ever trigger this? No — it
   only kills the account when it removes the LAST device with no recovery.
