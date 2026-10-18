# LUKS install-time key: real d-i proof in QEMU

Proves, with a real debian-installer run, that the install-time LUKS passphrase is
generated inside the installer, that the bootstrap's key removal leaves exactly one
key slot, and that a failed removal does not let the install finish.

Needs: `qemu-system-aarch64` (HVF on an Apple-silicon Mac; ~4-5 min per install), the
Debian arm64 netinst ISO pinned in `packages/flagship-builder/src/distros.ts`, `xorriso`,
`npx tsc -b`, 12 GB of disk.

```sh
W=/some/dir; mkdir -p $W/k
node tools/luks-di-qemu/make-iso.mjs ok     debian-13.6.0-arm64-netinst.iso $W/ok.iso
node tools/luks-di-qemu/make-iso.mjs broken debian-13.6.0-arm64-netinst.iso $W/broken.iso
xorriso -osirrox on -indev $W/ok.iso -extract /install.a64/vmlinuz $W/k/vmlinuz -extract /install.a64/initrd.gz $W/k/initrd.gz
WORK=$W bash tools/luks-di-qemu/run-install.sh ok $W/ok.iso        # serial log: $W/ok.serial.log
WORK=$W python3 tools/luks-di-qemu/stage2.py                       # boots the installed disk: old key refused, new key unlocks
WORK=$W bash tools/luks-di-qemu/run-install.sh broken $W/broken.iso # must print INSTALL FAILED and keep running
```

Expected in `ok.serial.log`: `luksDump` shows slot 0 before, slots 0+1 after the add,
slot 1 only after, `LUKS verified: exactly 1 enabled key slot`, `ENABLED-SLOT-COUNT=1`,
then power off. For `broken`: `FATAL: could not remove the install-time LUKS key` and
`*** FLAGSHIP INSTALL FAILED ***`, and the VM stays up.

The test bootstrap replaces only the heavy middle of the real bootstrap (clone, build,
register); the early_command passphrase generator, debconf handoff, late_command copy
and the step A/C shell are the production text. The full bootstrap against a gym `.com`
is exercised by the live lane (`tools/live-e2e/lanes/`).
