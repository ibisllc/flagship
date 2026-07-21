# Flagship Studio — macOS GUI

Native SwiftUI wrapper around the `@flagship/builder` Node CLI
(`packages/flagship-builder/`). For users who'd rather click than type.

## What it does

The builder opens **locked**, showing a QR + a short code. You pair it
from the Flagship phone app (scan the QR or type the code, confirm the
security code), and the phone sends the signed recipe over a live
session — the builder stays unlocked only while that session is up. There
is also an **"I have a recipe"** path for a recipe you received out of
band (paste it or drop the JSON file).

Once a recipe is in hand:

1. **Recipe** — delivered over the paired session, or pasted/dropped via
   "I have a recipe". The app verifies the signature and shows you the
   server-domain + expiry so you can sanity-check before flashing.
2. **ISO** — drag in a stock Ubuntu Server ISO (see
   `flagship-build distros` for accepted SHAs).
3. **Drive** — pick a USB drive from a read-only list. Only removable,
   external whole-disks appear; the internal boot disk and Apple
   recovery slices are hidden by design (the CLI's `dd` step is
   destructive — we don't even offer them).
4. **Bake** — invokes the CLI's `prepare` subcommand and streams stdout
   + stderr into a log panel. The CLI emits a `.flagship.iso` next to
   the input ISO.
5. **Done** — shows the resulting file path and a one-liner `dd`
   command to flash the picked drive when you're ready.

The "actually write to USB" step is intentionally **not** done by this
app yet — the Phase-2 CLI ships a `write` subcommand that bundles
prepare-and-flash; once that lands, swap `runPrepare` for `runWrite` in
`WizardModel.swift`.

## Requirements

You must have **Node.js installed** somewhere the app can find it. The
GUI looks in:

1. `$FLAGSHIP_NODE_PATH` (override)
2. `/opt/homebrew/bin/node` (Apple-silicon Homebrew)
3. `/usr/local/bin/node` (Intel Homebrew / standalone install)
4. `/usr/bin/node` (system)

If none of those work, install Node 20+ with `brew install node`.

The CLI itself is a TypeScript ESM module under
`packages/flagship-builder/src/`. The app finds it relative to its
own executable (during `swift run` development) or in the app bundle's
resources (Phase 2 release packaging will add a SwiftPM resource copy
step to bake the CLI directly into `.app/Contents/Resources/`).

## Build + run

```sh
cd apps/builder-mac
swift build
swift run FlagshipBuilder
```

To override the CLI entry point during development:

```sh
FLAGSHIP_BURN_ENTRY=/path/to/cli.ts swift run FlagshipBuilder
```

## Test

```sh
cd apps/builder-mac
swift test
```

Tests cover:

- `DiskEnumerator` plist parsing + accept/reject rules
- `VerifyResult` JSON parsing (incl. tolerance of noise before the JSON)
- `CLIArgs` argument-vector building
- `CLILocator` env-var override + fallback search

The view layer (`WizardView`, `WizardModel`) is intentionally not unit
tested — drive it manually with `swift run`.

## Entitlements

macOS sandbox notes (when you eventually sign + notarize):

- `com.apple.security.files.user-selected.read-only` — for drag-drop
  recipe + ISO.
- Removable-volume read access (handled by user-selected files for the
  ISO; `diskutil` doesn't need an entitlement).
- No network entitlement — the GUI never phones home; the CLI is a pure
  local consumer of phone-signed input.

## Architecture

```
Package.swift
Sources/
  FlagshipBuilderCore/   pure, testable
    CLIArgs              flagship-build arg-vector builders
    CLILocator           find node + the CLI entry path
    CLIRunner            spawn + stream stdout/stderr
    DiskEnumerator       diskutil plist parser + accept rules
    VerifyResult         decode the CLI's verify JSON
  FlagshipBuilder/       SwiftUI + AppKit shell
    FlagshipBuilderApp    @main
    WizardView           one-screen wizard
    WizardModel          @MainActor controller
    Theme                lightweight FlagshipUI token mirror
Tests/FlagshipBuilderTests/
```

The split keeps every CLI-driving and plist-parsing function in a
target that runs under `swift test` without ever launching SwiftUI.
