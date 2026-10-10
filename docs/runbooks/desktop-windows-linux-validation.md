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

1. Download `/download/windows` (the `studio-v0.1.0` zip), unzip it, and run
   `Flagship Studio.exe`. SmartScreen will warn (unsigned): More info → Run anyway.
2. Pair from the phone (Add server → Pair with Studio): QR or short code, then
   confirm the SAS on both screens.
3. **Host on this PC:** let it download and verify the Debian ISO, remaster it
   (this exercises the bundled `tools\xorriso.exe`), install under WHPX, boot,
   approve the unlock on the phone, and open `https://<server>.<user>.flagship.services/`.
   Pass = green padlock and the server online in the app.
4. **USB:** burn a stick, boot it on metal, approve the unlock, same check.
5. Note anything that needed a workaround. Timing (download, install, first
   boot) is useful too.

## 3. Linux (x86-64 desktop with GTK 4 + libadwaita)

```sh
sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-adw-1 qemu-system-x86 qemu-utils ovmf nodejs
python3 -m pytest apps/builder-linux/tests -q
bash apps/builder-linux/appimage/build.sh
```

`/dev/kvm` must be usable by your user (`ls -l /dev/kvm`; add yourself to the
`kvm` group if needed), or hosting falls back to slow TCG.

1. Download `/download/linux` (the AppImage), `chmod +x` it and run it.
2. Pair, host a server under KVM, approve the unlock, check HTTPS: same pass
   criteria as Windows.
3. Burn a USB stick (pkexec prompts for the raw write) and boot it on metal.
4. Open in SSH on a debug-grant VM: the terminal should log in as
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
