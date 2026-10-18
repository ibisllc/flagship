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
