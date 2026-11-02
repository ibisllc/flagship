# voi.ci pages and Messages (release 0.3, item H11)

Status: design, 2026-11-02. Nothing built. This is the contract the build chunks in §14 build to.
Brief: `RELEASE-0.3-JOURNAL.md`, log line "2026-11-02 OWNER DECISION: add to 0.3 voi.ci pages + Messages (H11)",
plus the owner's additions the same day (recorded in §0 as O1-O9). Related: `docs/named-links.md` (voi.ci names
today), `docs/architecture-v2/phone-route.md` (the phone's bare name), `docs/architecture-v2/relay-mesh.md` (the
signed, content-addressed, R2-cached feed pattern reused for pages), `docs/architecture-v2/pq-suites.md`
(`flagship/hybrid-seal/v1`), `docs/share-a-server.md` §5.1 (account-key attestations),
`docs/account-read-token.md`, `docs/service-access-gating.md` (per-app identity).

Not in 0.3: visitors posting or commenting on pages, the voi.ci discovery homepage, live (WebSocket) delivery,
calls, attachments other than text and links, a shared pseudonym blocklist.

## 0. Decisions in one page

1. **A page is `voi.ci/<username>`.** A contact card first (photo, display name, short bio, ordered links, a
   "Send me a message" button shown only while the owner accepts messages), then the owner's posts, newest first.
   One template, three accent variants, no custom HTML, CSS or script. §2.
2. **The page is a signed index of content-addressed pieces.** `flagship/voici-page/v1`, signed by the account's
   sensitive-order key (admin root; the IRK only on an account that pins none). Pieces are named by SHA-256, stored
   per page in R2, served immutable from `files.voi.ci`. Only new pieces upload. The index has a sequence number;
   `.com` accepts only `seq = current + 1`. §2, §3.
3. **voi.ci is a static, open-source site** that verifies the index signature in the browser against the account's
   public keys from `.com` (`GET /api/username/<u>`) before it shows anything. §4.
4. **Only an admin device publishes.** Any device of the account writes posts; they stay grayed ("Not published
   yet") until an admin device signs. Drafts reach the admin device directly over the phone's bare name when it is
   live, else through a `.com` drafts lane. §5.
5. **Visitors use the website; the app only signs in** ("Sign in with Flagship"). voi.ci shows a QR or a deep link
   through the existing `/qr-pipe` relay; the visitor's Flagship app approves and signs a **web delegation** for a
   non-extractable WebCrypto key the browser made. Every web message is signed by that key; anyone can check the
   chain against public keys, with the owner offline. §6.
6. **Per-page pseudonyms.** A sender's key toward a page is derived from their UMK and the page's id. Stable for that
   page, unlinkable across pages, never their username. The receiver sees one pseudonym ("Visitor 4F3A") and can
   rename it; nicknames sync encrypted across the receiver's devices. §6.2.
7. **A pseudonym is attested, not named.** `.com`'s CA signs `flagship/messages-key-attestation/v1` over the
   pseudonym key: "a Flagship account in good standing vouched for this key". It names no account. It carries an
   **abuse tag**: the sender's account, sealed by `.com` to an offline Flagship abuse key, opened only when a receiver
   reports a message. §6.3, §9.
8. **Messages are end-to-end encrypted with the post-quantum hybrid seal.** The body is sealed once; its content key
   is wrapped with `flagship/hybrid-seal/v1` (X-Wing) to the page owner's **inbox key** (derived from the owner's UMK,
   so every device of the account opens it) and to the sender's **thread key** (so the sender's browser can show the
   thread). §7.
9. **Delivery: straight to the owner's phone when it holds its bare name, else the `.com` mailbox.** The phone
   endpoint accepts exactly one cross-origin operation, from exactly `https://voi.ci`: deliver a signed envelope (and
   a liveness ping). It replaces the one-time-code browser session, which is retired. Every message ends in the
   mailbox (the phone forwards what it got directly), so all the owner's devices and the visitor's thread see it.
   Content-free push. §8.
10. **Abuse: per-receiver block, report, account ban, slow starts, per-device caps.** A block is local and a signed
    filter `.com` applies first. A report sends the message (and, if the reporter chooses, its text sealed to the
    abuse key) to Flagship. A confirmed abuser's account is banned: no new attestations, the reported pseudonym
    refused at once, its other pseudonyms within 30 days. New accounts start at 3 new recipients a day. Apple
    DeviceCheck/App Attest and Google Play Integrity cap new Messages accounts per device per month and let a ban
    cover the device; no phone number, no identity. A `.com` takedown tool removes pages. §9, §10.
11. **The reusable primitives** (web delegation, signed web envelope, direct-to-phone with mailbox fallback) live in
    a small browser library, `packages/flagship-web`, which voi.ci uses and any later Flagship website can. §6, §8.

Owner additions (binding, 2026-11-02):

- **O1** The page editor warns before the first publish and next to the profile fields that anything on the page
  can be linked to the owner's apps and servers (same username). §11.2.
- **O2** Direct-to-phone in 0.3, replacing `POST /api/phone/session`. §8.
- **O3/O4** Visitors are pseudonymous only; no named mode. The voi.ci site is the visitor's client; the app is only
  the authenticator. §6.
- **O5** Per-page pseudonyms; report-only abuse tag; no shared pseudonym blocklist (this drops the brief's
  "Flagship-signed shared spam blocklist" and the "refuse listed senders" setting). §6.2, §9.
- **O6** New accounts start slow; replies unlimited. §9.4.
- **O7** Per-device caps with App Attest/DeviceCheck and Play Integrity. §9.5.
- **O8** Nothing a visitor sends can hack the author: verify first, strict schema, text only, strict CSP. §12.
- **O9** Name and structure the web pieces as reusable primitives (`flagship-web`). §6, §8.

## 1. Terms and keys

- **Owner**: the account whose page it is. **Visitor / sender**: another Flagship account writing to it.
- **pageId**: 16 random bytes, lowercase hex (32), minted at the first publish, never changes (survives a later
  username change on `feat/custom-names`).
- **Sensitive key**: the account's pinned admin root, else its IRK (the `authorizeSensitiveComOp` rule).
- Canonical bytes: `tag|field|…` UTF-8 as in `packages/protocol` (`pq-suites.md` §2.1 strict subset). Integers are
  decimal ms; keys and hashes lowercase hex; absent = empty string; lists joined by `,`.
- `H(x)` = SHA-256, lowercase hex. `KDF(umk, info)` = HKDF-SHA256(ikm = UMK, salt = empty, info, 32), the same
  `derive` the existing key helpers use (`packages/protocol/src/keys.ts`).

Keys (all derived from the UMK, so every device of an account has them; non-admin devices hold the UMK today):

| Key | Derivation | Type | Use |
|---|---|---|---|
| Owner inbox key | `KDF(umk, "flagship/voici-inbox/v1|<pageId>|<inboxEpoch>")` as the X-Wing seed | X-Wing (hybrid) | opens messages to the page |
| Owner messages signing key | `KDF(umk, "flagship/voici-owner-sign/v1|<pageId>|<inboxEpoch>")` | Ed25519 | signs replies, blocks, phone acks |
| Messages secret | `KDF(umk, "flagship/messages-secret/v1")` | 32 bytes | root of the sender's pseudonyms |
| Pseudonym key P | `HKDF(messagesSecret, "flagship/messages-pseudonym/v1|<pageId>")` | Ed25519 | the sender's identity toward one page |
| Thread key T | `HKDF(messagesSecret, "flagship/messages-thread/v1|<pageId>")` as the X-Wing seed | X-Wing | opens replies and the sender's own copies |
| Drafts key | `KDF(umk, "flagship/voici-drafts/v1")` | AES-256-GCM key | seals post drafts between the owner's devices |
| Messages state key | `KDF(umk, "flagship/messages-state/v1")` | AES-256-GCM key | seals nicknames, blocks, read marks |
| Browser key B | WebCrypto ECDSA P-256, `extractable: false` | P-256 | signs every web request of one sign-in |

`inboxEpoch` starts at 1 and moves when the owner rotates the inbox (Settings, or automatically after Wipe &
restart, which makes a new UMK anyway).

**Why no per-device fan-out.** Every device of an account holds the UMK, so a key derived from it reaches all of
them, including devices added later (they see the history). Wrapping per device would publish the device count and
add no protection: a device that is removed still holds the UMK. If restricted (UMK-less) devices ever ship, they get
the inbox key through the directory-key grant mechanism (AGENTS open work item 5). Open decision D1.

## 2. The page

### 2.1 What a visitor sees (top to bottom)

1. Avatar (circle, 128 px CSS), display name, bio.
2. Links, in the owner's order, each a full-width button: a known-site icon (§2.4) or a generic link icon, the label,
   the host in small type.
3. **Send me a message**: the primary button, only while the index says `acceptsMessages = 1`.
4. Posts, newest first: date, text, up to 3 link cards. "Show older posts" loads the next chunk.
5. Footer: "Report this page", "Made with Flagship", the language picker.

### 2.2 Template

One layout. Three variants, chosen in the editor: `classic` (default; warm off-white, ink text, one accent),
`ink` (dark), `sea` (cool accent). Each follows the visitor's light/dark setting except `ink`. Fonts are the site's
own (`apps/web/public/fonts`), no web-font calls. Nothing else is configurable.

### 2.3 The photo: upload, re-encoded on the device (decided)

Upload, not link. A linked avatar would make every page view call a third-party host (tracking, and a host that can
swap the image). The editing device re-encodes from pixels: square crop, 512 × 512, JPEG quality 0.82, sRGB, no
EXIF/XMP/ICC/GPS (writing fresh from a bitmap drops all of it; the test checks the output has no APP1/APP2 segment).
Cap 150 KiB after encoding (step the quality down to 0.6, then refuse). iOS: ImageIO `CGImageDestination`; Android:
`Bitmap.compress(JPEG)`; webapp: `OffscreenCanvas.convertToBlob({type: "image/jpeg"})`.

### 2.4 Links

Up to 12. `https://` only (also `mailto:` for one email link), at most 512 chars, label at most 40. The host is shown
under the label so a label cannot hide where a link goes. Known-site icons come from one shared table,
`packages/protocol/src/voiciLinkSites.json`: `[{id, hosts:[...], label}]` (about 40: GitHub, Mastodon by
`/@user` path on any host, Bluesky, LinkedIn, Instagram, YouTube, TikTok, X, Threads, Facebook, Twitch, Substack,
Medium, Patreon, Ko-fi, Spotify, SoundCloud, Bandcamp, Behance, Dribbble, Stack Overflow, Reddit, Discord, Telegram,
Signal, WhatsApp, Flagship apps `*.flagship.services`, ...). Icons are monochrome SVGs bundled with the site and the
apps; matching is by exact host or host suffix, decided on the editing device and stored as `site` in the profile
piece (the renderer trusts only ids in its own table).

### 2.5 Posts and link cards

- Text, at most 2,000 characters after NFC; up to 3 links. Text is shown as text (§12.3).
- **Link cards.** The editing device fetches the link once when the post is written (GET, 5 s, 512 KiB cap, no
  cookies, no JavaScript; reads `og:title`, `og:site_name`, `og:description`, `og:image`), keeps title (120),
  site (60), description (200) and re-encodes the image (400 × 210 max, JPEG, 40 KiB) into a piece. The visitor's
  browser loads nothing from the linked site until the visitor clicks; the click opens it in a new tab
  (`rel="noopener noreferrer nofollow ugc"`, `referrerpolicy="no-referrer"`). No iframes, no players. The owner can
  remove a card and keep the link. Cost: the linked site sees the owner's device fetch it once (D9).

### 2.6 Formats

**Profile piece** (`application/json`, at most 16 KiB):

```text
{v:1, displayName, bio, avatar: <sha256>|null, theme: "classic"|"ink"|"sea",
 links: [{url, label, site: <id>|null}]}
displayName 1..64 chars, bio 0..280 chars, after NFC; refused: control chars except "\n" in bio, bidi controls
(U+202A-U+202E, U+2066-U+2069), U+FEFF.
```

**Posts chunk** (`application/json`, at most 256 KiB). Posts are kept in creation order in chunks of at most 20;
chunk 0 holds the oldest. Adding a post rewrites only the last chunk (a new piece); editing or deleting rewrites the
chunk that holds it.

```text
{v:1, chunk:<n>, posts:[{id:<32 hex>, createdAt, editedAt|null, text,
  links:[{url, card:{title, site, description, image:<sha256>|null}|null}]}]}
```

A deleted post is removed from its chunk (no tombstone on the public page).

**Images**: `image/jpeg`, the caps above. The renderer checks the JPEG magic and the size; the browser decodes.

### 2.7 The index: `flagship/voici-page/v1`

```text
flagship/voici-page/v1|<username>|<pageId>|<seq>|<issuedAt>|<acceptsMessages 0|1>|<inboxEpoch>|<inboxPub>
  |<ownerSignPub>|<pieces>|<signerKind admin-root|irk>|<signerPub>
pieces  = sorted list of "<role>:<sha256>:<size>"; role is "profile", "avatar", "chunk-<n>" (n decimal,
          0-based, contiguous) or "card-<sha256 prefix 16>"
inboxPub  X-Wing public key, hex (1216 bytes)
ownerSignPub Ed25519, hex
```

Envelope: `{kind:"VoiciPage", version:1, username, pageId, seq, issuedAt, acceptsMessages, inboxEpoch, inboxPub,
ownerSignPub, pieces:[{role, sha256, size}], signerKind, signerPub, signature}`. `seq` starts at 1 and rises by
exactly 1. Caps: 2,000 pieces, 300 KiB index. **No cap on the number of posts or the total page size** (owner):
only per-piece caps and per-day upload brakes (§9.4).

### 2.8 Storage and caching

R2 bucket `flagship-voici` (gym `flagship-voici-gym`), binding `VOICI`, custom domain `files.voi.ci`
(gym `files.gym.voi.ci`) with a cache rule that ignores query strings (as `relay-mesh.md` §4.5):

| Object | Content | Cache-Control |
|---|---|---|
| `v1/u/<username>.json` | the current signed index | `public, max-age=30` |
| `v1/p/<pageId>/<sha256>` | a piece (bytes as uploaded) | `public, max-age=31536000, immutable` |

Pieces live under their page (no cross-account deduplication: it would tell two owners they share a photo). A piece
no index has referenced for 30 days is deleted by a budgeted cron step. A takedown or account deletion deletes the
index object and the page's pieces and purges `files.voi.ci` by URL (Cloudflare API, `CLOUDFLARE_PURGE_TOKEN`).

### 2.9 Anti-rollback

- `.com` refuses any index whose `seq` is not `stored + 1` (D1 compare-and-set) and keeps the last accepted index
  in D1; R2 holds only the current one.
- The renderer remembers the highest `seq` it verified per `pageId` (localStorage) and refuses a lower one ("This
  page is out of date. Reload."). A cache or CDN that serves an older signed index is caught by anyone who saw the
  newer one; a first-time visitor can be shown an old but genuine page for at most the cache lifetime.
- `issuedAt` must be within 10 minutes of `.com`'s clock at upload.

## 3. Publishing API (`.com`)

All under `https://flagshipserver.com` (gym: the gym apex). JSON errors `{error, code, ...}`; codes only, the apps
write the sentences.

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/voici/pages/<u>/pieces` | sensitive-key signature over `flagship/voici-piece-upload/v1|<u>|<pageId>|<sha256>|<size>|<issuedAt>` in headers; body = the piece | stores one piece (idempotent) |
| `POST /api/voici/pages/<u>/publish` | the index's own signature | checks and stores the index |
| `GET /api/voici/pages/<u>` | none | `{index}` (the same as R2; for apps) |
| `POST /api/accounts/<u>/voici-drafts` | device headers (as `/profile`) | deposit a sealed draft op (§5.2) |
| `GET /api/accounts/<u>/voici-drafts` | read token | list draft ops |
| `POST /api/accounts/<u>/voici-drafts/consume` | sensitive key | delete ops an admin device published |

Publish checks, in order: size; strict JSON shape; account exists, not banned from pages, page not taken down;
`signerPub` is the account's sensitive key now; signature; `seq = stored + 1` (else 409 `seq-conflict` with the
stored index); every piece present in R2 under this page with the declared size and hash (re-hashed on upload);
the profile and chunk pieces parse under §2.6; `inboxPub`/`ownerSignPub` well formed. Then D1 row, R2 index, done.

Refusal codes: `malformed`, `too-large`, `not-sensitive-key`, `bad-signature`, `stale`, `seq-conflict`,
`missing-piece`, `bad-piece`, `taken-down`, `banned`, `rate-limited` (+`retryAfterSec`), `not-found`.

## 4. The voi.ci site

### 4.1 Routing on `voi.ci`

The `voi.ci` host is already routed to `flagship-com` (`apps/com/src/route.ts`, `handleVoiciRedirect`). New order
for `GET /<name>`:

1. A live custom name or code (`docs/named-links.md`) → its redirect, unchanged.
2. A username with a published, not taken-down page → the site shell (static HTML, the same bytes for every page).
3. `/@<username>` → 301 to `/<username>`.
4. Otherwise the existing 404/410.

**One namespace.** From this release a custom link name is refused when its key (hyphens removed) equals an existing
username's key, a code is never minted equal to a username, and `username-claim` refuses a name whose key equals a
live custom name or a live or retired code. A one-off script (`scripts/voici-namespace-report.mjs`, read-only) lists
existing collisions before the deploy; the owner decides each (D2). Expected: none (custom names are new in 0.3,
codes are random).

### 4.2 The site

`apps/voici-site/` (new): plain ES modules, no bundler, no framework, vendored `@noble/hashes`,
`@noble/curves` (Ed25519) and `@noble/post-quantum` (X-Wing), as the webapp vendors them. Served by `flagship-com`'s
assets under `https://voi.ci/_/<build hash>/...`, every script tag with `integrity` (SRI). Reproducible: a build
script writes `apps/voici-site/dist/` and `dist/MANIFEST.json` (SHA-256 of every file); CI rebuilds and compares; the
manifest hash is shown on `https://voi.ci/_/about`.

Render steps: fetch `files.voi.ci/v1/u/<u>.json` and `flagshipserver.com/api/username/<u>` in parallel; check the
index signature against the account's current admin root (or IRK when it pins none) and `username`; check `seq`
against localStorage; then fetch the profile, the newest chunk and the images, check each against its hash and size,
parse, render. Any failure: "This page couldn't be checked." and nothing from the index is shown.

**Why verify in the browser** (decided): R2, the CDN cache and the Worker are three places that could serve a forged
or altered page; the key comes from a different path (`.com`'s account API). It cannot protect against a dishonest
`.com` that lies about the key, or a malicious deploy of the site itself (§12.2), but it makes storage-side tampering
visible, costs one Ed25519 verify, and is the same check the apps run.

### 4.3 What the site shows a visitor

- The page (§2.1), read-only.
- "Send me a message" → the sign-in sheet if not signed in (§6.4), else the compose box and the visitor's own thread
  with this page (their messages and the owner's replies, with "Sent", "Delivered", "Delivered to their phone").
- Under the compose box, always: "Messages are private. If someone reports your message, Flagship can see which
  account sent it." and "You appear here as Visitor 4F3A. They never see your username."
- "Sign out of this page" (deletes the browser key and the thread key from this browser; the app also lists it).
- i18n: the site's strings through the site's `i18n.js` pattern (`apps/web/public/i18n.js`), the 7 locales; the
  owner's content is never translated.

### 4.4 CSP and headers (voi.ci)

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://files.voi.ci;
  font-src 'self'; connect-src https://flagshipserver.com wss://flagshipserver.com https://files.voi.ci
  https://*.flagship.services; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
X-Frame-Options: DENY, X-Content-Type-Options: nosniff, Referrer-Policy: no-referrer,
Strict-Transport-Security: max-age=63072000; includeSubDomains, Cross-Origin-Opener-Policy: same-origin,
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

No inline script or style (the shell is static; a source-grep test fails on any). Gym: the gym apex names.
`.com` answers CORS for `https://voi.ci` (exactly that origin, no credentials) on: `GET /api/username/<u>`,
`GET /api/voici/pages/<u>`, the `/api/voici/web/*` routes (§8.3) and the `/qr-pipe` upgrade.

## 5. Publishing from the apps

### 5.1 The rule

- Any device of the account can write, edit or delete posts and edit the profile. A change that is not yet in a
  published index is **local**: shown grayed with "Not published yet" in the editor and in the device's preview,
  never on voi.ci.
- Only an admin device signs an index. When an admin device has pending changes (its own or drafts from other
  devices) and the app is open and unlocked, it publishes at once without a further prompt (the unlocked-session
  rule); in the background it waits. The editor's "Publish" button on an admin device asks for the biometric if the
  session is locked.
- A non-admin device's change becomes a **draft op** handed to the admin device (§5.2). The owner sees on that device:
  "Waiting for an admin device to publish".

### 5.2 Draft ops

```text
plaintext {v:1, opId:<32 hex>, op: "post-add"|"post-edit"|"post-delete"|"profile"|"accept-messages",
           at, deviceId, post?|profile?|accepts?}
sealed    AES-256-GCM(draftsKey, nonce 12, aad = "flagship/voici-draft/v1|<u>|<opId>")
envelope  flagship/web-envelope/v1 (§7.1) with kind "voici-draft", signed by the device key; the receiver checks
          the device's grant chain against the account's admin root.
```

Delivery: to the admin phone directly when it is live (§8), else `POST /api/accounts/<u>/voici-drafts`. `.com`
pushes the account's admin devices a content-free `page-drafts`. All devices read the lane (read token) so every
device shows every pending change grayed. After publishing, the admin device calls `consume` with the opIds.
Images ride as pieces uploaded by the admin device after it opens the draft (a draft carries the re-encoded image
bytes, at most 150 KiB each).

### 5.3 Conflicts

Two admin devices: the loser of the `seq` compare-and-set gets 409 with the stored index, fetches its pieces, merges
by post `id` (newer `editedAt`/`at` wins; a delete beats an edit; profile fields last-writer-wins by `at`), re-signs
`seq + 1` and retries (at most 3 times, then shows "Couldn't publish. Try again."). Merging is a pure function in
`packages/protocol` with vectors, ported to Swift/Kotlin/webapp.

### 5.4 Accept messages

The switch is in the index (`acceptsMessages`), so turning it on or off is a publish. `.com` enforces the stored
index as the first filter on every send (§8.3); the phone enforces its own latest.

## 6. Signing in with Flagship (visitor side)

### 6.1 Shape

```text
browser B (voi.ci) ──QR / deep link via /qr-pipe──▶ visitor's app (any device with the UMK)
   app: derive P, T for pageId; get attestation A(P) from .com; sign delegation D(P → B); sign thread statement
   app ──sealed to the browser's ephemeral X25519 via /qr-pipe──▶ browser: {P pub, A, D, threadStmt, T seed}
browser keeps B (non-extractable), T seed, A, D in IndexedDB for this page
```

One approval per page (that is also the first-contact moment). The approval screen: "Sign in to voi.ci to message
<display name from the verified index>?" with "You appear as Visitor 4F3A. They never see your username." and
"Messages are private. If someone reports your message, Flagship can see which account sent it." Biometric once.

### 6.2 Pseudonyms

P and T derive from the Messages secret and the pageId (§1): the same person gets the same pseudonym on that page
from any device and any browser, and unrelated pseudonyms on two pages. The visible name is
`"Visitor " + base32(H(Ppub))[0..4]` uppercase (i18n'd prefix). The owner can rename it locally (§11).

Accepted cost (owner decision O5): two page owners cannot compare notes to link a sender, and so there is no shared
pseudonym blocklist; abuse is handled through reports and account bans (§9).

### 6.3 Attestation: `flagship/messages-key-attestation/v1`

A new tag in the account-key-attestation family (`packages/protocol/src/accountKeyAttestation.ts`). It needs the
abuse tag inside the signed bytes, so it is not a new `keyKind` of the v1 tag.

```text
request   flagship/messages-key-attestation-request/v1|<username>|<Ppub>|<renewOfHash or "">|<deviceCheckRef>|<issuedAt>
          signed by an account device key (device headers, as /profile); webapp devices too (§9.5)
answer    flagship/messages-key-attestation/v1|<Ppub>|<abuseEpoch>|<H(abuseTag)>|<issuedAt>|<expiresAt>
          signed by .com's online CA key (FLAGSHIP_CA_PRIV_HEX), verified through the maintainer chain like every
          CA artifact; envelope {kind:"MessagesKeyAttestation", version:1, ..., abuseTag, signedBy, signature}
abuseTag  flagship/hybrid-seal/v1 to the abuse key of abuseEpoch, purpose "flagship/voici-abuse-tag/v1",
          context [Ppub]; plaintext {v:1, username, accountCreatedAt, issuedAt}
```

- Lifetime 30 days. A **renewal** names `renewOfHash = H(previous attestation JSON)`; `.com` checks it signed that
  attestation for the same P (expired at most 7 days) and does not count it as a new recipient.
- `.com` builds the tag itself (a sender cannot put someone else's account in it) and **stores no P ↔ account
  mapping**: the request is checked, counted (§9.4) and answered; the only lasting trace is the per-account counter.
  This is a promise about code, not a property the visitor can check (§13).
- Refused for a banned account (`banned`), a banned device (§9.5), over the limits (`first-contact-limit`
  +`retryAfterSec`), or an account younger than its tier allows.

### 6.4 Web delegation: `flagship/web-delegation/v1` (generic primitive)

```text
flagship/web-delegation/v1|<scope>|<origin>|<audience>|<principalPub>|<delegateAlg>|<delegatePub>|<issuedAt>|<expiresAt>|<nonce>
scope        "voici-messages" (the only scope in 0.3)
origin       "https://voi.ci" (gym "https://gym.voi.ci")
audience     the pageId
principalPub P (Ed25519), which signs these bytes
delegateAlg  "p256"; delegatePub = B as uncompressed SEC1 (65 bytes) hex
expiresAt    ≤ the attestation's expiresAt
nonce        16 bytes hex
```

The **thread statement** binds T to P: `flagship/voici-thread-key/v1|<pageId>|<Ppub>|<Tpub>|<issuedAt>`, signed by P.

Revocation: the app lists "Websites you're signed in to" (Settings → Messages) from the Messages state blob;
"Sign out" signs `flagship/web-delegation-revoke/v1|<delegatePub>|<issuedAt>` with P and posts it to
`POST /api/voici/web/revoke`; `.com` refuses B from then on (kept until the delegation's expiry). The phone learns
revocations from the mailbox fetch (`revoked: [delegatePub]`) and refuses them on direct delivery.

### 6.5 The QR pipe

Reuses `/qr-pipe` exactly as `remote.flagshipserver.com` does (`docs/` remote QR-first, AGENTS "Remote is
QR-first"): the browser shows `https://<control apex>/voici-sign-in?s=<sid>&k=<browser X25519>&p=<pageId>&u=<username>`
as a QR on a desktop, and as an "Open Flagship" button on a phone (an app link; `APP_LINK_PATHS` gains
`voici-sign-in`). Both sides show the same 6-digit code. Without the app the link opens `apps/web/public/open/`
(store buttons) with "Come back to voi.ci/<u> after installing" and a return link; the browser tab keeps waiting on
the pipe for 10 minutes. The sealed answer is `flagship/voici-sign-in/v1` (X25519 + HKDF + AES-GCM, the remote-ticket
construction). The webapp can approve too (§9.5 tier).

## 7. The message envelope

### 7.1 `flagship/web-envelope/v1` (generic primitive)

```text
{v:1, kind, audience, conv, from, msgId, seq, sentAt, body, cred, sigAlg, sig}
canonical: flagship/web-envelope/v1|<kind>|<audience>|<conv>|<from>|<msgId>|<seq>|<sentAt>|<H(bodyBytes)>|<H(credBytes)>
kind      "voici-message" (visitor → owner), "voici-reply" (owner → visitor), "voici-draft" (§5.2)
audience  pageId (voici-*) or username (voici-draft)
conv      H("flagship/voici-conv/v1|" + pageId + "|" + Ppub); "" for drafts
from      the signer's public key, hex (P for messages, ownerSignPub for replies, device key for drafts)
msgId     16 random bytes hex
seq       per (conv, from), starts at 1, +1 per message
sentAt    ms
body      canonical JSON bytes of the sealed body (below), base64 inside the JSON as "bodyB64"
cred      voici-message: {attestation, delegation, delegationSig, threadStmt, threadSig}; voici-reply: {pageSeq};
          voici-draft: {grant, grantSignature}
sigAlg    "p256" (signed by B, IEEE P1363 r‖s, hex) for voici-message; "ed25519" otherwise
```

Hard caps: whole envelope 64 KiB; body 24 KiB.

### 7.2 Sealed body

```text
{suite:"flagship/hybrid-seal/v1", nonce, ct, wraps:[{keyId, sealed}]}
CEK      32 random bytes
ct       AES-256-GCM(CEK, nonce 12, aad = "flagship/voici-body/v1|<conv>|<msgId>", plaintext)
wraps    hybrid-seal/v1 of CEK, purpose "flagship/voici-cek/v1", context [conv, msgId], to:
         voici-message: the owner inbox key (index's inboxPub) and the sender's T
         voici-reply:   the sender's T and the owner inbox key (the owner's own copy)
plaintext {v:1, text, replyTo:<msgId>|null}; text 1..2000 chars after NFC, same refusals as the bio
```

No attachments in 0.3. Links are just text.

### 7.3 Ordering, replay, receipts

- Shown in `(sentAt, msgId)` order; a gap in `seq` shows "Some messages haven't arrived yet" until it fills.
- `.com` and the phone refuse a repeated `(conv, msgId)` and `sentAt` more than 10 minutes from their clock at
  receipt. Receivers keep the highest `seq` per `(conv, from)` and drop lower or equal.
- Receipts: "Sent" (`.com` stored it), "Delivered to their phone" (a direct ack, §8.2), "Delivered" (an owner device
  fetched it; `.com` records `fetched_at`). No read receipts in 0.3 (D7).

### 7.4 Replies

Symmetric. The owner's app signs a `voici-reply` with the owner messages signing key, wraps to T (from the verified
thread statement of that conversation) and the owner inbox key, and posts it to the mailbox. No attestation: the
reply's key is in the page's signed index. The visitor's browser checks the reply against the verified index's
`ownerSignPub` for the stated `pageSeq` or later.

## 8. Delivery

### 8.1 Paths

1. **Direct to the phone.** When the visitor opens the compose box, flagship-web pings
   `GET https://<u>.<servicesApex>/api/phone/live` (2 s timeout). A `200 {live:true, ownerSignPub}` with the
   page's `ownerSignPub` means the admin phone holds the name: messages go there. Anything else: mailbox.
2. **Mailbox.** `POST https://<control apex>/api/voici/web/send`.

Native draft delivery (§5.2) uses the same two paths from the apps.

### 8.2 The phone endpoint (`phone-route.md` §4, replaced in part)

Retired: `POST /api/phone/session`, `POST /api/phone/ping`, the `__Host-flagship-phone` cookie. `phoneEndpointCheck`
and its rules (Host exactly the phone's name, Origin exactly `https://<name>`, host-only cookie, CSRF header, no CORS)
stay in `packages/protocol/src/phoneRoute.ts` for any later browser operation, unused in 0.3.

New, the only operations reachable cross-origin, and only from the origins in `PHONE_WEB_ORIGINS`
(`["https://voi.ci"]`, gym `["https://gym.voi.ci"]`), a constant in `phoneRoute.ts`:

| Request | Answer |
|---|---|
| `OPTIONS /api/phone/deliver` with `Origin` in the list, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers` exactly `content-type` | `204`, `Access-Control-Allow-Origin: <that origin>`, `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: content-type`, `Access-Control-Max-Age: 600`, `Vary: Origin`; never `Allow-Credentials` |
| `GET /api/phone/live` | `{live:true, account, ownerSignPub}` (current page's), CORS for a listed origin |
| `POST /api/phone/deliver`, `Content-Type: application/flagship-envelope+json` (a non-simple type: a preflight always runs), body = one envelope | `200 {ack}` or `{error, code}` |
| anything else with an `Origin` header | `403`, no CORS headers |

Requests with no `Origin` (native apps) reach the same two operations. No cookie is read or set. Authentication is
the envelope's own chain. The phone checks, in order (§12.1), stores, forwards to the mailbox
(`POST /api/voici/web/send` with `direct: true`; `.com` dedupes by msgId), then acks:

```text
ack  flagship/voici-ack/v1|<conv>|<msgId>|<receivedAt>|<phoneRoutePub>
     signed by the owner messages signing key (voici-message) or by the admin device key (voici-draft)
```

A native sender also checks the TLS leaf's public key equals the ack's `phoneRoutePub` (the pin) and, for drafts,
that the signing device key holds an admin grant of its own account (from its read-token `device-grants`). A browser
cannot see the leaf; for it the ack signature under the verified page's key is the proof of delivery. A message is
sealed end to end, so a wrong peer learns only that a message was sent.

Phone limits: body 64 KiB; 8 concurrent requests; 20 deliveries a minute per `from`, 120 a minute in all; over that
`429`. Only while the app is in the foreground (that is when it holds the name).

### 8.3 Mailbox API (`.com`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/voici/web/send` | the envelope | store a voici-message or voici-reply |
| `POST /api/voici/web/thread` | B signature over `flagship/voici-thread-fetch/v1|<conv>|<since>|<issuedAt>` + the cred | the visitor's thread (both directions), since a cursor |
| `GET /api/voici/pages/<u>/inbox?since=` | read token of `<u>` | the owner's conversations: envelopes since a cursor, blocks, revoked delegations |
| `POST /api/voici/pages/<u>/block` | `flagship/voici-block/v1|<pageId>|<Ppub>|block|unblock|<issuedAt>` signed by ownerSignPub | the `.com` filter |
| `POST /api/voici/web/revoke` | §6.4 | refuse a browser key |
| `POST /api/voici/reports` | §9.2 | report |
| `PUT/GET /api/accounts/<u>/messages-state` | device headers / read token | the sealed state blob, version compare-and-set |

Send checks, cheapest first (filters on the claimed `from` only ever drop): size → outer JSON shape → page exists,
`acceptsMessages`, not taken down → `from` not blocked by this page, not a banned pseudonym, delegation not revoked
→ rate limits (§9.4) → signatures: delegation by P, attestation by the CA chain (cached per isolate), its abuse-tag
hash, thread statement, envelope by B; for replies the page's ownerSignPub → `(conv, msgId)` unique, `sentAt` fresh →
store → push. The body is never opened by `.com`.

Retention: 180 days from storage (D6); devices keep their own copies. Push: content-free, category `messages`,
kind `message` (an accepted conversation) or `message-request` (a new one; at most one push per conversation per
hour), to every device of the owner with a push token; `page-drafts` to admin devices. The APNs text is fixed and
localized (`pushBridge.ts` `APNS_ALERTS`: "New message").

### 8.4 What `.com` learns (honest)

| Learns | Does not learn |
|---|---|
| At sign-in: account S asked for an attestation of some key P (not stored after the answer, but seen) | message text, link text, nicknames |
| On every send: pseudonym P wrote to page X, when, how big, from which IP | S's username from a send (unless it kept the attestation request, which the code does not) |
| Direct deliveries: the same, later, when the phone forwards | which pages one sender writes to, unless it logs attestation requests |
| Who the page owner is (the page is public) | anything inside the abuse tag (offline key) |

So `.com` can, if it chose to log, map S to every page S writes to. Sealed sender with blind tokens (Privacy Pass,
RFC 9578) would close it and is listed as later work (§13).

## 9. Abuse

### 9.1 Block (per receiver)

Local (in the Messages state blob, so every owner device hides the conversation) and the signed `.com` filter. A
blocked pseudonym's sends are dropped before any signature check; the browser sees `accepted` with no delivery
(no oracle). The phone enforces its own copy.

### 9.2 Report

- **A message** (owner, in the app): `{kind:"message", pageId, envelope, reason, attached?}` signed by
  ownerSignPub. `attached` is the plaintext re-sealed with `hybrid-seal/v1` to the current abuse key, only if the
  owner ticks "Include the message text" (default off; the sheet says Flagship can then read it).
- **A page** (anyone, on voi.ci, "Report this page"): `{kind:"page", username, seq, reason, note ≤ 500}`;
  anonymous, or signed with B when signed in. Reasons: spam, harassment, impersonation, illegal, other.
- Stored in D1 `voici_reports`; the reporter's IP is not stored (rate limits count it in Durable Objects only).

### 9.3 The abuse key, review and bans

- **Key** (recommended, D4): an X-Wing key pair per quarter (`abuseEpoch`), generated offline; the private seed is
  wrapped with `age` to both owner YubiKeys (`age-plugin-yubikey`) and kept in `.maintainers/abuse-keys/<epoch>.age`
  (public halves beside it). The public list is signed by the cold ca-track key as
  `flagship/abuse-key/v1|<epoch>|<xwingPub>|<notBefore>|<notAfter>`, the way security notices are, and `.com` loads it
  from the checkout. Rotation: a new epoch each quarter; an old seed is destroyed 120 days after its `notAfter`
  (attestations live 30 days, reports are accepted 90 days), after which its tags can never be opened. Alternative
  (not recommended): a `.com` Worker secret; then `.com` could open every tag in bulk.
- **Review** (`npm run voici-abuse`, `scripts/voici-abuse.mjs`, needs `FLAGSHIP_ADMIN_SECRET`):
  `list`, `show <id>`, `open-tag <id>` (runs locally, unwraps the epoch key with a YubiKey touch, prints the
  username), `ban <username> <report-id> <reason>`, `unban`, `dismiss`, `takedown <username> <reason>`, `restore`.
- **Ban** (`POST /api/admin/voici/ban`): D1 `voici_bans`; the reported pseudonym goes into `voici_banned_pseudonyms`
  at once; `.com` refuses the account's attestation requests and renewals from then on, so its other pseudonyms stop
  within 30 days (D8); its devices are marked (§9.5) on their next contact. The account itself keeps its servers.
- **Appeal**: `apps/web/public/abuse.html` gains the appeal address and form; the owner answers with `unban` or
  `restore`. The banned app shows "Your account can't send messages. If you think this is a mistake, tell us."

### 9.4 Limits (`rateLimit.ts` buckets and D1 counters)

| What | Limit |
|---|---|
| New recipients (non-renewal attestations) per account | age < 7 d: 3/day; 7-29 d: 10/day; ≥ 30 d: 25/day; unattested tier (§9.5): 1/day, only from age ≥ 7 d |
| Messages per conversation before the owner replies or taps Accept | 3, then refused `awaiting-reply` |
| After that, per conversation | 30/hour, 200/day |
| Replies by the owner | no product limit (the per-IP brake only) |
| New conversations into one page | 200/day (protects the owner; then `page-busy`) |
| Sends per IP | 60/hour |
| Sign-in pipes per IP | the existing `qr-pipe-upgrade` budget |
| Page publishes per account | 100/day; pieces 50 MiB/day |
| Reports per IP | 10/hour |

New buckets: `voici-send`, `voici-publish`, `voici-piece`, `voici-report`, `voici-thread`, `messages-attest`.
The 429 carries `retryAfterSec` as today.

### 9.5 Per-device caps (App Attest, DeviceCheck, Play Integrity)

At Messages enrollment (an account's first attestation request) and on each later request, the app sends:

- **iOS**: an App Attest assertion over `H(request canonical bytes)` (key attested once per install; `.com` verifies
  the attestation object against Apple's App Attest root and keeps the key) and a DeviceCheck token.
- **Android**: a Play Integrity token (standard request, `requestHash` = `H(request canonical bytes)`); `.com`
  decodes it with Google's API and requires `MEETS_DEVICE_INTEGRITY` and the app's signing certificate.

Per device, with the bits kept by Apple (DeviceCheck: 2 bits + Apple's last-update month) and Google (Play Integrity
device recall: 3 bits):

- bit 0: "enrolled a Messages account this month". A second account on the same device in the same month is refused
  (`device-limit`). Cap: 1 new Messages account per device per calendar month (D5).
- bit 1: "banned". Set when a banned account's device next contacts `.com`, or at once with the newest stored token if
  Apple/Google still accept it. Every later enrollment from that device is refused.

What `.com` stores, per enrolled account: platform, enrolled_at, `HMAC(VOICI_DEVICE_SECRET, App Attest keyId)` (iOS)
and the newest DeviceCheck token or integrity token for 30 days (to set the ban bit), nothing else. No device
identifier, no phone number. Apple and Google learn that the app checked this device, not why. Privacy policy §
"Messages" says so.

**No attestation (the webapp, a rooted phone, a failed check).** Decided (D5): not refused, slower: the account must
be at least 7 days old, 1 new recipient a day, and at most 1 such enrollment per IP per day. The webapp can approve a
voi.ci sign-in under that tier. This keeps the webapp co-equal for everything except speed.

Owner setup: an Apple DeviceCheck key (`.p8`, secrets `APPLE_DEVICECHECK_KEY_ID`, `APPLE_DEVICECHECK_KEY`,
`APPLE_TEAM_ID`), the App Attest capability on the iOS app ID, a Google Cloud project linked in Play Console with a
service account for `decodeIntegrityToken` and device recall (`PLAY_INTEGRITY_SA_JSON`), `VOICI_DEVICE_SECRET`.

### 9.6 Takedown

`POST /api/admin/voici/takedown` (`x-admin-secret`), via `npm run voici-abuse -- takedown`: D1 `voici_takedowns`,
the R2 index and pieces deleted, `files.voi.ci` purged; `voi.ci/<u>` shows "This page isn't available." (410);
further publishes refused `taken-down`; the owner's apps show an Activity entry `voici.page.removed` with the reason
code and the appeal link. `restore` reverses it (the owner republishes).

### 9.7 Store requirements checklist

| Requirement (App Store 1.2, Google Play UGC policy) | Where |
|---|---|
| Terms that forbid objectionable content, accepted before posting or sending | a one-time "Page and message rules" sheet before the first publish and the first sign-in approval; `terms.html` §Messages |
| Filter objectionable content | new-sender limits, awaiting-reply cap, takedown, bans (§9.4-§9.6) |
| Report offensive content, in app | Report on every message and conversation; "Report this page" on every page |
| Block abusive users | Block on every conversation |
| Act on reports in a timely way (Apple: 24 h) | `voici-abuse list` is a weekly-plus duty; ops alert when a report is older than 24 h (`npm run ops -- voici`) |
| Published contact info | abuse.html, the footer link |
| Account deletion | exists; deletes the page, mailbox and pieces (§10.3) |

## 10. Owner-side state and lifecycle

### 10.1 Messages state blob

`{v:1, nicknames:{<Ppub>: name ≤ 40}, blocks:[Ppub], accepted:[conv], archived:[conv], readUpTo:{conv: msgId},
signedInSites:[{pageId, delegatePub, at}], pendingOps:[]}` sealed with the state key (AES-256-GCM, aad
`flagship/messages-state/v1|<u>|<version>`), at most 256 KiB, `PUT` with `version = stored + 1`; on conflict merge
(union for sets, newer `at` for names) and retry.

### 10.2 Rotation and recovery

Recovery keeps the UMK, so everything continues. Wipe & restart makes a new UMK: the app publishes a new index with
`inboxEpoch + 1`; old messages stay unreadable (as for every UMK-sealed thing). A visitor's sign-ins survive their own
recovery (same UMK).

### 10.3 Deletion

Account deletion: page, pieces, drafts, mailbox rows (both directions for its page), state blob, enrollment rows.
A deleted visitor's pseudonyms simply stop.

### 10.4 AI rule

Pages and messages never reach any model: no summaries, no AI drafting, nothing from Messages in a build session's
context. The box is not involved at all.

## 11. App UI (iOS reference, then Android, then the webapp)

### 11.1 Messages tab

A fifth tab between Apps and Activity: iOS `bubble.left` (`AppDestination.messages`), Android
`Icons.Outlined.ChatBubbleOutline`, webapp `view-messages` (+ `SUB_VIEW_TABS`). Unread badge.

- Top: **Your page** row (voi.ci/<u>, published/not published, "2 changes not published") → the editor.
- A segmented control: **Messages** | **Requests (n)**. A conversation is a request until the owner replies or taps
  Accept.
- Rows: nickname or "Visitor 4F3A", last line (text only, one line), time, unread dot.
- **Thread**: bubbles, text only; https URLs tappable and shown with their host; a tap asks "Open <host>?" (full URL
  shown) before leaving the app. Compose at the bottom (2,000 chars). Status under the owner's own last message.
- Menu: Rename, Accept (requests), Block, Report, Delete conversation (local and state blob; the mailbox copy
  expires).
- Empty states: "No messages yet. Turn on Accept messages on your page to get them."

### 11.2 Page editor

- **Warning (O1)**, a card above the profile fields and a confirm before the first publish: "Anyone can see this
  page. It shares your username with your apps and servers, so people can connect them." Buttons on the confirm:
  "Publish", "Cancel".
- Profile: photo (pick, crop, re-encode), display name, bio (counter), links (add, reorder by drag, delete; the icon
  appears as the URL is typed).
- Theme: three swatches.
- **Accept messages** switch with "People with a Flagship account can write to you. They appear as visitors, not by
  name."
- Posts: compose, the list (grayed "Not published yet" items, "Waiting for an admin device to publish" on non-admin
  devices), edit, delete, remove a link card.
- Preview: renders with the same rules as voi.ci (shared renderer logic; the webapp reuses the site's module).
- Publish button (admin devices); "Copy link", "Share".

### 11.3 Settings

Settings → Messages: "Websites you're signed in to" (revoke), "Rotate inbox key", "Page and message rules".

### 11.4 Sign-in approval screen (visitor's app)

§6.1 text, the 6-digit code, the page's verified display name and avatar, Approve (biometric) / Cancel. Refusals as
sentences: `first-contact-limit` "You can start {0} new conversations a day. Try again {1}.", `device-limit`,
`banned`, `unattested-too-new` "New accounts can start conversations from the web after 7 days."

### 11.5 Strings

Every string through i18n: webapp `tr()` + `node scripts/i18n-pwa.mjs extract|build`; iOS `String(localized:)` +
`scripts/i18n-ios.mjs harvest`; Android `i18n/android/en.json` + `node scripts/i18n-android.mjs build`; the site
`i18n/web`. Drafted translations for the 6 locales, listed in `i18n/REVIEW.md` (the warning, the rules sheet and the
report text need native review). `.com` returns codes only. Pushes carry no text.

## 12. Threat model

### 12.1 A malicious visitor

- **Order of checks** on the phone and on every owner device, before anything is decrypted or parsed beyond the outer
  shape: size cap → outer schema (fixed keys, types, lengths) → page accepts, not blocked, not revoked → rate limits →
  delegation, attestation chain, abuse-tag hash, thread statement, envelope signature → `(conv, msgId)` fresh →
  unwrap the CEK → decrypt → inner schema (`{v, text, replyTo}`, nothing else) → NFC and the character refusals.
  Any failure drops the message without logging its content.
- **Never HTML.** Text is put on screen as plain text (`textContent`, SwiftUI `Text(verbatim:)`, Compose `Text` with
  no `AnnotatedString.fromHtml`). Links are detected by one shared strict matcher (`https://` + host + path, no
  userinfo, punycode shown) and are never fetched or opened without a tap and a confirm. No previews of message links
  at all in 0.3.
- **Spoofing**: bidi controls and zero-width joiners at the edges are refused; the visitor's name is the generated
  one or the owner's nickname, never text the visitor chose.
- **Flooding**: §9.4 at `.com`, §8.2 on the phone, push at most once per conversation per hour.
- **Replay**: msgId uniqueness and the 10-minute window at `.com` and the phone; `seq` on devices.

### 12.2 A malicious voi.ci deploy (or XSS in it)

It runs in the visitor's browser, so it can read what the visitor types and the T seeds in that browser (all that
visitor's threads in it), and sign with B while the page is open. It cannot: sign as the visitor's account or another
pseudonym (P never leaves the app), extend B past its delegation's expiry or scope, create attestations, read the
owner's inbox (no owner keys on the web), or alter a page without the owner's signature (the apps verify pages
themselves). Mitigations: the strict CSP and SRI, no third-party code, the reproducible build and published manifest,
the source-grep tests, and deploys only from `main` (the `deploy-webapp-static.sh` guard pattern).

### 12.3 Abuse of the CORS allowance on the phone

Only `https://voi.ci` and only `deliver` and `live`; no cookies anywhere on the phone endpoint, so there is nothing a
cross-origin request can ride; every deliver carries its own full signature chain; a non-listed origin gets 403
without CORS headers; preflight is mandatory (non-simple content type) and the phone refuses a POST whose content type
is not exactly `application/flagship-envelope+json`. `live` reveals that the owner's app is in the foreground, which a
TCP connect to the bare name already reveals today (D10).

### 12.4 `.com`

It sees the metadata in §8.4, can drop or delay messages, and can lie about an account's keys (then both the site and
a visitor's app would accept a fake page; the owner's own apps would not, they hold the key). It cannot read
messages, forge a visitor (needs P) or an owner reply (needs the UMK-derived key), or open abuse tags (offline key).

### 12.5 Quantum

Message bodies are hybrid (X-Wing): recorded ciphertext stays closed. Signatures (Ed25519, P-256) are classical; a
future forger could fake old authorship but not read anything.

## 13. Risks and open points

1. **Scope.** This is a feature the size of a release (§14: ~50 agent-days). D3 waits for it.
2. **`.com` can link a sender to the pages they write to if it logs**; the "no mapping stored" rule is code, not
   cryptography. Later: blind-signed attestations (Privacy Pass).
3. **Ban latency**: other pseudonyms of a banned account keep working up to 30 days (attestation lifetime).
4. **Moderation load lands on the owner alone**, with Apple's 24 h expectation. Report spam is possible (limited per
   IP).
5. **Play Integrity device recall** and DeviceCheck token validity windows need checking against current docs before
   building (§9.5); App Attest verification in a Worker is new code (CBOR, X.509 chain, P-384).
6. **Legal**: hosting public posts needs a notice-and-action process (EU DSA), a DMCA agent if US copyright claims
   arrive; text and photos only, but photos can still be illegal content. Owner to confirm with counsel.
7. **XSS in voi.ci exposes every thread key in that browser** (§12.2).
8. **Gym needs `gym.voi.ci`** and `files.gym.voi.ci` (zone records, R2 custom domain).
9. **The phone must be in the foreground** for direct delivery; most messages will go through the mailbox.
10. **Webapp users send under the slow tier**; if the owner wants them refused instead, it is a flag in one place.

Open owner decisions:

- **D1** One account inbox key from the UMK, no per-device fan-out (recommended) vs per-device wrapping.
- **D2** `voi.ci/<username>` shares one namespace with link names and codes (rules in §4.1); how to settle any
  collision the report finds.
- **D3** Photo upload re-encoded on the device (recommended) vs link-only.
- **D4** Abuse key offline under the YubiKeys (recommended) vs a `.com` secret.
- **D5** 1 new Messages account per device per month; unattested accounts allowed on the slow tier (recommended) vs
  refused.
- **D6** Mailbox retention 180 days.
- **D7** No read receipts; "Delivered" only.
- **D8** Attestation lifetime 30 days (ban latency) vs 7 days (weekly re-sign-in on the web).
- **D9** Link cards fetched by the owner's device at post time (the linked site sees one fetch) vs no cards.
- **D10** The live ping makes "app open" visible to visitors (already visible by TCP); accept, or mailbox-only.
- **D11** Limits in §9.4 (3/10/25 a day by age; 3 before a reply; 200 new conversations a day per page).

## 14. Work breakdown

Each chunk stays in its own directories; I (release manager) stage and commit. Order: A first (3 days), then B-H in
parallel against A's vectors.

### A. Protocol and vectors (TS) — 3-4 days

- `packages/protocol/src/voiciPage.ts` (index bytes, piece schemas, caps, merge for §5.3, the namespace key),
  `voiciMessages.ts` (key derivations, envelope, sealed body, ack, block, thread statement, revoke, draft op, state
  blob), `webDelegation.ts`, `webEnvelope.ts` (generic), `messagesAttestation.ts` (request, answer, abuse tag),
  `voiciLinkSites.json`, `voiciText.ts` (NFC, refusals, the link matcher), `voiciPseudonymName.ts`.
- Vectors `packages/protocol/test-vectors/voici/` (`npx tsx tools/voici-vectors.ts [--check]`): page index (valid and
  each refusal), pieces, merge cases, derivations from a fixed UMK, delegation (P-256 signatures fixed, verify-only),
  envelope + body (fixed CEK/nonce/X-Wing seeds), reply, ack, block, draft, attestation + tag, text refusals, link
  matcher, pseudonym names.
- Phone endpoint policy in `phoneRoute.ts`: `PHONE_WEB_ORIGINS`, `phoneWebCheck` (preflight and request verdicts);
  session functions kept, routes retired.

### B1. `.com` pages, mailbox, drafts — 5 days

Migration **0123** `voici.sql` (`voici_pages`, `voici_pieces`, `voici_messages`, `voici_blocks`,
`voici_revoked_delegates`, `voici_drafts`, `messages_state`), storage types + D1 + in-memory + parity test;
`packages/control-plane/src/voiciPages.ts`, `voiciMailbox.ts`; routes in `apps/com/src/voiciRoutes.ts`; voi.ci
routing + namespace rules (`voici.ts`, `usernameClaim.ts`, `voici-name` set); CORS for voi.ci; R2 binding `VOICI`;
push categories `messages`, `page-drafts`; cron GC step (`cronPlan.ts`, `cronBudget.test.ts`); CPU budget tests for
send and publish; rate-limit buckets.

### B2. `.com` attestation, abuse, devices, admin tools — 5 days

`messagesAttestation.ts` handler + counters; abuse key loading and tag sealing; reports, bans, takedown routes
(`/api/admin/voici/*`); `deviceIntegrity.ts` (App Attest verify, DeviceCheck query/update, Play Integrity decode and
device recall) behind an interface with a fake for tests; `scripts/voici-abuse.mjs`, `scripts/abuse-key.mjs`
(generate, wrap, sign the public list), `scripts/voici-namespace-report.mjs`; `npm run ops -- voici`; `release.sh`
KNOWN_SECRETS and owner steps.

### C. flagship-web + voi.ci site — 5 days

`packages/flagship-web/` (browser ESM; `signIn.js` (qr-pipe, non-extractable P-256, IndexedDB), `envelope.js`,
`deliver.js` (live ping, direct, mailbox fallback, acks), `verify.js` (page index, replies)), tested in vitest with
Node WebCrypto against A's vectors; `apps/voici-site/` (shell, renderer, compose, thread, report, i18n, build +
manifest, CSP/source-grep tests); Worker asset wiring in `apps/com`.

### D. iOS — 8 days

Messages tab, thread, editor, preview, image re-encode, link cards, sign-in approval, Settings → Messages, state blob,
App Attest + DeviceCheck, phone endpoint `deliver`/`live` (retire the session code), drafts, push categories, A's
vectors in Swift tests, mock-gym scenarios (`GymMessages*`). Build and test on the Mac.

### E. Android — 8 days

The same in Compose; Play Integrity; Kotlin vectors; emulator mock-gym scenarios; `i18n/android`.

### F. Webapp — 5 days

`views/messages.js`, `views/thread.js`, `views/page-editor.js`, `lib/voici*.js` (reusing flagship-web where it fits),
sign-in approval (slow tier), state blob; shell bump; gym specs `web-messages-*`.

### G. Gym and conformance — 4 days

Live group `voici` in `tools/live-e2e/groups/release03/`: two throwaway accounts; publish with the admin phoneSim
online (direct) and offline (draft lane, then publish on return; grayed state via the API); a message round trip
browser → mailbox → owner → reply → browser; the same with the phone live (direct + ack + forward); block (dropped,
no oracle); report → `open-tag` with a gym abuse key → ban → attestation refused; first-contact limit; takedown (410,
pieces gone); the CORS rules from a fake origin. `phoneSim` gains `deliver`/`live`. A headless browser run of the
site (Playwright, already in the webapp gym). `.com` unit tests ride with B1/B2.

### H. Copy, policy, store — 2 days

Translations, `REVIEW.md`, terms and privacy sections, abuse.html appeal, store listing notes (UGC), FAQ.

**Estimate**: about 50 agent-days; with 6 agents in parallel after A, roughly 2 to 2.5 weeks to a green `voici` gym
group, plus owner time for the keys and secrets (§9.3, §9.5), the `voi.ci` zone records, and native review of the
translations. D3 then restarts.

### Interfaces the chunks share

- A's TS functions are the reference; Swift, Kotlin, webapp and flagship-web match A's vectors byte for byte.
- `.com` HTTP shapes in §3, §8.3, §6.3; error codes as listed.
- Phone endpoint: §8.2 exactly.
- Deploy order: migration 0123 → `.com` (with `VOICI_ENABLED=off` until the apps ship; the routes answer 404) →
  store builds → `VOICI_ENABLED=on`. No box release.
