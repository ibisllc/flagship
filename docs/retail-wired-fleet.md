# Wired trays: claiming a fleet from the webapp

**Status:** design, not built. Release 0.4 item F4, the wired / data-centre path of `docs/retail-box-setup.md`
(§15.3, old Q6 answered yes). Builds on the merged phase 1: `packages/protocol/src/boxClaim.ts`,
`packages/server-daemon/src/retailClaim/` and `packages/control-plane/src/boxClaim.ts`.

The owner, 2026-11-14, verbatim: "non Bluetooth boxes can be useful in a more corporate setting. Basically the promise
is you can build a data center with a rugged laptop-style command center running the Firefox webapp and server-trays
that are non-Bluetooth and hot-plugged into the network. You can tailor the wired approach to such a scenario. The app
is for the cool kids I guess". Also decided: release = wipe; no printed cards; the Wi-Fi stack waits for hardware
(trays are wired only, so it does not matter here).

## 1. The answer in short

1. **A tray is a retail box without Bluetooth.** Same image, same claim protocol (`flagship/box-claim/v1`), same
   power-key gestures (1 press when asked, 3 presses to show the setup code, 5 presses to reset), same release = wipe.
   Only the carrier changes: the blind `.com` mailbox instead of the radio.
2. **Trays need outbound HTTPS.** An unclaimed tray on Ethernet + DHCP reaches `.com` and the relay on 443. Everything
   the webapp says to it goes through the `.com` mailbox, end-to-end encrypted. The webapp never talks to a tray on the
   LAN, so a hostile LAN can only block a claim, never sit in it.
3. **Two ways to prove "this tray":**
   - **Console code (recommended for data centres).** 3 presses (or the BMC's soft-power button 3 times) put a fresh
     setup code on the tray's console: VGA/KVM, the serial port and the BMC's serial-over-LAN all show it. The operator
     types or pastes it into the webapp. Mode `code`: a relay, a hostile LAN and `.com` itself are all locked out.
   - **Lobby + timed press (when there is no console at all).** An unclaimed tray lists itself, under a random per-boot
     id, in a **claim lobby** at `.com` that only callers from the same public address see. The webapp arms every tray
     in the lobby at once; the operator presses one tray's button; the one tray that reports the press is the one in
     hand. Mode `open`, with the protections of section 4.3.
4. **Fleet operations live in the webapp:** claim a batch with one admin confirmation, name trays by rack position, put
   them in the server order, replace a dead tray in its slot, release (wipe) trays in bulk.
5. **Fully air-gapped data centres are not supported** (no certificates, no relay, no boot unlock without `.com`;
   `docs/data-sovereignty.md` D1 closed self-hosting). A restricted-egress network that allows exactly the hosts in
   section 7.5 is.

## 2. The scenario

- **Command centre:** a rugged laptop with Firefox (current ESR or release), the webapp installed as a PWA, signed in as
  an **admin device** of the company's account (only an admin device can sign the AuthCode,
  `flagship/auth-code-admin/v1`). Optionally the Flagship for Firefox extension (`docs/browser-extension.md`).
- **Trays:** headless 1U/2U nodes or blade-style trays from a partner SKU, no Bluetooth, power-on after AC loss (H3),
  hot-plugged into a powered chassis or a rack with a top-of-rack switch. Many have a BMC (IPMI/Redfish) on a separate
  management port; some only a front-panel button and a serial header.
- **Network:** the company's. DHCP is normal in a provisioning network, static addressing is common in production, the
  LAN is shared with other machines, and an attacker on it (a compromised host, a contractor's laptop) is in scope.
- **Scale:** tens of trays at first, a few hundred later (section 7.1 on the limits).

## 3. What changes against the home flow

| Home box (`retail-box-setup.md`) | Wired tray (this doc) |
|---|---|
| Phone app (iOS, Android) | Firefox webapp; the phone apps can claim trays too, by code |
| Bluetooth radio, 10-minute window | `.com` mailbox; a lobby window (section 6.2) |
| Presence rule: exactly one new advert | The lobby is authoritative: nobody on the LAN can hide a tray from it (4.3) |
| Wi-Fi details over the radio | Ethernet only; no secret ever goes to the tray before it is claimed |
| Monitor + 3 presses = the sharing method | Console code = the normal data-centre method |
| One box at a time | Batches |

What does not change: the handshake and its records, the receipt, the `.com` key pre-registration
(`POST /api/box-claim/key` before the tray provisions), the register gate (`boxClaimRegisterGate`), the ratcheting
setup code, the reset window, the locked state after an interrupted wipe, release = wipe.

## 4. Proving which tray: options and threats

### 4.1 Threats (wired)

| Threat | Who | What they want |
|---|---|---|
| W1 Race | another machine or person on the same network or behind the same public address | claim a tray first |
| W2 Pre-deployment claim | integrator, reseller, the previous tenant of a rack | own a tray before the company does |
| W3 LAN MITM | a host on the shared LAN (ARP/ND spoofing, rogue DHCP, mDNS answers) | sit between the webapp and the tray |
| W3b `.com` MITM | a malicious or compelled `.com` operator | swap keys in the mailbox (it carries every message) |
| W4 Fake trays | anyone behind the same public address | get the webapp to claim a machine they control |
| W5 Supply chain | anyone before delivery | a backdoored tray (same as T5) |
| W6 Re-use / RMA | the previous owner or tenant | keep access, read old data |
| W8 Identity leak | the LAN, `.com` | link trays, hardware or a site to an account |
| W9 Grief | anyone behind the same public address | keep claims from finishing |
| W10 Console exposure | anyone with KVM, serial or BMC access | read a setup code |

### 4.2 Options weighed

| Option | Targeting (which tray) | Against W3/W3b | Cost | Verdict |
|---|---|---|---|---|
| **Console code** (3 presses, shown on VGA/KVM, `ttyS0`, BMC serial-over-LAN; IPMI `chassis power soft` is an ACPI power button press, so a BMC can press remotely) | exact: the code is read off the tray | **closed** (code keys the handshake; `.com` sees only `sha256(mailbox tag ‖ code)`) | 20 characters per tray; copy-paste from a BMC console is easy | **Recommended** |
| **Lobby + timed press, arm-all** (section 4.3) | exact: only the pressed tray reports | W3 closed (the LAN never carries the claim); W3b open | one press per tray, ~10 s | **Recommended when there is no console** |
| Timed press over the LAN (webapp → tray directly) | as BLE | as BLE T3, worse: anyone on the LAN can relay | a browser cannot reach an unnamed LAN host (below) | Rejected |
| Per-port "claim VLAN" (the switch puts new trays and the laptop in an isolated network) | none by itself | makes the LAN trustworthy, but the tray cannot verify it is on one | switch configuration | **Deployment advice**, not a protocol: recommended together with either method |
| mDNS / DNS-SD discovery | none (anyone can answer) | none | browsers cannot browse mDNS | Discovery only, and only for the helper (section 5.4) |
| Link-local IPv6 over a direct cable (laptop ↔ tray) | the cable is the proof | closed while the cable is point-to-point | browsers cannot use zone ids (`fe80::1%eth0`) | Helper only; not needed with the console code |
| LLDP (the tray reports its switch and port) | a good hint ("switch sw-3, port 17") | none (spoofable) | small | **Later**, as a display aid in the lobby, never as proof (Q-W8) |
| DHCP option carrying a fleet lobby key | groups trays by the company's network, not its egress | none (rogue DHCP) | DHCP configuration | Optional, for networks whose wired and Wi-Fi egress differ (Q-W8) |
| Printed code or sticker | exact | closed | per-unit factory step | Ruled out by the owner |

### 4.3 Lobby + timed press, in detail

The lobby fixes the hole the radio has. On Bluetooth the attacker controls what the phone sees: it can clone the real
advert and drown it out, then relay (`retail-box-setup.md` §6.1). The lobby is a list served by `.com` over
authenticated TLS. A LAN attacker cannot remove a real tray from it; they can only add fakes, from behind the same
public address.

1. An unclaimed wired tray, once online, posts a lobby entry: a random per-boot `lobbyId` (32 bytes), its state
   (`unclaimed` or `reset-window`) and an expiry. Nothing else: no model, serial, MAC or address. `.com` files it under
   the caller's public address (IPv4 /32, IPv6 /64).
2. The webapp reads the lobby for its own public address and shows "N trays waiting".
3. **Arm-all.** The webapp opens one claim session (mode `open`) per entry, each in a fresh session mailbox, and sends
   `arm` to all of them at once. After the hidden pause it says "Press the power button on the tray you want to set up".
4. Exactly one session must report exactly one short press inside the window (the existing `judgePressReport`). That
   session is the tray in hand. Zero reports: try again. Two or more reports, a report before the instruction, or a
   `contention` from any entry: stop and explain.
5. The webapp re-arms the rest for the next tray (section 7.1).

Why the relay fails here: to relay, an attacker must hold its own session to the real tray. The real tray is in the
lobby, so the webapp has armed it too, and two arms inside 20 s abort both (`BoxClaimMachine.arm` → `contention`). If
the attacker leaves the real tray alone, the webapp's own session to it is direct and the press arrives there. A fake
entry can only make a press up: it does not know the hidden pause, and a fake report next to the real tray's report is
two reports, which stops the claim.

What is left, honestly:

- **W3b, a malicious `.com`.** It carries the mailbox, so in mode `open` it could run both ends. The internet check
  against `.com` cannot catch `.com`. Only the console code (or the extension's certificate check after the claim,
  section 5.3, which catches the "pass it on" variant) defends. A company that does not trust our operator uses the
  console code.
- **W9 grief.** Anyone behind the same public address can arm-spam and force `contention`. Remedies: the console code
  (code sessions never arm), a claim VLAN with its own egress address, rate limits on lobby reads and arms.
- **W1/W4 on shared egress** (a co-working space, a hosting provider's NAT): strangers see that trays are waiting and
  can add fakes. The press still closes the race and arm-all filters fakes.

### 4.4 Console code, in detail

- 3 short presses (front panel or BMC soft power) show a fresh code, as today (`SetupCodeStore.issue`,
  `ConsoleCodeDisplay`), on `tty1` **and** the serial console `ttyS0` (which BMC serial-over-LAN mirrors), for 10
  minutes. The code ratchets: single use, thrown away on claim, reset, key change, wipe or expiry.
- The webapp's "Add trays by code" box takes one code per line, so an operator can paste a column of codes copied from
  BMC consoles. Each code opens its own mailbox session (`setupCodeMailboxId`), no press needed.
- W10: anyone who can read the console in those 10 minutes can claim the tray. In a data centre that is the KVM or BMC
  network, which is already privileged (it can power-cycle and reinstall machines). Codes on the serial console end up
  in console logs on some terminal servers: harmless once used or expired, which is why a code is single use and short
  lived.
- After the code, the claim is the existing code-mode path: the tray provisions over Ethernet.

### 4.5 Recommendation

- **Default in the webapp: console code.** Shown first, because it closes every network attack, `.com` included.
- **Lobby + press** offered for trays with no console, with one line of help: "Pressing works when nobody else on
  your network is setting up trays. On a shared network use the setup code."
- **Advice for operators:** provision in a claim VLAN with its own egress address; then both methods are equally
  strong in practice and the lobby shows only your trays.

## 5. The webapp as the claimer

### 5.1 What a browser cannot do, and why the mailbox is the carrier

- No Bluetooth on Firefox (Web Bluetooth is not shipped), no raw sockets, no mDNS.
- No plain-HTTP or `ws://` call from the `https://` webapp to a LAN address (mixed content), and Firefox applies its
  own local-network restrictions on top.
- No custom trust: a self-signed certificate on `https://192.168.1.20` stops at Firefox's error page before any script
  or the extension sees it (the extension's `getSecurityInfo` only narrows a connection Firefox already accepted).
- An unclaimed tray has no name, so it can have no publicly trusted certificate.

So the webapp reaches unclaimed trays only through `.com`: the lobby list and the blind mailbox, both plain HTTPS to
the control apex. This also works from a phone, a second laptop or a remote office. The claim crypto is unchanged and
runs in the browser (the webapp needs X-Wing, `ml_kem768_x25519`, from the same noble library the protocol package
uses, and `hybridVerify` for the receipt, which it already has for verify-only PQ).

Rejected carriers: WebRTC data channels over the LAN (still need `.com` for signalling, gain only speed the claim does
not need, and pull a WebRTC stack onto the tray); a pre-claim certificate for each unclaimed tray (a public name and a
Let's Encrypt order per unsold box, inside the issuance rate limits, for nothing the mailbox does not already give).

### 5.2 Signing in the webapp

- The recipe and its AuthCode (`flagship/auth-code-admin/v1`), the box key registration (`flagship/box-claim-key/v1`,
  Ed25519), the server order (`flagship/server-order/v1`) and the release order are signed by the admin root, which a
  webapp admin device already holds. A non-admin browser sees "Only an admin device of this account can set up
  servers."
- **One confirmation per batch.** The webapp asks once ("Set up 12 trays on account acme?"), then signs each tray's
  AuthCode and key registration with the key it already holds unlocked for that session (the pattern of trusting the
  unlocked session). Each tray still has its own AuthCode, recipe and key registration; there is no batch envelope for
  a box to trust.
- `.com` limits AuthCode issues to 10 an hour per IRK (`rateLimit.ts`, `auth-code-issue`). A fleet needs a separate,
  larger budget for admin-root-signed issues, or an issue route that takes up to N codes in one call (Q-W4).
- Strict (quantum-safe) accounts: the webapp signs classical only. The claim's signatures are classical today, so this
  works, but once a strict account requires hybrid signatures for adding servers, the webapp needs ML-DSA signing or
  trays are claimed from a phone (Q-W9).
- A newly added admin device has the 24 h cooling period (`data-sovereignty.md` D10, when built): set the command-centre
  laptop up a day ahead.

### 5.3 The internet check from a browser, and the extension

The webapp cannot read a TLS leaf, so its check is weaker than the phone's (`retail-box-setup.md` §7.7):

- **Webapp alone:** it pre-registers the receipt's STK at `.com` before the tray provisions; `.com` then admits this
  AuthCode's server only under that key, so a "pass it on" relay's real tray never comes online. The webapp alarms when
  a tray it claimed has not registered within 10 minutes of a successful receipt.
- **With the Flagship for Firefox extension:** the webapp hands the extension the claimed server's name and the STK from
  the receipt (`runtime.sendMessage` from `webapp.flagshipserver.com` only; the extension accepts it only from that
  origin and only for servers of the signed-in account), and the extension pins the server exactly as if a phone had
  paired it: it fetches the STK-signed daemon status and checks it names the very leaf of the connection
  (`docs/browser-extension.md` "Pinning"). A mismatch is the full-screen alarm. This is the strong internet check, and it
  also catches a malicious `.com` in the "pass it on" variant, since `.com` cannot forge the tray's signature over its own
  certificate. Needs a new extension message and a `scope: "extension"` box session minted by the webapp instead of the
  phone (Q-W10).

### 5.4 Later: a local helper (not in the first build)

For what only a native program can do: discover trays by mDNS, read serial consoles and BMC serial-over-LAN, press BMC
soft power, claim over a direct cable. Shape: a small native-messaging host the Firefox extension talks to (only the
extension's id may connect; no open loopback port, which any web page could reach). It turns a rack of BMCs into a
column of codes and presses with no hand at the trays. It never holds account keys; it only fetches codes and presses
buttons, and every claim still runs in the webapp. Studio could ship it for Mac, Windows and Linux (Q-W7).

## 6. The tray side

### 6.1 Which carriers a box accepts

A box image declares its claim carriers per SKU in `/etc/flagship/retail.json` (read-only, in the image):
`{"carriers": ["ble"]}` for home boxes, `{"carriers": ["lobby"]}` for trays. The code mailbox (mode `code`) is accepted
by both, as today. Mode `open` over the mailbox is accepted **only** by a box whose carriers include `lobby`, and only on
a link that came from its own lobby entry. A home box keeps refusing it (`onHello`: "the mailbox takes only mode code"),
so a Bluetooth box's presence rule keeps its meaning.

### 6.2 Windows and gestures

- **Lobby window:** 30 minutes after power-on (racking a batch takes longer than 10 minutes), reopened by one short
  press while nothing is armed (today ignored on an unclaimed box). Closed when claimed. A claimed tray reappears only
  in its reset window (5 presses, 10 minutes, data intact until a new claim completes), as `reset-window`.
- **Show code:** 3 presses, or (Q-W5) a key on the console: pressing `S` on `tty1` or `ttyS0`. Typing on a console is
  the same physical-or-BMC presence as the button.
- **Status on the console.** Both consoles always show one line per stage, refreshed: link, address, DNS, `.com`,
  relay, lobby (`connectAndDiagnose` failure codes, in the box's i18n), plus the tray's addresses. This is the
  "screenless" diagnosis for a tray that never reaches the lobby (section 7.4).

### 6.3 Network

Ethernet with DHCP (v4 or v6/SLAAC). Outbound TCP 443 to the control apex and the relay. Not in the first build:
static addressing, 802.1X on wired ports, HTTP proxies (Q-W6; `feat/outbound-proxy` has the proxy half). A data centre
that needs static addresses uses DHCP reservations on the provisioning VLAN.

## 7. Fleet operations

### 7.1 Claiming many trays at once

The webapp's **Set up trays** screen (admin devices only):

1. Rack and power the batch. The lobby fills in ("9 trays waiting"), or paste codes.
2. Choose a naming pattern: `r{rack}u{unit}` typed per tray, or a numbered series (`tray-01`, `tray-02`, ...), checked
   against the account's names as typed.
3. One confirmation for the batch (5.2).
4. Code mode: all trays claim in parallel. Press mode: tray by tray; the screen shows the next name ("Press the button on
   the tray for r2u14") and re-arms the rest after each claim. About 10 s a tray.
5. A board shows each tray: claimed, key registered, online, certificate, first update, padlock. Failures carry the
   tray's own reason.
6. The new servers join the **server order** at the end, in claim order, in one signed order (the admin can drag them
   after). The order holds at most 64 servers today (`SERVER_ORDER_MAX`): a fleet past 64 needs the limit raised or a
   second account (Q-W3).

Boot unlock: trays should default to auto-unlock (sealed lease) so a power cut across a rack does not need 40 approvals;
approve mode stays available per tray.

### 7.2 Hot-plug replace

"Replace this tray" on a dead server's page:

1. Delete the dead server (existing signed revoke; it deposits a `wipe-now` decommission order the dead tray consumes if
   it ever boots again; its disk is sealed to the account anyway).
2. Claim the new tray with the same name, pre-filled.
3. Its slot in the server order is kept: one signed order puts the new STK where the old one was.
4. Data comes back from peers ("Restore from other servers", peer backup v2), when the account's backup policy keeps
   peer copies; otherwise from the latest backup file.

### 7.3 Decommission

Release = wipe (owner, 2026-11-14). "Release" on one or many trays signs one release order each (admin root); each tray
crypto-erases and reimages from its recovery partition, checks the wipe (`wipeVerifier.ts`) and returns to
UNCLAIMED. A tray pulled before it saw its order: the 5-press reset at the bench, then claim or release it from there.
For RMA, a released tray is clean: no secret survives.

### 7.4 Diagnosis without screens

In the order an operator meets them:

- **Not in the lobby:** NIC link lights; then the console status line (6.2) on a crash cart, KVM or BMC
  serial-over-LAN says which stage failed. The webapp's empty-lobby help lists exactly these steps and the hosts to
  allow (7.5).
- **In the lobby:** the tray is online by definition. During the claim its `network-status` messages arrive over the
  mailbox (they exist already).
- **After the claim:** the normal Activity, health card and `lastUpdate` for each server.

### 7.5 Restricted egress and air gaps

- **Restricted egress (supported):** the firewall allows outbound 443 to the control apex (`flagshipserver.com`, its
  `boot.` and `recovery.` names), the relay (`*.flagship.services` and its addresses) and the Let's Encrypt ACME API
  (the tray orders its own certificate; the TLS-ALPN-01 check comes back in through the relay). The webapp's help
  shows the list, generated from the same constants the box uses.
- **Air-gapped (not supported):** a tray cannot get its certificate, its relay tunnel, its boot unlock leases or its
  updates without us; self-hosting the control plane was closed (`data-sovereignty.md` D1). What does work after a
  claim, from the data-sovereignty work: phones (not browsers) reach trays on the LAN for rescue and basic offline
  control. A data centre that loses its uplink keeps its running trays serving on the LAN; a tray that reboots during the outage stays
  locked until the uplink returns (offline unlock, D2, not built). Q-W2 asks whether air gaps are a goal.

## 8. What changes in the merged phase 1

### 8.1 Protocol (`packages/protocol/src/boxClaim.ts`)

- Lobby entry and lobby list wire forms; `TAG_BOX_CLAIM_LOBBY` for the lobby id derivation if any.
- A session mailbox envelope: the first message of a lobby session names a fresh 32-byte session mailbox id chosen by the
  claimer, so several claimers never share one mailbox. The handshake itself does not change (the channel keys bind the
  session).
- `judgePressReport` unchanged; a new pure `judgeArmAll(reports)` for the webapp: exactly one ok report, else the stop
  reason. Vectors: two reports, an early fake beside a real press, contention from one entry, zero reports.
- No change to the receipt, `BoxClaimKey` or the code derivations.

### 8.2 Box (`packages/server-daemon/src/retailClaim/`)

| File | Change |
|---|---|
| `transport.ts` | `ClaimLink.kind` gains `"lobby"`; a `LobbyAnnouncer` (post, refresh, withdraw the entry) and a lobby link that opens one `MailboxLink` per session mailbox |
| `claimService.ts` | `onHello`: allow mode `open` on a `lobby` link when the SKU's carriers include `lobby`; `MAX_LINKS` per kind (lobby links capped separately, so arm-spam cannot starve the code mailbox); announce while `claimable`, withdraw on claim |
| `claimMachine.ts` | a lobby window (configurable, default 30 min) next to the radio window; one short press while unarmed reopens it on a wired SKU; `advertState` unchanged for BLE |
| `codeDisplay.ts` | write to `ttyS0` as well as `tty1`; a status screen with the network stages and addresses |
| new `consoleKeys.ts` | read `S` on the consoles as "show code" (if Q-W5 says yes) |
| `network.ts` | unchanged for Ethernet; Wi-Fi untouched (waits for hardware) |
| new `retailSku.ts` | read `/etc/flagship/retail.json` (carriers), fail closed to `["ble"]` |

### 8.3 `.com`

- `POST /api/box-claim/lobby` (tray: `{lobbyId, state, expiresAt}`, keyed by the caller's address group; refreshed,
  withdrawn on claim), `GET /api/box-claim/lobby` (webapp: entries for its own address group, `no-store`). New D1 table
  with a short TTL (or a Durable Object per address group), pruned by the existing `prune-box-claim-mailbox` job. Rate
  limits per address and per lobby id. Nothing about hardware; the address `.com` already sees.
- The mailbox routes are reused as they are for session mailboxes; `BOX_CLAIM_MAILBOX_MAX_PER_DIR` (32) is enough for one
  session per mailbox.
- AuthCode issue: a fleet budget or a batch issue route (Q-W4); confirm the AuthCode is single use at register
  (`retail-box-setup.md` §7.7).
- Server order: `SERVER_ORDER_MAX` if Q-W3 raises it.
- A migration number taken in order at build time.

### 8.4 Webapp and extension

- Webapp: Set up trays (lobby, codes, arm-all press flow, naming, batch confirmation, progress board), Replace this tray,
  bulk Release; X-Wing in the browser bundle; i18n for every string (`i18n/webapp`); a mock-gym scenario per stop.
- Extension: accept a claimed server from the webapp and pin it (5.3).
- iOS and Android: "Set up a tray by code" (the code path already exists for the sharing method), so a phone can claim
  a tray too. No press flow on phones for trays.

## 9. Work breakdown

**Phase W1, software on VMs** (QEMU trays: `system_powerdown` over QMP is an ACPI power-button press, the serial
console is captured from `-serial`):

1. Protocol: lobby wire, session mailbox envelope, `judgeArmAll`, vectors (TS, Rust box side, Swift and Kotlin for the
   code path only).
2. Box: SKU carriers, lobby announcer and links, lobby window and the reopen press, console status and `ttyS0`, per-kind
   link caps.
3. `.com`: lobby routes, table, rate limits, prune; AuthCode fleet budget; single-use AuthCode check.
4. Webapp: Set up trays, batch signing, board, server order append, Replace, bulk Release, alarms; X-Wing bundle.
5. Extension: webapp-handed pin.
6. Gym lane `retail-wired`: three VM trays in one lobby; arm-all with one press; a fake lobby entry that makes up a
   press (stopped); a second claimer arming (contention); console code claim of a fourth tray; release one and reclaim
   it; a "pass it on" relay caught at register.

**Phase W2, hardware:** pick a tray SKU with a BMC (Q1 of the main doc); extend the checklist: W-H1 BMC soft power
arrives as `KEY_POWER`; W-H2 serial-over-LAN shows `ttyS0`; W-H3 power on after AC loss in a chassis; W-H4 Ethernet on
the shipped NIC with no extra driver. A real run with a Firefox laptop on a shared LAN.

**Phase W3:** the local helper (5.4), LLDP hints, DHCP lobby key, static addressing and proxies, if the owner wants them.

## 10. Questions for the owner

- **Q-W1** Is lobby + timed press acceptable on a network you do not control (it trusts `.com` not to MITM, and anyone
  behind the same public address can grief), or should trays take only the console code?
- **Q-W2** Air-gapped data centres: out of scope (the recommendation, consistent with D1), or a goal for a later release?
- **Q-W3** Fleet size: raise `SERVER_ORDER_MAX` above 64, and how are fleets priced (free tier 25 GB, Pro)?
- **Q-W4** One admin confirmation per batch of trays (each tray still signed separately), and a larger AuthCode budget
  for admin-root-signed issues?
- **Q-W5** Show the setup code on a console keypress (`S`) as well as 3 presses?
- **Q-W6** Corporate networks: support HTTP proxies and static addresses in the first build (pulling the proxy half of
  `feat/outbound-proxy` forward), or DHCP + direct 443 only?
- **Q-W7** Build the native helper for the extension (BMC presses, serial capture, mDNS), and ship it inside Studio?
- **Q-W8** LLDP switch/port hints in the lobby, and an optional DHCP-delivered fleet lobby key?
- **Q-W9** Strict (quantum-safe) accounts: may the webapp claim trays with classical signatures, or must it gain ML-DSA
  signing first?
- **Q-W10** May the webapp mint the extension's box session for servers it claimed (today only a phone pairs the
  extension)?
- **Q-W11** Lobby on home boxes too, as the fallback for a dead Bluetooth radio (main doc §8.5)? The recommendation is
  no: the code path already covers it with a monitor.
