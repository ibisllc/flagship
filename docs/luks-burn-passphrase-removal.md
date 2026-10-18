# Removing the burn-time LUKS passphrase (GA close-out item 2)

Status 2026-10-17: **designed, not implemented.** The owner's rule for this
item was "verify live on the gym before landing, else land only the design".
It cannot be verified on the gym today (section 2), so no code changed.

## 1. What is live today

`BURN_PASSPHRASE = "flagship-build-time-luks-rekey-me-immediately"`
(`packages/flagship-builder/src/userdata.ts`) is a public constant. It is used
in four places:

| Where | Use | Outcome on the finished box |
|---|---|---|
| `preseed.ts` `debianCryptoStorageBlock` | `d-i partman-crypto/passphrase` (the preseed text sits on the USB stick / in the ISO) | **Slot survives** |
| `userdata.ts` `luksStorageBlock` | Ubuntu autoinstall `dm_crypt key:` (path kept in the engine, not the Debian default) | **Slot survives** |
| `userdata.ts` `buildLuksBootstrapBlock` | `luksAddKey` of the random key, then step C: `if false; then luksRemoveKey` (the "bring-up safety net") | **Never removed** |
| `appliance.ts` / `applianceFactory.ts` | The prebuilt VM appliance is published with the constant as its factory key; first-boot specialization re-keys and `luksRemoveKey`s `/etc/flagship/appliance-build.key` | Removed, but the removal is unverified, and it runs after the bootstrap that already (by design) keeps the slot |

So today a box installed from a USB stick (or a Studio ISO-fallback VM) keeps a
LUKS keyslot that any reader of this repository can open: the disk is
effectively unencrypted against anyone holding the disk. VM appliances end up
with only the real slot if specialization completes.

Every builder (macOS/iOS JavaScriptCore, Android Rhino, Windows Jint, Linux and
the Node CLI) runs the **same** bundle, `packages/flagship-builder/engine/
preseed-engine.js`, plus golden vectors (`engine/golden/preseed-vectors.json`
and its two vendored copies). There is one implementation to change and one
vector set to regenerate; no Swift/Kotlin/C# port of the LUKS text exists.

The legacy netboot path (`packages/installer-netboot/`, placeholder
`flagship-firstboot-placeholder`, "warning: placeholder LUKS slot remained")
ships nowhere (open item 12) and should be deleted rather than fixed.

## 2. Why this could not be verified live

The gym fleet (`tools/live-e2e/shared-run.ts`, `/api/gym/provision`) creates
cloud boxes through the cloud-init-direct path
(`packages/control-plane/src/demoCloudConfig.ts`,
`docs/cloud-init-direct-provisioning.md` "LUKS trade-off (a)"): the root disk
is **not encrypted**, there is no LUKS container, so `cryptsetup luksDump` on a
gym box proves nothing about this change. The only LUKS installs are the
debian-installer preseed path (USB stick, Studio VM) and the VM appliance, and
the gym has no lane that boots either. Spending gym fleet runs would also
not help: the zone peaks near 194 of 200 DNS records in a full run.

## 3. Design (smallest safe change)

Invariant to enforce: **when the install finishes, `cryptsetup luksDump` shows
exactly one enabled keyslot, and it is the random key the phone holds sealed.**
If that cannot be shown, the install fails loudly.

1. **No constant anywhere.** Delete `BURN_PASSPHRASE`. The engine never
   renders a passphrase; it renders a *source* for one.
2. **Debian preseed (the shipping path).** The burn-time passphrase is
   generated *inside the installer*, per install:
   - `preseed/early_command` (already composed by `partmanEarlyCommand` /
     the beacons) gains: generate 48 random alphanumerics with
     `tr -dc A-Za-z0-9 </dev/urandom | head -c 48` into
     `/tmp/flagship-luks-burn` (mode 600, installer RAM), then
     `debconf-set partman-crypto/passphrase "$P"` and
     `partman-crypto/passphrase-again`. The two `d-i partman-crypto/passphrase
     password ...` lines are removed from the preseed, so nothing about the
     passphrase is on the stick.
   - `late_command` copies `/tmp/flagship-luks-burn` to
     `/target/var/flagship/luks-burn.key` (0600; the target root is already the
     LUKS volume) before the in-target bootstrap.
3. **Bootstrap (`buildLuksBootstrapBlock`)** reads the key *file*
   (`LUKS_BURN_KEYFILE`, default `/var/flagship/luks-burn.key`) with
   `--key-file`, not a baked string. Step C stops being `if false`:
   1. `luksAddKey` the random key (existing step A), and seal + upload it
      (existing step B) first, so every failure before removal stays
      recoverable.
   2. `cryptsetup luksRemoveKey "$ROOT_LUKS_PART" --key-file "$LUKS_BURN_KEYFILE"`.
   3. **Verified removal, fail loud**, as one shared shell function
      (`flagship_assert_single_luks_slot`) exported from `userdata.ts`:
      - `cryptsetup open --test-passphrase --key-file "$LUKS_BURN_KEYFILE"`
        must **fail**;
      - `cryptsetup open --test-passphrase --key-file "$LUKS_KEY"` must
        **succeed**;
      - the enabled keyslot count from `cryptsetup luksDump` (LUKS2
        `N: luks2` lines, LUKS1 `ENABLED`) must be exactly **1**.
      Any failure prints `[flagship-bootstrap] FATAL: ...` and `exit 1`
      (the install is flagged failed; the sealed key is already stored, so the
      box is consistent and re-installable).
   4. `shred -u` the burn key file and the random key file.
4. **Ubuntu autoinstall.** `dm_crypt key:` becomes `keyfile: /tmp/luks-burn`,
   written by an autoinstall `early-commands` entry with the same generator, and
   copied into the target by a late command. (If this path is dead for
   shipping, delete it instead; decide in the same change.)
5. **VM appliance.** The factory image keeps its *published* factory key by
   design (it contains no owner data; first specialization replaces it), but it
   is renamed `APPLIANCE_FACTORY_KEY` and lives only in `appliance*.ts`, so
   `release-guard.sh` can tell a factory key from a backdoor. The bootstrap in
   `FLAGSHIP_APPLIANCE_PREINSTALLED=1` mode uses
   `/etc/flagship/appliance-build.key` as `LUKS_BURN_KEYFILE` and removes it
   itself (step 3), so the specializer's later unguarded `luksRemoveKey` of the
   same key must become a **conditional** (`--test-passphrase` first) followed
   by the same `flagship_assert_single_luks_slot`, otherwise it would abort on
   "no key available".
6. **Guard.** `scripts/release-guard.sh`: drop the `BURN_PASSPHRASE` finding and
   instead fail every build (dev too, like the debug-password finding) if the
   string `flagship-build-time-luks` or `if false; then` next to a
   `luksRemoveKey` reappears, or if `flagship_assert_single_luks_slot` is not
   called after `luksRemoveKey` in `userdata.ts`. Update
   `scripts/release-guard.test.ts` (today it asserts the constant is *found*).
7. **Existing boxes.** A box already installed from a USB stick keeps the old
   slot until reburned. Optional follow-up for an endorsed update: a boot-time
   scrub that tests the old constant with `--test-passphrase` and, if it opens,
   `luksRemoveKey`s it (removal needs only that passphrase, not another key;
   refuse if it would leave zero other slots). That scrub must carry the
   constant, so it needs its own release-guard exemption and an end date.

Box-side: the bootstrap and preseed live in the builder, not the daemon, so
this reaches new installs through new Studio/phone builds and a republished
VM appliance (`vm-appliance.yml`); existing boxes only through item 7.
Clients: no wire or UI change. The engine bundle, `apps/builder-mac/.../
Resources/preseed-engine.js`, `apps/mobile/android/app/src/main/assets/
preseed-engine.js` and the three golden-vector copies are regenerated together
(`cd packages/flagship-builder && npm run bundle:engine`, then
`node scripts/genGoldenVectors.mjs`, then copy as the engine README says).

## 4. Test plan (all must pass before landing)

Unit / vector (no hardware):
1. `packages/flagship-builder/tests/preseed.test.ts`: the encrypted preseed
   contains no `partman-crypto/passphrase password` line and no constant;
   `early_command` contains the generator and both `debconf-set` calls;
   `late_command` copies `/tmp/flagship-luks-burn` before the bootstrap.
2. `tests/userdata.test.ts`: the bootstrap reads `LUKS_BURN_KEYFILE`, has no
   `if false`, calls `luksRemoveKey --key-file`, then
   `flagship_assert_single_luks_slot`; ordering test: add key < seal+upload <
   remove < assert < shred.
3. A shell test that runs `flagship_assert_single_luks_slot` against a stub
   `cryptsetup` (slot table in a temp file) for: success; burn key still opens;
   real key doesn't open; two slots enabled; luksDump unreadable. Each failure
   must exit non-zero with a FATAL line.
4. Regenerate the vectors; `swift test` (PreseedEngineTests),
   `:app:testDebugUnitTest` (PreseedEngineTest), `dotnet test`
   (NativePreseedEngineTests) and `npx vitest run packages/flagship-builder`
   all byte-identical.
5. `scripts/release-guard.test.ts` updated: the real repo is clean under
   `RELEASE=1`; each reintroduction fails.

Real cryptsetup, no gym needed (catches the d-i unknowns):
6. A local QEMU d-i install (the 2026-05-24 recipe in the preseed comments)
   with the new preseed, then in the installed VM:
   `cryptsetup luksDump /dev/vda3` (or the partition `blkid -t TYPE=crypto_LUKS`
   names) shows **one** enabled slot; `--test-passphrase` with the sealed key
   passes; the install log shows the assert line. Also prove the two d-i
   unknowns: `debconf-set` in `early_command` really feeds partman-crypto,
   and `tr`/`head` on `/dev/urandom` exist in the d-i busybox.
7. The same with a deliberately broken removal (stub `luksRemoveKey` to fail):
   the install must end failed, not green.

Live (the owner's rule; needs a lane the gym lacks today):
8. **Add a gym "burn" lane**: boot a gym UpCloud server from the personalized
   debian ISO (UpCloud can attach a CD-ROM storage) through `/api/gym/provision`
   with `encryptRoot`, auto-unlock mode, and the gym debug-access grant, then
   from the fleet tooling (`tools/live-e2e/fleet-cli.ts` over the debug-access
   SSH path in the runbook) run `cryptsetup luksDump` on the root and assert:
   exactly one enabled keyslot, the old constant fails `--test-passphrase`,
   the box registers and serves a green padlock, and the phone-sealed key opens
   it through the unlock relay on reboot. Tear down through
   `/api/gym/teardown`; budget the DNS (one box, one account).
9. VM appliance: republish through `vm-appliance.yml`, host one on a Mac,
   `luksDump` over debug access, same assertions.

## 5. Owner decisions needed

- Approve a gym burn lane (item 8) or accept item 6 plus a hardware run
  (`docs/runbooks/device-test-agent.md`) as the live proof.
- Delete the Ubuntu autoinstall and netboot paths, or keep and fix them.
- Whether to ship the scrub for already-installed boxes (item 7 of section 3).
