# PAUSE (owner request 2026-10-16): save everything, summarise, stop
Token use is too high; the owner wants the goals tackled one at a time. Do exactly this, then STOP:
1. Don't start anything new. If a build/test command is running, let it finish only if it's < 5 min from done; otherwise stop it.
2. Commit ALL work in your worktree (including WIP) on your worktree branch, with an honest message ("WIP: ...").
   Push it: `git push origin HEAD:refs/heads/wip/<your-topic>-2026-10-16` (force-with-lease is fine for your own wip branch).
   If you have helper sub-agents, tell each to do the same with its own topic and wait for them; list their wip branches.
3. If anything is ready and green, you may land it with land-main.sh first; never land red or half-done work.
4. Release every lock you hold (native-build.lock, android-build.lock, gym.lock). Live gym: tear down every gym server/DNS first.
5. Delete your DerivedData / build outputs (keep the source worktree).
6. Write /private/tmp/claude-501/-Users-harrywinner-flagship/9d44d343-7b43-4e78-b071-875da7d51493/scratchpad/status/<your-topic>.md, at most ~40 lines:
   - Goal (one line)
   - Landed on main (commit ids, one line each)
   - Saved but not landed (wip branch name; what's in it; does it build/test green?)
   - Remaining work, as an ordered list of small steps with a size (S/M/L) and which files
   - Blockers / decisions needed from the owner
   - Gym coverage added / still missing
7. Reply to the coordinator with one line: "<topic>: paused, status at <path>, wip <branch or none>". Then stop and wait.
