# Wired trays: claiming a fleet from a command laptop

**Status:** design v2, not built. Release 0.4 item F4, the wired / data-centre path of `docs/retail-box-setup.md`
(§15.3, old Q6 answered yes). Builds on the merged phase 1: `packages/protocol/src/boxClaim.ts`,
`packages/server-daemon/src/retailClaim/` and `packages/control-plane/src/boxClaim.ts`.

v2 (owner feedback, 2026-11-14) replaces v1's "the webapp reaches trays only through `.com`" with a local helper on
the command laptop that talks to trays on the LAN directly, and treats air-gapped sites as a goal. Owner, verbatim:
"The idea that the Firefox server would need to go through .com relaying data for setup seems backwards. I think it's
okay to build a little serving app on the laptop to be able to listen/answer to servers on LAN directly, if that's
necessary for airgapped systems."

Earlier owner words that still hold: "non Bluetooth boxes can be useful in a more corporate setting. Basically the
promise is you can build a data center with a rugged laptop-style command center running the Firefox webapp and
server-trays that are non-Bluetooth and hot-plugged into the network. You can tailor the wired approach to such a
scenario. The app is for the cool kids I guess". Release = wipe; no printed cards; the Wi-Fi stack waits for hardware
(trays are wired only, so it does not matter here).

## 1. The answer in short

1. **A tray is a retail box without Bluetooth.** It runs the same image and the same claim protocol
   (`flagship/box-claim/v1`). It has the same power-key gestures: 1 press when asked, 3 to show the setup code, 5 to
   reset. Release still means wipe. Only the carrier changes: a framed TCP link on the LAN instead of the radio.
2. **A small helper on the command laptop carries the claim.** It is the **Flagship Studio** app the laptop already
   installs. The LAN work runs in one Rust engine, `flagship-fleet`, that all three Studios bundle and that also runs
   headless (section 5). The helper finds unclaimed trays on the LAN and opens framed claim links to them. It also reads
   serial or BMC consoles and presses BMC power buttons. For trays that are already claimed, it carries fleet orders
   over the LAN.
3. **The webapp stays the claimer and the signer.** Firefox talks to the helper through the Flagship for Firefox
   extension's native messaging. A loopback HTTP port with a pairing token is the fallback. The claim handshake runs
   **end to end between the webapp and the tray**. The helper forwards ciphertext and never holds a key, so a hostile
   helper is no stronger than a hostile LAN (section 6).
4. **Proving which tray:** the **console code** stays the default, and it closes every network attack. The **timed
   press** is accepted when the helper and the tray share a claim VLAN or a direct cable (section 4).
5. **`.com` drops out of the claim.** The `.com` lobby from v1 is dropped (it was never built). The code mailbox
   (already built for the phone's sharing method) stays only as a fallback, for claiming a tray from somewhere that is
   not on its LAN.
6. **Air-gapped sites are possible as "site mode"** (section 8). It is a separate, later build: site mode is a partial
   reversal of `docs/data-sovereignty.md` D1 and needs the owner's decision (Q-W2). It runs with no `.com`: no public
   names, no relay and no Let's Encrypt. Instead it uses LAN-direct connections, key-bound TLS for the helper and the
   phones, and a name-constrained site CA for browsers. Updates arrive on a USB stick ("sneakernet"). Trust is anchored
   in the account's admin root alone.

## 2. The scenario

- **Command centre:** a rugged laptop (Windows, Linux or Mac) with Firefox and the Flagship for Firefox extension, plus
  Flagship Studio as the helper. The webapp is signed in as an **admin device** of the company's account. Only an admin
  device can sign the AuthCode (`flagship/auth-code-admin/v1`).
- **Trays:** headless 1U/2U nodes or blade-style trays from a partner SKU, without Bluetooth. They power on after an AC
  loss (H3) and are hot-plugged into a powered chassis or a rack with a top-of-rack switch. Many have a BMC (IPMI or
  Redfish) on a management port; others only a front button and a serial port.
- **Network:** the company's. It may be shared and may contain an attacker (a compromised host, a contractor's laptop).
  It may have no internet at all (section 8).
- **Scale:** tens of trays at first, a few hundred later.

## 3. What changes against the home flow

| Home box (`retail-box-setup.md`) | Wired tray (this doc) |
|---|---|
| Phone app; the radio is in the phone | Webapp + Studio helper; the "radio" is the helper's LAN link |
| Bluetooth advert, 10-minute window | Opaque DNS-SD advert on the LAN, 30-minute window (7.2) |
| Presence rule: exactly one new advert | The same rule over what the helper sees, plus arm-all (4.3) |
| Wi-Fi details over the radio | Ethernet only; no secret goes to a tray before it is claimed |
| Monitor + 3 presses = the sharing method | Console code = the normal method; the helper can read it from serial or the BMC |
| One box at a time | Batches |
| `.com` key pre-registration + internet check | Kept on connected sites; on air-gapped sites, replaced by the helper's LAN check of the tray's key (8.2) |

What does not change: the handshake and its records, the receipt, the ratcheting setup code, the reset window, the
locked state after an interrupted wipe, and release = wipe.

## 4. Proving which tray

### 4.1 Options, now that the claim runs over the LAN

| Option | Targeting | Against a hostile LAN or a rogue helper | Verdict |
|---|---|---|---|
| **Console code typed into the webapp.** 3 presses (or BMC soft power three times) show the code on VGA/KVM, `ttyS0` and BMC serial-over-LAN | exact | **closed**: the code keys the handshake, and neither the LAN nor the helper knows it | **Default** |
| **Console code read by the helper** from serial or BMC serial-over-LAN | exact | closed against the LAN; **open against a rogue helper**, which now knows the code | Recommended for large batches; the trust in the helper is said on screen (6.2) |
| **Timed press, arm-all**, on a claim VLAN or a direct cable | exact (only the pressed tray reports) | closed while the link is physical (direct cable) or isolated (VLAN); on a shared LAN it is the Bluetooth relay case (T3) | **Accepted on an isolated link only**; the webapp asks which kind of network it is |
| Timed press on a shared LAN | as Bluetooth | open: an attacker can hide the real tray from discovery (ARP/ND spoofing, a forged DNS-SD answer) and relay | Refused by default; allowed only after a warning, like Bluetooth's Standard tier (Q-W1) |
| Link-local IPv6 over a direct cable (laptop to tray, no switch) | the cable is the proof | closed while the cable is point-to-point | The bench and crash-cart variant of "isolated link"; the helper can use zone ids, the browser never sees them |
| LLDP (the tray reports its switch and port) | a good hint ("sw-3, port 17") | none (spoofable) | Shown in the helper's list, never treated as proof (Q-W8) |
| Printed code or sticker | exact | closed | Ruled out by the owner |

### 4.2 Console code

- 3 short presses, or BMC `chassis power soft` sent three times (an ACPI power-button press, `KEY_POWER`), make a fresh
  code. It is shown for 10 minutes on `tty1` and on `ttyS0`, which BMC serial-over-LAN mirrors. The code is single use
  and is thrown away on claim, reset, key change, wipe or expiry.
- **Typed or pasted** into the webapp: the helper is a blind carrier. This is the strongest path and the default.
- **Read by the helper** (Studio's "Read codes from consoles", given the BMC credentials or the serial ports): the helper
  sends each tray's code to the webapp with the tray's address. The webapp says: "Studio read these codes. Anyone who
  controls this laptop could have read them too." This is fine on the command laptop, which holds the admin root anyway
  (6.1).
- Anyone who can read a console in those 10 minutes can claim the tray. In a data centre that means the KVM or BMC
  network, which can already power-cycle and reinstall machines.

### 4.3 Timed press with arm-all

1. Trays power on. The helper lists every unclaimed tray it discovers. The webapp keeps the Bluetooth presence rule:
   it notes the trays already present before the batch, and only trays that appear afterwards are candidates.
2. The webapp opens one claim session (mode `open`) per candidate through the helper and arms them all at once. After the
   hidden pause it says "Press the power button on the tray for r2u14".
3. Exactly one session must report exactly one short press, judged by the existing `judgePressReport`. Any other
   outcome stops the claim: zero or two reports, a report before the instruction, or a `contention` from any tray.
4. The rest are re-armed for the next tray.

On a direct cable or an isolated claim VLAN, nobody else can reach the trays, so the press is as strong as the code.
On a shared LAN, an attacker who hides the real tray from the helper and relays to it defeats this, as on Bluetooth
(`retail-box-setup.md` §6.1). The webapp therefore asks for the network kind first ("Direct cable or a network only
for setup" / "Shared network") and uses the code on a shared one.

### 4.4 Recommendation

- **Default: console code**, typed or read by the helper.
- **Press:** only on a direct cable or a claim VLAN.
- **Operator advice:** provision in a claim VLAN that holds only the command laptop, the new trays and (on a connected
  site) an uplink to the internet.

## 5. The helper: Flagship Studio, with a shared Rust engine

### 5.1 Why Studio, and why not a new app

Studio is already signed (Mac notarized; Windows still unsigned, an open owner decision) and distributed for Mac,
Windows and Linux. It already pairs with a phone, hosts VMs, writes disks, translates its text and updates itself. A
data-centre operator installs it once.

The catch is that the three Studios are written in three languages: Swift (`apps/builder-mac`), C#
(`apps/builder-windows`) and Python (`apps/builder-linux`). Writing the LAN code three times would triple the code and
the review of a security-sensitive parser. So:

- **`flagship-fleet`**, a new crate in `rust/` (next to `flagship-crypto`, which already has X-Wing for `pq-session`),
  is one binary built for the three OSes. It handles discovery, claim links, console reading, BMC presses, the
  native-messaging host and the loopback fallback, plus LAN delivery of fleet orders and (site mode) updates.
- **Each Studio bundles it, starts it, and adds one screen**: Fleet (on/off, the paired browser, which interfaces to
  use, BMC credentials, consoles).
- **Headless use:** `flagship-fleet serve` runs on its own on a Linux laptop or a jump host, for operators who do not
  want the Studio UI.

A new standalone app would give the same engine with a fourth installer, signing and update path. That is not worth it.

### 5.2 What the helper does and does not do

Does: discovery (DNS-SD `_flagship-claim._tcp`, with opaque per-boot ids, on the interfaces the operator picks); TCP
claim links carrying the existing `encodeClaimMessage` frames; console capture (serial ports, IPMI serial-over-LAN);
BMC power presses; LLDP hints; and, for claimed trays, carrying signed orders and status over LAN-direct (section 7).

Does not: hold the admin root, an account key, a device key, a recipe signing key or a claim channel key. It never
decrypts a claim record. It cannot sign anything a tray or `.com` accepts. If it disappears, the webapp still works for
everything except LAN claims.

### 5.3 The browser to helper link

**Primary: native messaging through the Firefox extension.** Firefox starts the helper only for the extension id named
in the host manifest that Studio installs. Firefox has no `externally_connectable`, so the webapp reaches the extension
through a content script on the webapp origin only, with `window.postMessage` and a strict origin check. The helper
opens no listening port.

**Fallback: loopback HTTP** at `http://127.0.0.1:<random port>`. Firefox treats loopback as a secure context, so an
`https://` page may call it. Defences, all required:

- the `Host` header must equal the literal loopback address and port (defeats DNS rebinding);
- the `Origin` must be the webapp's origin (or, in site mode, the helper's own);
- a custom header must be present (no CORS-simple requests);
- a pairing token is shown in Studio and entered once in the webapp, then sent with every call;
- requests come from loopback only, and no CORS wildcard is ever sent.

### 5.4 What the tray listens on

A wired SKU, while claimable (unclaimed in its window, or in a reset window), listens on TCP port 4433 (Q-W12) on its
LAN interfaces for claim frames. It also announces `_flagship-claim._tcp` with only a random per-boot id and its state:
no name, model, serial or MAC. The listener runs only the handshake parser, with frame caps, at most 4 links (as
`MAX_LINKS`), and a per-address rate limit. It closes when the window does. Bluetooth SKUs never open it (their
presence rule depends on the radio).

## 6. Threats with a LAN helper

| # | Threat | Code typed in the webapp | Code read by the helper | Press on an isolated link | Press on a shared LAN |
|---|---|---|---|---|---|
| H1 | **Rogue helper** (malware posing as Studio, a swapped binary, a compromised laptop) | closed: it carries ciphertext and does not know the code | **open**: it knows the code, so it can claim the tray for itself | open: it controls discovery and can relay | open |
| H2 | **Hostile LAN**: spoofed DNS-SD, ARP/ND spoofing, a fake tray, relay | closed | closed | closed (no one else on the link) | **open** (Bluetooth T3 equivalent) |
| H3 | **Browser to helper link**: another web page, DNS rebinding, another local user or process, another extension | closed: what crosses is ciphertext, and the tray needs the code | the codes cross this link: native messaging limits who can read them; on loopback the token and origin checks do | a hostile page could try to arm trays: blocked by the origin, header and token checks; at worst it causes contention (grief) | same |
| H4 | **Grief**: arm-spam, link floods on the claim port | code sessions never arm | same | needs a host on the isolated link | anyone on the LAN can force `contention` |
| H5 | **Helper supply chain**: an unsigned Windows build, the update channel | as H1 | as H1 | as H1 | as H1 |
| H6 | **Pass it on**: a relay forwards the recipe to the real tray and signs its own receipt | not possible (no relay without the code) | as H1 | not possible on an isolated link | caught on a connected site by `.com`'s register gate (the tray's key differs from the pre-registered one); in site mode, by the helper's LAN key check (8.2) only if the helper is honest |

### 6.1 Out of scope, as on the phone

An attacker who controls the command laptop's browser or the webapp origin already holds the admin root. A rogue helper
on that laptop is usually the same attacker, so the helper is not treated as an extra wall around the laptop. What the
design does guarantee: the helper's own code, or a malicious process that can talk to it, gains nothing without the
browser, unless the operator chooses helper-read codes (H1, column 2).

### 6.2 What the operator is told

- Helper-read codes: a one-line notice that Studio saw the codes.
- Press on a shared LAN: refused unless the operator confirms "Someone on this network could intercept the setup. Use the
  setup code instead?" (Q-W1).
- Windows Studio is unsigned today. A fleet product needs it signed (H5, Q-W13).

## 7. Fleet operations

### 7.1 Claiming many trays

The webapp's **Set up trays** screen (admin devices only, helper connected):

1. Rack and power the batch. The helper lists the trays it discovers, with LLDP port hints. Codes arrive pasted, or
   read from consoles.
2. Name the trays: by rack position (`r2u14`), or as a numbered series. Names are checked as typed (on a connected site
   by `.com`; in site mode against the site's list).
3. One confirmation for the batch. Each tray still gets its own AuthCode, recipe and key registration, signed with the
   admin root held unlocked for the session.
4. Code mode claims in parallel. Press mode goes tray by tray (about 10 s each).
5. A board shows each tray: claimed, key registered, online, certificate, first update, padlock.
6. One signed `flagship/server-order/v1` adds the batch at the end of the order. The order holds at most 64 servers
   (`SERVER_ORDER_MAX`; Q-W3).

`.com` limits AuthCode issues to 10 an hour per IRK (`auth-code-issue` in `rateLimit.ts`), so a fleet needs a larger
budget for issues signed by the admin root, or a batch issue route (Q-W4). Trays should default to auto-unlock, so that
a power cut across a rack does not need 40 approvals.

### 7.2 Windows and gestures on the tray

- **Claim window:** 30 minutes after power-on. One short press while nothing is armed reopens it. It closes once the
  tray is claimed.
- **Reset window:** 5 presses, 10 minutes, data intact until a new claim completes (unchanged).
- **Show code:** 3 presses, or (Q-W5) a key (`S`) on the console.
- **Status line** on `tty1` and `ttyS0`: link, address, DNS, then `.com` and the relay (or, in site mode, the helper).
  The `connectAndDiagnose` codes are shown in the box's i18n, with the tray's addresses. The helper reads this status
  over serial or the BMC too.

### 7.3 Hot-plug replace

"Replace this tray" on a dead server's page:

1. Delete the dead server with the existing signed revoke, plus a `wipe-now` order in case it ever boots again.
2. Claim the new tray under the same name.
3. Put its key in the same slot of the server order.
4. Restore the data from peers (peer backup v2) or from the latest backup file.

On a connected site the helper is needed only for the claim. In site mode the helper also carries the orders (8.2).

### 7.4 Decommission

Release = wipe. "Release" signs one release order per tray. Each tray crypto-erases, reimages from its recovery
partition, checks the wipe (`wipeVerifier.ts`) and returns to UNCLAIMED. The helper delivers the orders over the LAN
when a tray cannot reach `.com`. A tray pulled out before it received its order: 5-press reset at the bench, then
release it from there.

### 7.5 Diagnosis without screens

1. NIC link lights.
2. The console status line on serial, the BMC or a crash cart. The helper can collect these for the whole rack.
3. The helper's discovery list: a tray that announces itself but never reaches the next stage.
4. After the claim: Activity, the health card and `lastUpdate`, through `.com` or, in site mode, through the helper.

## 8. Air-gapped sites ("site mode")

### 8.1 What depends on `.com` and `.services` today

| Function | Who uses it | Today |
|---|---|---|
| Account, usernames, device book and grants, read tokens | every client, every box | `.com` D1 |
| AuthCode issue and single use; server registration (name, STK) | admin device; box at first boot | `.com` |
| Box key pre-registration (`/api/box-claim/key`) and the register gate | retail claim | `.com` |
| Public name `<server>.<user>.flagship.services` and its DNS | everyone | `.com` zone, root wildcard |
| Certificates: Let's Encrypt (TLS-ALPN-01 over the relay; DNS-01 for wildcards written by `.com`, `remoteDnsChallengeWriter.ts`) | box | LE + `.com` + relay |
| Relay tunnel, SNI passthrough, address echo | box; every remote client | `.services` |
| Boot unlock: unlock requests and replies, leases, sealed disk-key deposits, boot-key binding | box; phones | `boot.` on `.com` |
| Revocation: revoked servers, device grant revocations, invite revokes, the doorbell | box; clients | `.com` |
| Release list and endorsements (checked on the box against pinned keys); the code itself comes from git | box; apps | `.com` `/api/releases`, GitHub |
| CA endorsement lease (share accept, relay blessing; must renew about every 90 days) | box | the box's checkout, signed offline |
| Trusted time (`/api/time`, CA-signed) and the time floor | box; boot client | `.com` |
| Push notifications (APNs, FCM) | phones | `.com` |
| Account recovery, re-pair proofs, passkey cloud recovery, sealed peer-backup records | clients | `.com` |
| Server order storage and delivery | clients, boxes | `.com`, plus direct box to box |
| Security notices | clients | `.com` |
| Account-key attestation for shares | boxes | `.com` CA |
| Flagship Inference, AI provider egress | box | shim and hub |
| Gossip and access sync between boxes | boxes | relay names |

### 8.2 What a site uses instead

| Function | Site mode | Trade-off |
|---|---|---|
| Account and device book | the account is **created online once** (username, admin root pinned) or is **site-local** (no `.com` record at all, Q-W2b). Devices are added by admin-signed grants delivered over the LAN, and every box keeps its own book, as it already verifies grants | no `.com` view of devices; losing every admin device loses the site |
| AuthCode, registration | the box takes a recipe whose AuthCode the admin root signed, and checks it locally (it already does). The site's **signed server list** (the server order, extended) is the registry; names are unique within the site | no global uniqueness; no `.com` single-use check, so the tray's own refusal of a second claim is the only guard |
| Key pre-registration and internet check | the helper asks the tray, over LAN-direct, for an STK-signed hello naming its TLS leaf and a nonce (the rescue hello of `data-sovereignty.md` §4.3), and compares the key with the receipt | catches "pass it on" only if the helper is honest; no independent second view |
| Names and DNS | names under a domain the company owns (`r2u14.dc1.example.internal`) in its internal DNS, or bare addresses via the helper | the company runs DNS |
| TLS | **native clients** (phones, the helper): key-bound TLS, as rescue does: leaf hash signed by the STK, no CA needed, works with any certificate. **Browsers**: a **site CA** whose root the company installs in Firefox by enterprise policy (`Certificates.Install`), with an X.509 **name constraint** limited to the site's domain. The admin root authorises each box's certificate; the CA key sits on the helper laptop or, better, a YubiKey | the site CA is a new high-value key: name constraints keep a stolen one from minting certificates for other domains; without them it would be a company-wide interception key |
| Relay | none: LAN-direct (boxes already serve on LAN :443) and the company's own routing | nothing reaches the site from outside, which is the point |
| Boot unlock | approve mode carried by the helper or a phone on the LAN (the `data-sovereignty.md` "LAN fallback for boot unlock" idea, not built); auto-unlock with TPM-sealed leases (milestone 6 sealing) and lease lifetimes the owner sets | a long-lived lease on a stolen tray is a longer window; the TPM PCR policy is what holds it |
| Revocation | admin-signed revocations delivered by the helper to every box; boxes refuse grants older than the latest revocation they hold | a box that is off during a revocation keeps trusting the old grant until it is reached; the helper marks the boxes that have not acknowledged |
| Updates | **sneakernet**: a release bundle (git bundle, Rust binaries, `node_modules`, the v1 endorsement and its PQ companion) on a USB stick, imported by the helper and offered to boxes over the LAN; the box runs the same gate and rollback as an online update | updates happen only as often as someone carries them in; the helper shows how old each box's release is |
| CA lease | not needed for site features (no relay blessing, no cross-account shares); the features that need it stay off | no co-managers from other accounts |
| Time | owner-signed time from the helper (`flagship/site-time/v1`, new), never earlier than the box's floor; or the site's NTP with the floor as the bound | an operator who controls the helper can push the clock forward and expire leases and codes early; not backwards (the floor) |
| Push | none; the helper's dashboard and Activity | |
| Recovery | admin root backups (the v2 account key file), several admin devices; no cloud recovery | strictly the owner's responsibility |
| Peer backup, access sync, gossip | box to box over LAN addresses from the signed server list instead of relay names | needs the site's addressing in the list |
| Security notices | with the update bundle | late |
| AI | local AI on the site's GPUs (0.3 local AI) only | |

### 8.3 What it means for D1

D1 (owner, 2026-10-18) closed self-hosting: "everyone on `.com`", and the promise was "your data moves to another
account", not "your service runs without us". Site mode reopens D1 in a bounded form. It is not a self-hosted `.com`:
there is no account service, no public names and no relay. A site is a trust island under one admin root, built from
pieces that already verify the owner's signatures on the box. What it costs us: a second mode for boxes and clients to
test (gym), a site CA tool, a sneakernet update path, the helper as an order carrier, and the loss of `.com`'s second
view (pre-registration, single-use AuthCodes, revocation, trusted time). For these reasons this doc recommends building
the connected wired path in 0.4, and site mode as its own later release once the owner reopens D1 (Q-W2).

### 8.4 The browser in site mode

The webapp normally loads from `webapp.flagshipserver.com`, which an air-gapped laptop cannot reach (an installed PWA
keeps working offline, but its account calls fail). In site mode the helper serves a signed copy of the webapp at its
loopback origin. That origin is a separate browser origin, so it enrols as its own admin device (one more grant, made
while online, or by another admin device over the LAN). The webapp's pages for boxes go through the helper, and the
helper checks the key-bound hello before carrying anything.

## 9. Changes to the merged phase 1

### 9.1 Protocol (`packages/protocol/src/boxClaim.ts`)

- No change to the handshake, the records, the receipt, `BoxClaimKey` or the code derivations. The frames
  (`encodeClaimMessage`, the 64 KiB caps) carry over TCP as they are, with a 4-byte length prefix.
- New: the DNS-SD advert shape (per-boot id, state), `judgeArmAll(reports)` for the webapp, and the helper protocol
  (browser to helper messages: list, open link, frame in/out, close, console code, BMC press). Vectors for arm-all
  (two reports, a fake early report, contention, zero reports).
- Site mode later: `flagship/site-time/v1`, the site server list, site CA authorisation, the update bundle manifest.

### 9.2 Box (`packages/server-daemon/src/retailClaim/`)

| File | Change |
|---|---|
| new `retailSku.ts` | read `/etc/flagship/retail.json` (`carriers: ["ble"]` or `["lan"]`), fail closed to `["ble"]` |
| `transport.ts` | a `LanClaimPeripheral`: DNS-SD advert + TCP listener producing `ClaimLink`s of kind `"lan"`, length-prefixed frames, per-address limits |
| `claimService.ts` | accept mode `open` on `lan` links for wired SKUs; per-kind link caps; open and close the listener with `claimable` |
| `claimMachine.ts` | a 30-minute claim window for wired SKUs, reopened by one press while nothing is armed |
| `codeDisplay.ts` | `ttyS0` as well as `tty1`; a status screen |
| new `consoleKeys.ts` | `S` on a console shows the code (if Q-W5) |

### 9.3 `.com`

- The lobby from v1 is dropped (never built). The mailbox stays as it is, for the phone's sharing method and as the
  remote fallback.
- An AuthCode budget for fleets, or a batch issue route (Q-W4). Confirm single use at register.
- `SERVER_ORDER_MAX` if Q-W3 raises it.

### 9.4 Webapp, extension, Studio

- Webapp: Set up trays (helper status, discovered trays, codes, the network question, arm-all, naming, batch
  confirmation, board), Replace this tray, bulk Release; X-Wing in the browser bundle; every string through `i18n/webapp`.
- Extension: the `nativeMessaging` permission, a content script on the webapp origin only, and a bridge to the helper
  protocol; it accepts a server claimed by the webapp for pinning (connected sites).
- Studio (all three): bundle `flagship-fleet`, install the native-messaging host manifest, add the Fleet screen.
- iOS and Android: "Set up a tray by code" over the code mailbox stays possible; no LAN path on phones in this build.

## 10. Work breakdown

**Phase W1, connected sites, on VMs** (QEMU trays: `system_powerdown` over QMP is an ACPI power-button press; the
serial console is captured from `-serial`; a bridge network with a second "attacker" VM):

1. Protocol: the advert, the length-prefixed TCP framing, `judgeArmAll`, the helper protocol, vectors.
2. Rust `flagship-fleet`: discovery, links, serial and IPMI serial-over-LAN capture, BMC press, native-messaging host,
   loopback fallback with its checks; fuzzing of the frame parser.
3. Box: SKU carriers, the LAN peripheral, the window and reopen press, the consoles.
4. Studio x3: bundle, host manifest, Fleet screen. Windows signing (Q-W13).
5. Webapp and extension as in 9.4.
6. `.com`: AuthCode budget, single-use check.
7. Gym lane `retail-wired`: three trays and the helper on one bridge; code claims in parallel; arm-all press; an attacker
   VM that forges a DNS-SD answer and relays (stopped on the isolated setting by the presence rule, and caught by the
   register gate in the pass-it-on variant); a hostile page against the loopback fallback; release and re-claim.

**Phase W2, hardware:** a tray SKU with a BMC. Checklist additions: BMC soft power arrives as `KEY_POWER`;
serial-over-LAN shows `ttyS0`; power-on after AC loss in the chassis; the NIC works without an extra driver. Then a real
run from a Firefox laptop.

**Phase W3, site mode** (only if Q-W2 reopens D1): the site server list, key-bound checks in the helper, the site CA
with name constraints (YubiKey), the helper-served webapp origin, helper-carried boot unlock and revocations, sneakernet
update bundles, `site-time`, and a gym lane with the uplink cut.

## 11. Questions for the owner

- **Q-W1** Press on a shared LAN: refuse it (code only), or allow it after a warning, as on Bluetooth?
- **Q-W2** Site mode reopens D1 in a bounded form (no account service, no public names, trust from the admin root).
  Build it, and when? **Q-W2b:** may a site's account exist only on the site, with no `.com` record at all?
- **Q-W3** Fleets past 64 servers: raise `SERVER_ORDER_MAX`? And how are fleets priced?
- **Q-W4** One admin confirmation per batch of trays, and a larger AuthCode budget (or a batch route)?
- **Q-W5** Show the setup code on a console keypress (`S`) as well as 3 presses?
- **Q-W6** Corporate networks on connected sites: HTTP proxies and static addresses in the first build, or DHCP and
  direct 443 only?
- **Q-W7** Studio as the helper, with one shared Rust engine (recommended), or a separate small app?
- **Q-W8** LLDP port hints in the helper's list?
- **Q-W9** Strict (quantum-safe) accounts: may the webapp claim with classical signatures, or must it gain ML-DSA signing
  first?
- **Q-W10** May the webapp hand claimed servers to the extension for pinning (today only a phone pairs it)?
- **Q-W11** A LAN path on home boxes too, for a dead Bluetooth radio? Recommended no: the console code already covers it.
- **Q-W12** The claim port: 4433, or another fixed port the company can allow on its provisioning VLAN?
- **Q-W13** Windows Studio code signing: needed before fleets ship, since the helper is now in the claim path.
- **Q-W14** Helper-read codes: acceptable by default on the command laptop, or opt-in per batch?

## Owner decision, 2026-11-14: air-gapped site mode

Plan it, do not release it in 0.4. It comes after the Windows certification and after funding. 0.4 builds only the
connected wired path (if at all), with Studio as the LAN helper.

### Owner note, 2026-11-14: site mode for enterprise subscribers

Site mode could be limited to enterprise subscribers. Why: an air-gapped cluster still checks in with Flagship
periodically (by sneakernet or a brief controlled link) to refresh its permission from `.com`. In return Flagship:

- sends air-gapped security updates (signed release bundles for sneakernet);
- keeps a record per cluster that it "has not been hacked". Owner clarification (2026-11-14): this is primarily an
  attestation ceremony. The site's admin (the person who set up the cluster) goes online and signs, with the site's
  admin root, "I still run this cluster and all is fine". The record is that signed, dated statement (plus the
  cluster's signed state such as release and revocation versions). Optionally, the site may also upload statistics
  that let `.com` detect patterns and attacks across clusters (opt-in; aggregate counters only, no user content,
  under the AI-privacy and identity rules);
- gives a warranty: as long as the site stays subscribed and follows the simple guidelines, it will never lose
  availability or data to a hack.

To design with it: what the check-in proves and carries (signed by the site's admin root and each box, no user
content), how long a permission lasts between check-ins and what a lapsed site does (degrade, never wipe), the
guidelines the warranty depends on, and how the "not hacked" record is evidenced. The warranty wording needs legal
review before it is offered.

### Owner note, 2026-11-14: multi-admin ceremonies and enterprise accounts

The check-in ceremony may involve several people: the enterprise version can have elaborate multi-admin ceremonies
(for example k of n admins sign the "still running, all fine" statement). More broadly, enterprise admin accounts
should be the only ones that let you add multiple authorized user accounts and make some of them admins of certain
servers or services. Normal accounts can still invite someone to share a server (`docs/share-a-server.md`), but not
with the same granularity. Details to iron out: `docs/enterprise-accounts.md`.
