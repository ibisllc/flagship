# Flagship Burner — Linux GUI

GTK4 + libadwaita wrapper around the `@flagship/burner` Node CLI
(`packages/flagship-burner/`). UX matches `apps/burner-mac/` 1:1: one
window, five-step wizard — plus the desktop VM appliance: the same recipe can
be **hosted on this PC** as a managed QEMU/KVM VM instead of burned to USB
(parity with `apps/burner-windows` and `apps/burner-mac`).

## Two modes

Both modes remaster a base ISO with your signed recipe via the same
`@flagship/burner` Node CLI `write` subcommand, then flash it to a USB drive.
They differ only in *where the base ISO comes from*:

- **Simple (default)** — you don't supply an ISO. The burner fetches a stock
  **Debian-netinst** base ISO chosen by the **server manifest**
  (`POST https://flagshipserver.com/api/iso-manifest`), verifies its sha256,
  and caches it under `~/.cache/flagship-burner/`. Every later burn reuses the
  cache; the server decides when a new base ships. The burner is a *dumb
  executor*: it reports the version+sha of whatever it has cached, obeys the
  manifest's download-or-keep instruction, and verifies the bytes it downloads.
- **Advanced** — you bring your own stock Ubuntu/Debian ISO (drag it in). No
  manifest, no download. Toggle "Bring my own ISO (Advanced)" in the header.

The base-ISO download URL is shown live under the progress bar so you can see
exactly where the bytes are coming from. Both the cached path + sha256 (on
inspect) and the downloaded path + sha256 + source URL (after a download) are
written to the log pane.

## What it does

1. **Recipe** — drag in (or paste) the signed JSON the website produces
   after the phone scans the QR code. The GUI shells out to
   `flagship-burn verify` and shows you the server-domain + expiry so
   you can sanity-check before flashing.
2. **ISO** — *Advanced only.* Drag in a stock Ubuntu/Debian Server ISO. Run
   `flagship-burn distros` for accepted SHAs. In **Simple** mode this step is
   hidden — the Debian base ISO is fetched per the server manifest and cached.
3. **Drive** — pick a USB drive from a read-only list. Only removable,
   external whole-disks in the 500MB-500GB band appear; internal SSDs,
   NVMe boot drives, and oversized disks are hidden by design — they're
   also hard-refused by the CLI's safety classifier even with an
   explicit `--device`.
4. **Flash** — invokes the CLI's `write` subcommand wrapped in `pkexec` to
   remaster the ISO and raw-write it to the picked disk. The progress bar is
   accent-coloured during the remaster + write. Streams output into a log
   pane.
5. **Done** — shows the resulting server-domain + when the recipe
   expires.

## Host on this PC (VM appliance)

After a recipe verifies, a **destination chooser** appears: *Burn to USB* —
"Appliance (hardware)", the gold standard — or *Host on this PC* — "Appliance
(hosted VM)". Hosting runs the SAME remastered installer ISO (the Node CLI's
`prepare`) inside a managed QEMU/KVM VM: unattended install → LUKS → phone-home
unlock → register, unmodified. This app never holds a key; while the guest sits
sealed it just polls `https://<fqdn>/` — any HTTP response proves the unlock
completed (TLS terminates on the box).

Hosted servers live in the **"Servers on this PC" sidebar**. Per-row actions via
the ⋯ button / right-click / double-click: Start, Stop, Retry install, Open in
SSH (debug VMs only), Delete. Selecting a row opens its detail pane.

- **Recipes can also arrive by phone pairing** — "Pair with your phone" drives
  the shared `flagship-burn pair --emit-events` CLI and renders the QR / code /
  SAS natively; the delivered recipe behaves exactly like a dropped-in file.
- **Debug is consent-as-crypto.** SSH + the serial console exist IFF the recipe
  carries the phone-signed `debugGrant` sibling (mint with the pairing debug
  toggle, or `flagship-burn pair --debug`). The grant's `sshAuthorizedKey` is
  baked by the shared CLI at remaster time (`debugSshKeyFromGrant`), so a
  debug-friendly recipe yields an SSH-able first boot; a production VM gets NO
  console device and NO forwarded port — there is no host-side override.
- **"Open in SSH"** opens your terminal (`$TERMINAL`, else
  x-terminal-emulator / gnome-terminal / konsole / xterm) at
  `ssh -p <hostfwd-port> debug@127.0.0.1` — a local loopback forward into a VM
  hosted by THIS app, never a relay.
- **Metal-identical guest**: AHCI main disk (the guest sees `/dev/sda`),
  installer ISO attached as USB mass storage (`sdb`, same order as a real
  stick), OVMF UEFI with a per-VM vars copy, user-mode NAT (outbound only —
  inbound arrives over the tunnel), `-display none`.
- **KVM** is probed at launch (`/dev/kvm` exists + writable, vmx/svm flag). If
  unavailable the app says exactly why (kvm group / firmware / module) and
  degrades to TCG with an honest "much slower" warning — hosting still works.
- Bundles live under `$XDG_DATA_HOME/flagship-burner/VMs/<fqdn>/`
  (`config.json`, sparse `disk.qcow2`, per-VM `efi-vars.fd`, `installer.iso`
  during install only, `console.log` transcript for debug VMs).
- Resource plan (pinned by the shared golden vectors): 2–4 vCPUs, 4–6 GiB RAM
  per VM, 4 GiB host reserve, 64 GiB sparse disk, capacity capped by host RAM.

Extra requirements for hosting (on top of the burner's):

- `qemu-system-x86` + `qemu-utils` (e.g. `sudo apt install qemu-system-x86
  qemu-utils`)
- OVMF firmware (`sudo apt install ovmf` / `sudo dnf install edk2-ovmf`)
- KVM access: `sudo usermod -aG kvm $USER`, then log out and back in
- Overrides: `FLAGSHIP_QEMU_SYSTEM`, `FLAGSHIP_QEMU_IMG`, `FLAGSHIP_OVMF_CODE`,
  `FLAGSHIP_OVMF_VARS`

The pure VM core (lifecycle state machine, resource plan, install verdict,
bundle-name rules) is pinned to the cross-language contract in
`apps/desktop-shared/golden/vm-core-vectors.json` — the same vectors the
Windows (C#) and Mac (Swift) cores must pass.

### Owner validation on a real Linux box (this build machine is macOS)

The pure layer is fully unit-tested; the following need a live Linux desktop:

1. ~~GTK render~~ — **validated 2026-07-06 on ChromeOS/Crostini (Debian 12,
   GTK 4.8 + libadwaita 1.2)**: the window builds and runs. Two view-layer
   crashes were found + fixed on first-ever render (`Adw.ToolbarView` needs
   libadwaita ≥ 1.4 — now falls back to a plain box; a GTK3-only
   `set_hscrollbar_policy` call). Deeper interaction passes still pending.
2. A real KVM boot: create-server → unattended install → duration-gated verdict
   → first boot → sealed `awaitingPhoneUnlock` → phone approval → Running with
   a green padlock at the FQDN. **Partially validated on Crostini 2026-07-06**:
   a KVM-accelerated OVMF boot through `QemuHost` + QMP (`query-kvm
   enabled=true`, clean `quit`) works; the full install chain still needs a
   real recipe.
3. A real `Open in SSH` into a debug-grant VM (terminal opens,
   `debug@127.0.0.1` login accepted by the guest's grant gate).
4. A live phone pairing (QR scan → SAS match → recipe delivered → chooser).
5. The TCG degrade path on a machine without KVM (warning shown, VM still
   boots, slowly).

## Requirements

- **Python 3.10+**
- **GTK 4 + libadwaita** Python bindings:
  - Ubuntu 24.04 / Debian 13:
    `sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1`
  - Fedora 41+:
    `sudo dnf install python3-gobject gtk4 libadwaita`
  - Arch:
    `sudo pacman -S python-gobject gtk4 libadwaita`
- **Node.js 20+** somewhere on `PATH` — the Node CLI remasters the
  user-supplied ISO.
- **`lsblk`** — ships on every Linux distro.
- **`pkexec`** (PolicyKit) — ships on every modern desktop distro (NOT in
  ChromeOS's stock container — there the burner falls back to passwordless
  `sudo -n`, which Crostini grants the primary user; see below).

### ChromeOS (Crostini)

The burner runs inside ChromeOS's Linux container, and **Host on this PC gets
real KVM acceleration** where ChromeOS exposes `/dev/kvm` to the container
(true on this validated board; it varies by board/ChromeOS version — where
it's absent the VM degrades to TCG with the honest much-slower warning). An
arm64 Chromebook hosts a native arm64 guest (`qemu-system-arm
qemu-efi-aarch64` instead of `qemu-system-x86 ovmf`); burning always writes
the amd64 image.

```sh
sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 \
                 qemu-system-x86 qemu-utils ovmf
```

Three container quirks the app now handles:

- **USB burning does NOT work from the container** (validated 2026-07-06 on a
  real Chromebook): even after sharing the stick (ChromeOS Settings → Linux →
  Manage USB devices) so it appears as `/dev/sda`, ChromeOS manages the
  removable drive and **caps raw block writes from the container** — a burn
  stalls at ~0% (empirically ~488 KB, then a silent short write → `ENOSPC`).
  Everything up to the write is correct (enumeration, safety verdict,
  `sudo -n` elevation, remaster); only ChromeOS's device layer blocks the
  bytes. The app now shows an upfront advisory when a USB is selected on
  ChromeOS and recommends **Host on this PC** (which works great with KVM) —
  or run this burner on a native Linux machine to write a stick. The empty
  disk picker (before sharing) likewise explains the sharing step.
- **Elevation**: the stock container has no pkexec (and no polkit agent to
  prompt), so the raw write elevates via non-interactive passwordless
  `sudo -n` — which Crostini grants the primary user by design. pkexec still
  wins wherever it exists.
- **Open in SSH** opens the ChromeOS Terminal app (`x-terminal-emulator`
  resolves to `garcon-terminal-handler`, which takes the command verbatim —
  no `-e`).

## Run from a checkout

```sh
# From the repo root:
python3 apps/burner-linux/flagship-burner.py
```

The GUI resolves the Node CLI entry from
`packages/flagship-burner/dist/cli.js` relative to its own directory —
run `npx tsc -b packages/flagship-burner` once so the build exists
(plain `node` can't execute the `.ts` source; the src entry is only a
last-resort for TS-capable runtimes). Override with
`FLAGSHIP_BURN_ENTRY=...` if you need a different path (useful when
running from inside an AppImage extract).

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
  `WizardModel.refresh_disks` + `accept_*` callbacks, Simple/Advanced
  `set_mode`, and the Simple-mode base-ensure→CLI-write seam.
- `iso_manifest_client` — `/api/iso-manifest` POST shape + response
  parse (download vs keep), mocked HTTP.
- `iso_base_cache` — manifest-driven keep vs download vs sha-mismatch
  against a temp cache dir.
- **`vm/` core vs the shared golden vectors** (`test_vm_core_vectors`) —
  lifecycle transitions/invalids, the duration-gated install verdict, the
  resource plan, and bundle-name validation, all pinned to
  `apps/desktop-shared/golden/vm-core-vectors.json`.
- `vm/` units — QEMU argv builder, KVM probe classifier, QMP protocol over a
  fake duplex, toolchain/OVMF locator, inventory round-trip, the VMManager
  orchestrator (fake host), and `ssh_launch`.
- `pair_session` — the `FLAGSHIP_PAIR <json>` event parser (mirrors the
  Windows `PairEventParserTests`, plus the `debug-result.granted` field).
- `test_wizard_hosting` — pane switching, host-here pipeline (create →
  prepare → shred → install; rollback on failure), sidebar actions, SSH
  dispatch, pairing lifecycle.

The view layer is intentionally not unit tested — drive it manually
with `flagship-burner.py` (GTK objects are only constructed inside
`build_window`, so everything above runs headless without `gi`).

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

To enable the raw write, the user installs the PolicyKit actions once
(one for the Node-CLI write, one for the local raw-write flasher):

```sh
sudo install -m 644 \
    apps/burner-linux/polkit/com.flagshipserver.burner.policy \
    apps/burner-linux/polkit/com.flagshipserver.burner.write-image.policy \
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
                      + PkexecFlasher (local raw write); Simple/Advanced modes
iso_manifest_client.py POST /api/iso-manifest, parse download-or-keep response
iso_base_cache.py     manifest-driven Debian base-ISO cache (inspect / fetch /
                      stream-sha256-verify / store) for Simple mode
disk_write.py         sector-aligned raw write (lib + pkexec CLI entry)
cli_runner.py         spawn Node, stream output, locate CLI, parse JSON
disk_enumerator.py    lsblk JSON parser + safety classifier (mirrors devices.ts)
pair_session.py       FLAGSHIP_PAIR NDJSON event parser + pair-session driver
                      (wraps `flagship-burn pair --emit-events`)
vm/                   the VM appliance host layer (mirrors burner-windows src/VM/):
                      config, lifecycle (golden-vector-pinned state machine),
                      resource_plan, inventory (bundle store), recipe_info,
                      kvm_probe, qemu_locator, qemu_command_line (pure argv),
                      qemu_host + qmp_client (process + control socket),
                      manager (orchestrator), ssh_launch (Open in SSH)
polkit/               PolicyKit action XML — two actions: Node-CLI write
                      + write-image (pkexec python3 disk_write.py)
flatpak/              Flatpak manifest (stub — raw write is sandbox-incompatible)
appimage/             AppImage build script — produces a relocatable single-file binary
tests/                pytest unit tests; GUI layer not covered
```

The CLI-driving and lsblk-parsing functions live in modules that import
cleanly without a display, so `pytest` runs headless on CI.

## License

BUSL-1.1 — see repo root.
