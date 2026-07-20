#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail=0
check() {
  local pattern="$1"
  shift
  if rg -n -U --glob '*.ts' --glob '*.sql' "$pattern" "$@"; then
    fail=1
  fi
}

check '\b(device_label|device_name|display_name)\b' packages/storage/src packages/storage/migrations/0083_private_account_device_directory.sql
check '\bdeviceLabel\b' packages/protocol/src packages/control-plane/src apps/com/src
if sed -n '/interface PushTokenRecord/,/^}/p' packages/storage/src/types.ts | rg -n '\blabel\??:'; then fail=1; fi
if sed -n '/CREATE TABLE push_tokens/,/);/p' packages/storage/migrations/0083_private_account_device_directory.sql | rg -n '\blabel\b'; then fail=1; fi
if sed -n '/interface DemoUserRecord/,/^}/p' packages/storage/src/types.ts | rg -n '\bdisplay\??:'; then fail=1; fi

if (( fail != 0 )); then
  echo "private-name-storage-guard: plaintext account/device presentation field detected" >&2
  exit 1
fi

echo "private-name-storage-guard: OK"
