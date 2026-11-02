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
- A: **Canonical JSON** (`canonicalJson` in `webEnvelope.ts`), used for every JSON record and piece below: keys sorted
  by UTF-16 code unit, no whitespace, strings escaped exactly as `JSON.stringify` does for well-formed strings, safe
  integers only (no floats), lone surrogates refused. Pieces, sealed bodies, draft and state plaintexts must be
  canonical (parse, re-serialize, compare). Base64 is standard and padded, and must re-encode to the same string.
  Hybrid-seal `context` fields are the UTF-8 bytes of the hex strings named.

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

A: Pseudonym P and thread T derive with `KDF(messagesSecret, info)` (same HKDF, salt empty). The visible code is
base32 (RFC 4648, A-Z2-7) of SHA-256 over the **raw 32-byte** P, first 4 characters (`voiciPseudonymName.ts`).

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

C: the site draws a known site as a monogram of its table label in a ring (mail icon for `email`, the Flagship mark
for `flagship`, a link icon otherwise); no third-party brand artwork is bundled in 0.3. The apps may do the same.

### 2.5 Posts and link cards

- Text, at most 2,000 characters after NFC; up to 3 links. Text is shown as text (§12.3).
- **Link cards.** The editing device fetches the link once when the post is written (GET, 5 s, 512 KiB cap, no
  cookies, no JavaScript; reads `og:title`, `og:site_name`, `og:description`, `og:image`), keeps title (120),
  site (60), description (200) and re-encodes the image (400 × 210 max, JPEG, 40 KiB) into a piece. The visitor's
  browser loads nothing from the linked site until the visitor clicks; the click opens it in a new tab
  (`rel="noopener noreferrer nofollow ugc"`, `referrerpolicy="no-referrer"`). No iframes, no players. The owner can
  remove a card and keep the link. Cost: the linked site sees the owner's device fetch it once (D9).

F: the webapp makes no cards: its CSP reaches only Flagship's hosts and a site's page can't be read cross-origin, so
its posts carry their links with `card: null`. It still removes a card made on a phone.

### 2.6 Formats

**Profile piece** (`application/json`, at most 16 KiB):

```text
{v:1, displayName, bio, avatar: <sha256>|null, theme: "classic"|"ink"|"sea",
 links: [{url, label, site: <id>|null}]}
displayName 1..64 chars, bio 0..280 chars, after NFC; refused: control chars except "\n" in bio, bidi controls
(U+202A-U+202E, U+2066-U+2069), U+FEFF.
```

A: Lengths are Unicode code points after NFC; stored text must already be NFC (`not-nfc`). Also refused everywhere:
DEL, C1 controls (U+0080-U+009F), lone surrogates, and U+200B-U+200D / U+2060 at the start or end. Link URLs: `https://`
with a lowercase ASCII host of at least two labels (punycode for IDNs), optional port, no userinfo, the path from the
RFC 3986 unreserved/sub-delims/`%:@/?#[]` set; at most one `mailto:` link per profile; `site` must be an id of the
shared table or null. Card fields: title 1..120, site 0..60, description 0..200, no newlines. The message link
matcher (`findVoiciLinks`) skips a URL whose host is followed by `@` or `:` and drops trailing `.,;:!?)'"]`.
`voiciJpegHasMetadata` is the APP1/APP2 check the re-encode tests use. Rules: `packages/protocol/src/voiciText.ts`.

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
exactly 1. A: `acceptsMessages` is the integer 0 or 1 in the JSON too; pieces are sorted by the
`"<role>:<sha256>:<size>"` string in code-unit order; a `profile` piece is required; a card role is `card-` + the
first 16 hex of that piece's own hash; per-role size caps apply in the index (profile 16 KiB, chunk 256 KiB, avatar
150 KiB, card image 40 KiB). `voiciPieceRefsOk` checks the avatar and card images the content names are exactly the
listed image pieces. Caps: 2,000 pieces, 300 KiB index. **No cap on the number of posts or the total page size** (owner):
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
| B1: `GET /api/voici/pages/<u>/pieces/<sha256>` | none | a piece the stored index lists (the webapp's read) |

Publish checks, in order: size; strict JSON shape; account exists, not banned from pages, page not taken down;
`signerPub` is the account's sensitive key now; signature; `seq = stored + 1` (else 409 `seq-conflict` with the
stored index); every piece present in R2 under this page with the declared size and hash (re-hashed on upload);
the profile and chunk pieces parse under §2.6; `inboxPub`/`ownerSignPub` well formed. Then D1 row, R2 index, done.

Refusal codes: `malformed`, `too-large`, `not-sensitive-key`, `bad-signature`, `stale`, `seq-conflict`,
`missing-piece`, `bad-piece`, `taken-down`, `banned`, `rate-limited` (+`retryAfterSec`), `not-found`.
A: plus `wrong-page` (the index names another pageId than the stored one: a pageId never changes).

F: the wire the webapp sends is the iOS client's (`apps/mobile/shared/Sources/FlagshipCore/VoiciCom.swift`), so `.com`
serves one shape: a piece upload carries headers `x-flagship-page-id`, `x-flagship-sha256`, `x-flagship-size`,
`x-flagship-issued-at`, `x-flagship-signer-pub`, `x-flagship-signature` and the bytes as `application/octet-stream`;
publish is `{index}`; a draft deposit is `{envelope}` with the device headers; the drafts list is `{drafts:[envelope]}`;
consume is `{opIds, issuedAt, signerPub, signature}`, signed by the sensitive key over
`flagship/voici-drafts-consume/v1|<u>|<opIds sorted, joined ,>|<issuedAt>` (iOS, Android and the webapp agree). The
webapp's shell CSP reaches only the control and services apexes, so it reads pieces from `.com`:
**`GET /api/voici/pages/<u>/pieces/<sha256>`**, no auth, the same bytes as `files.voi.ci/v1/p/<pageId>/<sha256>`,
immutable, 404 for a piece the account's stored index doesn't list (B1). (The alternative, `https://files.voi.ci` in
`shellCsp`'s connect-src, widens the shell's CSP for one read.)

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

C: as built. The site is `apps/voici-site/src` (plain modules) plus `packages/flagship-web/src`; `node
apps/voici-site/build.mjs` writes it to `apps/web/public/_voici/<dir>/` (the `.com` Worker has one assets directory,
apps/web/public) with `MANIFEST.json` (`{v:1, files:{path: sha256}}`; the build id is SHA-256 of that file, `<dir>` its
first 16 hex), and writes `apps/com/src/voiciSiteBuild.generated.ts` (build id, the listed files, the shell HTML).
`--check` (and `apps/voici-site/tests/site.test.ts`) rebuild and compare byte for byte. The shell is served from that
module for every page and `/_/about` (an ASSETS fetch of `/_voici/index.html` would be a 307 under the default
html_handling); `/_/<dir>/<file>` serves only listed files of this build, immutable, else 404
(`apps/com/src/voiciSite.ts`). SRI: every script and stylesheet tag, and a `modulepreload` with `integrity` for every
module (an import map would need an inline script). Images are fetched, hash-checked, then shown from `blob:` URLs.
`apps/voici-site/dev/serve.mjs` is a local preview with signed sample pages; `dev/screenshots.mjs` renders it in
Playwright and fails on any console error or CSP violation (usable by G's headless run). Owner/B1: `files.voi.ci`
(R2 custom domain) needs a CORS rule allowing GET from exactly `https://voi.ci` (gym `https://gym.voi.ci`), or the
site cannot read the index and pieces.

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

C: `img-src 'self' blob:` instead of `img-src 'self' https://files.voi.ci`: the page shows only image bytes it already
checked against the signed index, so it shows them from `blob:` URLs it minted, never straight from files.voi.ci.

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
          A: the envelope's msgId IS the opId (so the receiver can form the aad before decrypting); the body is
          canonicalJson({suite:"flagship/voici-draft/v1", nonce:<hex>, ct:<b64>}); the plaintext fields are
          post-add/post-edit `post`, post-delete `postId`, profile `profile`, accept-messages `accepts` (0|1), and
          optional `images:[{sha256, data:<b64>}]` (JPEG, ≤150 KiB each, ≤4). Because of the images a voici-draft
          envelope may be 1 MiB (body 960 KiB), not the 64 KiB of §7.1, also on the phone endpoint.
envelope  flagship/web-envelope/v1 (§7.1) with kind "voici-draft", signed by the device key; the receiver checks
          the device's grant chain against the account's admin root.
```

Delivery: to the admin phone directly when it is live (§8), else `POST /api/accounts/<u>/voici-drafts`. `.com`
pushes the account's admin devices a content-free `page-drafts`. All devices read the lane (read token) so every
device shows every pending change grayed. After publishing, the admin device calls `consume` with the opIds.
Images ride as pieces uploaded by the admin device after it opens the draft (a draft carries the re-encoded image
bytes, at most 150 KiB each).

F: the webapp always deposits a draft in the lane, also after a direct delivery to the admin phone, so every device of
the account shows it grayed; the admin device's consume clears it (merging a draft twice changes nothing).

### 5.3 Conflicts

Two admin devices: the loser of the `seq` compare-and-set gets 409 with the stored index, fetches its pieces, merges
by post `id` (newer `editedAt`/`at` wins; a delete beats an edit; profile fields last-writer-wins by `at`), re-signs
`seq + 1` and retries (at most 3 times, then shows "Couldn't publish. Try again."). A: `mergeVoiciPage(published, ops)`: ops apply in (at, opId) order; a new post appends to the
last chunk (a new chunk at 20); for an existing id the newer `editedAt ?? createdAt` wins; an edit of a post no longer
present is dropped; a delete removes the post and leaves its (maybe empty) chunk; profile and accept-messages ops win
when `at` is later than the published index's issuedAt (then than the last applied op); touched chunks stay in
creation order. Merging is a pure function in
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

A: `deviceCheckRef` is the platform of the integrity evidence sent beside the request, `ios`, `android` or `none`
(the evidence is over H(request bytes), so it cannot be inside them). The answer envelope is `{kind, version,
pseudonymPub, abuseEpoch, abuseTagHash, abuseTag (base64 of the sealed bytes), issuedAt, expiresAt, signedBy,
signature}`; `H(abuseTag)` is over the sealed bytes. The tag's hybrid-seal header has senderKeyId = SHA-256(raw P) and
issuedAt = the attestation's; the plaintext is canonical JSON. `renewOfHash` = H(canonicalJson(previous attestation)).

- Lifetime 30 days. A **renewal** names `renewOfHash = H(previous attestation JSON)`; `.com` checks it signed that
  attestation for the same P (expired at most 7 days) and does not count it as a new recipient.
- `.com` builds the tag itself (a sender cannot put someone else's account in it) and **stores no P ↔ account
  mapping**: the request is checked, counted (§9.4) and answered; the only lasting trace is the per-account counter.
  This is a promise about code, not a property the visitor can check (§13).
- Refused for a banned account (`banned`), a banned device (§9.5), over the limits (`first-contact-limit`
  +`retryAfterSec`), or an account younger than its tier allows.

B2: the route is `POST /api/accounts/<u>/messages-attestation` with the device headers (as `/profile`) and body
`{request, signature, integrity?, previous?}`: `signature` is the same device key over the request's canonical bytes
(the headers don't cover the body); `integrity` is required when `deviceCheckRef` is `ios`
(`{platform:"ios", keyId, attestation | assertion, deviceToken}`, base64, exactly one of attestation/assertion) or
`android` (`{platform:"android", token}`) and absent for `none`; `previous` is the attestation a renewal names
(`.com` keeps nothing to look it up by): it must hash to `renewOfHash`, carry the same P, be signed by `.com`'s CA key
and have `expiresAt` at most 7 days past. Answer `{attestation}`. Codes: `malformed` (400), `too-large` (413),
`not-found` (404), `stale`, `not-authorized`, `bad-renewal`, `banned`, `device-limit`, `unattested-too-new` (403),
`first-contact-limit` with `limit` and `retryAfterSec` (429; a day is a UTC calendar day), `rate-limited` with
`retryAfterSec` (429; the unattested enrollment per address, §9.5), `no-abuse-key` (503: no signed abuse key in its
window). Evidence that fails, or a platform `.com` has no keys for, is not an error: the request is served on the
unattested tier. `device-limit` is checked only for an account's first attestation; a device's ban bit refuses
every request. The rule "nothing stored or logged links P to the account" is in `apps/com/src/messagesAttestation.ts`
and its test reads every D1 table and the log after a run.

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

A: B must reach the app before it can sign D, so after the 6-digit code the browser sends, inside the pipe,
`{kind:"flagship/voici-sign-in-request/v1", origin, pageId, username, delegatePub, nonce}`; the app's answer is
`{kind:"flagship/voici-sign-in/v1", pageId, pseudonymPub, attestation, delegation, delegationSig, threadStmt,
threadSig, threadSeed}` and the delegation must carry the request's `delegatePub` and `nonce`
(`checkVoiciSignInAnswer`).
E: the relay forwards only one phone-role frame per session, so the request rides a second leg whose sid both
sides derive from the X25519 secret; see "E: delivered (Android)" in §14.

F: the pipe, as the webapp (and any app) runs it: the app joins `/qr-pipe/<sid>?role=phone` and sends
`{kind:"hello", phonePk}`; both sides derive the code and key exactly as device pairing does (`pairingRelay.js`
`deriveMaterial`: HKDF salt `flagship/qr/v1`, info `flagship/qr/enc/v1` / `flagship/qr/sas/v1`); the browser then
sends ONE frame the relay hands to the phone as `{kind:"peer-deliver", ciphertext, nonce}` (the request, AES-GCM under
that key, base64url); the app answers with one `{kind:"deliver", ciphertext, nonce}` and waits for `delivered`. The
deployed relay refuses browser-sent frames ("browser sends nothing"), so it must pass this one request through for
`voici-sign-in` sessions (B1/C).

C: the `/qr-pipe` relay is one-way (the browser only listens; the app sends one sealed frame), so the browser cannot
send the sign-in request inside the pipe. Its two fields ride in the link instead, in the fragment (it names a
person): `https://<control apex>/voici-sign-in#s=<sid>&k=<browser X25519, b64url>&p=<pageId>&u=<username>&d=<B,
SEC1 hex>&n=<nonce hex>`. The app forms the request as `{kind, origin: its configured web origin, pageId: p, username:
u, delegatePub: d, nonce: n}` and answers it as above (the answer is AES-256-GCM under HKDF(X25519, salt
"flagship/qr/v1", info "flagship/qr/enc/v1"); both sides show `u32(HKDF(..., "flagship/qr/sas/v1", 4)) mod 10^6`).
`k` binds `d` and `n` exactly as a pipe frame would: the answer is sealed to `k` and the delegation must name `d`,
`n`. Reader: `parseSignInLink` in `packages/flagship-web/src/signIn.js` (D, E, F parse the same). The browser checks
the answer's attestation against its own `signedBy` (no CA-key endpoint exists for browsers); `.com` checks the CA
chain on every send. A relay session expires after 5 min; the browser opens a new one (new QR, same B and nonce)
until 10 min.

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

Hard caps: whole envelope 64 KiB; body 24 KiB. A: (voici-draft: 1 MiB / 960 KiB, §5.2.) `msgId` is 16 bytes hex;
`cred` hashes as `H(canonicalJson(cred))`; the envelope's own JSON is not required to be canonical.

### 7.2 Sealed body

```text
{suite:"flagship/hybrid-seal/v1", nonce, ct, wraps:[{keyId, sealed}]}
CEK      32 random bytes
ct       AES-256-GCM(CEK, nonce 12, aad = "flagship/voici-body/v1|<conv>|<msgId>", plaintext)
wraps    hybrid-seal/v1 of CEK, purpose "flagship/voici-cek/v1", context [conv, msgId], to:
         voici-message: the owner inbox key (index's inboxPub) and the sender's T
         voici-reply:   the sender's T and the owner inbox key (the owner's own copy)
plaintext {v:1, text, replyTo:<msgId>|null}; text 1..2000 chars after NFC, same refusals as the bio
A: nonce is hex; ct and each `sealed` are base64; `keyId` = hex of `pqKeyId(SUITE_HYBRID_SEAL_V1, recipient pub)`;
exactly two wraps; each wrap's hybrid-seal header has senderKeyId = SHA-256(raw `from` key) and issuedAt = sentAt;
context [UTF-8 conv, UTF-8 msgId]. The body and the plaintext are canonical JSON.
```

No attachments in 0.3. Links are just text.

### 7.3 Ordering, replay, receipts

- Shown in `(sentAt, msgId)` order; a gap in `seq` shows "Some messages haven't arrived yet" until it fills.
- `.com` and the phone refuse a repeated `(conv, msgId)` and `sentAt` more than 10 minutes from their clock at
  receipt. Receivers keep the highest `seq` per `(conv, from)` and drop lower or equal.
- Receipts: "Sent" (`.com` stored it), "Delivered to their phone" (a direct ack, §8.2), "Delivered" (an owner device
  fetched it; `.com` records `fetched_at`). No read receipts in 0.3 (D7).
- A: the 10-minute window applies where a message is received for sending (`.com`, the phone); a browser or app
  reading history checks signatures only. The thread-fetch cursor `since` is `[A-Za-z0-9_-]{0,64}` ("" = start).

### 7.4 Replies

Symmetric. The owner's app signs a `voici-reply` with the owner messages signing key, wraps to T (from the verified
thread statement of that conversation) and the owner inbox key, and posts it to the mailbox. No attestation: the
reply's key is in the page's signed index. The visitor's browser checks the reply against the verified index's
`ownerSignPub` for the stated `pageSeq` or later.

C: the browser verifies a reply against the current index's `ownerSignPub` only (R2 keeps only the current index);
a reply signed under an older inbox epoch is not shown. A visitor's `seq` is the highest of their own messages in the
fetched thread plus 1 (so two browsers of the same visitor continue one sequence).

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

A: conv is "" in a draft's ack. The wire ack is `{conv, msgId, receivedAt, phoneRoutePub, signature}`. The
endpoint's verdicts (`phoneWebCheck`): a Host other than the phone's name is 421; a non-listed Origin 403; a preflight
asking for any header but `content-type` 403; a wrong method on the two paths 405; a deliver whose Content-Type is not
exactly `application/flagship-envelope+json` (no parameters) 415; a request with no Origin to any other path falls
through to the endpoint's other rules.

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

F: bodies and answers as the webapp and the iOS client use them: send `{envelope, direct}`; the inbox answers
`{items:[{envelope, storedAt, fetchedAt?, direct}], cursor, blocks:[Ppub], revoked:[delegatePub]}`; block
`{block, signature}`; report `{report, signature}`; revoke `{revoke, principalPub, signature}`; the state GET answers
the blob `{version, nonce, ct}` (404 when none) and PUT sends it with the device headers, a conflict answering 409
`{code:"version-conflict", state}`; `GET /api/users/<u>/device-grants` (read token) answers `{grants:[{grantId,
username, deviceId, devicePubHex, scopes, issuedAt, expiresAt, signatureHex, ...}]}`, from which a non-admin device
takes its own grant for a draft's `cred`.

Retention: 180 days from storage (D6); devices keep their own copies. Push: content-free, category `messages`,
kind `message` (an accepted conversation) or `message-request` (a new one; at most one push per conversation per
hour), to every device of the owner with a push token; `page-drafts` to admin devices. The APNs text is fixed and
localized (`pushBridge.ts` `APNS_ALERTS`: "New message").

C: wire shapes flagship-web uses (B1 to match). `POST /api/voici/web/send`: body = the envelope JSON; any 2xx is
"Sent"; refusals `{error, code, retryAfterSec?}`. `POST /api/voici/web/thread`: body `{conv, since, issuedAt, sig,
cred}` (sig = B over `flagship/voici-thread-fetch/v1|conv|since|issuedAt`, cred = the message cred); answer `{items:
[{envelope, storedAt, fetchedAt|null, direct}], next}` (`direct`: it came through the phone; `fetchedAt`: an owner
device fetched it); codes `revoked`, `bad-delegation`, `bad-attestation` make the site sign out of that page.
`POST /api/voici/reports` (page): `{kind:"page", username, seq, reason, note, issuedAt, signer: null | {delegation,
delegationSig, sig}}`. The phone's `POST /api/phone/deliver` answers `{ack}`.

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
- A: both carry `issuedAt`. Signed bytes: `flagship/voici-report/v1|message|<pageId>|<H(canonicalJson(envelope))>|
  <reason>|<H(attached bytes) or "">|<issuedAt>` (Ed25519, ownerSignPub) and
  `flagship/voici-report/v1|page|<username>|<seq>|<reason>|<H(note)>|<issuedAt>` (P-256 by B, with the delegation, when
  signed in). `attached` is base64; its seal has purpose `flagship/voici-report-text/v1`, context [conv, msgId],
  senderKeyId SHA-256(raw ownerSignPub).
- Stored in D1 `voici_reports`; the reporter's IP is not stored (rate limits count it in Durable Objects only).
- F: the webapp never attaches the text (sealing to the abuse key is not in client code), so its report sheet has no
  "Include the message text" box; it sends `{report, signature}` with `attached: null`.

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

B1: also `voici-new-conversation` (subject = pageId, the 200/day), `voici-owner` (inbox, block, drafts, state,
revoke: 1,000/hour per IP) and `voici-page-read` (300/min per IP); `voici-thread` is 1,000/hour per IP and
`voici-piece` 600/hour per IP plus 1,000/day per account (no budget may exceed 1,000 or the gym's
`RATE_LIMIT_SCALE = 10` pushes it past the counter's 10,000 ceiling). The per-conversation caps (3 before a reply, 30
an hour, 200 a day) and the 50 MiB of pieces a day are D1 reads, not buckets. A visitor's 4th message before a reply
is refused `awaiting-reply` (429, no `retryAfterSec`); a page over 200 new conversations a day `page-busy`.

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

B2: binding the evidence to the request. App Attest: the install's first request sends the attestation object with
`clientDataHash` = SHA-256 of the request's canonical bytes (that request is the one-time challenge: it is
device-signed and fresh within 10 minutes, so there is no separate challenge round trip); later requests send an
assertion whose clientData is those bytes, and `.com` keeps the attested key's public half and counter (keyed by
`HMAC(VOICI_DEVICE_SECRET, keyId)`, naming no account; needed to verify assertions). `apple_validation_category_01`,
when present, must be 2 (TestFlight) or 4 (App Store), plus 3 (development signing) when `APPLE_APP_ATTEST_ENV` is
`development`. Play Integrity: `requestHash` = SHA-256 hex of the request bytes; the verdict must be
`PLAY_RECOGNIZED` for the package with one of the signing certificate digests, and `MEETS_DEVICE_INTEGRITY`. Bits:
DeviceCheck bit0 / recall `bitFirst` = enrolled (this month = `last_update_time` / `yyyymmFirst` is the current UTC
month), bit1 / `bitSecond` = banned. Device recall is a Google beta and an integrity token can write bits for 14 days
only (so a ban reaches an Android device by a stored token only within 14 days, else on its next contact).

Owner setup: an Apple DeviceCheck key (`.p8`, secrets `APPLE_DEVICECHECK_KEY_ID`, `APPLE_DEVICECHECK_KEY`,
`APPLE_TEAM_ID`), the App Attest capability on the iOS app ID, a Google Cloud project linked in Play Console with a
service account for `decodeIntegrityToken` and device recall (`PLAY_INTEGRITY_SA_JSON`), `VOICI_DEVICE_SECRET`.

B2: the abuse key list is `.maintainers/abuse-keys/list.json` `{version:1, entries:[{epoch, xwingPub, notBefore,
notAfter, signature}]}`, bundled by `.com`, which uses an entry only if its signature verifies under a key that held
a ca-track mandate in the pinned chain; the newest epoch in its window seals new tags. Made and signed with
`npm run abuse-key` (signing previews unless `--sign`). Reports: the message report's wire has no username, `.com`
finds the page by `pageId` and checks the signature against that page's current `ownerSignPub`; it keeps the
envelope (its attestation carries the tag), and accepts one report per (page, msgId). `POST /api/voici/reports`
answers CORS for the voi.ci origin (page reports come from the site; §4.4's list gains it). Admin routes
(`x-admin-secret`): `GET reports[?status=all]`, `GET reports/<id>`, `POST ban {username, reportId, reason}` (the
report's pseudonym goes into `voici_banned_pseudonyms` under that report id, the device bit is set with the newest
stored token), `POST unban {username}` (and its pseudonym, and the device bit), `POST dismiss {reportId}`,
`POST takedown {username, reason}` (repeat until `done: true`: at most 300 pieces purged then deleted per call),
`POST restore {username}`, `GET stats` (for `npm run ops -- voici`). A takedown also sets `voici_pages.taken_down_at`
and `takedown_reason`; restore clears them. Gym/config vars: `VOICI_WEB_ORIGIN`, `VOICI_FILES_HOST`,
`VOICI_FILES_ZONE_ID`. For chunk B1: `isAccountBanned`, `isPseudonymBanned`, `isTakenDown`,
`deleteVoiciAbuseAccount` (account deletion) and `pruneVoiciAbuse` (the cron) are exported from
`apps/com/src/voiciAbuse.ts`.

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

A: a nickname is stored as `{name, at}` so the merge can pick the newer; readUpTo keeps the local entry when both
sides have one; signed-in sites merge by delegatePub (newer `at`); pending ops by opId; output lists sorted. Wire:
`{version, nonce:<hex>, ct:<b64>}`.

### 10.2 Rotation and recovery

Recovery keeps the UMK, so everything continues. Wipe & restart makes a new UMK: the app publishes a new index with
`inboxEpoch + 1`; old messages stay unreadable (as for every UMK-sealed thing). A visitor's sign-ins survive their own
recovery (same UMK).

F: "Rotate inbox key" (Settings → Messages, admin devices) publishes the page with `inboxEpoch + 1` under the same
UMK. Every epoch's keys derive from the UMK, so the apps open older messages with the older epoch's key: rotating
loses nothing on the owner's devices.

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

F: the webapp: the Messages tab sits between Services and Activity (`views/messages.js`, `views/thread.js`,
`views/page-editor.js`, `views/voici-sign-in.js`, shell v190). Settings → Messages also has "Approve a voi.ci
sign-in" (paste the link), and the webapp opens `/voici-sign-in?…` when the open-in-app page hands it over. The service
worker shows the content-free `messages` push as "New message" (opens the tab) and `page-drafts` as "Changes to your
page has changes waiting" text B1 chose (opens the editor); it routes `app/messages`, `app/page` and `app/page-editor`.
Links in the editor reorder with Up and Down rather than by drag.

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
- A: delivered. Ports: Swift `apps/mobile/shared/Sources/FlagshipCore/{CanonicalJson,WebEnvelope,WebDelegation,
  MessagesAttestation,VoiciText,VoiciPage,VoiciMessages,VoiciMessagesRecords,VoiciPhoneWeb}.swift`; Kotlin
  `apps/mobile/android/.../core/voici/*.kt`; browser `apps/web/public/webapp/lib/voiciProtocol.js` (façade over
  `voiciCore.js`, `voiciText.js`, `voiciPage.js`, `voiciMessages.js`; X-Wing, P-256, HKDF and AES-GCM from the vendored
  `vendor/noble-post-quantum/pq-seal.js`), which chunk C can reuse for flagship-web. Apps and the webapp carry no
  abuse-tag sealing, abuse-key list, report-text sealing or thread fetch (`.com`, the offline tool and voi.ci only).
  JSON pieces and sealed bodies with a leading byte-order mark are refused.

### B1. `.com` pages, mailbox, drafts — 5 days

Migration **0123** `voici.sql` (`voici_pages`, `voici_pieces`, `voici_messages`, `voici_blocks`,
`voici_revoked_delegates`, `voici_drafts`, `messages_state`), storage types + D1 + in-memory + parity test;
`packages/control-plane/src/voiciPages.ts`, `voiciMailbox.ts`; routes in `apps/com/src/voiciRoutes.ts`; voi.ci
routing + namespace rules (`voici.ts`, `usernameClaim.ts`, `voici-name` set); CORS for voi.ci; R2 binding `VOICI`;
push categories `messages`, `page-drafts`; cron GC step (`cronPlan.ts`, `cronBudget.test.ts`); CPU budget tests for
send and publish; rate-limit buckets.

B1: as built. Storage `packages/storage/src/voici.ts` (`storage.voici`, D1 + in-memory, one contract test over both:
`packages/storage/tests/voiciStorage.test.ts`); handlers `packages/control-plane/src/voiciPages.ts`,
`voiciMailbox.ts`; the Worker side `apps/com/src/voiciRoutes.ts`, dispatched from `route.ts` after the generic rate
limiter and B2's `voiciAbuseRoutes.ts`, before the control plane. Everything answers 404 `not-found` and voi.ci keeps
today's behaviour until `VOICI_ENABLED = "on"` (prod `"off"` in wrangler.toml; the gym `"on"`, with
`VOICI_WEB_ORIGIN = "https://gym.voi.ci"` and a `gym.voi.ci` custom domain). Wire, as the other chunks asked for it:

- **Piece upload**: headers `x-flagship-page-id`, `x-flagship-issued-at`, `x-flagship-signature`; `x-flagship-sha256`,
  `x-flagship-size`, `x-flagship-signer-pub` optional (a mismatch is `bad-piece` / `not-sensitive-key`); body the bytes.
  `.com` hashes the body and checks the signature over what it computed. Answer `{ok, sha256, size}`; re-uploading a
  stored piece is a no-op. A piece is stored unreferenced until an index lists it.
- **Piece read**: `GET /api/voici/pages/<u>/pieces/<sha256>`, no auth, immutable, only pieces the stored index lists
  (404 otherwise, and for a page taken down); content type `image/jpeg` for avatar and card roles, else JSON.
- **Publish**: body the index or `{index}`; answer `{ok, pageId, seq}`; `409 seq-conflict` carries `index` (the stored
  one, or null). A publish parses only the JSON pieces it has not accepted in that role before (D1 remembers each
  piece's role and the image hashes it names), so a new post costs one chunk parse whatever the page's size.
- **Drafts**: deposit body the envelope or `{envelope}`, with the device headers (the signing device must be the
  envelope's `from`, its `cred.grant` a live grant of this account under the admin root or the IRK); at most 200
  pending per account; `page-drafts` push to admin devices on a new op. List answers `{drafts:[envelope]}`. Consume:
  `{opIds, issuedAt, signerPub?, signature}` (or `{consume:{username, opIds, issuedAt}, signature}`), the bytes
  `flagship/voici-drafts-consume/v1|<u>|<opIds sorted, joined ,>|<issuedAt>` (`packages/protocol/src/
  voiciDraftsConsume.ts`), 1 to 200 ids; answer `{ok, removed}`. Unpublished drafts are dropped after 30 days.
- **Send**: body the envelope or `{envelope, direct}`. Answer `{ok, status:"accepted", msgId, storedAt?}` (no
  `storedAt` for a blocked or banned sender, whose message is dropped, and for a repeat of a stored msgId, which is
  how the phone's forward is deduplicated). `direct` only marks the message (no push for it); it lifts no cap. A reply
  needs an existing conversation (else `not-found`). `.com` checks signatures natively (Ed25519 and P-256 WebCrypto);
  the verdicts and their order are `checkVoiciMessage`'s, held to the shared vectors by a test.
- **Accept** (`.com`'s side of §9.4): an `unblock` order on the block route also marks the conversation accepted,
  which lifts the awaiting-reply cap (`.com` cannot see the Accept in the sealed state blob). The apps send it when the
  owner taps Accept.
- **Thread**: body `{conv, since, issuedAt, sig, cred}` (or `{fetch, signature, cred}`); the attestation must still
  hold (`bad-attestation`), the delegation too (`bad-delegation`), the browser key not revoked (`revoked`). Answer
  `{items:[{id, envelope, storedAt, fetchedAt, direct}], next, more}`; `since`/`next` are decimal row ids ("" = start).
- **Inbox**: answer `{pageId, items:[{id, envelope, storedAt, fetchedAt, direct}], cursor, more, blocks:[Ppub],
  revoked:[delegatePub]}`, at most 200 a call; what it returns is marked delivered.
- **Revoke**: `{revoke, signature}` with `{delegation, delegationSig}` or `{principalPub}`. With only `principalPub`
  the page comes from a stored message of that pseudonym signed with that key (D1 keeps each message's browser key
  for this); without one the key is refused page-less for 30 days.
- **State**: GET answers the blob `{version, nonce, ct}` or 404 `not-found`; PUT takes the blob (or `{state}`) with
  the device headers; 409 `version-conflict` carries `state`.
- **CORS**: exactly `VOICI_WEB_ORIGIN`, no credentials, on the §4.4 routes and `POST /api/voici/reports`; a preflight
  may ask only for `content-type`. The webapp origin gains `x-flagship-page-id`, `-sha256`, `-size`, `-signer-pub`.
- **voi.ci host**: a link name or code first (unchanged), then a published page's shell (410 when taken down), `/@u`
  → 301; the shell and `/_/…` are C's `voiciSite.ts`. Namespace (D2): a link name whose key is a username's is
  `taken`; no code is minted equal to a username's key; account creation (`POST /api/accounts`, and the older
  `username/claim` handler) refuses a name whose key is a voi.ci name's (live or in its wait) or any code's, 409
  `{code:"taken"}`.
- **Push**: categories `messages` (kinds `message`, `message-request`; a request pushes at most once an hour per
  conversation) and `page-drafts` (admin devices only), content-free, app links `/app/messages` and
  `/app/page-editor`; APNs alerts "New message" and "A device on your account has changes waiting to be published
  on your page." (iOS catalog keys via `scripts/i18n-server.mjs sync`).
- **Cron**: `voici-gc` runs hourly with `voici-names` (one D1 batch and one R2 delete): pieces unreferenced 30 days
  (rows first, then their objects, 1,000 a run), mail past 180 days, drafts past 30 days, expired revocations; B2's
  `pruneVoiciAbuse` rides with it.
- **Deletion**: account deletion removes the R2 index and pieces (purge with `CLOUDFLARE_PURGE_TOKEN` and
  `VOICI_FILES_ZONE_ID`), the page, mailbox, blocks, revocations, drafts and state, and B2's rows
  (`deleteVoiciAbuseAccount`). `removeVoiciPageObjects` in voiciRoutes.ts is the same removal for a takedown.
- **CA keys** for attestations: the maintainer chain's at `now`, plus `.com`'s own `FLAGSHIP_CA_PRIV_HEX` public key
  (only when the secret is set), cached a minute per isolate.

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

D: as built (iOS), and the decisions the spec left open:
- Wire, as coded against B1/B2 (`shared/Sources/FlagshipCore/VoiciCom.swift`): drafts deposit body = the envelope;
  drafts list `{drafts:[{opId, envelope, createdAt}]}`; consume `{consume:{username, opIds, issuedAt}, signature}`;
  piece upload headers `x-flagship-page-id`, `x-flagship-issued-at`, `x-flagship-signature` (body = the piece); inbox
  `{messages:[{id, envelope, storedAt, direct}], cursor, more, blocks, revoked}` (read until `more` is false); state
  GET `{state}` / PUT `{state:{version, nonce, ct}}`; send `{envelope, direct}` (the phone's forward is `direct: true`);
  block `{block, signature}`; attestation as B2's note (integrity omitted for `none`, exactly one of attestation /
  assertion, `deviceToken`, `previous` on a renewal); `limit` read from `first-contact-limit`.
- Revoke (§6.4) needs the delegation (B1's handler): only the device that approved the sign-in keeps it, so on another
  device "Sign out" only drops the site from the state blob and the browser key runs out with its delegation (≤ 30
  days). B1 may want a P-signed revoke that names only `delegatePub`.
- Ack `phoneRoutePub` (§8.2) = the route claim's `phoneRoutePub` (the phone's Ed25519 account device key, as
  `/.well-known/flagship-phone` serves it), not the TLS leaf key. A native sender checks the ack signature and that
  the signer holds an admin grant (device-grants); URLSession gives no leaf pin, so none.
- The phone endpoint answers `live` 404 `not-live` and `deliver` 503 `unavailable` while the app holds no Messages keys
  (locked, no page); 429 `rate-limited` past 8 concurrent or §8.2's per-minute budgets; a blocked sender gets
  `200 {accepted:true}` with no ack (no oracle).
- Reports from the app carry `attached: null` (A's ports have no report-text sealing): no "Include the message text".
- Accept (§11.1) is local (state blob `accepted`); `.com` cannot see it, so its `awaiting-reply` cap lifts only on a
  reply. B1 to decide whether Accept needs a signed record.
- A non-admin device's op is shown grayed until: (lane) it left the lane, or (direct) an index with a higher `seq`
  than at the ack exists.
- The sign-in link fragment (C's note) is also accepted as a query and as `flagship://voici-sign-in?…` (the gym).

### E. Android — 8 days

The same in Compose; Play Integrity; Kotlin vectors; emulator mock-gym scenarios; `i18n/android`.

E: delivered (Android). Where the spec was silent, chunk E decided the following; B1/B2/C/D/F should match or say
otherwise (the Android client is `apps/mobile/android/.../api/VoiciClient.kt`, `core/voici/VoiciCenter.kt`,
`VoiciOwner.kt`, `VoiciSignIn.kt`):

- **HTTP bodies** (all JSON, refusals `{error, code, retryAfterSec?}`):
  - `POST /api/voici/pages/<u>/pieces`: body = the piece bytes (`application/json` or `image/jpeg`); headers
    `x-flagship-page-id`, `x-flagship-piece-sha256`, `x-flagship-piece-size`, `x-flagship-issued-at`,
    `x-flagship-signer-pub`, `x-flagship-signature` (the §3 upload bytes, sensitive key).
  - `POST …/publish` `{index}` → `{index}`; 409 `seq-conflict` carries the stored `index`. `GET /api/voici/pages/<u>`
    → `{index}` or 404.
  - Drafts: `POST /api/accounts/<u>/voici-drafts` `{envelope}` (device headers); `GET` → `{drafts:[{envelope, at}]}`;
    `POST …/consume` `{consume:{opIds, issuedAt}, signerPub, signature}` where the signature is the sensitive key's
    over **`flagship/voici-drafts-consume/v1|<u>|<opIds sorted, joined ,>|<issuedAt>`** (new tag; not in chunk A).
  - `GET /api/voici/pages/<u>/inbox?since=` → `{items:[{envelope, storedAt, fetched, direct}], cursor, blocks,
    revoked}`; items hold both directions (visitor messages and every owner device's replies). `cursor` echoes
    `since` when nothing is new.
  - `POST /api/voici/web/send` `{envelope, direct?:true}`; `POST …/block` `{block:{pageId, pseudonymPub, op,
    issuedAt}, signature}`; `POST /api/voici/web/revoke` `{revoke:{delegatePub, issuedAt}, pageId, pseudonymPub,
    signature}` (P is named so `.com` can check without a lookup); `POST /api/voici/reports`
    `{report:{kind, pageId, envelope, reason, attached, issuedAt}, signature}`.
  - `GET /api/accounts/<u>/messages-state` → `{state:{version, nonce, ct}}` or 404; `PUT` `{state}` (device headers);
    409 `version-conflict` carries the stored `state`.
  - **Attestation route** (§6.3 named none): `POST /api/accounts/<u>/messages-attestation` with device headers,
    body `{request:{username, pseudonymPub, renewOfHash, deviceCheckRef, issuedAt}, signature, integrity:
    {platform:"android", token} | null}` → `{attestation}`. `deviceCheckRef` is `android` only when a Play
    Integrity token rides along (its `requestHash` = hex SHA-256 of the request's canonical bytes), else `none`.
- **Sign-in pipe: two legs** (§6.5 assumed the browser could talk on its leg; the relay forwards one phone-role frame
  per session). Leg 1 = the QR's `s` (voi.ci = `browser`, app = `phone`, hello with its X25519 key, both show the
  SAS). Leg 2's sid = base64url(HKDF-SHA256(X25519 shared, salt `flagship/qr/v1`, info
  `flagship/voici-sign-in/return-sid/v1`, 16 bytes)); the app listens there as `browser` *before* its leg-1 hello,
  voi.ci joins as `phone` and spends its deliver on the sign-in request sealed under the leg-1 key (the QR kEnc);
  the app delivers the answer on leg 1. The link's params are read from the query or the fragment.
- **Sign-in times**: the delegation and thread statement are issued 5 minutes back (clock skew between phone,
  browser and `.com`); the app judges a fresh attestation at its own `issuedAt` when `.com` is ahead by ≤ 10 min.
  Recommend `.com` backdate attestation `issuedAt` a few minutes too. The app reuses a stored attestation for the
  page while it has > 7 days left, else asks again with `renewOfHash` (within the 7-day grace).
- **Phone ack key**: `phoneRoutePub` is the phone's route-claim key (its account device key), not the TLS key, so a
  native sender checks the ack signature under `phoneRoutePub` and that this key holds an `admin-root` grant with
  `admin` scope in `/device-grants` (§8.2's TLS-leaf pin is not applied on Android).
- **Phone deliver verdicts**: a blocked sender gets `200 {accepted:true}` with no ack (no oracle, as `.com`); a
  repeated msgId 409 `duplicate`; over the caps 413/429; any failed check 403 `{code}` with no ack.
- **State blob**: a device writes its copy as is (`version + 1`) when `.com` still holds the version it last read,
  and merges (§10.1) only when another device wrote in between, so a removal (unblock, sign-out, nickname cleared)
  sticks; a device with no local change adopts `.com`'s copy.
- **Reports from the app** carry `attached: null`: apps hold no abuse key (chunk A), so Android has no "Include the
  message text" option.
- **Rules sheet**: accepted once per device (kept in the device's sealed local copy), before the first publish and
  the first sign-in approval. Pushes `messages` / `page-drafts` open `/app/messages` / `/app/page-editor`.
- **Owner setup (Android)**: the Play Integrity Cloud project number is the Gradle property
  `flagship.playIntegrityProject` (BuildConfig `PLAY_INTEGRITY_PROJECT`); 0 = unattested tier.

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
