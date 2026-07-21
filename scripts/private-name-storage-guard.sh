#!/usr/bin/env bash
set -euo pipefail

ROOT="${PRIVATE_NAME_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

fail=0

# Expand the scan targets to a concrete file list. A target that resolves to
# NOTHING is a guard failure, not a pass: a renamed or deleted path must never
# turn a privacy check into a silent green.
list_files() {
  local p
  for p in "$@"; do
    if [[ -d $p ]]; then
      find "$p" -type f \( -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.sql' \) -print
    elif [[ -f $p ]]; then
      printf '%s\n' "$p"
    fi
  done
}

check() {
  local pattern="$1"
  shift
  local files=()
  while IFS= read -r f; do files+=("$f"); done < <(list_files "$@")
  if (( ${#files[@]} == 0 )); then
    echo "private-name-storage-guard: no files to scan for: $*" >&2
    fail=1
    return
  fi
  # -a: some sources embed raw control bytes (regex bounds, NUL key
  # separators), which would make grep skip them as "binary" — a privacy
  # scan must never be blinded by a byte in an unrelated line.
  if grep -anE "$pattern" "${files[@]}"; then
    fail=1
  fi
}

# Scan a declaration block (sed range) for a forbidden field.
check_block() {
  local range="$1" file="$2" pattern="$3"
  if [[ ! -f $file ]]; then
    echo "private-name-storage-guard: missing scan target: $file" >&2
    fail=1
    return
  fi
  local block
  block="$(sed -n "$range" "$file")"
  if [[ -z $block ]]; then
    echo "private-name-storage-guard: empty declaration block ($range) in $file" >&2
    fail=1
    return
  fi
  if printf '%s\n' "$block" | grep -anE "$pattern"; then
    fail=1
  fi
}

SCHEMA=packages/storage/migrations/0083_private_account_device_directory.sql
TYPES=packages/storage/src/types.ts

check '\b(device_label|device_name|display_name)\b' packages/storage/src "$SCHEMA"
check '\bdeviceLabel\b' packages/protocol/src packages/control-plane/src apps/com/src
check '\bcompanionLabel\b' packages/server-daemon/src packages/control-plane/src apps/com/src
check 'flagship/order/add-paired-session/v1' packages/protocol/src packages/server-daemon/src apps/com/src apps/web/public/webapp
check 'GET[[:space:]]+/api/users/[^[:space:]]+/devices\b' packages/control-plane/src apps/com/src

# A decrypted presentation name is a RENDER-time value. Persisting one into
# the browser's profile store would put it in localStorage — readable without
# the account key, and outliving the account itself.
check '(accountDisplayName|deviceDisplayName)' apps/web/public/webapp/lib/profiles.js

check_block '/interface PushTokenRecord/,/^}/p' "$TYPES" '\blabel\??:'
check_block '/CREATE TABLE push_tokens/,/);/p' "$SCHEMA" '\blabel\b'
check_block '/interface DemoUserRecord/,/^}/p' "$TYPES" '\bdisplay\??:'
check_block '/interface DeviceCapabilityGrantRecord/,/^}/p' "$TYPES" '\b(label|displayName|deviceName)\??:'
check_block '/interface DeviceIdentityRecord/,/^}/p' "$TYPES" '\b(label|displayName|deviceName)\??:'

# Applied migrations are immutable history. These pre-clean-schema files
# introduced the discarded fields and are explicitly neutralized by 0083.
# Every other migration, including every future one, must remain free of them.
while IFS= read -r migration; do
  case "$(basename "$migration")" in
    0017_push_token_label.sql|0027_demo_users.sql|0031_device_capability_grants.sql|0044_name_claims.sql) continue ;;
  esac
  check '\b(device_label|device_name|display_name|companion_label)\b|\b(display|label)[[:space:]]+TEXT\b' "$migration"
done < <(find packages/storage/migrations -maxdepth 1 -type f -name '*.sql' -print | sort)

if (( fail != 0 )); then
  echo "private-name-storage-guard: plaintext account/device presentation field detected" >&2
  exit 1
fi

echo "private-name-storage-guard: OK"
