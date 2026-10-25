# Boot chain refresh

A box's disk unlock runs in its initramfs, before the encrypted root exists. Until 0.3 the pieces
that make up that unlock were written once, at install, and nothing in the update path touched
them again: an installed box's boot unlock was frozen. From 0.3 an endorsed update carries them,
and the box adopts them only after a one-time test boot has proved they unlock it.

Code: `packages/boot-chain` (the generator), `packages/server-daemon/src/bootChainRefresh.ts` (the
refresh), setup step `boot-chain` (`setup.ts`, privd `SETUP_STEPS`, Rust broker `policy.rs`),
wiring in `index.ts`. Drill: `tools/boot-chain-drill/drill.sh`.

## The pieces, and their one source

| Piece | Path on the box | Mode | Made by |
|---|---|---|---|
| Unlock hook (stages the helper, tools, CA bundle, TPM tools, `/boot` facts) | `/etc/initramfs-tools/hooks/flagship-unlock` | 0755 | `buildUnlockHookScript()` |
| Unlock premount | `/etc/initramfs-tools/scripts/local-top/flagship-unlock` | 0755 | `buildUnlockPremountScript(hosts)` |
| Wi-Fi hook (Wi-Fi installs only) | `/etc/initramfs-tools/hooks/flagship-wifi` | 0755 | `buildWifiHookScript()` |
| Wi-Fi premount (Wi-Fi installs only) | `/etc/initramfs-tools/scripts/init-premount/flagship-wifi` | 0755 | `buildWifiPremountScript(ssid, psk)` |
| Unseal helper | `/boot/flagship-unseal` | 0755 | the release's `installer/flagship-unseal` |

`bootChainScripts(inputs)` in `@flagship/boot-chain` returns the four scripts. The installer
(`userdata.ts buildLuksBootstrapBlock`, every Studio and the phone through the engine bundle)
writes exactly these strings through quoted heredocs (`heredocWrite`); the refresh writes the same
strings. `packages/flagship-builder/tests/bootChainIdentity.test.ts` runs the bootstrap's heredocs
through a real shell and requires byte-identical files, also after reading them back as the
refresh does. The CA bundle, cryptsetup, lvm, openssl, curl, xxd, tpm2-tools and the NSS modules
are the system's own; the hook copies them into each build, so a rebuild picks up their updates.
The `/boot` facts (boot key, server domain, boot host, unlock mode, owner key, lease key) are box
data, not release pieces, and the refresh never writes them.

Per-box inputs are read back from the box's own root-owned scripts: the premount's
`APPROVED_BOOT_HOSTS` line (the release's list first, then any host the box was installed with
that the release does not list) and the Wi-Fi premount's `WIFI_SSID` / `WIFI_PSK` lines. A Wi-Fi
script whose lines can't be read back is left exactly as it is.

## Who runs it, and what it trusts

The daemon (unprivileged) asks privd for setup step `boot-chain` (name only; any argument is
refused). privd runs `node /opt/flagship/packages/server-daemon/dist/setup.js boot-chain` as root.
The step:

- generates the scripts with the release's own `@flagship/boot-chain` code;
- reads the helper from `/opt/flagship/installer/flagship-unseal` only after checking every
  component of its real path, and of the generator module's real path, is owned by root and not
  writable by group or others (`assertRootOnly`); a release tree that fails this, or an installed
  script that is not root's own, is refused and nothing changes;
- never reads `/var/flagship` (the daemon's state); its own state is
  `/var/lib/flagship-bootchain/` (root, 0700): `state.json`, the known-good initrd copy, the
  journal's backups and the build's scratch copy.

The daemon calls it when the update gate's outcome is `none` (no update waiting) or `committed`
(this boot verified an update), after the daemon reports healthy (tunnel up and a signed
heartbeat), on every start. So it runs after every applied update and on the first boot of every
box, and is a no-op whenever nothing changed. A daemon that still runs as root calls the same
code in-process.

## One run

1. **Recover**: a journal left by an interrupted run puts every file it had replaced back.
2. **Trial in progress?**
   - This boot's command line carries the trial's token → **promote** (below).
   - The box rebooted (new boot id) without the token, on the same kernel → the trial did not bring
     the box up: drop it, record the release's digest as failed, Activity
     `server.bootchain.rolled-back`.
   - Same boot → nothing (`trial-pending`). A newer release replaces a waiting trial.
3. **Installed pieces equal the release's** (bytes, mode, root-owned) → nothing; keep a copy of
   the initrd this boot came up on as the known-good copy (only one built before this boot began).
   This is how the first boot of a box establishes its known-good copy.
4. **A digest that already failed** → nothing until a release changes the pieces again.
5. **Stage**:
   - preconditions: the running kernel is the newest installed (else wait for the restart into
     it), the tools exist, `grub.cfg` sources `custom.cfg` and honours `next_entry`, `custom.cfg`
     is absent or ours, the running command line can be repeated safely, `/boot` has room for a
     second initrd;
   - copy `/etc/initramfs-tools` to the scratch dir, write the release's scripts into the copy,
     put the release's helper at `/boot/flagship-unseal` for the build (journalled),
     `mkinitramfs -d <copy> -o <scratch> <kernel>`, put the old helper back;
   - fail on a non-zero build or any `flagship-unlock hook:` line; check the image with
     `lsinitramfs -l`: the premount (and Wi-Fi premount) at their exact sizes, the helper at its
     exact size, and what the hook refuses to build without (merged-`/usr` paths accepted);
     record a digest of the unpacked image (`unmkinitramfs`: every path, type, mode, link target
     and file hash);
   - write the image to `/boot/flagship-initrd-trial.img` and `/boot/grub/custom.cfg` (below),
     then `grub-reboot flagship-bootchain-trial` and confirm `next_entry` in `grubenv`.
   Nothing the default boot uses has changed: `/etc` holds the old scripts, `/boot/flagship-unseal`
   the old helper, `initrd.img-<kernel>` the old image. A failure at any point drops the scratch
   copy and the trial and is reported once as `server.bootchain.rolled-back`.
6. **Promote** (on the trial's boot, healthy): journal backups of every piece, the default initrd
   and initramfs-tools' record of it; write the pieces to `/etc` and `/boot`;
   `update-initramfs -u -k <kernel>`; `sync`; the rebuilt image must pass the same `lsinitramfs`
   check and unpack to exactly the trial's digest (so the new default is, file for file, the image
   that just booted). Any failure puts every backup back (old scripts, helper, default initrd) and
   records the release as failed. Success removes the trial image and `custom.cfg`, keeps the
   replaced initrd as the known-good copy until the new default has itself booted, and notes
   `server.bootchain.refreshed`.

## The GRUB mechanism

The trial entry lives in `/boot/grub/custom.cfg`, which Debian's `41_custom` sources at boot (no
`update-grub` run, nothing in `/etc/grub.d` changes):

```
# Flagship boot chain trial (bootChainRefresh.ts): removed once the trial is decided.
menuentry 'Flagship start-up check' --id flagship-bootchain-trial {
	insmod part_gpt
	insmod part_msdos
	insmod ext2
	insmod gzio
	search --no-floppy --fs-uuid --set=root <UUID of the filesystem holding /boot>
	linux /vmlinuz-<running kernel> <running command line> panic=30 flagship.bootchain=<token>
	initrd /flagship-initrd-trial.img
}
```

The kernel path and arguments come from this boot's `/proc/cmdline` (`BOOT_IMAGE` and the rest,
minus any earlier `panic=` and token), so the trial differs from the default entry only in its
initrd, `panic=30` and the token. `grub-reboot` writes `next_entry` to `/boot/grub/grubenv`;
Debian's `00_header` loads it, boots that entry once and clears it (`save_env`) before booting, so
the next restart after that is the default entry again whatever happens in between. This is the
same on BIOS (`grub-pc`) and UEFI (`grub-efi-*`, removable or not): Debian boxes have `/boot` as a
plain ext4 partition and both platforms read `/boot/grub/grub.cfg` and `grubenv` from it (the EFI
stub's config only sets `prefix` there), and GRUB can write `grubenv` on ext4. The token proves to
the promote step that this boot used the trial; `/proc/sys/kernel/random/boot_id` tells a later
boot from the one that staged it.

`panic=30` makes the initramfs (`scripts/functions panic`) and the kernel reboot 30 seconds after a
panic instead of waiting at a shell, so a trial whose initramfs fails returns to the default entry
by itself.

## Failure modes

| What goes wrong | What happens |
|---|---|
| The build or its check fails | The trial is never set up; nothing the box boots from changed. Reported once. |
| The trial's initramfs panics, or the kernel does | Reboot after 30 s into the default entry; the next run sees the box came up without the token and drops the trial. Reported once. |
| The trial waits forever (a premount that hangs, or falls through to cryptsetup's passphrase prompt, which no one can answer: the disk has one random key) | The box stays down until it is restarted (the power button, Studio's Restart, the host's restart). Any restart boots the default entry, because `next_entry` was cleared when the trial started. The owner sees the box offline meanwhile. Not automatic. |
| The trial unlocks but the daemon never reports healthy | No promotion. The next restart is the default entry and the trial is recorded as failed (it may have been the release, not the chain). |
| A restart during the trial boot before the daemon is healthy (power loss, owner restart) | As above: counted as a failed trial for that release; the next release that changes the chain tries again. |
| An `approve` box's trial waits for the phone | As every boot: the owner approves on the phone and the trial goes on. |
| Power loss while staging | The default boot is untouched; the journal puts the old helper back on the next run. |
| Power loss while promoting | `update-initramfs` renames its new image into place and the step syncs, so the default initrd is the old one or the new one; the journal restores the old scripts, helper, initrd and initramfs-tools record on the next run. A rename torn by the filesystem would leave a box that cannot boot (the narrowest remaining window). |
| The rebuilt default differs from the trial (a package changed in between) | Old pieces and initrd put back, release recorded as failed. |
| A newer kernel is installed but not running | Staging waits for the restart into it. A kernel installed after staging makes the trial (which pins the running kernel) stale; it is dropped without blame and rebuilt for the new kernel. |
| `custom.cfg` holds someone else's entries, `grub.cfg` lacks `41_custom` or `next_entry`, the command line has a character GRUB can't carry, `/boot` is short of space, a tool is missing | No trial; reported once; the box keeps its chain. |
| A release removes a host from the default list | The box keeps it (it can't tell a removed default from a host it was installed with). |
| Kernel package updates between refreshes | They rebuild with the scripts in `/etc`, which only ever hold a chain that passed its trial. |

## Activity

`server.bootchain.refreshed` ("Updated how this server unlocks at start-up") and
`server.bootchain.rolled-back` ("Kept the previous start-up unlock", shown as a warning), with the
box's own sentence as detail. Labels in the webapp (`lib/activityFeed.js`, shell v181), iOS
(`ActivityViewModel.swift`) and Android (`BoxEventLabels.kt`), drafts in es, fr, de, pt-BR, ja,
zh-Hans.

## Tests and drill

- `packages/server-daemon/tests/bootChainRefresh.test.ts`: fakes of the box (files, initramfs
  tools, GRUB): unchanged → no-op and a known-good copy; changed → stage, trial boot, promote; a
  failed check, a failed hook, a failed promotion check, a rebuild that differs, a throwing
  promotion and a power cut each put everything back; a trial the box didn't come up on is dropped
  and not retried; daemon-writable or non-root sources are refused with nothing changed; exact
  modes under a 0077 umask (the real writer); the `lsinitramfs` parser, the GRUB command line and
  kernel ordering.
- `packages/flagship-builder/tests/bootChainIdentity.test.ts`: installer and refresh write
  byte-identical pieces (wired, auto, an extra boot host, Wi-Fi with shell characters).
- `packages/privd/tests/corpus.ts` (+ vectors, Rust `privd_conformance`): the step by name only.
- `tools/boot-chain-drill/drill.sh`: a Debian 13 VM with the real hook and premount: install
  v1, stage v2 (one more approved boot host, so the premount's log shows which one ran), reboot
  into the trial, promote, reboot on the default; stage v3 (v2 plus an init-premount that
  panics), reboot, and check it panicked, fell back to v2 by itself and was rolled back. Backends:
  UpCloud amd64 (BIOS, `grub-pc`, `/boot` on the root filesystem) and local QEMU arm64 (UEFI,
  `grub-efi-arm64`, `DRILL_BACKEND=qemu`). Neither VM has an encrypted root, so the premount stops
  at its LUKS check; a real phone-approved unlock through a trial is still to be drilled on a
  box.
