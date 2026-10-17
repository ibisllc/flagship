#!/usr/bin/env bash
#
# gym-refresh — bring the gym test env up to date before a run. Idempotent;
# run it before every live gym run (gym:weekly runs it as its first phase).
#
#   1. branch   the `gym` branch is `main` + the gym-only seams. Rebase it onto
#               origin/main in a dedicated worktree (its own node_modules) and
#               push it (--force-with-lease). A conflict stops the refresh.
#   2. build    npm ci when the lockfile changed, then tsc -b, in that worktree.
#   3. D1       apply every missing migration to flagship-state-gym and stamp
#               the schema_version ledger the deploy gate reads.
#   4. secrets  every secret name prod's Worker has must exist on the gym
#               Worker (values are the gym's own, from .gym-secrets.env or
#               generated; never copied from prod). Same for the gym Fly app.
#   5. deploy   the gym Worker FROM THE GYM BRANCH through `npm run deploy`
#               (clean build + predeploy gates, pointed at the gym D1), then the
#               gym Fly app, scaled to one machine.
#   6. health   gym.flagshipserver.com and flagship-services-gym answer 200.
#
# Usage: bash scripts/gym-refresh.sh [--no-push] [--skip-fly-deploy] [--skip-deploy] [--dry-run]
#
# Env: GYM_WORKTREE      (default ~/.cache/flagship/gym-worktree)
#      GYM_SECRETS_FILE  (default <main checkout>/.gym-secrets.env)
#      GYM_UPCLOUD_TOKEN_FILE (default ~/.config/flagship/upcloud-token)
#      GYM_BASE_REF      rebase the gym branch onto this ref instead of origin/main (never pushed)
#      GYM_INSTALLER_GIT_REF  the ref new gym boxes clone (a pushed branch; default gym: only that branch
#                         carries the gym trust pin, so a box on main can't check
#                         anything the gym CA signed, e.g. a share's account-key attestation)
#      GYM_REFRESH_DRY_RUN=1  same as --dry-run
#
# Never touches prod: prod is only READ (its secret names, to compare).

set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.fly/bin:$PATH"

GYM_INSTALLER_GIT_REF="${GYM_INSTALLER_GIT_REF:-gym}"
DRY="${GYM_REFRESH_DRY_RUN:-0}"
push=1 fly_deploy=1 deploy=1
for arg in "$@"; do
  case "$arg" in
    --no-push) push=0 ;;
    --skip-fly-deploy) fly_deploy=0 ;;
    --skip-deploy) deploy=0; fly_deploy=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg (see --help)" >&2; exit 2 ;;
  esac
done

WT="${GYM_WORKTREE:-$HOME/.cache/flagship/gym-worktree}"
# GYM_BASE_REF tries the gym on unlanded work (e.g. a feature branch): the gym
# branch is rebased onto it locally and never pushed.
BASE="${GYM_BASE_REF:-origin/main}"
[ "$BASE" = "origin/main" ] || push=0
COMMON_DIR="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$REPO/.git")"
MAIN_CHECKOUT="$(dirname "$COMMON_DIR")"
SECRETS_FILE="${GYM_SECRETS_FILE:-$MAIN_CHECKOUT/.gym-secrets.env}"
UPCLOUD_TOKEN_FILE="${GYM_UPCLOUD_TOKEN_FILE:-$HOME/.config/flagship/upcloud-token}"
FLY_APP="flagship-services-gym"
PROD_FLY_APP="flagship-services"
D1="flagship-state-gym"
CFG="wrangler.gym.toml"
CONTROL_HEALTH="https://gym.flagshipserver.com/api/health"
SERVICES_HEALTH="https://flagship-services-gym.fly.dev:8443/api/health"

# Secrets prod has that the gym deliberately goes without: store pushes, the
# public adapter index, the inference shim (the gym has none), and the
# suspended Hetzner account.
GYM_ONLY_SECRETS="PB_TOKEN_RSA_JWK PB_FILLER_SECRET PB_TAG_SECRET"
NOT_NEEDED_IN_GYM="ADAPTERS_GITHUB_TOKEN APNS_BUNDLE_ID APNS_KEY_ID APNS_PRIVATE_KEY_PEM APNS_TEAM_ID FLAGSHIP_INFERENCE_ENDPOINT HCLOUD_TOKEN"

phase() { echo; echo "──── gym-refresh: $1"; }
say() { echo "  $*"; }
die() { echo "✗ gym-refresh: $*" >&2; exit 1; }
run() { if [ "$DRY" = "1" ]; then echo "  DRY-RUN would exec: $*"; else "$@"; fi; }

if [ "$DRY" != "1" ]; then
  [ -f "$SECRETS_FILE" ] || die "no gym secrets file at $SECRETS_FILE (bash scripts/gym-setup-live-env.sh creates it)"
  set -a
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  set +a
fi

# ── 1. branch ─────────────────────────────────────────────────────────────
phase "1/6 gym branch rebased on $BASE ($WT)"
if [ "$DRY" = "1" ]; then
  say "DRY-RUN would: fetch origin; worktree $WT at origin/gym; rebase onto $BASE if behind; push HEAD:gym --force-with-lease"
else
  git -C "$REPO" fetch -q origin main gym
  if ! git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
    mkdir -p "$(dirname "$WT")"
    git -C "$REPO" worktree add --detach "$WT" origin/gym >/dev/null
    say "created worktree $WT"
  fi
  [ -z "$(git -C "$WT" status --porcelain)" ] || die "$WT has uncommitted changes; commit or discard them first"
  old_gym="$(git -C "$WT" rev-parse origin/gym)"
  git -C "$WT" checkout -q --detach origin/gym
  if git -C "$WT" merge-base --is-ancestor "$BASE" HEAD; then
    say "gym already contains $BASE ($(git -C "$WT" rev-parse --short "$BASE"))"
  else
    say "rebasing gym ($(git -C "$WT" rev-list --count HEAD.."$BASE") commits behind) onto $BASE"
    # A conflict resolved once (anywhere in this repo) is replayed by rerere;
    # the rebase only stops for one nobody has resolved yet.
    rr() { git -C "$WT" -c rerere.enabled=true -c rerere.autoupdate=true "$@"; }
    if ! rr rebase -q "$BASE"; then
      tries=0
      while [ "$tries" -lt 50 ] && [ -d "$(git -C "$WT" rev-parse --path-format=absolute --git-path rebase-merge)" ] && [ -z "$(git -C "$WT" diff --name-only --diff-filter=U)" ]; do
        tries=$((tries + 1))
        say "conflict resolved from rerere; continuing"
        GIT_EDITOR=true rr rebase --continue >/dev/null 2>&1 || true
      done
      if [ -d "$(git -C "$WT" rev-parse --path-format=absolute --git-path rebase-merge)" ]; then
        git -C "$WT" diff --name-only --diff-filter=U | sed 's/^/  unresolved: /'
        git -C "$WT" rebase --abort || true
        die "gym does not rebase cleanly onto main; resolve by hand (docs/runbooks/gym-test-env.md, 'Keeping the gym branch current')"
      fi
    fi
    if [ "$push" = "1" ]; then
      git -C "$WT" push -q --force-with-lease="gym:$old_gym" origin HEAD:gym
      git -C "$REPO" fetch -q origin gym
      say "pushed rebased gym ($(git -C "$WT" rev-parse --short HEAD))"
    else
      say "--no-push: rebased locally only"
    fi
  fi
  git -C "$REPO" branch -f gym "$(git -C "$WT" rev-parse HEAD)" >/dev/null 2>&1 || true
fi

# ── 2. build ──────────────────────────────────────────────────────────────
phase "2/6 install + build in the gym worktree"
if [ "$DRY" = "1" ]; then
  say "DRY-RUN would: npm ci (when package-lock.json changed) && npx tsc -b in $WT"
else
  lock_hash="$(shasum -a 256 "$WT/package-lock.json" | cut -d' ' -f1)"
  if [ "$(cat "$WT/node_modules/.gym-refresh-lock" 2>/dev/null || true)" != "$lock_hash" ]; then
    (cd "$WT" && npm ci --no-audit --no-fund >/dev/null)
    echo "$lock_hash" > "$WT/node_modules/.gym-refresh-lock"
    say "npm ci done"
  fi
  (cd "$WT" && npx tsc -b) || die "tsc -b failed on the gym branch"
  say "tsc -b clean at $(git -C "$WT" rev-parse --short HEAD)"
fi

wr() { (cd "$WT/apps/com" && npx wrangler "$@"); }

# ── 3. D1 ─────────────────────────────────────────────────────────────────
phase "3/6 gym D1 migrations ($D1)"
if [ "$DRY" = "1" ]; then
  say "DRY-RUN would: wrangler d1 migrations apply $D1 --config $CFG --remote; stamp schema_version"
else
  applied=0
  for attempt in 1 2 3; do
    if out="$(wr d1 migrations apply "$D1" --config "$CFG" --remote </dev/null 2>&1)"; then applied=1; break; fi
    say "migrations apply attempt $attempt failed; retrying"
    sleep 10
  done
  if [ "$applied" != 1 ]; then
    echo "$out" | tail -20
    die "migrations apply failed on $D1"
  fi
  echo "$out" | grep -E '✅|No migrations' | sed 's/^/  /' || true
  now_ms="$(($(date +%s) * 1000))"
  values="$(ls "$WT/packages/storage/migrations" | grep -oE '^[0-9]{4}' | sort -u | sed "s/.*/('&', $now_ms)/" | paste -sd, -)"
  wr d1 execute "$D1" --config "$CFG" --remote \
    --command "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES $values" </dev/null >/dev/null
  say "schema_version ledger stamped through $(ls "$WT/packages/storage/migrations" | grep -oE '^[0-9]{4}' | sort | tail -1)"
fi

# ── 4. secrets ────────────────────────────────────────────────────────────
phase "4/6 secrets (gym vs prod, names only)"
secret_names() { wr secret list "$@" 2>/dev/null | grep -oE '"name": *"[^"]+"' | sed -E 's/.*"([^"]+)"$/\1/' | sort -u; }
# Gym value source for each secret a refresh may need to (re)create.
gym_value_var() {
  case "$1" in
    ACCOUNT_READ_TOKEN_SECRET) echo GYM_ACCOUNT_READ_TOKEN_SECRET ;;
    FLAGSHIP_RECOVERY_PROOF_SECRET) echo GYM_RECOVERY_PROOF_SECRET ;;
    FLAGSHIP_TOTP_KEK) echo GYM_TOTP_KEK ;;
    SERVICES_CONTROL_SECRET) echo GYM_SERVICES_CONTROL_SECRET ;;
    USAGE_REPORT_SECRET) echo GYM_USAGE_REPORT_SECRET ;;
    BOOT_NOTIFY_SECRET) echo GYM_BOOT_NOTIFY_SECRET ;;
    FLAGSHIP_INFERENCE_TOKEN_SECRET) echo GYM_INFERENCE_TOKEN_SECRET ;;
    PB_FILLER_SECRET) echo GYM_PB_FILLER_SECRET ;;
    PB_TAG_SECRET) echo GYM_PB_TAG_SECRET ;;
    *) echo "" ;;
  esac
}
ensure_gym_value() {
  local var="$1"
  if [ -z "${!var:-}" ]; then
    printf -v "$var" '%s' "$(openssl rand -hex 32)"
    ( umask 077; printf '%s="%s"\n' "$var" "${!var}" >> "$SECRETS_FILE" )
  fi
}
put_gym_secret() { printf '%s' "$2" | wr secret put "$1" --config "$CFG" >/dev/null 2>&1; }
if [ "$DRY" = "1" ]; then
  say "DRY-RUN would: compare 'wrangler secret list' names (prod vs --config $CFG), set missing gym values, same for Fly"
else
  prod_names="$(secret_names)"
  gym_names="$(secret_names --config "$CFG")"
  [ -n "$prod_names" ] || die "could not list prod secret names (wrangler not authed?)"
  unresolved=()
  for name in $(comm -23 <(echo "$prod_names") <(echo "$gym_names")); do
    case " $NOT_NEEDED_IN_GYM " in *" $name "*) continue ;; esac
    var="$(gym_value_var "$name")"
    if [ -n "$var" ]; then
      ensure_gym_value "$var"
      put_gym_secret "$name" "${!var}" && say "set $name (gym value)" || unresolved+=("$name")
    elif [ "$name" = UPCLOUD_TOKEN ] && [ -r "$UPCLOUD_TOKEN_FILE" ]; then
      put_gym_secret UPCLOUD_TOKEN "$(tr -d '\n' < "$UPCLOUD_TOKEN_FILE")" && say "set UPCLOUD_TOKEN (from $UPCLOUD_TOKEN_FILE)" || unresolved+=("$name")
    elif [ "$name" = WEBPUSH_CONTACT ]; then
      put_gym_secret WEBPUSH_CONTACT "mailto:gym@flagshipserver.com" && say "set WEBPUSH_CONTACT" || unresolved+=("$name")
    elif [ "$name" = WEBPUSH_VAPID_PUBLIC_KEY_B64URL ] && [ -n "${GYM_VAPID_PRIVATE_PEM:-}" ]; then
      if [ -z "${GYM_VAPID_PUBLIC:-}" ]; then
        GYM_VAPID_PUBLIC="$(printf '%s' "$GYM_VAPID_PRIVATE_PEM" | tr '|' '\n' | node -e '
          const { createPrivateKey, createPublicKey } = require("node:crypto");
          const pem = require("node:fs").readFileSync(0, "utf8");
          const jwk = createPublicKey(createPrivateKey(pem)).export({ format: "jwk" });
          const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
          process.stdout.write(raw.toString("base64url"));')"
        ( umask 077; printf 'GYM_VAPID_PUBLIC="%s"\n' "$GYM_VAPID_PUBLIC" >> "$SECRETS_FILE" )
      fi
      put_gym_secret "$name" "$GYM_VAPID_PUBLIC" && say "set $name" || unresolved+=("$name")
    else
      unresolved+=("$name")
    fi
  done
  if [ "${#unresolved[@]}" -gt 0 ]; then
    die "gym Worker lacks secrets prod has and no gym value is known: ${unresolved[*]} (set them with 'wrangler secret put <NAME> --config $CFG', or add them to NOT_NEEDED_IN_GYM with the reason)"
  fi
  say "gym Worker has every secret prod has (except: $NOT_NEEDED_IN_GYM)"
  # Secrets the gym needs whether or not prod has them yet: peer backup's
  # (docs/peer-backup.md §13), so the live peer-backup group can run first.
  for name in $GYM_ONLY_SECRETS; do
    case "$gym_names" in *"$name"*) continue ;; esac
    if [ "$name" = PB_TOKEN_RSA_JWK ]; then
      if [ -z "${GYM_PB_TOKEN_RSA_JWK:-}" ]; then
        GYM_PB_TOKEN_RSA_JWK="$(node -e 'process.stdout.write(JSON.stringify(require("node:crypto").generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({format:"jwk"})))')"
        ( umask 077; printf "GYM_PB_TOKEN_RSA_JWK='%s'\n" "$GYM_PB_TOKEN_RSA_JWK" >> "$SECRETS_FILE" )
      fi
      put_gym_secret PB_TOKEN_RSA_JWK "$GYM_PB_TOKEN_RSA_JWK" && say "set PB_TOKEN_RSA_JWK (gym value)" || die "could not set PB_TOKEN_RSA_JWK"
    else
      var="$(gym_value_var "$name")"
      ensure_gym_value "$var"
      put_gym_secret "$name" "${!var}" && say "set $name (gym value)" || die "could not set $name"
    fi
  done

  fly_names() { flyctl secrets list -a "$1" 2>/dev/null | awk 'NR>1 && $1 ~ /^[A-Z_]+$/ {print $1}' | sort -u; }
  fly_missing="$(comm -23 <(fly_names "$PROD_FLY_APP") <(fly_names "$FLY_APP") || true)"
  staged=0
  for name in $fly_missing; do
    var="$(gym_value_var "$name")"
    [ -n "$var" ] || die "gym Fly app lacks $name and no gym value is known"
    ensure_gym_value "$var"
    printf '%s=%s\n' "$name" "${!var}" | flyctl secrets import --stage -a "$FLY_APP" >/dev/null
    say "staged $name on $FLY_APP"
    staged=1
  done
  if [ "$staged" = "1" ] && [ "$fly_deploy" = "0" ]; then
    flyctl secrets deploy -a "$FLY_APP" >/dev/null && say "deployed staged Fly secrets"
  fi
fi

# ── 5. deploy ─────────────────────────────────────────────────────────────
phase "5/6 deploy the gym Worker (from gym) + the gym Fly app"
if [ "$deploy" = "0" ]; then
  say "--skip-deploy: leaving both deployments as they are"
else
  if [ "$DRY" = "1" ]; then
    say "DRY-RUN would: (cd $WT/apps/com && npm run deploy -- --config $CFG) with the migration gate on $D1"
  else
    if ! out="$(cd "$WT/apps/com" && FLAGSHIP_MIGRATION_CHECK_DB="$D1" FLAGSHIP_MIGRATION_CHECK_CONFIG="$CFG" \
        npm run deploy -- --config "$CFG" ${GYM_INSTALLER_GIT_REF:+--var "DEMO_INSTALLER_GIT_REF:$GYM_INSTALLER_GIT_REF"} 2>&1)"; then
      echo "$out" | tail -30
      die "gym Worker deploy failed"
    fi
    echo "$out" | grep -E 'Current Version ID|migration-check|Uploaded' | sed 's/^/  /' || true
  fi
  if [ "$fly_deploy" = "1" ]; then
    if [ "$DRY" = "1" ]; then
      say "DRY-RUN would: flyctl deploy -c fly.gym.toml -a $FLY_APP --remote-only --strategy=immediate"
    else
      (cd "$WT" && flyctl deploy -c fly.gym.toml -a "$FLY_APP" --remote-only --strategy=immediate --yes 2>&1 | tail -3 | sed 's/^/  /') \
        || die "gym Fly deploy failed"
    fi
  fi
fi
run flyctl scale count 1 -a "$FLY_APP" --yes

# ── 6. health ─────────────────────────────────────────────────────────────
phase "6/6 health"
if [ "$DRY" = "1" ]; then
  say "DRY-RUN would poll: $CONTROL_HEALTH and $SERVICES_HEALTH → 200"
  echo "✓ gym-refresh DRY-RUN OK"
  exit 0
fi
wait_200() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 10 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 10
  done
  return 1
}
wait_200 "$CONTROL_HEALTH" || die "gym control plane not healthy: $CONTROL_HEALTH"
say "control plane 200"
wait_200 "$SERVICES_HEALTH" || die "gym data plane not healthy: $SERVICES_HEALTH"
say "data plane 200"
echo "✓ gym-refresh OK — gym $(git -C "$WT" rev-parse --short HEAD) on main $(git -C "$REPO" rev-parse --short "$BASE")"
