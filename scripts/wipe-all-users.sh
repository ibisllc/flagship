#!/usr/bin/env bash
# Tolerant prod user-wipe runner — GUARDED, with a KEEP LIST.
#
# WHY THIS EXISTS: prod D1's schema drifts from the repo's migration files
# (migrations are applied to prod by hand, ad hoc — not every numbered
# migration is necessarily live). The companion .sql run via
# `wrangler d1 execute --file` is ONE transaction, so the first
# `DELETE FROM <table-not-in-prod>` aborts the whole wipe and nothing is
# deleted. This runner deletes each table INDEPENDENTLY, so a table that
# isn't in prod is SKIPPED instead of fatal — the wipe adapts to whatever
# prod actually has.
#
# The table list is sourced from the canonical .sql so there is one source of
# truth. PRESERVES marketplace_listings (catalog) + CF/SQLite internals.
#
# ── WHAT SURVIVES (the KEEP LIST) ──────────────────────────────────────────────
# Demo / evaluation accounts remain available as a FEATURE: the ability to
# create them through the demo flow is untouched by this script. The existing
# pre-GA demo sample users CAN be wiped: they are NOT kept unless named. Only
# the keep list survives, and nothing here can wipe "everything": the keep
# list is never empty.
#   * Default keep: playstore-test-0725, the shared App Store / Google Play
#     review login (never tear it down while a review is open).
#     WIPE_KEEP_DEFAULT=0 drops it from the list (only once the reviews are
#     over, and only if at least one other name is kept).
#   * Add names with WIPE_KEEP=a,b,c  and/or  --keep a,b,c  and/or a file with
#     one username per line (# starts a comment): --keep-file PATH or
#     WIPE_KEEP_FILE=PATH. A named file that is unreadable or holds no names,
#     or a WIPE_KEEP that is set but blank, REFUSES (fail closed).
#   * A kept account is kept WHOLE. Every table keeps that account's rows, by
#     the key the table really uses: username/account columns, the account's
#     servers (server_domain, pod_canonical), order serials, the account's and
#     its devices' public keys, the invite/share/backup rows hanging off those.
#     Rows of every other account go. Tables with no account in them are
#     wiped (W) or kept whole (K); the preview names each table's scope.
#   * A kept name that does not exist is a typo: a name you typed REFUSES the
#     run when it is not found; only the built-in default may be absent.
#
# ── GUARDS (AGENTS.md → "GA close-out" item 1) ────────────────────────────────
# This script can delete every user + server except the keep list in one
# command. It cannot be pointed at a database by default or by accident:
#   1. WIPE_ENV and WIPE_D1 are REQUIRED. Nothing defaults to prod.
#   2. The pair must be consistent: env "prod" is the PROD database
#      (flagship-state) and nothing else; any other env must name its own D1.
#   3. A per-table PREVIEW (rows to delete / rows to keep, read-only queries)
#      runs first. Without --yes the script STOPS there: that is a dry run and
#      the normal way to look before you leap.
#   4. --yes plus WIPE_CONFIRM equal to WIPE_ENV is needed to delete.
#   5. A PROD wipe additionally needs a human at a terminal: stdin must be a
#      TTY and the operator must TYPE the database name. No env var can answer
#      that prompt, so CI, agents and pipes can never wipe prod.
# An audit line (timestamp · env · D1 · operator · rows) is printed before the
# delete and after it completes, followed by a re-count that proves every
# table now holds only kept rows. scripts/release-guard.sh fails (always, dev
# too) if any of these guards is removed.
#
# Usage:
#   # dry run (preview only, writes NOTHING; the default):
#   WIPE_ENV=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh
#   # + the accounts that would go / stay (read-only):
#   WIPE_ENV=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh --list-accounts
#   # keep more accounts:
#   WIPE_KEEP=harry-main,qa-two ... bash scripts/wipe-all-users.sh
#   ... bash scripts/wipe-all-users.sh --keep-file ~/keep-accounts.txt
#   # wipe the gym DB:
#   WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1=flagship-state-gym \
#       WIPE_WRANGLER_CONFIG=wrangler.gym.toml bash scripts/wipe-all-users.sh --yes
#   # wipe PROD (owner at a terminal; you will be asked to type "flagship-state"):
#   WIPE_ENV=prod WIPE_D1=flagship-state WIPE_CONFIRM=prod \
#       bash scripts/wipe-all-users.sh --yes
#   Full owner procedure: docs/runbooks/pre-ga-scrub.md
#
# Env:
#   WIPE_ENV      target env name (required); WIPE_CONFIRM must match it.
#   WIPE_CONFIRM  must equal WIPE_ENV to authorize a real delete.
#   WIPE_D1       wrangler D1 binding/name (required; prod is "flagship-state").
#   WIPE_WRANGLER_CONFIG  optional wrangler --config path (e.g.
#                 wrangler.gym.toml, relative to apps/com). Unset = prod
#                 behavior unchanged (apps/com/wrangler.toml).
#   WIPE_KEEP / WIPE_KEEP_FILE / WIPE_KEEP_DEFAULT  the keep list (above).
#   WIPE_LOCAL    1 = run against wrangler's LOCAL D1 (--local) instead of the
#                 remote one; refused for WIPE_ENV=prod. WIPE_LOCAL_PERSIST is
#                 the optional --persist-to directory (no spaces).
# Credential: a shell already authenticated to Cloudflare / wrangler with
# access to the D1 database (wrangler login, or CLOUDFLARE_API_TOKEN with D1
# edit rights; a dry run only reads). It does not use FLAGSHIP_ADMIN_SECRET.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
sql="$here/wipe-all-users-prerelease-2026-06-02.sql"
com_dir="$here/../apps/com"

for arg in "$@"; do
  case "$arg" in -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d'; exit 0 ;; esac
done

PROD_D1="flagship-state"
DEFAULT_KEEP="playstore-test-0725"
target_env="${WIPE_ENV:-}"
d1="${WIPE_D1:-}"
wr_config="${WIPE_WRANGLER_CONFIG:-}"

# GUARD 1: nothing defaults to prod.
if [ -z "$target_env" ] || [ -z "$d1" ]; then
  echo "REFUSING TO RUN: WIPE_ENV and WIPE_D1 are both required (no default target)." >&2
  echo "  e.g. WIPE_ENV=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh" >&2
  exit 1
fi

# GUARD 2: env and database must agree. A non-prod env may NEVER point at the
# prod D1, and "prod" may never point at anything else (so a typo'd WIPE_ENV
# can't borrow prod's weaker-looking path).
if [ "$target_env" != "prod" ] && [ "$d1" = "$PROD_D1" ]; then
  echo "REFUSING TO WIPE: WIPE_ENV='$target_env' but WIPE_D1 is the PROD database ($PROD_D1)." >&2
  echo "A non-prod wipe must name its own D1, e.g.:" >&2
  echo "  WIPE_ENV=gym WIPE_CONFIRM=gym WIPE_D1=flagship-state-gym bash scripts/wipe-all-users.sh --yes" >&2
  exit 1
fi
if [ "$target_env" = "prod" ] && [ "$d1" != "$PROD_D1" ]; then
  echo "REFUSING TO WIPE: WIPE_ENV=prod must name the prod database WIPE_D1=$PROD_D1 (got '$d1')." >&2
  exit 1
fi

# Local D1 is for rehearsals; it can never be combined with the prod env.
mode="--remote"
if [ "${WIPE_LOCAL:-}" = "1" ]; then
  if [ "$target_env" = "prod" ]; then
    echo "REFUSING TO RUN: WIPE_LOCAL=1 is for rehearsals and cannot be combined with WIPE_ENV=prod." >&2
    exit 1
  fi
  mode="--local"
  if [ -n "${WIPE_LOCAL_PERSIST:-}" ]; then
    case "$WIPE_LOCAL_PERSIST" in
      *[[:space:]]*) echo "WIPE_LOCAL_PERSIST must not contain whitespace" >&2; exit 2 ;;
    esac
    mode="--local --persist-to $WIPE_LOCAL_PERSIST"
  fi
fi

# --yes (or --force) is the only way past the dry-run preview.
proceed=0
list_accounts=0
keep_file="${WIPE_KEEP_FILE:-}"
keep_arg=""
keep_arg_set=0
args=("$@")
i=0
while [ "$i" -lt "${#args[@]}" ]; do
  arg="${args[$i]}"
  case "$arg" in
    --yes|--force) proceed=1 ;;
    --dry-run) proceed=0 ;;
    --list-accounts) list_accounts=1 ;;
    --keep-file)
      i=$((i + 1))
      if [ "$i" -ge "${#args[@]}" ]; then echo "--keep-file needs a path" >&2; exit 2; fi
      keep_file="${args[$i]}" ;;
    --keep-file=*) keep_file="${arg#--keep-file=}" ;;
    --keep)
      i=$((i + 1))
      if [ "$i" -ge "${#args[@]}" ]; then echo "--keep needs a name list" >&2; exit 2; fi
      keep_arg="${keep_arg:+$keep_arg,}${args[$i]}"; keep_arg_set=1 ;;
    --keep=*) keep_arg="${keep_arg:+$keep_arg,}${arg#--keep=}"; keep_arg_set=1 ;;
    *)
      echo "unknown argument: $arg (try --yes, --dry-run, --list-accounts, --keep, --keep-file, --help)" >&2; exit 2 ;;
  esac
  i=$((i + 1))
done

# ── The keep list ──────────────────────────────────────────────────────────────
# Names are lowercased and must look like a username (letters, digits, dashes):
# they are spliced into SQL, so anything else is refused outright.
keep_all=""      # every kept name, one per line
keep_named=""    # the names an operator typed (not the built-in default)
add_keep() {     # add_keep <name> <named|default>
  local n
  n="$(printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -d '[:space:]')"
  [ -z "$n" ] && return 0
  if ! printf '%s' "$n" | grep -qE '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'; then
    echo "REFUSING TO RUN: '$1' is not a valid username for the keep list." >&2
    exit 1
  fi
  keep_all="$keep_all$n"$'\n'
  if [ "$2" = "named" ]; then keep_named="$keep_named$n"$'\n'; fi
}
add_keep_list() { # add_keep_list <comma/space separated> <named|default>
  local item
  for item in $(printf '%s' "$1" | tr ',' ' '); do add_keep "$item" "$2"; done
}

if [ "${WIPE_KEEP_DEFAULT:-1}" != "0" ]; then add_keep "$DEFAULT_KEEP" default; fi

if [ "${WIPE_KEEP+set}" = "set" ]; then
  if ! printf '%s' "${WIPE_KEEP}" | grep -qE '[A-Za-z0-9]'; then
    echo "REFUSING TO RUN: WIPE_KEEP is set but names nobody. Unset it or list usernames." >&2
    exit 1
  fi
  add_keep_list "$WIPE_KEEP" named
fi
if [ "$keep_arg_set" -eq 1 ]; then
  if ! printf '%s' "$keep_arg" | grep -qE '[A-Za-z0-9]'; then
    echo "REFUSING TO RUN: --keep names nobody." >&2
    exit 1
  fi
  add_keep_list "$keep_arg" named
fi
if [ -n "$keep_file" ]; then
  if [ ! -f "$keep_file" ] || [ ! -r "$keep_file" ]; then
    echo "REFUSING TO RUN: keep file '$keep_file' is missing or unreadable (an unreadable list never means wipe everything)." >&2
    exit 1
  fi
  file_names=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    file_names="$file_names $line"
  done < "$keep_file"
  if ! printf '%s' "$file_names" | grep -qE '[A-Za-z0-9]'; then
    echo "REFUSING TO RUN: keep file '$keep_file' names nobody (an empty list never means wipe everything)." >&2
    exit 1
  fi
  add_keep_list "$file_names" named
fi

keep_all="$(printf '%s' "$keep_all" | grep . | sort -u)"
keep_named="$(printf '%s' "$keep_named" | grep . | sort -u)"
if [ -z "$keep_all" ]; then
  echo "REFUSING TO RUN: the keep list is empty. This script always keeps at least one account." >&2
  exit 1
fi

# 'a','b' for SQL, and the salted username hashes user_identity_records is keyed by.
K=""
KHASH=""
sha256_hex() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else sha256sum | cut -d' ' -f1; fi
}
for n in $keep_all; do
  K="${K:+$K,}'$n'"
  h="$(printf '%s' "flagship/userIdHash/v1|$n|flagship.v1" | sha256_hex)"
  KHASH="${KHASH:+$KHASH,}'$h'"
done

# ── Which rows of each table belong to a kept account ──────────────────────────
# A table's KEEP predicate is true for the rows that survive. @W wipes the
# whole table (no account in it); @K keeps it whole (no account in it, and
# deleting it would weaken a kept account's protections). The sets below are
# built from the KEPT accounts' own rows, which are never deleted, so the order
# the tables are processed in does not matter.
KSERV="SELECT lower(server_domain) FROM servers WHERE lower(username) IN ($K) UNION SELECT lower(server_domain) FROM auth_codes WHERE lower(username) IN ($K) UNION SELECT lower(subdomain) FROM routing WHERE lower(username) IN ($K) UNION SELECT lower(active_server_fqdn) FROM demo_users WHERE lower(username) IN ($K) AND active_server_fqdn IS NOT NULL"
KSERIAL="SELECT lower(serial) FROM auth_codes WHERE lower(username) IN ($K)"
KKEYS="SELECT lower(irk_pub_hex) FROM usernames WHERE lower(username) IN ($K) UNION SELECT lower(aid_pub_hex) FROM usernames WHERE lower(username) IN ($K) AND aid_pub_hex IS NOT NULL UNION SELECT lower(admin_root_pub_hex) FROM usernames WHERE lower(username) IN ($K) AND admin_root_pub_hex IS NOT NULL UNION SELECT lower(device_pub_hex) FROM device_identities WHERE lower(account_id) IN ($K) UNION SELECT lower(old_admin_root_pub_hex) FROM admin_root_rotations WHERE lower(username) IN ($K) UNION SELECT lower(new_admin_root_pub_hex) FROM admin_root_rotations WHERE lower(username) IN ($K)"
KINV="SELECT invite_id FROM service_invites WHERE lower(author_aid) IN ($KKEYS) OR lower(creator_pub_hex) IN ($KKEYS)"
KSHARE="SELECT share_id FROM server_shares WHERE lower(owner_username) IN ($K) OR lower(server_domain) IN ($KSERV)"
KPIK="SELECT pik_pub_hex FROM pb_holders WHERE lower(username) IN ($K) OR lower(server_domain) IN ($KSERV)"

u()   { printf 'lower(%s) IN (%s)' "$1" "$K"; }
srv() { printf 'lower(%s) IN (%s)' "$1" "$KSERV"; }

pred_of() {
  case "$1" in
    # Identity + naming
    usernames)                  u username ;;
    usernames_aliases)          printf '%s OR %s' "$(u old_username)" "$(u new_username)" ;;
    user_identity_records)      printf 'username_hash IN (%s)' "$KHASH" ;;
    name_claims|service_aliases|user_service_aliases|voici_links)
                                u username ;;
    username_offer)             u name ;;
    username_suggest_throttle)  echo "@W" ;;
    # Servers + routing + registration
    servers|auth_codes|routing|server_orders)
                                u username ;;
    box_serials)                printf 'lower(stk_pub_hex) IN (SELECT lower(identity_pubkey_hex) FROM servers WHERE %s) OR lower(serial) IN (%s)' "$(u username)" "$KSERIAL" ;;
    daemon_status|server_health) srv server_domain ;;
    provision_status)           printf 'lower(serial) IN (%s) OR %s' "$KSERIAL" "$(srv server_domain)" ;;
    install_events)             printf 'lower(serial) IN (%s)' "$KSERIAL" ;;
    install_policy_fanout)      printf '%s OR %s' "$(u username)" "$(srv server_domain)" ;;
    custom_domain_orders)       printf '%s OR %s' "$(u user_id)" "$(srv pod_canonical)" ;;
    nfc_rendezvous)             echo "@W" ;;
    service_invites)            printf 'lower(author_aid) IN (%s) OR lower(creator_pub_hex) IN (%s)' "$KKEYS" "$KKEYS" ;;
    service_invite_bindings)    printf 'invite_id IN (%s)' "$KINV" ;;
    server_shares)              printf '%s OR %s' "$(u owner_username)" "$(srv server_domain)" ;;
    server_share_unlocks|server_share_push)
                                printf 'share_id IN (%s) OR %s' "$KSHARE" "$(srv server_domain)" ;;
    share_inbox)                echo "@K" ;;
    server_transfers)           printf '%s OR %s OR %s' "$(srv server_domain)" "$(u giver_username)" "$(u acquirer_username)" ;;
    server_evictions)           srv pod_canonical ;;
    server_migrations)          printf '%s OR %s OR %s' "$(u username)" "$(srv server_domain)" "$(srv new_server_domain)" ;;
    peer_backup_manifests|pb_roots|pb_holders)
                                printf '%s OR %s' "$(u username)" "$(srv server_domain)" ;;
    pb_leases|pb_token_serials) printf 'pik_pub_hex IN (%s)' "$KPIK" ;;
    pb_token_issue)             srv server_domain ;;
    # Cert authority + mint
    acme_account_key_grants|mint_reservations|entitlement_revocation_lists)
                                u username ;;
    acme_account_key_delivery)  srv server_domain ;;
    # Boot-unlock + sealed key material
    box_sealed_leases|auto_unlock_leases|unlock_key_deposits|pending_unlock_approvals|sealed_luks_keys)
                                srv server_domain ;;
    secret_mailbox)             printf '%s OR %s' "$(u username)" "$(srv server_domain)" ;;
    boot_nonces)                echo "@K" ;;
    # Recovery + re-pair + peer backup
    webauthn_recovery_records|recovery_shards|pending_re_pairs|trust_exceptions|admin_root_rotations)
                                u username ;;
    # Devices + delegation + push
    device_capability_grants|push_tokens|watch_delegates)
                                u username ;;
    device_identities|device_self_profiles|device_managed_profiles|account_directory_key_grants|account_profiles)
                                u account_id ;;
    # Demo sandbox
    demo_users|demo_llm_ledger) u username ;;
    # Marketplace installs
    marketplace_installs)       printf '%s OR lower(puller_irk_pub_hex) IN (%s)' "$(u creator)" "$KKEYS" ;;
    # Billing / tiers / promos
    tier_subscriptions|hardware_orders|llm_promo_issues|llm_promo_lifetime|llm_promo_usage|usage_counters|app_purchases)
                                u username ;;
    meter_counters)             u account ;;
    meter_batches|stripe_events) echo "@K" ;;
    vouchers)                   u redeemed_by ;;
    # Audit + telemetry
    audit_events|ct_alerts)     u username ;;
    qr_pipe_metrics)            echo "@W" ;;
    *)                          echo "@MISSING" ;;
  esac
}

# Pull the table names out of the canonical .sql (no spaces in table names, so
# plain word-splitting is safe + portable to macOS bash 3.2).
tables="$(grep -oiE 'DELETE FROM [a-z_]+' "$sql" | sed -E 's/DELETE FROM //I' | sort -u)"
if [ -z "$tables" ]; then
  echo "ERROR: no DELETE targets parsed from $sql — refusing to run" >&2
  exit 1
fi
# Work each table's rule out once (P_<table>); the loops below only read it.
for t in $tables; do
  p="$(pred_of "$t")"
  if [ "$p" = "@MISSING" ]; then
    echo "REFUSING TO RUN: table '$t' is in the wipe list but this script has no rule for which of its rows a kept account owns." >&2
    exit 1
  fi
  printf -v "P_$t" '%s' "$p"
done

cd "$com_dir"

d1x() { # d1x <wrangler d1 execute args...>
  # shellcheck disable=SC2086
  npx wrangler d1 execute "$d1" ${wr_config:+--config "$wr_config"} $mode "$@" </dev/null
}

RE_N='"n"[[:space:]]*:[[:space:]]*([0-9]+)'
RE_K='"k"[[:space:]]*:[[:space:]]*([0-9]+)'

# Per table: sets cnt_total, cnt_keep and cnt_status (ok | absent | error).
count_table() {
  local t="$1" v="P_$1" p out q
  p="${!v}"
  case "$p" in
    @W) q="SELECT count(*) AS n, 0 AS k FROM $t;" ;;
    @K) q="SELECT count(*) AS n, count(*) AS k FROM $t;" ;;
    *)  q="SELECT count(*) AS n, COALESCE(SUM(CASE WHEN COALESCE(($p),0) <> 0 THEN 1 ELSE 0 END),0) AS k FROM $t;" ;;
  esac
  cnt_total=0; cnt_keep=0
  if out="$(d1x --command "$q" --json 2>/dev/null)"; then
    if [[ $out =~ $RE_N ]]; then cnt_total="${BASH_REMATCH[1]}"; fi
    if [[ $out =~ $RE_K ]]; then cnt_keep="${BASH_REMATCH[1]}"; fi
    cnt_status="ok"; return 0
  fi
  # The scoped query failed: is the table itself missing, or the predicate?
  if d1x --command "SELECT count(*) AS n FROM $t;" --json >/dev/null 2>&1; then
    cnt_status="error"
  else
    cnt_status="absent"
  fi
}

scope_label() {
  local v="P_$1"
  case "${!v}" in
    @W) echo "wipe all" ;;
    @K) echo "keep all" ;;
    *)  echo "by account" ;;
  esac
}

preview() { # preview <heading>
  local t total=0 keep=0 del=0 present=0 absent=0 errors=0
  echo "── $1 ──────────────────────────────────────────────"
  echo "  target env : $target_env     D1: $d1"
  echo "  tables     : $(printf '%s\n' "$tables" | grep -c .)"
  echo "  preserves  : marketplace_listings + other tables named in the .sql PRESERVED-TABLES line + CF/SQLite internals"
  echo "  keep list  : $(printf '%s' "$keep_all" | tr '\n' ' ')"
  echo
  printf '  %-34s %-11s %8s %8s %8s\n' "table" "scope" "total" "keep" "delete"
  for t in $tables; do
    count_table "$t"
    case "$cnt_status" in
      absent)
        printf '  %-34s %-11s %s\n' "$t" "$(scope_label "$t")" "absent in this database"; absent=$((absent + 1)) ;;
      error)
        printf '  %-34s %-11s %s\n' "$t" "$(scope_label "$t")" "ERROR: could not scope (schema drift?)"; errors=$((errors + 1)) ;;
      *)
        printf '  %-34s %-11s %8s %8s %8s\n' "$t" "$(scope_label "$t")" "$cnt_total" "$cnt_keep" "$((cnt_total - cnt_keep))"
        present=$((present + 1)); total=$((total + cnt_total)); keep=$((keep + cnt_keep)); del=$((del + cnt_total - cnt_keep)) ;;
    esac
  done
  echo
  echo "  → would delete ~$del row(s), keep $keep, across $present table(s) ($absent absent, $errors unscoped)"
  preview_deleted="$del"; preview_errors="$errors"
}

# The kept accounts that really exist. A name the operator typed that is not
# there is almost certainly a typo, so it stops the run; the built-in default
# may be absent (a gym or a fresh database has no review account).
found_raw=""
if ! found_raw="$(d1x --command "SELECT lower(username) AS username FROM usernames WHERE lower(username) IN ($K);" --json 2>/dev/null)"; then
  echo "REFUSING TO RUN: could not read the usernames table to check the keep list." >&2
  exit 1
fi
found_names="$(printf '%s' "$found_raw" | grep -oE '"username"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
missing_named=""
echo "── keep list ─────────────────────────────────────────────────"
for n in $keep_all; do
  if printf '%s\n' "$found_names" | grep -qx "$n"; then
    echo "  keep     $n"
  elif printf '%s\n' "$keep_named" | grep -qx "$n"; then
    echo "  MISSING  $n   (named by you, but no such account in $d1)"
    missing_named="$missing_named $n"
  else
    echo "  absent   $n   (built-in default; nothing to keep in this database)"
  fi
done
echo
if [ -n "$missing_named" ]; then
  echo "REFUSING TO RUN: these kept names do not exist:$missing_named. Fix the keep list (typo?)." >&2
  exit 1
fi

if [ "$list_accounts" -eq 1 ]; then
  echo "── accounts (read-only) ──────────────────────────────────────"
  if acc_raw="$(d1x --command "SELECT username || '|' || COALESCE(is_demo,0) || '|' || COALESCE(account_type,'') || '|' || claimed_at AS r FROM usernames ORDER BY claimed_at;" --json 2>/dev/null)"; then
    printf '  %-8s %-28s %-5s %-12s %s\n' "verdict" "username" "demo" "type" "claimed_at(ms)"
    printf '%s' "$acc_raw" | grep -oE '"r"[[:space:]]*:[[:space:]]*"[^"]*"' | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/' |
    while IFS='|' read -r un demo typ at; do
      if printf '%s\n' "$keep_all" | grep -qx "$(printf '%s' "$un" | tr 'A-Z' 'a-z')"; then v="KEEP"; else v="delete"; fi
      printf '  %-8s %-28s %-5s %-12s %s\n' "$v" "$un" "$demo" "$typ" "$at"
    done
  else
    echo "  (could not read the usernames table)"
  fi
  echo
fi

preview "wipe preview"

if [ "$preview_errors" -ne 0 ]; then
  echo >&2
  echo "REFUSING TO WIPE: $preview_errors table(s) could not be scoped to the keep list (column missing in this database?)." >&2
  echo "Apply the pending migrations or fix the rule before a real run; a table left unscoped would be half-wiped." >&2
  exit 1
fi

# Gate 1 + 2 + 3: require --yes AND a matching WIPE_CONFIRM token.
if [ "$proceed" -ne 1 ]; then
  echo
  echo "DRY RUN — nothing deleted, nothing written. To really wipe:"
  echo "  WIPE_ENV=$target_env WIPE_D1=$d1 WIPE_CONFIRM=$target_env bash scripts/wipe-all-users.sh --yes"
  exit 0
fi
total="$preview_deleted"

confirm="${WIPE_CONFIRM:-}"
if [ "$confirm" != "$target_env" ]; then
  echo >&2
  echo "REFUSING TO WIPE: WIPE_CONFIRM must equal the target env." >&2
  echo "  target env   : $target_env" >&2
  echo "  WIPE_CONFIRM : '${confirm:-<unset>}'" >&2
  echo "Re-run with:  WIPE_ENV=$target_env WIPE_D1=$d1 WIPE_CONFIRM=$target_env bash scripts/wipe-all-users.sh --yes" >&2
  exit 1
fi

# GUARD 5: production needs a person at a terminal typing the database name.
if [ "$target_env" = "prod" ]; then
  if [ ! -t 0 ]; then
    echo >&2
    echo "REFUSING TO WIPE PRODUCTION: stdin is not a terminal. A prod wipe needs a person" >&2
    echo "typing the database name; no flag or environment variable can answer for them." >&2
    exit 1
  fi
  echo >&2
  echo "THIS DELETES EVERY USER AND SERVER IN PRODUCTION ($d1) EXCEPT the keep list above," >&2
  echo "demo sample users and test accounts included." >&2
  printf 'Type the database name (%s) to continue: ' "$d1" >&2
  typed=""
  read -r typed || true
  if [ "$typed" != "$d1" ]; then
    echo "REFUSING TO WIPE PRODUCTION: typed '${typed}', expected '$d1'." >&2
    exit 1
  fi
fi

operator="${USER:-$(id -un 2>/dev/null || echo unknown)}"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "AUDIT $stamp · WIPE START · env=$target_env d1=$d1 operator=$operator approx_rows=$total keep=$(printf '%s' "$keep_all" | tr '\n' ',' | sed 's/,$//')"

wiped=0; skipped=0; failed=0
for t in $tables; do
  v="P_$t"; p="${!v}"
  case "$p" in
    @K) echo "  keep   $t (kept whole)"; continue ;;
    @W) stmt="DELETE FROM $t;" ;;
    *)  stmt="DELETE FROM $t WHERE COALESCE(($p),0) = 0;" ;;
  esac
  if d1x --command "$stmt" >/dev/null 2>&1; then
    echo "  wiped  $t"; wiped=$((wiped + 1))
  elif d1x --command "SELECT count(*) AS n FROM $t;" --json >/dev/null 2>&1; then
    echo "  FAILED $t (table exists but the delete failed)"; failed=$((failed + 1))
  else
    echo "  skip   $t (absent in $target_env)"; skipped=$((skipped + 1))
  fi
done

# Prove it: every table must now hold only kept rows.
leftover=0
for t in $tables; do
  v="P_$t"
  case "${!v}" in @K) continue ;; esac
  count_table "$t"
  if [ "$cnt_status" = "ok" ] && [ "$cnt_total" -ne "$cnt_keep" ]; then
    echo "  LEFTOVER $t: $((cnt_total - cnt_keep)) row(s) that should be gone" >&2
    leftover=$((leftover + 1))
  fi
done

stamp_done="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "AUDIT $stamp_done · WIPE DONE · env=$target_env operator=$operator wiped=$wiped skipped=$skipped failed=$failed leftover_tables=$leftover"
echo "done: $wiped wiped, $skipped skipped, $failed failed, $leftover with leftovers"
if [ "$wiped" -eq 0 ]; then
  echo "WARNING: nothing wiped — check wrangler auth + the '$d1' binding" >&2
  exit 1
fi
if [ "$failed" -ne 0 ] || [ "$leftover" -ne 0 ]; then
  echo "WARNING: the wipe is incomplete — re-run it (it is safe to repeat) and check the lines above" >&2
  exit 1
fi
