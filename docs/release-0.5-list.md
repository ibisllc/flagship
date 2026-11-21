# Release 0.5: the work list

Started 2026-11-17 from owner decisions taken during 0.4. Add each item as the owner decides it; the 0.5 journal takes
over once "let's start 0.5" is said.

## Decided for 0.5

1. **The overlay network** (owner, 2026-11-16): key-derived ULA addresses, trusted peers direct and strangers through
   relays, a PQ transport, and one relay mesh. Design: `docs/networking-vision.md`, overlay section.
2. ~~Business / Enterprise plan~~: moved into 0.4 (owner, 2026-11-17: "I meant putting the enterprise features in 0.4").
3. **Cluster backup** (the owner's own servers back each other up, orchestrated by Flagship; a paid feature) and
   **Flagship Vault** (end-to-end encrypted off-site backup space, included in plans plus prepaid blocks). Both are in
   `docs/plans-and-backup-offer.md`.
4. **Community OHTTP relays** (owner, 2026-11-17): volunteers run relays, and a request picks one at random. Registered
   and health-checked, with Sybil limits. The rule from `docs/outbound-proxy.md` "Failure handling" still applies: if
   our infrastructure fails, the system keeps working.
5. **Turn the marketplace on** (owner, 2026-11-19: hidden in 0.4). It is in the code but switched off
   (`docs/runbooks/results/marketplace-findings-2026-11-19.md`). Before the switch: the listing security scanner
   (`scan_grade` ships NULL today; `MARKETPLACE_SCANNER_PUBKEY_HEX`), moderation and reporting (a report/flag on a
   listing, a takedown path, App Review guideline 1.2 for user-generated content), and paid apps (in-app purchase on
   iOS, guideline 3.1.1; Payments step 7 below). Then flip `"marketplace": true` in `release/version.json`, run
   `node scripts/check-versions.mjs --write`, set `MARKETPLACE = "on"` in both wrangler files, bring back the website's
   `/marketplace/` page and links from git history (removed in the `0.4/marketplace-off` website commit), flip the
   tests that expect its absence (they read the switch or say "0.4"), and ship new store builds.

6. **voi.ci posts: a capped server copy, older posts from the phone** (owner, 2026-11-20). `.com` keeps only the
   newest chunks of a page (a cap to choose, e.g. the newest 10 chunks = 200 posts). Chunks stay numbered 0..N, so a
   visitor's browser sees which ones `.com` doesn't hold and asks the owner's phone for them: a signed request over the
   same phone route calls use (`voi.ci/<user>` → the phone's bare name), answered with the chunk exactly as signed in
   the index, so the browser checks it against the index as today. `.com` caches a fetched chunk by its SHA-256 (the
   index pins it, so the cache can never serve a wrong one). Offline phone: "Older posts are on <name>'s phone, which
   is offline right now." Needs a new index version (`chunk-<n>` stops being contiguous on `.com`, or the index lists
   which chunks `.com` holds), phone code on all three apps, and the cap enforced by `.com` at publish with a
   localized refusal. Not in 0.4: it needs a phone update, and 0.4's store builds are being made.
7. **voi.ci comments and reposts** (owner, 2026-11-20). Roots already in 0.4: every post has a stable 32-hex id and a
   permalink (`voi.ci/<user>#p-<id>`). 0.5 design to write:
   - **Comments**: a post's comment stream is keyed by (owner, post id). Followers of a post subscribe to it (a
     subscription is held per visitor key, like Messages' threads, never by account name); a new comment is
     signed by its author, sent to the post owner's phone, which accepts or holds it under the page's message rules
     and fans it out to subscribers (push or the next visit). Best effort: a subscriber who isn't online in time
     misses an update and catches up from the stream on the next visit. Comments show oldest first.
   - **Reposts**: a plain repost puts the original (owner, post id, its chunk hash) on the reposter's page and points
     to the original's comments: one shared stream. A **quote post** is a new post with its own text, so it gets its
     own comment stream; it embeds the original as a card (signed reference, rendered from the original's page) and
     the original can show "quoted by" as a count, not a merged thread. Deleting the original turns the card into
     "This post was removed".
   - Moderation: reports and blocks from Messages apply; App Review 1.2 (user-generated content) needs report, block
     and a takedown path before comments ship.
   - **Owner decision (2026-11-20): who may comment = whoever the owner lets see the page** (public page: anyone the
     page lets in; a limited page: the people it is limited to). One toggle on post creation, "Allow comments", per
     post and sticky from the last choice. No case-by-case moderation (no approval queue). Still needed for the
     stores and the law: the owner can delete a comment on their own post and block its author (Messages' block),
     visitors can report a comment, and `.com` honours takedowns (DMCA, abuse).

## Carried over from 0.4

- F14, the parked after-launch work: a second relay by DNS round-robin, Rust production qualification (G10), removing
  old implementations once proven (G8), the gym on IPv6 only, `VOICI_CANONICAL`.
- Payments step 6 (the Monero view wallet, after the accountant's advice) and step 7 (paid marketplace apps, 10% cut).
- WireGuard full tunnel for the outbound proxy.
- OHTTP for every box's setup, and the OHTTP client in the initramfs.

## Reassess at the start of 0.5

- **Voucher-file import on iPhone** (owner, 2026-11-18). 0.4 ships it on Android only. iOS 1.3 takes only the "Load
  into Flagship" link, because a visible file import risks App Review guideline 3.1.1 ("license keys") on the first
  in-app purchase review. Once Apple has approved the in-app purchases, decide whether to add the file import to iOS,
  citing 3.1.3(b) in the review notes. If Apple ever objects to the link, check whether it can be switched off
  without a new build (not verified).
- **Bank transfer for Business batches:** a paid `send_invoice` invoice doesn't produce vouchers yet
  (`docs/runbooks/payments-setup.md`).
- **Adapter review through Flagship Inference, any vendor** (owner, 2026-11-19). `apps/com/src/adapterReview.ts`
  calls only Anthropic's API (`ADAPTER_REVIEW_ANTHROPIC_KEY`). Route it through Flagship Inference (the shim and its
  OpenAI-compatible upstreams: DeepInfra, OpenRouter fallback, any vendor later) to save cost, with no
  provider-specific secret. The same goes for any other server-side AI review. Update release.sh's secret list.
- **Community adapters, turned on together** (2026-11-19). Three pieces must arrive together, or none does anything:
  - the review model, through Flagship Inference as above;
  - `ADAPTER_ATTESTATION_SIGNING_KEY` (`openssl rand -hex 32`, offline copy on the FlagshipKeys volume), with its
    public half added to `release/adapter-vetting-keys.json` in an endorsed box release;
  - `ADAPTER_COMPLAINT_SALT` (`openssl rand -hex 32`).
  Until then `release/adapter-vetting-keys.json` is empty, so boxes keep community adapter lookup off. 0.4 shipped
  them unset on purpose.
- **Fit release.sh to the project as it is now** (owner, 2026-11-20: "no more skipping outdated steps"). The 0.4 run
  had to skip or wave through steps written for 0.3. Before the 0.5 run, rewrite `scripts/release.sh` (and
  `release.test.ts`, `docs/runbooks/0.4-deploy-sheet.md`, the browser-tasks list) so every step in `--list` is one the
  release really needs, and one-time steps that already happened are gone, not just guarded:
  - step 20 (deploy the 0.3 TS hub, mesh off): remove; keep the mesh-off rollback as a documented rollback, not a step.
    Drop step 22's `require_done services` with it.
  - steps 24-27 (relay key, admit iad1, tunnel certs and DNS, switch the feed on): one-time 0.3 mesh setup, already
    live. Fold into one "relay mesh: check" (directory lists iad1, secrets present, both tunnel names on valid TLS);
    keep step 28 (deploy the Rust relay) as the relay update.
  - one-time setup that is done: 5 (catalog keys), 6 (PQ release key ceremony), 15-18 (D1 backup set-up, R2 buckets,
    feed domain and cache rule, mesh key seed), 22 (root wildcard + CAA). Turn into read-only checks that pass
    silently.
  - 0.3-only steps: 36 (pre-GA scrub; the wipe tool is gone), 38 (retire the wipe tool; done), 46 (tell the 0.2
    apps to update; make it a generic "tell older apps to update" naming the versions), 47 (hall of fame for 0.3),
    43's feat/UX wording.
  - re-pin after cosmetic merges (only warns since 2026-11-20): keep, and say in `--list` which steps a re-pin
    re-opens (11 when the webapp shell moves).
  - steps that merely wait (12 appliance builds, 31/41 publish) could merge.
  - step 23 refuses when the caller exported GYM_SECRETS_FILE (the webapp deploy guard): unset it inside release.sh
    for the .com deploy, and stop documenting the prefix (release.sh finds ~/flagship/.gym-secrets.env itself).
  - step 29 (30-minute relay watch): run it right after step 28 or check it later by hand; make check-versions.mjs
    carry the product version into rust/Cargo.toml (the 0.4 relay still reports "0.3.0").
  - step 33 (DEPLOYED-FINAL for the Windows agent) pushes to a hard-coded device-results/windows-2026-10-17 branch
    that is gone: make it optional and create its own branch only when a device test is planned.
  - need_gym_secret reads GYM_ADMIN_SECRET with grep|cut and keeps the quotes of a quoted value in .gym-secrets.env
    (step 37's gym sweep got 403): strip quotes or source the file.
  - no Experimental label on anything (owner, 2026-11-20, regardless of testing): remove step 39's Windows-acceptance
    gate for the tag and consider deleting the STUDIO_EXPERIMENTAL switch and its tag markup entirely.
  - step 43 (feat/UX translations, store art, VOICI_CANONICAL): split into the i18n gate (already per merge), a
    native-review status that does not force a yes/stop, and the store-art check next to the store builds.
  Goal: a fresh run's `--list` reads as this release's plan, start to finish, with no step a person must know to skip.
- **Remove the VOICI_CALLS switch** (owner, 2026-11-20: "this entire switch idea is crazy"). A feature ships with the
  store build that carries it; calls were held off on production while the builds that answer them were already in
  review. Remove `VOICI_CALLS` (and the deploy sheet's "Calls on" step, release.sh's notes) so calls are simply part
  of the release; keep a server-side brake only if it is repurposed, e.g. to limit calls for accounts past their
  data quota. Same review for the other launch switches (`VOICI_ENABLED`, `MARKETPLACE`): a switch is for an outage
  or abuse brake, not for sequencing a launch.
- **Make the Google-free push choice visible on Android** (owner, 2026-11-20). FCM is the default where Google Play
  services exist (0.4 sets up Firebase); a phone with a UnifiedPush distributor (ntfy, NextPush, Sunup) already uses
  it instead, even with Play services. Add a Settings line under notifications that says which service delivers
  pushes and, while it is Google, offers "Keep Google out of your notifications: install a UnifiedPush app such as
  ntfy" with a link and a short why (Google sees that a push arrived and when, never what it says or which account).
  Every string through i18n; same idea on the webapp's notification settings if it applies.
- **Service worker: a non-JSON shell manifest is "missing", not "broken"** (CI agent, 2026-11-20). An HTML answer
  for `/shell-manifest.json` (wrangler dev's SPA fallback, the gym Worker) leaves a service worker that never
  installs. Fix `checkAgainstManifest` in apps/web/public/webapp/service-worker.js; needs a shell bump and re-sign.
- **Marketplace scan secrets before turning the marketplace on:** `SERVICES_CONTROL_SECRET`,
  `FLAGSHIP_SCANNER_PRIV_HEX` and the R2 secrets in the repo (the nightly scan skips while `marketplace` is false).
