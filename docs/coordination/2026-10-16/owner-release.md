# Owner release calls (after owner-deploy.sh)

## A. Endorse a box release (every box-side change needs it; YubiKey, run in a real terminal)
cd ~/flagship && git fetch origin
node scripts/endorse-release.mjs --to origin/main --from <current endorsed box commit>          # dry run: preview only
node scripts/endorse-release.mjs --to origin/main --from <current endorsed box commit> --sign   # YubiKey tap, stages the endorsement
git add .maintainers && git commit -m "Endorse release <sha>" && git push origin HEAD:main
# then redeploy .com so it serves the endorsement (same steps as owner-deploy.sh section 1's last line, from a clean worktree)
# current endorsed commit: node scripts/latest-endorsed-release.mjs

## B. CA lease renewal (before 2026-11-05; YubiKey): see docs/ca-operations.md and `node scripts/rotate-and-endorse-ca.mjs --help`

## C. iOS store build (Xcode 27.1 RC, from a clean worktree of main)
W=~/flagship-ios-wt; git -C ~/flagship worktree add --detach $W origin/main
cd $W/apps/mobile/ios/App
# bump CURRENT_PROJECT_VERSION in project.yml (now "4") to the next build number, then regenerate if xcodegen is used:
#   sed -i '' 's/CURRENT_PROJECT_VERSION: "4"/CURRENT_PROJECT_VERSION: "5"/' project.yml && xcodegen
export DEVELOPER_DIR=/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer
node ~/flagship/scripts/ios-release-clean.mjs --build                       # Release must carry no mocks/dev mode
xcodebuild -project FlagshipApp.xcodeproj -scheme FlagshipApp -configuration Release -destination 'generic/platform=iOS' -archivePath /tmp/Flagship.xcarchive -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath /tmp/Flagship.xcarchive -exportPath /tmp/FlagshipExport -exportOptionsPlist <your ExportOptions.plist with method app-store-connect, destination upload> -allowProvisioningUpdates
# then in App Store Connect: attach the build, answer export compliance (X25519/AES-GCM/Ed25519 sealing), submit.

## D. Android store build (JDK 17; upload key in apps/mobile/android/keystore/keystore.properties)
W=~/flagship-and-wt; git -C ~/flagship worktree add --detach $W origin/main; cd $W/apps/mobile/android
# set versionCode ABOVE the highest in Play's App bundle explorer (build.gradle.kts has 8; versionName 0.0.8): edit app/build.gradle.kts
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
bash scripts/check-release-clean.sh
./gradlew :app:bundleRelease :wear:bundleRelease        # AABs in app/build/outputs/bundle/release; upload to Play internal track

## E. Mac Studio release (notarized DMG): bash scripts/release-studio.sh   (needs wrangler on PATH; Info.plist version is stale at 0.1.0 until fixed)
## F. Windows/Linux Studio: GitHub Actions "studio-release.yml" with publish=true

## G. Gym refresh (already done today): bash scripts/gym-refresh.sh
