# NFC pre-built boxes — tap-to-pair (future)

**Status:** future / post-v1; not scheduled, no code yet. Design captured
here so it can be picked up as a unit.

**Goal.** Let someone buy a pre-built Flagship server at retail (Best Buy)
or online, take it home, and pair it to their phone by **tapping the phone
to the box** — with no per-unit factory provisioning, no printed secret to
store, and a clean resale/donation path. Do it without weakening the core
trust model (the phone is the trust root; the box is commodity hardware the
owner chooses to trust because they possess it).

> Conventions (same as `lifecycle-spec.md`)
> - **PSK** = phone signing key (delegated). **IRK** = identity recovery
>   key. **UMK** = user master key. **STK** = server identity key.
> - **PhoneOrder** = canonical-bytes signed message from
>   `@flagship/protocol/auth.ts`.
> - **Box** = the physical server. **Tag** = the NFC chip on the box.
> - Routes under `/.flagship/` are daemon-intercepted; apps never see them.

---

## TL;DR — the decision

1. **One generic golden ISO** on every box (branded and DIY). No per-unit
   image, no per-unit key injection, no printed card married to a board.
2. **On every boot while unpaired**, the box generates a **fresh keypair**
   and enters pairing mode. On successful pair it **persists** the identity
   and stops regenerating. On reset/unpair it **wipes** and returns to
   regenerate-on-boot. (See state machine below.)
3. **Two product tiers, one pairing protocol.** The handshake (ephemeral
   key + ECDH + SAS) is identical; only the *confirmation surface* differs:
   - **Branded box (retail/online): NFC tap.** The tap delivers the box's
     fresh public key over a ~4 cm channel — proximity authenticates the
     key, so no on-screen code is needed. The tap is also the
     possession proof.
   - **DIY / self-flash: on-screen QR.** Reuses the existing QR/relay v2
     (`/qr` + `/qr-pipe`, ECDH + SAS); the key + SAS are shown on the
     monitor the builder has plugged in. No NFC hardware, no printed
     secret.
4. On a branded box, the **tap** is the pairing gesture and the **power
   button** (held N seconds) is the reset/unpair gesture. No semantic
   overload.

This is *cheaper and simpler* than per-unit provisioning, and it is more
faithful to "your hardware" than a factory-injected manufacturer secret
(see "Deliberate non-goals").

---

## Why — what this replaces

Three alternatives were considered and rejected for retail:

- **Printed-secret QR (sealed in the box).** Fragile on two axes:
  *lifecycle* — the secret is bound to the unit for life, so resale means
  shipping a paper card or living with a stale/photographed code, and
  there is no clean re-pair; *manufacturing* — it forces per-unit flashing
  (this image + this identity) married to this printed card in this box,
  a per-unit station and a whole class of mismatch failures. It breaks the
  single golden ISO.
- **BLE pairing.** ~10 m range is weak proximity (a whole store/apartment
  is "near"), it still needs a SAS to be safe, and it adds the most
  Alpine/BlueZ surface and support cost for the least unique benefit.
- **Passive printed NFC tag.** Same staleness/storage problem as QR — a
  static tag can't carry a key that changes every boot.

The chosen base model — generic ISO + ephemeral key on boot + a physical
gesture — keeps the box stateless-until-owned and makes resale a wipe.

---

## State machine (generic ISO, every box)

```
        power on
           │
           ▼
   ┌──────────────────┐   no persisted identity
   │  UNPAIRED        │◄──────────────────────────────┐
   │  - gen ephemeral │                                │
   │    keypair       │                                │
   │  - enter pairing │                                │
   │    mode (emit)   │                                │
   └────────┬─────────┘                                │
            │ first valid ownership claim completes    │
            ▼                                          │
   ┌──────────────────┐                                │
   │  PAIRED          │   persist STK + owner (IRK/UMK  │
   │  - stop emitting │   binding), provision LUKS      │
   │  - normal ops    │   unlock policy, PSK delegation │
   └────────┬─────────┘                                │
            │ hold power button N s  (or phone-issued   │
            │ remote unpair, signed by IRK)             │
            ▼                                          │
   ┌──────────────────┐                                │
   │  RESET            │  wipe LUKS volume + persisted  │
   │  - secure-erase  │  identity + paired session  ───┘
   └──────────────────┘
```

Key generation is cheap (Ed25519/X25519 in milliseconds), so regenerating
each boot while unpaired is free. The **only** persisted secret is created
at successful pair; it is the thing wiped on reset. Until paired, the box
has nothing at rest worth stealing — consistent with the LUKS-unlock-by-
phone model (the owner's phone becomes the keyholder at pairing).

---

## The pairing handshake (shared by both tiers)

Per boot, while UNPAIRED, the box holds:

- `STK_pub` / `STK_priv` — Ed25519 server **identity** keypair (becomes the
  box's long-lived STK iff this pairing succeeds; see `build-tasks.md` C.7
  for STK rotation).
- `E_box_pub` / `E_box_priv` — X25519 **ephemeral** key for this session
  (forward secrecy).
- `nonce` / `sessionId` — fresh random per boot.
- `hint` — discovery hint: mDNS name + cloud rendezvous id (see
  `build-tasks.md` C.5 LAN/BLE fallback).

**Pairing payload** (the thing emitted — over NFC or shown as QR):

```
PAIR = { v, STK_pub, E_box_pub, nonce, sessionId, hint }
SIG  = Ed25519_sign(STK_priv, canonical(PAIR))     // binds the ECDH key
                                                   // + nonce to STK
```

**Exchange:**

1. Phone obtains `PAIR` + `SIG`, verifies the signature with `STK_pub`
   (self-consistency: the box vouches that `E_box_pub`/`nonce` belong to
   this identity).
2. Phone generates `E_phone` (X25519), computes
   `ss = ECDH(E_phone_priv, E_box_pub)`.
3. Both sides derive the session key and SAS:
   ```
   transcript = v | STK_pub | E_box_pub | E_phone_pub | nonce | sessionId
   K_session  = HKDF(ss, salt=nonce, info="flagship/pair/v1" | transcript)
   SAS        = truncate(HKDF(ss, info="flagship/pair-sas/v1" | transcript))
   ```
4. Confirmation surface authenticates `STK_pub`/`E_box_pub` as **this**
   box (this is the only step that differs between tiers — see below).
5. Over the confirmed channel the phone sends the **ownership claim**: a
   `PhoneOrder`-style message carrying the owner binding (IRK/UMK-derived),
   establishes **PSK** delegation, provisions the LUKS unlock policy, and
   sets the **RCK** routing for the box's subdomain. Box accepts the
   **first** valid claim, transitions to PAIRED, persists, stops emitting.

`K_session` encrypts+authenticates everything after the tap, even when bulk
traffic flows over LAN/cloud — a network MitM cannot substitute keys
without `E_box_priv`, which never leaves the box.

---

## How each tier confirms "this is the box in front of me"

- **DIY (QR on screen):** the phone displays the SAS; the builder compares
  it to the SAS rendered on the box's attached monitor. Mismatch → abort.
  (Identical to relay v2 today.)
- **Branded (NFC tap):** **proximity replaces the SAS.** The phone read
  `PAIR` directly off the box at ~4 cm, a channel an attacker cannot
  occupy, so `E_box_pub` is authenticated by physics. Preferred flow is a
  **read+write tap**: the phone reads `PAIR` and writes `E_phone_pub` back
  into the tag in the same tap, so the whole key agreement is
  proximity-bound; bulk then flows over LAN/cloud under `K_session`. No LED
  dance, no code comparison.
  - *Fallback if read+write is awkward:* phone reads `PAIR` over NFC, sends
    `E_phone_pub` over LAN/cloud (`hint`), and the box confirms via a
    **status-LED SAS** blink pattern derived from `SAS`. Cheap, screenless.

---

## NFC transport — hardware specifics

- **Must be a host-updatable tag, not a passive printed one** — the payload
  changes every boot. Use an NTAG-I2C-class dual-interface chip
  (e.g., NXP NT3H2111 *NTAG I²C plus*, or ST ST25DV). The host writes the
  current `PAIR`/`SIG` (as NDEF) into tag EEPROM when it enters pairing
  mode, and clears it on PAIRED.
- **x86 integration is the real BOM/eng decision.** Mini-PCs rarely expose
  clean I²C/GPIO to userspace. Options, cheapest-and-most-robust first:
  1. **Companion MCU** (~$0.30–0.80, e.g., CH32V/STM32C0) that owns the
     NTAG over I²C and receives the current payload from the host over
     USB-CDC each boot. Decouples from whatever x86 board is sourced.
  2. USB-to-I²C bridge to the NTAG.
  3. USB NFC frontend (PN5xx) in **card-emulation** mode — host emulates
     the tag live (most flexible, slightly pricier, more driver surface).
  - Default to (1).
- **Enclosure constraint:** NFC needs a non-metal window over the antenna;
  a metal lid kills it. Plan a plastic top or an antenna cutout with a
  printed "tap here" target. Affects industrial design — flag to ID early.
- **Phone support:** Android reads/writes tags natively. iOS uses Core NFC
  (`NFCTagReaderSession` / `NFCNDEFReaderSession`, iPhone 7+); needs the
  *Near Field Communication Tag Reading* capability + entitlement + usage
  string. Format `PAIR` as NDEF so both platforms read it cleanly. Confirm
  the iOS NFC capability lands on the app roadmap (`apps/mobile/ios`).
- **Powered-off behaviour:** dual-interface tags are readable by a phone's
  RF field even when the host is off (the field powers the tag). A
  shelf/off box therefore exposes only a *stale public* payload (harmless)
  and **cannot complete a handshake** — the host must be running to do ECDH
  and accept a claim. See the in-store hijack threat below.

---

# Security outline

## Trust model & assumptions

- **The phone is the trust root.** The box is commodity hardware; it earns
  trust by being *possessed and paired*, not by a manufacturer blessing.
- TLS for user content terminates on the box; flagship.services is a
  stateless pipe and cannot read content.
- Adversary may control the network (LAN and the cloud relay path),
  including active MitM, and may be physically near the box (same building,
  same store).
- Cryptographic primitives (Ed25519, X25519, HKDF, AEAD) are sound; the
  box's RNG is adequately seeded at pairing time (see Residual risks).

## Security goals (what pairing must guarantee)

| # | Property | Met by |
|---|----------|--------|
| G1 | **Targeting** — phone pairs with the unit it physically has | NFC ~4 cm read (branded) / on-screen SAS (DIY) |
| G2 | **MitM resistance** — no relay can interpose | ECDH bound to proximity-/SAS-authenticated `E_box_pub` |
| G3 | **Possession proof** — a human is at the box now | the tap (branded) / button or screen access (DIY) |
| G4 | **Forward secrecy** — past sessions safe if box later seized | per-boot ephemeral X25519; wipe on reset |
| G5 | **Resale hygiene** — prior owner retains nothing | RESET secure-erases LUKS + identity → factory-fresh |
| G6 | **Single-owner** — only the first valid claim wins | box latches PAIRED on first claim, stops emitting |

## Threats & mitigations

- **T1 — Network MitM (LAN or cloud relay).** Active attacker relays the
  handshake. *Mitigated:* `E_box_pub` is authenticated out-of-band (NFC
  proximity or screen SAS) and bound into `K_session`; the attacker lacks
  `E_box_priv`, so they cannot derive `ss`. Forging `SIG` needs `STK_priv`.
- **T2 — Wrong-box / ambiguity** (two boxes in pairing mode on one LAN,
  apartment/dorm). *Mitigated:* NFC selects by physical tap; DIY selects by
  matching the on-screen SAS. The cloud/LAN discovery `hint` is only a
  rendezvous convenience, never the trust anchor.
- **T3 — Shelf/stale-payload capture.** Attacker taps a powered-off boxed
  unit in store. *Mitigated:* they read only a public `PAIR` (no secret);
  with the host off, no handshake can complete. Tamper-evident packaging
  makes opening visible.
- **T4 — In-store pre-purchase hijack.** Attacker powers on an unsealed
  unit in store and claims it before purchase. *Mitigated by, in order of
  strength:* (a) tamper-evident sealing so it can't be powered on
  unnoticed; (b) **claim-gated-on-activation** — the retailer scans the
  serial at checkout and the box only accepts a claim after the cloud marks
  that serial *activated*; (c) any pre-activation claim is reversible and
  flagged. Decision: ship at least (a)+(b).
- **T5 — Counterfeit / look-alike box.** A random PC runs the same ISO and
  is indistinguishable from a "real" branded box. *Accepted as a non-goal*
  — see below. Targeting (G1) still holds: the buyer pairs with the box
  they possess, genuine or not.
- **T6 — Evil-maid / supply-chain tamper of a genuine box.** Firmware
  swapped between factory and shelf. *Partially mitigated* by Secure/
  Measured Boot if the box ships with verified boot; otherwise out of scope
  for *pairing* and noted as a hardware-platform requirement, not a
  protocol guarantee. (Without a factory key this cannot be fully closed —
  a conscious tradeoff.)
- **T7 — Replay of an old pairing payload.** *Mitigated:* per-boot `nonce`/
  `sessionId` in the signed transcript; the phone binds the session to the
  freshly read nonce and rejects reused ones.
- **T8 — Resale data remanence.** Next owner recovers prior owner's data.
  *Mitigated:* RESET secure-erases the LUKS volume (key destruction) and
  the persisted identity; the box returns to UNPAIRED with a new STK on
  next boot.
- **T9 — Malicious/own-LAN claim after legit pairing.** Box already PAIRED;
  attacker tries to re-pair. *Mitigated:* PAIRED boxes do not emit and
  reject pairing; re-pair requires physical RESET (button hold) or an
  IRK-signed remote unpair. (Couples to recovery/re-pair, `build-tasks.md`
  C.6.)
- **T10 — Tag-write tamper (NFC read+write flow).** Attacker writes a bogus
  `E_phone_pub` into the tag. *Mitigated:* the box treats tag-written data
  as an untrusted offer; the claim still must be completed and signed over
  `K_session`, and only the first *valid* claim wins. A bogus write at best
  causes a failed/abandoned session, not a takeover. Rate-limit/clear the
  tag between attempts.

## Deliberate non-goals (conscious tradeoffs)

- **No per-box factory identity / no manufacturer attestation.** Every box
  runs the identical generic ISO with no injected secret, so there is **no
  counterfeit detection** (T5) and **no factory CA chain**. This is
  intentional and *on-brand*: the phone is the trust root and possession is
  what matters; a factory-injected secret would reintroduce a manufacturer
  trust dependency the project avoids elsewhere. If counterfeit detection
  is ever required (e.g., warranty/marketplace gating), it can be added as
  an *optional* signed serial in a secure element without changing the
  pairing protocol — but it is explicitly not required for security here.
- **No reliance on NFC for confidentiality** — only for *authenticated key
  delivery*. All payloads carried over NFC are public or signed; secrecy
  comes from the ECDH session, not from the tap.

## Residual risks / open questions

- **RNG at first boot.** Ephemeral and identity keys are only as good as the
  box's entropy at pairing. Ensure the ISO seeds the RNG (hardware RNG /
  jitter / `haveged`-equiv) before keygen; document the requirement.
- **Activation backend (T4).** Claim-gating-on-activation needs a retailer
  integration (serial scanned at checkout → cloud marks activated). Define
  the API and the offline/edge cases (e.g., retailer can't scan).
- **LED-SAS entropy** (fallback flow). ~6 bits per attempt with retry is
  fine for interactive single-shot; confirm the pattern alphabet and
  retry/lockout policy.
- **Read+write NFC ergonomics on iOS** (a single session doing read then
  write) — validate against Core NFC session limits; the LAN/cloud +
  LED-SAS fallback exists if it's awkward.
- **Metal-enclosure ID** — confirm the case design reserves a non-metal NFC
  window before tooling.

---

## Implementation checklist (the TODO)

**Protocol / shared**
- [ ] `@flagship/protocol`: `PAIR`/`SIG` canonical-bytes type + verify;
      HKDF transcript + SAS derivation (`flagship/pair/v1`).
- [ ] Box state machine: UNPAIRED (regen) → PAIRED (persist) → RESET
      (secure-erase); wire into `server-daemon` boot path.
- [ ] First-valid-claim latch + "stop emitting on PAIRED".

**Box firmware / ISO (generic golden image)**
- [ ] Per-boot ephemeral keygen; RNG-seed gate before keygen.
- [ ] Pairing-mode emitter: write `PAIR`/`SIG` (NDEF) to the tag; clear on
      pair/reset.
- [ ] Power-button: long-hold → RESET (secure-erase) without colliding with
      ACPI shutdown in pairing mode.
- [ ] Optional status-LED SAS blink (fallback confirmation).
- [ ] mDNS advertise + cloud rendezvous (`hint`); reuse C.5 LAN fallback.

**Companion MCU (branded SKU)**
- [ ] Firmware: receive current payload over USB-CDC; drive NTAG over I²C;
      handle phone read (+ optional write-back of `E_phone_pub`).
- [ ] Pick part (NT3H2111 / ST25DV + MCU); reference schematic + antenna.

**Phone apps**
- [ ] iOS: Core NFC capability/entitlement; `NFCTagReaderSession` read
      (+ write for read+write flow); pairing UI ("tap your box").
- [ ] Android: NFC read/write; pairing UI.
- [ ] Both: ECDH + claim send; DIY QR/SAS path unchanged (relay v2).

**Manufacturing / retail**
- [ ] Single golden ISO build (reuse `reproducible-iso-build.md`) — no
      per-unit step.
- [ ] Serial → activation API; checkout-scan integration (T4).
- [ ] Tamper-evident packaging; "tap here" target on the case.

**Docs / tests**
- [ ] E2E: tap-to-pair happy path; MitM-on-LAN rejected; reset→re-pair;
      pre-activation claim rejected; two-boxes-one-LAN disambiguation.
- [ ] Update `lifecycle-spec.md` and `multi-device.md` with the NFC tier.

> The full task breakdown (agent-doable / human-required / business-gated) lives in `docs/v1-operational-tasks.md` § **N — NFC retail tier (post-v1, planned)**.

---

## Design refinements (2026-05-26 review)

Layered on top of the original spec; nothing removed.

**Handshake / state**

1. **30-second session-lock window.** When the phone reads `PAIR` over
   NFC, the box latches the `sessionId` for 30 s; only a claim
   matching that `sessionId` can win the first-valid-claim race.
   After 30 s with no claim the box rolls a fresh keypair + sessionId.
   Closes the implicit race in the "first valid claim wins" rule.

2. **`BoxUnpair` envelope.** New `@flagship/protocol` type:
   `flagship/box-unpair/v1 | userId | boxId | issuedAt`, IRK-signed.
   Owner-initiated remote unpair, semantics in "Locked decisions" Q4.

3. **`WiFiConfig` over K_session.** After the pair latches, the phone
   ships SSID/PSK/region over the encrypted post-pair channel; box
   stores + joins. Documents the otherwise-implicit Wi-Fi onboarding
   path. Carried as an authenticated envelope inside the
   `K_session`-encrypted tunnel.

4. **Hard RNG gate before keygen.** ISO blocks all keygen until
   `/proc/sys/kernel/random/entropy_avail ≥ 256`. Configures
   jitterentropy + a `haveged`-equivalent into the golden ISO so x86
   boxes without a hardware TRNG aren't keygen-blocked at every boot.

5. **LED-SAS alphabet specced.** 4-color pulse pattern encoding
   ~6 bits per glance; 3-of-3 confirmation pattern (user matches
   three glances); 10-second per-pulse timeout; 3 retries before
   the box clears its emit + waits 30 s.

**Hardware / box surface**

6. **Resale-wipe verification.** After RESET secure-erases LUKS, the
   firmware reads back a 4-KiB chunk from the wiped volume and
   confirms it decrypts to garbage (no recognizable plaintext). On
   success, a green LED solid 5 s + audible chime if the SKU has a
   buzzer. Tells the seller "wipe confirmed" visually.

7. **NFC-failure graceful degrade.** If the NTAG / companion MCU is
   dead (broken antenna, EEPROM failure), the box still pairs via
   the DIY HDMI+QR path (the same `PAIR`/`SIG` rendered as a QR on
   a connected monitor + relay v2's SAS). Hardware fault doesn't
   brick the unit.

8. **"Tap here" iconography as case-ID requirement.** Standard symbol
   (NFC waves over a phone outline) printed in the antenna window;
   non-metal window over the antenna is a tooling-blocker; reserve
   the antenna footprint pre-tooling. Promoted from "residual risk"
   to a hard checklist item.

9. **Two-box-one-LAN disambiguation hint.** `hint` field carries a
   6-digit visible code (last 6 hex of `STK_pub`). When the phone
   discovers multiple candidates over LAN/cloud, it shows the suffix;
   user confirms the matching box before the tap. Tightens T2.

**Phone UI**

10. **"Pairing with [hint] (read via tap)" affordance + optional
    SAS glance.** Even on branded boxes (where the tap authenticates
    `E_box_pub` by physics), the phone shows the SAS as an *optional*
    additional verification glance — visible alongside the LED on
    the box. Defensive in noisy environments (e.g., a maker space
    with three Flagship boxes in pairing mode at once).

---

## Locked decisions (2026-05-26 review)

| # | Decision | Choice |
|---|----------|--------|
| Q1 | Online-sales activation gate | **Defer** — tamper-evident packaging + first-claim latch only. No carrier webhook, no shipping-email code, no order-attestation backend. The implementation checklist's "Serial → activation API" task is **in-store-only** for v1; online sales rely on T4's mitigation (a) alone. The API surface (N-CLOUD) extends cleanly if we ever add an online gate. |
| Q2 | iOS NFC ergonomics | **Try read+write, fall back to LED-SAS** — best UX when Core NFC cooperates, graceful degrade when it doesn't. If the write half of the tap session fails, the phone surfaces "we'll finish over Wi-Fi — watch the LEDs" and continues via LAN + LED-SAS. |
| Q3 | Hardware shipping model | **Defer** — proceed with protocol + ISO + phone + reference companion-MCU work; the manufacturing / retail / hardware-platform tasks stay flagged **business gate** until who-ships-this is decided. |
| Q4 | `BoxUnpair` semantics | **Light touch — rebind only.** The envelope resets the box to UNPAIRED state on next boot but LEAVES LUKS data intact. Wipe-on-resale still requires physical button hold. An attacker with phone access cannot remotely destroy server data; matches the "phone is the trust root, not the wipe oracle" stance. |

---

## Cross-references

- `build-tasks.md` C.5 (LAN/BLE fallback), C.6 (recovery / re-pair), C.7
  (STK rotation), A.7 (hardware orders).
- `reproducible-iso-build.md` — the single golden image.
- QR/relay v2 (`/qr`, `/qr-pipe`) — the DIY tier's confirmation surface,
  reused verbatim.
- `lifecycle-spec.md` — PSK/IRK/UMK/RCK/STK definitions and the claim flow.
