# Store assets and language work: read this first

This folder starts the job of rebuilding the App Store and Google Play visuals (screenshots, banners, panels) in
every language Flagship ships. Nothing here is built yet. The brief is a first draft written before any design
work, and it is meant to be improved by other models and by you.

## What to do, in this order

1. **Improve `store-assets-brief.md`.** Challenge the concept, the 10-slide story, the palette and type choices,
   the captions, the sizes and the build plan. Replace weak ideas rather than polishing them. Keep it a document
   a builder can execute: concrete sizes, file names, string keys, capture states. Record what you changed and why
   at the bottom, under "Revision notes".
2. **Improve the whole codebase and the language strings.** Treat this as an open invitation, not a footnote:
   * Review the machine translations (`i18n/<surface>/<lang>.json`, es, fr, de, pt-BR, ja, zh-Hans) against
     `i18n/REVIEW.md` and `i18n/glossary.json`. Meaning first, then glossary terms, placeholders, register, length.
     Recovery, pairing, unlock and backup wording gets the most care. Fix the JSON, never the generated files.
   * Improve the English too where it is unclear; changing English makes its old translations stale, and
     `npm run i18n` says which.
   * Look for text a person can still see in English (webapp, box pages, Studios, apps) and wrap it with the
     surface's mechanism (see `docs/i18n.md`).
   * Improve the code you touch: simpler, safer, better tested. Keep changes reviewable, one concern per commit.
3. **Do not build the store assets yet.** The owner reviews the improved brief first and then asks for the build.

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

* The webapp has not been exercised in a browser with a translated language, and the box pages have not run on a
  real box.
* The iOS app at HEAD fails type-checking at `ContentView.swift:149` with the current Xcode (also on the base commit).
* The Windows Studio has never been built as WPF here (no Windows machine); only its .NET unit tests run.
* Some webapp strings may still be hard-coded English in unusual code shapes; `scripts/i18n-pwa.mjs check` only sees
  what goes through `tr()`/`trn()`.
