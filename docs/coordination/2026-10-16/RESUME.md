# How the coordinator resumes after a usage-limit cut-off
1. Check locks in /private/tmp/claude-501/flagship-locks/ (gym.lock, native-build.lock = iOS, android-build.lock).
   A lock whose owner agent was cut off and has no running process (ps for xcodebuild/gradle/shared-run) is stale: remove it.
2. SendMessage "usage is back; resume where you stopped" to every top-level agent (ids in the session),
   and ask parents to resume their helpers.
3. Start anything in queued-tasks.md not yet started.
4. Phone: adb over Wi-Fi at <phone-ip>:<port> (re-pair if the port changed; ph.sh holds P=).
