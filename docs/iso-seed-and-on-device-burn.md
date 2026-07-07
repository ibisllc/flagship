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
   netinst ISO with three changes, all applied with `xorriso`:
   - the default boot entry (BIOS **and** UEFI) auto-preseeds from
     `/cdrom/flagship/preseed.cfg` with a short timeout;
   - a **generic, recipe-independent** `preseed.cfg` is added at
     `/flagship/preseed.cfg` — the *seed stub*;
   - an **empty, GPT-registered `FLAGSHIP` FAT16 partition** (16 MiB) is
     appended (`-append_partition`), so the partition the installer must find
     already exists in the GPT (see "Partition registration" below);
   - otherwise the boot equipment is replayed byte-for-byte so the seed stays
     USB-bootable on BIOS and UEFI.

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
     isohybrid MBR/GPT *and the empty FLAGSHIP partition* come along);
   - read the GPT to locate the FLAGSHIP region (the highest-first-LBA entry),
     and **overwrite its contents** with the per-recipe preseed FAT volume.

   Both are raw-sector operations (SCSI `WRITE(10)`) — no partition-table
   surgery, no ISO surgery, no native code.

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
- appends an empty `FLAGSHIP` FAT16 partition (`-append_partition`, GPT+MBR);
- repacks with `-boot_image any replay` (boot equipment verbatim), keeping the
  **original Debian volume id** (d-i keys `/cdrom` detection on it);
- pins every timestamp to a fixed epoch, the GPT disk GUID to a fixed value, and
  `SOURCE_DATE_EPOCH` for `mformat`, so the output is **byte-for-byte
  reproducible**.

Given the same stock base + this script + the same `xorriso`, the seed sha256 is
identical on every machine. Anyone can re-derive it and compare against the
published hash — that is the transparency guarantee.

### Pinned hashes

| field | value |
|---|---|
| stock base | Debian 13.5.0 amd64 netinst (`FLAGSHIP_ISO_MANIFEST`, official signed sha) |
| seed sha256 | `bc8ccfe82b77ba2424c9baefff11e29d8190578639312dac8ca76223867802ec` |
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

## Partition registration: the seed pre-declares FLAGSHIP in the GPT

The seed is a GPT isohybrid (`xorriso -toc`: "MBR isohybrid … GPT APM"), and
**Linux ignores MBR partition entries on a GPT disk** — so a `FLAGSHIP`
partition the installer must find has to live in the **GPT**. An earlier design
that added `FLAGSHIP` only to the MBR on-device was invisible to d-i's
`list-devices partition` (confirmed on a build host).

**Resolved (option 4):** the seed build pre-declares an **empty, GPT-registered
`FLAGSHIP` FAT16 partition** (16 MiB) via `xorriso -append_partition`, which
registers it in **both the GPT and the MBR**. So the burner does **zero
partition-table surgery**: it streams the seed verbatim (the empty partition
comes along) and overwrites that partition's *contents* with the per-recipe
preseed FAT. The burner finds the region by reading the GPT (the appended
partition is the highest-first-LBA entry). `mformat` is deterministic under a
pinned `SOURCE_DATE_EPOCH`, so the seed stays byte-for-byte reproducible.

## Validation status

- **Reproducible seed build** — done + verified (byte-identical across runs;
  `sha256=bc8ccfe8…` for the Debian 13.5.0 base).
- **`FLAGSHIP` is GPT-registered** — verified by parsing the seed's GPT
  (`part3: name=Appended3`, the 16 MiB FLAGSHIP region past the ISO).
- **Full install in QEMU (no hardware)** — verified end to end: a burned stick
  (seed + the FLAGSHIP partition overwritten with a real recipe preseed) boots
  under OVMF/UEFI with a blank target disk + the stick as a USB installer; d-i
  finds FLAGSHIP via the GPT, chain-loads the recipe preseed, and installs
  **unattended** (no interactive stall) through partitioning, base install, and
  the flagship bootstrap. This is the same boot chain real hardware runs — it
  exercises everything except the USB write transport.
- **The USB-C OTG *write* transport** (`MassStorageWriter` over real SCSI-USB) —
  the ONE remaining hardware-gated piece; unit-tested against fakes, needs a
  real phone + stick to confirm.

### Build dependencies

`build-seed.sh` needs `xorriso` and `mtools` (`mformat`/`mcopy`) on the build
host. Both are packaged everywhere (`apt install xorriso mtools`).
