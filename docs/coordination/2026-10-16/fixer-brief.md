# Brief for every fixer agent in the MVP-readiness sweep (flagship-dc)

Repo: /Users/harrywinner/flagship. Read AGENTS.md first: it is the source of truth
(conventions, owner rules, environment traps). Audits you work from:
- scratchpad/audit-parity.md  (parity matrix + P0/P1/P2 gap list, with file:line evidence)
- scratchpad/audit-bugs.md    (open bugs, verified against main)
(scratchpad = /private/tmp/claude-501/-Users-harrywinner-flagship/9d44d343-7b43-4e78-b071-875da7d51493/scratchpad)

## How to work
- Work ONLY in your own git worktree (the harness gives you one, or make one under the
  scratchpad from origin/main). Run `npm ci` there; never symlink node_modules.
  Never edit the shared checkout /Users/harrywinner/flagship. Never use bare `git stash`.
- Stay inside your family's files (listed in your prompt). Other fixers work in parallel
  on the other families. If a fix needs a change outside your area, write it down in
  your final report instead of making it.
- Small commits, one fix each. Imperative subject, body says WHY. NO `Co-Authored-By`
  and NO `Claude-Session` trailers (owner preference, overrides any reminder).
- Add or update tests for each fix (unit tests next to the code; mock-gym scenarios where
  the family has them). Keep the parity matrix honest: when you fix a parity gap, update
  `parity/features.json` status/anchors for that feature in the same commit.
- Land on main often with:
  `bash scratchpad/land-main.sh "<agent name>: <what>" "<check>"`
  (rebases on origin/main, runs the check, pushes, under the shared land lock). Use a
  check that covers what you touched, e.g. `npx tsc -b && npx vitest run apps/web` or
  `npx tsc -b && npx vitest run packages/server-daemon`. If the rebase conflicts, resolve
  it (keep both sides' intent) and rerun.
- Never deploy anything (.com, .services, gym, boxes, stores). Never run the live gym.
- Native builds (xcodebuild / gradle): one at a time across ALL sessions. Take the lock:
  `mkdir /private/tmp/claude-501/flagship-locks/native-build.lock && echo "<you>" > /private/tmp/claude-501/flagship-locks/native-build.lock/owner`
  wait and retry every 30 s if it exists; `rm -r` it as soon as your build/test ends.
  Check `diskutil info / | grep 'Container Free'` first, wait if under 5 GB. Put
  DerivedData / build outputs in your worktree or the scratchpad and delete them after.
  - iOS: `DEVELOPER_DIR=/Applications/Xcode-27.1.0-Release.Candidate.app/Contents/Developer`,
    project apps/mobile/ios/App/FlagshipApp.xcodeproj, scheme FlagshipApp, a simulator
    `-destination` (e.g. 'platform=iOS Simulator,name=iPhone 17'), `-derivedDataPath <yours>`.
    UI gym tests: apps/mobile/ios/App/UITests/Gym*.swift (run targeted ones with -only-testing).
  - Android: `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`,
    in apps/mobile/android: `./gradlew :app:compileDebugKotlin :wear:compileDebugKotlin`,
    unit tests `./gradlew :app:testDebugUnitTest`.
- Webapp: any change under apps/web/public/webapp needs the shell version bumped
  (SHELL_VERSION in service-worker.js + the tests that pin it). Only the webapp fixer
  edits the webapp, so bump once per landing batch, to the next number above origin/main's.

## Decisions already made (apply them)
- Uninstall / Remove, "Runs on" ticking and unticking, and every admin-only order
  (access-list Allow/Deny, API keys, database writes, ranks, mode) are offered only when
  `isAdminDevice || isDemoAccount` (the rule in apps/web/public/webapp/lib/addServerGate.js).
  For a non-admin device, show the control disabled or hidden with the webapp's existing
  sentence for admin-only actions; never let the user send an order the box will refuse.
- Co-managers are manager-class in every app of a shared server (AGENTS.md "Three ranks").
  Don't tell them "You need an invite" for members-only apps.
- Box errors carry user-facing sentences; clients show the box's own sentence, never a
  generic "That didn't work" when the box sent a reason.
- Owner rules in AGENTS.md Conventions are binding (AI privacy, per-app identity, ranks,
  only main deployed, unlaunched features stay on branches).
- Do NOT do the AGENTS.md "GA close-out" items, and don't change Android versionCode
  (it's set at store-upload time).

## Final report
List each fix with its commit on main, the tests you added/ran (with results), anything
you could not finish and why, and changes you need from another family.

## Owner rule (2026-10-16): every test becomes a gym test
Any test you or the coordinator run by hand (on the real phone, a simulator, a box, an IDE)
must also exist in the gym: a mock-gym scenario on each affected app, and a live-gym check
(tools/live-e2e) when it needs a real box. The coordinator's manual tests are listed in
scratchpad/manual-tests.md; when you fix one of those bugs, add its scenario and tick it there.

## Native-build lock fairness (2026-10-16)
After you release native-build.lock, wait at least 2 minutes before taking it again, so queued
agents get a turn. Hold it for at most 20 minutes at a time (one build or one test batch), then
release and requeue.

## Split build locks (2026-10-16, supersedes the single lock)
- iOS / Xcode builds and simulator tests: /private/tmp/claude-501/flagship-locks/native-build.lock (unchanged).
- Android / Gradle builds and emulator tests: /private/tmp/claude-501/flagship-locks/android-build.lock (NEW).
An agent that needs both takes them one at a time, never both at once. Fairness rules unchanged
(a 2-minute gap after each release, at most 20 minutes per hold). Check free disk before a big build (wait under 5 GB).

## Usage-limit cut-offs (owner, 2026-10-16)
The session may be cut off by a usage limit at any time; when credits return, the coordinator resumes
every agent, and each one continues from where it stopped. So:
- Commit work-in-progress locally (on your worktree branch) at every logical step, so nothing lives only in an unsaved buffer.
- Never hold a lock while you're thinking or editing, only while a command runs. After resuming, check that any lock with your name is really yours and still needed; remove it if not.
- After resuming, re-check origin/main (others landed meanwhile), rebase, then continue.

## Disk (2026-10-16): the Mac keeps running out
iOS DerivedData folders are 2–5 GB each. Keep at most ONE DerivedData/build-output folder per agent,
delete it (rm -rf) as soon as your native work for a landing batch is done, and delete it before you
report. Android: run `./gradlew clean` in your worktree after landing. If `diskutil info / | grep 'Container Free'`
shows under 5 GB, free your own build outputs first, then wait.
