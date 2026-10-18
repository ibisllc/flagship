# Account gone: a signed-in device whose account no longer exists

Owner decision 2026-10-18 (task N1). After the pre-GA wipe every account except
the store-review demo is deleted. A device that is already signed in keeps its
identity and keeps calling `.com`. This is the one contract that lets it say, in
plain words, that its account is gone. Typed-name sign-in already says "No
Flagship account by that name" (`account/resolve`, `kind: "unknown"`); this is
the other half, for a device that never types a name.

Web is done (webapp shell v145). iOS and Android implement it from this
document (parity row `account-gone`).

## What `.com` answers

For an account that does not exist, every route in the table below answers

```
HTTP/1.1 404
content-type: application/json
cache-control: private, no-store
vary: authorization

{ "error": "account-not-found", "code": "account-not-found" }
```

- The check runs before any auth check, so no token, signature or header is
  needed and every caller gets the same answer. It never names another account.
- "Exists" is exactly what the public `GET /api/account/resolve/<name>` already
  reveals: a `usernames` row, or a demo account (a demo being cleaned up,
  `cleanup-only`, counts as gone, as `resolve` already says `unknown`).
  Demo accounts and the store-review account are unaffected.
- A real account keeps its normal answers (401 without a read token, 403 for an
  unauthorized signer, 200 with one).
- The 429 limiter runs before the route, so these answers are counted like any
  other. (The read-token mint has no limiter budget of its own today.)
- Code: `packages/control-plane/src/accountGone.ts`; the table is
  `ACCOUNT_GONE_ROUTES` in `apps/com/src/controlPlaneRoutes.ts`; tests
  `apps/com/test/accountGoneRoutes.test.ts`.

### Routes that answer it (path account is `<u>`, any method unless noted)

| Calls | Paths |
|---|---|
| Read token | `POST /api/accounts/<u>/read-token` |
| Servers and activity | `/api/users/<u>/pods`, `/stream`, `/audit`, `/outstanding-orders` |
| App names | `/api/users/<u>/apps/aliases`, `/apps/<id>/links`, `/apps/<id>/rename` |
| Device book | `/api/users/<u>/device-grants`, `/device-grants/revoke` |
| Directory and profiles | `/api/accounts/<u>/profile`, `/directory`, `/devices/<d>/profile`, `/managed-profile`, `/directory-key-grant`, `/devices/<d>` |
| Server order | `POST /api/accounts/<u>/server-order` |
| Account lists | `/api/users/<u>/trust-exceptions`, `/service-invites`, `/server-shares`, `/server-shares/list`, `/watch-delegates`, `/acme-account-keys`, `/admin-root-rotations` |
| Account and recovery state | `GET /api/users/<u>`, `GET /api/users/<u>/re-pair` |

Not on it, on purpose: lookups other accounts make about a name
(`pubkey-cert`, `account-key-attestation`, `server-shares/<id>/unlock|revoke`,
`service-invites/.../create|revoked-since`), the recovery, TOTP and device-admit
ceremonies, `account/resolve`, `users/check`, `username/*`. They keep their own
answers.

What a deleted account got before (audited 2026-10-18 against an empty D1):
`/pods`, `/stream`, `/audit`, `/apps/*`, `/device-grants` answered 401 ("an
account read token is required"), so a client could only show "status paused";
`/profile`, `/directory` and `read-token` answered 403 "not authorized";
`trust-exceptions`, `watch-delegates`, `acme-account-keys`,
`admin-root-rotations` and `re-pair` answered an empty 200; the POSTs answered
400 "malformed". Nothing answered 500.

## What a client does with it

1. Treat a response as "my account is gone" only when ALL hold: status 404, the
   body's `code` is `account-not-found`, and the account in the request path
   (`/api/users/<u>/...` or `/api/accounts/<u>/...`) is this device's own
   account (its account name; lowercase compare). A 404 for another name, such
   as the owner of a shared server, or a 404 without the code, changes nothing.
2. On the first such answer, once: close every menu, dialog and sheet (the lock
   sweep), show the full-screen state below over whatever view is up, make the
   rest of the page unreachable.
3. Stop asking. Poll loops (live sync, inbox, status, health) stop; any later
   call that names that account is answered locally with the same 404 and sends
   nothing. No retry, no backoff storm. Error toasts and alerts for failed
   calls stay quiet while the screen is up.
4. The screen:
   - Title: `This account was removed`
   - Body: `This account no longer exists on Flagship. This can happen after a reset.`
   - Small line with the account name: `Account: <name>`
   - Primary button `Create a new account`: remove this device's copy (below),
     then open the create flow.
   - Secondary button `Remove it from this browser` (phones: `Remove it from this
     device`): remove this device's copy, then the welcome view. If another
     saved account remains on the device, go to its normal sign-in instead.
   - No data-loss or recovery claims: the screen says what happened and nothing
     else. Sentence case, no em dashes.
5. "Remove this device's copy" forgets everything the device holds for that
   account and nothing about other accounts: the stored device key and any PIN
   or biometric wrap of it, the sealed admin-root record, held secured
   sessions, the saved profile (account id, device id, per-profile settings,
   server tokens), held read tokens, the unlocked session, cached server lists.
   When no account is left, also the bootstrap's default key record (the first
   account's key is created there and copied, so it would otherwise bring the
   unlock screen back after a reload). It talks to no server.
6. A demo account that was cleaned up gets the same screen.

Web files: `lib/accountGone.js` (state, no imports), `lib/accountGoneUi.js`
(screen and removal), the detection in `lib/comFetch.js` (global fetch guard)
and `lib/accountRead.js`, poll stop in `lib/liveSync.js`, toast quiet in
`lib/toast.js`. Gym: `apps/web/e2e/gym/gym-gone.spec.ts` (4 scenarios),
registry `tools/gym/src/suites/webGone.ts`; unit
`apps/web/tests/webappAccountGone.test.ts`.

## Native notes

- iOS: one place sees every answer (the `FlagshipServerClient` request path);
  put the check there, publish the state on the app model, and stop the
  `liveSync`/status tasks from it. The Release build has no mock clients, so
  the mock-gym scenario goes behind the same `#if DEBUG` seam as the others.
- Android: the same in the shared HTTP client; the state lives in the app
  scope; stop the polling coroutines; also clear the Keystore alias and the
  encrypted prefs.
- Old store builds (iOS 1.0 build 4, Play versionCode 8) have no handling and
  show their usual paused or unlock state.

## Known edges

- If someone re-claims the same name after the wipe, the old device's calls get
  the new account's normal 401 or 403, not this 404: `.com` cannot tell them
  apart without a signed request, and a signed request that fails for a
  different key is a separate "this account is now someone else's" case that
  this contract does not cover.
- The web screen only shows after the browser makes its first account call. A
  browser sitting on the unlock screen finds out right after it unlocks.
