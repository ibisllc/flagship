# On-device USB-OTG burner (Android) — design notes & findings

Status: **subsystems complete + unit-tested; on-device ISO remaster (recipe
injection) is the one part that is NOT yet implementable against a stock Debian
netinst without a server-side change — it is a clearly-marked seam with a TODO.**

This document records the investigation the task asked for: how to inject the
phone-signed recipe into the base ISO **without `xorriso`** on Android, the
options considered, the decision, and exactly what is still needed.

---

## 1. What the desktop burner does (the thing we are mimicking)

Reference: `apps/burner-mac/Sources/FlagshipBurnerCore/{IsoBaseCache,IsoManifestClient,Remaster,UserData}.swift`
and `packages/flagship-burner/src/{write,preseed,userdata,remasterIso}.ts`.

The desktop flow is:

1. **Manifest** — `POST https://flagshipserver.com/api/iso-manifest` with
   `{platform, burnerVersion, current:{version,sha256}|null}`; the server replies
   `{download:{url,sha256,version,sizeBytes,attestation}}` or `{download:null}`
   ("keep what you have"). The burner is a dumb executor — it never compares shas
   itself, it obeys the order and verifies the bytes it downloads.
2. **Download + verify** — stream the ordered URL to a cache file, computing
   sha256 as it goes, and **discard on mismatch**. Cached at
   `~/Library/Caches/flagship-burner/flagship-base-<version>.iso`.
3. **Remaster (the hard part)** — turn the stock Debian netinst into an
   *unattended* install ISO. For Debian this means, via `xorriso`:
   - **place `preseed.cfg` at the ISO root** (`/preseed.cfg`), and
   - **patch the bootloader configs** (`/boot/grub/grub.cfg` for UEFI,
     `/isolinux/*.cfg` for BIOS) to append the kernel cmdline
     `auto=true priority=critical preseed/file=/cdrom/preseed.cfg` and drop the
     menu timeout.
   The signed recipe (`blobB64`), the first-boot bootstrap script, the LUKS
   storage recipe, the phone-home beacons, etc. are all **embedded as text inside
   `preseed.cfg`** (`buildDebianPreseed` in `preseed.ts`).
4. **Raw write** — `dd`-style stream the remastered ISO to the raw USB block
   device in chunks, then `fsync`.

So the recipe never touches the *image's filesystem layout* except via that one
added `preseed.cfg` file + the two patched boot-config text files.

---

## 2. The hard problem on Android: no `xorriso`, no root, no block device

Three constraints that the desktop path does not have:

- **No `xorriso` / libisofs.** There is no ISO9660/El-Torito authoring tool
  available, and bundling a native one is heavy + per-ABI.
- **No root and no raw block device.** Android apps cannot open `/dev/sd*`.
  The only no-root path to a USB stick is the **USB Host API** (`UsbManager`)
  talking the **USB Mass Storage Bulk-Only Transport (BOT)** protocol directly to
  the device's bulk endpoints, encoding SCSI CDBs (INQUIRY / READ CAPACITY(10) /
  WRITE(10)) ourselves. (The Storage Access Framework only exposes *mounted*
  filesystems, not raw sectors, so it cannot write a bootable image.)
- **Memory/IO.** A netinst is ~700 MB; everything must stream, never load whole.

The raw-write + manifest/verify constraints are solved here (see §4). The
**remaster** is the genuinely hard one and is analysed next.

---

## 3. Remaster options considered

### (a) Pure-Kotlin ISO9660 / El-Torito remaster — **rejected for this pass**
Re-implement enough of `libisofs` to (i) add a new file (`preseed.cfg`) and
(ii) grow two existing files (the boot configs — we *append* text, so they get
bigger). ISO9660 stores each file as a contiguous **extent**; you cannot grow a
file in place, and adding a file means rewriting directory records, the path
tables, and (because Debian images are `isohybrid` GPT/MBR with an embedded EFI
System Partition holding a *second* copy of grub.cfg) keeping the El-Torito boot
catalog + the hybrid partition tables consistent. This is effectively
re-authoring the filesystem. High risk, large surface, and it would touch the
**security-critical signed-bootstrap path** — not justifiable in one pass.

### (b) Write base ISO verbatim + inject the recipe via a separate labeled volume — **recommended path forward**
Write the stock image unchanged, then add the recipe as a small **separate
FAT volume** (or a known file on a labeled partition) that the installer reads.
This avoids all ISO9660 surgery. The catch: **stock Debian d-i only loads a
preseed when the kernel cmdline tells it to** (`preseed/file=…` or
`auto url=…`), and we cannot set the cmdline without patching the bootloader —
which is exactly the ISO surgery we are avoiding.

The clean version of (b) therefore needs **one small server-side change** (a
different surface, intentionally out of scope here): have `/api/iso-manifest`
serve a **pre-remastered Flagship base image** whose bootloader cmdline already
contains `preseed/file=…` pointing at a fixed label (e.g. `auto url` or
`preseed/file=/media/FLAGSHIP/preseed.cfg`), so the **only** per-burn step on the
phone is dropping `preseed.cfg` (carrying the signed recipe) onto that labeled
volume. That is trivially doable on-device (small FAT image, deterministic) and
keeps the security-critical preseed/bootstrap generation in the **single shared
generator** rather than re-implemented (and drift-prone) in Kotlin.

### (c) Initrd preseed — **rejected**
d-i can preseed very early from a file appended to the initrd. But that means
decompressing (gzip/xz), editing a cpio archive, recompressing, and re-checksum —
comparable complexity to (a), plus it still needs a cmdline/initrd reference.

### Decision
- **This pass implements (b)'s on-device half end-to-end except the actual
  recipe-embedding write**, which is a documented seam (`IsoInjector`).
- The default `IsoInjector` is `VerbatimInjector`: it streams the base image
  through unchanged so the **download → verify → USB write** pipeline is real,
  tested, and exercised on hardware. It logs loudly that the recipe is **not yet
  embedded** (the burned stick boots stock Debian, not an auto-provisioned box).
- The recipe is parsed + validated on-device (`RecipeParse`) so the seam is fully
  wired and the UI shows what *would* be burned; turning the seam on is a small,
  bounded follow-up once the base-image cmdline question (above) is decided.

---

## 4. What IS implemented + unit-tested in this pass

All under `app/src/main/java/com/flagshipserver/app/burner/`:

- **`usb/ScsiCommands.kt`** — pure CBW/CSW/CDB byte encoders (Bulk-Only
  Transport): `TEST UNIT READY`, `INQUIRY`, `READ CAPACITY(10)`, `WRITE(10)`,
  `READ(10)`. SCSI multi-byte fields are **big-endian**; the BOT wrapper fields
  are **little-endian** — the unit tests pin both. (`ScsiCommandsTest`)
- **`usb/MassStorageWriter.kt`** — drives the protocol over an injectable
  `BulkTransport` (real impl wraps `UsbDeviceConnection`; tests use a simulated
  device). `inquiry()`, `readCapacity()`, and a block-aligned `writeImage()` loop
  with progress. (`MassStorageWriterTest` — a fake device round-trips the image.)
- **`usb/UsbHost.kt`** — `UsbManager` enumeration of class-0x08/proto-0x50
  (SCSI/BOT) devices, permission request, endpoint open → a real `BulkTransport`.
  Hardware-dependent (compiles, not unit-tested).
- **`iso/IsoManifest.kt` + `IsoManifestClient.kt`** — the locked wire contract,
  over an injectable `BurnerHttp` seam. (`IsoManifestClientTest` — fake HTTP.)
- **`iso/IsoBaseCache.kt`** — inspect cache → POST manifest → obey → streaming
  download with incremental sha256 + progress, discard-on-mismatch, atomic
  rename, prune stale. (`IsoBaseCacheTest` — fake HTTP + temp dir.)
- **`iso/RecipeParse.kt`** — validate + extract the serial/domain/username from
  the recipe JSON (so the UI + the future injector have what they need).
  (`RecipeParseTest`)
- **`iso/IsoInjector.kt`** — the remaster seam + `VerbatimInjector`.
- **`BurnerOnDeviceViewModel.kt`** — orchestrates detect → permission → download
  → verify → inject → write, exposing a `StateFlow<BurnState>`.
- **`ui/screens/BurnerOnDeviceScreen.kt`** — the Compose UI: drive picker,
  "this erases the drive" warning, phase progress bar, success — public entry
  `BurnerOnDeviceScreen(recipeJson, onDone)`.

Manifest addition: the `android.hardware.usb.host` feature (declared
`required="false"`). No `USB_DEVICE_ATTACHED` launch intent-filter is declared —
the flow is launched in-app and requests device permission at runtime, so an
attach filter would just offer the app for every plugged-in mass-storage device.

---

## 5. Exactly what still needs doing (and what needs a physical OTG drive)

**To make the burned stick auto-provision (turn the seam on):** pick the §3(b)
mechanism and implement `IsoInjector.inject` accordingly. The lowest-risk choice
is the small server change to serve a Flagship base image whose cmdline already
references a fixed preseed label, then have the injector write a tiny FAT volume
holding `preseed.cfg`. The preseed/bootstrap text MUST come from the **shared
generator** (`packages/flagship-burner` `buildDebianPreseed`), not a Kotlin
re-implementation — porting that signed, security-critical path is a separate,
carefully-validated task. Until then the injector is verbatim.

**Needs a physical OTG drive to validate (cannot be unit-tested):**
1. `UsbHost` enumeration + permission + endpoint open against a real stick.
2. `MassStorageWriter.readCapacity()` / `writeImage()` against real hardware
   (block size discovery, max bulk-transfer size tuning, total write time).
3. A burned stick actually booting on target hardware (only meaningful once the
   injector embeds the recipe).

Everything else — SCSI/BOT command encoding, the CBW/CSW round-trip, the manifest
contract, sha256 verification, cache decisions, recipe parsing — is covered by
JVM unit tests (`./gradlew :app:testDebugUnitTest`).
