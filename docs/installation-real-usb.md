# Installing Flagship on real hardware

This is the **real-USB** path — what you do when you want your own pod on metal
you own. Flagship Studio performs the image download and USB write.

## What you'll need

1. A computer to install Flagship on. Any 64-bit x86 box with:
   - 4 GB RAM minimum (8 GB recommended)
   - 32 GB disk minimum (128 GB+ for real use)
   - Boots from USB
2. A USB drive. 8 GB or larger. **Will be erased.**
3. A Mac or Windows computer to do the burning.
4. Your phone, paired with your Flagship account.

## Steps

### 1. Install Flagship Studio

On the Mac or Windows computer that will write the USB, open
`https://flagshipserver.com/studio`, download Studio, and launch it. Studio
fetches and verifies the current base image automatically.

### 2. Mint a recipe on your phone

Open the Flagship app and tap "Create server." Walk through:

1. Pick a short name (becomes the subdomain — e.g. "home"
   → `home.<your-username>.flagship.services`)
2. One-line description
3. Recipe TTL — how long this recipe stays valid. Default 6 hours,
   range 5 min – 24 hours. Pick based on when you expect to burn + boot.
4. Choose **Pair with the builder app**, then scan Studio's QR or type its
   short code
5. Confirm the security code; the phone signs the recipe with your account
   key and sends it through the one-shot pairing relay

### 3. Receive the recipe in Studio

Studio stages the recipe after the pairing is approved. If you created the
server in the webapp instead, download its `.json` recipe and use Studio's
**I have a recipe** path to open or paste it.

Treat this file like a single-use auth token — anyone with it can do ONE
install at your `<server-domain>` until it expires. Keep it on the burning
machine, ideally in a directory only you can read.

### 4. Burn the USB

In Studio, select the target USB drive and start the write. Confirm the drive
carefully: it will be erased. Studio downloads and verifies the base image,
prepares it with the signed recipe, and performs the privileged raw write.

#### Advanced: CLI

```sh
cd packages/flagship-builder
node src/cli.ts verify ~/Downloads/flagship-recipe-*.json
# Confirm server-domain + expiry match what you minted

sudo node src/cli.ts write \
    ~/Downloads/flagship-recipe-*.json \
    ~/Downloads/flagship-base.iso
# Picks a USB interactively. Refuses any drive that looks internal.
```

The Builder auto-shreds the recipe `.json` after a successful write (the
phone-signed token is single-use; leaving it on disk extends the attack
window). Pass `--keep-recipe` if you want to keep it.

#### Advanced: "Burn elsewhere"

If your builder machine isn't where you want to do the raw write — say,
you mint on a laptop and burn on a desktop — use `prepare` to build a
flashable ISO, then use whatever burning tool you like (`balenaEtcher`,
Rufus, `dd`):

```sh
node packages/flagship-builder/src/cli.ts prepare \
    ~/Downloads/flagship-recipe-*.json \
    ~/Downloads/flagship-base.iso \
    ~/Downloads/flagship-ready.iso

# Then on the target machine:
sudo dd if=~/Downloads/flagship-ready.iso of=/dev/diskN bs=4M status=progress
```

### 5. Boot the target machine from the USB

Plug the USB into the target. Power on, hit your firmware's boot-menu key
(F12 / F10 / Esc — varies by manufacturer), pick the USB. The installer
reads the recipe and runs unattended. Allow roughly 5–15 minutes.

The machine reboots into its newly-installed Debian/Ubuntu rootfs and the
flagship-bootstrap systemd unit POSTs the registration to
`flagshipserver.com`. Once that lands, the pod is alive at
`https://<server-name>.<your-username>.flagship.services/`.

### 6. Verify on your phone

Open the Flagship app. Your new pod should show up under "My servers"
within ~30 seconds of registration. Tap it — you'll see the green TLS
state, the IP, the cert expiry.

## Troubleshooting

**Studio cannot download the base image.**
Check the computer's connection and retry. Studio verifies the image against
the signed manifest before it writes anything. Advanced CLI users supplying
their own image must provide the exact image and digest expected by the builder.

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
