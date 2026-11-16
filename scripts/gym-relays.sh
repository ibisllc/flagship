#!/usr/bin/env bash
#
# gym-relays — turn the gym's Fly relays on for a run and off between runs (owner, 2026-11-16: Fly
# bills a started machine for every hour it runs, and the gym needs its relays only while a run goes).
#
#   bash scripts/gym-relays.sh on       start every machine of every gym relay app, wait until started
#   bash scripts/gym-relays.sh off      stop them (refused while the gym lock is held)
#   bash scripts/gym-relays.sh status   print each machine's state and autostart
#
# Both on and off first make sure no service of a machine has autostart on: with it on, any packet to the
# relay's address (internet scanners) starts a stopped machine again within seconds (2026-11-09). The
# fly.gym*.toml files say auto_start_machines = false too, so a deploy keeps it off. A stopped machine
# costs only its root filesystem; the apps keep their secrets, certificates and addresses.
#
# gym-refresh.sh runs `on` before its health check; gym-weekly.sh (cleanup) and gym-release-run.sh
# (exit) run `off`. After a hand-run group (shared-run.ts), run `off` yourself.
#
# Env: GYM_RELAY_APPS     the apps (default "flagship-services-gym flagship-services-gym-b"); only names
#                         starting with flagship-services-gym are accepted, so production can never be hit
#      GYM_RELAYS_DRY_RUN=1  print the flyctl calls instead of making them (also --dry-run)
#      GYM_LOCK_HELD=1    `off` from inside the run that holds the gym lock
#      GYM_RELAYS_SETTLE_SEC  seconds `off` waits before its second look after changing autostart (default 60)
#      FLAGSHIP_GYM_LOCK  the gym lock path (default /private/tmp/claude-501/flagship-locks/gym.lock)

set -euo pipefail
export PATH="$HOME/.fly/bin:$PATH"

APPS="${GYM_RELAY_APPS:-flagship-services-gym flagship-services-gym-b}"
LOCK="${FLAGSHIP_GYM_LOCK:-/private/tmp/claude-501/flagship-locks/gym.lock}"
DRY="${GYM_RELAYS_DRY_RUN:-0}"
CMD=""
for arg in "$@"; do
  case "$arg" in
    on|off|status) CMD="$arg" ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$CMD" ] || { echo "usage: gym-relays.sh on|off|status [--dry-run]" >&2; exit 2; }

for app in $APPS; do
  case "$app" in
    flagship-services-gym|flagship-services-gym-*) ;;
    *) echo "✗ gym-relays: $app is not a gym relay app (names start with flagship-services-gym)" >&2; exit 2 ;;
  esac
done

if [ "$CMD" = off ] && [ -e "$LOCK" ] && [ "${GYM_LOCK_HELD:-0}" != 1 ]; then
  echo "✗ gym-relays: the gym lock is held ($LOCK: $(cat "$LOCK" 2>/dev/null || echo unknown)); not stopping relays under a run" >&2
  exit 4
fi

fly() { if [ "$DRY" = 1 ]; then echo "  DRY-RUN would exec: flyctl $*"; else flyctl "$@"; fi; }

# One line per machine: "<id> <state> <autostart-on: yes|no>".
machines() {
  flyctl machines list -a "$1" --json | node -e '
    const ms = JSON.parse(require("fs").readFileSync(0, "utf8")) || [];
    for (const m of ms) {
      const on = (m.config?.services ?? []).some((s) => s.autostart !== false);
      console.log(`${m.id} ${m.state} ${on ? "yes" : "no"}`);
    }'
}

rc=0 changed=0
pass() {
for app in $APPS; do
  if [ "$DRY" = 1 ]; then
    echo "▸ $app: DRY-RUN would list machines, turn autostart off and $([ "$CMD" = on ] && echo start || echo stop) each machine"
    continue
  fi
  list="$(machines "$app")" || { echo "✗ gym-relays: could not list $app's machines" >&2; rc=1; continue; }
  if [ -z "$list" ]; then
    echo "▸ $app: no machines"
    [ "$CMD" = on ] && { echo "✗ gym-relays: $app has no machine to start (deploy it first)" >&2; rc=1; }
    continue
  fi
  while read -r id state autostart; do
    [ -n "$id" ] || continue
    if [ "$CMD" = status ]; then
      echo "  $app $id $state autostart=$autostart"
      continue
    fi
    if [ "$autostart" = yes ]; then
      # --skip-start: the update leaves the machine stopped; `on` starts it below.
      fly machine update "$id" -a "$app" --autostart=false --skip-start --yes >/dev/null
      echo "  $app $id: autostart off"
      state=stopped changed=1
    fi
    if [ "$CMD" = on ]; then
      if [ "$state" != started ]; then fly machine start "$id" -a "$app" >/dev/null; fi
      fly machine wait "$id" -a "$app" --state started --wait-timeout 2m >/dev/null \
        || { echo "✗ gym-relays: $app $id did not start" >&2; rc=1; continue; }
      echo "  $app $id: started"
    else
      if [ "$state" != stopped ] && [ "$state" != suspended ]; then fly machine stop "$id" -a "$app" >/dev/null; fi
      fly machine wait "$id" -a "$app" --state stopped --wait-timeout 2m >/dev/null \
        || { echo "✗ gym-relays: $app $id did not stop" >&2; rc=1; continue; }
      echo "  $app $id: stopped"
    fi
  done <<< "$list"
done
}
pass
# Fly's proxy takes some seconds to learn a machine's new autostart (2026-11-16: a request 15 s after the
# update still started it), so an `off` that changed it looks again once the proxy has caught up.
if [ "$CMD" = off ] && [ "$changed" = 1 ] && [ "$DRY" != 1 ]; then
  echo "▸ autostart changed: checking again in ${GYM_RELAYS_SETTLE_SEC:-60} s"
  sleep "${GYM_RELAYS_SETTLE_SEC:-60}"
  pass
fi
exit "$rc"
