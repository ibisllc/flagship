# Task 5: Compose flake, webapp gym specs, adversarial review (cloud session). PARTIAL: (b) final rerun pending

## URGENT: the webapp does not boot on release/0.4 since calls round 3
`apps/web/public/webapp/lib/voiciOwner.js` imports `checkVoiciPageIndex` **twice** (lines 19 and 35, the second added by
`b34cf9971` "Webapp: reveal pill, Call back, delete forgets, block anonymous callers"). A duplicate import binding is an early
error (`SyntaxError: Identifier 'checkVoiciPageIndex' has already been declared`), so the module never loads, and neither does the shell:
`#view-bootstrap` never appears. Every gym scenario fails at the first step (98/98 in the specs I ran on `4a71f43f3`, including
`gym-smoke`). It is still broken at today's tip `6487ff1c2`. No vitest caught it, because unit tests import only the modules they
exercise. **Do not deploy the webapp from any commit after b34cf9971 without the fix.**

**Fix on `0.4/webapp-boot-cloudfix`** (`d2cb7331e`, off `6487ff1c2`): it drops the duplicate import and adds
`apps/web/tests/webappModulesParse.test.ts`. That test parses all ~325 webapp `.js` files as ES modules in one Node process
(`vm.SourceTextModule`, 0.2 s), so a module that can't load fails CI. It fails without the fix (names the exact error) and passes with it.

## (a) Flaky `ModelMenuComposeTest > stagedAttachmentsWithNotice`: FIXED on `0.4/compose-flake-cloudfix` (`750505b48`)
**Cause.** The exception is not slowness. Robolectric's Compose idling loop gave up after ~2.4 million idle checks in 60 s
("Compose did not get idle … check your measure/layout lambdas"), thrown from `setContent` (`ModelMenuComposeTest.kt:94`, called at 252).
The only time-driven node in this test is `FSCard`, whose content sits in `animateContentSize()` (`ui/components/Components.kt:197`).
Once earlier tests have run in the same JVM, that size animation sometimes never settles under Robolectric's clock. The test author had
already replaced a live text field in this same test for the same reason. The failure needs earlier classes in the JVM: the class alone
passed every time (also 3× under 6 busy-loop CPU hogs), while `ui.*` or `ui.screens.*` reproduced it. It is intermittent even then,
which is why bisecting to a single class was inconclusive.
**Fix (test only).** Draw FSCard's surface (same shape, colours, padding) without `animateContentSize`. The test checks the chips and
the notice, not the card. Production `FSCard` is unchanged.
**Proof.** Before: failed in 5 of the last 6 full-suite runs (reports 01, 03, 04, plus two today). After: **5 of 5 full `:app:testDebugUnitTest`
runs green** (`--rerun-tasks`, 3065 tests, 0 failures each), the last three while a 372-scenario Playwright gym ran on the same 4 vCPUs.

## (b) Webapp Playwright gym specs
Config `apps/web/e2e/gym/playwright.gym.config.ts` (static server, no backend; 1 worker).

**Run 1, at `e46b6eb88`** (before b34cf9971): **355 passed, 17 failed** of 372 (44 min). Each failing test was rerun alone on an
otherwise idle machine, and **all 17 failed again, so none are load flakes.**

Cluster A, 13 tests: Home's "Add / Restore a server" click is dropped. **REAL but stale tests, not a product bug.** The button
deliberately ignores a tap for 450 ms after anything is inserted above it (`lib/settleGuard.js`, added 2026-10-18). Home inserts banners
just after it paints, and these tests click within that window, so the dialog never opens. Evidence: with the guard at 0 ms the tests
pass. With the guard at 450 ms and a 3 s wait before the click, there are 0 mutations and the dialog opens.
- Direct: `gym-servers:185` (demo account), `:200`, `:223` (Add/Restore choices), `:276` (lock closes menus), `gym-gone:36`,
  `gym-notices:69`: "dialog[aria-label="Add or restore a server"] not found".
- Timeouts (90–120 s) behind the same click: `gym-archive:465,:539,:608,:641`, `gym-backups:322`, `gym-misc:870,:919`.
- Plus `gym-servers:200` expected 3 menu buttons: `aff641ecf` added "Set up a box from a store".
These match CI's daily web-gym failures (home-demo-account, add-import-choices, lock-closes-menus).

**Fix on `0.4/gym-cloudfix`** (in progress; rebased onto the boot fix): a `clickAddServer(page)` helper in `gymKit.ts` waits for
500 ms of quiet in `#view-home` (and the paused line) before tapping, the way a person would. It replaces all 18
`page.click("#home-add-server")`, and the menu list now includes the store-box choice. A full rerun is in progress.

Other failures from run 1, being re-checked on the fixed tree:
- `gym-servers:85` drag reorder: the saved order is missing `office.smoketest…` (expected [office, home, …]).
- `gym-messages:617`: "a reply on a voi.ci page this account wrote to shows once". The link is `""`, expected `https://voi.ci/bob`.
- `gym-sweep:359`: "presses every control on an app's pages". `#view-service-detail` is hidden.
- `gym-restoremerge:196`: the admin restore-merge scenario times out (120 s).

New-feature specs: **restore-merge** has 4 scenarios; 3 pass and :196 times out (above). There is **no gym spec for org-join or calls** at
e46b6eb88 or at the tip (`grep` of `apps/web/e2e/gym`: no org-join or voi.ci-call scenarios; calls have their own lane in
`apps/web/e2e/voici-calls`, which Task 6 covers).

## (c) Adversarial review
Published as **`cloud-reports/05c-adversarial-review.md`**, with failing tests on **`0.4/review-cloud`** (4 commits): 5 Medium
(F1 cross-account call-key revocation, F2 SCIM `__proto__` pollution, F3 unverified seat links, F4 keyd CGK adopted under a superseded
record (TS and Rust), F5 audit export doesn't notice dropped box log heads), 4 Low, and 2 Info. No Critical or High findings.
I re-read F1 end to end myself: the revocation is stored and looked up by `callKeyPub` alone (`control-plane/src/voiciCalls.ts:534-546,574`,
`storage/src/voiciCalls.ts:210-219`).
