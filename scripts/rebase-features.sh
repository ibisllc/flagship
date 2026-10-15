#!/usr/bin/env bash
# Keep the unlaunched feature branches current with main (AGENTS.md,
# "Unlaunched features live entirely on their own branch").
#
# Each branch is its parent plus one feature: main for most, feat/marketplace
# for the two that need its payment rail. A child is rebased onto its parent's
# tip only after the parent itself moved, so run the whole list in one go.
#
#   scripts/rebase-features.sh            report: behind/ahead + predicted conflicts
#   scripts/rebase-features.sh --apply    also rebase every branch predicted clean,
#                                         in a scratch worktree, and push it
#
# --apply, per clean branch: a backup ref (backup/<slug>-pre-rebase-<date>),
# `git rebase --onto <parent> <old base>` in a scratch worktree with its own
# `npm ci`, `npx tsc -b`, then the branch ref moves and is pushed with
# --force-with-lease against the tip it had. A branch with predicted
# conflicts, a failed rebase or a red tsc is left untouched and listed for a
# person or agent to finish by hand. A branch checked out in another worktree
# is skipped (detach it there first). Children are skipped when their parent
# needed work and didn't move.
#
# The web shell's cache version (SHELL_VERSION in
# apps/web/public/webapp/service-worker.js) is a known hand-off: a branch that
# changes webapp files runs its own version above its parent's. When the parent
# moves past it the rebase conflicts there, or the report flags it; pick the
# next unused version above the parent's and update the tests that pin it.
#
# Options: --apply, --no-push, --no-tsc, --remote <name> (default origin),
#          --only <branch> (repeatable), --scratch <dir> (default $TMPDIR).
set -euo pipefail

# branch:parent, parents listed before their children.
BRANCHES=(
  "feat/browser-extension:main"
  "alpine:main"
  "feat/phone-usb-burn:main"
  "feat/retail:main"
  "feat/marketplace:main"
  "feat/custom-names:feat/marketplace"
  "feat/custom-domains:feat/marketplace"
)

APPLY=0 PUSH=1 TSC=1 REMOTE=origin ONLY=() SCRATCH="${TMPDIR:-/tmp}"
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --no-push) PUSH=0 ;;
    --no-tsc) TSC=0 ;;
    --remote) REMOTE="$2"; shift ;;
    --only) ONLY+=("$2"); shift ;;
    --scratch) SCRATCH="$2"; shift ;;
    -h|--help) sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

cd "$(git rev-parse --show-toplevel)"
git fetch -q "$REMOTE" || echo "warning: fetch from $REMOTE failed; using local refs" >&2
DATE=$(date +%Y-%m-%d)

selected() {
  [ ${#ONLY[@]} -eq 0 ] && return 0
  local o
  for o in "${ONLY[@]}"; do [ "$o" = "$1" ] && return 0; done
  return 1
}

shell_version() { # <rev>
  git show "$1:apps/web/public/webapp/service-worker.js" 2>/dev/null \
    | sed -n 's/^const SHELL_VERSION = "v\([0-9]*\)";.*/\1/p'
}

checked_out_elsewhere() { # <branch>
  git worktree list --porcelain | grep -qx "branch refs/heads/$1"
}

# Old bases first: a child's base is where it left its parent, which must be
# read before the parent moves.
BASES=()
for entry in "${BRANCHES[@]}"; do
  b=${entry%%:*} p=${entry#*:}
  if git rev-parse -q --verify "refs/heads/$b" >/dev/null; then
    BASES+=("$(git merge-base "$p" "$b")")
  else
    BASES+=("")
  fi
done

NEEDS_HAND=() DONE=() MOVED_OR_CURRENT=(main)
moved_or_current() {
  local m
  for m in "${MOVED_OR_CURRENT[@]}"; do [ "$m" = "$1" ] && return 0; done
  return 1
}

printf '%-24s %-18s %7s %6s %10s  %s\n' BRANCH PARENT BEHIND AHEAD CONFLICTS NOTE
i=0
for entry in "${BRANCHES[@]}"; do
  b=${entry%%:*} p=${entry#*:} base=${BASES[$i]}; i=$((i + 1))
  selected "$b" || continue
  if [ -z "$base" ]; then
    printf '%-24s %-18s %7s %6s %10s  %s\n' "$b" "$p" - - - "no local branch"
    continue
  fi
  read -r behind ahead < <(git rev-list --left-right --count "$p...$b")
  note=""
  # Simulate replaying the branch's own commits (base..b) onto the parent.
  if out=$(git merge-tree --write-tree --name-only --no-messages --merge-base="$base" "$p" "$b" 2>/dev/null); then
    conflicts=0
  else
    conflicts=$(printf '%s\n' "$out" | sed '1d' | sed '/^$/,$d' | grep -c . || true)
  fi
  # Only a branch that set its own shell version must stay above its parent's.
  bv=$(shell_version "$b") pv=$(shell_version "$p") basev=$(shell_version "$base")
  if [ -n "$bv" ] && [ -n "$pv" ] && [ "$bv" != "$basev" ] && [ "$bv" -le "$pv" ]; then
    note="shell v$bv is not above $p's v$pv"
  fi
  printf '%-24s %-18s %7s %6s %10s  %s\n' "$b" "$p" "$behind" "$ahead" "$conflicts" "$note"
  if [ "$conflicts" -gt 0 ]; then
    printf '%s\n' "$out" | sed '1d' | sed '/^$/,$d' | sed 's/^/    conflict: /'
  fi

  [ "$APPLY" = 1 ] || continue
  if [ "$behind" = 0 ] && [ -z "$note" ]; then MOVED_OR_CURRENT+=("$b"); continue; fi
  if [ "$p" != main ] && ! moved_or_current "$p"; then
    NEEDS_HAND+=("$b: parent $p was not brought up to date"); continue
  fi
  if [ "$conflicts" -gt 0 ] || [ -n "$note" ]; then
    NEEDS_HAND+=("$b: ${conflicts} predicted conflict(s)${note:+; $note}"); continue
  fi
  if checked_out_elsewhere "$b"; then
    NEEDS_HAND+=("$b: checked out in a worktree; detach it there and re-run"); continue
  fi

  old=$(git rev-parse "$b")
  slug=${b#feat/}
  backup="backup/$slug-pre-rebase-$DATE"
  git rev-parse -q --verify "refs/heads/$backup" >/dev/null && backup="$backup-$(date +%H%M%S)"
  git branch "$backup" "$old"

  wt="$SCRATCH/rebase-features-${slug//\//-}-$$"
  git worktree add -q --detach "$wt" "$old"
  ok=1
  if ! git -C "$wt" rebase -q --onto "$p" "$base" >/dev/null 2>&1; then
    git -C "$wt" rebase --abort >/dev/null 2>&1 || true
    NEEDS_HAND+=("$b: rebase stopped on a conflict merge-tree didn't predict"); ok=0
  fi
  if [ "$ok" = 1 ] && [ "$TSC" = 1 ]; then
    if ! (cd "$wt" && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx tsc -b >/dev/null 2>&1); then
      NEEDS_HAND+=("$b: rebased cleanly but npm ci / tsc -b failed (tip left at $old)"); ok=0
    fi
  fi
  if [ "$ok" = 1 ]; then
    new=$(git -C "$wt" rev-parse HEAD)
    git update-ref "refs/heads/$b" "$new" "$old"
    MOVED_OR_CURRENT+=("$b")
    msg="$b: $(git rev-parse --short "$old") -> $(git rev-parse --short "$new") (backup $backup)"
    if [ "$PUSH" = 1 ] && git rev-parse -q --verify "refs/remotes/$REMOTE/$b" >/dev/null; then
      if git push -q --force-with-lease="$b:$old" "$REMOTE" "$b"; then msg="$msg, pushed"
      else msg="$msg, PUSH REFUSED (the remote moved)"; fi
    fi
    DONE+=("$msg")
  fi
  git worktree remove --force "$wt"
done

if [ "$APPLY" = 1 ]; then
  echo
  echo "Rebased:"; [ ${#DONE[@]} -eq 0 ] && echo "  (none)" || printf '  %s\n' "${DONE[@]}"
  echo "Needs a person or agent:"; [ ${#NEEDS_HAND[@]} -eq 0 ] && echo "  (none)" || printf '  %s\n' "${NEEDS_HAND[@]}"
fi
