# Branch cleanup, 2026-10-25

The 0.3 release (security hardening, UX, architecture, milestones 7-8) landed on `release/0.3`.
Every other branch was archived on origin under `refs/archive/2026-10-25/<name>` (or `.../local/<name>`
and `.../remote/<name>` where the two copies differed) and then deleted; uncommitted work found in
worktrees is under `refs/archive/2026-10-25/wip/<worktree>`. Nothing was lost: fetch any of them with
`git fetch origin refs/archive/2026-10-25/<name>:<name>`.

Kept: `main`, `release/0.3`, `gym`, `hof-jay`, the unlaunched feature branches (`feat/marketplace`,
`feat/custom-names`, `feat/custom-domains`, `feat/outbound-proxy`, `feat/retail`,
`feat/browser-extension`, `feat/phone-usb-burn`, `feat/other-os-installers`, `feat/data-sovereignty`,
`alpine`), UX's newer copies of four of them (`ux-marketplace`, `ux-custom-names`, `ux-custom-domains`,
`ux-outbound-proxy`, to fold in when those are rebased), `device-results/windows-2026-10-17` and
`wip/coordination-2026-10-16`.

How each deleted branch relates to `release/0.3` at `03813fda4`: **ANCESTOR** (all its commits are in
the release), **CONTAINED** (merging it changes nothing), otherwise the share of its own added lines
(commits not patch-equal to one in the release) still present verbatim in the release. Lower shares are
work that landed in another form (rebased, reworked, moved from `main` to `debug` sources, or removed
on purpose, e.g. the chat lead authority, the pre-0.3 copies of the gym seams).

| Branch | Relation |
|---|---|
| `a1-android` | ANCESTOR |
| `a1-m14` | ANCESTOR |
| `a1-m14b` | ANCESTOR |
| `a2-android` | ANCESTOR |
| `a4-debug` | ANCESTOR |
| `a5-env` | ANCESTOR |
| `a6-backups` | ANCESTOR |
| `a7-android` | ANCESTOR |
| `a7-restore` | ANCESTOR |
| `a7-sweep` | ANCESTOR |
| `a7-sweep-saved` | 100.0% present |
| `a8-material` | ANCESTOR |
| `agent/web-assets` | ANCESTOR |
| `android-redesign` | 76.3% present |
| `b1-no-mocks` | ANCESTOR |
| `backup/alpine-pre-rebase-2026-10-08` | backup |
| `backup/alpine-pre-rebase-2026-10-14` | backup |
| `backup/alpine-pre-rebase-2026-10-15` | backup |
| `backup/alpine-pre-rebase-2026-10-15-161018` | backup |
| `backup/alpine-pre-rebase-2026-10-15-164719` | backup |
| `backup/alpine-pre-rebase-2026-10-15-165030` | backup |
| `backup/alpine-pre-rebase-2026-10-15-165843` | backup |
| `backup/alpine-pre-rebase-2026-10-15-181533` | backup |
| `backup/alpine-pre-rebase-2026-10-15-201056` | backup |
| `backup/alpine-pre-rebase-2026-10-16` | backup |
| `backup/browser-extension-pre-rebase-2026-10-14` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-142850` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-160925` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-164659` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-165016` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-165825` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-181523` | backup |
| `backup/browser-extension-pre-rebase-2026-10-15-201038` | backup |
| `backup/browser-extension-pre-rebase-2026-10-16` | backup |
| `backup/custom-domains-pre-named-links-2026-10-21` | backup |
| `backup/custom-domains-pre-rebase-2026-10-14` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15-165936` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15-181623` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15-201354` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15-b` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15-c` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15-d` | backup |
| `backup/custom-domains-pre-rebase-2026-10-15b` | backup |
| `backup/custom-domains-pre-rebase-2026-10-16` | backup |
| `backup/custom-domains-pre-ux-2026-10-23` | backup |
| `backup/custom-names-pre-named-links-2026-10-21` | backup |
| `backup/custom-names-pre-rebase-2026-10-14` | backup |
| `backup/custom-names-pre-rebase-2026-10-15` | backup |
| `backup/custom-names-pre-rebase-2026-10-15-165926` | backup |
| `backup/custom-names-pre-rebase-2026-10-15-181612` | backup |
| `backup/custom-names-pre-rebase-2026-10-15-201354` | backup |
| `backup/custom-names-pre-rebase-2026-10-15-b` | backup |
| `backup/custom-names-pre-rebase-2026-10-15-c` | backup |
| `backup/custom-names-pre-rebase-2026-10-15-d` | backup |
| `backup/custom-names-pre-rebase-2026-10-15b` | backup |
| `backup/custom-names-pre-rebase-2026-10-16` | backup |
| `backup/custom-names-pre-ux-2026-10-23` | backup |
| `backup/feat-UX-pre-integration-2026-10-24` | backup |
| `backup/feat-architecture-pre-integration-2026-10-24` | backup |
| `backup/feat-browser-extension-pre-rebase-2026-10-08` | backup |
| `backup/feat-chromebook-fit-pre-rebase-2026-10-08` | backup |
| `backup/feat-free-tier-throttle-2026-10-13` | backup |
| `backup/feat-marketplace-pre-rebase-2026-10-08` | backup |
| `backup/feat-retail-pre-rebase-2026-10-08` | backup |
| `backup/gym-pre-0.3-2026-10-25` | backup |
| `backup/gym-pre-rebase-2026-10-08` | backup |
| `backup/gym-pre-rebase-2026-10-14` | backup |
| `backup/gym-pre-rebase-2026-10-17` | backup |
| `backup/gym-pre-rebase-2026-10-18` | backup |
| `backup/gym-pre-rebase-2026-10-18b` | backup |
| `backup/gym-ux-pre-integration-2026-10-24` | backup |
| `backup/lock-screen-sign-out-pre-ux-2026-10-23` | backup |
| `backup/marketplace-pre-named-links-2026-10-21` | backup |
| `backup/marketplace-pre-rebase-2026-10-14` | backup |
| `backup/marketplace-pre-rebase-2026-10-15` | backup |
| `backup/marketplace-pre-rebase-2026-10-15-165915` | backup |
| `backup/marketplace-pre-rebase-2026-10-15-181602` | backup |
| `backup/marketplace-pre-rebase-2026-10-15-201354` | backup |
| `backup/marketplace-pre-rebase-2026-10-15-b` | backup |
| `backup/marketplace-pre-rebase-2026-10-15-c` | backup |
| `backup/marketplace-pre-rebase-2026-10-15b` | backup |
| `backup/marketplace-pre-rebase-2026-10-16` | backup |
| `backup/marketplace-pre-ux-2026-10-23` | backup |
| `backup/multilingual-pre-ux-2026-10-23` | backup |
| `backup/named-links-pre-ux-2026-10-23` | backup |
| `backup/outbound-proxy-pre-named-links-2026-10-21` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15-165945` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15-181633` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15-201354` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15-b` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15-c` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-15-d` | backup |
| `backup/outbound-proxy-pre-rebase-2026-10-16` | backup |
| `backup/outbound-proxy-pre-ux-2026-10-23` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-14` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15-161110` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15-164732` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15-165055` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15-165855` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15-181542` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-15-201107` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-16` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-16-082234` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-17` | backup |
| `backup/phone-usb-burn-pre-rebase-2026-10-17-010342` | backup |
| `backup/release-0.3-pre-squash` | backup |
| `backup/retail-pre-rebase-2026-10-14` | backup |
| `backup/retail-pre-rebase-2026-10-15` | backup |
| `backup/retail-pre-rebase-2026-10-15-142931` | backup |
| `backup/retail-pre-rebase-2026-10-15-161137` | backup |
| `backup/retail-pre-rebase-2026-10-15-165905` | backup |
| `backup/retail-pre-rebase-2026-10-15-181552` | backup |
| `backup/retail-pre-rebase-2026-10-15-201117` | backup |
| `backup/retail-pre-rebase-2026-10-15-c` | backup |
| `backup/retail-pre-rebase-2026-10-16` | backup |
| `backup/ux-custom-domains-2026-10-24` | backup |
| `backup/ux-custom-names-2026-10-24` | backup |
| `backup/ux-fc-android-2026-10-24` | backup |
| `backup/ux-fc-ios-wip-2026-10-24` | backup |
| `backup/ux-fc-web-2026-10-24` | backup |
| `backup/ux-marketplace-2026-10-24` | backup |
| `backup/ux-outbound-proxy-2026-10-24` | backup |
| `backup/ux-rb-wt-wip-2026-10-24` | backup |
| `build-chat-model-switch` | 94.3% present |
| `c1-pairing` | ANCESTOR |
| `c2-peer` | ANCESTOR |
| `c3-backups` | ANCESTOR |
| `chore/delete-wipe-tooling` | 100.0% present |
| `coord-activity` | ANCESTOR |
| `f1-ci` | ANCESTOR |
| `feat/UX` | 96.9% present |
| `feat/architecture` | 96.5% present |
| `feat/multilingual` | 95.8% present |
| `feat/named-links` | 95.9% present |
| `fix/android-device-pairing` | ANCESTOR |
| `fix/appliance-factory-tar` | CONTAINED |
| `fix/appliance-gym` | 1.0% present |
| `fix/appliance-resize-key` | 100.0% present |
| `fix/final-round-polish` | ANCESTOR |
| `fix/home-single-leader` | ANCESTOR |
| `fix/hub-blessing-auth` | ANCESTOR |
| `fix/ios-device-pairing` | ANCESTOR |
| `fix/lock-screen-sign-out-auth` | 95.8% present |
| `fix/manifest-description-shorten` | ANCESTOR |
| `fix/prerelease-cleanup` | ANCESTOR |
| `fix/studio-restart-keeps-start` | ANCESTOR |
| `fix/studio-serial-uart` | ANCESTOR |
| `fixer/pre-ga-scrub` | ANCESTOR |
| `gym-keep` | 87.3% present |
| `gym-land-2` | 87.3% present |
| `gym-land-3` | ANCESTOR |
| `gym-pods` | 89.7% present |
| `gym-stack` | ANCESTOR |
| `gym-stream/fixes` | ANCESTOR |
| `gym-stream/gym-rebased` | 1.0% present |
| `gym-stream/probe` | ANCESTOR |
| `gym-stream/rebase-2026-10-18b` | 1.0% present |
| `gym-ux` | 91.1% present |
| `integrate/0.3` | ANCESTOR |
| `integrate/0.3-arch` | ANCESTOR |
| `ios-b8` | ANCESTOR |
| `ios-backups` | ANCESTOR |
| `ios-fixes-win` | 92.5% present |
| `ios-gym-sweep` | 94.3% present |
| `ios-notices` | ANCESTOR |
| `ios-polish` | ANCESTOR |
| `ios-stream` | ANCESTOR |
| `ios-sweep-final` | ANCESTOR |
| `ios-win-land` | ANCESTOR |
| `livegym-d1` | ANCESTOR |
| `plan/update-server-feature` | ANCESTOR |
| `rc-verify` | ANCESTOR |
| `rescue/ai-needs-you-chat-76d6312` | 58.1% present |
| `tmp/mkt-rebased-on-5e80` | 3.9% present |
| `todo/backend-batch` | ANCESTOR |
| `ux-android-screens` | 96.0% present |
| `ux-fc-android` | 96.8% present |
| `ux-fc-ios` | 96.9% present |
| `ux-fc-web` | 96.9% present |
| `ux-ios-screens` | 96.0% present |
| `ux-lead-fix` | 96.9% present |
| `ux-rebase` | 97.5% present |
| `ux-rebase-pre2` | 96.0% present |
| `ux-web-screens` | 96.0% present |
| `web-box/cpu-budget` | ANCESTOR |
| `web-box/ga-luks` | ANCESTOR |
| `web-box/other-os-installers` | 7.4% present |
| `web-box/rck-parity` | ANCESTOR |
| `web-box/version-0-2` | ANCESTOR |
| `web-n1-account-gone` | ANCESTOR |
| `web-n1b-admin-key` | ANCESTOR |
| `web-wildcard-dns` | ANCESTOR |
| `wip/android-device-bugs-2026-10-16` | 100.0% present |
| `wip/android-redesign-2026-10-16` | 76.3% present |
| `wip/auto-a079b83e15cdc6c0e-2026-10-16` | 94.3% present |
| `wip/auto-a25bffb381ce78912-2026-10-16` | 89.4% present |
| `wip/auto-a31d9777148f27d98-2026-10-16` | 54.3% present |
| `wip/auto-a362f24ae7b10110f-2026-10-16` | 79.1% present |
| `wip/auto-a85a0ff2b359fdecf-2026-10-16` | 96.9% present |
| `wip/auto-abb7589a25141d1dc-2026-10-16` | 88.5% present |
| `wip/backups-2026-10-16` | 100.0% present |
| `wip/backups-android-2026-10-16` | 79.1% present |
| `wip/backups-ios-2026-10-16` | 95.2% present |
| `wip/co-invite-native-2026-10-16` | 85.7% present |
| `wip/connect-account-2026-10-16` | 91.5% present |
| `wip/debug-access-2026-10-16` | 88.5% present |
| `wip/env-sign-2026-10-16` | 95.7% present |
| `wip/gym-burn-test-2026-10-17` | 1.6% present |
| `wip/gym-burn-test-2026-10-17-rebased` | 1.6% present |
| `wip/ios-gym-2026-10-16` | 93.6% present |
| `wip/ios-gym-sweep-remainder-2026-10-17` | 94.3% present |
| `wip/live-gym-2026-10-16` | 100.0% present |
| `wip/no-mocks-2026-10-16` | 95.2% present |
| `wip/pairing-relay-2026-10-16` | 98.6% present |
| `wip/parity-honest` | ANCESTOR |
| `wip/peer-backup-2026-10-16` | ANCESTOR |
| `wip/share-accept-2026-10-16` | 71.8% present |
| `wip/share-accept-ios-2026-10-16` | 85.0% present |
| `worktree-agent-a0076e5d15cf210b4` | 85.7% present |
| `worktree-agent-a04d461adc1f9c793` | 91.5% present |
| `worktree-agent-a079b83e15cdc6c0e` | ANCESTOR |
| `worktree-agent-a09ae3f2b0246805c` | ANCESTOR |
| `worktree-agent-a0df80e0c379a6f23` | ANCESTOR |
| `worktree-agent-a1413a0f17bcaeadb` | ANCESTOR |
| `worktree-agent-a1552e40e8d9cd9e4` | 71.8% present |
| `worktree-agent-a1b2b33dfc42f4aa5` | 95.2% present |
| `worktree-agent-a1f3cf7d70daba370` | 100.0% present |
| `worktree-agent-a23b8062211fcef99` | ANCESTOR |
| `worktree-agent-a25bffb381ce78912` | 89.4% present |
| `worktree-agent-a2a70a74864c84c71` | ANCESTOR |
| `worktree-agent-a31a91d4b2ececf54` | 87.5% present |
| `worktree-agent-a31d9777148f27d98` | 54.3% present |
| `worktree-agent-a3453a8beb01656fa` | ANCESTOR |
| `worktree-agent-a362f24ae7b10110f` | 79.1% present |
| `worktree-agent-a409a55b4ae5eafbc` | 100.0% present |
| `worktree-agent-a427e545c7d53748d` | ANCESTOR |
| `worktree-agent-a46afda5bf7608481` | ANCESTOR |
| `worktree-agent-a51d46e5166954693` | ANCESTOR |
| `worktree-agent-a5ac0708eb313482b` | ANCESTOR |
| `worktree-agent-a5b14f4d5a500cf8a` | ANCESTOR |
| `worktree-agent-a5eb59330783e7f75` | 71.4% present |
| `worktree-agent-a607115b4dc928caa` | ANCESTOR |
| `worktree-agent-a60f1b28185b55023` | ANCESTOR |
| `worktree-agent-a69c759cb0fb47189` | ANCESTOR |
| `worktree-agent-a75c427772f9b54d2` | ANCESTOR |
| `worktree-agent-a7b4ee4d0ba40fba8` | ANCESTOR |
| `worktree-agent-a7ec6fa0c55aed893` | ANCESTOR |
| `worktree-agent-a7f443f3455063ebe` | ANCESTOR |
| `worktree-agent-a85a0ff2b359fdecf` | 96.9% present |
| `worktree-agent-a87fc7d4a5c123596` | ANCESTOR |
| `worktree-agent-a8a3a9f93f887df53` | 100.0% present |
| `worktree-agent-a923bd80c2380d4d5` | ANCESTOR |
| `worktree-agent-aa3853c57f3fca4fb` | 93.6% present |
| `worktree-agent-aa6ea7e8e7ed636a4` | 79.1% present |
| `worktree-agent-aa94eb8a6f97d4fbf` | 95.7% present |
| `worktree-agent-ab3341932f36f2f18` | 100.0% present |
| `worktree-agent-ab9efd9e99d7908e9` | 88.5% present |
| `worktree-agent-abb7589a25141d1dc` | ANCESTOR |
| `worktree-agent-ac677e0d076261b10` | 95.2% present |
| `worktree-agent-ac918c705b732dfcb` | 98.6% present |
| `worktree-agent-ad2ee798c8a032681` | ANCESTOR |
| `worktree-agent-add85f9917d805d43` | ANCESTOR |
| `worktree-agent-ae23fd5c171a11238` | ANCESTOR |
| `worktree-agent-ae7af9e776fb34af4` | ANCESTOR |
| `worktree-agent-ae884f7198d919431` | 71.4% present |
| `worktree-agent-aecb904476b53ef84` | 85.0% present |
| `worktree-agent-aeddd892ab1dd8206` | 89.7% present |

| Worktree snapshot | Archived as |
|---|---|
| `flagship` | `refs/archive/2026-10-25/wip/flagship` (0d7567969) |
| `flagship-shim-wt` | `refs/archive/2026-10-25/wip/flagship-shim-wt` (6ebca2f9d) |
| `agent-a25bffb381ce78912` | `refs/archive/2026-10-25/wip/agent-a25bffb381ce78912` (93ed597cd) |
| `agent-abb7589a25141d1dc` | `refs/archive/2026-10-25/wip/agent-abb7589a25141d1dc` (3a14c2ce1) |
