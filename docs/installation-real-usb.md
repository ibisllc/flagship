# Installing Flagship on real hardware

The cloud demo (`flagshipserver.com/build/` → debian-12 base image) is the
fastest way to try Flagship without committing hardware. This document is the
**real-USB** path — what you do when you want your own pod on metal you own.

## What you'll need

1. A computer to install Flagship on. Any 64-bit x86 box with:
   - 4 GB RAM minimum (8 GB recommended)
   - 32 GB disk minimum (128 GB+ for real use)
   - Boots from USB
2. A USB drive. 8 GB or larger. **Will be erased.**
3. A second computer to do the burning. Mac, Windows, or Linux.
4. Your phone, paired with your Flagship account.

## Steps

### 1. Download the stock Ubuntu Server ISO (once)

Go to https://releases.ubuntu.com/22.04.5/ on your builder computer and grab
`ubuntu-22.04.5-live-server-amd64.iso` (~2 GB). Save it somewhere stable;
you can reuse it for many Flagship installs.

The Builder will refuse any ISO that doesn't match Canonical's published
SHA-256 — this is the trust boundary for the operating-system layer.

### 2. Mint a recipe on your phone

Open the Flagship app and tap "Create server." Walk through:

1. Pick a short name (becomes the subdomain — e.g. "home"
   → `home.<your-username>.flagship.services`)
2. One-line description
3. Recipe TTL — how long this recipe stays valid. Default 6 hours,
   range 5 min – 24 hours. Pick based on when you expect to burn + boot.
4. Tap "Continue" → scan the QR code shown on `flagshipserver.com` (or
   paste the QR's URL into your phone browser if the camera path doesn't
   work — same flow either way)
5. The phone signs the recipe with your account-owner key and pushes it
   through a one-shot relay to the desktop

### 3. Download the recipe on the desktop

Once the phone signs and pushes, the webapp shows the green "delivered"
state. Hit the **Download recipe (.json)** button right below the "Deliver
to homepage" button. You'll get a file named
`flagship-recipe-<server-domain>-<expiry>.json`.

Treat this file like a single-use auth token — anyone with it can do ONE
install at your `<server-domain>` until it expires. Keep it on the burning
machine, ideally in a directory only you can read.

### 4. Burn the USB

#### Option A: Mac

Open the **Flagship Studio.app** in `apps/builder-mac/` (run `swift run`
inside that directory if you don't have a release build yet). Drag in:

1. The recipe `.json`
2. The Ubuntu Server ISO
3. Select your USB drive from the picker

Click **Bake.** Enter your admin password when prompted. ~3 minutes later
the drive is ready.

#### Option B: Linux

Open the **Flagship Studio** (GTK4 app at `apps/builder-linux/`). Same
wizard as the Mac app:

```sh
cd apps/builder-linux
python flagship-builder.py
```

The app asks for sudo via PolicyKit when it needs to do the raw write.

#### Option C: CLI (any OS)

```sh
cd packages/flagship-builder
node src/cli.ts verify ~/Downloads/flagship-recipe-*.json
# Confirm server-domain + expiry match what you minted

sudo node src/cli.ts write \
    ~/Downloads/flagship-recipe-*.json \
    ~/Downloads/ubuntu-22.04.5-live-server-amd64.iso
# Picks a USB interactively. Refuses any drive that looks internal.
```

The Builder auto-shreds the recipe `.json` after a successful write (the
phone-signed token is single-use; leaving it on disk extends the attack
window). Pass `--keep-recipe` if you want to keep it.

#### Option D: "Burn elsewhere"

If your builder machine isn't where you want to do the raw write — say,
you mint on a laptop and burn on a desktop — use `prepare` to build a
flashable ISO, then use whatever burning tool you like (`balenaEtcher`,
Rufus, `dd`):

```sh
node packages/flagship-builder/src/cli.ts prepare \
    ~/Downloads/flagship-recipe-*.json \
    ~/Downloads/ubuntu-22.04.5-live-server-amd64.iso \
    ~/Downloads/flagship-ready.iso

# Then on the target machine:
sudo dd if=~/Downloads/flagship-ready.iso of=/dev/diskN bs=4M status=progress
```

### 5. Boot the target machine from the USB

Plug the USB into the target. Power on, hit your firmware's boot-menu key
(F12 / F10 / Esc — varies by manufacturer), pick the USB. Ubuntu's
subiquity installer takes over, reads the recipe from the CIDATA
partition, runs unattended. About 5-15 minutes (mostly apt install).

The machine reboots into its newly-installed Debian/Ubuntu rootfs and the
flagship-bootstrap systemd unit POSTs the registration to
`flagshipserver.com`. Once that lands, the pod is alive at
`https://<server-name>.<your-username>.flagship.services/`.

### 6. Verify on your phone

Open the Flagship app. Your new pod should show up under "My servers"
within ~30 seconds of registration. Tap it — you'll see the green TLS
state, the IP, the cert expiry.

## Troubleshooting

**Builder refuses my ISO.**
Check the SHA-256 — `shasum -a 256 ubuntu-22.04.5-live-server-amd64.iso`
must match Canonical's published value. If you downloaded from a mirror
it may have been re-released.

**Builder refuses my recipe.**
Recipes expire (your phone showed how long when you minted). If you've
been sitting on it past `authCode.expiresAt`, mint a fresh one. The
Builder refuses early so you don't burn a USB that wouldn't register
anyway.

**Pod doesn't appear on phone after install.**
SSH into the target box (it has openssh by default; user `flagship`).
Check `journalctl -u flagship-bootstrap` and
`tail /var/log/flagship-bootstrap.log`. Most common: NodeSource apt
repo timeout (re-run the bootstrap manually) or DNS not resolving
`flagshipserver.com` (check `/etc/resolv.conf`).

**Builder refuses the drive I picked.**
Either it looks like an internal drive (size > 500 GB, vendor
matches a known internal-drive signature) or you targeted `/dev/sda` /
`/dev/disk0` (always refused, no matter the flags). Pick a removable
USB. The Builder errs aggressively on the "don't wipe the user's
laptop" side — this is intentional.

## Threat model

See `packages/flagship-builder/README.md` § threat model.

Tl;dr: phone is the trust root, recipe is a one-shot signed token,
Builder refuses tampered ISOs by SHA, never calls flagshipserver.com.
