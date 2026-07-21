#!/usr/bin/env bash
set -euo pipefail

ROOT="${PRIVATE_NAME_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

fail=0
check() {
  local pattern="$1"
  shift
  if rg -n -U --glob '*.ts' --glob '*.js' --glob '*.mjs' --glob '*.sql' "$pattern" "$@"; then
    fail=1
  fi
}

check '\b(device_label|device_name|display_name)\b' packages/storage/src packages/storage/migrations/0083_private_account_device_directory.sql
check '\bdeviceLabel\b' packages/protocol/src packages/control-plane/src apps/com/src
check '\bcompanionLabel\b' packages/server-daemon/src packages/control-plane/src apps/com/src
check 'flagship/order/add-paired-session/v1' packages/protocol/src packages/server-daemon/src apps/com/src apps/web/public/webapp
check 'GET[[:space:]]+/api/users/[^[:space:]]+/devices\b' packages/control-plane/src apps/com/src
if sed -n '/interface PushTokenRecord/,/^}/p' packages/storage/src/types.ts | rg -n '\blabel\??:'; then fail=1; fi
if sed -n '/CREATE TABLE push_tokens/,/);/p' packages/storage/migrations/0083_private_account_device_directory.sql | rg -n '\blabel\b'; then fail=1; fi
if sed -n '/interface DemoUserRecord/,/^}/p' packages/storage/src/types.ts | rg -n '\bdisplay\??:'; then fail=1; fi
if sed -n '/interface DeviceCapabilityGrantRecord/,/^}/p' packages/storage/src/types.ts | rg -n '\b(label|displayName|deviceName)\??:'; then fail=1; fi
if sed -n '/interface DeviceIdentityRecord/,/^}/p' packages/storage/src/types.ts | rg -n '\b(label|displayName|deviceName)\??:'; then fail=1; fi

# Applied migrations are immutable history. These three pre-clean-schema files
# introduced the discarded fields and are explicitly neutralized by 0083.
# Every other migration, including every future one, must remain free of them.
while IFS= read -r migration; do
  case "$(basename "$migration")" in
    0017_push_token_label.sql|0027_demo_users.sql|0031_device_capability_grants.sql|0044_name_claims.sql) continue ;;
  esac
  check '\b(device_label|device_name|display_name|companion_label)\b|\b(display|label)\s+TEXT\b' "$migration"
done < <(find packages/storage/migrations -maxdepth 1 -type f -name '*.sql' -print | sort)

if (( fail != 0 )); then
  echo "private-name-storage-guard: plaintext account/device presentation field detected" >&2
  exit 1
fi

echo "private-name-storage-guard: OK"
