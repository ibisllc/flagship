#!/usr/bin/env bash
# The Rust relay's rollout (release plan G7 / R7, docs/architecture-v2/relay-transport.md §8): local conformance, then
# the gym as the canary with a mixed-version fleet and a rollback drill, then prod with a rollback that changes no box.
#
#   bash scripts/relay-canary.sh local              # cargo test + the two-implementation conformance suite (no cloud)
#   bash scripts/relay-canary.sh gym                # PRINTS the gym canary steps; add --run to run them (deploys the GYM relay)
#   bash scripts/relay-canary.sh prod               # PRINTS the prod canary and rollback commands; never runs them
#
# Nothing here deploys unless `gym --run` is given by the operator. Prod is printed only: the owner runs it from main.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
what="${1:-}"
run=0
[ "${2:-}" = "--run" ] && run=1
GYM_APP="flagship-services-gym"
GYM_HOST="$GYM_APP.fly.dev"
PROD_APP="flagship-services"

step() {
  echo
  echo "── $1"
  shift
  echo "   \$ $*"
  if [ "$run" = 1 ]; then
    read -r -p "   run it? [y/N] " a
    [ "$a" = y ] || { echo "   skipped"; return 0; }
    "$@"
  fi
}

case "$what" in
  local)
    export PATH="/opt/homebrew/opt/rustup/bin:$PATH" CARGO_INCREMENTAL=0
    # The test-only `conformance` feature lets S18 fake a provider's public address; the release image never enables it.
    (cd rust && cargo test -p flagship-relay && cargo build -p flagship-relay --bin flagship-relay --features conformance)
    npx vitest run tools/relay-conformance
    ;;
  gym)
    echo "Gym canary of the Rust relay. The gym is the canary: its relay app switches image, its boxes do not change."
    echo "Precondition: 'bash scripts/relay-canary.sh local' is green on the commit gym-refresh deploys."
    step "1. Deploy the gym relay from the Rust image (fly.gym.relay.toml; same app, ports, env and secrets)" \
      env GYM_RELAY=rust bash scripts/gym-refresh.sh
    step "2. Check which relay answers, the :8444 echo" \
      npx tsx tools/relay-conformance/live-check.ts --relay "$GYM_HOST" --expect rust
    step "3. Mixed fleet on the Rust relay: B3 runs main's daemon (the old box), the rest this release; keep the fleet up" \
      npx tsx tools/live-e2e/shared-run.ts --groups core,gating,enforcement,one-list,serving,backups,ai-chat,update --keep
    echo "   The run prints: --reuse gym-results/<run>/fleet.json. Set FLEET to that path for steps 4-7."
    FLEET="${FLEET:-gym-results/<run>/fleet.json}"
    step "4. Rollback drill: the Node image again, rolling, with every box still connected" \
      flyctl deploy -c fly.gym.toml -a "$GYM_APP" --remote-only --strategy=rolling --yes
    step "5. Every box reconnected to the TS hub by itself (no box change)" \
      npx tsx tools/relay-conformance/live-check.ts --relay "$GYM_HOST" --expect ts --fleet "$FLEET"
    step "6. Forward again to the Rust image and re-check the same fleet" \
      flyctl deploy -c fly.gym.relay.toml -a "$GYM_APP" --remote-only --strategy=rolling --yes
    step "6b." npx tsx tools/relay-conformance/live-check.ts --relay "$GYM_HOST" --expect rust --fleet "$FLEET"
    step "7. Core group again on the kept fleet, then tear it down" \
      npx tsx tools/live-e2e/shared-run.ts --groups core --reuse "$FLEET"
    step "7b." npx tsx tools/live-e2e/shared-run.ts --teardown --reuse "$FLEET"
    ;;
  prod)
    cat <<EOF
Prod canary (owner, from a clean main checkout, after the gym canary passed; never --strategy=immediate):

  export PATH="\$HOME/.fly/bin:\$PATH"
  flyctl deploy -c fly.relay.toml -a $PROD_APP --remote-only --strategy=rolling --yes
  npx tsx tools/relay-conformance/live-check.ts --relay $PROD_APP.fly.dev --expect rust
  npm run ops -- services          # tunnels online back to the pre-deploy count, no missed redirections
  bash scripts/release.sh --list   # the relay-echo step: run it (the phones drop an address whose echo is wrong)

Watch for 30 minutes: tunnelsOnline, router.bad / holdTimeouts in /api/stats, box heartbeats in npm run ops -- health.

Rollback (no box change; boxes redial the same address and land on the Node hub):

  flyctl deploy -a $PROD_APP --remote-only --strategy=rolling --yes          # the default fly.toml + Dockerfile
  npx tsx tools/relay-conformance/live-check.ts --relay $PROD_APP.fly.dev --expect ts
EOF
    ;;
  *)
    sed -n '2,10p' "$0"
    exit 2
    ;;
esac
