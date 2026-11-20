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
