# Removing the burn-time LUKS passphrase (GA close-out item 2)

Status 2026-10-18: **built on `main` for the USB/ISO debian-installer path and
proved in a real d-i run in QEMU** (section 4). The live UpCloud proof is in
section 5. Owner decisions of the same day: the legacy Ubuntu autoinstall and
Debian-netboot installer paths left `main` (branch `feat/other-os-installers`);
already-installed servers are not scrubbed (they age out); a pre-GA user scrub is
a separate runbook (`docs/runbooks/pre-ga-scrub.md`).

## 1. What changed

Before: `BURN_PASSPHRASE = "flagship-build-time-luks-rekey-me-immediately"` was
a public constant in the preseed on the stick, and the bootstrap's
`luksRemoveKey` sat behind `if false`, so every USB-installed box kept a slot
anyone reading this repository could open.

Now, per install:

1. `partman/early_command` (preseed.ts, `luksBurnKeyCommand`) generates 48
   random alphanumerics inside the installer (`tr -dc A-Za-z0-9 </dev/urandom |
   head -c 48`), length-checked (`exit 1` otherwise), writes them 0600 to
   `/tmp/flagship-luks-burn` (installer RAM), hands them to partman-crypto with
   `debconf-set` and marks both questions **seen** through d-i's
   `debconf-set-selections` (without the seen flag partman-crypto still prompts
   at critical priority: found in the QEMU run). The preseed carries no
   passphrase line and no constant. A debug image (dev-only SSH stub) is built
   unencrypted, because it never re-keys.
2. `late_command` copies the file to `/var/flagship/luks-burn.key` on the target
   (already the new LUKS volume) before the in-target bootstrap, and deletes the
   RAM copy only after the bootstrap succeeds.
3. The bootstrap (`buildLuksBootstrapBlock`, userdata.ts) adds the random
   phone-sealed key with `--key-file /var/flagship/luks-burn.key`, seals and
   uploads it, then (step C, `buildLuksBurnSlotRemovalBlock`): proves the new
   key opens the disk, runs `cryptsetup luksRemoveKey ... --key-file`, then
   `flagship_assert_single_luks_slot`: the removed key must no longer open the
   disk, the new key must, and `luksDump` must show exactly **one** enabled slot
   (LUKS2 and LUKS1 formats). Any failure prints `[flagship-bootstrap] FATAL:`
   and exits 1. Success reports `sealing` "Disk key secured: one unlock key slot,
   install key removed" to the order-status channel and shreds both key files.
4. **A failed bootstrap no longer looks like a finished install.** The old
   late_command ended `A && B && beacon || true || ( exit 1 )`: the beacon's own
   `|| true` swallowed every failure, so a failed install powered off exactly like
   a good one (found in QEMU; d-i does not stop on a failed late_command in the
   text or the newt frontend either). The beacon is now grouped, and the failure
   branch prints the FATAL lines and `*** FLAGSHIP INSTALL FAILED ***` on the
   console and holds there instead of powering off. The phone shows `error`
   (the bootstrap's exit trap) and never gets `installed`.
5. VM appliance: unchanged by design. Its published factory key
   (`APPLIANCE_FACTORY_KEY`, appliance.ts) is replaced on first boot; the
   bootstrap uses `/etc/flagship/appliance-build.key` there and leaves its removal
   to the specializer, which now also proves the new key opens the disk, removes
   the factory slot, runs the same single-slot assertion and only then deletes the
   key file. An already published appliance keeps working with the new bootstrap
   (its old specializer still removes the key itself); republish the appliances to
   get the verified removal (`vm-appliance.yml`).
6. `scripts/release-guard.sh` fails EVERY build (dev too) if a constant
   passphrase or a `flagship-(build|burn)-time-luks` string returns, if
   `if false; then` appears in the builder sources, or if userdata.ts adds a LUKS
   key without a `luksRemoveKey` followed by `flagship_assert_single_luks_slot`.
   `RELEASE=1 scripts/release-guard.sh` is green for this item.

Engine bundle, the Mac/Android copies and the golden vectors are regenerated
(`bash` steps in `packages/flagship-builder/engine/README.md`). No wire or UI
change. Already installed boxes keep the old slot until reburned (not scrubbed,
owner decision).

## 2. Tests

- Unit: `packages/flagship-builder/tests/preseed.test.ts`, `userdata.test.ts`,
  `appliance.test.ts` (no passphrase line or constant; generator and handoff in
  `early_command`; ordering add < seal+upload < remove < assert < shred; failure
  branch).
- Shell: `tests/luksSingleSlot.test.ts` runs the real shell text under bash with a
  stub `cryptsetup`: success, burn key still opens, new key does not open, two
  slots, unreadable `luksDump`, failed `luksRemoveKey`, appliance mode.
- Guard: `scripts/release-guard.test.ts`.
- Vectors: `vitest run packages/flagship-builder` (TS), Swift
  `PreseedEngineTests`, Android `PreseedEngineTest` and the Windows
  `NativePreseedEngineTests` read the same regenerated vectors.

## 3. Not covered

- The full bootstrap (clone, build, register, seal upload) is exercised by the
  live lane (section 5), not by QEMU.
- x86 (amd64) d-i was not run in QEMU; the QEMU proof is arm64 d-i under HVF.
  The d-i parts used (busybox `tr`/`head`, `debconf-set`, `debconf-set-selections`,
  partman-crypto) are architecture independent.

## 4. QEMU d-i proof (2026-10-18)

`tools/luks-di-qemu/` (README there). Debian 13.6.0 arm64 netinst, the real
generated preseed, a harness bootstrap that runs the real step A and C text.
Results (serial log excerpts):

- `luksDump` before: slot 0 only (the generated passphrase, 48-byte key file).
- After `luksAddKey`: slots 0 and 1. After the removal: slot 1 only,
  `LUKS verified: exactly 1 enabled key slot on /dev/vda4`, `ENABLED-SLOT-COUNT=1`.
- Booting the installed disk (UEFI): `Please unlock disk vda4_crypt:` refuses
  the install-time key (`No key available with this passphrase.`) and accepts the
  new key, reaching `flagship-pod login:`.
- Forced `luksRemoveKey` failure: `FATAL: could not remove the install-time LUKS
  key`, then `*** FLAGSHIP INSTALL FAILED ***`, and the VM stays up (it does not
  power off).
- d-i unknowns resolved: `tr`/`head` on `/dev/urandom` and `debconf-set` exist in
  the d-i busybox; `debconf-set` alone is NOT enough (the passphrase is still
  asked) and the seen flags fix it.

## 5. Live proof (UpCloud, 2026-10-18)

`tools/live-e2e/lanes/luks-burn.ts`, a limited lane (not the full gym): mint a gym
account and signed recipe, build the REAL preseed, remaster the pinned amd64
Debian 13.6.0 netinst ISO, upload it to an UpCloud storage, boot a server from it
(2xCPU-4GB, empty 40 GB disk, `flagship-env=gym`), and read the gym `.com` order
status until the one-slot detail appears. It stops there, then destroys the server
through the gym teardown, deletes the ISO storage and checks the gym is back to
base. The installer's progress beacons (hard-coded to the production control plane)
are blackholed in the installer, so the lane never contacts production.

Result of the run that passed (`swift-dingo`): the unattended install ran the real
bootstrap on the server: `downloading` 17:05:16Z, `registering` 17:05:31Z (against
the gym `.com`), `sealing` 17:06:01Z, then `sealing` with detail "Disk key secured:
one unlock key slot, install key removed" at 17:06:16Z. That detail is only sent
after `flagship_assert_single_luks_slot` passed on the server's own disk, so it is
the one-slot evidence. Cleanup: server destroyed, 12 DNS records deleted (one
account, one box), ISO storage gone; gym before and after: 0 servers, 0 DNS records;
whole `flagship.services` zone 166 records before and after.

The first lane attempts found two real bugs, fixed in the same change:

- **BIOS boot never ran the preseed.** The Debian ISO's `spkgtk.cfg` carries
  `timeout 300` + `ontimeout <speech installer>` and is included last, so the
  remaster's `timeout 1` lost and a BIOS boot landed in the accessible installer
  (speech synthesis, language menu, no preseed) after 30 s. `editIsolinuxCfgForPreseed`
  now points `ontimeout` at the plain installer and the remaster also patches
  `spkgtk.cfg` and `spk.cfg` (TS, Swift, C#). UEFI boots (grub) were not affected.
- **apt hung on the install CD.** d-i leaves an active `deb cdrom:[...]` line in
  the target's sources.list; with the install medium as a CD-ROM device the
  bootstrap's first `apt-get` started apt's cdrom method, which waits for the disc
  for ever (the install sat at "Running preseed..." for 30+ minutes). late_command
  now deletes the line before the bootstrap.

Re-run it with `set -a; source .gym-secrets.env; set +a; npx tsc -b && npx tsx
tools/live-e2e/lanes/luks-burn.ts` (about 8 minutes once the ISO is cached;
`tools/live-e2e/lanes/vnc-screenshot.py` shows the server console if a run stalls).
It refuses to start while the gym has any server, and the gym.lock rule applies.
