# Recipe delivery & remote install (design)

> Status: **design, not built.** Captures the decisions from the 2026-06-23
> design discussion. Build sequencing is at the bottom — this lands *after* the
> online happy-path (reburn → build-a-service) is proven. Design-only; no code
> has been written against this yet.

## The decision in one line

**The recipe is secret-free by default.** It is a phone-IRK-signed *blueprint*
(namespace + owner IRK pub + bootstrap), carrying **no** secret key material.
Secrets reach the box one of two ways:

- **Online (default):** the box comes up, registers, attests its identity, and
  the owner's phone delivers secrets over the box's own pinned pipe — reusing the
  existing box-sealed auto-unlock-lease + entitlement/pairing-deposit patterns.
- **Offline (advanced):** the owner injects secrets into the boot media locally,
  over a phone↔builder QR-matched channel, so the box needs no internet at boot.

Everything below follows from that single property.

## Why secret-free by default

- **The recipe becomes hand-off-able.** With no secrets in it, it can travel by
  *any* channel — a short code, a `.com` relay, a file, a QR — because there is
  nothing to leak. Tampering with any signed field breaks the signature and the
  box refuses to boot.
- **`.com` stays content-blind even when it relays.** It never sees secrets
  because the recipe has none.
- **Recovery is free.** Box secrets (SWK, disk key, pairing) are *deterministic*
  derivations from the account UMK (`deriveSWK(umk, serverId)` etc.). A lost box
  re-burned from a recipe re-derived on the recovered phone gets byte-identical
  keys → peer backups decrypt. No escrow.

## Trust model (grounded, so the UX copy stays honest)

| Party | Role | Signs anything load-bearing? |
|---|---|---|
| **Phone** | Trust root. Holds the UMK; derives IRK/BAK/SWK; **signs the recipe** with the IRK. | Yes — the recipe. |
| **`.com`** | Namespace **registrar** + DNS + content-blind **relay** + signature **verifier** + (future) **transparency log**. | **No.** It verifies phone signatures and records state; it never signs a recipe. |
| **Builder** | Local executor: pulls the secret-free recipe, downloads the OS, writes the USB, optionally injects secrets. | n/a |
| **Box** | **Attests** its identity (and, future, its image) so substitution/tampering is detectable. | Yes — its STK-signed daemon-status. |

**Key honesty constraint:** the phone **cannot** cryptographically verify the
builder is genuine over the channel. The builder is a *public binary*, so any
embedded "I'm real" key is extractable into a trojan. OS code-signing protects the
binary at *launch* (Gatekeeper/notarization) but is **not** observable to the
phone in-band. Therefore builder trust is a **supply-chain** decision (got it from
the right place + the OS gatekept it), reinforced by an **informed-consent**
warning at the one moment it matters (the secret hand-over) — never by "verified ✓"
theater on a SAS.

## The three delivery paths

Unifying question for the user: **"Where do you build the boot disk?"** —
presented as **two warm top-level choices**, not a three-card technical fork:

1. **Set it up yourself** → method chosen by platform:
   - **On this phone** — Android USB-OTG (the hero path: phone is trust-root *and* tool, no second device).
   - **On a computer** — the Builder app (the only self-build path on iOS; the fallback on Android when OTG is flaky or the download is too big for the phone).
2. **Have someone set it up for you** → **export the secret-free recipe as a file.**

The "someone else" path is **not** niche — "have my partner / kid / friend build
it" is common and warm. It is co-equal, not hidden.

### Path A — Phone (Android USB-OTG)
Phone writes the USB directly. Default flow needs no other device. Advanced
features (below) available via the single Advanced toggle.

### Path B — Computer (qr-on-builder session)
1. The **builder shows a QR + a short code** — this is the entry point.
2. The phone **scans the QR** (or the user **types the short code**) → establishes
   a phone↔builder session. A short confirmation code shown after the scan is the
   **SAS**: it proves *channel integrity* (no network MITM between the phone and
   the app that drew the QR) — it does **not** prove the app is the genuine builder.
3. The phone **immediately sends the secret-free recipe** (low stakes — signed,
   nothing to steal). The builder downloads the base OS and writes the USB; progress
   can mirror to the phone.
4. **Advanced → embed secrets (offline):** see the handshake + consent warning
   below. This is the only step that hands keys to the builder.

The session is long-lived by design (clean UX); the **risk is the secret-send, not
the session**. Keep the session, gate the escalation.

### Path C — Export setup file (delegated)
The phone exports the secret-free recipe as JSON for whoever is building the
server. Two audiences, **identical security**, different tone:

- **Trusted helper** (partner, friend, your own IT): you're delegating *labor*.
- **Hosting operator** (colo/managed): you're delegating *the hardware*.

Copy leads warm, not fearful:
> "Send this to whoever's building the server — a family member, a friend, or a
> hosting provider. It contains no secrets; your keys never leave your phone."

then the calm, relationship-sized caveat:
> "They'll control the hardware, so choose someone you'd trust with the machine
> itself."

**The headline property:** even when someone else builds it, **you remain the sole
key-holder.** The file is secret-free → the box comes online → *your* phone
delivers the secrets over the pinned pipe, from wherever you are. "No secrets in
the file" is the feature, not a limitation. (Edge case deferred from v1: "someone
else builds it *and* it must run offline" needs a key-holder present at first boot;
export stays secret-free in v1.)

A curated **"trusted operators" directory** is a *business program* (vetting,
endorsement, liability) — scope it separately from the cheap export feature.

## Phone↔builder secret-injection handshake (Path B advanced / offline)

1. Builder generates an **ephemeral keypair**; the QR encodes its pubkey + a nonce;
   the short code is the **SAS** over the resulting channel.
2. Phone scans → ECDH channel. The phone receiving the pubkey *optically off the
   screen* means a **remote** attacker can't sit in the middle (physical presence
   required). The SAS confirms no network MITM.
3. **Consent gate (every time, not suppressible):**
   > "You're about to send this box's secret keys to the Builder app. Send only to
   > the genuine Flagship Studio you installed from flagshipserver.com."
4. Phone encrypts the secrets to the builder's ephemeral pubkey → builder injects
   them into the USB image → **wipe the ephemeral key + tear down the channel.**

Residual risk after the optical channel excludes remote attackers: *local malware
impersonating the builder*. That is exactly the supply-chain risk the consent
warning + distribution hygiene address — and nothing a transport choice (`.com`
vs LAN) can fix, since the builder is the endpoint either way.

## The single "Advanced mode" toggle

Both the phone-OTG flow and the computer builder expose **one** "Advanced mode"
toggle — **off by default**, labelled plainly *"for people who know what they're
doing."* It gates exactly these power-user features:

1. **Choose your own ISO** — bring your own base image instead of the blessed manifest.
2. **Embed secrets for offline install** — bake keys into the disk so the box needs
   no internet at boot. *(Unlocks the option; the actual key-send still passes the
   per-use informed-consent warning above — the toggle is not the consent.)*
3. **Debug mode** — local command-line access on the box (the console/`debug`
   bring-up path).

Rationale: these are footguns/power-tools. One clearly-labelled gate keeps the
default flow clean and safe, makes "advanced" a single mental switch, and means a
normal user never sees an ISO picker, a secrets toggle, or a shell option.

**GA note:** debug access ships at GA (owner decisions 2026-07-05 and
2026-10-16): an owner who knows what they're doing can let their own SSH key
into their server for a while. It is never on by default, and it is SSH-key
only. Specified in "Debug access" below.

## Debug access

An owner lets one SSH public key in as the box's `debug` user (passwordless
sudo) until a set time. Consent is crypto the box verifies, never a flag.

**Grant and revoke** (`packages/protocol/src/debugAccess.ts`; vectors in
`packages/protocol/test-vectors/debug-access/`, passed by TS, Swift, Kotlin and
the webapp; regenerate with `scripts/gen-debug-access-vectors.mjs`):

    flagship/debug-access/v2|<serverDomain>|<sshPublicKey>|<issuedAt>|<expiresAt>
    flagship/debug-access-revoke/v1|<serverDomain>|<issuedAt>

- `sshPublicKey` is the key normalized to `<type> <base64>` (options and comment
  dropped; the blob must decode and name the same type). Types: ssh-ed25519,
  ecdsa-sha2-nistp256/384/521, the two `sk-` FIDO types, ssh-rsa. The apps show
  the OpenSSH fingerprint (`SHA256:…`, no padding).
- `expiresAt` is after `issuedAt` and at most 7 days later. The apps offer
  1 hour, 24 hours (the default) and 7 days. Renewing is signing a new grant.
- Both are sensitive orders: the admin root on an admin-pinned box (or an
  admin device holding an admin grant the box's device book verifies); the IRK
  only on a box with no admin root pinned. Co-managers and non-admin devices
  can't sign one, and the apps don't offer it to them.
- `flagship/debug-access/v1` (no expiry, optional key, password login) is gone:
  a v1 grant is refused with "This debug access grant is from an older app."

**Box** (`packages/server-daemon/src/debugAccessGate.ts`, the only place that
lets anyone in over SSH):

- A grant is taken only if it names this box, verifies under the authority
  above, is newer than every grant and revoke taken before (`floorIssuedAt`,
  so nothing replays), is within 10 minutes of the box clock when it comes
  from a device, and hasn't ended. Refusals are sentences the apps show.
- Opening: the `debug` user gets password `*` (no password; not "locked", so
  key auth works), the key goes into the root-owned
  `/etc/flagship/debug-ssh/authorized_keys` with OpenSSH's own
  `expiry-time="…Z"` as a backstop, `/etc/sudoers.d/90-flagship-debug` gives
  passwordless sudo, and `/etc/ssh/sshd_config.d/10-flagship-debug.conf` is a
  `Match User debug` block: that key file, `AuthenticationMethods publickey`,
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`.
- Closing (at `expiresAt` by a timer plus a 30 s check, or at once on a
  revoke): key file and sudoers removed, account set to `!` and expired,
  `loginctl terminate-user debug` and `pkill -KILL -u debug`, sshd drop-in
  removed. A grant for a different key closes the old key's sessions first.
- State is `<dataDir>/debug-access.json`, written durably before access opens
  and marked `ending` before it closes, so a restart finishes a half-done
  close and never reopens an ended grant. An unreadable state file closes
  access and refuses every grant signed before it was found. The v1 gate's
  marker (`debug-access-done.json`) closes its password login on first start.
- Activity: `server.debug-access.granted`, `.renewed`, `.expired`, `.revoked`.
- server-detail carries `debugAccess: {on, expiresAt, keyFingerprint,
  grantedBy: "admin" | "owner-key", lastEnded?}`.

**Where grants come from:**

- At install: the recipe's unsigned top-level `debugGrant` sibling (a JSON
  string of `{grant, signatureHex}`, like `swkHex` / `pairingOrder`; not part of
  the signed install blob). The phone or webapp signs it at mint time when the
  owner turns on Advanced → "Debug-friendly server" and pastes a key; Studio
  (Mac, Windows, Linux) and the CLI only carry it into install-blob.json. The
  box reads it once, at first boot (it may be older than 10 minutes but must
  not have ended). The CLI never bakes the grant's key into the image.
- At runtime, from an admin device's server page:
  - `GET /api/screens/debug-access` → the view above
  - `POST /api/screens/debug-access` `{grant, signatureHex}` → `{ok, change:
    "granted"|"renewed", debugAccess}`
  - `POST /api/screens/debug-access/revoke` `{revoke, signatureHex}` → `{ok,
    change: "revoked"|"unchanged", debugAccess}`
  - refusals: `{error: "<sentence>"}` with 400/403/409/422; companion sessions
    get 403; share sessions never reach the screens API.

**Apps** (webapp, iOS, Android at parity): the server page has "Debug access"
for an admin device: turn on (paste a key, pick 1 h / 24 h / 7 days, the
warning "Anyone with this key can read everything on this server while it's
on.", biometric), renew, turn off. While on, a banner reads "Debug access is
on until <time>." Other devices see the state read-only. The Activity tab
labels the four entries.

**Release guard** (`scripts/release-guard.sh`): a `DEBUG_PASSWORD` constant, a
`chpasswd` for the debug user, or `PasswordAuthentication yes` anywhere in
shipping source fails every run, dev included; so does a gate file that no
longer contains `verifyDebugAccessGrant`, `AuthenticationMethods publickey`,
`PasswordAuthentication no` and `expiry-time=`. A `useradd … debug` outside
the gate fails a release.

## Warning placement principle

Warn at **consequential, new, irreversible decisions** — handing over keys,
delegating to an operator — **not** at every theoretically-risky step.

- **Start of a builder session:** an *ambient, non-blocking* provenance cue
  ("Builder — install only from flagshipserver.com · how to verify"). **No blocking
  modal:** the trust-the-builder decision was already made at download/launch, and
  re-litigating it at connect-time only breeds fatigue and is theater for the
  image-tampering threat (a user who installed a trojan clicks "OK" anyway).
  Do **not** frame it as "connecting to a builder *as opposed to* `.com`" — there
  is no `.com` alternative for writing media; the contrast is incoherent.
- **Secret hand-over:** the explicit, every-time, non-suppressible consent modal.
- **Image tampering is defended by attestation, not prose** (next section).

## Attestation & tamper/MITM detection

The recipe's signature stops *tampering with signed fields*. The rest is detected
*after the fact*, anchored to the owner IRK that `.com` cannot forge:

- **Owner-held commitment:** at mint the phone records `hash(recipe)` + the box
  binding it expects.
- **Post-install attestation = the detection.** When the box comes online the phone
  checks its live identity/cert fingerprint (off the STK-signed daemon-status,
  which it already pins) against the commitment. Substituted hardware, a MITM'd
  registration, or a swapped box → the live identity won't match → **detected**
  (the authorized box never appears, or a mismatch fires).
- **Human SAS (reuse the NFC LED-SAS work):** the phone shows a short fingerprint
  of the recipe + expected box identity; the owner compares it to the box's own
  (apex page / a "verify this server" screen) — works fully out-of-band.
- **`.com` transparency receipt:** when `.com` produces/relays the boot media, it
  returns a signed "served blob H at T" receipt and logs it CT-style (mirrors the
  existing CAA + CT cert-monitoring) → detect a rogue `.com` that swapped the blob.

**Future hardening (not v1):** *image-measurement attestation* — reproducible OS
builds + the box measuring its own boot image hash and reporting it for the phone
to check against the expected manifest. This is the **only** defense against a
malicious builder that writes your *real* signed recipe but **backdoors the OS
image** (box attests as "yours" but is trojaned). The natural extension of the
identity attestation above; the honest ceiling on the builder-trust problem.

## The frontpage QR

Out of the burn loop entirely. Its one honest job is a **desktop → phone bridge**
("viewing on a computer? scan to install the app on your phone"). Keep it because
it looks good; make the payload a **plain short URL** (→ `flagshipserver.com`
today; device-detect to the App Store / Play once those exist) — **never a
recipe**, so there is nothing sensitive in it and it stays future-proof. The real
high-value QR is later: a **retail-packaging deep-link** that opens the app into
"set up this hardware" (`feat/retail`).

## Limits, stated plainly

- You **cannot prevent** a physically-controlling installer from extracting secrets
  present at boot. Mitigation: minimize secrets in the handed-off artifact
  (secret-free default) + attest.
- You **cannot cryptographically verify** the builder is genuine over the channel.
  Mitigation: informed consent + distribution hygiene + (future) image attestation.
- **Detect, narrow, verify — not prevent.**

## Build sequencing & open decisions

**Near-term, implementable now (and partly done):**
- *Secret-free recipe* — the SWK is already deterministic + the recipe-sibling
  plumbing exists; finishing the move means delivering disk-key/SWK/pairing
  phone→box post-attestation instead of embedding, and dropping the unsigned
  secret siblings from the default recipe.
- The **single Advanced-mode toggle** gating ISO-pick / embed-secrets / debug.

**Later / sequenced after the online happy-path is proven:**
- The phone↔builder session + QR-matched secret-injection (Path B advanced).
- Android USB-OTG burning (Path A).
- Export-file path + delegated-build UX (Path C).
- `.com` transparency receipt; image-measurement attestation.

**Open decisions:**
1. **Recipe→builder transport:** `.com` relay under a short code (works across
   networks, one infra piece, recipe is secret-free so `.com` stays blind) **vs**
   same-LAN discovery (fully sovereign, no `.com` hop). Lean: relay as default,
   LAN as the offline-purist option — it mirrors the secrets question one level
   down (convenient-relay vs fully-local).
2. **Trusted-operator directory** — ship the export *feature* now; treat the
   *directory* as a separate business decision.
3. **Sovereign axis vs trustless-remote-install axis** — these pull opposite ways
   (offline/home-build wants secrets-in-USB; datacenter-hand-off wants
   detached-secrets). Resolved by *modes*, not a global choice: secret-free is the
   default; embed-secrets is an Advanced opt-in for self-build; export is always
   secret-free. Optimize the **kitchen-table / sovereign** story first.
