# Task 2: 0.4/enterprise-build Android check (cloud session)

Tested commit: `fc088c0589f1fd17a9b3b6cb925c7b818d8a4c09` (origin/0.4/enterprise-build, "Enterprise: the Kotlin port of the org authority records")

Setup: JDK 17.0.21 (apt), Android SDK cmdline-tools + platform 36 + build-tools 36.0.0, Gradle 8.11.1 wrapper, `local.properties` sdk.dir only. No repo changes.

## `./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --tests '*OrgAuthorityVectorsTest*' --tests '*VoiciCallsVector*'`
**BUILD SUCCESSFUL.** No compile errors.
- `com.flagshipserver.app.core.pq.OrgAuthorityVectorsTest`: 4 tests, 0 failures
- `com.flagshipserver.app.core.voici.VoiciCallsVectorsTest`: 5 tests, 0 failures

(The first attempt failed only because the sandbox proxy blocked `gcp.mirrors.maven.org`, where Maven Central redirects the 158 MB Robolectric `nativeruntime-dist-compat-1.0.12.jar`. That was an environment issue, not code.)

## `./gradlew :app:testDebugUnitTest` (full)
**BUILD SUCCESSFUL in 2m 32s.** 431 test classes, **2974 tests, 0 failures, 0 errors, 6 skipped.**

No fix needed, so I didn't create `0.4/enterprise-build-cloudfix`.

## `npm run parity` on this branch
Exit 1, **4 reds, not the expected 2**:
- push-categories (2, expected): `ios:voici-call` and `android:voici-call`. Neither platform's push handlers name `voici-call` (emitted by APNS_ALERTS).
- signed-tags (2, **not expected**):
  - `web:flagship/voici-call-allow/v1` is in ios+android but not web
  - `web:flagship/voici-missed-call/v1` is in ios+android but not web

All 18 `org-*` signed-tag reds and the `kotlin:org-authority` test-vector red from release/0.4 are gone on this branch.
