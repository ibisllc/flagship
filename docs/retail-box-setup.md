# Retail boxes: how a buyer pairs a preinstalled box

**Status:** design, not built. Release 0.4 item F4 ("Preinstalled ISO"), owner question of 2026-11-13. Needs owner
review before any code. Supersedes the pairing choice in `docs/nfc-box-pairing.md` (on `feat/retail` and copied to
`release/0.4`) for retail boxes; that doc's protocol pieces are reused where noted in section 11.

The owner's question, verbatim: "I mean thinking of the setup for retail boxes? Do we bundle an NFC tag? Do we just
use a first-come-first-serve beam-to-nearby-apps-over-Bluetooth as soon as you plug it in? (With a booklet warning you
to please install the app before plugging in the machine. And return it if you can't get a pairing ... maybe someone
raced you to pair) how do we avoid MITM?"

## 1. The answer in short

1. **Every box ships with a secret claim code**, printed as a QR code plus 20 characters on a card inside the sealed
   box and on a sticker under the box. Never on the outside packaging. No NFC in the first version.
2. **The code is the key, not the radio.** The phone and the box run one handshake whose keys mix in the code. An
   attacker in the middle, on Bluetooth or Wi-Fi, cannot finish it without the code. A neighbour without the code
   cannot claim the box. No first-come race exists for anyone who has not seen the card.
3. **The claim travels only over a local link**: Bluetooth LE (any box) or the home network (box on Ethernet). Never
   through `.com`. So a leaked code is useful only to someone standing near the box, who could unplug it anyway.
4. **What the phone sends is the existing admin-signed recipe**, the same consent the box already verifies today. The
   box answers with a receipt signed by its new server key, so the phone pins that key from the box itself, not from
   `.com`.
5. **Someone claimed it first? Press the power button five times, then set it up again with your code.** The box
   erases itself only when the new claim completes. Nobody returns a working box because of a race.

`.com` learns nothing new: no serial number, no retailer record, no link between a purchase and an account.

## 2. What a retail box is (assumptions)

- A commodity mini PC (an x86-64 model we pick per SKU), not custom hardware. Ethernet port, a Wi-Fi + Bluetooth combo
  card (Intel AX2xx class supports the LE peripheral role), firmware TPM 2.0, a power button, an HDMI port. **No
  screen and no LED we can drive** on most models. We do not get to add an NFC chip or a microcontroller without a
  custom board.
- "Preinstalled" means the published VM appliance (`docs/desktop-vm-appliance.md`, "Chosen path"), built for metal,
  written to the internal disk at the factory: EFI + `/boot` + LUKS root under the disposable build key, plus a small
  **recovery partition** holding the signed factory image for resets (section 8). On first claim the box replaces the
  disposable LUKS key with a per-box key sealed to the owner's phone, as appliances already do, and moves itself to the
  newest endorsed release (`firstBootUpdate.ts`).
- The firmware is set up per SKU: power button reported to the OS (not "force off" on a short press), Secure Boot on
  with our shim, boot order locked.

## 3. What pairing must achieve

Pairing a retail box replaces "burn a USB stick with your recipe". It must:

| # | Goal | Why |
|---|------|-----|
| G1 | The buyer's phone talks to **this** box, the one in their hands | targeting; two boxes in one flat |
| G2 | Nobody in the middle can read or change the exchange | MITM on Bluetooth, Wi-Fi, LAN, `.com` |
| G3 | Only the buyer can claim it | neighbour, shop employee, courier |
| G4 | The phone learns the box's server key (STK) from the box, out of band | today the owner path takes the STK from `.com` (`docs/architecture-v2/evidence-map.md` item 1) |
| G5 | The box gets the owner's consent as signatures it verifies | owner rule: consent is load-bearing crypto |
| G6 | Wi-Fi credentials reach the box secretly when there is no cable | most homes |
| G7 | Resale, returns and resets are clean; the last owner keeps nothing | second-hand market |
| G8 | No account identity leaks: not on the radio, not to the box's next owner, not to `.com` | owner rule |

G5 is already solved by the current install path. The recipe carries the owner IRK, an AuthCode that only an admin
device can sign (`flagship/auth-code-admin/v1`, AGENTS.md "Adding a server is admin-only"), and the box refuses
anything else. Retail pairing only has to **deliver** that recipe safely, plus Wi-Fi, and bring back the box's key.

## 4. Threat model

| Threat | Who | What they want |
|---|---|---|
| T1 Racing the buyer | neighbour within radio range; anyone on the same LAN | claim the box first: grief, or own a box in someone's home |
| T2 Pre-sale claim | shop employee, warehouse, courier with the box in hand | claim it, or note its secret for later |
| T3 Active MITM | someone on the Bluetooth link or the Wi-Fi/LAN | sit between phone and box, swap keys, read the Wi-Fi password |
| T4 Swapped or tampered box | supply chain | a box with a backdoored image that pairs normally |
| T5 Resold or returned box | previous owner | keep access, or read old data |
| T6 Stolen box | burglar | read data; reuse the box |
| T7 Cloned tag or photographed code | anyone who saw the card or tag | the T1 or T2 attack with the secret in hand |
| T8 Identity leak | radio scanners, the next owner, `.com` | learn which account owns a box, or link a purchase to an account |
| T9 Grief by failed attempts | neighbour | lock the buyer out with wrong guesses |

Out of scope: an attacker who controls the buyer's phone, and one who controls the box after its owner set it up
(that is the existing box security model).

## 5. The options

### 5.1 BLE first-come-first-serve on plug-in (the owner's sketch)

The box advertises over Bluetooth as soon as it powers on. The first app that connects claims it. A booklet says
"install the app first; if you cannot pair, return the box".

- **Racing (T1):** open to anyone within Bluetooth range, which is 10 to 50 m through walls. In a block of flats
  that is several households. An attacker's app can sit and wait for any new Flagship box to appear.
- **MITM (T3):** nothing stops it. With no shared secret and no screen on the box, the phone cannot tell the real box
  from a relay. A short authentication string (SAS) needs a second display; the box has none.
- **The worst part: MITM does not fail visibly.** A relay that forwards the claim gives the buyer a box that seems to
  work. "Return it if you can't pair" only catches the clumsy attacker who claims and keeps the box; it never catches
  the one who stays in the middle. Some later check might notice (the STK that `.com` reports would differ from the one
  the phone pinned), but then the attacker already saw the Wi-Fi password.
- **Cost of "return it":** each return is shipping both ways, restocking, a support contact and an unhappy buyer. An
  attacker can force returns at will (claim every box that appears in range), so returns become a denial of service
  we pay for. A retailer will not stock a product with that failure mode.
- **Good:** zero per-unit factory work; one image for every box.

Verdict: not safe enough. Fine as a *transport*, not as the *trust*.

### 5.2 BLE or LAN discovery plus a SAS compared on two screens

The standard fix for 5.1. Both sides show a short code derived from the handshake; the human checks they match.

- Needs a screen or a drivable LED on the box. Our boxes have neither by default. An HDMI monitor works (that is the
  DIY path in `nfc-box-pairing.md`) but buyers of a retail box should not need one.
- Without a screen the old design proposed an LED colour pattern (`LED_SAS_*` on `feat/retail`). Mini PCs do not let
  the OS drive the power LED, and colour patterns are slow and hard for colour-blind users.
- Does not stop racing (T1) on its own: a racer simply completes their own claim. The SAS only protects someone who
  is looking at the box.

Verdict: right idea, wrong hardware. Keep HDMI + on-screen code as the fallback (section 8.4).

### 5.3 Physical button opens a pairing window

The box only accepts a claim for a few minutes after someone presses its button.

- Proves a person is at the box now. Shrinks the race window from "any time" to "the minutes after the press".
- Does not stop a neighbour who is listening during those minutes (T1), and does nothing for MITM (T3).
- Power buttons are awkward: firmware usually forces power-off after a 4 s hold, so long-press gestures never reach
  the OS. Short presses (or several in a row) do reach it once the firmware is set to report them.

Verdict: a good add-on for resets and for reopening the radio, not the main defence.

### 5.4 Dynamic NFC tag with a per-boot key (current `feat/retail` design)

The box writes a fresh public key into a host-updatable NFC tag each boot; the phone reads it at about 4 cm, so
proximity authenticates the key (no code to compare).

- Strong against T1 and T3: the radio range is centimetres and the key changes each boot.
- **Needs custom hardware:** an NTAG-I2C or ST25DV chip, a companion microcontroller to feed it over USB, an antenna
  window in a non-metal case. We cannot buy that off the shelf. It breaks "commodity mini PC".
- iPads have no NFC; cheap Android phones often lack it. A second path is needed anyway.
- iOS Core NFC read-then-write in one session is fragile (the old doc's Q2 already plans a fallback).

Verdict: a possible later premium SKU. Not the first retail box.

### 5.5 Static NFC sticker carrying a secret

A cheap passive tag inside the box holds the claim code.

- Same secret as a printed QR, so the same strength, but **readable through cardboard**: a shop employee can tap a
  sealed box and read the code without breaking the seal (T2, T7). Cloning is trivial (T7).
- Useful only as a convenience that opens the app, carrying no secret (a link to the setup screen). Even that is
  little better than the QR code every phone camera reads.

Verdict: no secrets on NFC. Optional "tap to open the app" sticker at most (owner question Q3).

### 5.6 Printed QR code with a per-box secret (recommended)

A card inside the sealed box (and a sticker under the box) carries a high-entropy claim code. The phone scans it. The
code keys the handshake over any transport.

- **T1 racing:** a racer without the code cannot claim. The box rejects them after a few tries.
- **T3 MITM:** an attacker in the middle cannot complete a handshake keyed by a 100-bit code, and cannot guess it
  offline from what they see.
- **T2 / T7 leaked code:** someone who photographed the card can claim only from close by (claims are local only),
  and only while the box is unclaimed or in a reset window. The buyer recovers with a reset (section 8.1).
  Tamper-evident packaging makes the photo hard to take unnoticed.
- **Cost:** one per-unit step at the factory (generate the code, print it, put it in the right box). Section 9.1 keeps
  mismatches rare.
- Works on every supported phone and iPad: a camera is enough. Also the pattern HomeKit and Matter use for the same
  problem (a setup code on a label; Matter adds a device attestation certificate, our section 9.4).

### 5.7 Comparison

| | 5.1 BLE first-come | 5.2 BLE + SAS | 5.3 Button window | 5.4 Dynamic NFC | 5.5 Static NFC secret | 5.6 QR secret (+ local link + button) |
|---|---|---|---|---|---|---|
| T1 neighbour race | open | open | narrowed | closed | closed | closed |
| T2 shop employee | open | open | open | closed if sealed | open (reads through box) | closed if sealed; recoverable |
| T3 active MITM | open, silent | closed with a screen | open | closed | closed | closed |
| T4 swapped box | open | open | open | open | open | open until attestation (9.4) |
| T5 resale | n/a | n/a | n/a | clean | old owner keeps code | old owner keeps code; transfer or reset (8.2) |
| Needs a box screen or LED | no | yes | no | no | no | no |
| Custom hardware | no | no | no | yes | sticker only | card + sticker |
| Per-unit factory step | none | none | none | none | write tag | generate + print code |
| Works on iPad / NFC-less phones | yes | yes | yes | no | no | yes |
| "Return if it fails" needed | yes, and can be forced | rarely | yes | rarely | yes | no (reset instead) |

## 6. Why "install the app first, return it if you can't pair" is not the plan

The booklet can still say "install the app first", because it makes setup smooth. It must not be the security. The
box waits for its owner as long as it takes: with the claim code there is no race to win by being early. And the
answer to "someone else set it up" is a reset the buyer does at home in a minute (section 8.1), never a trip back to
the shop. Returns are for hardware faults and for a card that does not match its box.

## 7. The recommended design

### 7.1 The claim code

- 100 random bits from the box's own RNG at the factory, behind the RNG gate (`rngGate.ts` on `feat/retail`).
- Printed as 20 characters of Crockford base32 in five groups of four (`7KQ2-M9XD-...`), and as a QR code holding
  `https://flagshipserver.com/claim#c=<code>&v=1`. The fragment never reaches a server (same rule as today's app
  links). Without the app, the link opens the store page (`apps/web/public/open/`).
- The QR also carries the box's **model and serial printed in clear** next to it, so a card in the wrong box is
  obvious (section 9.1). The serial is never sent to `.com`.
- The box keeps the code, or a key derived from it, in a TPM NV index (fallback: a root-only file on the recovery
  partition). It survives resets. It is not readable over any network interface.

Why 100 bits and no PAKE: with a long code a plain pre-shared-key handshake is safe. An attacker who plays the box to
the phone sees one confirmation tag that depends on the code; guessing 2^100 codes offline is out of reach. A PAKE
(CPace, SPAKE2+) would be needed only for a short code the user types (6 to 8 digits). Typing 20 characters is the
rare fallback, so we keep the simpler construction. Owner question Q4 if a short typed code is wanted.

### 7.2 Transports

The handshake is identical on each. Security comes from the code, so the transport is chosen for reach, not trust.

- **LAN (box on Ethernet, phone on the home Wi-Fi):** the unclaimed box advertises `_flagship-claim._tcp` over mDNS
  with a random instance name and listens on one port. Fastest. iOS asks for Local Network access (the app already
  declares it for LAN-direct; add the service type to `NSBonjourServices`).
- **Bluetooth LE (no cable, or the phone is on another network):** the box advertises one Flagship service UUID with
  a random per-boot identifier and no name. The phone connects, runs the handshake over a GATT characteristic (or an
  L2CAP channel where both sides support it; a claim is a few KB with the PQ keys) and sends the Wi-Fi details inside.
- **Not through `.com`.** No relay, no rendezvous id. This keeps `.com` out of the claim and stops a remote attacker
  with a photographed code. The `feat/retail` NFC rendezvous drop-box is not used.

Radio hygiene (T8, T9): the BLE advert stays up for 30 minutes after power-on while unclaimed, then stops; one short
press of the power button reopens it for 30 minutes. The LAN listener stays up while unclaimed. After five failed
handshakes the box closes both until the next button press. A claimed box advertises nothing.

### 7.3 The handshake (`flagship/box-claim/v1`)

Sketch for review, not the final wire format.

1. Phone and box each send an ephemeral X-Wing public key (hybrid X25519 + ML-KEM, as `flagship/pq-session/v1` uses),
   with fresh nonces. The box adds its state: `unclaimed`, `claimed` or `reset-window`.
2. Both derive `K = HKDF(kem_secrets, salt = H("flagship/box-claim/v1" | code), info = transcript)`.
3. The phone sends a confirmation MAC under `K`. The box checks it before it says anything else; a wrong MAC counts
   as a failed attempt. The box then sends its own MAC. Each side now knows the other holds the code.
4. Everything after travels under `K` (AES-GCM, as the existing seals).

The box's state answer is authenticated by the code, so an attacker cannot fake "claimed" to push a buyer into a
return, nor fake "unclaimed".

### 7.4 What the claim carries

Phone to box, under `K`:

- The **recipe**, exactly as Studio or a USB stick delivers it today: owner IRK, the admin-signed AuthCode, server name
  and settings, boot unlock mode. The box verifies it with the code it already runs for seed-disk recipes. This is the
  consent: a key and signatures the box checks, never a yes/no flag.
- **Wi-Fi details** (optional): the `WiFiConfig` envelope from `feat/retail` (SSID, password, region).
- Nothing about the account beyond what the recipe already holds (the box needs the namespace to register).

Box to phone, under `K`:

- A **claim receipt** signed by the box's new STK and its PQ half: the STK public key, the boot key binding
  (`flagship/boot-key-binding/v3`), the hardware model, the factory image version, and a hash of the handshake
  transcript. The phone **pins this STK** as the server's key (G4). When the box later shows up on `/pods`, the phone
  checks `.com`'s STK equals the pinned one and alarms if not. Retail boxes get a real out-of-band pin, where USB and
  VM installs still rely on trust on first use.

Then the box does what an appliance does after reading its seed disk: joins Wi-Fi, re-encrypts to its per-box LUKS
key sealed for the phone, registers with `.com` under the AuthCode, takes its first-boot update, asks the phone for
the first unlock. The phone shows the existing "Waiting for your server" timeline.

Only an admin device can claim, because only an admin device can sign the AuthCode. A non-admin device that scans a
card sees "Only an admin device of this account can set up a server."

### 7.5 Box states

```
            factory
               |
               v
   +----------------------+   claim with code + valid recipe
   | UNCLAIMED            |---------------------------------------+
   | listens LAN, BLE 30m |                                       |
   +----------------------+                                       v
               ^                                        +-------------------+
               | claim with code completes:             | CLAIMED           |
               | box wipes, reimages, then              | normal server     |
               | applies the new recipe                 | no claim listener |
   +----------------------+   5 short presses           +-------------------+
   | RESET-WINDOW (10 min)|<--------------------------------------+   |
   | data intact          |                                           |
   +----------------------+   window ends with no claim: back to CLAIMED
                                                                      |
   admin-signed "release this box" order (owner's app) ---------------+--> wipe --> UNCLAIMED
```

- The wipe happens **only when a new claim completes** in the reset window. Five accidental presses, or a burglar
  pressing buttons, erase nothing. The window closes after 10 minutes and the box carries on as before.
- A box in the reset window still serves its owner. The owner's phone gets an Activity entry and a push: "Someone
  pressed the reset button on home. If that was not you, the server is unchanged; it stays yours unless the setup
  card is used in the next 10 minutes." (Wording through i18n.)

## 8. Recovery

### 8.1 Someone else set it up first

The buyer scans the card. The handshake succeeds (they hold the code) and the box answers `claimed`. The app says:
"This box was already set up by another account. If you just bought it, press its power button five times, then tap
Set it up again. Setting it up erases everything on it." The buyer presses, taps, and the claim completes. The other
account's server goes offline for good; its owner can delete it.

The box never says who claimed it. The handshake carries no account name.

What this costs us: nothing, unless the code itself is wrong for the box (section 9.1). No return, no support call
for the race case.

### 8.2 Resale and handing over

- **Seller cooperates:** use the existing transfer-a-box flow (`docs/account-deletion-and-name-reclaim.md` section 4)
  to hand it over with data, or "Release this box" in the app (an admin-signed order the box verifies) to wipe it back
  to UNCLAIMED. The buyer then claims with the card.
- **Seller does not cooperate, or the box is second-hand from a stranger:** the buyer uses the reset window. The
  previous owner still knows the printed code, so they could race the reset window, but only from near the box, during
  those 10 minutes. The app tells a buyer of a second-hand box to do the reset with the box at home, out of reach of
  the seller.
- The previous owner's data: the reset reimages from the recovery partition and destroys the old LUKS header and key
  slots (`wipeVerifier.ts` on `feat/retail` checks the wipe). Their keys never lived anywhere the new owner can read.

### 8.3 Returns to a shop

The returns desk scans the card with the Flagship app (no account needed for a status check). The authenticated state
answer says `unclaimed` or `claimed`. A claimed box gets the five presses and a "Release for return" claim from the
desk app that only wipes (no recipe), restoring factory state. Owner question Q6: whether shops get this mode or boxes
come back to us.

### 8.4 Lost card, dead Bluetooth

- The sticker under the box carries the same code.
- Both lost: plug in a monitor, press the power button five times. The box shows its QR code and the 20 characters on
  screen. Showing the code needs physical presence at the box, which is the same proof the card gives.

### 8.5 Stolen box

The disk is encrypted to a key only the owner's phone can unseal, as today. A thief can wipe and claim the box (they
have it and may have the sticker), but cannot read anything. Owner question Q5: a "stolen" list of factory attestation
keys that phones refuse to claim, once attestation exists (section 9.4). It is checked on the phone, never at `.com`.

## 9. What each part needs

### 9.1 The factory

- Write the metal appliance and the recovery partition (one image per SKU, no per-unit image).
- Boot each box once on the burn-in rack (they do that anyway). On that boot the box generates its claim code, seals
  it into the TPM, and hands it over a wired factory link to the label printer. The box makes its own secret, so no
  per-unit secret is ever stored by us or the factory beyond the print job.
- Print the card and the sticker. Stick the sticker on the box, put the card in the same box, seal with
  tamper-evident tape. Card and sticker carry the serial in clear so a mix-up is visible.
- Nothing else is secret. No account, no recipe, no `.com` registration at the factory.

### 9.2 The box (software)

- The claim service: LAN listener, BLE GATT peripheral through BlueZ over D-Bus, the handshake, the state machine,
  the reset window, rate limits.
- Power button: logind ignores the key; a small daemon counts presses (one press reopens BLE on an unclaimed box,
  five presses open the reset window; on a claimed box a single press keeps meaning "shut down cleanly").
- The HDMI fallback screen.
- Recovery partition and the reimage path.
- Bluetooth and Wi-Fi firmware for the chosen SKUs (Debian `non-free-firmware`), on the metal appliance only.

### 9.3 The phone apps

- **iOS (18.0 floor):** QR scanning with VisionKit `DataScannerViewController` or AVFoundation (all supported
  devices, iPad included). Bluetooth through **AccessorySetupKit** (iOS 18.0+): a system sheet finds the Flagship
  service and grants access to that one accessory, without the general Bluetooth prompt; Core Bluetooth then runs the
  connection in the foreground. LAN through Network.framework with the Local Network permission. No NFC needed. If we
  add a "tap to open" sticker later, background tag reading opens the universal link on iPhone XS and later (every
  iOS 18 iPhone) with no entitlement beyond Associated Domains.
- **Android (API 29 floor):** CameraX with a bundled QR decoder (no Google Play services, so de-Googled phones work).
  Bluetooth through **CompanionDeviceManager** association (API 26+), which avoids the location permission that a raw
  BLE scan needs on Android 10 and 11; `BLUETOOTH_CONNECT` on 12+. LAN through NsdManager.
- Both: the handshake and the claim (shared vectors in TS, Swift, Kotlin), the "Set up a box from a store" entry in
  Add a server (admin devices only), the already-claimed screen, the reset instructions, the STK pin from the receipt
  and its check against `/pods`.
- The webapp cannot do Bluetooth on iOS Safari and has no mDNS. It shows "Use the Flagship app on your phone to set
  up this box."

### 9.4 Later: proving the box is genuine (T4)

The claim code proves "the phone talks to the box that came with this card". It does not prove the box runs our
image. A supply-chain attacker who swaps box and card together wins. The fix is the Matter-style approach on the TPM:

- At the factory the box makes a non-exportable attestation key in its TPM; our offline manufacturing CA certifies it.
- During the claim the box sends a TPM quote of its Secure Boot and boot measurements, signed by that key.
- The phone checks the certificate against the CA key in the app and the measurements against the release's expected
  values, offline. It shows "Genuine Flagship box" or "Not a Flagship box: set it up only if you built it yourself."
- `.com` sees none of it. The attestation key is a stable hardware id, so it goes only to the phone.

This needs reproducible metal images and measured boot (still open for the boot chain: AGENTS.md, milestone 6, "no
TPM quote or UKI"). Phase 3.

### 9.5 `.com`

Nothing new for the claim. The box registers with the AuthCode like any server. Specifically we do **not** ship
`box_serials`, `/api/serial/activate` or the serial binding from `feat/retail` for retail pairing: binding a serial to
a server key lets anyone who joins our database with a retailer's sales records learn which buyer owns which account
(T8), and the claim code already does the job the activation gate was for. If warranty needs a serial, it stays on
the card and in the retailer's system, not ours (owner question Q7).

## 10. The buyer's flow

1. Open the box. Check the seal was intact. Take out the box, the cable, the power brick and the setup card.
2. Install Flagship on the phone and create an account, if not done (the booklet's first page says so; it is a
   convenience, not a requirement).
3. Plug the box into power, and into the router with the cable if possible.
4. In the app: Add a server, Set up a box from a store. Scan the card.
5. The app finds the box on the home network, or asks to use Bluetooth ("Flagship wants to find your box nearby").
6. No cable: the app asks which Wi-Fi to join and its password.
7. Name the server. Face ID or fingerprint to sign. The box sets itself up; the app shows the usual timeline and asks
   for the first unlock approval when the box restarts.
8. Done: the server is on Home, with a padlock on its address.

Booklet text (English source; every line goes through `i18n/retail-booklet/` like any other surface):

> **Before you start.** Install the Flagship app on your phone. Keep this card: it is the key that lets you set up this
> box. Don't share a photo of it.
>
> **Set up.** Plug in the power and, if you can, the network cable. In the app, tap Add a server, then Set up a box
> from a store, and scan the card. Your phone finds the box on its own.
>
> **If the app says this box is already set up.** Press the box's power button five times, quickly. Then tap Set it up
> again. Setting it up erases anything on the box. Only someone holding this card, standing near the box, can do this.
>
> **Selling or giving it away.** In the app, use Hand over this server, or Release this box. Give the new owner this
> card.
>
> **Lost the card?** The same code is on the sticker under the box. No sticker either: connect a screen, press the
> power button five times, and the box shows its code.
>
> **The seal was broken when you got it?** Ask the shop for another box.

## 11. Work breakdown

### 11.1 What exists on `feat/retail` (6 commits off `main`, behind `release/0.4`)

| Piece | File | Fate |
|---|---|---|
| PAIR payload, transcript, `K_session`, SAS | `packages/protocol/src/nfcPair.ts` | Rework into `box-claim/v1`: drop the per-boot STK and the unauthenticated PAIR; keep the HKDF transcript shape; add the code and X-Wing |
| `WiFiConfig` envelope + seal | same | Reuse as is |
| `BoxUnpair` (rebind only) | same | Replace with "release this box" (admin-signed, wipes); Q4 of the old doc said rebind only, owner to confirm (Q8) |
| LED-SAS alphabet and verifier | same + mobile | Drop (no drivable LED) |
| First-claim latch, session lock | `server-daemon/src/nfcPairing/pairStateMachine.ts` | Reuse the latch; add `reset-window` and rate limits |
| RNG gate | `nfcPairing/rngGate.ts` | Reuse |
| Wipe verifier | `nfcPairing/wipeVerifier.ts` | Reuse for reset and release |
| Per-boot key emitter | `nfcPairing/pairEmitter.ts` | Drop |
| NFC rendezvous drop-box on `.com` | `control-plane/src/nfcRendezvous.ts`, migration 0040 | Drop (claims never go through `.com`) |
| Serial activation, `bindStk`, rendezvous lookup | `control-plane/src/serialActivation.ts`, `serverRegister.ts` | Drop for pairing (section 9.5) |
| iOS and Android NFC reader, pair screens, view models, tests, strings | `apps/mobile/...Nfc*` | Reuse the screen flow, view model shape and strings; swap the NFC reader for QR + BLE + LAN |

### 11.2 New work

Phase 1, software only (testable on any mini PC or a VM with a test code, no factory):

1. `flagship/box-claim/v1` spec, TS reference, Rust (box side), Swift, Kotlin, shared vectors including wrong code,
   replay, MITM key swap, state forgery. External review with the PQ session (same reviewer).
2. Box claim service: LAN listener, BLE peripheral (BlueZ), state machine, reset window, rate limits, power-button
   daemon, HDMI code screen, recipe hand-off into the existing appliance specializer.
3. Recovery partition and reimage; "release this box" order (admin root signed) and its consumer.
4. iOS: QR scan, AccessorySetupKit + Core Bluetooth, LAN, claim flow, STK pin from the receipt and the `/pods` check,
   already-claimed and reset screens. Then Android in spirit (CompanionDeviceManager, NsdManager, CameraX). Mock gym
   scenarios on both.
5. i18n for every new string, including the booklet surface.
6. A gym lane: a VM with a virtual "factory" code, claimed over the LAN path; a second claim refused; reset window and
   re-claim.

Phase 2, hardware and factory:

7. Pick the SKU(s); check the BLE peripheral role, firmware power-button setting, TPM NV, Secure Boot with our shim.
8. Metal appliance build per SKU (drivers, firmware) in CI; the recovery image.
9. Factory burn-in tool: generate code on the box, print card and sticker, verify the printed code against the box
   over the wired link before sealing.
10. Packaging: tamper-evident seal, card sleeve, sticker placement, booklet.

Phase 3, genuineness:

11. TPM attestation key, offline manufacturing CA (YubiKey, like the release keys), quote verification in the apps,
    measured-boot expected values per release, optional stolen list.

Side benefit for Q2 of the journal: phase 1 also gives a **preinstalled image for DIY metal**. Studio can write the
metal appliance to a stick or disk, generate the code itself and show it, and the user claims over the LAN like a
retail box. That would let USB installs skip the Debian installer. Owner question Q9.

## 12. Questions for the owner

- **Q1** Accept the recommendation: per-box printed claim code, local-only claim (LAN or BLE), no first-come pairing,
  no NFC in the first version?
- **Q2** Who ships the hardware (old doc's Q3, still open): our own SKU through a contract manufacturer, or a partner's
  mini PC with our image? This decides the factory steps and phase 2.
- **Q3** Add a "tap to open the app" NFC sticker with no secret, or QR only?
- **Q4** A 20-character typed fallback (simple handshake), or a short 8-digit code with a PAKE (more crypto to build
  and review, easier to type)?
- **Q5** Phase 3 genuineness check and a stolen list: wanted at all, and before or after the first retail sale?
- **Q6** Returns: may shops wipe a returned box with the app, or do returns come back to us?
- **Q7** Confirm dropping `box_serials` / serial activation from `feat/retail` (identity link to retail sales), keeping
  serials off `.com` entirely.
- **Q8** "Release this box" from the app: wipe (recommended), or rebind only as the old doc decided?
- **Q9** Use the same claim flow for DIY metal installs (a preinstalled image instead of the Debian installer)?
- **Q10** Second-hand boxes: is the 10-minute reset-window race with the previous owner acceptable, given they must be
  near the box? The alternative is a per-owner code rotation that needs a screen or a new card.
