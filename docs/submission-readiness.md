# Submission-readiness — open issues to GA

> Owner-requested 2026-06-19. The concrete path from "v2 gating built" to a hand-testable build and an
> app-store submission. Tagged **[agent]** (I can do) vs **[owner]** (needs your accounts/hardware/secrets).
> Sequence: make the new surfaces work+provable → disarm dev-mode → store onboarding → final on-device pass.

## P0 — Make the new surfaces actually work + provable
1. **Gating v2 polish — any-device manual-finalize** (+ `/invite` canonical link + acceptance-reply cross-client pin). **[agent — IN FLIGHT]**
2. **Fix the vibe-build manifest gap** — a one-shot/minimal scratch prompt makes the model omit the manifest's required `data:{}` → deploy 502 ("data must be an object"). Make the manifest schema tolerate a static site with no `data` (optional) OR fix the scratch system-prompt to always emit `data:{}`. **Blocks live-validating any deployed-service flow.** **[agent]**
3. **Live-validate against a real box** — the new gating (v1 + v2) + the web-experience QR-login, end-to-end (box bring-up + the gym data-plane apex are fixed; #2 unblocks a deployable service). **[agent]**
4. **GymLiveTests slices** for the uncovered flows (gating, web-experience) so hand-testing is guided + regressions caught — the gym is mostly backendless mocks today. **[agent]**
5. **Deferred cross-surface parity** (CLAUDE.md): webapp post-recovery keep/replace/wipe screen; companion-requests background poll on mobile; Android `PodSwitcher` + `AddControlDevice` order-send; webapp add-a-server chooser. **[agent]**

## P1 — Dev-mode disarmament (Bucket C — MUST before real users)
6. **CI grep-gate** that FAILS a *release* build if the `debug`-user or burn-time-LUKS constants are present. **[agent]**
7. **Guard/disarm the prod-wipe script** — per-env confirmation token + prod row-count dry-run + audit-logged admin-only path (or remove it from the deployable surface). **[agent]**
8. **Remove `DEV_LATE_LOG` + the W12 debug endpoints** from the release surface (keep on dev). **[agent]**
9. **Gate the demo/dev flips** (3-tap live/mock toggle + DemoFixtures) behind the release flag — keep them for dev/gym. **[agent]**
10. **Builder reburn:** remove the `debug`/`flagship` console user + burn-time LUKS passphrase + re-enable the `luksRemoveKey` guard. **[agent code + owner reburn]**

## P2 — Store onboarding (the actual submission gate)
11. **iOS TestFlight:** Associated Domains capability, Xcode Archive + ASC upload, metadata, ≥5 external testers. **[owner]**
12. **Android Play:** signed AAB (`./gradlew :app:bundleRelease`), internal track, testers. **[owner]**
13. **APNs key + FCM** setup (needs the store presence) → unblocks real push/notifications. **[owner]**
14. **`pro.html` payment placeholders** — Monero + mailing address (on `feat/marketplace`). **[owner]**

## P3 — Feature completeness + final pass
15. **Notifications (#91):** long-poll → app-initiated local → teal sliver (doable now); real push after #11–13. **[agent now + owner]**
16. **On-device hand-test of the security ceremonies** (recovery, re-pair, device-takeover, unlock-approval) — least-proven, highest-risk. **[owner]**

## Recommended sequence
P0 agent items now (1 in flight → 2 unblocks → 3 + 4) ∥ P1 Bucket-C agent items (6,7,8,9) → then the owner-gated P2 store onboarding + the builder reburn (#10) → P3. The store onboarding (P2) is the true long pole and is entirely owner-side, so it's worth starting in parallel with the agent work.
