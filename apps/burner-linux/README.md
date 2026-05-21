# Flagship Burner — Linux GUI

GTK4 + libadwaita wrapper around the `@flagship/burner` Node CLI
(`packages/flagship-burner/`). UX matches `apps/burner-mac/` 1:1: one
window, five-step wizard.

## What it does

1. **Recipe** — drag in (or paste) the signed JSON the website produces
   after the phone scans the QR code. The GUI shells out to
   `flagship-burn verify` and shows you the server-domain + expiry so
   you can sanity-check before flashing.
2. **ISO** — drag in a stock Ubuntu Server ISO. Run
   `flagship-burn distros` for accepted SHAs.
3. **Drive** — pick a USB drive from a read-only list. Only removable,
   external whole-disks in the 500MB-500GB band appear; internal SSDs,
   NVMe boot drives, and oversized disks are hidden by design — they're
   also hard-refused by the CLI's safety classifier even with an
   explicit `--device`.
4. **Bake** — invokes the CLI's `write` subcommand (full burn) wrapped
   in `pkexec` so the user gets the standard PolicyKit admin-auth
   prompt for the one-shot root grant. Streams stdout/stderr into a
   log pane.
5. **Done** — shows the resulting server-domain + when the recipe
   expires.

## Requirements

- **Python 3.10+**
- **GTK 4 + libadwaita** Python bindings:
  - Ubuntu 24.04 / Debian 13:
    `sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1`
  - Fedora 41+:
    `sudo dnf install python3-gobject gtk4 libadwaita`
  - Arch:
    `sudo pacman -S python-gobject gtk4 libadwaita`
- **Node.js 20+** somewhere on `PATH`. Same prereq as the Mac GUI.
- **`lsblk`** — ships on every Linux distro.
- **`pkexec`** (PolicyKit) — ships on every modern desktop distro.

## Run from a checkout

```sh
# From the repo root:
python3 apps/burner-linux/flagship-burner.py
```

The GUI resolves the Node CLI entry from
`packages/flagship-burner/src/cli.ts` relative to its own directory, so
it Just Works in a checkout. Override with `FLAGSHIP_BURN_ENTRY=...` if
you need a different path (useful when running from inside an AppImage
extract).

## Test

```sh
python3 -m pytest apps/burner-linux/tests/
```

Tests cover:

- `disk_enumerator.parse_lsblk` + verdict rules — mirrors the Mac
  `DiskEnumerator` tests + the CLI's `devices.test.ts`.
- `cli_runner` argument vectors + locator fallback + `verify` JSON
  parser — mirrors `CLIArgsTests` + `VerifyResultTests`.
- `wizard` state machine (GUI-agnostic) — `WizardState` readiness,
  `WizardModel.refresh_disks` + `accept_*` callbacks.

The view layer is intentionally not unit tested — drive it manually
with `flagship-burner.py`.

Static analysis:

```sh
python3 -m py_compile apps/burner-linux/*.py
```

## Distribute

### AppImage (works on every modern desktop distro)

```sh
bash apps/burner-linux/appimage/build.sh
# → apps/burner-linux/dist/FlagshipBurner-x86_64.AppImage
```

The AppImage bundles the Python sources + the built CLI (`tsc -b`
output from `packages/flagship-burner/dist/`). It does **not** bundle
Node, GTK4, or libadwaita — those remain runtime prereqs on the host.

To enable the `write` subcommand, the user installs the PolicyKit
action once:

```sh
sudo install -m 644 apps/burner-linux/polkit/com.flagshipserver.burner.policy \
    /usr/share/polkit-1/actions/
```

### Flatpak (stub — `verify` + `prepare` only)

```sh
flatpak-builder --user --install build-dir \
    apps/burner-linux/flatpak/com.flagshipserver.Burner.yaml
```

The Flatpak sandbox blocks raw block-device access by design, so the
`write` subcommand will NOT work from inside the Flatpak. The recipe
verification + ISO baking paths still work — useful for users who flash
USBs via `balenaEtcher` or GNOME Disks anyway. Phase-2 we may revisit
this with a portal-mediated "open this device" prompt.

## Architecture

```
flagship-burner.py    GTK app entry — wires Adw.Application, opens the wizard window
wizard.py             GUI-agnostic WizardState + WizardModel + GTK view builder
cli_runner.py         spawn Node, stream output, locate CLI entry, parse verify JSON
disk_enumerator.py    lsblk JSON parser + safety classifier (mirrors devices.ts)
polkit/               PolicyKit action XML — installs the "Bake to USB" auth dialog
flatpak/              Flatpak manifest (stub — write is sandbox-incompatible)
appimage/             AppImage build script — produces a relocatable single-file binary
tests/                pytest unit tests; GUI layer not covered
```

The split keeps every CLI-driving and lsblk-parsing function in modules
that import cleanly without a display, so `pytest` runs headless on CI.

## License

BUSL-1.1 — see repo root.
