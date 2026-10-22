# DELETE THIS FILE once the multilingual release has shipped

Handoff from the 2026-10-22 review of `feat/multilingual` to whoever packages and releases it. It is not documentation:
the lasting rules are in `docs/i18n.md`, `i18n/REVIEW.md` and `AGENTS.md`. Delete it in the commit that ships the release
(or when every box below is ticked).

## What has to happen for this branch to reach people

- [ ] **Webapp shell v158** (`apps/web/public/webapp/service-worker.js`, `lib/buildInfo.js`). Deploy through
  `apps/com` `npm run deploy` as usual (it deploys `flagship-webapp` first). Two changes users will notice:
  the service worker registers again (it silently never did on this branch, see "Fixed" below) and catalogs are
  fetched as `i18n/<lang>.json?v=<hash>`. If the branch is merged after `main` moved its shell past v157, take the next
  unused number and move the eight test pins (`grep -rn 'SHELL_VERSION = "v' apps/web/tests`) and `WEB_BUILD`.
- [ ] **Endorsed box release.** Box pages now stop at English when the browser prefers it
  (`packages/server-daemon/src/i18n/index.ts`), and their catalog ships with the box. Nothing else box-side changed here.
- [ ] **Android store build.** Compile first: `ShareServerScreens.kt` changed (start-up card now picks between two
  sentences; share-sheet fallback is `R.string.share_person_fallback`) and was **not compiled here** (no Android SDK).
  Wear OS now has `values-<lang>/` folders for the first time; check the watch app in Japanese.
- [ ] **iOS store build.** Eight `Failure(message:)` sentences are `String(localized:)` now (App*ViewModel files); three
  new catalog keys ("Couldn't sign the change/key/copy: %@") were added to `i18n/ios/en.json` by hand. The next
  `i18n-ios.mjs harvest` will find them in the code and keep them. iOS still fails to build, see below.
- [ ] **Windows Studio.** `VMInventoryStore.cs` uses a new `Strings.F("notAValidServerName", …)` key. `dotnet test
  apps/builder-windows/tests` passes 278/278 on Linux with the .NET 8 SDK (`apt-get install dotnet-sdk-8.0` works in
  this container); the WPF app itself has still never been built off a Windows runner.
- [ ] **Native review** of at least recovery, pairing, unlock and backup wording per language (`i18n/REVIEW.md`) before
  store screenshots are made in that language. The machine drafts were read line by line in this review for those
  areas, but by a model, not a native speaker.

## iOS: `ContentView.swift:149` (not fixed, proposed)

Not changed because nothing here can compile Swift. Line 148-149 is the `.task {` at the end of a single `body`
expression of a `ZStack` plus `.sheet`, `.fullScreenCover`, eleven `.onChange` and `.task`; newer Swift type-checkers
give up on chains like this ("unable to type-check this expression in reasonable time"), reported near the end of the
chain. The usual fix, behaviour-preserving:

```swift
var body: some View { observingLifecycle(presentations) }

/// The shell and its sheets (the first half of the old chain, unchanged).
private var presentations: some View {
    ZStack { /* unchanged */ }
        .sheet(isPresented: accessAlertBinding) { /* unchanged */ }
        .fullScreenCover(isPresented: onboardingBinding) { /* unchanged */ }
}

/// Every .onChange and the .task (the second half, unchanged), applied to the shell.
private func observingLifecycle<V: View>(_ content: V) -> some View {
    content
        .onChange(of: app.isPaired) { _, paired in /* unchanged */ }
        // … the other ten .onChange blocks …
        .task { /* unchanged */ }
}
```

Moving the two `Binding(get:set:)` literals into `private var accessAlertBinding: Binding<Bool>` and
`onboardingBinding` helps the checker further. If the real error message is different, start from it; the README said
only "fails type-checking at 149".

## Fixed in this review that a release note might mention

- The service worker never registered on this branch (`lib/swRegister.js` gained an `import` but was loaded as a
  classic script). A test now fails any such `<script>`.
- "Restore by {date} ({n} days left)" and "Started {date} · {n} steps" had the two values swapped in all six languages
  (cause: `scripts/i18n-reuse.mjs` numbered placeholders by position; fixed and tested; the gate now catches the
  pattern).
- The docs page said single-device recovery waits 7 days and other devices can cancel it; it is 3 days, and only the
  recovering device can cancel (`RE_PAIR_SINGLE_GRACE_MS`, `/re-pair/object`).
- Android said "Flagship never proxies LLM traffic"; AI calls go through the relay by default
  (`docs/ai-privacy-and-staging.md` §4). The sentence now says so.
- Wear OS translations were never generated; Android `check` only compared the English file.

## English worth an owner decision (not changed: each one makes six translations stale)

- **"restore" means two things.** Un-revoking a server ("can't connect until you un-revoke it", button "Restoring…",
  activity "Restored server") and restoring a backup use the same English word, and es/pt-BR/de/ja/zh therefore use the
  same word for both. French already separates them (rétablir / restaurer). Suggest "Un-revoke" → "Allow again" /
  "Reinstate" in English.
- **"box" and "server"** are both used for the user's machine in about 60 webapp/iOS strings; the glossary says
  "server". Translations now use a distinct word for box (zh 主机, no longer 设备 "device"), but one English word would be
  simpler.
- **Errors stay English by design** (README/`docs/i18n.md`), but several thrown messages reach the screen through
  `toast(e.message)` (likely e.g. "this server isn't registered yet — wait for it to come online" via `serverOrderFailureText` → `humanError` in the webapp; check). Worth listing
  which thrown messages are user-facing and translating those.
- "Recovery merge-back", "Pair with the builder" (the Studio used to be called builder), "pod" in the webapp: old terms
  that read oddly in every language.

## New tooling in short

- `node scripts/i18n-<android|windows|ios> accept <key>|--all [--module wear|--surface ios-infoplist]` after retranslating
  a name-keyed string whose English changed.
- `test-vectors/language-negotiation.json` is the one language-choice rule (webapp, box, website).
- Store captions should go in a new name-keyed surface `i18n/store/` (brief §6); copy `i18n/wear` as the smallest
  example and add a `scripts/i18n-store.mjs` with `build`/`check` like `i18n-windows.mjs`.
