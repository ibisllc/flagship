# Services marketplace + sample services

> **Branch discipline.** This is a *workspace artifact* — a design/planning doc
> that is never served to the website or the app, so it lives on `main` (like
> the D1 migration files). The marketplace *feature code itself* must NOT land
> on `main`: it lives entirely on the `feat/marketplace` branch until the
> feature launches. `feat/marketplace` = `main` + exactly the marketplace
> feature, kept additive and independent. When you pick this up, check out that
> branch; do not reintroduce marketplace code onto `main`.

Status: **planned (v1.x).** The marketplace *plumbing* already exists —
`marketplace_listings` (D1), `/api/screens/marketplace-browse` (P1.4),
`/api/marketplace/search`, and the install flow (`installFromMarketplace`,
`apps/web/public/webapp/views/marketplace.js`). What's missing is a real
catalog (authored, containerised services with manifests) and the security
scanner that grades them. See `app-developer-guide.md` + `manifest.md` for
the per-app contract and `monetization-free-tier-first.md` for pricing.

## Goal

Ship a small, curated catalog of self-contained services a user can install
onto **their own** server in one tap, plus at least one "social" service so
the personal-cloud value prop is tangible ("host the things you'd otherwise
hand to a Big Tech tenant — on hardware you own").

## Current state (surveyed 2026-06-05) — most of this is ALREADY built

The marketplace is far more complete than "greenfield". Inventory:

- **Marketplace language exists on every surface:** website landing §3
  ("Things people actually built last week"), a full `/marketplace/` page,
  FAQ ("How does the marketplace work?"), privacy §2.5, terms §5; iOS
  `ServicesTab` ("Services your neighbours built. One tap to install.");
  Android `MarketplaceScreens.kt`; webapp `views/marketplace.js` (+ scan-grade
  tooltips). The only placeholders are graceful "marketplace is coming soon"
  fallbacks shown when **no server is paired yet**.
- **Delivery pipe is ~95% wired:** `marketplace_listings` (D1, migration
  0005) + full `MarketplaceStorage` CRUD; control-plane endpoints
  list/get/search/install/scan (`packages/control-plane/src/marketplace.ts`);
  the daemon installer `POST /api/services`
  (`packages/server-daemon/src/servicePlatform.ts`) verifies the IRK-signed
  request, parses the manifest, provisions data stores, deploys the
  container, and registers the `<label>.<user>` route — already covered by
  the per-user **wildcard** cert (no per-service ACME). Cross-creator git
  clone from the canonical pod (`cloneService.ts`) + the screens-BFF browse
  proxy are wired too.

### The one real broken link: manifest delivery
The listing stores only a manifest **hash** (`manifest_hash_hex`; the schema
comment says "Phone re-checks before install"), and `serializeListing`
returns `manifest_hash`, not the manifest. But the webapp install path
(`installFromMarketplace`, `lib/installService.js:64`) requires
`listing.manifestJson` and throws "marketplace listing missing manifestJson"
without it. So **tap-install fails at the manifest step today.**

This is a genuine fork in the marketplace's trust model — the schema leans
one way, the client code leans the other:

- **(A) Manifest lives in the listing.** Add `manifest_json` to the listing
  (storage + serialize + publish flow); `.com` returns it; the daemon runs
  it. Simplest, matches the current webapp code. But `.com` now holds the run
  spec (mild tension with "we host listings, not code").
- **(B) Manifest pulled from the canonical pod + hash-verified.** Keep the
  listing to a hash; the installer fetches the manifest from the creator's
  pod and checks it against `manifest_hash_hex` before running. Matches the
  committed schema ("re-checks before install") and the "directory, not an
  app store" philosophy. More work; updates the webapp/daemon install flow.

**Decision owner-gated** — it shapes whether flagshipserver.com ever holds a
service's run spec. Once chosen, the pipe is a small, well-scoped change
(the rest of the delivery chain already exists), after which the remaining
work is just **seeding real listings** (the sample catalog below).

## Implementation plan — option A chosen (manifest in the listing)

Surveying deeper revealed the delivery backend has **several** unbuilt
segments (not just the manifest gap). Sequenced commits on `feat/marketplace`:

1. **Manifest contract (storage + control-plane).** Add a `manifest_json`
   column (migration **0047**) + `MarketplaceListingRecord.manifestJson`; wire
   the D1 + in-memory adapters; `handleMarketplaceList` accepts `manifestJson`
   and verifies `sha256hex(manifestJson) === manifestHashHex` (define this as
   THE commitment — nothing pins it today); `handleMarketplaceGet` returns it,
   search omits it (bloat). Vitest. ⚠ **introduces a new prod D1 migration** —
   needs `wrangler d1 execute … 0047 --remote` to deploy.
2. **Daemon publish handler.** `/api/screens/marketplace/publish` is *called*
   by the webapp (`vibe-code.js`) but **not implemented** on the daemon. Build
   it: resolve the service manifest, compute `manifestHashHex`, build + IRK-sign
   `MarketplaceListRequest`, POST to `.com /api/marketplace/list` **with**
   `manifestJson`. Tests.
3. **Webapp install alignment.** Confirm the GET HTTP shape (`{listing:{…}}`
   vs flat) and that `installFromMarketplace` reads `manifestJson` + verifies
   it against `manifest_hash` before signing. Fix any wrapper/field mismatch.
4. **Seed the sample catalog.** Author manifests for Site/Drop/Notes/Link +
   Hearth and a seed path (admin endpoint or script) to populate
   `marketplace_listings`; the scanner (open task #9) then grades them.
5. **Build Hearth** (the social service) as a provision-only container per the
   Apple-review decision below.

Segments 1–3 are the "pipe"; 4–5 are the catalog. 1 is the foundation and the
only one touching prod schema.

## Starter catalog (sample services)

Each is a single OCI image + a `manifest` (ports, env, health, resource
hints), accessed at `<label>.<user>.flagship.services` once installed. Keep
the launch set free (no IAP — see Apple notes below).

- **Site** — a personal blog / static-ish CMS.
- **Drop** — file share + photo gallery (personal Dropbox/Immich-lite).
- **Notes** — markdown notes / docs.
- **Link** — URL shortener (ties into the existing voi.ci appId work).
- **Hearth** *(working name)* — the **social** service: chat, stories,
  posts, timelines. Single-tenant: your server, your circle. Federation is
  out of scope for v1 (you invite people to *your* instance; cross-instance
  follow is a later question).

`Hearth` is the headline sample but also the one with App Store implications
— see below. Names are placeholders (alts: Commons, Circle, Porch, Roost).

## The "Hearth" social service — shape

- Self-hosted, single-instance, invite-based (no public sign-up firehose).
- Surfaces: a timeline of posts, ephemeral stories, 1:1 + group chat.
- Content + media live on the **user's box**; TLS terminates there, so
  `.services` (and Flagship the company) can't read any of it — same content-
  blind property as everything else. This is a privacy *win* to lean on.
- Moderation is the instance owner's: they admit members and can remove
  content/members on their own server. (This matters for Apple — below.)

## Apple App Store review — does the social service hurt us?

Short answer: **it adds risk, but the magnitude hinges on one architectural
question** — does the *native iOS app* render the user-generated content, or
does it only *provision* the service (consumed in the browser/PWA at the
user's own domain)?

### Case A — app only provisions (recommended)
The social service runs on the user's box; people read/post via the PWA at
`hearth.<user>.flagship.services`. The native app **never displays a feed or
chat**. Then Guideline **1.2 (UGC)** largely doesn't attach to the app — it's
a server/hosting control panel, a category Apple already allows (cPanel-style
managers, self-hosting dashboards). **Risk: low–moderate**, and what's left
is about the marketplace-installs-software angle, not the social content.

### Case B — app natively renders the feed/chat
Then **Guideline 1.2 applies in full** and Apple will *require*, before
approval: a content filter, a report-objectionable-content mechanism with
timely action, block/mute of abusive users, a published moderation contact,
and an EULA with zero-tolerance terms. Ship without these → rejection. Build
them → approvable (third-party Mastodon/Pixelfed clients pass with exactly
this kit). **Risk: high if unprepared, manageable if we build the safeguards.**

### Guidelines that apply regardless of A/B
- **2.5.2 (no code that changes the app's own functionality):** the
  marketplace installs containers onto the *user's server*, not the iPhone,
  and doesn't alter the iOS app's features. Defensible (it provisions
  external infra), but reviewers may probe — frame the app as a "server
  control panel," not an "app store." Precedent exists; novelty invites
  scrutiny.
- **3.1.1 / IAP:** keep launch services **free / BYOK** to sidestep the
  digital-goods IAP fight. Services running on the user's own hardware may
  qualify as real-world/external, but don't pick that fight at launch.
- **5.1 Privacy:** content is content-blind to us — a *strong* privacy-label
  story, not a liability.
- **Age rating:** unrestricted UGC ⇒ likely 17+. Set it correctly; not a
  blocker.

### Recommendation (and the owner's instinct is right)
**Ship the first App Store submission WITHOUT the marketplace.** Rationale:
1. The first review is the riskiest; get the core app approved with a clean,
   legible purpose ("run your own private cloud server").
2. The marketplace-installs-services concept is itself the more novel,
   scrutiny-prone part; stacking social UGC on top compounds risk in one
   review.
3. It buys time to build the security scanner (task #9) and — only if we ever
   render UGC natively — the 1.2 safeguard kit.
4. Adding the marketplace in a 1.x update is routine and lower-stakes once a
   baseline is approved.

Then, when the marketplace lands: design **Hearth as Case A** (native app
*provisions*; content is consumed in the PWA), which keeps the UGC burden off
the binary. Only add native feed-rendering after the full 1.2 kit exists.

Honest counterpoint: Apple does scrutinise material functionality changes on
update, and there's a mild "no bait-and-switch" expectation. But shipping a
genuine marketplace feature in an update isn't hiding functionality to sneak
past review — it's normal staged delivery.

## Tasks (when picked up)
- Author the manifest + image for each starter service; seed
  `marketplace_listings` (today the table is empty/NULL `scan_grade`).
- Build **Hearth** as a provision-only service (Case A) with owner-side
  admit/remove.
- Wire the security scanner (task #9) so every listing has a grade before the
  catalog goes public (E2 live exercise: ≥10 listings, ≥3 cross-pod installs).
- Keep the iOS app's marketplace surface **provision-only** (no native UGC
  rendering) for the first marketplace release.
