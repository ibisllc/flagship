# Names on a locked phone: nicknames and ring-back pages (design, 2026-11-22)

Status: **design only**, nothing built. Branch `0.4/android-calls` at `5fbacd74a`. Builds on `docs/voici-calls.md`
("As built: answering while locked", "Ring-back") and `docs/voici-and-messages.md` (pseudonyms, the sealed Messages
state). Owner-agreed direction: a small table outside the app lock, OS-encrypted and readable after the first unlock
since boot (like Contacts), so a locked phone can show (a) the nicknames of visitors the owner has really had calls
with and (b) the page name of a ring-back. Opt-in, tied to "Answer calls while Flagship is locked", erased on sign out.

This document says what goes in the table, where it lives, how a ring-back finds its entry without giving Apple or
Google a stable identifier, what the owner sees, and how to test it. Owner decisions still open are in §8.

## 1. What happens today (read from the code)

- **Incoming call, app locked, call key on.** `VoiciCallCenter.incoming` (iOS,
  `apps/mobile/ios/Sources/FlagshipUI/Calls/VoiciCallCenter.swift`) uses `lockedKeys()` (from
  `VoiciCallKeyStore.currentAccountKey`, `Calls/VoiciCallKey.swift`). The push's sealed caller can't be opened (the
  inbox key needs the account), so the room's signed request sets the name: `lockedCallerName(from:)` gives
  "Visitor 4F3A" for a 64-hex pseudonym, else "Anonymous caller". Nicknames (`MessagesState.nicknames`, keyed by
  pseudonym pub, `apps/mobile/shared/Sources/FlagshipCore/VoiciMessagesRecords.swift`) are in the sealed, synced
  Messages state and only appear after the unlock (`join` → `keys.nicknames[who.from]`). Android does the same
  (`calls/VoiciCallCenter.kt`, `core/voici/VoiciCenter.lockedCallKeys`).
- **Ring-back, app locked.** `.com` pushes `{kind:"voici-ring", ringId, hint, room}`
  (`packages/control-plane/src/voiciCallModes.ts`, `handleVoiciRing` + `buildVoiciRingPusher`); `ringId` is random per
  ring and the hint is sealed to the caller's thread key with context `[conv, ringId]`. iOS `incomingRing` runs
  `MessagesStore.openRing` (needs `Keystore.messagesUMKIfCached()`), so locked it shows "Someone on voi.ci", and
  Answer ends the call (`answerRing`: "ring-back ended: locked-no-page"). Android `calls/VoiciRingCenter.kt` posts a
  CallStyle ring with "Someone you wrote to is calling you back. Open Flagship to answer."
  (`voici_ring_incoming_locked`).
- **Where the names go once set.** iOS CallKit `localizedCallerName`, with `includesCallsInRecents = false`
  (VoiciCallCenter.swift:195), so nothing lands in the Phone app's Recents or iCloud call history. Android: a
  self-managed Telecom connection (`calls/VoiciConnectionService.kt`, `setCallerDisplayName`) and the app's own
  full-screen `VoiciCallActivity` (`setShowWhenLocked(true)`). Self-managed calls are not written to the system call
  log (no `EXTRA_LOG_SELF_MANAGED_CALLS`), but Telecom hands the display name to Bluetooth car kits and Wear OS.
- **Already outside the app lock today (finding).** The device's Calls list, `VoiciCallHistory`
  (`Calls/VoiciCallHistory.swift`, Android `calls/VoiciCallHistory.kt`), sits in plain `UserDefaults` /
  SharedPreferences: up to 200 records with the pages this account called (`.page(username:)`) and the visitors'
  pseudonym pubs. A thief with an after-first-unlock phone or an extraction already learns which pages the account
  called. That is a larger leak than this design adds; see §8 D6.
- **The settings footer is stale.** `VoiciCallsSettingsSection.swift:100` still says the caller shows as "Someone on
  voi.ci" until the unlock; since `5fbacd74a` it shows the visitor name. §5 gives new wording either way.

## 2. Threat model

What the new table holds at most: up to 50 nicknames the owner typed for visitors they had calls with, and up to 50
page names (public voi.ci names) this account called with call-back on. Nothing else: no messages, no keys that open
anything, no account name beyond what the call key's entry already holds.

| Who | What they get today (call key on) | What the table adds | Notes |
|---|---|---|---|
| **Thief, phone unlocked at the OS, Flagship locked** | Can answer a ringing call (the call key's point); sees "Visitor 4F3A". The Calls list in Flagship needs the app unlocked, but its data is in UserDefaults. | Sees the nickname ("Mom") of whoever rings while they hold the phone, and the page name of a ring-back. Cannot list the table from the UI (no screen shows it while locked). | Same exposure as a phone's own Contacts app. Accepted by the owner. |
| **Thief, phone locked at the OS (after first unlock)** | Lock-screen ring: visitor name, answerable. | The nickname / page name on the lock-screen ring, only when a call comes in. | iOS: CallKit shows the name on the lock screen regardless of notification-preview settings. Android: our own full-screen activity draws it over the keyguard. |
| **Forensic extraction, after first unlock (AFU)** | Call key (Secure Enclave / Keystore, not extractable on most phones), UserDefaults call history. | The whole table: ≤50 nicknames + ≤50 page names. AFU-class Keychain items and CE storage are readable in an AFU extraction. | Keys are hashed (§3.2), so the table alone doesn't name pseudonym pubs or conversation ids; it doesn't add links to `.com`'s records. Biggest real cost: "this person calls someone they call Mom, Dr Patel". |
| **Forensic extraction, before first unlock (BFU)** | Nothing (AFU items are sealed by the passcode). | Nothing. | Holds on iOS (Data Protection class C) and Android (CE storage + Keystore). |
| **Device backup / new phone restore** | — | Nothing: iOS `…ThisDeviceOnly`, Android file excluded from Auto Backup and device-to-device transfer. | Must be pinned by a test (§7). |
| **Shoulder surfing, shared family phone** | Visitor name on the ring. | The nickname on the ring. A family member using the phone (OS unlocked) learns who rings Flagship. | This is the main human cost. The toggle says it plainly (§5). Car kits, a paired watch and iOS "Announce Calls" (Siri reads the name aloud) repeat it. |
| **APNs / FCM** | Call push: callId, room, sealed caller. Ring push: random `ringId`, sealed hint, room. | **Ring push gains one 16-byte `tag`** = HMAC of the random `ringId` under a per-conversation key APNs never sees. Unlinkable from ring to ring, and nothing names a page, account or person. The call push is unchanged (nicknames are looked up on the phone). | Pushes stay content-free (no alert text, no names). §4. |
| **`.com`** | Already stores the ring-back channel row `(page_id, conv, username)` (`0149_voici_ring_backs.sql`), so it knows that conversation can ring that account. Never sees nicknames. | Stores one 32-byte `ring_tag_key` per channel row, derived from the caller's Messages secret. Learns nothing new: it already links conv ↔ account on that row. Nicknames never reach `.com`. | A dishonest `.com` could compute a tag for another cached page and make a locked ring show the wrong page name. It can already push fake rings; and the hint (opened after the unlock) decides what is dialled (§4.4). |
| **The page owner (callee side of a ring-back)** | Sees the caller's pseudonym only. | Nothing: the tag key never reaches the owner and the ring order is unchanged. | No owner-client change. |

**AI rule** (Conventions): no model reads this table; it is never logged, never sent in diagnostics, and the call logs
keep logging reason codes only (`voiciCallLog.notice(... privacy: .public)` must never get a nickname).

## 3. Storage

### 3.1 What is stored

One record per account, a small versioned JSON blob, rebuilt from the unlocked account (never edited piecemeal while
locked):

```
{ "v": 1, "account": "<username lowercased>", "builtAt": <ms>,
  "names": { "<k16 hex>": { "n": "Mom", "last": <ms of last call> }, ... },          // ≤ 50
  "rings": { "<tagKey hex>": { "u": "brisk-quartz", "p": "<pageId>", "last": <ms> }, ... } }  // ≤ 50
```

- `names` key: `k16 = first 16 bytes of SHA-256("flagship/voici-locked-name/v1|" + pseudonymPub)`. The ringing request
  gives the pseudonym pub, so the phone computes the key and looks it up. The table never holds the pub or the conv
  id, so an extracted table can't be joined with what `.com` or a seized page holds without the pubs themselves.
- `names` entries: only a pseudonym that (1) has a nickname in `MessagesState.nicknames`, and (2) has a call record
  with this account, in either direction and any outcome except `failed`, in the last 90 days (from
  `VoiciCallHistory` on this device plus the missed calls `.com` holds, opened when unlocked), and (3) is not in
  `blocks`, not `forgotten`, and its conversation isn't anonymous (an anonymous browser key has no nickname). The
  value is the nickname as stored (already length-capped by `VoiciText.prepareVoiciText(.nickname)`).
- `rings` key: the conversation's ring tag key (§4.2), 32 bytes. Value: the page's voi.ci name and pageId (public
  data). Entries: each `signedInSites` page for which this account attached a ring-back channel from the app, within
  the channel's 90-day life; removed on "Stop call-backs", conversation delete, or the page's removal.
- Cap 50 + 50, by most recent `last`; anything older than 90 days is dropped at each rebuild and ignored on read.
  Expected size well under 8 KB.

### 3.2 Where

- **iOS:** one Keychain generic-password item, service `com.flagship.voici.locked-names`, account = username,
  `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no access control / user presence (the same class as
  `VoiciCallKeyStore`, `VoiciCallKey.swift`). Not in a shared access group: the widget and watch extensions do not
  read it. A new `VoiciLockedNamesStore` next to `VoiciCallKeyStore`.
- **Android:** a file in the app's credential-encrypted `filesDir` (`voici-locked-names/<username-hash>.bin`),
  AES-256-GCM under a Keystore key `flagship.voici.lockedNames` (`setUserAuthenticationRequired(false)`, no
  `setUnlockedDeviceRequired`, no StrongBox: it must open quickly while ringing). The app's other
  `EncryptedSharedPreferences` users (`core/AppState.kt`, `core/SecuredSessionStore.kt`) work, but androidx
  security-crypto is deprecated; a plain Keystore-wrapped file is smaller and has no new dependency. Exclude the
  directory in `data_extraction_rules.xml` / `backup_rules.xml` (cloud backup and device transfer). Not direct-boot
  aware, like the call key (before first unlock the app doesn't run anyway).
- **The VoIP / FCM path reads only this table and the call key.** No other account data is opened while locked.

### 3.3 Sync across the owner's devices

The table is **not synced and never leaves the device**. Each device builds its own from data it already has:
nicknames and blocks from the synced Messages state, call records from its own history plus `.com`'s missed calls,
ring tag keys derived from the Messages secret (§4.2, so every device of the account can match every ring-back,
whichever device attached the channel). A device builds a table only while its own setting is on.

Lag: a nickname deleted or a visitor blocked on device A disappears from device B's table at B's next unlock (B can't
read the sealed state while locked). Accepted; stated in §5's help text ("updated each time you unlock").

### 3.4 Rebuild and erasure

Rebuild (whole blob, atomic write) when unlocked and the setting is on: at unlock, after a Messages state merge
(local or from another device), after a call ends, after a ring-back attach or stop, after a block, delete or
report, after a nickname change. Cheap: at most a few hundred records to scan.

Erase (delete the Keychain item / the file **and** the Android Keystore key) on:

| Event | Hook today |
|---|---|
| Setting off | iOS `MessagesStore.revokeCallKey()` (MessagesStore.swift ~843); Android `VoiciCenter.revokeCallKey()` (~915) |
| Sign out, Remove this device, wipe | iOS `Keystore.onWipe` hook (MessagesStore.swift ~1576, beside `VoiciCallKeyStore.delete`); Android `VoiciCenter.forgetLocal()` (~300) |
| Account gone (404 `account-not-found`) | the same forget path both apps already run for account gone |
| Call key revoked by `.com` (grant revoked, device removed elsewhere) | wherever the app learns its call key is dead; the table goes with it |
| No longer an admin device | the call-key setting is admin-only; drop both together |
| Calls turned off for the page / page removed | drop `names`; keep `rings` only if D1 says ring-back names stand alone |

Write a test for each row (§7).

## 4. Ring-back page names while locked

### 4.1 The problem

The ring push has a random `ringId` and a hint only the thread key opens. A locked phone holds neither the thread
key nor anything that says which of its conversations rang. Whatever we add must let the phone pick its entry
without handing APNs / FCM a stable identifier (which would let them see "this account gets rung from the same
conversation every Tuesday").

### 4.2 Options

**(a) A per-conversation tag key `.com` stores with the channel; the push carries `tag = HMAC(tagKey, ringId)`.**
(recommended)

- `tagKey = HKDF-SHA256(ikm = messagesSecret, info = "flagship/voici-ring-tag/v1|" + pageId)`, 32 bytes. Derived, so
  every unlocked device of the caller account gets the same key for that page; no sync, no new secret to back up.
- The caller app sends it in the ring-back attach (`POST /api/voici/web/ring-back`, body field `ringTagKey`) beside
  the pseudonym-signed `flagship/voici-ring-back/v1` order. Only when the app attaches with device headers (an
  account); the voi.ci site's browser attach (`apps/voici-site/src/call.js`) names no account and gets no push, so it
  sends none. (The device headers, `flagship/account-directory-request/v1` in `packages/protocol/src/accountMetadata.ts`,
  don't cover the body. Leaving the field unsigned is acceptable: a forged key only makes the name not show. If the
  owner wants it signed, bump the order to `voici-ring-back/v2` with the key's hash in it; see D4.)
- `.com` stores it in a new nullable column `voici_ring_backs.ring_tag_key` (migration `0158_voici_ring_tag.sql`;
  storage `packages/storage/src/voiciCalls.ts`). Replaced by the next attach, gone with the row (stop, block, page
  removed, delete, 90 days, account rename in `accountRename.ts` moves it with the row).
- `handleVoiciRing` adds `tag = hex(HMAC-SHA256(tagKey, ringId))[0:32]` (16 bytes) to the ring push payload when the
  row has a key: `{kind:"voici-ring", ringId, hint, room, tag}`. Thread fetches don't need it.
- Locked phone: for each `rings` entry compute the HMAC over the push's `ringId` and compare in constant time; ≤50
  HMACs, microseconds.
- Leaks: APNs / FCM see a fresh random-looking 16 bytes per ring (the `ringId` is fresh each ring, so tags never
  repeat). `.com` learns a key bound to a row that already names the account. The page owner learns nothing.
- Changes: `.com` (migration, storage, handler, pusher), protocol (the derivation constant + vectors), iOS and Android
  (send on attach, table entry, locked match). No owner-side, webapp or voi.ci site change.

**(b) A ring-only key whose public half the owner seals a second hint to.**

- The caller app derives a per-page X25519 (or X-Wing) "ring key", keeps the private half in the table, attaches the
  public half; `.com` passes it to the owner on the inbox item; owner clients seal a second hint to it; the push
  carries both hints; the locked phone tries each ring key.
- Better integrity (`.com` can't make a ring show another page) but: every owner client (iOS, Android, webapp)
  changes its ring order; the owner now sees a second per-conversation public key; the push grows by another sealed
  hint (an X-Wing seal is about 1.1 KB, comfortably inside APNs' 5 KB VoIP limit but not free); trial decryption
  per entry. And the integrity gain is small, because the real hint is still opened and checked after the unlock
  before anything is dialled (§4.4).

**(c) Put `conv` (or a stable channel id) in the push.** Rejected: a stable identifier per conversation to APNs/FCM.

**(d) Guess "the page I called most recently".** Rejected: wrong as soon as two call-backs are attached.

**(e) Let the locked phone ask `.com`.** Rejected: no key a locked caller device holds can authenticate a thread
fetch (the call key is a page owner's key and signs only call answers), and it adds a network round trip during the
ring.

### 4.3 Recommendation: (a)

Smallest change, no owner-client or browser change, nothing new to APNs/FCM beyond unlinkable bytes, and `.com`
learns nothing it doesn't already hold.

Protocol additions (`packages/protocol/src/voiciCallModes.ts`):
- `TAG_VOICI_RING_TAG = "flagship/voici-ring-tag/v1"`, `deriveVoiciRingTagKey(messagesSecret, pageId)`,
  `voiciRingTag(tagKey, ringId)`.
- Shared vectors `packages/protocol/test-vectors/voici/ring-tag.json` (TS, Swift, Kotlin; webapp not needed).
- `parseVoiciRingBackBody` accepts optional `ringTagKey` (64 hex) and refuses any other shape (400 `malformed`).

### 4.4 Behaviour on Answer while locked

The table only names the ring. On Answer:
1. The phone asks for the app unlock (Face ID / biometric), as any ring-back does today; a ring-back can't be
   answered with the call key (it dials out as the caller's pseudonym, which needs the account).
2. After the unlock, open the real hint (`openRing` / `openRingHint`). If it opens and its `pageId` matches the
   cached one, dial. If it doesn't open, or names another page, end the ring as failed and log
   `ring-back-tag-mismatch` (reason only).

This also fixes today's dead end on iOS (`answerRing` gives up with `locked-no-page` instead of unlocking first);
Android already opens the app. Suggested as part of the same work: keep the push until the unlock and reopen the
hint then.

## 5. UX

Style: short plain sentences, no jargon ("key", "table", "encrypted" only where needed). Every string through
`i18n/<surface>/*.json` (`npm run i18n`), iOS first.

### 5.1 The setting

On Social → Calls settings (`VoiciCallsSettingsSection.swift`), as a second row under the existing toggle, shown only
while "Answer calls while Flagship is locked" is on:

> **Answer calls while Flagship is locked**  [on]
>
> **Show names while locked**  [on/off]
>
> Footer, setting off: "While Flagship is locked, callers show as “Visitor 4F3A” and call-backs as “Someone you wrote
> to”."
>
> Footer, setting on: "Your names for people you've talked to, and the pages that call you back, can show on the lock
> screen, a paired watch or a car. Anyone holding this phone can see them when a call comes in. They stay on this
> phone and are updated each time you unlock."

And the existing toggle's footer becomes (fixing the stale text): "This phone keeps a key that can answer calls and
nothing else, so you can answer from the lock screen. Your messages stay locked."

Why a separate row rather than one switch: answering from the lock screen and showing "Mom" there are different
choices (a shared family phone wants the first, not the second). The owner said "tied to": the names row exists only
under the answer toggle and goes off (and the table is erased) when it does. See D1 and D2.

### 5.2 First-time prompt

When the owner turns on "Answer calls while Flagship is locked" (it already asks for an unlock), show one sheet after
the call key is made:

> **Show names on the lock screen?**
>
> When someone you've talked to calls, this phone can show the name you gave them, even while Flagship is locked.
> Anyone holding the phone will see it too.
>
> [Show names]  [Not now]

"Not now" leaves the names row off; the sheet is not shown again (the row stays in settings).

### 5.3 What the ring shows

Incoming call to the owner's page (lock screen, CallKit / full-screen ring):

| App state | Setting | Caller | Shows |
|---|---|---|---|
| Unlocked | any | known nickname | "Mom" |
| Unlocked | any | no nickname | "Visitor 4F3A" |
| Locked, call key off | — | any | "Unlock Flagship to answer" (iOS) / the existing locked ring |
| Locked, call key on | names off | signed-in | "Visitor 4F3A" |
| Locked, call key on | names on | nickname + talked in 90 days | "Mom" |
| Locked, call key on | names on | nickname but never talked / > 90 days | "Visitor 4F3A" |
| Locked | any | anonymous browser | "Anonymous caller" |

The visitor name appears as soon as the room's signed request arrives (today's behaviour); the nickname can be shown
at the same moment (looked up from the request's pseudonym, not from the push).

Ring-back (a page this account called rings back):

| App state | Setting | Shows |
|---|---|---|
| Unlocked | any | "voi.ci/brisk-quartz" (today's `voi.ci/<username>` on iOS, `voici_calls_peer_page` on Android) |
| Locked | names off, or no entry | "Someone you wrote to is calling back" (one string on both platforms, replacing iOS "Someone on voi.ci" here) |
| Locked | names on, entry matches | "voi.ci/brisk-quartz is calling back" |

Answer while locked on a ring-back: "Unlock Flagship to call back" (§4.4).

Nothing else changes: no lock-screen list of names, no Calls tab while locked, no names in notifications other than
the ring itself.

## 6. Changes by component

| Component | Change |
|---|---|
| Protocol | ring-tag derivation + HMAC, vectors, `ringTagKey` in the ring-back body parser |
| `.com` / storage | migration 0158 (`ring_tag_key`), `putRingBack` stores it, `handleVoiciRing` adds `tag`, rename moves it, tests in `voiciCallModes` / `voiciCallKeys` suites |
| iOS (reference) | `VoiciLockedNamesStore`; rebuild hooks in `MessagesStore`; `attachRingBack` sends `ringTagKey`; `VoiciCallCenter.onSession` nickname lookup when `incomingPeer == nil`; `incomingRing` table match + "is calling back" strings; unlock-then-dial on locked Answer; settings row, footer, first-time sheet; erasure in `revokeCallKey` and `onWipe` |
| Android | the same in `calls/` + `core/voici/VoiciCenter.kt`: Keystore-wrapped file store, rebuild hooks, attach field, `VoiciCallCenter` lookup, `VoiciRingCenter` match, backup exclusion, settings row and sheet, erasure in `revokeCallKey` / `forgetLocal` |
| Webapp, voi.ci site | none (the webapp doesn't ring; the site's browser attach names no account) |
| Wear / watch | none directly; they mirror whatever the phone's ring shows (stated in the footer) |
| i18n | new strings in `i18n/ios`, `i18n/android`; retire the stale footer string |
| parity | rows `voici-locked-names` and `voici-ring-back-locked-name` in `parity/features.json` (iOS, Android; webapp n/a) |

Deploy order: `.com` with migration 0158 first (it ignores the field from old apps and sends no tag without a key),
then the store builds. Old apps keep today's generic ring.

## 7. Test plan

Shared / protocol
- Vectors for `deriveVoiciRingTagKey` and `voiciRingTag` (TS, Swift, Kotlin), including a different `ringId` giving
  an unrelated tag.
- `parseVoiciRingBackBody`: accepts no key, a 64-hex key; refuses other shapes.

`.com`
- Attach with `ringTagKey` stores it; a re-attach replaces it; a browser attach (no account) clears it.
- The ring push carries `tag` = HMAC(key, ringId) only when a key is stored; two rings give different tags; the push
  has no text fields (assert the payload keys exactly: `kind, ringId, hint, room, tag`).
- Stop / block / page removal / conv delete / expiry remove the key with the row; account rename moves it.

iOS (unit, `FlagshipMobileTests`; then the mock gym)
- Table builder: nickname + call in 90 days → entry; nickname without a call → none; blocked / forgotten / anonymous
  → none; > 50 → oldest dropped; > 90 days → dropped; deleted nickname → gone at the next rebuild.
- Store: item written `AfterFirstUnlockThisDeviceOnly`, no access control (assert the query attributes); not in an
  access group.
- Erasure: setting off, `onWipe` (sign out / remove this device), account gone, call key revoked → item absent.
- `lockedCallerName` path: request with a known pseudonym and names on → nickname; names off → "Visitor …".
- Ring-back: matching tag → page name; no match / no tag → generic; locked Answer → unlock then dial; hint mismatch
  after unlock → ends, `ring-back-tag-mismatch` logged; no nickname ever in `voiciCallLog`.
- Mock gym: settings row appears only under the answer toggle; first-time sheet once; footers match §5.

Android (unit + `VoiciAppTest` + emulator mock gym)
- The same builder, matching and erasure cases; the Keystore key is deleted with the file; the file is in the backup
  exclusion rules (parse `data_extraction_rules.xml` in a test); CallStyle and Telecom display name use the table
  name only when the setting is on.

Live / device (one green run, per the gym rule)
- Two phones: owner A (page), caller B. B calls A, A names B "Mom". Lock A's app, B calls: A's lock screen shows
  "Mom". Turn names off: "Visitor …". Block B on another of A's devices, unlock A once, lock, B calls: blocked
  anyway by `.com`; confirm the table entry is gone.
- B attaches a call-back, A rings back, B's app locked: "voi.ci/<A> is calling back"; Answer asks for the unlock,
  then dials. B's second device (never attached) shows the same name after one unlock.
- Sign out on B: the table is gone (iOS: check with a debug build's Keychain dump; Android: file and key absent).
- iOS restore from backup to a new phone: no table.

## 8. Owner decisions still open

1. **D1 Ring-back names for accounts without a page.** Ring-backs reach any device of the caller's account, but
   "Answer calls while Flagship is locked" only exists for admin devices of an account that publishes a page with
   calls on (`VoiciCallsSettingsSection.swift`, `store.isAdmin`, `v.showsWho`). Tying ring-back names to it means a
   person who only calls others never gets them. Recommended: show "Show names while locked" on its own for such
   accounts (controls ring-back names only), or accept the gap.
2. **D2 One switch or two.** Recommended two (answer / show names). If the owner wants one, the names come on with the
   answer toggle and the first-time sheet becomes a notice, not a choice.
3. **D3 "Had calls with" window and cap.** Proposed: any call except a failed one, last 90 days (matches the ring-back
   life), 50 entries. Should a missed call alone count (a stranger who rang once and was then given a nickname)?
   Proposed yes, since a nickname is the owner's deliberate act.
4. **D4 Sign the tag key.** Proposed unsigned (TLS + device headers; a forged key only hides the name). Signing it
   needs `voici-ring-back/v2`.
5. **D5 Answer a ring-back from the lock screen.** This design keeps "unlock to call back". Answering without the
   unlock would need a caller-side call-only key, a separate decision.
6. **D6 The Calls list in UserDefaults.** `VoiciCallHistory` on both platforms stores pages called and visitors'
   pseudonyms in plain app preferences, readable in an AFU extraction, with no setting. Recommended (separate
   change): move it behind the app lock (sealed under the account) or into the same AFU Keychain/Keystore-wrapped
   store, and stop keeping page names there when the account is locked.
7. **D7 iOS "Announce Calls", watch and car.** These repeat the name and we can't switch them off per call. Proposed:
   say so in the footer (done in §5.1) and nothing more.
