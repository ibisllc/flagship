#!/usr/bin/env bash
# gym-setup-live-env.sh — ONE-COMMAND stand-up of the isolated `gym.` UI-test
# environment (docs/ui-test-gym.md §6.5 / §12-G6; the step-by-step is
# docs/runbooks/gym-test-env.md). It wraps that runbook: generates the gym's OWN
# test-only secrets, creates its D1 + R2, patches the `REPLACE_WITH_…`
# placeholders in apps/com/wrangler.gym.toml, deploys the gym Worker, then (if
# Fly is authed) stands up the gym Fly app + IPs and re-deploys. Idempotent and
# re-runnable: each phase checks state, so a second run resumes where the first
# stopped (e.g. after you `flyctl auth login`).
#
# SAFETY: every command here is scoped to GYM-NAMED resources
# (flagship-{state,iso,iso-temp,backups}-gym, flagship-services-gym, the
# gym.flagshipserver.com custom domains). It NEVER opens the prod wrangler.toml /
# root fly.toml, so prod stays byte-identical. The gym apex is public/knowable;
# isolation is by ZEROING its own DB between runs (§4), not secrecy.
#
# PREREQS (operator hand — see the runbook):
#   - Cloudflare: `wrangler whoami` succeeds on the account owning the two zones.
#   - Fly (for the data plane): `flyctl auth login`. If absent, this script does
#     the Cloudflare half and STOPS with the exact next step.
#   - A SEPARATE test Hetzner project token, the test project's SSH pubkey, and a
#     Zone:DNS:Edit token for flagship.services — supplied via env vars or the
#     interactive prompts (see "owner-supplied secrets" below). Without HCLOUD_TOKEN
#     the gym Worker still deploys; demo-box provisioning just no-ops until it's set.
#
# USAGE:
#   bash scripts/gym-setup-live-env.sh                 # interactive
#   GYM_HCLOUD_TOKEN=… GYM_DNS_TOKEN=… GYM_SSH_PUBKEY="ssh-ed25519 …" \
#     bash scripts/gym-setup-live-env.sh               # non-interactive
#   GYM_SKIP_FLY=1 bash scripts/gym-setup-live-env.sh  # CF half only
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
WRANGLER_CFG="wrangler.gym.toml"                       # relative to apps/com
WRANGLER_CFG_ABS="$REPO/apps/com/wrangler.gym.toml"
FLY_CFG="$REPO/fly.gym.toml"
SECRETS_FILE="$REPO/.gym-secrets.env"                  # gitignored; the gym's test-only secrets
FLY_APP="flagship-services-gym"
D1_NAME="flagship-state-gym"

c_blue=$'\033[1;36m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_green=$'\033[1;32m'; c_off=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$c_blue"  "$c_off" "$*"; }
warn() { printf '%s[!]%s %s\n' "$c_yellow" "$c_off" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$c_green" "$c_off" "$*"; }
die()  { printf '%s[x]%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
wr()   { ( cd "$REPO/apps/com" && npx wrangler "$@" ); }

# ── Phase 0: preflight ───────────────────────────────────────────────────────
log "Phase 0 — preflight"
command -v node >/dev/null || die "node not found"
[ -f "$WRANGLER_CFG_ABS" ] || die "missing $WRANGLER_CFG_ABS (the gym Worker config)"
[ -f "$FLY_CFG" ]          || die "missing $FLY_CFG (the gym Fly config)"
wr whoami >/dev/null 2>&1 || die "wrangler is not authenticated — run 'npx wrangler login' on the account owning flagshipserver.com + flagship.services"
ok "wrangler authenticated; gym configs present"
# The `gym` reserved-username ban is a permanent in-repo invariant — confirm it.
if npx vitest run packages/control-plane/tests/labels.test.ts >/dev/null 2>&1; then
  ok "reserved-username ban green (gym/test/e2e/qa/ci/staging unclaimable)"
else
  warn "could not confirm the reserved-name ban via vitest (continuing — it ships on main)"
fi

# ── Phase 1: the gym's OWN test-only secrets ─────────────────────────────────
# Generated once and cached (gitignored) so re-runs reuse the same values, and
# the Fly side can match SERVICES_HMAC_KEY. NEVER reuse a prod secret.
log "Phase 1 — test-only secrets ($SECRETS_FILE)"
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"; ok "loaded cached gym secrets"
else
  GYM_ADMIN_SECRET="$(openssl rand -hex 32)"
  GYM_DEMO_IRK_KEK="$(openssl rand -hex 32)"
  GYM_SERVICES_HMAC_KEY="$(openssl rand -hex 32)"
  # VAPID (web push) — mint a FRESH pair via the repo helper.
  VAPID_OUT="$(npx tsx "$REPO/scripts/generate-vapid.ts" 2>/dev/null || true)"
  GYM_VAPID_PUBLIC="$(printf '%s' "$VAPID_OUT"  | grep -ioE 'public[^A-Za-z0-9]*[:= ]+[A-Za-z0-9_-]+' | grep -oE '[A-Za-z0-9_-]{20,}' | head -1 || true)"
  GYM_VAPID_PRIVATE_PEM="$(printf '%s' "$VAPID_OUT" | awk '/BEGIN/{f=1} f{print} /END/{f=0}' || true)"
  umask 077
  cat > "$SECRETS_FILE" <<EOF
# Gym test-env secrets — GITIGNORED, test-only, never prod. Generated $(date -u +%FT%TZ 2>/dev/null || echo now).
GYM_ADMIN_SECRET="$GYM_ADMIN_SECRET"
GYM_DEMO_IRK_KEK="$GYM_DEMO_IRK_KEK"
GYM_SERVICES_HMAC_KEY="$GYM_SERVICES_HMAC_KEY"
GYM_VAPID_PUBLIC="$GYM_VAPID_PUBLIC"
GYM_VAPID_PRIVATE_PEM="$(printf '%s' "$GYM_VAPID_PRIVATE_PEM" | tr '\n' '|')"
EOF
  ok "generated + cached gym secrets (admin, DEMO_IRK_KEK, SERVICES_HMAC_KEY, VAPID)"
  [ -n "$GYM_VAPID_PUBLIC" ] || warn "VAPID generation produced no public key — set WEBPUSH_VAPID_* by hand if you exercise push"
fi
# Owner-supplied secrets: env-var → else prompt → else warn+skip.
GYM_HCLOUD_TOKEN="${GYM_HCLOUD_TOKEN:-}"; GYM_DNS_TOKEN="${GYM_DNS_TOKEN:-}"; GYM_SSH_PUBKEY="${GYM_SSH_PUBKEY:-}"
prompt_secret() {
  local var="$1" desc="$2"
  local cur="${!var-}"
  if [ -z "$cur" ] && [ -t 0 ]; then
    read -rsp "    $desc (blank to skip): " cur; echo
    printf -v "$var" '%s' "$cur"
  fi
}
prompt_secret GYM_HCLOUD_TOKEN "test Hetzner project API token (HCLOUD_TOKEN)"
prompt_secret GYM_DNS_TOKEN     "Cloudflare Zone:DNS:Edit token for flagship.services"
prompt_secret GYM_SSH_PUBKEY    "test project SSH PUBLIC key (ssh-ed25519 …)"

# ── Phase 2: Cloudflare — D1 + R2 + placeholders ─────────────────────────────
log "Phase 2 — Cloudflare D1 + R2"
# D1: create iff absent, capture id, patch the placeholder.
if wr d1 info "$D1_NAME" >/dev/null 2>&1; then ok "D1 $D1_NAME exists"; else log "creating D1 $D1_NAME"; wr d1 create "$D1_NAME" || die "d1 create failed"; fi
# `wrangler d1 info` prints the database_id as a bare UUID in an UNLABELED row,
# so match the first UUID anywhere in the output (not a `uuid:`-prefixed line).
D1_ID="$(wr d1 info "$D1_NAME" 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)"
if [ -n "$D1_ID" ] && grep -q 'REPLACE_WITH_flagship-state-gym_DATABASE_ID' "$WRANGLER_CFG_ABS"; then
  sed -i '' "s/REPLACE_WITH_flagship-state-gym_DATABASE_ID/$D1_ID/" "$WRANGLER_CFG_ABS" 2>/dev/null \
    || sed -i "s/REPLACE_WITH_flagship-state-gym_DATABASE_ID/$D1_ID/" "$WRANGLER_CFG_ABS"
  ok "patched D1 id → $WRANGLER_CFG ($D1_ID)  [commit this]"
fi
log "applying migrations to $D1_NAME (idempotent)"
wr d1 migrations apply "$D1_NAME" --config "$WRANGLER_CFG" --remote || warn "migrations apply reported an issue — review above"
# R2: three buckets (ignore 'already exists'); enable temp dev-url; patch the base.
for b in flagship-iso-gym flagship-iso-temp-gym flagship-backups-gym; do
  wr r2 bucket create "$b" >/dev/null 2>&1 && ok "created R2 $b" || ok "R2 $b exists"
done
DEVURL="$(wr r2 bucket dev-url enable flagship-iso-temp-gym 2>/dev/null | grep -oE 'https://pub-[0-9a-f]+\.r2\.dev' | head -1 || true)"
if [ -n "$DEVURL" ] && grep -q 'REPLACE_WITH_GYM_iso-temp_PUBLIC_DEV_URL' "$WRANGLER_CFG_ABS"; then
  sed -i '' "s|REPLACE_WITH_GYM_iso-temp_PUBLIC_DEV_URL|$DEVURL|" "$WRANGLER_CFG_ABS" 2>/dev/null \
    || sed -i "s|REPLACE_WITH_GYM_iso-temp_PUBLIC_DEV_URL|$DEVURL|" "$WRANGLER_CFG_ABS"
  ok "patched temp-bucket public base → $DEVURL  [commit this]"
fi

# ── Phase 3: build + deploy the gym Worker FIRST ─────────────────────────────
# A brand-new Worker must EXIST before `wrangler secret put` can target it, so
# deploy precedes the secret-set (Phase 4). The Worker boots fine without the
# secrets (they're read at request time, not module load), so this ordering is
# safe; secrets land immediately after, no re-deploy needed.
log "Phase 3 — tsc -b + deploy the gym Worker (custom domains self-provision DNS+cert)"
( cd "$REPO" && npx tsc -b ) || die "tsc -b failed — fix before deploying (the Worker bundles the BUILT control-plane dist/)"
wr deploy --config "$WRANGLER_CFG" || die "wrangler deploy failed"
if curl -fsS "https://gym.flagshipserver.com/api/health" >/dev/null 2>&1; then ok "control plane healthy: https://gym.flagshipserver.com/api/health"; else warn "control-plane health not 200 yet (custom-domain cert can take a few minutes)"; fi

# ── Phase 4: secrets onto the (now-existing) gym Worker ──────────────────────
log "Phase 4 — gym Worker secrets"
put_secret() { local name="$1" val="$2"; [ -n "$val" ] || { warn "skip $name (no value supplied)"; return; }; printf '%s' "$val" | wr secret put "$name" --config "$WRANGLER_CFG" >/dev/null 2>&1 && ok "set $name" || warn "could not set $name"; }
put_secret FLAGSHIP_ADMIN_SECRET "$GYM_ADMIN_SECRET"
put_secret DEMO_IRK_KEK          "$GYM_DEMO_IRK_KEK"
put_secret SERVICES_HMAC_KEY     "$GYM_SERVICES_HMAC_KEY"
put_secret HCLOUD_TOKEN          "$GYM_HCLOUD_TOKEN"
put_secret CLOUDFLARE_DNS_API_TOKEN "$GYM_DNS_TOKEN"
put_secret DEMO_PUBLIC_SSH_KEY   "$GYM_SSH_PUBKEY"
[ -n "${GYM_VAPID_PUBLIC:-}" ] && put_secret WEBPUSH_VAPID_PUBLIC_KEY_B64URL "$GYM_VAPID_PUBLIC"
[ -n "${GYM_VAPID_PRIVATE_PEM:-}" ] && put_secret WEBPUSH_VAPID_PRIVATE_KEY_PEM "$(printf '%s' "$GYM_VAPID_PRIVATE_PEM" | tr '|' '\n')"

# ── Phase 5: Fly data plane (gated on auth) ──────────────────────────────────
if [ "${GYM_SKIP_FLY:-}" = "1" ]; then warn "GYM_SKIP_FLY=1 → skipping the Fly data plane"; else
export PATH="$HOME/.fly/bin:$PATH"
if ! command -v flyctl >/dev/null 2>&1 || ! flyctl auth whoami >/dev/null 2>&1; then
  warn "Fly is not authenticated. The Cloudflare half is done."
  cat <<EOF

  NEXT (data plane — needs your hand):
    1) flyctl auth login
    2) re-run:  bash scripts/gym-setup-live-env.sh
       (idempotent — it resumes here and stands up $FLY_APP + IPs, then re-deploys the Worker)
EOF
  exit 0
fi
log "Phase 5 — Fly data plane ($FLY_APP)"
flyctl apps list 2>/dev/null | grep -q "$FLY_APP" && ok "$FLY_APP exists" || { flyctl apps create "$FLY_APP" || die "fly apps create failed"; ok "created $FLY_APP"; }
printf '%s' "$GYM_SERVICES_HMAC_KEY" | flyctl secrets import -a "$FLY_APP" <<<"SERVICES_HMAC_KEY=$GYM_SERVICES_HMAC_KEY" >/dev/null 2>&1 \
  && ok "set SERVICES_HMAC_KEY on $FLY_APP" || warn "could not set SERVICES_HMAC_KEY on Fly (set it by hand to match the Worker)"
flyctl deploy -c "$FLY_CFG" -a "$FLY_APP" --remote-only --strategy=rolling --yes || die "fly deploy failed"
# Allocate anycast IPs iff none yet, then patch the passthrough placeholders.
flyctl ips list -a "$FLY_APP" 2>/dev/null | grep -qE 'v4' || flyctl ips allocate-v4 -a "$FLY_APP" || true
flyctl ips list -a "$FLY_APP" 2>/dev/null | grep -qE 'v6' || flyctl ips allocate-v6 -a "$FLY_APP" || true
IP4="$(flyctl ips list -a "$FLY_APP" 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1 || true)"
IP6="$(flyctl ips list -a "$FLY_APP" 2>/dev/null | grep -oiE '([0-9a-f]{0,4}:){3,}[0-9a-f:]+' | head -1 || true)"
[ -n "$IP4" ] && sed -i '' "s/REPLACE_WITH_GYM_FLY_ANYCAST_IPV4/$IP4/" "$WRANGLER_CFG_ABS" 2>/dev/null || sed -i "s/REPLACE_WITH_GYM_FLY_ANYCAST_IPV4/$IP4/" "$WRANGLER_CFG_ABS" 2>/dev/null || true
[ -n "$IP6" ] && sed -i '' "s|REPLACE_WITH_GYM_FLY_ANYCAST_IPV6|$IP6|" "$WRANGLER_CFG_ABS" 2>/dev/null || sed -i "s|REPLACE_WITH_GYM_FLY_ANYCAST_IPV6|$IP6|" "$WRANGLER_CFG_ABS" 2>/dev/null || true
ok "Fly IPs: v4=$IP4 v6=$IP6  [commit wrangler.gym.toml]"
log "re-deploying the gym Worker so it publishes per-box DNS at the gym Fly IPs"
wr deploy --config "$WRANGLER_CFG" || warn "re-deploy reported an issue"
fi

# ── Phase 6: what's left (manual DNS + smoke) ────────────────────────────────
cat <<EOF

${c_green}Gym control plane is up.${c_off} Remaining manual steps (see docs/runbooks/gym-test-env.md):
  • DNS (one-time, by hand in the flagship.services zone): add a proxied/grey
    A+AAAA for  gym.flagship.services  (and optionally *.gym.flagship.services)
    → the gym Fly anycast IPs above. Per-box <server>.<user>.gym.flagship.services
    A/AAAA + _acme-challenge are published by the Worker at runtime.
  • Smoke the live chain (the gym admin secret is cached in .gym-secrets.env):
      source .gym-secrets.env
      FLAGSHIP_ADMIN_SECRET="\$GYM_ADMIN_SECRET" FLAGSHIP_BASE_URL="https://gym.flagshipserver.com" \\
        node scripts/sample-user.mjs create gymdemo --display "Gym Demo"
      npm run gym -- live            # the live vertical slice (detects the env)
  • Wipe between runs (isolation by zeroing): the gym-DB loop in the runbook
    (names ${D1_NAME}, NEVER prod's flagship-state).
EOF
ok "done"
