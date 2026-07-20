# End-to-end real-USB install — pre-flight checklist

Run this once you're ready to do the P0 "real-metal USB install proof
point." Everything you should verify or have on hand before starting.

## Hardware

- [ ] Burning machine — your Linux laptop (or Mac, or Windows). Has
      Node 20+ installed (`node --version` ≥ v20).
- [ ] Target machine — the box that will become the Flagship pod.
      Must be able to boot from USB; 4GB+ RAM; 32GB+ disk.
- [ ] USB drive — 8GB+ minimum. Will be erased.
- [ ] iPhone or Android with the Flagship app (or you can use the
      webapp on your phone's browser if the native app isn't on
      TestFlight/Play yet).

## Artifacts

- [ ] Stock Ubuntu Server ISO downloaded:
      https://releases.ubuntu.com/22.04.5/ubuntu-22.04.5-live-server-amd64.iso
      (the Builder refuses any other SHA — pinned at
      `9bc6028870aef3f74f4e16b900008179e78b130e6b0b9a140635434a46aa98b0`).
- [ ] Your phone has a Flagship account (username claimed, IRK
      derived). If not, walk through the onboarding first.

## Software gates (re-run before testing if it's been a while)

```sh
cd ~/flagship
npm install --workspaces                            # latest deps
npx tsc -b                                          # full workspace clean
npx vitest run                                      # 3214+ pass, 8 skipped
node packages/flagship-builder/src/cli.ts distros    # lists Ubuntu 22.04
node packages/flagship-builder/src/cli.ts --help     # all 6 subcommands
```

If any of those fail, stop and investigate before starting the real
test.

## The test (full chain)

### Step 1 — Mint a recipe on the phone

Open the Flagship app (or `https://flagshipserver.com/webapp/` on
mobile Safari). Tap **Create server.**

- Pick a short name (e.g. `home`)
- One-line description
- TTL slider → 6 hours is fine (default). The test should finish in
  well under an hour, but 6h gives you buffer if you hit a snag
  burning.
- Tap **Continue.**

### Step 2 — Show the QR on the burning machine

On your Linux laptop, open `https://flagshipserver.com/` in a fresh
browser tab. You'll see a one-time QR code. The page also prints the
URL the QR encodes — copy that.

### Step 3 — Scan or paste on the phone

In the Flagship app's "Scan QR" step, scan the QR with the camera, or
tap "Paste URL" and paste the URL from the desktop.

A **6-digit match code** will appear on both screens. Verify the codes
match (this is your SAS check — protects against a MITM). Tap
**Confirm** on the phone.

### Step 4 — Phone signs + delivers via QR-pipe

The phone signs the InstallBlob with your IRK + RCK and pushes through
a one-shot Durable Object on `.com`. The desktop tab reads it on the
other end. Watch the desktop tab — it'll transition through
`connecting → matching → minting → delivering → delivered`.

### Step 5 — Download the recipe.json

Once `delivered`, the **Download recipe (.json)** button enables. Hit
it. You'll get `flagship-recipe-<server-domain>-<expiry>.json` in your
Downloads folder.

### Step 6 — Verify the recipe (optional but good first run)

```sh
node packages/flagship-builder/src/cli.ts verify ~/Downloads/flagship-recipe-*.json
```

Confirms the signature verifies + prints the server-domain and expiry.
Errors here mean you should mint a fresh recipe (probably expired or
tampered).

### Step 7 — Burn the USB

Plug in the USB drive. Make sure it's the one you intended (the
Builder will refuse anything that looks internal, but better to be
sure).

```sh
sudo node packages/flagship-builder/src/cli.ts write \
    ~/Downloads/flagship-recipe-*.json \
    ~/Downloads/ubuntu-22.04.5-live-server-amd64.iso
```

It'll show the device picker, you pick (say) `/dev/sdb`, type `yes`.
Takes ~3 minutes to write.

After write completes, the Builder auto-shreds the recipe `.json`
(default behavior; pass `--keep-recipe` to opt out).

### Step 8 — Boot the target machine

Plug the USB into the target. Power on, hit your firmware's boot-menu
key (F12 / Esc / F10 — varies by manufacturer), pick the USB. Subiquity
takes over with autoinstall and runs unattended.

Time to first registration: ~10-15 minutes (mostly apt install,
git clone, npm install, tsc build).

### Step 9 — Verify on your phone

Open the Flagship app. Your new pod should show up under "My servers"
within ~30 seconds of registration. Tap it — see the green TLS state.

Open `https://<server-name>.<your-username>.flagship.services/` in a
browser. You should see the daemon's default landing page with a real
Let's Encrypt cert (green padlock).

## If something goes wrong

| Symptom | First thing to try |
|---|---|
| Builder refuses recipe | Check expiry; mint a fresh one |
| Builder refuses ISO | Re-run `shasum -a 256` against Canonical's published value |
| Subiquity hangs at "select language" | autoinstall didn't see the CIDATA partition. Re-burn with `flagship-build write --device /dev/diskN`. Check that the USB has TWO partitions when `lsblk` |
| Pod doesn't register | SSH into target as `flagship` (no password — will fail. Need to add a recovery method here in Phase 2). Otherwise: boot a recovery USB + `cat /var/log/flagship-bootstrap.log` |

## Next steps (signal to me when you're done)

- Pod registers: tell me. We move to vibecode "hello world" demo + opening the site.
- Pod doesn't register: SSH in, grab `/var/log/flagship-bootstrap.log` + `journalctl -u flagship-first-boot-register`, send the tail.

The end-to-end chain is now **ready for live test** — all four
components have green tests and align on the v2 wire format. The only
unknowns left are real-hardware quirks (firmware boot order, BIOS-vs-UEFI
boot mode, network DHCP behavior) which we'll diagnose if they
surface.
