# F3: public re-pair state and replayable re-pair initiate (external report "Aldi", Low)

Investigated 2026-11-23 on `release/0.4` = `main` (`4416c542b`). Read-only: no code changed, nothing
posted to production. Production reads were `SELECT`s on D1 and one anonymous GET of a non-existent
account (`404 account-not-found`).

## Verdict

| Claim | Verdict |
|---|---|
| (1) `GET /api/users/{u}/re-pair` is unauthenticated and returns the whole pending row, proof included | **True** |
| (2) After the recoverer's self-cancel, replaying the original initiate body within 5 minutes arms a new pending row | **True**, and it is wider than reported: it also undoes an **admin veto** |
| "Takeover still needs more keys" | **True**: only the holder of the new IRK can complete, and on the path where a third party can rebuild the body, that holder already held the account's current key |

Severity: **Low** (agree). The two together let anyone who watches the public GET re-arm a cancelled or
vetoed recovery for up to 5 minutes after it was signed, without any credential. It gives the third
party nothing they can complete, and it gives the recoverer nothing they could not do anyway, but it
makes an admin veto non-durable against a stranger and costs the owner a second veto.

The researcher's source pin `eb43ae84c` matches: the cited route lines (`controlPlaneRoutes.ts:815`
regex, `:948` method table) are at `:994` and `:1154` on HEAD, the handler at `:3484-3491`;
`rePair.ts` moved by about 11 lines (`DEFAULT_MAX_AGE` `:258`, eviction `:786-803`, `handleGetRePair`
`:1600-1620`). `rePair.ts` changed between the pin and HEAD only in voi.ci call-key cleanup and a PQ
grant field, nothing in the reported paths.

## 1. What the GET returns, to whom

Route: `apps/com/src/controlPlaneRoutes.ts:3484-3491`, no `gateAccountRead` (compare `/pods` at
`:2931-2933`). Handler `packages/control-plane/src/rePair.ts:1600-1620`:

```
pending: { newIrkPub, oldIrkPub, initiatedAt, completesAt, objectedAt, vetoedBy,
           offlineAlertMs, proof: { issuedAt, newIrkSignature, oldIrkSignature? } }
```

To anyone, for any existing account (a non-existent one gets the account-gone 404, so it is also an
existence oracle, but `GET /api/username/:u` already is one). `oldIrkPub` is public anyway via the
username lookup; `vetoedBy` is the account's admin root public key; `proof` is new since D1 0105
(`packages/storage/migrations/0105_re_pair_proof.sql`), added so boxes can check a re-pair themselves.

## 2. Why it is public, and who reads it

It began as a public status read (M4) for the clients' "Replace pending" banner; 0105 then put the proof
in it for the box, and 0108 added `vetoedBy` for the veto UI. No reader sends credentials today.

| Reader | Code | Fields used | Can it authenticate? |
|---|---|---|---|
| Box re-pair watcher | `packages/server-daemon/src/postRecovery/rePairWatcher.ts:396-402` (poll every 5 min, wired at `server-daemon/src/index.ts:5527-5531` with bare `fetch`) | `newIrkPub`, `oldIrkPub`, `initiatedAt`, `objectedAt`, **`proof`** (verified at `:109-152`) | Yes: the box already mints an STK read token (`BoxReadToken`, used by `aliasReconciler.ts:41`); `requireAccountRead` accepts `s:` server tokens (`packages/control-plane/src/accountReadToken.ts:258-261`) |
| Webapp Trusted devices (banner, own-replacement finalize, admin veto) | `apps/web/public/webapp/lib/replaceDeviceCeremony.js:361-388`, `views/trusted-devices.js:117-127, 239-241, 351-379` | `newIrkPub`, `completesAt`, `initiatedAt`, `objectedAt` (veto signs `newIrkPub`, `initiatedAt`, `completesAt`) | Yes: a signed-in session; it already holds a read token for `/pods` |
| iOS Settings | `apps/mobile/shared/Sources/FlagshipAPI/Client/FlagshipServerClient.swift:4463-4482`, `ios/.../SettingsViewModel.swift:204-213`; model `:851-871` (`oldIrkPub` non-optional) | same + `oldIrkPub` (decode), `vetoedBy` | Yes (device read token) |
| Android Trusted devices | `android/.../api/FlagshipServerClient.kt:1926-1944`, `viewmodels/TrustedDevicesViewModel.kt:166-192`; model `api/ScreensModels.kt:1385-1393` (`oldIrkPub` required) | same | Yes (device read token) |
| Studios, gym live-e2e | none | none | n/a |

No client reads `proof` or `offlineAlertMs`; only the box needs `proof`. Every reader that matters is a
device of the account or one of its servers, so every one of them can carry an account read token.

The veto path does not need a public read: the veto is signed by the pinned admin root
(`rePair.ts:930-1017`), so a vetoing device is necessarily a signed-in admin device that can mint a
device read token. There is deliberately **no** old-key veto: `/re-pair/object` is self-cancel by the
new key (`rePair.ts:1063-1083`, `docs/v1.2-security-cascade.md` "Recovery threat model"), so "an old
device that lost its key must see the pending row in order to veto" is not a case that exists. A
device without keys can do nothing with the row except read the banner.

## 3. Replay: real, and it reaches the admin veto

Initiate (`rePair.ts:260-918`): checks only `|now - issuedAt| <= 5 min` (`:329-331`, so the window is up
to 5 minutes either side of the client's clock), the new-IRK signature (`:423`) and a credential
(`:513-728`). Nothing records that an envelope was used. Then the eviction (`:786-803`):

```ts
const vetoed = typeof existing.objectedAt === "number";   // :797
if (vetoed || pastCompletionWindow) await deps.pendingRePairs.delete(r.username);
```

`objectedAt` is set by both the self-cancel (`d1.ts:3089`) and the **admin veto**
(`d1.ts:3098`, which also sets `vetoed_by_hex`). So any valid initiate evicts an admin-vetoed row too,
and inserts a new row with `initiatedAt = now` and a fresh `completesAt` (`:805-826`), a new T+0 push and
a new `re-pair-initiated` audit row.

Who can build a valid body:

- **Registered-key initiates** (`oldIrkSignature`; used by Replace device, key-file import and login
  takeover on all three clients): the whole body is `request{username,newIrkPub,oldIrkPub,issuedAt}` +
  `signature` + `oldIrkSignature`, and the public GET returns every one of those values
  (`proof.issuedAt`, `proof.newIrkSignature`, `proof.oldIrkSignature`, `newIrkPub`, `oldIrkPub`).
  **A third party can rebuild an accepted initiate from the GET alone.** All production rows are this
  kind (below).
- TOTP initiates: the code is not in the GET; codes are not single-use (`totp.ts:621-652`, ±1 period),
  so only the recoverer can replay, for about a minute.
- Recovery-code initiates: the code is consumed (`rePair.ts:687-701`); a replay fails.
- Recovery-credential (`recoveryProof`) initiates: the token is not in the GET; it is bearer for its
  5-minute TTL (`recoveryProof.ts` header already documents this exact self-cancel-then-replay residual),
  so only the recoverer can replay.

So, to the key question: **yes, a third party who saw a pending registered-key re-pair can undo the
real owner's admin veto by replaying, if the veto landed within 5 minutes of the attempt's `issuedAt`**
(realistic: the T+0 push goes out at once). What it does and does not give them:

- They cannot change the new key; `/re-pair/complete` must be signed by the new IRK
  (`rePair.ts:1281-1350`), so only the original recoverer can finish. The old veto body cannot be
  replayed onto the new row (it binds `initiatedAt`/`completesAt`, `rePair.ts:952-957`; tested in
  `packages/control-plane/tests/rePairVeto.test.ts:78-87`), so the admin must veto again (biometric).
- If the recoverer is hostile, they hold the account's current key (that is what a registered-key
  initiate proves), so they can re-sign a fresh initiate at will; the veto is by design not durable
  against a credential holder ("a retry starts a fresh full wait, and recovery is never disabled",
  `rePair.ts:922-928`). The stranger adds nothing they could not do.
- The real harm is to an owner who vetoed and stopped watching: a stranger can quietly put the attempt
  back on the clock, and if the second push is missed, the recoverer can complete at the end of the
  grace. And for an honest recoverer who cancelled their own attempt, a stranger can re-arm it, which
  holds the account's one-row lock (409 for a new attempt) until it is cancelled again by the same UMK's
  next key or vetoed. Per-account initiate budget (3 per 15 min, `apps/com/src/rateLimit.ts:374-377`)
  bounds the replays to about two.

Unrelated to the report but noted: the box watcher also reads `objectedAt` publicly; nothing there
changes with the fix except that the read needs a token.

## 4. Severity

**Low.** Information disclosure (whether and when an account is mid-recovery, its admin root key, and a
complete replayable envelope) plus a 5-minute, credential-free re-arm of a cancelled or vetoed attempt.
No takeover, no key change, nothing a recoverer could not already do. Aggravating detail beyond the
report: it also defeats an admin veto, not only a self-cancel. Mitigating: the veto design already
allows any credential holder to restart, every re-arm pushes the owner and lands in Activity.

## 5. Fix

### (a) The GET

No caller needs an anonymous answer. Plan, in deploy order:

1. **Box (endorsed release first).** `RePairWatcher` gets the box's `BoxReadToken.fetch` instead of bare
   `fetch` (`server-daemon/src/index.ts:5531`; same shape as `aliasReconciler.ts`). Harmless against
   today's `.com`, which ignores the header.
2. **`.com`, step 1 (compatible with every shipped client).** In `handleGetRePair`, return `proof` and
   `offlineAlertMs` only when `requireAccountRead` passes (any of `irk`, `d:`, `s:`). The anonymous
   answer keeps exactly the 0.3 store-build shape (`newIrkPub`, `oldIrkPub`, `initiatedAt`,
   `completesAt`, `objectedAt`, `vetoedBy`): both native models require `oldIrkPub`
   (`FlagshipServerClient.swift:851-856`, `ScreensModels.kt:1385-1389`), and the veto needs
   `newIrkPub`/`initiatedAt`/`completesAt`. This alone kills third-party reconstruction of the
   initiate. Old boxes then lose the proof path (`verifyRePairSwap` returns null; admin-pinned boxes
   still have the rotation path) and keep the old IRK until updated: fail-safe, acceptable under
   "pre-release, break old servers". Demo accounts pass `requireAccountRead` without a token
   (`accountReadToken.ts:237`), so demo boxes and clients are unaffected. Do not ship this before
   step 1: a box that sees a token-less row stores it in `unverified` without the proof and can never
   verify it later.
3. **Clients (0.4 webapp shell, iOS, Android).** Send the account read token they already hold for
   `/pods` on this GET (webapp `fetchPendingRePair`, Swift `fetchPendingRePair`, Kotlin
   `fetchPendingRePair`).
4. **`.com`, step 2 (owner decision, see questions).** Gate the whole GET with `gateAccountRead`
   (401 without a token). 0.3 store builds then lose the banner and the Reject recovery button (all
   three catch the error and hide the banner; Android's `accept` set is 200/404/405, so a 401 throws and
   is caught in `TrustedDevicesViewModel`). Do it when 0.3 builds are retired, or keep step 1's
   anonymous shape until then.

Add `ACCOUNT_READ_HEADERS` (`no-store`) to the answer as `/pods` does. Tests: anonymous answer has no
`proof`; a server token gets it; a revoked device token does not; demo account passes.

### (b) Replay and veto durability (`.com` only; no client or box change)

1. **A cancelled attempt cannot be revived by anything signed before it was cancelled.** In the
   eviction block (`rePair.ts:794-803`), when `existing.objectedAt` is set, refuse (409,
   `reason: "re-pair-cancelled-replay"`) an initiate with `r.issuedAt <= existing.objectedAt`. Covers
   both the self-cancel and the admin veto, needs no migration, and keeps the design's "a fresh retry
   starts a fresh wait" (a fresh retry is signed after the cancel). Also refuse when
   `existing.proof?.issuedAt === r.issuedAt && existing.newIrkPubHex === r.newIrkPub` (exact replay
   while the old row is still there, e.g. past its completion window). False positive only if the
   retrying device's clock is behind `.com` by more than the time since the cancel; the user retries a
   minute later.
2. **Single-use envelopes (recommended hardening, closes the older-attempt residual and the recoverer's
   own TOTP / recoveryProof reuse).** A table like `recovery_challenges_used` (D1 0112,
   `d1.ts:3379-3381`: `INSERT OR IGNORE`, `expires_at` swept on write): `re_pair_initiates_used
   (digest_hex PRIMARY KEY, expires_at)` with `digest = SHA-256(canonical RePairInitiate bytes)`,
   `expires_at = issuedAt + DEFAULT_MAX_AGE + margin`. Claim it after every check passes and before the
   eviction; a lost claim is 409. Next migration number is **0160**. Optionally record the TOTP step and
   the `recoveryProof` token digest the same way so each credential use is single-use too.
3. Optional: tighten the freshness check to `issuedAt` no more than ~60 s in the future (it is ±5 min
   today, `rePair.ts:329-331`), which halves the worst-case window.

Compatibility: (b) changes nothing for honest clients (each initiate is freshly signed); old store
builds and boxes are untouched. Tests to add in `packages/control-plane/tests/rePair.test.ts` /
`rePairVeto.test.ts`: replay after self-cancel 409; replay after admin veto 409 and the vetoed row is
kept; a fresh initiate after the veto succeeds; replay of an older attempt after a newer one died 409
(with 2.).

## 6. Production (read-only, counts only)

- `pending_re_pairs`: **2 rows, 0 live** (none pending, none claimed for completion, none past their
  window). 1 self-cancelled, 1 admin-vetoed. Both carry a proof with `oldIrkSignature` (registered-key),
  both real accounts (not demo), both with the 3-day single-device grace.
- The self-cancelled row was started 2026-11-19 04:30 UTC and cancelled **657 ms** after it was
  initiated (scripted, consistent with the researcher's tests). Its account shows **6**
  `re-pair-initiated` audit events between 2026-11-17 and 2026-11-19, all registered-key, two distinct
  new keys: consistent with their initiate / cancel / replay testing. Nothing of theirs is pending.
- The vetoed row (other account) was started 2026-11-06 and vetoed about 17 hours later, outside any
  replay window; it has one initiate event.
- Last 30 days in `audit_events`: 7 `re-pair-initiated` (2 accounts), 1 `re-pair-vetoed`,
  1 `re-pair-refused-no-credential`.

## Owner questions

1. Gate the whole GET now (0.3 store builds lose the pending banner and Reject recovery until they
   update), or ship step 1 (proof behind a token, 0.3 shape stays public) now and gate fully once 0.3
   builds are retired?
2. Is the no-migration rule (b1) enough for 0.4, or add the single-use table (b2, migration 0160) now?
3. Should an admin veto be more than "this attempt only", for example refusing the same new key for some
   hours after a veto, or requiring a non-registered-key credential to retry? Today a holder of the
   account key can restart at once by design.
4. Credit "Aldi" in the hall of fame (Low, two findings)?

## Resolution (2026-11-23, branch `0.4/re-pair-fix`)

Owner decisions (2026-11-23): gate the whole GET now (breaking 0.3 store builds and un-updated boxes is accepted
for this fix), add the single-use table, and make a veto hold for a day against the vetoed key. Answers to the
questions above: (1) gated fully, (2) both b1 and b2, migration **0161** (0160 went to F2), (3) a 24-hour block on
the vetoed new key, (4) open.

- **The GET** (`apps/com/src/controlPlaneRoutes.ts`, `RE_PAIR_GET`) goes through `gateAccountRead` like `/pods`:
  a read token minted by a device of the account (`d:`), its IRK, or one of its servers (`s:`); demo accounts read
  without one. No token is the same 401 `/pods` answers (`private, no-store`), with nothing of the row. Authorized
  readers keep every field (the box needs `proof`; the clients `newIrkPub`, `oldIrkPub`, `initiatedAt`,
  `completesAt`, `objectedAt`, `vetoedBy`). `docs/account-read-token.md` lists it.
- **Box**: `RePairWatcher` takes a `readToken` (`BoxReadToken`, STK-minted) instead of a bare `fetch`
  (`server-daemon/src/index.ts`); when no token can be minted the read goes without one, as `ownDepositFetch`
  does (a demo account is let in). A 401 is an error like any other: the watcher keeps its last row and the IRK it
  trusts, applies nothing and polls again; once the read works a proven swap applies as before (tested).
- **Clients**: the webapp reads through `accountReadFetch` (shell **v252**); iOS `fetchPendingRePair` through
  `sendAccountRead`; Android through its account-read path. A 401 hides the banner as a paused `/pods` read does.
- **Replay** (`packages/control-plane/src/rePair.ts`), checked before any credential is spent:
  (b1) an initiate by the same new key dated at or before that row's cancel or veto: 409
  `re-pair-cancelled-replay`; the exact envelope of a dead row: 409 `re-pair-replay`.
  (b2) `re_pair_initiates_used` keeps the SHA-256 of each accepted initiate's canonical bytes (until
  `issuedAt` + 5 min + 1 min) and of the credential it spent: a TOTP code (3 min) or a recovery-session token
  (`flagship/re-pair-credential-used/v1|…`); a second use is 409 `re-pair-replay` or `re-pair-credential-used`
  (recovery codes were already consumed). Claimed only after every check passes and after the live-row
  "already pending" check, so a TOTP retry or a busy account does not burn the envelope. Expired rows are swept
  on each write, as `recovery_challenges_used` (no cron).
  `issuedAt` more than 60 s ahead of `.com` (or 5 min behind) is 403 `re-pair-stale`.
- **Veto**: a successful admin veto writes `re_pair_vetoed_keys` (account, new key, now + 24 h); an initiate with
  that key before then is 409 `re-pair-vetoed-recently` with `until` and `retryAfterSec`. The vetoed row carries
  the same rule while it exists. A self-cancel writes nothing. Account rename moves the block.
- **Migration 0161** (re-runnable): `re_pair_initiates_used`, `re_pair_vetoed_keys`; `KNOWN_MIGRATIONS`, the
  deploy sheet (§3b). Rate-limit budgets unchanged.
- **Deploy order**: 0161 → `.com` (with the v252 shell) → endorsed box release → iOS 1.3 / Android 13. Meanwhile a
  box without the release reads 401 and applies no re-pair (fail-safe; it applies a proven one after it updates), and
  0.3 store builds show no pending-recovery banner or Reject recovery button and word a vetoed-key retry as
  "already pending".
- **Sentences** (webapp `lib/rePairRefusal.js`, iOS `RePairRefusalText`, Android `RePairRefusalText`; machine
  drafts in the six languages): `re-pair-vetoed-recently` "An admin of this account rejected a recovery with this
  device less than a day ago. You can try again after a day, or ask the admin."; `re-pair-replay` and
  `re-pair-cancelled-replay` "This recovery request was already used. Start the recovery again.";
  `re-pair-credential-used` "That code was already used for a recovery. Wait for a new code, or repeat the
  recovery step, and try again."; `re-pair-stale` "This device's clock doesn't match Flagship's. Set the date and
  time to automatic, then try again."
- Tests: `apps/com/test/rePairReadRoute.test.ts` (no token 401 like `/pods`, other account's token 401, device
  token, revoked device, box token with the proof, demo), `packages/control-plane/tests/rePairReplay.test.ts`
  (replay after self-cancel, after admin veto, exact reuse of a dead row, reuse after the row was replaced,
  honest retry, live row, future skew, recovery-token and TOTP reuse, the 24 h block and its end, another key,
  the block surviving a replaced row, no block after a self-cancel), `packages/storage/tests/rePairSingleUse.test.ts`
  (both adapters over the migration), `packages/server-daemon/tests/rePairWatcher.test.ts` (the token on the GET,
  fail-safe on 401, never let in never swaps).
