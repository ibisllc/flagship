# Security notices: tell every app something, and lock them only for a security reason

Status: phase 1 built on `main` (2026-10-18): the envelope and vectors in
TypeScript, the maintainers' tool, `GET /api/notices` on `.com`, the webapp
client and its gym scenarios. Phase 2 (owner request): the iOS and Android
ports from the spec in "Client behaviour" below. Nothing is deployed or
signed yet: the committed notice is `null`.

Two features ride one signed document.

- **A. Broadcast.** "Attention, we will update on Wednesday 21 October. Your
  servers keep running, but flagshipserver.com may be briefly unavailable."
  Every app and the webapp picks it up from `.com` without telling `.com`
  who or what it is.
- **B. Lock.** The app locks itself until it is updated and shows "Update
  required" with the store link. Only when the security protocol changes in a
  breaking way, and only for a security reason that is named in the signed
  bytes.

## 1. What changed from the first design, and why

The first design was right on the big things (one anonymous static GET, signed
offline, fail open, never destroy data). Where it was wrong or thin:

| First design | What was built | Why |
|---|---|---|
| "Signed by the CA key chain the apps already pin, like CaEndorsement" | Signed by the **cold ca-track maintainer authority** (the YubiKey holder), verified against the baked pin and the apps' own clock. Never by the hot operational CA key. | The hot CA key lives on `.com` as `FLAGSHIP_CA_PRIV_HEX`. A notice it could sign is a notice a compromised `.com` could forge, which is the exact attack this feature must not allow. A CaEndorsement is different: the cold key signs a short lease that authorises the hot key. Here the cold key signs the notice itself. |
| Kinds: maintenance, update-advisory, update-required | Adds **`none`**, a signed all clear | `seq` only moves up and a 204 from `.com` cannot retract anything (a hostile `.com` could answer 204 too), so retracting a notice, a lock above all, needs a signed, higher-`seq` statement. |
| `deprecates`: "protocol vN stops being accepted after a date" | `lockFrom` (when the lock starts) and `deprecatesProtocol` (which protocol level boxes and `.com` stop accepting at `lockFrom`) | One date, not two that can disagree. `update-required` is "the nag banner now, the lock from `lockFrom`", so a grace window and "window 0" are the same envelope. |
| Fields: seq, kind, message, platforms, advisoryId, validFrom, validUntil | Adds `reason`, `eventAt`, `lockFrom`; the message may carry `{date}`; **no URL in a notice** | The security reason must be in the signed bytes (the lock screen shows it), not only in a CLI flag. `{date}` is rendered in the person's own locale and zone. The store link always comes from the app itself, so a stolen signature cannot send people to a phishing page. |
| "ONE signed document" | One notice per document | Simple and verifiable, with a real cost (see "Honest weak spots": a later notice replaces an earlier one, so the tool refuses to lift a lock in force without `--supersede-lock`). |

## 2. Threat model

| Threat | What happens |
|---|---|
| `.com` or Cloudflare is compromised and forges a lock | Impossible. The signer must be the ca-track authority at the app's clock, proven from the baked pin. Tested: a notice from another chain, or a chain not hashing to the pin, locks nothing. |
| ... and drops, delays or suppresses a notice | Possible. Apps fail open, so the effect is "people are not told". A lock is **defence in depth against a mistake or a known-bad old build, not a security boundary against a hostile `.com`**: the boxes and `.com` must still refuse the old protocol themselves (section 7). |
| ... and replays an old signed notice (to everyone, or to one IP) | Bounded: a notice is valid for at most 30 days (`validUntil - validFrom`, enforced by the bytes themselves), apps remember the highest `seq` they verified and refuse lower or equal ones, and apps only ever lock inside the window by their own clock. A replay can show an old banner inside its window; it cannot lock after `validUntil`. |
| ... and serves a mandate chain from before a rotation (to revive a rotated-out key) | Apps remember the `issuedAt` of the newest authority mandate they have verified (the "tip") and refuse a chain whose authority is older. |
| The maintainer signs a wrong notice | The tool previews everything, refuses what the apps would refuse, needs a typed phrase (`LOCK-USERS` for a lock), and a mistake is capped at 30 days and retracted by a signed `none` with a higher `seq` (YubiKey, commit, `.com` deploy; apps pick it up on their next poll). |
| The signing key is lost or stolen | A thief can lock every app for at most 30 days per signed notice and cannot be stopped from re-signing until the authority rotates: the existing ca-track successor takeover (`docs/ca-operations.md`). Old notices stop verifying when the authority at the app's clock is no longer that key. |
| The device clock is wrong | Fail open for early clocks (a notice is "not yet"), and a clock set back can make an expired notice look in-window again. That needs control of the device's clock, and the cap is the original 30-day window. Hardening not built: remember the latest time seen and never judge a window by an earlier one (recommended for the native ports, optional). |
| A notice carries a link or markup | Not possible. `://` is refused in the bytes, text is rendered as text, never markup, and the store link is the app's own. |
| The lock locks people out of their server | It never deletes anything. It does refuse signing and calls to servers, so a phone that is locked cannot approve a boot unlock until it is updated (see weak spots). |
| The notice endpoint is down or slow | Nothing happens: apps keep the last verified notice and fail open. |

## 3. Privacy analysis

The request is `GET https://flagshipserver.com/api/notices`:

- No authentication, username, device id, app version, build or platform. No
  cookie is sent (`credentials: omit`) or set. No query string, no custom
  header, no referrer. (A browser or OS still sends its own user agent and
  the network sees the IP; nothing here adds to that.)
- One static body for every caller of one deploy. `ETag` is the same for
  everybody, so a conditional request reveals nothing either.
- The handler reads one request header (`If-None-Match`, to answer 304). It
  does not read the IP, cookies, authorization or any `x-flagship-*` header.
- Counters only: a daily total in D1 `meter_counters` (account `_system`,
  resource `notice-fetch`), flushed at most once a minute per Worker
  isolate. It counts requests that reach the Worker, not people.
- The apps decide locally whether a notice is about them. Which build, which
  platform and which protocol level they run never leaves the device.

What this does not hide, honestly: the TCP and TLS connection exists, so
Cloudflare and anyone on the path see "an app contacted `flagshipserver.com`"
and its IP at that time. Every installed app already contacts `.com` for
other reasons, so the notice poll adds a timing signal, not a new party. If
that ever matters, the outbound proxy and OHTTP relay work on
`feat/outbound-proxy` can carry this one request, since it is a plain GET
with nothing in it.

Targeting: because nothing identifies the caller, `.com` cannot choose a
notice per person, only per network address (a hostile `.com` could serve a
different **validly signed** notice to one IP, such as an older one inside its
window). Every signed notice is committed in `.maintainers/notices/history/`,
so what was ever signed is public.

## 4. The wire format

`GET /api/notices` answers:

- `204` with no body: no notice in force on this deploy.
- `200 application/json`:
  `{ "version": 1, "notice": <SecurityNotice>, "mandates": [<Mandate>, ...] }`
  where `mandates` is the public ca-track mandate log (the same JSON
  `/api/maintainer-blessing` serves) the app needs to find the current
  authority. It authenticates itself against the baked pin.
- Headers: `Cache-Control: public, max-age=300, stale-while-revalidate=3600`,
  `ETag`, and CORS for the webapp origins (the Worker's usual rule). `405` for
  anything but GET and HEAD.

### SecurityNotice

```json
{
  "type": "SecurityNotice", "version": 1,
  "seq": 3, "kind": "update-required",
  "validFrom": 1792000000000, "validUntil": 1794592000000,
  "eventAt": 1793209600000, "lockFrom": 1793209600000,
  "platforms": { "android": {"minBuild": 40, "minProtocol": 2}, "ios": {"minBuild": 12, "minProtocol": 2}, "web": {"minBuild": 150, "minProtocol": 2} },
  "advisoryId": "FSA-2026-001", "deprecatesProtocol": 1,
  "reason": "A flaw in how a signed message is checked lets an attacker act as you.",
  "message": "You must update Flagship by {date}. Older versions will stop working.",
  "signedBy": "<64 lower-hex ca-track authority pubkey>", "signature": "<128 lower-hex>"
}
```

Canonical bytes (UTF-8, `|` separated, no trailing separator):

```
flagship/security-notice/v1|<signedBy>|<seq>|<kind>|<validFrom>|<validUntil>|<eventAt>|<lockFrom>|<platforms>|<advisoryId>|<deprecatesProtocol>|<reason>|<message>
```

`platforms` is `name:minBuild:minProtocol` entries sorted by name, joined by
`,` (`android:40:2,ios:12:2,web:150:2`), empty when there are none. Numbers
are base-10 integers. Reference: `packages/protocol/src/securityNotice.ts`.
Vectors (the file every port must pass):
`packages/protocol/test-vectors/security-notice/vectors.json`, built by
`npx tsx packages/protocol/tests/genSecurityNoticeVectors.ts`.

### Rules (a notice that breaks one cannot even be signed; apps drop it)

Checked in this order; the first broken rule is the error code in the vectors.

| Rule | Code |
|---|---|
| `signedBy` is 64 lower-hex | `bad-signer` |
| `seq` is an integer of 1 or more | `bad-seq` |
| `kind` is `none`, `maintenance`, `update-advisory` or `update-required` | `bad-kind` |
| `validFrom` and `validUntil` are safe integers (epoch ms) | `bad-time` |
| `validUntil` is after `validFrom` | `window-order` |
| `validUntil - validFrom` is at most 30 days (2,592,000,000 ms) | `window-too-long` |
| `eventAt` is 0, or inside `[validFrom, validUntil]` (and 0 for `none`) | `bad-event-at` |
| `lockFrom`, `deprecatesProtocol` are whole numbers | `bad-lock-from`, `bad-deprecates` |
| platform names are `android`, `ios`, `web`; each has whole `minBuild` and `minProtocol` | `bad-platforms`, `bad-minimum` |
| `advisoryId` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` or is empty | `bad-advisory` |
| `reason` is at most 160 characters, `message` at most 280, neither has `\|` or a control character | `bad-reason`, `bad-message` |
| neither contains `://` | `message-has-link` |
| a message with `{date}` has an `eventAt` | `date-token-needs-event` |

Then per kind:

| | `none` | `maintenance` | `update-advisory` | `update-required` |
|---|---|---|---|---|
| message | empty | required | required | required |
| platforms | none | optional (none = everyone; a bare name limits it), minimums 0 | required, every entry has a `minBuild` or `minProtocol` above 0 | same as advisory |
| `advisoryId` | empty | empty | optional | **required** (`advisory-required`) |
| `reason` | empty | empty | optional | **required** (`reason-required`) |
| `lockFrom` | 0 | 0 | 0 | in `[validFrom, validUntil)` (`bad-lock-from`) |
| `deprecatesProtocol` | 0 | 0 | 0 | 0, or below every listed `minProtocol` (`deprecates-not-enforced`) |

Error codes for a kind's own rules: `platforms-not-allowed`,
`message-not-allowed`, `message-required`, `platforms-required`,
`minimum-required`, `minimum-not-allowed`, `lock-from-not-allowed`,
`deprecates-not-allowed`, `advisory-not-allowed`, `reason-not-allowed`.

## 5. How a client decides (the shared algorithm)

1. **Fetch** (section 6 for when): one anonymous GET. `204`, any error, a
   non-JSON body or a malformed document: stop, change nothing.
2. **Find the authority.** Walk the response's `mandates` forward from the
   baked pin (`verifyMandateChainFromPin`) and take `currentAuthority` at
   **this device's clock**. No authority, or one whose mandate `issuedAt` is
   older than the newest this device has verified (`tip`): stop, change
   nothing. Otherwise remember the larger tip.
3. **Verify.** Parse (every rule above), then check `signedBy` is the
   authority key and the Ed25519 signature over the canonical bytes. Failure:
   stop, change nothing.
4. **Anti-rollback.** If `seq` is not above the highest `seq` ever verified,
   stop. Otherwise store the document (notice and mandates) and the new
   highest `seq`.
5. **Decide**, from the stored notice, at the device's clock, every time the
   app starts, returns to the foreground, and at the next boundary
   (`validFrom`, `lockFrom`, `validUntil`, at most 6 hours ahead). The stored
   notice is **re-verified against the authority each time**; if the
   authority cannot be shown now, the answer is "nothing".
   - `kind` is `none`: nothing.
   - Before `validFrom` or from `validUntil` on: nothing. **A lock is never
     shown past `validUntil`, however stale the cache.**
   - `maintenance`: a banner, when `platforms` is empty or lists this platform.
   - `update-advisory`: nothing if this platform is not listed or the build
     and protocol are at or above the minimums, else the update banner.
   - `update-required`: the same test, then the update banner before
     `lockFrom` and **the lock from `lockFrom`**.
   - Below the minimum means `minBuild > 0 and build < minBuild` or
     `minProtocol > 0 and protocol < minProtocol`.

Fail open means every failure above leaves what the person already sees as it
was. A fetch that returns nothing new (a refusal, a repeat) does not
re-decide. The vectors pin steps 3 to 5; the webapp tests pin step 2.

## 6. Client behaviour spec (what the iOS and Android ports must do)

This section is the contract for phase 2. The webapp is the reference
implementation: `apps/web/public/webapp/lib/securityNotice.js` (the
algorithm, fetch, store, poller), `lib/noticeUi.js` (banner, lock),
`lib/updateLock.js` and `lib/comFetch.js` (the network side), and
`lib/buildInfo.js` (what this build is).

### 6.1 Port the envelope

- `SecurityNotice.swift` in `FlagshipCore`, `SecurityNotice.kt` in `core/`:
  parse, canonical bytes with the rules and codes above, verify (Ed25519 via
  the same primitive `MaintainersTrust` already uses), `outcome`, `accept`.
- Authority: reuse `MaintainersTrust.verifyMandateChainFromPin` and
  `currentAuthority` (both exist in Swift and Kotlin) with the baked pin the
  apps already carry for `verifyComBlessing`.
- Pass `packages/protocol/test-vectors/security-notice/vectors.json`:
  `positive` (parse, canonical string equal, verifies under
  `keys.authorityPubHex`), `reject` (each gives `expect`), `unsignable` (each
  throws the first broken rule's `code`), `outcomes` (`notice`, `client`,
  `now` give `expect`), `accept` (`store`, `candidate`, `authorityKeys` give
  `expect`). Swift test name `SecurityNoticeVectorTests` under
  `apps/mobile/shared/Tests/FlagshipSharedTests/`, Kotlin
  `SecurityNoticeVectorsTest` under `app/src/test/.../core/`. Both must
  read the path `test-vectors/security-notice` (the parity check looks for
  it) and then delete the four allowlist entries and flip the parity row.
- Build constants: `build` is `CFBundleVersion` as an integer on iOS and
  `versionCode` on Android (the number the notice's `minBuild` names).
  `protocol` is `CLIENT_PROTOCOL_LEVEL` (1 today); keep a Swift and Kotlin
  constant and a test that it equals the TypeScript one (the webapp does:
  `webappSecurityNotice.test.ts`).

### 6.2 Fetch, store, poll

- URL: `https://<control apex>/api/notices` (the apex the app already
  uses for `.com`; the gym and production differ only there).
- Request: `GET`, no body, **no custom headers, no cookies (URLSession
  `httpShouldHandleCookies = false`, an ephemeral configuration with no
  credential storage and no cache of cookies; OkHttp without a cookie jar), no
  query, no referrer, no redirects followed** (a redirect is a failure).
  Do not send the app's usual `x-flagship-*` headers; do not route it through
  the authenticated API client.
- When: once shortly after launch, and when the app returns to the
  foreground if the last attempt was 15 minutes ago or more, each with a
  random delay of 0 to 10 seconds. Never more than one in flight. A failure
  is silent and the next attempt is the next foreground.
- Store (per install, not per account, so it survives sign-out and a second
  account): `highestSeq`, the last accepted document (notice and mandates),
  `tip` (ms), and `dismissed` (`{seq, at}`). iOS: `UserDefaults` or a file
  in Application Support; Android: `SharedPreferences` or a file in app
  files. Reading a corrupt store is "empty".
- Timer: after each decision, schedule the next boundary as in section 5.

### 6.3 What the lock refuses

While locked (decision is `lock`), the app refuses **signing and server
actions** and deletes nothing:

- Every network request from the app except: a GET or HEAD to the control
  apex (reads change nothing, and sign-out and the key backup need some),
  and the notice fetch itself. That is: no signed order, no call to any box
  or `*.flagship.services` host, no write to `.com`.
  - iOS: one gate in the API clients' request path (the `URLSession`
    wrapper `LiveScreensClient` and the `.com` client share) that throws
    `UpdateRequiredError`. Android: an OkHttp interceptor installed first.
  - Throw a typed error screens can show as "Update required"; nothing
    should show a generic failure.
- Background work: unlock approvals and boot approvals (including the
  Watch's), backup fetches, push-token sync and the live screens socket do
  not run. Notifications still arrive; their actions open the lock screen.
- It does **not** block: the key backup (`.flagshipkey` export), sign-out,
  and the OS-level update.

### 6.4 Banner

Above the main content, below the status bar, one at a time. Strings
(sentence case, no em dashes), from `NOTICE_COPY` in `noticeUi.js`:

| What | Text |
|---|---|
| Body | the notice's message with `{date}` replaced by the local date and time of `eventAt` (the device's locale and zone, e.g. "Wednesday, October 21 at 9:00 AM") |
| Dismiss button | `Dismiss` |
| Update button (update banner only) | web: `Reload to update`; **native: `Update`** (opens the store listing) |

Visibility: `maintenance` stays dismissed for that `seq`. `update-advisory`
returns 24 hours after it was dismissed. The grace window of an
`update-required` (before `lockFrom`) reappears on every launch (dismissal
lasts the launch). A new `seq` shows again. Style: a card with a teal left
rule for maintenance, a warning tint and rule for the update banner.
Accessibility: a status role (not an alert), the text readable at the largest
type size, the buttons at least 44 pt / 48 dp.

### 6.5 The lock screen

Replaces the whole app UI (iOS: a root `fullScreenCover` that cannot be
swiped away; Android: a root overlay that consumes all input, system Back
leaves the app instead of reaching what is behind). Before showing it, close
every sheet, menu, dialog and popover (the webapp runs `dismissOverlays()`
from the lock sweep), and make everything behind it inaccessible to
VoiceOver and TalkBack. Layout, top to bottom, left aligned in a 440 pt / dp
column, centred vertically, same sentence case:

```
SECURITY UPDATE                       mono, small, uppercase, muted
Update required                       title, 28
<message with {date} filled in>       body, 17
Why: <reason>                         15, soft ink (the reason is mandatory for a lock)
Your accounts and servers are unchanged and nothing has been deleted.
Flagship is paused on this device until you update.      14, muted
[ Update Flagship ]                   primary, full width
[ Back up my account key ]            secondary, full width
[ Sign out ]                          secondary, full width
Advisory FSA-2026-001 · Signed by the Flagship maintainers   12, faint
```

Exact strings:

| Element | Text |
|---|---|
| Kicker | `Security update` |
| Title | `Update required` |
| Why line | `Why: ` + `reason` |
| Reassurance | `Your accounts and servers are unchanged and nothing has been deleted. Flagship is paused on this device until you update.` |
| Primary | web: `Reload to update`; **native: `Update Flagship`** (the app's own store listing: App Store `https://apps.apple.com/app/id6768945985`, Google Play `https://play.google.com/store/apps/details?id=com.flagshipserver.app`, kept only in the app's own constants, never from the notice) |
| Backup | `Back up my account key`; while the account is not unlocked: `Unlock to back up my account key` |
| Sign out | `Sign out` |
| Meta | `Advisory <advisoryId> · Signed by the Flagship maintainers` |
| Update failed (toast) | `Couldn't update yet. Check your connection and try again.` |

Behaviour:

- **Backup** runs the app's existing account key export (the same
  ceremony as Settings) above the lock. If the account is locked behind the
  biometric or PIN screen, the button steps aside to that unlock screen (the
  lock screen hides while an unlock surface is showing) and the lock screen
  returns the moment the app is unlocked. The unlock screens themselves are
  never blocked.
- **Sign out** is the app's existing Sign out (the same recovery-gated flow,
  which only needs reads from `.com`).
- **Update**, web: ask the service worker for the newest shell and reload;
  with none waiting, delete the shell caches and reload (never account
  data). Native: open the store listing.
- After an update the new build is at or above the minimum, the stored
  notice decides "nothing" and the lock goes away by itself.

### 6.6 Mock-gym scenarios for each app

Same five as the webapp (`tools/gym/src/suites/webNotices.ts`), with a
throwaway authority injected the way the webapp gym does (a test pin; the
app's own poller keeps the baked pin and so refuses a forged lock):

1. a maintenance notice shows a dismissible banner with the date;
2. a verified update-required notice locks the app (dialogs closed, UI
   inaccessible, nothing sent, backup reachable);
3. the lock lifts when the build is updated or the notice ends, and an older
   notice cannot bring it back;
4. fails open: a lock the baked pin cannot vouch for, a 500 and junk lock
   nothing;
5. an update-required notice nags until its lock date, then locks.

Live gym (needs a real box and a signed notice, so it is a later item): none
in phase 1, because a real notice needs the YubiKey; the mock gym carries
the behaviour.

## 7. Protocol versions: letting people update later

### 7.1 What the code does today

- Every signed message has a tag `flagship/<purpose>/vN` in canonical bytes.
  Almost all are `v1`; 13 purposes have a `v2`
  (`auto-unlock-lease`, `debug-access`, `device-admit`,
  `device-capability-grant`, `gossip`, `push-token-register`,
  `server-backup-body`, `server-backup-data`, `server-backup-slot`,
  `server-transfer-claim`, `service-access-mode`, `service-allow-remove`,
  `tunnel-hello`). This feature's own tag is `flagship/security-notice/v1`.
- A `v2` replaced its `v1` in place. Each verifier hard-codes **one** tag
  (the tunnel hub verifies only `tunnel-hello/v2`; the daemon verifies
  `service-access-mode/v2` for admin orders). Where an old builder is still
  in the tree (`legacyEnvelopes.ts`), it is there for tests and older
  artifacts, not as a second accepted version.
- There is **no protocol level** anywhere in the wire or in HTTP: no header,
  no handshake field (the sibling handshake has a `protocolVersion` that must
  be exactly 1), no capability list on a box. `/api/*` routes are not
  versioned. The project's stated posture (owner, pre-release) is "no
  compatibility for old boxes or deployed builds".
- So today there is no way for two protocol versions to be accepted side by
  side, and no way for a client to learn which one a box speaks.

### 7.2 The rule

A **protocol level** is a whole number every build carries
(`CLIENT_PROTOCOL_LEVEL`, 1 today). It is raised only when a build ships a
breaking change to a signed message or a wire contract. A breaking change is
announced with an `update-required` notice, and the notice carries the
window:

- `deprecatesProtocol = N` and every listed platform's `minProtocol = N + 1`:
  from `lockFrom`, clients below N + 1 lock, and boxes and `.com` stop
  accepting level N.
- **Before `lockFrom`, both level N and level N + 1 are accepted** (the
  window), and old clients see the update banner (the nag).
- **Window 0** is `--lock-at now`: no overlap. A change that cannot tolerate
  the old path sets it.

### 7.3 What would have to change to build the window

None of this is built. It is the list for whoever ships the first breaking
change.

1. **Verifiers accept a set.** Each verifier that sees a changed tag takes an
   ordered list `[vN+1, vN]` and gets "is level N still accepted at `now`?"
   from the notice (boxes and `.com` both hold the baked pin and the mandate
   chain, so they can verify the notice themselves; `.com` bundles it, a box
   fetches it and verifies it like any app).
2. **Peers say what they speak.** A box reports `acceptedProtocols` in its
   heartbeat and server-detail; `.com` sends the same list in a response
   header on every response (the same bytes for everyone). A client signs at
   the highest level both support. A new client talking to an old box
   falls back to N; it never signs both.
3. **Stored artifacts.** Leases, grants and mailbox orders signed under N
   before `lockFrom` need a rule: accepted until their own expiry, or
   re-signed on first use. Decide per artifact kind; the long-lived ones
   (device grants, admin orders) are the cost.
4. **Vectors for both tags**, plus a window table (accepted before `lockFrom`,
   rejected after, for each side).
5. **The update path is exempt.** Whatever an app uses to update a box
   (the signed server-update order, the release catalog, the endorsement
   check) must stay on the old level for at least one release, or be accepted
   at both. Otherwise an app on N + 1 cannot ask an old box to update, and
   the lock sends the owner to a box they can no longer reach.
6. **Order of rollout.** Boxes accept both (an endorsed release), then
   `.com` accepts both, then clients start emitting N + 1 (only after the
   peer advertises it), then the notice is signed with `lockFrom` and
   `deprecatesProtocol`, then at `lockFrom` boxes and `.com` drop N.

### 7.4 Recommendation

Do not build the window now. Pre-release, the project's posture is to break
old boxes and builds, and there are only two ways to use a window honestly:

- **Use a window only when the old path is not itself the vulnerability.** A
  window keeps the old protocol alive for the whole grace period, and the nag
  banner only reaches people who open the app. An attacker keeps using the
  old path regardless. For a **security** break, sign `required` with
  `--lock-at now` (window 0) and have boxes and `.com` refuse the old level
  in the same release.
- For a **convenience** break (a v2 that is better, not safer) a window of
  7 to 14 days is reasonable, and then item 5 above is the one that must not
  be forgotten.

The tool nudges this way: any `required` notice with a window longer than
zero prints a warning that the vulnerable path stays accepted, and one over
14 days a second one.

## 8. How maintainers publish a notice

You need the ca-track YubiKey (the same one that renews the CA lease) and a
checkout with the maintainers clone built (`maintainers/` next to the repo, or
`FLAGSHIP_MAINTAINERS_DIR`). The authority must be in force: the committed
ca-track mandate runs to 2027-04-04 (renewal: `docs/ca-operations.md`). **If the
mandate lapses no notice verifies anywhere; apps fail open, so nothing breaks,
but nothing can be announced or locked either.**

```sh
# 1. Preview. Nothing is signed or written; it prints the exact canonical bytes
#    and who sees what.
node scripts/security-notice.mjs maintenance \
  --message "We will update Flagship on {date}. Your servers keep running, but flagshipserver.com may be briefly unavailable." \
  --event 2026-10-21T09:00:00Z

# 2. The same command with --sign: a typed confirmation, then the YubiKey.
#    It writes .maintainers/notices/current.json and history/<seq>-<kind>.json.
node scripts/security-notice.mjs maintenance ... --sign

# 3. Commit both files, land on main, and redeploy .com (the Worker bundles
#    current.json): cd apps/com && npm run deploy
# 4. Check it is live: curl -s https://flagshipserver.com/api/notices
```

Kinds, in order of weight:

- `maintenance`: a banner. `--event` is the date the message talks about;
  `--until` defaults to a day after it.
- `advisory`: the update banner for builds below `--platform name:minBuild[:minProtocol]`.
- `required`: the lock. **Only for a security reason.** The tool refuses
  without `--advisory <id>` and `--security-reason "<one sentence>"`, and
  without `--lock-at <time|now>`. It refuses a minimum no shipped build can
  meet (`--allow-unshipped` if the build ships first), refuses a message
  with an em dash, emoji, a link, a `|`, or over 280 characters, and the
  sign step needs the typed phrase `LOCK-USERS`. Before signing a lock:
  the webapp build and the store builds at the minimum are live; the update
  path works across the break (section 7.3 item 5); `--lock-at` leaves time
  for the stores' review, or the lock arrives before the fix.
- `clear`: a signed all clear that supersedes the notice in force. It is how
  a lock is retracted. Replacing a lock with anything weaker needs
  `--supersede-lock`.

`seq` is chosen above everything ever signed (the tool reads
`history/`). Do not reuse a lower one: apps ignore it as a rollback.

Time to effect: committing is not enough. The notice reaches `.com` at the
deploy, and each app picks it up on its next launch or foreground (15 minute
minimum between polls, 0 to 10 seconds of jitter). A retraction takes the
same path.

## 9. Honest weak spots

- **A lock is not a boundary against a hostile `.com`.** It can suppress it.
  The old protocol must be refused by boxes and `.com` themselves; the lock
  only gets honest users to update (section 7).
- **One notice at a time.** A newer `seq` replaces the older one entirely,
  including a lock still in force. The tool refuses to lift a lock without
  `--supersede-lock`, but a maintainer who must announce maintenance during a
  lock has to restate the lock in the same notice (a `required` notice has one
  message). Per-kind slots would fix it at the cost of a bigger envelope.
- **A locked phone cannot approve a boot unlock.** The lock refuses signing,
  and the approval is a signed boot response, so a server that reboots while
  its phone is locked waits until the person updates. The update is one tap
  and the lock has a grace window by default, but this is the sharpest edge.
  If a break does not touch the boot path, a future field could name
  exemptions; not built.
- **The webapp's "update" is a cache dance.** A service worker serves the
  old shell until a new one activates. "Reload to update" asks for the update
  and falls back to deleting the shell cache; a browser that blocks service
  workers just reloads.
- **The clock is trusted.** See the threat table.
- **The mandate chain is the carrier's.** It authenticates itself against the
  pin, but a hostile carrier can withhold a newer mandate; the tip memory
  only protects a device that has seen the newer one. A fresh install has no
  tip.
- **IP and timing** are visible to the network and Cloudflare (section 3).
- **Poll lag.** A retraction or a new lock reaches an app only when it next
  launches or comes to the foreground, up to a deploy plus 15 minutes after.
- **The signature is only as safe as the YubiKey and the typed
  confirmation.** One wrong `LOCK-USERS` is a 30-day denial of service for
  every old build until retracted.

## 10. Where things are

| What | Where |
|---|---|
| Envelope, rules, outcome, accept | `packages/protocol/src/securityNotice.ts` |
| Vectors and the generator | `packages/protocol/test-vectors/security-notice/vectors.json`, `packages/protocol/tests/genSecurityNoticeVectors.ts` |
| The maintainers' tool | `scripts/security-notice.mjs` (tests: `scripts/security-notice.test.ts`) |
| The signed notice and its history | `.maintainers/notices/current.json` (`null` for none), `.maintainers/notices/history/` |
| `.com` route | `apps/com/src/securityNotices.ts`, wired in `route.ts` before the rate limiter |
| Webapp | `lib/securityNotice.js`, `lib/noticeUi.js`, `lib/updateLock.js`, `lib/buildInfo.js`, `lib/comFetch.js` (the lock's network gate) |
| Webapp tests and gym | `apps/web/tests/webappSecurityNotice*.test.ts`, `apps/web/e2e/gym/gym-notices.spec.ts`, `tools/gym/src/suites/webNotices.ts` |
| Parity | `parity/features.json` row `security-notices` |
