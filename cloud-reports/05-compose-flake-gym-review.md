# Task 5: Compose flake, webapp gym specs, adversarial review (cloud session). COMPLETE

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

## (b) Webapp Playwright gym specs: **all 375 pass on `0.4/gym-cloudfix`**
Config `apps/web/e2e/gym/playwright.gym.config.ts` (static server, no backend, 1 worker).

**Run 1, at `e46b6eb88`:** 355 passed, 17 failed of 372. Every failure was rerun alone on an idle machine and **all 17 failed
again, so none are load flakes.** At the newer tip (`6487ff1c2`), every scenario fails first on the boot break above.

**Final run:** branch **`0.4/gym-cloudfix`** = `6487ff1c2` + the boot fix (`d2cb7331e`) + 5 commits: **375 passed, 0 failed**
(28 min). The commits, oldest first (each cherry-picks on its own):

| commit | kind | what |
|---|---|---|
| `44cd54cb0` | stale tests (13) | Home's "Add / Restore a server" ignores a tap for 450 ms after anything is inserted above it (`lib/settleGuard.js`). Home adds banners just after it paints, and the tests clicked at once, so the dialog never opened. Proof: with the guard at 0 ms they pass; at 450 ms with a 3 s wait there are 0 mutations and the dialog opens. The new `clickAddServer()` in gymKit waits for 500 ms of quiet, used at all 18 call sites. Also: the menu lists "Set up a box from a store" (`aff641ecf`). `main` and `nav` now sit inside `.app-shell`, which the account-gone screen and the update lock make inert, so those checks use `closest("[inert]")`. **The page behind the lock is still inert; it was not a regression.** The restore-merge refusal uses the custody-round-two sentence. These match CI's daily web-gym failures. |
| `e8d717bd2` | stale tests (3, tip only) | Custody round two refuses to create an account without a PRF passkey (`custody-unsupported`). The onboarding scenarios had no authenticator and ran on `127.0.0.1`, which WebAuthn refuses as a relying party. They now use a CDP virtual authenticator with `hasPrf` (`gymKit.prfAuthenticator`, the setup gym-custody already had) on `localhost`. |
| **`6391e2e45`** | **REAL product bug** | **Restore-merge's Undo and "Delete now" confirmations can't be clicked in the webapp.** `inlineConfirm` (and every inline prompt in `lib/modal.js`) draws a fixed overlay at the end of `body`. The restore-merge window is a `<dialog>` opened with `showModal()`, which is in the top layer and makes the rest of the page inert, so the confirmation opens *behind* it ("dialog … subtree intercepts pointer events" until the 120 s timeout). Fix: `ensureHost()` mounts the host inside the topmost open modal dialog, and stays at the end of `body` otherwise. All 331 webapp vitest files are still green. The same trap applies to any other inline prompt opened from a modal dialog. |
| `ce962ab67` | env-dependent test | The Social tab opens a voi.ci page in a new window that the page-level mock doesn't see, so the test needed the live voi.ci (unreachable here, so the popup URL read `""`). Now the browser context answers voi.ci. |
| `9259c47ac` | stale test | Since the wide list/detail layout (`6ee7706c0`), Home's list starts at y≈595 on the gym's 1280×720 window. The office card's drag handle sat below the viewport, the press hit nothing, and no drag started. It passed at phone width. The drag helper now scrolls both cards into view. |

**New-feature coverage:** restore-merge has 4 scenarios, all pass with the fixes; one found the bug above. **There are no gym
scenarios for org-join or calls** (`apps/web/e2e/gym` has none; calls have their own lane in `apps/web/e2e/voici-calls`, which Task 6 covers).

## (c) Adversarial review
Published as **`cloud-reports/05c-adversarial-review.md`**, with failing tests on **`0.4/review-cloud`** (4 commits): 5 Medium
(F1 cross-account call-key revocation, F2 SCIM `__proto__` pollution, F3 unverified seat links, F4 keyd CGK adopted under a superseded
record (TS and Rust), F5 audit export doesn't notice dropped box log heads), 4 Low, and 2 Info. No Critical or High findings.
I re-read F1 end to end myself: the revocation is stored and looked up by `callKeyPub` alone (`control-plane/src/voiciCalls.ts:534-546,574`,
`storage/src/voiciCalls.ts:210-219`).
