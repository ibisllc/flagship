# Apps that run from your phone

Status: **design, for owner review** (2026-11-17). Nothing is built. Proposed for 0.6, with the risk-retiring work in
0.5 (§9). Copy that goes with it: `docs/phone-apps-copy-proposal.md`.

The owner's idea: use the "AI builds your app" flow to build small apps for people who have no server. Each app has
three states:

- **dormant**: the app's HTML, JS and CSS live on `.com` and are served statically, so it always loads;
- **mailbox**: while the phone is offline, visitors' writes are sealed to the owner and queued, like the voi.ci inbox;
- **live**: while the phone is online, it answers requests and takes in the queued writes.

Read with: `build-modes.md` (the AI build flow), `app-runtimes.md` (runtimes and the sandbox), `manifest.md`,
`app-apis.md` (who reaches an app, sign-in, ranks), `voici-and-messages.md` (the sealed mailbox, pseudonyms, abuse),
`voici-calls.md` (the phone's bare name in use), `architecture-v2/phone-route.md` (the phone's tunnel and endpoint),
`ai-privacy-and-staging.md`, `service-access-gating.md`, `plans-and-backup-offer.md`, `named-links.md`.

## 0. Decisions in one page (recommended; owner to confirm, §10)

1. **The phone runs no app code.** An app is a static bundle (runs only in visitors' browsers) plus a **declarative
   app definition** (collections, fields, rules, views, statuses) that a fixed engine compiled into the Flagship app
   interprets. No JavaScriptCore or QuickJS handlers. This is what keeps the iOS app inside App Store guideline 2.5.2
   (§5.3), and it also makes every app's behaviour checkable before it runs.
2. **One write path in all three states.** A visitor's write always goes to the app's mailbox on `.com`, sealed to the
   owner. "Live" means the phone is connected to that mailbox and answers in about a second; "dormant" means the
   write waits. The visitor's browser code is the same either way (§4.1).
3. **One engine, three hosts.** The engine is a Rust crate (`flagship-phone-app`) linked into iOS and Android the way
   the other Rust crates are, and into the box daemon. On a box it is the same app, always live (§6).
4. **Each app gets its own browser origin** on a separate registrable domain (PSL-listed), one label deep:
   `<app>--<user>.<apps zone>`. Its stable public address is its voi.ci name (§2.4).
5. **Visitors are pseudonymous per app**: a Flagship user's key toward the app is derived from their UMK and the app
   only (the existing per-app identity rule); anyone else gets a browser key made for that app's origin (§4.3).
6. **The AI build runs on the phone**, against Flagship Inference or the owner's key, through the relay, on sample
   data only. The AI never sees a real entry and never learns who the owner is (§5).
7. **`.com` sees ciphertext, sizes and timing**, plus the public bundle and the public part of the snapshot. It also
   serves the app's code, which is a weaker promise than a box gives; the doc says so plainly (§4.4).
8. **Moving to a server keeps the app, its data, its visitors' pseudonyms and its voi.ci address** (§6).

## 1. What fits and what doesn't

The test: **the owner can answer within hours, the data fits in a small database, and a visitor can live with
"received, waiting for confirmation".** An iPhone can't serve in the background (§4.2), so a phone app is an
asynchronous app with a fast path when the owner is looking at it.

| Fits | Why it works | Notes |
|---|---|---|
| Sign-up sheets (bake sale, carpool, volunteer shifts, potluck) | small rows, a capacity per slot, the owner confirms | capacity is checked when the phone takes the write (§3.3) |
| Small shop taking orders (bakery, crafts, eggs from the farm) | a catalog in the snapshot, orders as writes, statuses (new → confirmed → ready → done) | physical goods only; payment outside the app (cash, the shop's own payment link) in v1 |
| Booking (lessons, haircuts, a holiday cottage) | slots with capacity 1, holds as pending entries | double booking resolved by the phone in arrival order, the loser told at once |
| Family or club board | members-only, sealed snapshot, posts and comments | ≤ 50 members in v1 (snapshot is wrapped to each) |
| Forms and polls (RSVP, survey, vote) | write-only for visitors, counts in the snapshot | one vote per pseudonym |
| Wish lists, gift registries, lost-and-found | read the snapshot, claim an item | |

| Doesn't fit | Why | Where it belongs |
|---|---|---|
| Heavy compute (image processing, AI calls per request, search over big data) | the phone runs a fixed engine, no app code, and only while open | a box app (`node-24`, `python-3.13`) |
| Big storage (photo albums, file sharing, video) | mailbox and snapshot limits (§3.4); phone storage and battery | a box app with a files folder |
| Always-on APIs (webhooks, bots, integrations, chat with instant replies) | dormant means no answer; iOS background rules | a box app |
| Real-time multi-user (games, live docs) | no server process between visitors | a box app |
| Payments taken in the app, accounts with passwords, anything that stores card data | out of scope and a liability | Pro payment rail later, or a box |
| Anything needing secrets server-side (API keys to call other services) | there is no server side that runs app code | a box app with env vars |

## 2. The app model

### 2.1 A new runtime: `phone-static`

`runtime.base: "phone-static"` joins `node-24`, `python-3.13` and `static` in the catalog (`app-runtimes.md` §4.1). It
has no image, no port, no `start`, no `data.stores`, no `network.subdomain`. It has a bundle root and a `phone` block.
Manifest schema 2 (`manifestV2.ts`) gains it; schema 1 refuses it.

### 2.2 Manifest shape

```jsonc
{
  "schema_version": 2,
  "name": "bake-sale",
  "version": "0.1.0",
  "description": "Bake sale sign-up",
  "runtime": { "base": "phone-static", "root": "web", "engine": 1 },

  "phone": {
    "collections": {
      "slots": {
        "writers": "owner",                          // owner | anyone | signed-in | members
        "fields": {
          "label":     { "type": "text", "max": 60 },
          "starts_at": { "type": "datetime" },
          "capacity":  { "type": "int", "min": 1, "max": 500 }
        }
      },
      "signups": {
        "writers": "anyone",
        "fields": {
          "slot":  { "type": "ref", "to": "slots" },
          "name":  { "type": "text", "max": 60 },
          "item":  { "type": "text", "max": 120 },
          "phone": { "type": "phone", "private": true }   // never in a snapshot
        },
        "per_visitor": { "max_rows": 3, "edit_own": true, "delete_own": true },
        "rules": [
          { "capacity": { "group_by": "slot", "max_from": "slots.capacity", "count_status": ["new", "confirmed"] } },
          { "unique": ["slot", "name"] },
          { "open": { "until_field": "slots.starts_at" } }
        ],
        "statuses": { "initial": "new", "owner_moves": { "new": ["confirmed", "declined"], "confirmed": ["declined"] } },
        "replies": {
          "confirmed": "You're on the list for {slot.label}.",
          "declined":  "Sorry, {slot.label} is full."
        }
      }
    },
    "views": {
      "open_slots": {
        "from": "slots", "fields": ["label", "starts_at", "capacity"],
        "count": { "of": "signups", "by": "slot", "as": "taken", "status": ["new", "confirmed"] }
      },
      "who_brings_what": { "from": "signups", "fields": ["slot", "name", "item"], "where": { "status": "confirmed" } }
    },
    "mine": ["signups"],                            // a visitor may read back their own rows (sealed to them)
    "away": { "close_after_days": 21 }              // stop taking writes if the phone hasn't drained for this long
  },

  "access": { "mode": "open", "role_descriptions": { "member": "Can sign up", "manager": "Can confirm", "master": "Owns it" } },
  "migration": { "verification": "standard" }
}
```

The bundle (`web/`) is HTML, CSS, JS, images, fonts and JSON. It talks to the app only through `flagship-app.js`, a
small fixed client library served by `.com` at a fixed path on the app's origin (§4.1).

### 2.3 The definition language is closed

Everything the phone does with a write comes from this list, so every app terminates, is bounded and can be checked
by the validator before it is published. Adding a construct is an engine version (`runtime.engine`), shipped in the
binary.

| Part | v1 set |
|---|---|
| Field types | `text`, `long_text`, `int`, `decimal`, `bool`, `date`, `datetime`, `enum`, `ref`, `email`, `phone`, `list<ref+int>` (order lines). No regexes (no ReDoS); `email`/`phone` are fixed formats. `private: true` keeps a field out of every snapshot. |
| Writers | `owner`, `anyone`, `signed-in` (a Flagship pseudonym), `members` (the app's access list) |
| Per visitor | `max_rows`, `edit_own`, `delete_own`, a per-visitor rate (`per_hour`) |
| Rules | `capacity` (count per group against a constant or a referenced field), `unique` (over fields), `open` (`from`/`until`, constants or referenced fields), `requires` (a ref must exist and be in a status), `max_total` (rows in the collection) |
| Computed | `lookup` (copy a field from a ref), `mul`, `sum` over order lines (`total = sum(lines.qty * lines.item.price)`), `count`. Fixed-point decimals, no floats. |
| Statuses | one state machine per collection; only the owner (or a manager) moves a row; each move may send a fixed reply template |
| Views | projections of a collection: fields, `where` on equality/status, `count` of a child, `sort`, `limit`. Public views go into the snapshot; members views into the sealed snapshot. |

What is **not** in it, on purpose: loops, user functions, string building beyond `{field}` slots in reply templates,
network calls, time-based jobs (the owner's phone runs nothing on a schedule except the `away` rule, which `.com`
enforces from the signed snapshot).

### 2.4 Addresses

- **Origin:** `<app>--<user>.<apps zone>`, one label deep so Cloudflare's edge certificate covers it (the limit noted
  for `fshp.tech` deep names). A registrable domain of its own, submitted to the Public Suffix List
  (`psl-submission-flagship-services.md` is the template), so one app can't set cookies for another or for `voi.ci`.
  Not `*.voi.ci` and not `*.flagshipserver.com`: a hostile bundle must not be same-site with either.
- **Public address:** the app's voi.ci name (`named-links.md`), e.g. `voi.ci/bakesale`, which redirects to the origin
  and, after an upgrade, to the box (§6).
- **Not** `<app>.<user>.flagship.services`: names there resolve to the relay, and TLS for them must end on a box.

### 2.5 What is readable while dormant: the signed snapshot

The phone publishes a **snapshot** after each change it makes (debounced, at most once every 10 s) and when the
owner edits the app:

```text
flagship/phone-app-snapshot/v1
  appId | seq | issuedAt | engine | bundleHash | writesOpenUntil | views: { name: rows } | membersBlob?
  signed by the app's publish key
```

- **The publish key** is derived from the UMK and the appId (so every admin device of the account can publish), and
  bound once to the account by the sensitive-order key (admin root), the way a voi.ci page's `ownerSignPub` is. The
  browser library checks the binding against `GET /api/username/<u>` and the snapshot against the binding before the
  page sees any data.
- **Anti-rollback:** `.com` accepts only `seq = current + 1`; the browser keeps the highest `seq` it saw per app and
  refuses an older one (as `voici-and-messages.md` §2.9).
- **Members-only apps:** the members views are sealed: one content key, wrapped (`hybrid-seal/v1`) to each member's
  per-app key. ≤ 50 members in v1; past that, the app needs a box.
- **Staleness is shown:** the library exposes `issuedAt`, and the validator makes every bundle show "Updated {time}
  ago" once a snapshot is older than a day. A dormant app never pretends to be live.
- **`writesOpenUntil`** is `now + away.close_after_days` at each publish; `.com` refuses writes after it
  (`app-closed`), so an owner who vanished stops collecting other people's data.

## 3. Data

### 3.1 The database on the phone

- SQLite (the engine's own, bundled in the Rust crate, so iOS and Android behave the same), one file per app in the
  app's private storage: iOS Application Support with `NSFileProtectionCompleteUntilFirstUserAuthentication`, Android
  `noBackupFilesDir`.
- Encrypted at the page level with a key derived from the UMK and the appId and held in the Keychain / Keystore
  (`ThisDeviceOnly`). So the platforms' own device backups carry only ciphertext that a new phone can't open; they are
  not our backup.
- The engine owns the schema (generated from the definition); the owner never writes SQL. A new app version migrates
  by the engine's rules: add field, add collection, widen a limit; anything else (drop, narrow, retype) is refused by
  the validator unless the owner confirms "these entries will lose this field".

### 3.2 Backups

1. **A sealed copy on `.com`**, written after each drain that changed anything (debounced to 5 min) and daily:
   the database file sealed under `deriveAppBackupKey(UMK, appId)`, versioned compare-and-set like the Messages state
   blob (`voici-and-messages.md` §10.1). `.com` holds one current copy plus the previous one.
2. **The mailbox keeps every entry until a backup that includes it is stored.** The phone acks entries to the mailbox
   with the backup's version; `.com` deletes an entry only when its ack names a stored backup. So losing the phone
   between a drain and the next backup loses nothing (§8.4).
3. **Export** to Files / the share sheet: CSV per collection, and the sealed file.
4. **The account's servers**, once it has one: the app moves there (§6), and the box's own backups take over.

Restore needs the account (cloud recovery or another device of the account): the backup key comes from the UMK.

### 3.3 The mailbox on `.com`

The voi.ci mailbox, specialised:

- **Envelope** `flagship/phone-app-write/v1`: `{appId, collection, op (insert|update|delete), rowId, writeId,
  visitorPub, cred?, sentAt, sealed}`, signed by the visitor key. `sealed` = the fields, sealed with
  `hybrid-seal/v1` to the app's inbox key (derived from the UMK and appId) and to the visitor key (so the visitor can
  read back what they sent). `writeId` makes a retry idempotent.
- **Result** `flagship/phone-app-result/v1`: `{appId, writeId, status (accepted|refused|expired), code, rowStatus,
  reply?}`, sealed to the visitor key and signed by the publish key. A refusal carries the rule's code (`full`,
  `duplicate`, `closed`), never another visitor's data.
- **Checks on `.com`, cheapest first** (it can't read the fields): size → shape → app exists, published, not taken
  down, `writesOpenUntil` not passed → visitor key not blocked → limits (§3.4) → for `signed-in`/`members` writers the
  delegation and attestation chain (`voici-and-messages.md` §6) → signature → `writeId` unique → store → wake the
  phone (§4.1) or push.
- **What the phone checks** (everything else): the definition's types, limits, rules, per-visitor caps, then
  applies the write in arrival order (`.com`'s storage sequence), answers a result, and republishes the snapshot.

Capacity and uniqueness are therefore decided on the phone, in arrival order. While dormant, a visitor sees
"Received. {name} will confirm." and the snapshot's count as of its `issuedAt`.

### 3.4 Limits, retention and abuse

| | Free | Pro | Pro Max | Business |
|---|---|---|---|---|
| Phone apps per account | 2 | 10 | 25 | 10 per seat, pooled |
| Bundle size | 5 MB | 25 MB | 50 MB | 25 MB |
| One write | 16 KiB | 16 KiB | 16 KiB | 16 KiB |
| Mailbox, waiting (per app) | 1,000 entries or 5 MB | 10,000 or 50 MB | 25,000 or 100 MB | 10,000 or 50 MB |
| Mailbox retention (not drained) | 30 days | 180 days | 180 days | 180 days |
| Snapshot | 1 MB | 5 MB | 10 MB | 5 MB |
| Sealed backup on `.com` | 20 MB | 200 MB | 500 MB | 200 MB per app |

Numbers are a starting point for the owner, in the style of `plans-and-backup-offer.md`; file uploads (photos) are
out of v1.

Abuse, reusing `voici-and-messages.md` §9:

- **Rate limits** (`rateLimit.ts` buckets): writes per IP 60/hour; per visitor key 20/hour (or the app's `per_hour`);
  new visitor keys per app 200/day (`app-busy`); snapshot publishes per app 360/hour; bundle publishes per account
  50/day.
- **Anonymous writers:** a small proof of work per new visitor key (privacy-friendly; no third-party challenge), raised
  per app when it is flooded. Turnstile is an alternative the owner may choose (§10).
- **Owner accounts:** new accounts start slow (one phone app until the account is 7 days old), and the per-device caps
  of §9.5 (App Attest, DeviceCheck, Play Integrity) cover phone-app accounts too, since a phone-only account has no
  server to anchor it.
- **Block and report** in the owner's inbox for a visitor key (local + the signed `.com` filter, no oracle), and
  "Report this app" on every app (served by `.com` in the app's footer frame, §4.4). Reports and takedowns go through
  `npm run voici-abuse`.
- **Bundles are public**, so they can be checked: the publish path scans for known phishing patterns (login forms
  for other brands, password fields, card number fields) and holds a matching bundle for review. Writes stay
  unreadable to us.
- **No eviction:** a full mailbox refuses new writes; it never drops old ones (§8.3).

## 4. Transport, privacy, identity

### 4.1 One path: the app's room on `.com`

```text
visitor browser (app origin)                  .com                                   owner's phone
  flagship-app.js ── POST /api/apps/<id>/write (sealed envelope) ──▶ AppRoom DO ──(if connected)──▶ engine
                 ◀── result within ~1 s (sealed) ◀──────────────── AppRoom ◀── result + new snapshot ──┘
                 ◀── {queued} at once if no phone is connected
  later: POST /api/apps/<id>/results (signed by the visitor key) ◀── sealed results waiting for this key
```

- **AppRoom**, a Durable Object per app (like a call's `CallRoom`): holds the mailbox sequence, the serving lease, and
  the phone's WebSocket while one is connected. It forwards each stored write to the phone and the phone's sealed
  result back to the waiting browser (held up to 5 s, then `queued`).
- **The serving lease:** one device serves an app at a time (generation number, compare-and-set, as the bare-name
  ledger in `phone-route.md` §3). Another admin device of the account stays a standby and takes over when the holder
  leaves. A removed device's lease ends with its grant.
- **Live reads:** a bundle may ask a declared view with parameters (`query("open_slots", {day})`) or the visitor's own
  rows (`mine`). Live, the phone answers sealed to the visitor; dormant, the library answers from the snapshot
  (public views) or says "not available right now" (`mine` rows the visitor didn't keep locally).
- **Why not straight to the phone's bare name, or WebRTC?** Both work (calls prove the path), but they reveal the
  visitor's IP address to the owner's phone, need the phone's certificate and tunnel, and give the browser two code
  paths. The room path is one path in all three states. Direct delivery over the bare name stays an option for a
  later version (lower latency, no `.com` in the write path while live); WebRTC data channels add nothing for
  request and answer traffic.

### 4.2 What "live" means on each platform

- **iOS:** the phone holds the room while Flagship is in the foreground. In the background it gets a content-free push
  ("New entries in an app") and may drain in a short background task when iOS grants one (`BGAppRefreshTask`,
  `content-available` pushes are rate-limited by iOS and not guaranteed). No VoIP push: Apple allows it for calls only.
- **Android:** foreground as iOS; in the background a high-priority FCM (or UnifiedPush) message starts a short
  expedited job that drains and republishes. A user-visible "Serving your apps" foreground service is possible but
  costs battery; off by default.
- **Owner devices that are always on** (an iPad on a stand, an old Android phone on a charger) can serve all day.
  That is the honest fast path; the copy must never say "always on" (`phone-apps-copy-proposal.md`).

### 4.3 Who the visitor is

Follows the per-app identity rule (Conventions, `service-access-gating.md`):

| Visitor | Key toward this app | What the owner sees |
|---|---|---|
| Not signed in | a non-extractable WebCrypto key made by `flagship-app.js` and kept in this origin's IndexedDB | "Visitor 4F3A" (renameable), stable while that browser keeps it |
| Signed in with Flagship | `deriveAppAccountId(UMK, accountZone, serviceRef)` (`flagship/app-aid/v2|<accountZone>|<serviceRef>`, the zone being the phone's own `<account>.<apex>`) through a web delegation to a browser key (`voici-and-messages.md` §6.4), attested by `.com` without naming the account | the same pseudonym on every device of that person, unlinkable to their pseudonym in any other app |
| Member (members-only apps) | the per-app key the invite named | their name from the invite, and their rank |

Ranks: the owning account's admin devices are master, its other devices and co-managers manager, invited people
member (`app-apis.md` §5). In a phone app, managers may move statuses and read entries (a co-manager's device gets the
inbox key through the share, as with servers); members only write what the definition lets them.

### 4.4 Privacy, honestly

| `.com` learns | `.com` does not learn |
|---|---|
| That the app exists, its owner's username (public, as a voi.ci page), its bundle and public snapshot (public) | the content of any write, result, reply, private field or members view |
| Per write: visitor pseudonym key, app, size, time, IP address | which person a signed-in pseudonym belongs to (the attestation names no account) |
| When the owner's phone is connected, and how many writes it drains | the members list of a members-only app (only wrapped keys) |
| The sealed backup's size and when it changes | the database inside it |

What is weaker than a box, and must be said in the privacy policy and the app's help:

- **`.com` serves the app's code.** On a box, TLS ends on the owner's hardware and the code comes from there. Here a
  compromised `.com` could serve altered JS that reads what a visitor types before it is sealed. Mitigations: bundles
  are content-addressed and signed by the publish key; `flagship-app.js` is open source and versioned; a public log
  of bundle hashes (later) lets anyone check what was served. Moving the app to a box (§6) removes this.
- **The relay and `.com` see visitor IPs and timing**, as for voi.ci messages.

The page's CSP, set by `.com` on every app origin:
`default-src 'self'; script-src 'self'; connect-src 'self' https://<control apex>; img-src 'self' data: blob:;
form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, no inline script, no eval, no third-party anything.
So a bundle can only talk to its own mailbox: no analytics, no exfiltration to another host, and a phishing page
can't send what it collects anywhere but the owner's sealed inbox. A fixed footer frame from `.com` carries "Made
with Flagship · Report this app".

## 5. The AI build flow

### 5.1 What the AI writes

The bundle (`web/`), the manifest with its `phone` block, and `sample-data.json` (made-up rows for the preview). No
server code, no build file, no dependencies (the bundle is plain files; a framework must be vendored as files and
counts against the bundle size).

The build agent's tools: `write_file`, `read_file`, `list_files`, `validate` (the engine's validator: definition,
bundle CSP rules, every `query`/`write` call in the bundle names a declared view or collection, size), `preview`,
`ask_owner`, `finish`. The validator is the gate, as the box's `BuildWorkspace` is today.

### 5.2 Where the build runs

On the phone. A phone-only account has no box to run the loop, and the loop for this runtime is small (no installs,
no containers). The model is reached exactly as a box reaches it today, never with the owner's name or the phone's
address:

- **Flagship Inference** through the meter shim, over the relay (or OHTTP once 0.5's relays land; per the
  fail-safe rule, if our OHTTP relay fails the call falls back to the relay path, never to a direct call). Eligibility
  today needs a server that reported in the last 24 h (`build-modes.md`); phone-only accounts need a new rule: an
  attested device (App Attest / Play Integrity, §9.5 of the Messages doc) and a smaller allowance (phone-static
  builds are small; to be measured with `infra/inference/build-eval`).
- **The owner's own key**, held on the phone, called through the hub relay as box AI calls are, so the provider never
  sees the phone's IP.

The AI privacy rule holds: the prompt never carries the account, the display name, contacts or location; the app's
title and the owner's display name are filled in by the phone after the build (`{owner}` slots the snapshot fills);
everything the model reads back goes through the model redactor (a port of `buildModelRedactor`). **The AI never sees
a real entry:** it works on `sample-data.json`, and editing a live app works on a staging copy with sample data, then
the phone publishes the new version.

**Preview** is the real path with sample data: the phone publishes the draft as an unlisted preview app (random
origin, expires after 24 h, sample snapshot), serves it from its engine, and opens it in `SFSafariViewController` /
Chrome Custom Tabs. That is a browser, not code run by the Flagship app.

### 5.3 App Store rules: the biggest risk, and the answer

**The rules (read 2026-11-17 on developer.apple.com/app-store/review/guidelines):**

- **2.5.2:** "Apps should be self-contained in their bundles, and may not read or write data outside the designated
  container area, nor may they download, install, or execute code which introduces or changes features or
  functionality of the app, including other apps." (The only exception is educational apps that teach coding.)
- **4.7:** "Apps may offer certain software that is not embedded in the binary, specifically HTML5 and JavaScript mini
  apps and mini games, streaming games, chatbots, and plug-ins", but then 4.7.1 to 4.7.5 apply: privacy, a content
  filter with report and block, IAP for digital goods, **no exposing native APIs to the software without Apple's
  permission (4.7.2)**, an index of all such software with universal links (4.7.4), and age gating (4.7.5).
- The Developer Program License Agreement (the 2017 wording of §3.3, quoted from memory; check the current PDF before
  relying on it) lets "interpreted code" be downloaded only if it does not change the app's primary purpose, does not
  create a store for other code, and does not bypass the OS's security features.
- **Google Play** (Device and Network Abuse) bans downloading executable code (dex, JAR, .so) from outside Play, but
  exempts code running in a virtual machine or interpreter with indirect access to Android APIs, "such as JavaScript in
  a webview or browser"; interpreted code loaded at run time must not break any Play policy.

**What would fail:** AI-written JS handlers that the Flagship iOS app downloads and runs in JavaScriptCore to answer
visitors. That is code the app downloads and executes, which adds functionality that changes per user. 4.7 does not
rescue it: a handler is not a mini app shown to the user, and exposing the database or the network to it is exactly
what 4.7.2 forbids without permission. A reviewer could also read the whole feature as a way around 2.5.2. On
Android, QuickJS handlers would likely pass the interpreter exemption, but one design for both platforms is worth
more than that.

**The design that passes:**

1. **No app code runs in the Flagship app.** The phone runs the engine compiled into the binary and reviewed with it.
   An app definition is data (a schema, rules, views and templates), the way a spreadsheet, a form builder or a
   database app's tables are. Downloading new data does not add functionality; the functionality (store rows, check
   rules, publish views) is the same for every app and is in the binary.
2. **The bundle's code runs only in visitors' browsers**, served from the app's own web origin, like any website
   builder. The owner sees it in Safari (or `SFSafariViewController`), never in a `WKWebView` the Flagship app
   controls with native bridges. So 4.7's mini-app duties don't arise (we offer no mini apps inside our app), and
   2.5.6 (web browsing uses WebKit) is met by Safari itself.
3. **The owner manages entries in native, generic screens**: an inbox per collection, rows, status buttons from the
   state machine, reply templates, block and report, CSV export. They are the same for every app.
4. **Strangers' content in the app** (entries, names) is user-generated content under guideline 1.2: filter (the
   definition's field types and limits, text only), report and block (reused from Messages), and our contact
   information. Already met for Messages.
5. **Shops sell physical goods or services in person** (3.1.3(e): no IAP needed), and payment happens outside the
   Flagship app. Selling digital goods through a phone app is refused by the validator in v1.
6. **Before building:** describe the feature to App Review through the "contact us" form for guideline questions, and
   ship the smallest version (a sign-up sheet) to external TestFlight first, which goes through beta review.

If App Review still refuses: the iOS app keeps the builder and the inbox, and serving moves to the owner's other
devices (an Android phone, the webapp in a browser tab, a box). That is the fallback, not the plan.

## 6. The upgrade path: the same app moves to a box

A box is a phone that never sleeps. The box daemon links the same engine crate and serves the same bundle.

1. The owner gets a server. The app's page offers **Move to a server**: the phone sends the decrypted database to the
   box over the paired session (as Migrate does), signed by the admin root as an `app-copy/v1`-style order.
2. The box takes the **serving lease** for the app in its AppRoom, drains the mailbox, and from then on answers every
   write within a second, day and night. Nothing changes for visitors' browsers.
3. Optionally, **serve from the box directly**: the box hosts the bundle at `<app>.<server>.<user>.flagship.services`
   (TLS on the box, the strong promise back), the voi.ci name points there, and the old origin redirects. The mailbox
   stays as a fallback while the box is down.
4. The appId and `serviceRef` don't change, so signed-in visitors keep their pseudonyms and members keep their access.
5. **Grow it:** "Make this a full app" asks the AI to rewrite it as a `node-24` app on Postgres, on a staging copy,
   with the engine's SQLite rows imported by a generated migration. One-way; the phone version stays until the owner
   deletes it.
6. Going back (box gone, phone serves again) is the same lease handover, the other way.

## 7. Pricing

Phone apps are the **Free tier's front door**: someone with only a phone can build something useful in minutes, and
the natural next step is a server.

- **Free:** 2 phone apps, the limits in §3.4, Flagship Inference with the phone-only allowance while the promotion
  lasts. No payment needed, as `launch-mvp.md` requires.
- **Pro / Pro Max:** more apps, bigger mailboxes, 180-day retention, bigger backups. Possibly no "Made with
  Flagship" mark on paid apps (owner decision; the "Report this app" link stays on every plan).
- **Business:** several staff phones can serve the org's apps (the serving lease moves between seats; a shop where
  whoever is at the counter takes the orders), managers by seat, pooled limits.
- **The server upsell** is honest: "Want answers at 3 a.m.? Move it to a server." shown when an app often waits
  hours, or nears its mailbox limit.

Our cost per app is small: R2 for bundles, snapshots and backups (megabytes), Durable Object and D1 rows for the
mailbox, and Worker requests for writes. Static bundle requests should go through Cloudflare's cache (immutable,
content-addressed) so a popular app costs almost nothing. Measure in the spike (§9) before fixing Free's numbers.

## 8. Failure handling (one test per failure mode)

Rule (owner, 2026-11-17, `feedback_privacy_infra_fail_safe`): if Flagship's own infrastructure fails, everything
keeps working as far as it can, retrying then degrading; a setting the owner chose that fails alerts loudly. Tests
are live-gym groups (`phone-apps`) plus engine and Worker unit tests.

### 8.1 `.com` down

- Visitors who have opened the app before load it from the service worker `flagship-app.js` installs (the bundle is
  content-addressed and immutable); a new visitor gets the edge cache's copy or nothing.
- A write is kept in the browser's outbox (IndexedDB) and retried with backoff; the page says "Saved on this device.
  It will be sent when the app's service is back." `writeId` keeps the retry from counting twice.
- The owner's phone keeps its database and inbox; the owner can read and change entries; snapshot publishes and
  results queue on the phone and go out when `.com` answers.
- **Test `phone-apps-com-down`:** the gym Worker answers 503 for `/api/apps/*`; a returning visitor submits; the page
  shows the outbox line; the Worker comes back; the write arrives exactly once and the visitor gets its result.

### 8.2 The phone offline for weeks

- Writes queue until the retention ends or the mailbox fills. The snapshot ages and the page shows "Updated 12 days
  ago".
- At 7 days without a drain, a content-free push to every admin device; again at 14.
- At `away.close_after_days` (default 21) `.com` refuses new writes (`app-closed`, from the signed `writesOpenUntil`);
  the page says "This app isn't taking new entries right now."
- At retention's end an undrained entry is deleted and its visitor's result becomes `expired` ("Your entry wasn't
  received in time").
- **Test `phone-apps-away`:** gym time travel; no phone for 31 days on Free; pushes at 7 and 14 days, writes refused
  after 21, entries older than 30 days expire with an `expired` result to their visitors, the rest drain when the
  phone returns.

### 8.3 Mailbox full

- New writes are refused (`app-mailbox-full`, no `retryAfterSec`); nothing already queued is dropped. The page says
  the app isn't taking new entries. The owner gets a push at 80 % and at full.
- **Test `phone-apps-mailbox-full`:** fill a Free app to 1,000 entries; the 1,001st is refused with the code; the
  pushes fired once each; a drain frees room and the next write is accepted.

### 8.4 The phone lost (restore)

- The owner recovers the account on a new phone (cloud recovery or another device). The new phone derives the app
  keys, downloads the latest sealed backup, then drains every mailbox entry the backup does not include (entries are
  kept until a stored backup covers them, §3.2), and takes the serving lease.
- Removing the lost phone from Trusted devices ends its lease (grant revoked); if it comes back online it is refused
  and can't publish (its publish key still derives from the UMK, so the binding check alone isn't enough: AppRoom
  also checks the device grant on every lease and publish).
- **Test `phone-apps-restore`:** phone A drains and backs up; ten more writes arrive; A is destroyed; B recovers; all
  rows are present exactly once, the ten are applied in order, A's reconnect is refused, snapshot `seq` continues.

### 8.5 Other failure modes, each with its test

| Failure | Behaviour | Test |
|---|---|---|
| Two owner devices try to serve | the lease's compare-and-set lets one hold; the other is a standby | `phone-apps-two-servers` |
| `.com` serves an old snapshot | the browser refuses `seq` below its high-water mark | `phone-apps-rollback` (engine + library unit) |
| A hostile write (oversize, wrong types, forged rowId, another visitor's row) | refused by `.com`'s shape checks or the engine; the result names the rule | `phone-apps-hostile-writes` (fuzzed against the engine) |
| A bundle tries a third-party host | the validator refuses it at build; the CSP blocks it at run time | `phone-apps-csp` |
| Engine version skew (bundle built for engine 2, phone on 1) | the phone refuses to publish it and asks to update the app; the old version keeps serving | `phone-apps-engine-skew` |
| The backup write fails | entries stay in the mailbox (no ack); retry; a push after 24 h | `phone-apps-backup-fail` |
| Our OHTTP relay fails during a build | falls back to the relay path; never a direct call | `phone-apps-build-ohttp-down` |

## 9. Effort and release

Estimates in engineer-days at this project's pace, in the style of `voici-and-messages.md` §14 (which came to about
45 days). This is larger: it is the Messages mailbox, plus a hosting platform, plus a build loop off the box.

| Chunk | Days |
|---|---|
| A. Protocol: manifest schema 2 `phone-static`, the definition language spec, write / result / snapshot envelopes, vectors (TS, Rust, Swift, Kotlin) | 7 |
| B. Rust engine: validator, SQLite schema and migrations, rules, computed fields, views, snapshot builder, fuzzing | 15 |
| C. `.com`: app origins and the new zone, bundle publish and scan, AppRoom (mailbox, lease, live forwarding), limits, retention, `away`, backups, abuse and takedown | 15 |
| D. `flagship-app.js`: sealing, identity (anonymous and signed-in), snapshot verify, outbox, service worker, queries | 7 |
| E. Build on the phone: agent loop, tools, preview apps, redactor port, Flagship Inference eligibility for phone-only accounts | 12 |
| F. iOS: engine host, serving lease, drain in foreground and background, inbox screens, backup and restore, settings | 15 |
| G. Android: the same | 15 |
| H. Webapp: inbox and management (view, statuses, export); serving from a browser tab is not in v1 | 6 |
| I. Upgrade path: box daemon hosts the engine, Move to a server, voi.ci retarget | 8 |
| J. Gym and conformance (§8 tests, two devices) | 8 |
| K. Copy, i18n (six languages), privacy policy and terms, store listings | 4 |
| L. Security review and its fixes | 6 |
| **Total** | **≈ 118 days** (about 24 engineer-weeks; parallel agents shorten the calendar, not the device runs) |

**Proposed release: 0.6, with risk retired in 0.5.** 0.5 already holds the overlay network, cluster backup, Vault and
community OHTTP relays (`release-0.5-list.md`); adding 24 weeks of new surface to it would delay all of them.

- **In 0.5 (about 3 weeks):** the App Review question to Apple (§5.3 point 6); the definition language spec and the
  engine's validator with vectors; a spike measuring `.com` cost per app and the iOS background drain rate on a real
  phone; the apps domain bought and submitted to the PSL (the list takes weeks to months).
- **0.6:** forms, polls and sign-up sheets (dormant, mailbox, live through the room), iOS and Android, backups,
  restore, the gym groups.
- **0.7:** shops and booking (order lines, computed totals, holds), members-only boards, Business multi-seat serving,
  Move to a server.

Per the branching rule, all of it lives on `feat/phone-apps` until it launches; only D1 migrations and this doc sit
on `main`.

## 10. Decisions for the owner

1. **No phone-side code** (declarative definitions only), as the answer to guideline 2.5.2. Accept that some app ideas
   need a box?
2. **The apps domain**: buy a new registrable domain for app origins and submit it to the PSL (recommended), or reuse
   one you have.
3. **Anonymous writers**: proof of work (recommended) or Cloudflare Turnstile.
4. **Flagship Inference for phone-only accounts**: allowed with an attested device and a smaller allowance? (Today it
   needs a running server.)
5. **Limits and prices** in §3.4 and §7, including whether paid plans drop the "Made with Flagship" mark.
6. **The weaker trust model** (§4.4: `.com` serves the code) is acceptable for phone apps, stated plainly, with Move
   to a server as the fix?
7. **Release:** spike and App Review question in 0.5, the feature in 0.6/0.7, or something else.
8. **Payments in shops**: none in v1 (pay in person or by the shop's own link), or plan for it with the payments rail.
