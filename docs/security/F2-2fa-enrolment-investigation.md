# F2: "Enable multi-device + 2FA" shows "Network error" (external report, Low)

Investigated 2026-11-23 on `release/0.4` = `main` (`9f83d2121`). Read-only: no code changed, nothing
posted to production. The deployed webapp files for this flow (`lib/totp.js`, `lib/humanError.js`,
`views/account-security.js`, `keystore.js`) are byte-identical to the tree (SHA-256 compared against
`https://webapp.flagshipserver.com/<file>`).

## Verdict

A functional bug plus a misleading message, not a security hole. The flow is not broken for everyone
in the code we can test: a signed `enroll-begin` through the real Worker entry (`route()`, SQLite D1,
a 64-hex KEK, webapp `Origin`) returns 200 with the CORS header and the QR. The production KEK is set
and works (one account has a staged secret, so `encryptTotpSecret` and the D1 write ran there).

The webapp says "Network error — check your internet connection." for anything the browser reports as
a `TypeError` and for its own pre-flight guards, so the sentence covers at least four different causes.
We cannot tell which one the reporter hit (no Worker logs are kept, see below). Ranked:

1. **The Worker threw, and the browser saw a CORS failure (most likely if the reporter was really
   online).** `.com` has no top-level catch: `apps/com/src/index.ts:29` → `route()` →
   `routeImpl` (`apps/com/src/route.ts:621`); CORS is added only to a response `routeImpl` returns
   (`route.ts:622`, `applyCors` at `route.ts:1620`). Any exception (a D1 error, a bad secret, a bug)
   becomes Cloudflare's 1101 page, and a CPU kill (1102) or a Cloudflare security challenge is the same:
   none carry `access-control-allow-origin`, so `fetch()` from `webapp.flagshipserver.com` rejects with
   `TypeError: Failed to fetch` and `humanError` (`apps/web/public/webapp/lib/humanError.js:89`) calls it
   a network error. Reproduced locally: the same request with a 62-hex KEK makes `route()` throw
   (`FLAGSHIP_TOTP_KEK must be 32 bytes`, `packages/control-plane/src/totp.ts:221-225`) instead of
   answering; in a browser that is exactly the reporter's message. (Production's KEK is fine; this only
   shows the class.) A Cloudflare bot challenge on a POST from a VPN, Tor or datacenter address would also
   land here: a likely environment for a security researcher. Zone security settings were not checked
   (no API token).
2. **The client's own guard with status 0.** `signedPost` throws `status: 0` when `session.username` is
   empty (`apps/web/public/webapp/lib/totp.js:78`; also `:79` for no UMK). The view checks only
   `session.umk` (`views/account-security.js:318`), and `humanError` maps status 0 to "Network error"
   (`humanError.js:125-128`). With an empty username `fetchAccountType` returns nulls
   (`totp.js:57`), the page renders "Single-device account" with the Enable button, and the click
   fails with "Network error" without any request leaving the browser. `unlockSession` fills the name
   from the profile store or `""` (`lib/state.js:43`); not proven to happen, but nothing prevents it.
3. **Any other `TypeError` in the click path** (a bug in signing, a `null` body read on a 2xx at
   `totp.js:116` → `totpEnrollBegin` reading `body.secret`) is shown as "Network error" too
   (`humanError.js:89`: every `TypeError` counts as offline).
4. **A real transport failure** (an extension, a DNS filter or corporate proxy blocking
   `flagshipserver.com/api/...`). The reporter says other pages work, so this is least likely.

Not the cause: the CSP (`connect-src` includes `https://flagshipserver.com`, checked on the live
header), CORS preflight (live `OPTIONS` answers 204 with the webapp origin and `content-type`
allowed), routing (the route exists, `apps/com/src/controlPlaneRoutes.ts:996`, `:3420`; a live `GET`
on the path answers 404 with CORS, so the Worker reaches it), version skew (deployed webapp = tree,
and `.com` is deployed from the same commit), rate limits (no budget on enroll-begin), passkeys or
WebAuthn (this flow uses none: it signs with the IRK through WebCrypto Ed25519,
`keystore.js:739-745`; a browser without Ed25519 could not have unlocked the webapp at all, and its
`NotSupportedError` would read "That didn't work", not "Network error"). A wrong IRK (403) or an unknown
account (404) also show other sentences.

## 1. The flow

**Webapp** (`apps/web/public/webapp/views/account-security.js`)

- Button: `renderActions`, label `tr("Enable multi-device + 2FA")` (`:208`), click handler `:316-341`.
- Page load: `GET https://flagshipserver.com/api/users/<u>` (`lib/totp.js:50-63`), public, returns
  `accountType` and `totpEnrolledAt` (`packages/control-plane/src/usernameClaim.ts:187-196`).
- Enable: `totpEnrollBegin` (`lib/totp.js:132`) signs `flagship/totp-enroll-begin/v1|<u>|<issuedAt>`
  with the IRK (`totp.js:90`, `keystore.js:739`) and `POST`s
  `https://flagshipserver.com/api/users/<u>/totp/enroll-begin` `{request, signature}` (`totp.js:96`).
  Cross-origin (webapp. → apex), JSON, so a preflight. No other origin is contacted.
- Step 3: `POST .../totp/enroll-confirm` with the 6-digit code (`totp.js:156`), returns 10 recovery codes.
- Disable: `POST .../totp/disable` with a live code (`totp.js:181`).
- Errors: 503 → "Two-factor isn't enabled on this server yet" (`:333-336`); everything else →
  `humanError(e)`, which drops the server's reason (`humanError.js:113-144`).

**Server** (`packages/control-plane/src/totp.ts`): `handleTotpEnrollBegin` `:720-816` checks shape,
username, freshness (403 `stale request`), account (404), IRK signature (403 `invalid signature`),
encrypts a fresh secret under `FLAGSHIP_TOTP_KEK` and writes it to `usernames.totp_secret_encrypted`
(`:782-784`), returns secret, otpauth URL and a QR PNG.

**String paths to "Network error — check your internet connection."** (`humanError.js:29`, i18n key in
`i18n/webapp/en.json:1641`): `e.code === "network"`, any `e.name === "TypeError"`, a message containing
"failed to fetch" / "networkerror" / "network error" / "load failed" (`:85-97`), or `status === 0`
(`:125-128`). For this flow that is: a rejected fetch (offline, blocked, or a CORS-less error page from
the Worker or Cloudflare), the status-0 guards in `totp.js:78-79`, and any thrown `TypeError`.

**iOS** (`apps/mobile/ios/Sources/FlagshipUI/ViewModels/AccountSecurityViewModel.swift:125-168`,
`Screens/AccountSecurityScreen.swift:110-146`): the same three routes through `FlagshipServerClient`
(`apps/mobile/shared/Sources/FlagshipAPI/Client/FlagshipServerClient.swift:252`, `:3713`). Named "Code
protection" ("Turn on code protection"), not "multi-device + 2FA". Errors are staged (key access,
signing, server) and go through `UserErrorText.of` (`shared/Sources/FlagshipAPI/UserErrorText.swift`),
which tells offline, dropped, timeout and server problems apart; a native app has no CORS, so a Worker
1101 arrives as a 500 → "Service temporarily unavailable". iOS is the honest reference.

**Android** (`apps/mobile/android/app/src/main/java/com/flagshipserver/app/viewmodels/AccountSecurityViewModel.kt:85-124`):
same routes, "Turn on code protection". The server step puts the raw exception text on screen
(`couldnt_start_enrollment` = "Couldn't start enrollment: %1$s" with `e.message`, `:116-123`) and decides
503 by `msg.contains("503")`; confirm and disable do the same (`:164-172`, `:215-222`). It does not use
`UserErrorText` there, unlike its signing step (`:97-98`).

## 2. Production checks (read-only)

| Check | Result |
|---|---|
| Shell CSP `connect-src` (live header on `webapp.flagshipserver.com`) | `'self' https://flagshipserver.com wss://flagshipserver.com https://*.flagshipserver.com ... https://*.flagship.services ...`: allows the flow |
| `OPTIONS /api/users/x/totp/enroll-begin` with the webapp origin | 204, `access-control-allow-origin: https://webapp.flagshipserver.com`, `content-type` allowed, POST allowed |
| `GET /api/users/<missing>` | 404 JSON with CORS |
| `GET` on the enroll-begin path | 404 with CORS (Worker reaches the control plane; POST not sent, by instruction) |
| Deployed webapp files vs tree | identical |
| `FLAGSHIP_TOTP_KEK` secret | set (`wrangler secret list`) |
| D1 `usernames` (31 non-demo accounts) | 0 enrolled (`multi`), 1 with a staged but never confirmed secret, 30 never started |
| D1 `audit_events` | no `totp-*` or `account-type-changed-*` rows ever |
| Worker logs | none kept: no `[observability]` in `apps/com/wrangler.toml`; `npm run ops -- workers` needs an analytics token we don't have; `wrangler tail` is live only, useless without a reproduction |

So no production account has ever completed 2FA enrolment, and one began it without finishing (we
cannot tell whether that was the reporter).

## 3. Impact

- Functional: a web user who hits this cannot turn on code protection from the browser. They can from
  the iOS or Android app (same account, same server routes), assuming the cause is the browser path
  (CORS-less errors) and not a server-side failure that would hit the apps too.
- Security: nothing crosses a boundary. The error hides the real cause and makes support guess, and a
  user may believe they are protected when they are not (they are not: the badge stays "Single-device").
- The reporter's environment (VPN, privacy extension, bot challenge) is a plausible trigger for cause 1;
  either way the bug is the message.

### Related findings from reading the code (not in the report)

- **A second `enroll-begin` overwrites a live secret.** `handleTotpEnrollBegin` does not check
  `accountType`/`totpEnrolledAt`; it replaces `totp_secret_encrypted` at once (`totp.ts:782-784`). On an
  enrolled account, any device holding the IRK (any member device, not just an admin) that taps Enable
  (iOS and Android hide it when enrolled; a stale page or a second browser does not) silently kills the
  owner's authenticator for recovery until a confirm finishes, and a confirm replaces the recovery
  codes without a code from the current authenticator. Low to Medium (integrity / lock-out of the
  recovery factor; the actor already holds the account key).
- **A staged secret counts as a recovery credential.** Re-pair treats any `totp_secret_encrypted` as an
  enrolled TOTP method (`packages/control-plane/src/rePair.ts:466`, `:544-546`), so an abandoned
  enrol-begin (Cancel does not clear it on the server) leaves a live code factor on a single-device
  account that the owner may not know about. Low: only the browser that began it ever saw the secret,
  but if it was shown and walked away from, it is a credential nobody remembers. One production account
  is in this state.
- **Enabling and disabling 2FA are IRK-only**, while the owner rule says only admins change security
  posture (ranks). Owner question below.
- **Wording differs**: webapp "Multi-device + 2FA", iOS/Android "Code protection".

## 4. Fix plan

### `.com` (server)

1. **Never answer without CORS.** Wrap `routeImpl` in `route()` (`route.ts:621`) in try/catch: on a
   throw, `console.error` one content-free line (route template, error class, a request id; never the
   username, body or IP) and return `500 {error: "internal-error", code: "internal-error", requestId}`
   through `withSecurityHeaders(applyCors(...))`. Then a server failure reaches the webapp as a 500 and
   reads "Our service is briefly unavailable", not "Network error". Test: a route that throws still
   carries `access-control-allow-origin` (`apps/com/test/`).
2. **Count failed enrolments, no personal data.** A small hourly counter like `rate_limit_log`
   (migration: `endpoint`, `outcome` code such as `ok`, `stale`, `bad-signature`, `unknown-account`,
   `not-configured`, `internal-error`, `count`), written for `totp/enroll-begin|enroll-confirm|disable`,
   readable by an admin route and `npm run ops`. Optionally turn on Workers Logs
   (`[observability] enabled = true`, sampled) once item 1 guarantees the lines are content-free: owner
   decision, since it stores console output at Cloudflare.
3. **Don't let begin touch a live secret.** Stage the new secret in its own column
   (`totp_pending_secret_encrypted` + `totp_pending_at`, migration), move it to the live column only in
   `enroll-confirm`; refuse `enroll-begin` on an enrolled account with `409 code: totp-already-enrolled`
   (re-enrolment = disable with a live code, then enrol). Re-pair keeps reading only the live column, so
   an abandoned begin is never a recovery credential; expire pending secrets after an hour. Vectors and
   tests in `packages/control-plane/tests/totpEnroll.test.ts`.
4. Give refusals stable `code`s (`stale-request`, `invalid-signature`, `account-not-found`,
   `totp-not-configured`) beside `error`, so clients stop matching English or status substrings.

### Webapp

1. **Tell transport failures apart at the fetch** (`lib/totp.js`): wrap the `fetch` in try/catch and
   rethrow a tagged error (`code: "network"`, plus `offline: navigator.onLine === false`). Wrap the
   signing step separately and tag it `code: "sign-failed"` (`NotSupportedError` → `code: "unsupported"`).
   Replace the status-0 guards with `userError(...)` sentences (`humanError.js:156`), and make the view
   check `session.username` as well as `session.umk`.
2. **Stop treating every `TypeError` as offline** (`humanError.js:89`): only a tagged transport error,
   or a fetch rejection message, is network. Unknown errors fall to "That didn't work".
3. **Show the server's reason** for this screen: use `knownReasonText` (`humanError.js:157-171`, already
   maps `stale request` → clock, `invalid signature` → key mismatch) plus the new codes
   (`totp-already-enrolled`, `account-not-found`, `totp-not-configured`).
4. Sentences (all through `tr()` → `i18n/webapp/en.json`, then the six machine drafts; `npm run i18n`):
   - offline: "You're offline. Connect to the internet and try again."
   - unreachable but online: "Couldn't reach Flagship. If your connection works, a browser extension,
     VPN or firewall may be blocking flagshipserver.com."
   - server failure (500/1101/1102): the existing "Our service is briefly unavailable — wait a moment
     and try again."
   - unsupported browser: "This browser can't make the signature this needs. Update it, or turn this on
     from the Flagship app."
   - already enrolled: "Code protection is already on for this account. Turn it off first to set up a
     new authenticator."
   - no account name loaded: "This browser hasn't loaded your account. Lock and unlock it, then try
     again."
   (No "cancelled" case: this flow asks for no passkey. If item 3 below gates it on the admin key, add
   the existing `custodyErrorText` cancel sentence.)
5. Clear the server's pending secret on Cancel (needs a `DELETE`/`POST .../totp/enroll-cancel`, IRK
   signed) or rely on the server-side expiry from `.com` item 3.
6. Tests: `apps/web/tests/webappTotpView.test.ts` gains cases for a rejected fetch, offline, a 500, a
   `NotSupportedError` at signing, an empty username, and each refusal code.

### iOS

Already honest about transport errors. Add the same server codes (`totp-already-enrolled` and the
rest) to the view model's catches, the empty-username case is already handled ("No active account on
this device."). Strings in `i18n/ios/*.json`.

### Android

Replace the raw `e.message` in `couldnt_start_enrollment`, `couldnt_confirm` and `couldnt_disable`
(`AccountSecurityViewModel.kt:116-123`, `:164-172`, `:215-222`) with `UserErrorText.reason(e)` (as the
signing step does) and branch on the HTTP status and `code`, not `msg.contains("503")`. Strings in
`i18n/android/*.json`. Parity row `account-security` in `parity/features.json`.

## 5. Severity

**Low.** Functional/UX bug with an honesty problem in error copy; no data exposure, no bypass, and the
protection is available from the phone apps. The related re-enrolment overwrite is Low to Medium on its
own and is worth fixing in the same change, since nobody is enrolled in production yet (no migration of
live secrets needed).

## Open questions for the owner

1. Should turning code protection on or off need the admin key (admin device, passkey on the webapp)
   rather than the IRK any device holds? The rank rule suggests yes.
2. Turn on Workers Logs for `.com` (sampled, content-free lines only), or keep only the D1 counters?
3. One name for the feature on every surface: "Code protection" (phones) or "Multi-device + 2FA" (web)?
4. Ask the reporter (through the usual channel) for browser + version, extensions/VPN, and whether the
   browser console showed a CORS error or a status: that would settle cause 1 vs 2.
5. The one production account with a staged, unconfirmed secret: leave it (it is a working recovery
   code factor for that account) or clear it with the server fix?
