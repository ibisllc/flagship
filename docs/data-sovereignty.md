# Data sovereignty: the user keeps their data if we cannot serve them

> **Status: phase 1 (2026-10-18).** The threat model, an honest inventory,
> the "Rescue my data" design, and the box/protocol slice of it are on
> `main` (section 5). The phone screens, the webapp, gym scenarios and the
> live-gym lane are phase 2 (section 7). Nothing here is deployed: boxes need
> an endorsed release.

Owner promise (2026-10-18): **users can keep their data even if we fall to
censorship.** If `.com` is ordered to kill an account, the user's phone must
still reach their server directly over the LAN, make a backup, and import it
into another account on another server, so their service survives.

This file is the design and the inventory behind that promise. It is
deliberately blunt about what does not hold yet.

## 1. Threat model

What an order against us can do, in increasing strength:

| # | Event | Who can do it |
|---|---|---|
| T1 | The account row is deleted or blocked at `.com` (usernames row gone, devices refused, read tokens 404) | `.com` operator |
| T2 | The server is revoked: leases and the sealed disk blob deleted, routing and DNS for `<server>.<user>.flagship.services` removed (`accountDeletion.ts` does this for a deliberate deletion; an operator can do the same by hand) | `.com` operator |
| T3 | The relay is unreachable or refuses the box (`.services` down, HELLO refused after revocation) | `.services` operator, a network censor |
| T4 | `.com` is unreachable for everyone (seized, blocked, offline) | anyone |
| T5 | Both of T3 and T4, plus the zone `flagship.services` is gone | anyone |

What the user holds in each: their phone with the account key (UMK) and so
the admin root, IRK, STK derivation and archive keys; a box on their own
hardware with their data on a disk only their phone can unlock.

What we are defending: **the user's data and their ability to move it**, not
the service's availability under the old name. Names under `flagship.services`
are ours to lose and the design never promises to keep them.

What we are not defending against: an attacker who holds the admin root (they
already own the box), or a user who has lost every device and has no recovery.

### Hard limits, stated up front

1. **Rescue only works while the box is running.** The data disk is encrypted
   and the key comes from `.com` on every boot (section 3.1). If the box
   reboots after T2, it cannot unlock. The window to rescue is "before the next
   reboot", unless the owner has chosen an offline unlock (decision D2).
2. **"Import into another account" needs a control plane that will create that
   account and a server.** Under T1 to T3 that is `.com` serving someone else.
   Under T4 or T5 there is no `.com` to make the new account: the rescue
   still produces a portable, passcode-sealed `.flagship` file, but there is
   nowhere in Flagship to restore it until a control plane exists. Closing that
   gap is a separate, larger decision (D1).
3. **A web browser cannot do any of this.** It cannot connect to an address
   with another server's name, or accept a certificate by key. The Rescue flow
   is phone-only (iOS, Android), and Studio on the desktop later.

## 2. What already works with no `.com` (verified by reading the code, and in
tests where noted)

- A running box keeps serving. I found no code that makes a running box stop
  serving, or wipe itself, because `.com` answers "revoked" or "not found"
  (the heartbeat only logs, the health reporter ignores the answer, relay
  lockdown is off by default and fails open).
- **`.com` cannot make a box wipe.** Self-delete (`selfDeleteConsumer.ts`) and
  decommission (`decommissionConsumer.ts`) orders are re-verified on the box
  under the pinned admin root (the IRK only where none is pinned). `.com` can
  withhold an order or replay an old signed one, not forge one.
  (Open: the self-delete order has no server binding or freshness check on the
  box; replaying an old one is only harmful if the same owner key is later
  reused. Worth closing, not urgent.)
- **Owner requests are verified on the box.** `POST /api/orders-from-user`
  (`orders.ts`) verifies against the config-pinned IRK (admin root for the
  destructive types) with a 5-minute staleness check, no network. The
  paired-session gate (`pairedSessionStore.ts`) is a local file. The backup
  routes (`serverArchive/service.ts`) call nobody.
- **The LAN-direct listener** (`lanDirect.ts`) pipes any private-LAN
  connection into the same TLS server the relay feeds, so every route above
  is reachable on the LAN.
- **The device book** is cached on disk (`account-devices.json`) and a failed
  refresh keeps the old book (`accessPrincipals.ts`).

## 3. Inventory: what the box and the phone depend on `.com` and `.services` for

Citations are to the code as read on 2026-10-18; "not run" means I read it
and did not watch a box do it.

### 3.1 Box

| Dependency | Needs | When `.com` is gone | Horizon |
|---|---|---|---|
| **Boot unlock, auto mode.** `boot-stage.sh` and the initramfs `userdata.ts` GET `/api/boot/lease/<domain>` (signed with the STK) from `boot.flagshipserver.com`; the sealed key is unsealed locally and held only in tmpfs. Nothing cached on disk. | `.com` | Falls back to approve, which also needs `.com`. | At the **next reboot** |
| **Boot unlock, approve mode.** The box POSTs `/api/boot/request`, `.com` pushes the phone, the phone re-seals the key and POSTs `/api/boot/response`. | `.com` and push | Waits forever (the window is about a year). | At the next reboot |
| **Account or server revoked (T1/T2).** `boxStkForDomain` returns null so every boot route answers 404 "unknown server"; deletion also deletes the box's leases and `luksKeys` sealed blob (`accountDeletion.ts:119-204`). | n/a | **The box can never unlock again through Flagship.** | Next reboot, permanent |
| Offline unlock path | none by design. The initramfs offers a "manual" console passphrase; the passphrase is the public build-time constant `BURN_PASSPHRASE` (`userdata.ts`), and the slot is not removed yet. | Works today, by accident of an open GA item | **GA close-out item 2 deletes it**, leaving no offline path at all (D2) |
| **Certificate issuance and renewal.** DNS-01 is used for every name (`letsEncryptIssuer.ts:222-228`): the box POSTs `/api/dns-01/publish` to `.com` (`remoteDnsChallengeWriter.ts`), which writes the TXT in the `flagship.services` zone. TLS-ALPN-01 (the `.services` passthrough) is not used in production. `.com` answers 404 "unknown server" / 403 "revoked" for a revoked server, and every non-2xx is just a failed attempt. | `.com` and the zone | Renewal fails every time. The box keeps serving the cert it has. | LE certs last 90 days; renewal starts at 27 to 30 days left (`runtime.ts` window with jitter) and is tried every 6 h with backoff, so the cert expires **up to about 90 days after the last good renewal** (27 to 30 days after the first failed attempt). After expiry the daemon keeps serving the expired cert and keeps retrying. |
| Certificate on **reboot** | `shouldReuseCert` required more than 30 days left and matching names; otherwise the box started with **no certificate** and every TLS handshake (relay and LAN) failed | Found by this audit | **Fixed in phase 1** (section 5.3): a stale certificate that names the box is now served while a new one is requested |
| **Startup waited for the relay.** `startDaemonRuntime` did `await tunnel.ready()` (first HELLO_ACK) before installing any cert, before the renewal timer, and before `index.ts` mounted the API, the pollers and the screens handlers. With the relay unreachable at boot the box did not serve even on the LAN. | `.services` | Found by this audit | **Fixed in phase 1**: the wait is capped at 60 s and the tunnel keeps dialing in the background |
| Tunnel HELLO and entitlement | `.services` hub; a CA-signed-chain entitlement bundle on disk, re-fetched from `.com` only if missing or invalid (first boot) | Relay path dies when the hub refuses the box; owner API on the LAN is unaffected (after the fix above) | Immediate for the relay |
| Endpoint discovery (`/api/services/endpoints`) | `.com`, 5 s timeout | Falls back to the on-disk cache, then to the env hub | none |
| Read token for the box's own `.com` calls (`boxReadToken.ts`) | `.com` | Lazy; fails only the read | none. `BoxReadToken.fetch` has **no timeout**, so a black-holed `.com` can stall a sign-in that awaits `ensureKnown` (not run) |
| Device-grants book | `.com`, every 5 min | Old book kept. A 200 with an empty list would drop devices (`adopt()`); a 404 or 5xx does not | none |
| Re-pair watcher (`rePairWatcher.ts`) | `.com` unsigned JSON | **`.com` alone can clear every paired session and install a new IRK on a box that pins no admin root.** Not a data-loss issue; a trust issue (D5) | n/a |
| Mailbox lanes (pairing, SWK, CGK, update, migration, rehome, self-delete, decommission, rotation) | `.com` | Nothing arrives; every order is verified on the box | none |
| Status heartbeat, health reports, push (APNs), alerts | `.com` | Lost; the owner stops hearing about the box | none |
| Relay blessing, CA chain | `.com`; the CA lease is in the repo | Never fatal (OBSERVE mode). The production CA's only lease expires **2026-11-05**: after that every CA-chain check fails closed (AGENTS.md Urgent) | 2026-11-05 |

### 3.2 Phone

| Dependency | Needs | When `.com` is gone |
|---|---|---|
| Server list, status, certificate pin | `/pods` with an account read token minted by `.com`; the pin is the leaf hash from the STK-signed daemon-status `.com` relays | The app is blind: no list, no pin, no screens. Everything the app does for a server goes through that pin |
| Paired-session token | Minted once by a phone-signed order and stored per server | Persists; still valid on the box. But the app only uses it over a pinned, resolved connection |
| LAN-direct | A hint fetched earlier over the relay (`/api/screens/lan-hint`) and the pin from `/pods` | Cannot start; a stale hint is only a probe target |
| Account keys | On the device (Keychain/Keystore) | Unaffected. **This is what makes rescue possible**: the UMK derives the STK, IRK and admin root |
| N1 "This account was removed" screen (being built) | `.com` 404 with `account-not-found` | Has "Remove from this device", which erases the keys rescue needs (section 4.8) |
| Adding a server, importing a backup | `.com` for the new account | New account only; the backup file itself needs nothing (passcode slot) |

### 3.3 What breaks first, in order

1. **Immediately (T2)**: the relay route and DNS name, so every existing link,
   browser and `/pods` view dies. The box keeps running and its apps keep
   serving on the LAN.
2. **At the first reboot**: the box cannot unlock. This is the cliff. For the
   promise to mean anything, rescue has to be possible before it, or an
   offline unlock has to exist (D2).
3. **About 27 to 30 days later**: renewals have failed since day 60 of the
   cert; the cert expires at day 90. Browsers and WebPKI clients refuse the
   box. A phone that trusts the key (section 4) is unaffected.
4. **2026-11-05**: the CA lease expires regardless of any censorship.

## 4. "Rescue my data": design

### 4.1 What the user sees

A **Settings → Rescue my data** entry that exists always: signed in or not,
account present or removed, network or not. It also appears as a third button,
**Save my servers' data**, on the N1 screen ("This account was removed",
`scratchpad/WORKLIST.md` N1), beside "Create a new account" and "Remove from
this device". It needs the account key on the device and nothing else.

Flow: pick the server (from the phone's local copy of its servers; or type
the name; or scan/see it on the local network) → "Looking for your server on
this Wi-Fi…" → "Found *home*" → Face ID → passcode screen (a generated
passcode is suggested exactly as for Back up now; mandatory) → progress
("Making the backup… 40 %") → "Downloading… resume if interrupted" → the file
`home-2026-10-18.flagship` is saved where the user chooses → "To restore it,
make a new account and use Add/Import a server". Every step shows the box's
own sentence on refusal.

### 4.2 Finding the box (three paths, in this order)

1. **mDNS / Bonjour (built).** The box answers multicast DNS for
   `_flagship._tcp.local`. The instance is named by an **opaque id**:
   `hex(HMAC-SHA256(key = the box's STK public key, "flagship/lan-discovery/v1|" + name))[0..8]`
   (`rescueDiscoveryId`). The phone derives each of its servers' STK from its
   own account key, recomputes the id, and matches. The announcement carries no
   name, account or owner, only the id, the port and the LAN addresses
   (private ranges only; never a public one). A bystander on the Wi-Fi sees "a
   Flagship box" and cannot tell whose. iOS needs the Bonjour service type
   `_flagship._tcp` in `NSBonjourServices` and the existing local-network
   permission; Android uses `NsdManager`.
2. **Manual IP.** The user types an address (`192.168.1.20`) with the server
   name. For a user whose router blocks multicast. The box shows its address on
   its console (4.2.1).
3. **Code on the box console (design only).** The box's console already shows
   boot status. Add one line: `Flagship home: https://192.168.1.20  rescue id 4f2a91c0`.
   The phone accepts the id as a hint and still verifies by key. Needs an
   `/etc/issue.d/` drop-in written by the daemon and the appliance's getty;
   small but OS-level, so left to phase 2 (it needs the appliance rebuilt).

Studio-hosted VMs sit behind NAT and cannot be found by a phone on the Wi-Fi
(`lan-direct.md`); for those, rescue runs from the Mac itself (Studio phase,
D6).

### 4.3 Trusting the box without a certificate authority (the safer choice)

Two options were weighed:

- **TOFU-pin the leaf key from the pairing record.** Needs the phone to have
  saved a fingerprint, which today comes from `.com` `/pods` and rotates every
  renewal. After the certificate rotates (or expires) a pin from last month
  no longer matches, and the user would have to override a security warning
  at exactly the moment they are under pressure. Rejected as the primary path.
- **Authenticate by key, bind to the connection (built).** The phone never
  asks whether the certificate is valid. It connects by address with the
  server's name as SNI, accepts whatever certificate is presented, and asks
  the box to prove itself: `POST /api/rescue/hello {clientNonce}` returns a
  hello **signed by the box's STK** that names the phone's nonce and the
  SHA-256 of the certificate the box is presenting. The phone derives that STK
  itself (`deriveSTK(deriveSWK(UMK, serverName))`), verifies the signature, and
  checks that the certificate hash equals the one its own TLS stack saw. A
  machine in the middle must present a different certificate, so the hash
  differs and the phone stops before signing anything (tested). The check
  takes a hash, never a validity date, so **an expired Let's Encrypt
  certificate, a certificate for a name that no longer resolves, or no DNS at
  all do not matter**.

So: safest = key-bound hello; and after the certificate expires it still works.
Browsers cannot do this (no custom trust), which is why the flow is phone-only.

A fallback self-signed certificate on the box would not change any of this for
the phone and would not help a browser (it would still warn); it is not
needed (D4).

### 4.4 Authenticating the owner with no `.com` round trip

Which existing endpoints accept an owner with no `.com`, and what changed:

| Endpoint | Auth on the box | Needs `.com`? | Verdict |
|---|---|---|---|
| `POST /api/orders-from-user` `add-paired-session` | IRK signature (even on admin-pinned boxes: pairing orders are "pair-for-use") over a payload with only a 5-minute window and no box nonce; the token opens the **whole** owner surface | No | Works offline, but too broad and too weak to be the rescue gate: any device holding the IRK gets a full session, and nothing binds it to the connection |
| `/api/screens/server-archive/*` | a paired-session token | No | Works offline once you have a token |
| `/api/rescue/*` (**new, built**) | a signed order, below | No | The rescue gate |

The new gate, `flagship/rescue-session/v1|<server>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>`,
is signed by the **sensitive-order key: the admin root on a box that pins one
(an IRK signature is refused), the IRK on a box that pins none** (the same
`authorizeSensitiveOrder` every destructive order uses). It names a nonce the
box issued seconds ago and spends it on first use (right or wrong), names the
certificate hash of this very connection, and is good for 2 minutes. So it
cannot be replayed, relayed to another connection, or reused. It returns a
random token that lives in memory for an hour (at most 4 at once), accepted
**only** by `/api/rescue/*`: the paired-session gate does not know it, and the
rescue routes allow exactly: server summary, start a backup, watch it, fetch
its bytes (`backup-file`, `chunk`, `bundle`), delete it. No link minting, no
approvals, no restore, no saved-backup routes, no other screens. A rescue
session cannot install, remove, read app data or change access.

Availability: everything on the LAN reaches the app as one loopback source, so
there is no per-caller limit. A guess cannot succeed (it needs a signature), so
the caps only bound memory and log noise: a flood of hellos drops the oldest
pending one rather than refusing the owner, and refusals reach the Activity
log at most every ten seconds. A hostile LAN device can slow a rescue, never
open one.

### 4.5 Making the backup

Unchanged: the existing archive path (`server-backup-and-clone.md`), now
reachable at `/api/rescue/archive/start` etc. The passcode slot stays
mandatory (`400 passcode-required`, tested through the rescue route), and the
phone also includes the account slot so that account's own devices can open
it. Without `.com` the phone does not need the old account for any of this;
the passcode is what opens the file in a stranger's account.

### 4.6 Downloading

`GET /api/rescue/archive/bundle?offset=N` (≤ 4 MiB) with
`x-flagship-bundle-bytes` and `x-flagship-bundle-sha256`: the existing
resumable downloader, 4 parts at a time, a progress file, SHA-256 check, and
the one `.flagship` file saved where the user chooses. The box keeps the
backup up to 24 h; the phone deletes it when the download verifies.

### 4.7 Importing into a new account

The existing Add/Import a server flow, unchanged. Walking through it for a
different account:

1. Pick the `.flagship` file. Open with the **passcode** (the account slot fails
   in the new account, as intended). No old-account step.
2. Streams the data part and checks size and SHA-256. Local.
3. Pick a name (the saved one is filled in unless taken). The new account's
   admin root signs the `server-restore/v1` order. New account only.
4. The new box adopts it and installs the apps one by one.

Step-by-step, **nothing in the import reads the old account**. But restoring
into a different account has consequences that are not yet handled, and one
that needs a decision before we can say "your service survives":

- **Restored apps keep their original creator.** App ids are
  `<creator>--<slug>` and the restore keeps them. On the new box the creator
  is not the host, so `ServicePlatform.install` treats the app as
  **cross-creator**: the URL label becomes `<slug>-<oldname>`, and, when the
  pull-state store is wired, it records an auto-update pull from the app's
  "canonical home" `<slug>.<oldname>.flagship.services`. A freed name can be
  claimed by anyone (deliberate deletion frees it immediately,
  `account-deletion-and-name-reclaim.md` §1), so a restored app could be told
  to pull code from whoever now holds the old name. I did not trace whether the
  lineage verifier would stop it; **this needs a test and a fix (restore must
  treat a backup's apps as the new host's own and skip canonical-home pulls)
  before the import path is promised for another account.** Phase 2, first item.
- **Members and invite links** came from the old account: people must be
  re-invited, and links minted by `.com` for the old account are dead. A
  visitor's per-app key is derived from the visitor's own account, so their
  identity toward the app survives if the app keys on it.
- **API keys** are signed by the old owner and are dropped on import ("no
  longer verify"); the owner mints new ones.
- **The address changes** (new server, new account): every shared link breaks.
  Unavoidable. Custom domains are a Pro feature on a branch.
- A restore needs a new server: hardware, plus a control plane that will make
  one (limit 2).

### 4.8 Edge: "Remove from this device" erases the keys rescue needs

On the N1 screen, "Remove from this device" (and any sign-out that wipes
profiles) deletes the UMK. After it, rescue is impossible. The button must say
so ("This also erases the keys that open your server's backup on this phone.
Save your servers' data first.") and N1's third button should come first.

## 5. What is built in phase 1 (on `main`)

### 5.1 Protocol (`packages/protocol/src/rescue.ts`)

`flagship/rescue-hello/v1` (box STK) and `flagship/rescue-session/v1`
(sensitive-order key), canonical `tag|server|clientNonce|boxNonce|certSha256|issuedAt`,
nonces 16 bytes hex, hash 32 bytes hex; `checkRescueHello` (the phone's checks
before it signs: signature, server, nonce, **certificate hash**, freshness);
`rescueDiscoveryId`. Vectors: `packages/protocol/test-vectors/rescue/vectors.json`
(TS passes; Swift, Kotlin and webapp ports are phase 2, per the four-port rule).

### 5.2 Box (`packages/server-daemon/src/rescue/rescue.ts`, `lanDiscovery.ts`)

`/api/rescue/{hello,session,server,archive/*}` answered **before** the
paired-session gate in `screensHttp.ts`, wired in `index.ts`; mDNS responder
started with the LAN listener (`FLAGSHIP_LAN_DISCOVERY=0` disables;
`FLAGSHIP_LAN_DIRECT=0` disables both). A bind failure is logged and ignored.
Activity: `server.rescue.opened` and `server.rescue.refused`.

### 5.3 Box boot (`runtime.ts`, `acme/persistentStore.ts`)

- The wait for the relay is capped (`relayGraceMs`, default 60 s: the first
  dial is jittered up to 30 s). After it the box goes on, logs why, and the
  tunnel keeps trying.
- A certificate that is inside its renewal window or past its end, and names
  this box, is installed while the retry loop asks for a new one
  (`shouldServeStaleCert`, `onCertFallback`). The daemon uses it only to know
  which certificate the phone will see; it does not report "live".

### 5.4 Tests

- `packages/protocol/tests/rescue.test.ts`: vectors, tag separation, every
  field covered by the signature, `checkRescueHello` refusals.
- `packages/server-daemon/tests/rescue.test.ts`: real TLS in front of the
  real screens handler and the real archive service, **every outbound
  `fetch` throws and none is attempted**: admin-root session → backup →
  download → open with the passcode and the account key; an **expired**
  certificate; IRK refused on an admin-pinned box and accepted on one that pins
  none; a stranger's key; replayed order; wrong certificate, nonce, server,
  stale hello; a **relaying man in the middle** caught by the certificate hash;
  token scope (no paired-session route, no link/approve/restore/saved route);
  passcode still mandatory; expiry and eviction; no lock-out under refusals;
  flood handling.
- `sovereigntyBoot.test.ts`: the bounded relay wait; stale-cert serving.
- `lanDiscovery.test.ts`: the DNS codec, what is and is not announced, a real
  UDP round trip, LAN-only sources, port-in-use.

Not run: a real box, a real phone, multicast on a real network, `startDaemonRuntime`
itself (its two changes are tested as the extracted pure functions).

## 6. Findings that need decisions (owner)

- **D1. A control plane the user can reach when `.com` is gone.** Without one,
  "import into another account" is impossible under T4/T5. Options: a published
  self-hostable control plane (the Worker is already open-source-shaped, BUSL);
  a second operator; or accept that the promise is "your file survives" and
  not "your service restarts".
- **D2. Offline unlock.** Unlock needs `.com` on every boot, and the one
  offline path (the public burn passphrase) is slated for removal at GA.
  Options: an owner-held **recovery key** (a LUKS slot whose key the phone
  shows once and includes sealed in every backup); a LAN approval to the
  initramfs (the phone sends the re-sealed key straight to the box, verified
  against the pinned admin root; needs a small listener in the initramfs); or
  a cached lease on the boot partition. Recommend the recovery key first.
- **D3. Rescue must be possible before a reboot.** Consider telling the owner
  (N1, and a banner when `/pods` is 404) "do not restart your server until you
  have saved its data".
- **D4. Fallback certificate.** Recommend **no**: the phone authenticates by
  key; a self-signed fallback helps no one.
- **D5. Re-pair watcher trusts unsigned `.com` JSON** and can swap the owner
  IRK on a box with no pinned admin root. Under this threat model `.com` is the
  adversary. Chain it from the pinned key like `adminRootRotationConsumer`.
- **D6. Studio-hosted VMs** are behind NAT. Rescue from the Mac itself (a
  host-side path into the VM) or a bridged mode.
- **D7. Second discovery path.** mDNS is built. Add the console line/QR
  (needs an appliance rebuild) and BLE later (`lan-direct.md`). Recommend the
  console line.
- **D8. Restoring into another account** (4.7): treat restored apps as the new
  host's own; ship before promising the import.

## 7. Phase 2 plan

| Item | Effort | Notes |
|---|---|---|
| Restore treats a backup's apps as the new host's own (4.7), with a test importing into a second host | 1 to 2 days | box; first, blocks the promise |
| iOS: Rescue screen, Bonjour browse, key-bound TLS (custom trust evaluation comparing the leaf hash), progress and resume, N1 third button, "Remove" warning, local-network permission copy | 5 to 7 days | reference client; mock-gym scenarios first |
| Android: same with `NsdManager` and an OkHttp trust manager | 5 to 7 days | |
| Swift, Kotlin, webapp ports of the vectors | 1 day | the webapp ships only the vector/tests (no rescue UI: a browser cannot do it) |
| Box console line `/etc/issue.d` + appliance rebuild | 1 day | D7 |
| Settings entry always present, N1 hook (N1 is being built now) | 0.5 day each app | |
| Gym scenarios (mock): found, not found, wrong passcode, expired cert, interrupted download resumes, N1 → rescue → import into a second mock account | 2 days across apps | owner rule: every test a gym test |
| **Live-gym lane `sovereignty`** | 3 days | below |
| Offline unlock (D2): recovery key | 4 to 6 days | owner decision first |
| Timeout on `BoxReadToken`, self-delete freshness, re-pair signature (D5) | 2 days | small box fixes |

**Live-gym lane.** After the usual fleet is up (account A `home`, account B
`home`): apply an `iptables` egress drop on A's box to everything except the
runner and B's box (through the gym-only debug access grant, no change to the
box image), plus a gym-only `.com` rule that makes A's account answer 404
(`/api/gym/...` like teardown). Then the runner, acting as the phone (the TS
protocol in `tools/live-e2e`), joins the box's private utility-network address
through a sibling gym box (LAN-direct binds private addresses only, and a gym
runner is not on that network), does hello → session → backup → download, proves
`.com`/`.services` saw nothing from the box during it (egress counters), then
imports the file into account B on a new box and checks the apps start and the
data is there. The reboot cliff gets its own check: reboot the blocked box and
assert it does **not** unlock (documenting D2) until a recovery key exists.

Total: about 4 to 5 weeks for one engineer across the phones, gym and the
decisions, excluding D1 (a project of its own).
