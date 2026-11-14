# Retail boxes: how a buyer pairs a preinstalled box

**Status:** design v2, not built. Release 0.4 item F4 ("Preinstalled ISO"). Owner decision of 2026-11-14: the
recommended flow is first-boot Bluetooth pairing with no per-unit printed card, hardened by a timed button press and
an internet key check. The printed 100-bit claim code of design v1 (2026-11-13) stays as an optional **Verified**
upgrade for our own future hardware (section 9). Supersedes the pairing choice in `docs/nfc-box-pairing.md` (on
`feat/retail` and copied to `release/0.4`) for retail boxes; that doc's protocol pieces are reused where noted in
section 13.

The owner's question of 2026-11-13, verbatim: "I mean thinking of the setup for retail boxes? Do we bundle an NFC tag?
Do we just use a first-come-first-serve beam-to-nearby-apps-over-Bluetooth as soon as you plug it in? (With a booklet
warning you to please install the app before plugging in the machine. And return it if you can't get a pairing ...
maybe someone raced you to pair) how do we avoid MITM?"

## 1. The answer in short

1. **App first, then power.** The buyer opens the app. It scans Bluetooth LE and tells them to plug in the box. The
   box must appear only after that, and must be the only unclaimed Flagship box nearby. Anything else stops the setup.
2. **A short radio window.** An unclaimed box advertises for 10 minutes after power-on, then goes quiet.
3. **A timed button press.** Once the box appears, the app says "Press the power button now". The box must report
   one short press within a few seconds. The timing carries the security. A neighbour cannot press a button in
   someone else's home, so nobody can race the buyer. A short press never shuts the box down (section 7.5).
4. **Ethernet recommended.** With a cable, no Wi-Fi password crosses the radio. Over Wi-Fi the app warns first.
5. **An internet check after pairing.** The phone compares the key the box gave it over Bluetooth with the key the box
   registered at `.com`, and alarms on any mismatch. Pressing the power button five times reclaims the box.
6. **Nothing per unit, nothing at `.com`.** No card, no serial, no MAC address sent anywhere. The box itself refuses a
   second claim, and its key is registered at claim. That is the "burned" effect.

What this does not do, said plainly: it cannot detect a live relay that sits within Bluetooth range during setup and
clones the real box after it appears. Section 6 says what such an attacker gets and which variants the internet check
catches. Buyers who need more can plug in a monitor (section 8.4), and our own future hardware can carry the Verified
upgrade (section 9).

## 2. What a retail box is (assumptions)

- A commodity device we pick per SKU, sold with our image: an x86-64 mini PC (NUC-style, Beelink, Minisforum, ASUS)
  or a Raspberry Pi 5. Not custom hardware. Ethernet, Bluetooth LE, a power button. **No screen and no LED we can
  drive** on most models. Section 10 is the checklist a model must pass.
- "Preinstalled" means the published VM appliance (`docs/desktop-vm-appliance.md`, "Chosen path"), built for metal,
  written to the internal disk: EFI + `/boot` + LUKS root under the disposable build key, plus a small **recovery
  partition** holding the signed factory image for resets (section 8). On first claim the box replaces the disposable
  LUKS key with a per-box key sealed to the owner's phone, as appliances already do, and moves itself to the newest
  endorsed release (`firstBootUpdate.ts`).
- Firmware is set per SKU: power on after AC loss, a short power press reported to the OS (not a hard off), boot
  order locked, Secure Boot with our shim where the board has it.
- Every unit of a SKU gets the same image. No per-unit step beyond writing the disk.

## 3. What pairing must achieve

Pairing a retail box replaces "burn a USB stick with your recipe". It must:

| # | Goal | Why |
|---|------|-----|
| G1 | The buyer's phone talks to **this** box, the one in their hands | targeting; two boxes in one flat |
| G2 | Nobody in the middle can read or change the exchange | MITM on Bluetooth |
| G3 | Only the buyer can claim it | neighbour, shop employee, courier |
| G4 | The phone learns the box's server key (STK) from the box, and checks it against `.com` | today the owner path takes the STK from `.com` only (`docs/architecture-v2/evidence-map.md` item 1) |
| G5 | The box gets the owner's consent as signatures it verifies | owner rule: consent is load-bearing crypto |
| G6 | Wi-Fi credentials reach the box when there is no cable | most homes |
| G7 | Resale, returns and resets are clean; the last owner keeps nothing | second-hand market |
| G8 | No account identity or hardware id leaks: not on the radio, not to the next owner, not to `.com` | owner rule |

G5 is already solved by the current install path. The recipe carries the owner IRK and an AuthCode only an admin
device can sign (`flagship/auth-code-admin/v1`, AGENTS.md "Adding a server is admin-only"). The box refuses anything
else. Retail pairing has to **deliver** that recipe, plus Wi-Fi, and bring back the box's key.

Without a shared secret or a screen, G2 cannot be fully met over Bluetooth. That is the honest gap of this design,
and the reason the Verified upgrade exists.

## 4. The buyer's flow

The box is headless. No monitor, no keyboard.

1. Open the box. Check the seal. Take out the box, the cable and the power brick.
2. Install Flagship on the phone and create an account, if not done.
3. In the app: Add a server, then Set up a box from a store. The app turns on Bluetooth scanning and checks that no
   unclaimed Flagship box is already advertising nearby. If one is, it stops: "Another Flagship box nearby is waiting
   to be set up. If it is yours, unplug it and start again. If not, set this box up somewhere else or use a network
   cable and a screen."
4. The app says: "Plug the network cable into your router if you can. Then plug in the power." The box boots (power
   on after AC loss; no button needed). If it stays off, the app says "Press the power button once."
5. The box appears, usually within a minute. The app checks it is the only one. If a second box appears at any point
   until the claim completes, the app stops and asks the user to check.
6. The phone and box open an encrypted Bluetooth session. After a short random pause, the app says "Press the power
   button now". The box reports one short press within a few seconds. Too early, too late, more than one, or another
   phone trying at the same moment: the app stops and explains.
7. Name the server. Face ID or fingerprint to sign the recipe. The box receives it and answers with a receipt signed
   by its new server key: the phone now has the box's public key.
8. The phone registers that key at `.com` under the recipe's AuthCode (it has internet; the box may not yet). From
   then on `.com` accepts this server only from that key.
9. No cable: the app asks which Wi-Fi to join, warns (section 7.6), then hands the password to the box. The box sets
   itself up; the app shows the usual timeline and asks for the first unlock approval.
10. Once the box is online, the app checks that the box that came online holds the key it registered. A match shows
   the server on Home with a padlock. A mismatch, or a box that never comes online, shows an alarm (section 7.7).

If the box never appears: it may already be claimed (by a shop employee, a previous owner, or someone who raced). The
app says: "No new box appeared. If this box was set up before, press its power button five times, quickly, then tap
Try again. Setting it up erases everything on it."

### 4.1 Booklet text

English source; every line goes through `i18n/retail-booklet/` like any other surface.

> **Before you plug it in.** Install the Flagship app on your phone and open it. Tap Add a server, then Set up a box
> from a store. The app tells you when to plug in the box.
>
> **Use the network cable if you can.** Plug it into your router before the power. Then your Wi-Fi password never has
> to travel over the air.
>
> **Plug in the power.** The box starts by itself. When the app asks, press the power button once. A short press
> only: it does not switch the box off. Holding the button for several seconds does.
>
> **Set it up at home, with no other new Flagship box switched on nearby.** The app stops if it sees two.
>
> **If the app finds no box, or says this box is already set up.** Press the power button 5 times, quickly. Then tap
> Try again in the app. Setting it up erases anything on the box. Only someone standing at the box can do this.
>
> **If the app shows a red warning after setup.** Do not use that server. Press the power button 5 times and set the
> box up again, with the network cable. If you used Wi-Fi, change your Wi-Fi password.
>
> **Selling or giving it away.** In the app, use Hand over this server, or Release this box.
>
> **The seal was broken when you got it?** Ask the shop for another box.

## 5. Threat model

| Threat | Who | What they want |
|---|---|---|
| T1 Race | neighbour within Bluetooth range (10 to 50 m through walls) | claim the box first: grief, or own a box in someone's home |
| T2 Pre-sale claim | shop employee, warehouse, courier with the box in hand | claim it before the buyer |
| T3 Relay MITM | attacker with radio kit within range during setup | sit between phone and box, swap keys, read the Wi-Fi password, or get the recipe |
| T4 Pre-staged fake | attacker who places a fake "box" advert before the buyer starts | make the phone pair with the fake |
| T5 Supply-chain swap | anyone between factory and buyer | a box with a backdoored image that pairs normally |
| T6 Resale | previous owner | keep access, or read old data |
| T7 Theft | burglar | read data; reuse the box |
| T8 Identity leak | radio scanners, the next owner, `.com` | learn which account owns a box, or link hardware to an account |
| T9 Grief | neighbour | stop the buyer from finishing setup |

Out of scope: an attacker who controls the buyer's phone, and one who controls the box after its owner set it up
(the existing box security model).

## 6. What each defence buys, honestly

| Threat | Standard (this design) | Verified (section 9) |
|---|---|---|
| T1 race | **closed.** The claim needs a timed press on the box, bound to one session; a second phone arming at the same time aborts both | closed |
| T2 pre-sale claim | **recoverable.** The buyer sees no box, does the 5-press reset at home and claims; the employee would need to be at the box during the reset window | recoverable; also needs the card |
| T3 relay MITM | **open.** Partly detected: a relay that passes the claim on to the real box is caught by the internet check (7.7). A relay that keeps the claim is not | closed (the code keys the handshake) |
| T4 pre-staged fake | **filtered.** The phone refuses if any unclaimed box advertises before power-on, or two appear. A fake that appears at the same moment and hides the real one is T3 | closed |
| T5 supply-chain swap | **open** | closed once TPM attestation exists (9.3) |
| T6 resale | **clean.** No secret survives a reset; the previous owner must be at the box during the 10-minute reset window | clean if the card goes with the box |
| T7 theft | disk unreadable (sealed to the owner's phone); a thief can reset and reuse the box | same |
| T8 identity leak | **closed.** Random per-boot Bluetooth address and id, no name, no serial or MAC to `.com` | same; the attestation key goes only to the phone |
| T9 grief | **open.** A neighbour can keep arming and force aborts while the window is open. Remedy: unplug and replug later, or a monitor (8.4) | closed by the code |

### 6.1 The relay case in detail

The attacker runs two Bluetooth sessions: one with the buyer's phone (pretending to be the box) and one with the real
box (pretending to be the phone). The phone sees one box, because the attacker clones the real advert, can drown it
out, and iOS never shows Bluetooth addresses anyway. The user's press happens on the real box, which reports
it to the attacker's session, which reports them to the phone. The button proves a person is at a box. It cannot
prove which session that person is looking at.

The attacker then has the phone's recipe (signed; they cannot change it) and, over Wi-Fi, the Wi-Fi password. Two
variants:

- **Pass it on.** The attacker forwards the recipe to the real box and makes its own key to sign the phone's receipt
  (the phone has no prior key to check against). The real box registers its real key at `.com`. The internet check
  sees two different keys and alarms. The attacker keeps the Wi-Fi password.
- **Keep it.** The attacker sends the real box a recipe from the attacker's own account, and registers the buyer's
  recipe on hardware the attacker controls. The phone's pinned key equals the key at `.com`. No alarm. The buyer's
  data lives on the attacker's machine, and the attacker owns a box inside the buyer's home (it can grant itself debug
  access, like any owner). This variant is silent.

What the attack costs: custom radio kit within Bluetooth range during the setup minutes of one targeted buyer. It is
not a drive-by attack, and it cannot be done remotely or in bulk. The design accepts it for the Standard tier and
says so in the app's help. Defences that close it: a monitor on the box (8.4), or the Verified card.

## 7. The design

### 7.1 Discovery and the presence rule

- The app starts scanning for the Flagship service UUID **before** the user powers the box. Any unclaimed advert
  already visible stops the flow.
- After power-on, exactly one new advert must appear. The app keeps scanning until the claim completes. A second
  unclaimed advert, or the first one vanishing and reappearing with a different id, stops the flow.
- This filters a fake staged in advance and an innocent second box in the same flat. It cannot detect a clone that
  appears at the same time as the real box, or a relay that hides it (section 6.1).

### 7.2 Advertising

- An unclaimed box advertises one Flagship service UUID, a random per-boot identifier and a state byte (`unclaimed`
  or `reset-window`). No name, no model, no serial. Resolvable private address rotation as BlueZ does by default.
- Unclaimed: it advertises for **10 minutes after power-on**, then stops and drops every session. Power-cycling opens
  a new window. Reset window: also 10 minutes (section 7.5).
- A claimed box advertises nothing.
- No LAN claim path. Claims are Bluetooth only, so the presence rule means something. (Ethernet only gives the box its
  internet.) Trays without Bluetooth claim through the `.com` lobby and mailbox instead, never over the LAN:
  `docs/retail-wired-fleet.md`.

### 7.3 The handshake (`flagship/box-claim/v1`, mode `open`)

Sketch for review, not the final wire format. The same message flow serves the Verified mode (section 9).

1. Phone and box each send an ephemeral X-Wing public key (hybrid X25519 + ML-KEM, as `flagship/pq-session/v1` uses),
   with fresh nonces, the mode and the box state.
2. Both derive `K = HKDF(kem_secrets, salt = H("flagship/box-claim/v1" | mode | code-or-empty), info = transcript)`.
   In mode `open` the code is empty, so `K` is unauthenticated: it hides the session from passive listeners only.
3. Everything after travels under `K` (AES-GCM, as the existing seals).
4. A box that holds a Verified code refuses mode `open`. A phone that scanned a card refuses a box answering `open`.

### 7.4 The timed press

The box is the authority. The phone checks too, to catch a fake that makes presses up.

- **Arm.** The phone sends `arm` over the session. The box accepts one armed session at a time. If a second session
  arms while one is armed, or within the press window, the box aborts both and tells each `contention`. The app says:
  "Another phone tried to set up this box at the same moment. Make sure nobody nearby is setting up a Flagship box,
  then try again."
- **Instruction.** After a random 2 to 6 s pause, the phone shows "Press the power button now". The box does not
  learn when the instruction appeared.
- **The press.** The box reports each short press with its offset from `arm`. It accepts the claim only if exactly one
  short press (a burst of one, released within 1.5 s) arrives inside the 20 s after `arm`. The phone also requires
  that it came after its instruction and within 5 s of it. A press before the instruction means the box (or something
  pretending to be it) made it up: the app stops with "This box reported a press before you were asked. Don't
  continue." A fake guessing the hidden pause fails often, and a failure is itself a warning. One press, not several,
  because it is less awkward and less likely to go wrong; the timing does the work, not the count.
- **One claim per arm.** A successful press check gives that session one claim, valid for 2 minutes. Then the box
  takes the recipe.

### 7.5 The power key on the box

- `systemd-logind` is set with `HandlePowerKey=ignore`, `HandlePowerKeyLongPress=ignore`, `HandleRebootKey=ignore`,
  `HandleSuspendKey=ignore`, `HandleHibernateKey=ignore` (a `logind.conf.d` drop-in, on unclaimed and claimed boxes).
- A small root service reads `KEY_POWER` (EV_KEY 116) from the ACPI "Power Button" input device (or the Pi 5's
  `pwr_button`) through evdev, and counts bursts: presses less than 1.5 s apart, the burst ends 2 s after the last.
- The drop-in ships in the image, so it is in force from the very first boot. A short press therefore never shuts
  down or reboots the box, claimed or not. Only a hold of about 4 s does, because that is a firmware hard off the OS
  never sees. No gesture uses a hold. Gestures are short presses only.
- The press that powers the box on happens while the OS is off, so it is never counted. The service also ignores
  presses in its first 10 s, for bounce.
- Meanings:
  - Unclaimed or reset window, a session armed: presses feed the press check (a burst of one passes; any other
    burst fails it).
  - Unclaimed, nothing armed: ignored.
  - Claimed, a single press outside any window: **nothing** (recommended). It used to mean "shut down cleanly"; that
    moves to the app (the existing power controls), so a stray press or a curious child changes nothing.
  - Claimed, a burst of 5: the deliberately different gesture, so it cannot happen by accident. It opens the
    **reset window** for 10 minutes. The box keeps serving its owner, advertises with state `reset-window`, and
    wipes only when a new claim, with its own timed press, completes. If the window ends with no claim, nothing
    changed. The owner gets an Activity entry and a push: "Someone pressed the reset button on
    home. If that was not you, the server is unchanged and stays yours unless someone sets it up in the next 10
    minutes." (Wording through i18n.)
  - Unclaimed or reset window, a burst of 3 (owner, 2026-11-14): show the current setup code as a QR code on an
    attached monitor, for the sharing method (15.1). Nothing appears on screen until asked. No monitor: nothing.
  - Claimed, any other burst: ignored.

### 7.6 What the claim carries

Phone to box, under `K`:

- The **recipe**, exactly as Studio or a USB stick delivers it today: owner IRK, the admin-signed AuthCode, server name
  and settings, boot unlock mode. The box verifies it with the code it already runs for seed-disk recipes.
- **Wi-Fi details** (optional): the `WiFiConfig` envelope from `feat/retail` (SSID, password, region). Before sending
  it, the app warns: "Your Wi-Fi password goes to the box over Bluetooth. If someone nearby is intercepting this setup,
  they could read it. A network cable avoids this." Buttons: Use a cable instead / Send it.

Box to phone, under `K`:

- A **claim receipt** signed by the box's new STK and its PQ half: the STK public key, the boot key binding
  (`flagship/boot-key-binding/v3`), the hardware model, the factory image version, and a hash of the transcript. The
  phone pins this STK. In mode `open` the pin is only as good as the session (a relay can sign its own receipt), which
  is why 7.7 exists.

Then the box does what an appliance does after reading its seed disk: joins the network, re-encrypts to its per-box
LUKS key sealed for the phone, registers with `.com` under the AuthCode (which registers its STK: from here the box
refuses any further claim), takes its first-boot update, asks the phone for the first unlock.

Only an admin device can claim, because only an admin device can sign the AuthCode. A non-admin device sees "Only an
admin device of this account can set up a server."

### 7.7 The internet check

- When the server first shows on `/pods`, the phone compares `.com`'s STK and boot key binding with the receipt. It
  also opens the box over the relay path (`<server>.<user>.flagship.services`, TLS ends on the box) and checks the
  certificate chains to the pinned STK.
- Match: done. Mismatch, or the box never registers while another server under this AuthCode does: a full-screen
  alarm. "The server that came online is not the box you paired with. Someone may have intercepted the setup. Don't
  use it. Press the box's power button 5 times and set it up again, with a network cable. If you sent your Wi-Fi
  password, change it." The phone marks the server untrusted and offers Delete (the existing signed revoke).
- The AuthCode must be single use at `.com`, so one claim yields at most one registered server. Check this in
  `handleServerRegister`; make it so if not.
- Because the phone registers the box's key at `.com` before the box goes online (section 4 step 8), a "pass it on"
  relay's real box is refused at registration and never comes online: the same alarm, earlier.
- Honest limit: this catches the "pass it on" relay, not the "keep it" relay (section 6.1).

### 7.8 Box states

```
              factory
                 |
                 v
   +---------------------------+   timed press + valid recipe  
   | UNCLAIMED                 |-----------------------------------+
   | BLE for 10 min after boot |                                   |
   +---------------------------+                                   v
                 ^                                        +-------------------+
                 | new claim completes:                   | CLAIMED           |
                 | wipe, reimage, apply the new recipe    | key at .com       |
                 |                                        | no advert         |
   +---------------------------+     5 short presses      +-------------------+
   | RESET-WINDOW (10 min)     |<------------------------------+   |
   | data intact, BLE on       |                                   |
   +---------------------------+  window ends, no claim: back to CLAIMED
                                                                   |
   admin-signed "release this box" order (owner's app) -----------+--> wipe --> UNCLAIMED
```

## 8. Recovery

### 8.1 Someone else set it up first

The box does not advertise, so the app finds nothing. The buyer presses five times; the box advertises
`reset-window`; the app claims it with the timed press; the box wipes and takes the new recipe. The other account's
server goes offline for good; its owner can delete it. The box never says who claimed it. No return, no support call.

### 8.2 Resale and handing over

- **Seller cooperates:** the existing transfer-a-box flow (`docs/account-deletion-and-name-reclaim.md` section 4), or
  "Release this box" (an admin-signed order the box verifies) to wipe it back to UNCLAIMED.
- **Seller does not cooperate:** the buyer uses the reset window at home. No secret survives, so the seller could
  interfere only by standing near the box during those 10 minutes.
- Old data: the reset reimages from the recovery partition and destroys the old LUKS header and key slots
  (`wipeVerifier.ts` on `feat/retail` checks the wipe).

### 8.3 Returns to a shop

A returns desk powers the box, presses five times if it is claimed, and runs a "Release for return" claim from the
app (timed press, no recipe, wipe only). Owner question Q4: whether shops get this mode or boxes come back to us.

### 8.4 With a monitor (the strong path for Standard boxes)

Plug in a monitor and press the power button five times (or power on an unclaimed box with a monitor attached). The
box shows a QR code holding a fresh 100-bit one-time code on screen. The app scans it and runs the handshake in the
Verified mode with that code. This closes the relay case (T3, T9) for anyone with a screen at hand. The app offers it
from the Standard flow's help and after any alarm.

### 8.5 Dead Bluetooth

The monitor path still needs Bluetooth. A box whose Bluetooth fails goes back as a hardware fault. (A LAN fallback
keyed by the on-screen code is possible later: owner question Q6.)

### 8.6 Stolen box

The disk is encrypted to a key only the owner's phone can unseal, as today. A thief can reset and claim the box but
cannot read anything.

## 9. Verified: the printed code, for our own hardware

Kept from design v1 as an optional upgrade, for a future SKU we build ourselves through a contract manufacturer.

### 9.1 The claim code

- 100 random bits from the box's own RNG on the factory burn-in boot, behind the RNG gate (`rngGate.ts` on
  `feat/retail`), sealed in a TPM NV index (fallback: a root-only file on the recovery partition). It survives resets
  and is never readable over any interface.
- Printed on a card inside the sealed box and a sticker under the box: 20 characters of Crockford base32 in five
  groups of four, and a QR code holding `https://flagshipserver.com/claim#c=<code>&v=1` (the fragment never reaches a
  server). Model and serial printed in clear beside it, so a card in the wrong box is obvious. The serial is never
  sent to `.com`.
- The handshake is 7.3 in mode `code`: `K` mixes in the code, each side sends a confirmation MAC under `K` before
  anything else, five wrong MACs close the radio until the next power-on. A 100-bit code makes a PAKE unnecessary.
- Everything else is the Standard flow: presence rule, 10-minute window, timed press, internet check. The box refuses
  mode `open`. The 5-press reset re-claims only with the card (or the monitor code).

### 9.2 What it closes and costs

Closes T3, T4 and T9: an attacker without the code cannot finish a handshake, relay or not. Costs a per-unit factory
step (generate, print, match card to box, tamper-evident seal) and leaves the previous owner of a resold box holding
the code unless the card changes hands.

### 9.3 Later: proving the box is genuine (T5)

At the factory the box makes a non-exportable attestation key in its TPM; our offline manufacturing CA (YubiKey, like
the release keys) certifies it. During the claim the box sends a TPM quote of its Secure Boot and boot measurements.
The phone checks certificate and measurements offline and shows "Genuine Flagship box" or "Not a Flagship box: set it
up only if you built it yourself." `.com` sees none of it (a stable hardware id goes only to the phone). Needs
reproducible metal images and measured boot (AGENTS.md, milestone 6: "no TPM quote or UKI").

## 10. Partner hardware checklist

A model is sold as a Flagship box only if one unit passes all of this, tested by us, not taken from a spec sheet.
Each test takes about a minute from a Debian live stick (or our image with a root shell).

| # | Requirement | How to test |
|---|---|---|
| H1 | A short power press reaches the OS as `KEY_POWER` and does not cut power | `sudo systemd-inhibit --what=handle-power-key --mode=block evtest`, pick "Power Button" (Pi 5: `pwr_button`), press briefly. Expect `KEY_POWER value 1` then `value 0`, and the box stays on. Repeat 5 quick presses: five pairs (the reset gesture). |
| H2 | A ~4 s hold still forces power off (the escape hatch) | hold the button; the box goes off within about 5 s |
| H3 | Power on after AC loss | BIOS: "Restore on AC Power Loss" / "After power failure" = Power On. Shut down, unplug, wait 10 s, plug in: it boots with no press. (Pi 5 boots on power by default.) |
| H4 | Bluetooth LE peripheral role | `bluetoothctl show`: a controller with `Roles: peripheral`. `bluetoothctl`, `menu advertise`, `uuids <test uuid>`, `back`, `advertise on`; a phone scanner (nRF Connect) sees it. |
| H5 | Ethernet works on Debian with no extra driver | plug a cable; `ip -br addr` shows an address on the wired interface within 10 s |
| H6 | Wi-Fi joins on Debian (`non-free-firmware` allowed) | `nmcli dev wifi connect <ssid> password <pw>` succeeds |
| H7 (Verified only) | TPM 2.0 with NV space, Secure Boot with our shim | `tpm2_getcap properties-fixed`; `mokutil --sb-state` after enrolling |

Common support, to be confirmed per model:

- **x86 mini PCs** (Intel and ASUS NUC, Beelink, Minisforum, ASUS PN series) usually report a short press through
  ACPI as `KEY_POWER` and offer the AC-loss setting in the BIOS. Bluetooth depends on the combo card: Intel AX200/AX210
  class works as a BlueZ LE peripheral; some Realtek and MediaTek cards need newer firmware. Some cheap boards hide the
  AC-loss setting or ship it disabled.
- **Raspberry Pi 5** has a power button: a short press arrives as `KEY_POWER` on `pwr_button`, a long hold forces off,
  and it boots when power is applied. Bluetooth 5.0 LE and gigabit Ethernet on board. Needs our arm64 appliance.
- **Raspberry Pi 4** has no power button. It fails H1 and is not a retail box (an add-on GPIO button would be a
  different SKU).

## 11. What each part needs

### 11.1 The box

- The claim service: BLE GATT peripheral through BlueZ over D-Bus (or an L2CAP channel where supported; a claim is a
  few KB with the PQ keys), the handshake, the 10-minute window, the state machine, arming and contention.
- The power-key service and the logind drop-in (7.5).
- The reset window, the recovery partition and the reimage path; the "release this box" consumer.
- The on-screen code for the monitor path (8.4).
- Bluetooth and Wi-Fi firmware for the chosen SKUs (Debian `non-free-firmware`), on the metal appliance only.
- Nothing stored or sent that identifies the hardware.

### 11.2 The phones

- **iOS (18.0 floor):** Core Bluetooth scanning in the foreground with the Bluetooth permission. Not
  AccessorySetupKit: its system picker hides how many boxes are advertising, and the presence rule needs to see every
  advert. QR scanning (VisionKit or AVFoundation) for the monitor path and Verified cards.
- **Android (API 29 floor):** `BluetoothLeScanner`. On Android 12+ `BLUETOOTH_SCAN` with `neverForLocation` and
  `BLUETOOTH_CONNECT`. On Android 10 and 11 a BLE scan needs `ACCESS_FINE_LOCATION` and location turned on; the app
  explains why. Not CompanionDeviceManager, for the same reason as AccessorySetupKit. CameraX with a bundled QR decoder.
- Both: the handshake (shared vectors in TS, Swift, Kotlin), the presence rule, arming and the hidden pause, the
  press screen, the Wi-Fi warning, the receipt pin, the internet check and its alarm, the reset instructions, "Set up
  a box from a store" in Add a server (admin devices only).
- The webapp cannot do Bluetooth on iOS Safari. It shows "Use the Flagship app on your phone to set up this box."

### 11.3 `.com`

Nothing new for the claim, and nothing about hardware. The box registers with the AuthCode like any server, and its
STK is stored as today. Confirm the AuthCode is single use (7.7). We do **not** ship `box_serials`,
`/api/serial/activate` or the serial binding from `feat/retail`: a hardware id at `.com` links a purchase to an
account (T8), and the box's own refusal of a second claim plus its registered key already give the "burned" effect.

## 12. Why not "return it if you can't pair"

The booklet still says "open the app first", because the presence rule needs it. Returns are not the security. With
the timed press nobody can race the buyer, and the answer to "someone else set it up" is a reset the buyer does at home
in a minute. Returns are for hardware faults.

## 13. Work breakdown

### 13.1 What exists on `feat/retail` (6 commits off `main`, behind `release/0.4`)

| Piece | File | Fate |
|---|---|---|
| PAIR payload, transcript, `K_session`, SAS | `packages/protocol/src/nfcPair.ts` | Rework into `box-claim/v1`: drop the per-boot STK and the SAS; keep the HKDF transcript shape; add modes `open` and `code`, X-Wing, arming |
| `WiFiConfig` envelope + seal | same | Reuse as is |
| `BoxUnpair` (rebind only) | same | Replace with "release this box" (admin-signed, wipes); owner to confirm (Q3) |
| LED-SAS alphabet and verifier | same + mobile | Drop (no drivable LED) |
| First-claim latch, session lock | `server-daemon/src/nfcPairing/pairStateMachine.ts` | Reuse the latch; add the window, arming, contention, `reset-window` |
| RNG gate | `nfcPairing/rngGate.ts` | Reuse (ephemeral keys; Verified codes) |
| Wipe verifier | `nfcPairing/wipeVerifier.ts` | Reuse for reset and release |
| Per-boot key emitter | `nfcPairing/pairEmitter.ts` | Drop |
| NFC rendezvous drop-box on `.com` | `control-plane/src/nfcRendezvous.ts`, migration 0040 | Drop (claims never go through `.com`) |
| Serial activation, `bindStk`, rendezvous lookup | `control-plane/src/serialActivation.ts`, `serverRegister.ts` | Drop (section 11.3) |
| iOS and Android NFC reader, pair screens, view models, tests, strings | `apps/mobile/...Nfc*` | Reuse the screen flow, view model shape and strings; swap NFC for Core Bluetooth / `BluetoothLeScanner` |

### 13.2 Phase 1: software, on a VM with a simulated radio and button

1. `flagship/box-claim/v1` spec (both modes), TS reference, Rust (box side), Swift, Kotlin; shared vectors including
   relay key swap, state forgery, early press, contention, wrong code (Verified). External review alongside the PQ
   session.
2. Box claim service behind a transport interface: a BlueZ GATT transport, and a socket transport with BLE-sized
   frames for tests. On a Linux dev machine BlueZ's virtual controller (`btvirt` over the `vhci` driver) runs the real
   GATT code with no radio.
3. Power-key service. In a QEMU VM the QMP command `system_powerdown` delivers an ACPI power button press, which
   reaches the guest as `KEY_POWER` on "Power Button": the real code path, scripted. Plus the logind drop-in.
4. Reset window, recovery partition and reimage; "release this box" order (admin root signed) and its consumer;
   on-screen monitor code.
5. iOS first: scan and presence rule, session, arming, press screen, Wi-Fi warning, receipt pin, internet check and
   alarm, reset screens. Then Android in spirit. Mock gym scenarios on both, with a scripted fake box covering every
   stop (second box, early press, contention, key mismatch).
6. `.com`: confirm or make the AuthCode single use, with a test.
7. i18n for every new string, the booklet surface included.
8. A gym lane: a VM box claimed over the socket transport with a scripted press; a second claim refused; reset window
   and re-claim; a relay that passes the claim on, caught by the internet check.

### 13.3 Phase 2: hardware

9. Pick the partner SKU(s); run the section 10 checklist on one unit of each; set the firmware defaults.
10. Metal appliance build per SKU (drivers, firmware) in CI; the recovery image.
11. A real-radio run: iPhone and an Android 10 phone against each SKU; measure discovery time and press reliability;
    a deliberate second box nearby.
12. Packaging and booklet; tamper-evident seal.

### 13.4 Phase 3: Verified (our own hardware)

13. Factory burn-in tool (generate the code on the box, print card and sticker, verify before sealing).
14. TPM attestation key, offline manufacturing CA, quote verification in the apps, measured-boot values per release.

Side benefit: phase 1 also gives a **preinstalled image for DIY metal**. Studio could write the metal appliance to a
disk and the user claims it like a retail box, skipping the Debian installer (Q5).

## 14. Questions for the owner

Answered on 2026-11-14 and removed: Bluetooth-first with no per-unit card (old Q1); no NFC sticker (old Q3); no serial
or hardware id at `.com` (old Q7); the second-hand reset race (old Q10: no secret survives a reset now).

- **Q1** Partner hardware: which vendor(s) and models first (x86 mini PC, Pi 5, or both)? This sets phase 2.
- **Q2** Verified tier: our own SKU at all, and is the TPM genuineness check (9.3) wanted before or after the first
  Verified sale? A stolen list of attestation keys (checked on the phone only) with it?
- **Q3** "Release this box" from the app: wipe (recommended), or rebind only as the old NFC doc decided?
- **Q4** Returns: may shops wipe a returned box with the app's release mode, or do returns come back to us?
- **Q5** Use the same claim flow for DIY metal installs (a preinstalled image instead of the Debian installer)? DIY
  machines often lack Bluetooth, which leads to Q6.
- **Q6** A LAN claim path keyed by the on-screen monitor code, for boxes with dead or missing Bluetooth?
- **Q7** Is the silent "keep it" relay (6.1) acceptable for the Standard tier, with the monitor path offered in help?
  A cheap extra check would ask for another press over the internet after the radio window closes; it raises the
  attacker's cost but does not stop one who also claimed the real box, so this doc does not include it.
- **Q8** What the app calls the two tiers to the buyer (for example nothing for Standard, "Verified box" for the
  other), and whether the Standard help text names the relay risk outright.

## 15. Owner notes, 2026-11-14 (round 3), to fold into the design

Verbatim: "The QR code should change whenever the server is reset (5 clicks). As well as key changes and memory
wipes. A server that powers off during resets should be bricked - you must either do a complete reset again or bring
it back to the store. Seeing and storing the QR code should not leak any information. It should be a first come
first serve throwable key that sets things in motion but is discarded entirely over time." Question: how does a
headless box get its internet (Ethernet can be tricky, Wi-Fi finicky), especially when the QR code is shared
(a cousin, a shop's setup desk)? Mandate an easy network (working DHCP, no captive portal)?

Proposed reading (pending the owner's confirmation):

- **The code ratchets.** A claim code is single use. Each claim, key change or wipe makes a new one on the box (only
  its hash kept), so a code that has been used, seen or stored is worthless afterwards. The printed card is code 0:
  it dies at the first claim (this reverses 9.1's "survives resets"). The new code goes sealed to the owner's app
  ("Show this box's setup code", for handing over). A 5-press reset with nobody holding the current code falls back
  to the Standard claim (Bluetooth + timed press), so a 5-press reset also kills any leaked code. A monitor (8.4)
  always shows the current code.
- **Nothing in the code.** 100 random bits, no serial, model, MAC, account or server name. Before use it is a bearer
  claim (first come, first served); after use or a reset it is junk. Any internet mailbox keyed by it at `.com`
  holds only a hash and expires.
- **Interrupted reset = locked.** Once the wipe starts (a "reset in progress" marker is fsynced first; the LUKS
  header is crypto-erased, so the window is seconds), a power loss leaves the box in a locked state that serves
  nothing and accepts only a fresh 5-press reset. Recommended: lock only from the moment the wipe starts, not from
  the 5 presses, else 5 presses + pulling the plug destroys a working server (cheap grief by anyone at the box).
- **Network.** Supported: Ethernet with DHCP; Wi-Fi WPA2/WPA3-Personal on 2.4/5 GHz sent over Bluetooth, with the box
  scanning and listing the networks it can see, then reporting the exact failure (wrong password, no DHCP address,
  no DNS, captive portal, relay unreachable) before the Bluetooth session closes. Not supported, said up front:
  captive portals, 802.1X enterprise Wi-Fi, networks that block outbound 443. Optional: static IP sent over
  Bluetooth; Wi-Fi Easy Connect (DPP, Android only); WPS push button (often disabled).
- **Remote claim (the shared QR).** Only with Ethernet + DHCP: an unclaimed box online opens a claim mailbox at `.com`
  keyed by a hash of its current code, and whoever holds the code claims over the internet (handshake keyed by the
  code, `.com` blind). Over Wi-Fi someone must be at the box once to pass the Wi-Fi details.

### 15.1 Owner, 2026-11-14: no printed cards; two separate methods

"I want to avoid the printing of cards, as that would add a lot of operational complexity." No code is printed, on
any tier (section 9's card is dropped; a Verified tier, if ever, would rest on TPM attestation alone). Owner
clarification the same day: there are two separate methods, and the normal one uses no monitor.

1. **Bluetooth + button press (the normal method).** No monitor; the booklet asks the buyer NOT to plug one in, for
   safety (a screen showing a setup code lets anyone who sees it claim the box). The phone at the box claims it
   directly: sections 4 and 7, no code shown or handed out.
2. **Monitor (the sharing method).** For setting up a box for someone else (a cousin, a shop's setup desk): plug in a
   monitor and press the power button 3 times (owner: the code appears only when asked); the box shows its current
   setup code as a QR code; a photo of it can be sent to whoever will own the
   box, who claims over the internet through a `.com` mailbox keyed by a hash of the code (`.com` blind), with the
   box on Ethernet + DHCP. Because the code arrives off the radio, this method also closes the relay case.

The code ratchets: made fresh at every reset, claim, key change and wipe; single use; the box keeps only its hash; it
expires a set time after it is first shown. Seeing or keeping a used or expired code gives nothing away.

### 15.2 Owner, 2026-11-14: one documentation page for every box

The button gestures (1 press when the app asks, 3 presses to show the setup code on a monitor, 5 presses to reset)
live on one public documentation page, the same for every box and every buyer, plus the generic booklet (4.1). Nothing
unique is printed per box.

### 15.3 Owner, 2026-11-14: answers to the phase-1 questions

- **Wi-Fi stack:** depends on the hardware, which is not chosen. Wait until a partner SKU is picked (doc Q1).
- **Release this box = wipe.** Releasing a box always wipes it clean. To keep the data, make a backup first or
  transfer the server to a friend (the transfer-a-box flow). (Old Q3 answered: wipe, never rebind-only.)
- **Boxes without Bluetooth: the wired / data-centre path (old Q6, answered yes).** The use case is corporate: a
  rugged laptop as the command centre running the webapp in Firefox, and server trays without Bluetooth hot-plugged
  into the network. Design the wired claim for that scenario (fleet claims from the webapp over the LAN, many trays
  at once). "The app is for the cool kids": Bluetooth stays the phone path for homes.
  **Design: `docs/retail-wired-fleet.md`** (console code as the default, a `.com` claim lobby with an arm-all timed
  press for trays with no console, batch claims, replace and bulk release from the webapp, its own questions Q-W1 to
  Q-W11).
