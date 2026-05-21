# W12 — Debian-12-netinst-based installer (cloud demo path)

**Last updated**: 2026-05-21.
**Replaces** (for cloud demo only — see below): the Alpine + apkovl
installer under `packages/installer-apkovl/` + `scripts/build-flagship-iso.sh`.

## Why we replaced Alpine for cloud installs

The Alpine 3.21 standard ISO, booted in apkovl-mode on a Hetzner cx23
cloud VM, **doesn't mount its modloop-lts kernel-modules squashfs**.
`/lib/modules` stays empty; `af_packet` cannot load; `udhcpc` fails on:

```
socket(AF_PACKET,2,8): Address family not supported by protocol
```

DHCP never sends Discover, the bootstrap has no network to
`apk-add nodejs git curl jq` from, and it exits silently. Live-confirmed
2026-05-21 by reading the bootstrap log we persisted to /dev/sda offset
1 GiB from a rescue boot.

Debian d-i (Debian installer) is the canonical preseed-driven Linux
installer. **Its installer kernel has every common driver built IN** —
virtio_net, realtek, intel, af_packet all live in the vmlinuz, not in
a separately-mounted squashfs. DHCP works on every common cloud VM out
of the box. d-i has 20+ years of operator trust and is reproducibly
built upstream.

The trailer-at-disk-end mechanism (`packages/iso-personalizer/`) stays
**unchanged** — d-i ignores bytes past its filesystem; the trailer at
`disk_size - trailer_size` is reachable from the chrooted `/target`
during preseed's `late_command`.

## Scope

The Debian-netboot ISO is **only** used by the cloud demo path
(`admin-snapshot-now` → Worker dd's base ISO + trailer onto a temp
Hetzner VPS). The legacy `/build/` flow on real hardware (USB-stick
installs) still uses the Alpine apkovl ISO, because:

1. The Alpine ISO works fine on bare metal — the modloop-loading
   pathology is specific to cloud-VM boot sequences.
2. Switching `/build/` to d-i requires reworking the browser-side
   "paste a build code, get a personalized ISO" UX, which is a
   follow-up commit.

## Where the pieces live

```
scripts/
  build-flagship-iso.sh                Legacy — Alpine + apkovl. /build/ ONLY.
  build-flagship-netboot-iso.sh        W12 — Debian 12 netinst. Cloud demo.

packages/installer-netboot/
  preseed.cfg                          d-i preseed (full automation).
  install.sh                           Placeholder; symmetry with Alpine.
  parse-trailer.sh                     Pure-bash trailer parser +
                                       Ed25519 sig verify.
  late-command.sh                      Runs inside chrooted /target.
                                       Port of installer/install.sh
                                       (Alpine path) — LUKS rotate +
                                       git clone + identity + systemd
                                       units + register.
```

## The preseed contract

`preseed.cfg` answers every d-i directive that would otherwise prompt.
The load-bearing ones:

- `partman-auto/method string crypto` — root is LUKS-encrypted. The
  install-time passphrase is a placeholder; the late-command rotates
  it to one derived from the install blob + phone-delegated pubkey.
- `pkgsel/include` — pre-installs `openssh-server git curl jq nodejs
  npm cryptsetup lvm2 ca-certificates xxd`. Each is load-bearing
  somewhere downstream (jq → blob parse; xxd → hex u32 LE; cryptsetup
  → LUKS rotate; etc.).
- `apt-setup/non-free-firmware boolean true` — some Hetzner kernels
  need realtek/intel firmware blobs that only live in
  `non-free-firmware`. Without this, the installed system boots but
  networking is half-broken.
- `preseed/late_command` — `in-target /root/late-command.sh`. This is
  the entry point to our flagship-side install logic.

Tests in `packages/installer-netboot/tests/preseed.test.ts`
mechanically enforce all of the above so a future edit cannot silently
break the cloud install.

## The trailer parser

`parse-trailer.sh` reads the last ~64 KB of `/dev/sda`, validates the
trailer format from `packages/iso-personalizer/src/trailer.ts`, and
verifies the embedded Ed25519 signature over the install-blob's
canonical-bytes against the blob's own `userPubKey` field.

It cannot use `@noble/ed25519` (the apkovl bootstrap's strategy)
because d-i's freshly installed Debian rootfs goes through `npm ci`
**after** the late-command runs. So:

- Primary path: `openssl pkeyutl -verify -rawin -pubin` against an
  SPKI-wrapped DER form of the embedded pubkey. OpenSSL 3.0+ ships
  with Debian 12 and supports Ed25519 verify natively.
- Fallback: inline-Python via `python3 -` (Debian's python3-minimal is
  ~5 MB). Implements RFC 8032 Ed25519 verify directly — pure stdlib,
  no `cryptography` or `pynacl` dep.

If neither verifies, the late-command aborts the install. (Same
fail-closed posture as the apkovl bootstrap.)

## The late-command

`late-command.sh` runs inside the chrooted `/target` (= installed
Debian rootfs). By that point d-i has already:

1. Partitioned `/dev/sda` with the encrypted-LVM atomic recipe.
2. LUKS-formatted the root volume with the placeholder passphrase.
3. Bootstrapped a minimal Debian rootfs into the encrypted LVM.
4. Installed `pkgsel/include` packages.

Our late-command then:

1. Parses + signature-verifies the trailer from `/dev/sda`.
2. Rotates the LUKS passphrase from the placeholder to a fresh
   random 64-byte key. (cryptsetup `luksAddKey` → `luksRemoveKey`.)
3. Clones the Flagship repo at the trailer-pinned git ref.
4. Runs `npm ci` + `npx tsc -b`.
5. Generates the server identity keypair (raw priv hex →
   `/var/flagship/identity/identity.priv.hex`; PKCS8 PEM →
   `/boot/identity.pem` for the boot-stage to sign consume-unlock-key
   requests).
6. Writes systemd units:
   - `flagship-data-services.service` (postgres + minio + redis +
     adminer under docker compose).
   - `flagship-boot-stage.service` (oneshot; polls .com for the
     unlock-key, opens LUKS).
   - `flagship-daemon.service` (the actual server-daemon process).
   - `flagship-first-boot-register.service` (oneshot; runs once after
     reboot, since registration needs egress to .com which is not
     always available from inside d-i's post-install chroot).
7. Seals the LUKS key for the phone's delegated pubkey + drops it on
   disk for the first-boot register unit to upload.

## Operator runbook — building + deploying the ISO

```sh
# 1. Build the netboot ISO (this fetches ~450 MB from cdimage.debian.org
#    and produces a ~600 MB ISO. Takes ~5 min on a fast box.).
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
    bash scripts/build-flagship-netboot-iso.sh \
        out/flagship-netboot-debian-12.7.0-x86_64.iso

# 2. Upload to R2.
npx wrangler r2 object put flagship-iso/flagship-netboot-debian-12.7.0-x86_64.iso \
    --file out/flagship-netboot-debian-12.7.0-x86_64.iso

# 3. Update wrangler.toml [vars] if the version pin changed.
# 4. Deploy the Worker.
cd apps/com && npx wrangler deploy

# 5. Run a real demo-user provisioning to live-test:
HCLOUD_TOKEN=... node scripts/sample-user.mjs create demo-alice
# Watch the /api/users/demo-alice/pods endpoint; expect a register
# event within ~6-10 minutes (Debian install is slower than Alpine but
# more reliable).
```

## Pinning + reproducibility

`scripts/build-flagship-netboot-iso.sh` follows the same shape as
`build-flagship-iso.sh`:

- `SOURCE_DATE_EPOCH` clamps every file mtime in the ISO.
- xorriso runs with `-volid` + `-volume_date` set to the pinned epoch
  so the ISO's UUID is deterministic.
- The upstream Debian netinst ISO is sha256-pinned (declare -A
  `DEBIAN_SHA256` table). Mismatched checksum aborts before any
  further work.

The reproducible-build CI workflow (`.github/workflows/build-iso.yml`)
still runs for the Alpine ISO only. Extending it to also build + cmp
the netboot ISO is a follow-up.

## Outstanding (operator follow-ups)

1. Build the first netboot ISO + upload to R2 + flip
   `FLAGSHIP_NETBOOT_ISO_URL` in `wrangler.toml`.
2. Live-test via `scripts/sample-user.mjs create demo-alice`.
3. Once live-verified: cut the `/build/` flow over to the netboot ISO
   too (browser-side personalize stays unchanged; only the base ISO
   key changes).
4. Extend `.github/workflows/build-iso.yml` to byte-compare two
   netboot-ISO builds.
