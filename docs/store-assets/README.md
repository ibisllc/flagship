# Store assets and language work: read this first

The App Store and Google Play visuals (screenshots, the Play feature graphic, the hi-res icon) for every shipped
language are built from one template set and one string table. The design is `store-assets-brief.md`; what the
native capture tests must produce is `capture-plan.md`.

## Regenerate the store art

```sh
npm run store-assets            # webapp captures + render + check: everything below in one go (about 70 s)
open store/out/review/index.html
```

That is two steps you can also run alone:

```sh
npm run store-assets:capture    # the real webapp on the made-up world (store/demo-world.json), every language, light/dark per slide
npm run store-assets:render     # store/captures + store/templates + i18n/store -> store/out, then the check
npm run store-assets:release-check   # also fails on any missing native capture or webapp stand-in: run before uploading
```

* **Inputs.** Screens: `store/captures/<ios|android>/<lang>/<device>/<id>.png` from the native tests
  (`capture-plan.md`; none exist yet), else a webapp stand-in from `store/captures/webapp/<lang>/<phone|tablet>/`,
  else a red "CAPTURE MISSING" frame naming the file and the gym state that should produce it. Captions:
  `i18n/store/<lang>.json`. Sizes, slides and which template draws what: `store/store.json`. Templates:
  `store/templates/*.html` (phone, tablet, watch, closing, feature, icon) with `store.css` and `slide.js`. Fonts are
  vendored in `store/fonts` with their OFL licences; never fetched.
* **Outputs** (ignored by git, rebuilt from the inputs): `store/out/<appstore|playstore>/<lang>/<class>/<id>-<theme>.png`
  at each store's exact pixel size, `store/out/playstore/icon.png`, `store/out/manifest.json` (size, SHA-256, caption,
  which capture each image used and whether it was native, a stand-in or missing), and a contact sheet per language,
  `store/out/review/<lang>.html` (search-size thumbnails, full size on click, the captions beside the English).
* **Stand-ins are never uploaded.** Each one carries "stand-in: webapp capture, not for upload" under the shelf
  line and in the manifest; `release-check` refuses them.
* **Checks.** `render.mjs check`: every ga language × size class × slide exists at its exact size, matches its manifest
  hash and current caption, no caption overflowed. `npm run i18n` (via `scripts/i18n-store.mjs check`) lints the
  captions like any surface (placeholders, keep-terms, stale English, no 。 or "!"), checks the cut CJK fonts hold every
  caption character, and lays every caption out at every store size in headless Chromium: a caption that needs more
  than two lines at the smallest allowed size (three on the closing card) fails with the language and the text.

### Changing a caption

Edit `i18n/store/en.json` (then translate the key in every language and `node scripts/i18n-store.mjs accept <key>`),
or a translation directly. Japanese and Chinese may carry `\n` where the line should break. If a Japanese or Chinese
caption gains a character the vendored font cut does not have, `npm run i18n` says so: run
`python3 scripts/store-assets/subset-cjk.py` (needs `pip install fonttools brotli`; it downloads the pinned Noto
sources once to `~/.cache/flagship-store-fonts`). Then `npm run store-assets:render`.

## Language work

1. **Improve the whole codebase and the language strings.** Treat this as an open invitation, not a footnote:
   * Review the machine translations (`i18n/<surface>/<lang>.json`, es, fr, de, pt-BR, ja, zh-Hans) against
     `i18n/REVIEW.md` and `i18n/glossary.json`. Meaning first, then glossary terms, placeholders, register, length.
     Recovery, pairing, unlock and backup wording gets the most care. Fix the JSON, never the generated files.
   * Improve the English too where it is unclear; changing English makes its old translations stale, and
     `npm run i18n` says which.
   * Look for text a person can still see in English (webapp, box pages, Studios, apps) and wrap it with the
     surface's mechanism (see `docs/i18n.md`). The store contact sheets are a quick way to spot some: they show the
     webapp in every language.
   * Improve the code you touch: simpler, safer, better tested. Keep changes reviewable, one concern per commit.

## How to work in this repo

* Orientation and status: `AGENTS.md`. Language system: `docs/i18n.md`. Reviewer's brief: `i18n/REVIEW.md`.
* After editing strings, rebuild that surface and run the gate:
  `node scripts/i18n-<web|android|ios|windows|linux|pwa|box>.mjs build`, then `npm run i18n` (`npm run i18n:status`
  for coverage). Generated native files are committed; do not hand-edit them.
* Tests: `npx vitest run` (whole repo), `npx tsc -b`. Windows Studio unit tests: `dotnet test apps/builder-windows/tests`
  (three `QemuCommandLineTests` failures exist and are unrelated to language work).
* All six languages are `ga` in `i18n/locales.json`. Do not flip a language back to `draft` or add one without the
  owner asking; adding one means a row in `locales.json` plus a translations file per surface.
* Thrown error messages, the box's JSON API errors, signed security notices, the legal pages and emails to Flagship
  staff stay English by design.

## Do not touch or commit

* `apps/mobile/android/keystore/upload_certificate.pem`, `dns-ent-experiment.jsonl`, `TODO-VOICI-SERVICE-SLUGS.md`
  (they stay untracked).
* Do not use `git add -A` on `apps/`; add paths explicitly.
* Do not push to `main`, and do not deploy. Box-side changes reach boxes only with an endorsed release.
* Commit messages end with the `Co-Authored-By` and `Claude-Session` lines used elsewhere in the log.

## Known gaps worth attacking

* The webapp now runs in every language for the store captures (`npm run store-assets:capture`), which showed one
  untranslated word: "Scheduled" in a backup row (`apps/web/public/webapp/lib/savedBackups.js:162`, not wrapped in
  `tr()`). The box pages have not run on a real box.
* The iOS app at HEAD fails type-checking at `ContentView.swift:149` with the current Xcode (also on the base commit).
* The Windows Studio has never been built as WPF here (no Windows machine); only its .NET unit tests run.
* Some webapp strings may still be hard-coded English in unusual code shapes; `scripts/i18n-pwa.mjs check` only sees
  what goes through `tr()`/`trn()`.
