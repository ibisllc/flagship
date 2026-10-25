# feat/other-os-installers

`main` + the installer paths `main` shed on 2026-10-18 (owner decision), kept for a
possible multi-OS effort. `main` ships Debian's debian-installer only; nothing on
`main` depends on this branch.

## What is here

- Ubuntu subiquity autoinstall: `buildAutoinstallUserData` (packages/flagship-builder
  `src/userdata.ts`), the NoCloud remaster (`src/remasterIso.ts`
  `remasterIsoWithAutoinstall`, `editGrubCfgForAutoinstall`), the `ubuntu` entry in
  `src/distros.ts`, the engine entry `buildUserDataFromRecipe`, and the Swift
  (`Remaster.swift`, `UserData.autoinstallYAML`), Kotlin and C# (`NativeIsoRemaster.cs`)
  ports.
- Debian netboot installer: `packages/installer-netboot/`,
  `scripts/build-flagship-netboot-iso.*`, `docs/installer-netboot.md`, the
  `FLAGSHIP_NETBOOT_ISO_*` wrangler vars.

## State of the install-time LUKS passphrase (read before reviving)

The public constant (`BURN_PASSPHRASE`, `flagship-build-time-luks-rekey-me-immediately`)
and the netboot placeholder (`flagship-firstboot-placeholder`) are REMOVED from these
paths, following `docs/luks-burn-passphrase-removal.md`:

- Ubuntu autoinstall: an `early-commands` entry generates 48 random alphanumerics into
  `/tmp/flagship-luks-burn`, the curtin `dm_crypt` entry uses `keyfile:` pointing at it,
  and a late-command copies it to `/var/flagship/luks-burn.key` before the bootstrap,
  which removes that slot and asserts exactly one key slot (same bootstrap as Debian).
- Netboot preseed: `partman/early_command` generates the passphrase (same generator as
  main), `late_command` copies it into `/root/flagship-luks-burn`, and `late-command.sh`
  uses it instead of the placeholder and shreds it after the rotation.

**None of this was run or tested** (owner: "simply removed without debugging/testing").
Only the unit tests of the builder package pass, with updated pins. Expect to debug
curtin's `keyfile:` handling, the netboot `debconf-set` + seen flags (main's d-i path
needed them) and the Ubuntu early-commands environment. The Debian path on `main` has
the real proof (`tools/luks-di-qemu/`, `tools/live-e2e/lanes/luks-burn.ts`) and the
fixes for the BIOS speech-installer timeout and the CD apt source; none of the other
installers here has them checked.

Rebase onto `main` when it moves (`scripts/rebase-features.sh`).

## Against release/0.3's install model (rebased 2026-10-25)

release/0.3 installs a box only from a signed box artifact (`release/box-release.json`,
`installer/install-box-artifact.sh`): an exact commit, threshold and PQ signatures, no git
clone and no npm on the box.

- **Ubuntu autoinstall: fits.** `buildAutoinstallUserData` runs the release's
  `buildBootstrapScript` with `family: "ubuntu"`, so it pins an exact commit, installs the
  signed artifact and uses the generated initramfs premount (`unlockPremount.ts`), which
  opens any `crypto_LUKS` partition under its crypttab name; on a plain (non-LVM) root its
  `vgchange -ay` is a no-op. The `family` default is Debian so every Debian output stays as
  on the release. Still untested on a real Ubuntu install, as before. The autoinstall's
  package list is the old one (no `openssl`, `tpm2-tools`, `cryptsetup-initramfs`, which
  the Debian preseed now installs); check them before a live run.
- **Debian netboot: does not fit.** `packages/installer-netboot/late-command.sh` is the
  old `installer/install.sh` port: it `git clone`s `FLAGSHIP_INSTALLER_GIT_REF` (a branch
  name is accepted) and runs `npm ci`, and its preseed installs `nodejs npm git`. Reviving
  it means replacing that with the release bootstrap or `install-box-artifact.sh` fed from
  the trailer (exact commit, artifact digest and the release's trust keys), and dropping
  the branch-name refs. Kept verbatim here; its unit tests pass, but it bypasses the
  artifact checks entirely and must not ship as is.
