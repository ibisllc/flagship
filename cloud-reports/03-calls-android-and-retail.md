# Task 3: voi.ci calls Android + retail image (cloud session). COMPLETE

## (a) release/0.4 @ `5ffcb2e29f5971bf0b34e212272d0e5ad8d8b0cf`, Android
`./gradlew --continue :app:compileDebugKotlin :app:assembleDebug :app:testDebugUnitTest :wear:assembleDebug` (JDK 17, SDK 36)

- `:app:compileDebugKotlin`: **PASS, no compile errors** (the new calls/, VoiciCallPush.kt, ConnectionService, VoiciCallActivity and manifest all compile)
- `:app:assembleDebug`: **PASS** (`app-debug.apk`)
- `:wear:assembleDebug`: **PASS** (`wear-debug.apk`)
- `:app:testDebugUnitTest`: 431 classes, 2975 tests, 2 failures on the first run, **both green on rerun → no real failures**:
  - `MaintainersConformanceTest > allConformanceVectors_replayToManifestVerdict`: **ENV**. The test reads `node_modules/@ibisllc/maintainers/conformance/manifest.json`, and my fresh worktree had no `npm ci` yet. Passes after `npm ci` (2/2). Worth knowing: Android unit tests need the root `node_modules`.
  - `ModelMenuComposeTest > stagedAttachmentsWithNotice` (`AppNotIdleException` at `ModelMenuComposeTest.kt:94`): **FLAKY**. Same as report 01; passes alone (8/8).

No fixes needed, so I didn't create `0.4/calls-android-cloudfix`.

## (b) 0.4/retail-image @ `502e27a399dd3ea855df4a122e7ee1965a1cd07d`, `tools/retail-vm/run.sh`
**NOT RUN: there is no KVM.** `/dev/kvm` doesn't exist in this cloud container (no nested virtualization available), and `run.sh` exits 2 on that check. Stopped as instructed.

**btvirt:** Ubuntu 24.04's `bluez-test-tools` (5.72-0ubuntu5.8, a Debian-derived package) ships `/usr/bin/btvirt` (plus `man1/btvirt.1.gz`), from `dpkg -c` of the downloaded .deb. I could **not** check Debian trixie's own package directly because the sandbox proxy blocks `deb.debian.org`. It's very likely the same, since Ubuntu takes the Debian bluez packaging, but it's unverified for Debian 13.

## (c) 0.4/retail-image @ `502e27a39`: vitest + Android
`npm ci` + `npx tsc -b`: PASS.

### `npx vitest run` (1333 files, 17987 tests, 643 s on 4 vCPU): 13 files / 14 tests failed. Each file rerun alone:

**Caused by the retail branch (they pass on release/0.4 @ 5ffcb2e29):**

| File | Alone | Verdict | Failure / cause |
|---|---|---|---|
| `packages/flagship-builder/tests/applianceDiskKey.test.ts:257` "re-keys after the recipe check and before … the bootstrap runs" | 1 fail | **REAL (stale test, mechanical)** | `expected 9364 to be less than -1`: the test looks for `FLAGSHIP_APPLIANCE_PREINSTALLED=1 /usr/local/sbin/flagship-bootstrap.sh`, but the branch changed `appliance.ts:175` to `FLAGSHIP_APPLIANCE_PREINSTALLED=1 FLAGSHIP_BOX_KEY_IN_KEYD="$RETAIL" /usr/local/sbin/flagship-bootstrap.sh`. indexOf returns -1. Update the needle. |
| `packages/server-daemon/tests/retainedRuntime.test.ts:50` "every ExecStart names an absolute executable…" | 1 fail | **REAL (stale test, mechanical)** | It still expects the literal `^ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning packages/server-daemon/dist/index.js$` in `userdata.ts`. The branch moved the unit into `daemonServiceUnit()` (`packages/flagship-builder/src/daemonUnit.ts:25`, where that line still exists unchanged). Point the test at `daemonUnit.ts` (or at the rendered unit). |
| `apps/com/test/cpuBudget.test.ts` "stays within the D1 round-trip and CPU budgets" | 2/2 pass | **FLAKY** | CPU timing under full-suite load; it also passed on release/0.4 |

**Inherited from release/0.4 (they fail at 5ffcb2e29 too; most are in report 01 / the cloud-fixes work):**
- `packages/control-plane/tests/schemaStatus.test.ts`: KNOWN_MIGRATIONS is missing `0141`, `0146`
- `scripts/release-manifest.test.ts:41`: probably the same ledger drift
- `packages/storage/tests/accountRename.test.ts`: `voici_live_calls.username`, `voici_voip_tokens.username`
- `tools/adversarial/tests/envelopeForgery.test.ts`: AT-ENV-09 `BoxClaimKey` separator shift; AT-ENV-10 now has **28** unclassified tags (17 on release/0.4 @27859683)
- `scripts/compat-matrix.test.ts`: 208 ≠ 210
- `scripts/gym-refresh-acme.test.ts`: empty `ISSUANCE_ACME_DIRECTORY`
- `scripts/ios-release-clean.test.ts`: `MockScreensClient+RestoreMerge.swift`
- **New since report 01, also on release/0.4 @5ffcb2e29:**
  - `apps/web/tests/webappKeyInventory.test.ts:58` (N06 ratchet): `lib/orgJoin.js` touches key material and isn't on the known list
  - `apps/web/tests/webappSecurityNotice.test.ts:94`: `WEB_BUILD` expected 213, got 210 (shell version vs. the pin)
  - `scripts/mobile-clients-inventory.test.ts:72`: raw HTTP clients outside the pinning factory in the new calls code: `android/.../calls/VoiciCallCenter.kt`, `ios/.../Calls/VoiciCallCenter.swift`, `ios/.../Calls/VoiciCallSession.swift`

### Android `:app:testDebugUnitTest` on retail-image
431 classes, 2975 tests, **1 failure = the known FLAKY `ModelMenuComposeTest.stagedAttachmentsWithNotice`**; everything else passes, including the preseed golden-vector readers. The regenerated vectors are fine on Android.
