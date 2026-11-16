# Task 6: release/0.4 @ `4bb402875` (org-directory 2, custody 2, libwebrtc pin, calls round 3) (cloud session)

Tested commit: `4bb402875` ("0.4 journal: calls round 3 merged"), fresh worktree, `npm i`. 4 vCPU / 15 GiB, Linux x86-64,
node 22.23.4, Rust 1.99.1, JDK 17 + Android SDK 36, Docker 29.9.

**Headline:** everything passes except (1) the **webapp boot break from report 05**, which is in this commit too
(`b34cf9971` is an ancestor; fix `0.4/webapp-boot-cloudfix`), and (2) two REAL vitest failures, both fixed on
`0.4/vitest-cloudfix`. The only Android failure is the known Compose flake (fix `0.4/compose-flake-cloudfix`, not in this commit).

| # | step | result |
|---|---|---|
| 1 | `npm i`, `npx tsc -b` | **PASS** |
| 2 | full `npx vitest run` | 1358 files, 18300 tests: **3 failed** (2 REAL, 1 FLAKY), see below |
| 3 | `npm run i18n` / `npm run parity` | **PASS / PASS** (no reds) |
| 4 | `cargo fmt --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` | **PASS** / **PASS** (clean) / **PASS**: 120 binaries, 844 passed, 0 failed, 4 ignored |
| 5 | Android `:app:assembleDebug :wear:assembleDebug :app:testDebugUnitTest` | both builds **PASS**; libwebrtc **downloaded and verified**; tests 3065, **1 failure = known FLAKY** `ModelMenuComposeTest.stagedAttachmentsWithNotice` |
| 6 | adversarial suite `npx vitest run tools/adversarial` | **PASS** |
| 7 | openldap CI job against `osixia/openldap:1.5.0` (Docker) | **PASS** (real run, see below) |
| 8 | Playwright `apps/web/e2e/voici-calls` | **PASS 3/3** |
| 9 | gym `gym-custody.spec.ts` | **FAIL 3/3 at 4bb402875 (ENV-of-the-commit: the boot break)**; **PASS 3/3** on `0.4/gym-cloudfix` |

## 2. vitest: 3 failures, each rerun alone
- **REAL** `packages/server-daemon/tests/pgErrorListeners.test.ts`: `expected [ 'directory/ldap.ts:81' ] to deeply equal []`.
  A false positive. The guard treats any `new Client(` as a Postgres client, and org-directory round two's LDAP pull builds an
  `ldapts` Client. **Fixed** (`370777ddb`): the guard only looks in files that load `pg` (`from "pg"` or `import("pg")`). It
  still finds every real pg client (appSql, realAdmins, pgQuota, runtime).
- **REAL** `packages/storage/tests/accountRename.test.ts`: `voici_call_keys.username`, `voici_call_key_revocations.username`,
  `voici_ring_backs.username` and `voici_call_settings.username` are in neither list. **Fixed** (`72745ca48`). **Please review
  the classification**, since it's a judgement call:
  - **Renamed:** `voici_call_settings` (the owner's call hours: one ciphertext under a UMK-derived key, so the account's own) and
    `voici_ring_backs` (the caller account whose phones a call-back rings, the same reasoning as `voici_voip_tokens`).
  - **Not renamed:** `voici_call_keys` ("each binding is signed over the old name, so a rewritten row would not verify; the
    device binds its call key again under the new name") and `voici_call_key_revocations` ("a revocation record, keyed by
    the call key"). Consequence: after a rename, locked-phone answering needs the device to bind again. Old binding rows stay
    under the old name and only verify under the old page key. Review F1 (cross-account revocation) is separate and still open.
- **FLAKY** `apps/com/test/cpuBudget.test.ts`: CPU timing under full-suite load; 2/2 alone (also seen in report 03).

Branch **`0.4/vitest-cloudfix`** is off the current tip `6a2a7779f`, 2 commits. The storage suite (41 files, 640 tests), both
rename test files and the pg guard all pass on it.

## 5. Android and the libwebrtc pin
`libwebrtc: downloading libwebrtc.aar from libwebrtc-157-43884507084` and `… flagship-turn-android.zip …` into
`apps/mobile/android/build/webrtc/libwebrtc-157-43884507084/` (the release assets were reachable here via
release-assets.githubusercontent.com). The build's own check passed. I also checked the hashes independently against
`tools/libwebrtc/artifacts.sha256`: `libwebrtc.aar` `b6778d3d…186f` (38 MB) ✓ and `flagship-turn-android.zip` `8eb2998f…6804` ✓.
The debug APK carries `libjingle_peerconnection_so.so` and `libflagship_turn_ffi.so` for arm64-v8a, armeabi-v7a and x86_64.
`:wear:assembleDebug` PASS. Unit tests: 3065, 6 skipped, 1 failure = the Compose flake (5/5 green with the fix branch, report 05).

## 7. OpenLDAP job
`docker pull osixia/openldap:1.5.0` (digest `sha256:18742e9c449c9c1afe129d3f2f3ee15fb34cc43e5f940a20f3399728f41d7c28`; the first
attempt hit Docker Hub's anonymous 429, a retry later worked). The container ran with the CI job's env, and the health-check
`ldapsearch` answered. Then I ran the job's command,
`npx vitest run packages/server-daemon/tests/directory.openldap.integration.test.ts`, with the four `FLAGSHIP_TEST_LDAP_*` vars:
**1 passed**. It was a real run, not a skip: slapd logged the admin BIND, two `ADD uid=ana|old,ou=people-<ts>` entries and the
`(objectClass=inetOrgPerson)` SRCH for `entryUUID mail cn memberOf employeeType` (2 entries).

## 8–9. Playwright
- `apps/web/e2e/voici-calls`: **3/3** pass: handed-off call requested, rung, answered and checked; a handoff link opens once; an
  anonymous visitor calls a page open to anyone (proof of work). That lane serves its own pages, which is why the boot break
  doesn't affect it.
- `gym-custody.spec.ts` at `4bb402875`: 3/3 fail at `#view-bootstrap` (the boot break). On `0.4/gym-cloudfix` (boot fix plus
  the gym fixes, current tip) all three pass in the full 375/375 gym run.

## Still open from earlier reports
- Merge order suggestion: `0.4/webapp-boot-cloudfix` **first** (the webapp does not boot), then `0.4/gym-cloudfix` (stacked on
  it; includes the restore-merge confirm-dialog product fix `6391e2e45`), `0.4/compose-flake-cloudfix`, `0.4/vitest-cloudfix`.
- Review findings F1–F5 (report 05c) have failing tests on `0.4/review-cloud`; I haven't fixed them.
