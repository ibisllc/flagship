# Validating Flagship Studio on Windows and Linux

What to do on a Windows PC or a Linux desktop that the Mac can't. CI already
builds, unit-tests and smoke-tests both packages (`studio-release.yml`), but
neither has run on a real desktop with a phone. Record results in the "Desktop
Studio" entry of `AGENTS.md` and fix what breaks on the machine that shows it.

## 1. Set up the checkout

```sh
git clone https://github.com/ibisllc/flagship.git && cd flagship   # or: git pull
npm ci
npx tsc -b
```

Agents on that machine get `AGENTS.md` through `CLAUDE.md` automatically.

## 2. Windows (10 or 11, x64)

Prerequisites: .NET 8 SDK, Windows PowerShell, and Hyper-V's Windows Hypervisor
Platform enabled (Settings → Optional features → More Windows features).

```powershell
apps\builder-windows\make.ps1 test      # .NET suite, must be green
apps\builder-windows\make.ps1 publish   # dist\FlagshipBuilder.exe
```

Then test the **released** package, not the dev build, because that's what
users get:

1. Download `/download/windows` (the latest `studio-v*` zip), unzip it, and run
   `Flagship Studio.exe`. SmartScreen will warn (unsigned): More info → Run
   anyway. Help → About must show the release version.
2. **Pairing:** the pairing code is up at launch with no click. Pull the
   network cable / turn Wi-Fi off: it says "Waiting for an internet
   connection"; restore it and a fresh code appears. Pair from the phone (Add
   server → Pair with Studio): QR or short code, then confirm the SAS on both
   screens.
3. **Host on this PC (prebuilt image, the default):** choosing the card starts
   at once. It downloads the published appliance (~2.5 GB, parts resume after
   an interruption), verifies it, creates the server's overlay disk and seed,
   and the guest specializes and powers off by itself (about a minute), then
   boots sealed. Approve the unlock on the phone and open
   `https://<server>.<user>.flagship.services/`. Pass = green padlock, the
   server online in the app, the detail pane's **Health** card filled within a
   few minutes, and the taskbar button showing download progress.
4. **Host on this PC (installer ISO):** set `FLAGSHIP_VM_FORCE_ISO=1`, relaunch,
   and host a second server: it downloads and verifies the Debian ISO, remasters
   it (this exercises the bundled `tools\xorriso.exe`) and installs under WHPX.
   Same pass criteria.
5. **Restart and stop:** Restart a running server from the tray; an
   auto-unlock server that ran before must read "Unlocking…" and come back with
   no phone approval. Stop, Quit and Restart as administrator must each power
   servers off gracefully first (Restart as administrator asks before it does).
6. **Sleep:** while a server runs, the PC must not idle-sleep (`powercfg
   /requests` lists Flagship Studio under SYSTEM).
7. **USB:** enter Wi-Fi details, burn a stick, quit and relaunch (the Wi-Fi is
   remembered), boot the stick on metal, approve the unlock, same check.
8. Note anything that needed a workaround. Timing (download, install, first
   boot) is useful too.

## 3. Linux (x86-64 desktop with GTK 4 + libadwaita)

```sh
sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-secret-1 qemu-system-x86 qemu-utils ovmf nodejs xorriso
python3 -m pytest apps/builder-linux/tests -q
bash apps/builder-linux/appimage/build.sh
```

`/dev/kvm` must be usable by your user (`ls -l /dev/kvm`; add yourself to the
`kvm` group if needed), or hosting falls back to slow TCG.

1. Download `/download/linux` (the AppImage), `chmod +x` it and run it. About
   must show the release version.
2. Steps 2–5 of the Windows list, with KVM instead of WHPX: pairing at launch
   and offline, hosting from the prebuilt image (the default; qemu-img builds
   the overlay), then with `FLAGSHIP_VM_FORCE_ISO=1` from the installer ISO,
   Health, Restart from the row menu or detail pane, "Unlocking…" after a
   restart. Without xorriso, a burn or the installer path must name the
   package to install before downloading anything.
3. **Tray:** on KDE, or Ubuntu with its AppIndicator extension, a tray icon
   lists each server with Start/Stop/Restart, Stop all and Quit. Stock GNOME
   shows no icon; that's expected.
4. **Sleep:** while a server runs, `systemd-inhibit --list` shows Flagship
   Studio (or GNOME's own inhibitor list does).
5. Burn a USB stick with Wi-Fi (pkexec prompts for the raw write), relaunch to
   see the Wi-Fi remembered (in the keyring when one runs), and boot it on
   metal.
6. Open in SSH on a debug-grant VM: the terminal should log in as
   `debug@127.0.0.1`.

## 4. Debian 13.7.0 re-pin check (either OS)

Production pins Debian 13.6.0. Before re-pinning:

1. Download the official 13.7.0 netinst amd64 ISO and check its SHA-256 against
   Debian's `SHA256SUMS`.
2. In Studio's **Advanced** mode, choose that ISO, then host a VM and burn a
   USB from a fresh recipe. Both must reach a green padlock.
3. Only then change the pins listed under "Open work" in `AGENTS.md`.

## 5. Cutting a new desktop release

After fixing anything, push to `main`, then:

```sh
gh workflow run studio-release.yml -f version=<x.y.z>               # dry run
gh workflow run studio-release.yml -f version=<x.y.z> -f publish=true
```

Point `INSTALLER_DOWNLOADS` in `apps/com/src/route.ts` (and its test) at the new
asset names, then `npx tsc -b && (cd apps/com && npm run deploy)`.
