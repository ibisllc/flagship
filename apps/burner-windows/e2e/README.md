# Windows desktop-VM appliance — end-to-end boot

This harness boots a **real VM** from a **real recipe** through the **actual
production C# stack**, on this Windows box, under **QEMU + WHPX**. It exists to
prove the thing the Mac slice couldn't finish: that the remaster → boot →
unattended-install → boot-from-disk loop works on a hosted VM.

## What it does

- **`mint-recipe.ts`** — the scripted equivalent of the `/dev/create-server`
  phone simulator (no typeable build-code; the recipe file is handed straight
  to the app). It suggests a username, claims it for a fresh IRK, records an
  AuthCode, registers the RCK, and self-signs an **InstallBlob v2** with
  `diskEncryption:"none"` (so the loop needs no phone to unlock) and an
  owner-IRK-signed `debugGrant` sibling. Writes the issued-envelope recipe +
  a `.identity.json` sidecar (the IRK — never part of a recipe).

- **`VmE2E/`** — a headless runner that drives the EXACT production sources
  (`RecipeLoader` → `VMConfig.Plan` → `VMManager` → `QemuHost` → the
  duration-gated verdict): plan the VM, copy the remastered ISO into the
  bundle, `BeginInstall`, watch the lifecycle to a live state, then poll the
  public FQDN for a real-TLS response (the green padlock).

## Run it

```pwsh
# 0. Toolchain (once): .NET 8 SDK, QEMU (WHPX), xorriso via MSYS2.
winget install Microsoft.DotNet.SDK.8 SoftwareFreedomConservancy.QEMU MSYS2.MSYS2
C:\msys64\usr\bin\bash -lc "pacman -Sy --noconfirm xorriso"

# 1. Mint a recipe against prod (writes recipe.json + recipe.identity.json).
npx tsx apps/burner-windows/e2e/mint-recipe.ts out\recipe.json

# 2. Fetch + remaster the base ISO (the same CLI path the app's Host-here uses).
#    The manifest is live, so the base downloads to %LOCALAPPDATA%\flagship-burner\.
$env:Path = "C:\msys64\usr\bin;$env:Path"
npx tsx packages/flagship-burner/src/cli.ts prepare out\recipe.json `
    "$env:LOCALAPPDATA\flagship-burner\flagship-base-debian-13.5.0.iso" out\installer.iso --keep-recipe

# 3. Boot it end-to-end.
dotnet run --project apps/burner-windows/e2e/VmE2E -- out\recipe.json out\installer.iso out\vms
```

## What this run PROVED (2026-07-05, this box: Win11 Home, QEMU 11.0.50)

The host side is green end-to-end:

1. **Remaster on Windows** — after fixing xorriso (see the commit log), the CLI
   remasters the Debian netinst with the recipe preseed.
2. **WHPX boot** — the remastered ISO boots under `-accel whpx` (after masking
   VMX+SGX from the guest CPU so OVMF doesn't #GP; see `QemuCommandLine`).
3. **UEFI → GRUB → unattended d-i** — `BdsDxe` starts the USB-attached ISO, GRUB
   honors the injected preseed cmdline, and Debian installs unattended.
4. **The install seam** — the guest powered itself off cleanly at **6.7 min**;
   the **duration-gated verdict correctly classified it as success** (the exact
   ambiguity the Mac Phase-0 finding warned about, proven live), the ISO
   detached, and the guest **booted from its own disk** to `Running`.

Three Windows/WHPX-specific blockers were found live and fixed + regression-
pinned along the way: xorriso (missing + `C:\`-path parsing), the WHPX
VMX/SGX #GP, and the virtio-vs-USB disk-ordering trap that made d-i install
onto the installer stick.

## What is NOT yet proven — and why

The **in-guest first-boot provisioning** (clone → build → identity →
**register** → ACME → **serve**) did **not** complete: after first boot the guest
sits **idle at the `flagship-pod login:` prompt** (2.9% CPU), the FQDN never
resolved (`.com` never published DNS), and no phone-home beacons landed.

Crucially, this is **not** the VM host's job and **not** Windows-specific:

- Registration does **not** happen in the installer. `userdata.ts` (lines 26-35)
  is explicit: inside d-i's chroot `systemctl start` is a no-op, so the
  late_command only **`systemctl enable`s** the provisioning units, which are
  meant to fire on the **first real boot**. That first-boot chain is the
  daemon/bootstrap's own systemd mechanism, byte-identical to metal and the
  gym/Hetzner path.
- `userdata.ts` itself flags this path **"EXPERIMENTAL — brick risk on first
  boot"**, and the root `CLAUDE.md` lists **"registers → serves / green
  padlock"** under *pending owner validation* (needs a physical reburn). The
  idle box is consistent with the enabled units not firing on first boot.

A production/debug-**grant** box has **no console login** (root disabled, no
`debug` password until the daemon's `debugAccessGate` runs, and it never got
that far) and the installed GRUB/kernel is **video-only** (no serial getty —
`init=/bin/bash` over serial isn't reachable). To break in for diagnosis, bake a
dev SSH key at install time (below) — the CLI now threads it.

## Recommended next step (to finish the serve proof)

Make the box **inspectable** so the first-boot chain can be watched/driven:

1. **Bake a diagnostic dev SSH key** (now wired end-to-end). The CLI's
   `prepare`/`user-data` accept `--debug-ssh-key-file <pub>` (or
   `--debug-ssh-key "<key>"`), threaded into `buildDebianPreseed`
   /`buildAutoinstallUserData` → the `flagship` user's `authorized_keys`:

   ```pwsh
   ssh-keygen -t ed25519 -N '""' -f out\diag
   npx tsx packages/flagship-burner/src/cli.ts prepare out\recipe.json `
       "$env:LOCALAPPDATA\flagship-burner\flagship-base-debian-13.5.0.iso" `
       out\installer.iso --keep-recipe --debug-ssh-key-file out\diag.pub
   # boot (step 3 above), then, once the guest is up on its NAT'd loopback fwd:
   ssh -i out\diag -p <sshPort> flagship@127.0.0.1   # sshPort = QemuHost.SshPort
   ```

   This bootstrap is deliberately **non-provisioning** — it ONLY makes the box
   reachable (sshd + key, no LUKS re-key, no clone/build/register), so you drive
   + observe the serve loop **manually** and bake the fix back into the
   production bootstrap. It is the mechanism for chasing the first-boot bug, not
   a normal image.
2. OR give the VM host a **rescue-shell affordance** — it owns the disk + GRUB,
   so a host-driven "boot to a root shell" (append `init=/bin/bash`, or an
   overlay initrd) would let the app read `/var/log/flagship-bootstrap.log` and
   the enabled-unit state without weakening production (the guest's own security
   is unchanged; the host already fully controls the VM).
3. Then confirm whether the first-boot units actually fire under a VM boot, and
   whether `in-target systemctl enable` reliably drops the `.wants` symlinks —
   the userdata comment already flags this as needing live validation.
