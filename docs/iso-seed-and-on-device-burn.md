# ISO seed + on-device USB burn

How a phone (or the desktop burner) turns a USB stick into a Flagship box
**without remastering an ISO on-device**, and how the base image is derived,
delivered, and verified transparently.

## The problem

Turning a recipe into a bootable installer normally means *remastering* a
Debian netinst ISO: editing `/boot/grub/grub.cfg` and the isolinux configs
inside the ISO9660 filesystem to auto-preseed, injecting the preseed, and
rebuilding the El Torito / isohybrid boot equipment. That is a full
read-modify-write of an ~800 MB image via `xorriso` (a native C library). A
phone can't cheaply do it, and it's the reason the desktop burner shells out to
the Node CLI's `remasterIso.ts`.

## The design: pre-baked seed + appended partition

We split the work so the phone never touches the ISO9660 structure:

1. **The seed** (`iso-seed/`, built once on a build host / CI): a stock Debian
   netinst ISO with exactly three changes, all applied with `xorriso`:
   - the default boot entry (BIOS **and** UEFI) auto-preseeds from
     `/cdrom/flagship/preseed.cfg` with a short timeout;
   - a **generic, recipe-independent** `preseed.cfg` is added at
     `/flagship/preseed.cfg` — the *seed stub*;
   - nothing else — the boot equipment is replayed byte-for-byte so the seed
     stays USB-bootable on BIOS and UEFI.

   One seed serves **every** user; it carries no per-recipe data.

2. **The seed stub preseed** (`iso-seed/preseed.cfg`) does only two things:
   set the handful of settings d-i consumes before `early_command` (locale,
   keyboard — fixed constants), and in `early_command` mount a FAT partition
   labeled **`FLAGSHIP`** and load the real per-recipe preseed from it via
   `debconf-set-selections`. Every recipe-derived directive (partitioning,
   `late_command` with the signed InstallBlob) is consumed *after*
   `early_command`, so it lands in time. This is a standard d-i chain-load.

3. **The per-recipe payload** = one file, `preseed.cfg`, which is the full
   output of the shared `buildDebianPreseed` generator
   (`packages/flagship-burner`) — it already carries the base64-encoded signed
   InstallBlob and the first-boot bootstrap. The burner writes it to a small
   FAT16 volume labeled `FLAGSHIP` (`FatVolume.buildPreseedVolume` already
   produces exactly this).

4. **The on-device burn**:
   - stream the seed to the stick **verbatim** (raw copy from LBA 0 — the
     isohybrid MBR/GPT come along);
   - append the `FLAGSHIP` FAT16 volume in free space past the ISO image
     (the stick is larger than the seed);
   - add one MBR partition entry pointing at it.

   All three are raw-sector operations (SCSI `WRITE(10)` to arbitrary LBAs) —
   no ISO surgery, no native code.

## Trust model (unchanged)

The **phone's signature on the InstallBlob is the entire trust root**, exactly
as for the desktop burner. The seed is generic and carries no recipe, so a
malicious seed can't target a specific box. The per-recipe `preseed.cfg` embeds
the phone-signed blob; the burner MUST verify the preseed it lays down embeds
*that* signature before writing it (so a hostile preseed source can't swap in a
different box's recipe). `.com` is never in the trust path — it only ships the
generic seed bytes, which are sha-pinned and reproducible (below).

## Deriving the seed (reproducible)

`iso-seed/build-seed.sh <stock-netinst.iso> <out-seed.iso>`:

- extracts `/boot/grub/grub.cfg`, `/isolinux/txt.cfg`, `/isolinux/isolinux.cfg`;
- prepends a default `Flagship automated install` GRUB entry + `set timeout=3`,
  and points BIOS isolinux at an equivalent `flagship` label — both with the
  cmdline `auto=true priority=critical preseed/file=/cdrom/flagship/preseed.cfg`;
- adds `iso-seed/preseed.cfg` at `/flagship/preseed.cfg`;
- repacks with `-boot_image any replay` (boot equipment verbatim), keeping the
  **original Debian volume id** (d-i keys `/cdrom` detection on it);
- pins every timestamp to a fixed epoch and the GPT disk GUID to a fixed value,
  so the output is **byte-for-byte reproducible**.

Given the same stock base + this script + the same `xorriso`, the seed sha256 is
identical on every machine. Anyone can re-derive it and compare against the
published hash — that is the transparency guarantee.

### Pinned hashes

| field | value |
|---|---|
| stock base | Debian 13.5.0 amd64 netinst (`FLAGSHIP_ISO_MANIFEST`, official signed sha) |
| seed sha256 | `367acd2f6f6f19b5da0335c65f692963b06bd996c9e09509ac6732978ec2168d` |
| built by | `iso-seed/build-seed.sh` @ this commit, `xorriso` 1.x |

Re-pin the seed sha whenever the stock base or `build-seed.sh` changes (a new
Debian point release re-pins both the stock and the seed together).

## Delivery

`.com`'s `POST /api/iso-manifest` serves the seed to the burner, sha-pinned,
exactly like the stock base — but from a **transparent public artifact** (a
GitHub release) so anyone can fetch the same bytes the app fetches. The stock
Debian base still comes from Debian/Google mirrors; only the *seed* (our
derivative) is served by us, and it's reproducible from the documented recipe
above. See `docs/iso-manifest`* + the `platform: "android"` seed manifest.

## Verify it yourself

```sh
# 1. fetch the exact stock base .com pins (url+sha in the manifest)
# 2. re-derive the seed
iso-seed/build-seed.sh debian-13.5.0-amd64-netinst.iso my-seed.iso
# 3. compare against the published seed sha256
sha256sum my-seed.iso   # must equal the pinned value above
```

## ⚠️ Partition registration: the seed is a GPT isohybrid

Verified by assembling a full stick image on a build host (seed streamed
verbatim + a FAT16 `FLAGSHIP` volume placed past the ISO + an MBR entry) and
reading `preseed.cfg` back out: the **FAT volume + its contents are correct**,
but the seed carries a **GPT** (`xorriso -toc`: "MBR isohybrid … GPT APM"), and
**Linux ignores MBR partition entries on a GPT disk**. So a `FLAGSHIP` partition
added only to the MBR is invisible to the installer's `list-devices partition`.

The burner MUST make the partition visible to the kernel. Options, most→least
robust:

1. **Add `FLAGSHIP` to the GPT partition array** (primary header at LBA 1; keep
   the MBR entry too for MBR-only firmwares). Requires recomputing the GPT
   header + partition-array CRC32s. This is the correct, most-compatible path.
2. **Write `preseed.cfg` into the seed's existing ESP** (already a
   GPT-enumerated FAT partition). Tested on a build host and found **not viable
   as-is**: the Debian netinst ESP has only ~10 KB free, so a 33 KB preseed is
   "Disk full". Would require the seed build to enlarge the ESP first.
3. **Build the seed MBR-only** (strip the GPT) so the MBR is authoritative and
   the slot-3 append is seen — this is the path the build-host layout test
   already validates for the phone side; the open question is only whether an
   MBR-only isohybrid UEFI-boots on the target (many do, via the `0xEF` ESP).
4. **Best: register `FLAGSHIP` in the GPT at *seed-build* time** as a fixed
   placeholder region just past the ISO, so the phone writes only FAT bytes into
   an already-registered offset (no on-device GPT CRC surgery). More seed-build
   work; cleanest phone side.

The FAT-volume + partition-entry mechanics are verified on a build host;
**which registration path boots on real hardware is the open
hardware-validation question** (options 1/3/4 are the live candidates).

## Validation status

- **Reproducible seed build** — done + verified (byte-identical across runs;
  `sha256=367acd2f…`).
- **Seed still boots (isohybrid BIOS+UEFI El Torito preserved)** — verified via
  `xorriso -toc`. A real boot on hardware is the remaining physical check.
- **Stick layout** — verified on a build host: FAT16 `FLAGSHIP` volume built,
  placed past the ISO, and `preseed.cfg` read back out of it; ESP + MBR
  signature preserved. Does NOT exercise the SCSI-over-USB transport (hardware)
  or resolve the GPT-registration question above.
- **The `early_command` chain-load + partition boot** — needs a physical OTG
  burn + boot to validate end to end (hardware-gated). Two open risks: the
  GPT-vs-MBR partition registration (above), and d-i's `early_command` timing /
  label detection.
