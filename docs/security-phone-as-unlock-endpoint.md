# Security proposal: the phone as a tunnel endpoint for boot-time secrets

Status: proposal / RFC. Supersedes the plaintext-relay LUKS unlock and the
self-signed-entitlement interim.

## 1. Problem

Boot-time secrets currently pass through `.com` in the clear:

- **LUKS unlock** — at boot, `boot-stage.sh` calls `POST /unlock-key/consume`
  and gets back `{ unlockKey: "<hex>" }` *plaintext*, fed straight to
  `cryptsetup luksOpen`. To produce that, the phone unseals the key and
  **deposits the plaintext to `.com`**, which relays it one-shot to the box.
  So `.com` sees the disk key for that window — weaker than the platform's
  "flagship.services literally cannot read user content."
- **Entitlement** — the builder box currently *self-signs* its admission
  credential because the user's IRK (which should sign it) lives only on the
  phone, and there's no channel for the phone to sign the box's freshly-minted
  STK at first boot.

Both gaps have the same root cause: **there is no direct, authenticated,
end-to-end channel between the booting server and the user's phone.**

## 2. Proposal in one sentence

`.com` becomes a **blind store-and-forward relay**: the booting box and the
user's phone exchange **sealed + signed** messages through a per-user mailbox on
`.com`, with **APNs/FCM** waking the phone. The box never talks to the phone
directly and **the phone hosts nothing** — it is a push-woken HTTPS client that
does crypto. `.com` sees only ciphertext (the secret, sealed for the box's STK)
and signed-but-public blobs (the request, the entitlement); it can *withhold* (a
DoS) but never *read* or *forge*. The security is the **sealing + signing + the
keys baked into the ISO blob**, not the transport — so we drop the live tunnel
at no cost.

> **Design note (supersedes an earlier draft):** an earlier version of this doc
> had the phone *host* a transient tunnel endpoint (`device.<username>`) that the
> box `GET`s. That's unnecessary — if the phone is only signing/sealing, a blind
> `.com` relay woken by push is cryptographically equivalent and far simpler (no
> hub routing for the phone, no `device.<username>` DNS, no WSS server on the
> phone, no `irkLookup` for a phone endpoint). This doc now specifies the relay.

This reuses what already exists: the InstallBlob's baked keys (the box knows the
phone's pubkey; the phone learns the box's STK), `sealForRecipient`, the push
fan-out, the single-use auth-code, and the directory `.com` already keeps.

## 3. Trust anchors (what is known a priori, before any network call)

1. **The ISO blob (baked at burn time).** The `InstallBlob` carries the
   phone's delegated pubkey, the user's IRK pubkey, and a **single-use,
   IRK-signed auth-code**. Consequence: the **server can authenticate the
   phone** (verify responses against the baked phone pubkey) and can **prove it
   holds a user-authorized blob**.
2. **APNs.** `.com` can wake the user's devices ("open the app to finish
   installing <server>"). A *liveness* signal, never a secret carrier.
3. **`.com` as directory.** First-boot registration is authenticated by the
   single-use auth-code, so `.com` binds the box's freshly-generated **STK**
   (server identity key) to the user. The phone can ask `.com`, over its own
   authenticated channel, "which STK registered with my auth-code?" — i.e. "who
   is my box."

Crucially, **the secret itself rides none of these** — the blob carries no disk
key (the key is generated on the box), APNs carries no key, and `.com` only
ever holds the *sealed* copy.

## 4. The handshake (relayed, store-and-forward; LUKS unlock — entitlement is identical with a sign instead of an unseal)

```
0. (burn)      phone mints InstallBlob {phone pubkey, IRK-signed single-use auth-code}
               → user burns it into the ISO → installs it into THE box in their hand.
1. (first boot) box generates STK; registers with .com presenting the auth-code
               (single-use → CONSUMED → "recipe used forever"; no second box can bind).
               .com binds STK → user and records device-info (ip/region/os). Disk is
               LUKS-encrypted, key sealed-for-phone, parked on .com (unreadable by .com).
2. box posts a SecretRequest {serverDomain, stkPub, purpose, nonce} (STK-signed) to its
               mailbox on .com. .com pushes the phone (APNs/FCM): "your box <device-info>
               is finishing setup — open the app." (The small signed request may ride in
               the push; the phone also fetches pending requests from .com on open as the
               reliable path.)
3. user opens app → app fetches the pending SecretRequest(s) from its mailbox, then:
     a. shows the box's device-info for a one-tap "Yes, this is my box" (the human is
        the backstop against a rogue box / a lying directory);
     b. unlock-key: unseals the LUKS key (only the phone can) and RE-SEALS it for stkPub,
        bound to the request nonce → SealedSecretResponse;
        entitlement: signs a RootEntitlement binding (username, stkPub, podCanonical)
        with the user IRK;
     c. posts the sealed/signed reply back to .com.
4. box polls its mailbox, gets the reply, verifies it came from the phone (against the
               phone pubkey baked in the blob), unseals with its STK private key →
               luksOpen / installs the entitlement → shreds plaintext.
               .com saw only ciphertext + public signed blobs the entire time.
```

`.com` is a **blind mailbox**: it stores the box-posted request, fires the push,
stores the phone-posted reply, and serves it back to the box. It can drop or
withhold (a DoS) but the request is STK-signed, the reply is sealed for the STK
and verified by the box against the *baked* phone key — so `.com` can neither
read nor forge. No tunnel, no hub, no phone-hosted endpoint.

## 5. Threat model

| Threat | Defense |
|---|---|
| **Network MITM** (box ↔ hub ↔ phone) | Secret is sealed for the STK end-to-end; mutual *app-layer* auth (box signs with STK; phone authenticated via the baked pubkey + the IRK-claimed endpoint). TLS is defense-in-depth, not the trust root. A MITM sees only ciphertext and can impersonate neither side. |
| **Rogue box** claiming to be the user's server | To register + bind an STK you must present the single-use, IRK-signed auth-code from the blob. No blob → no binding → the phone won't seal for you. The phone seals only for the **directory-bound** STK, after the user's visual confirm. |
| **Recipe/blob theft before first use** (the one real residual) | Short auth-code TTL (~24h), single-use, user-controlled delivery (copy-paste preferred). A registration race is *visible*: the user sees an unexpected box's device-info at the confirm step ("that's not my box / wrong location") and `.com` can alert "a box already registered." Mitigated, not eliminated — §7. |
| **Phone impersonation** (feed the box a malicious key) | The box verifies every reply against the phone pubkey **baked into the blob**; a relay (or anyone) cannot forge a phone signature it doesn't hold. |
| **Replay** | Fresh nonce per request; the sealed response is bound to the nonce + STK. |
| **`.com` compromise** | `.com` never sees plaintext (sealed end-to-end). Worst case it can mis-route / withhold (a *DoS*, not a confidentiality break) or *lie* about the directory STK — caught by (a) the box authenticating the phone independently of `.com` and (b) the user's visual device-info confirm. |
| **Headless box can't be eyeballed** | Direction is reversed on purpose: the **phone verifies the box** (device-info + STK binding) and the **human confirms on the phone**; the box trusts the phone via the baked pubkey. No screen on the box is needed. |

## 6. Why "I burned the ISO myself" is (almost) enough

Possession of the single-use, IRK-signed auth-code *is* the proof: only someone
holding the blob you created can register a box that `.com` will bind to your
account, and you put that blob into the box in your hand. The auth-code's
single-use + short TTL means the legitimate first-boot consumes it; a second
attempt fails and is visible. HTTPS is genuinely just hardening on top — the
real authentication is the app-layer crypto (STK signatures + sealed-for-STK +
the baked phone key), which holds even if the transport were fully observed.

The honest gap is the **window between minting the recipe and the box consuming
it** (§7). The visual device-info confirm at unlock time is the human backstop.

## 7. Residual risks / open questions (decide these)

1. **Phone offline / user ignores the alert.** Boot blocks on the disk key.
   Need a bounded wait + a fallback: a **box-sealed auto-unlock lease** (§7a)
   covers unattended reboots without exposing the key to `.com`; first boot
   should always require the phone. Define the timeout and the retry/notify
   cadence.
2. **No box cert at unlock time.** The disk is locked and the daemon (LE cert)
   isn't up yet, so the unlock channel rides the *hub's* TLS, not the box's. The
   security is the app-layer sealing, not the transport cert — acceptable, but
   state it explicitly.
3. **Recipe-interception window** — the only real confidentiality gap. Options:
   shorten TTL further; bind the auth-code to a device-attestation; *require*
   the device-info confirm before the first unlock always; alert on a second
   registration attempt for a name.
4. **TOFU binding.** STK→user is trust-on-first-registration. Mandate the
   one-tap confirm on first unlock (not skippable) so a race is always caught.
5. **Endpoint naming + multi-device.** Devices are not addressable by name,
   so `<deviceLabel>.<username>` is off the table; the open question is only
   which device answers when the user has several, and how the box discovers
   the right endpoint (likely: `.com` directory returns the user's
   currently-claimable endpoint).

## 7a. Unattended reboot without trusting `.com` — the rogue-operator bound

Unattended reboot (no phone present) and "`.com` can read the key" are
**independent** axes, and we keep them independent.

**Box-sealed lease.** A long-lived auto-unlock lease stores the key on `.com`
**sealed for the box's STK**, never in plaintext. On reboot the box pulls the
sealed blob and unseals it itself with its STK private key (kept on the
unencrypted `/boot`, since crypto must run before the encrypted root opens).
`.com` holds ciphertext only — on the lease path exactly as on the phone-gated
path. (Today's lease deposits *plaintext*; eliminating that is the concrete
fix this proposal mandates.) The recipient STK is **pinned at lease creation**
(below); `.com` cannot retarget it.

**Three adversaries, kept separate:**

| Adversary | Defended by |
|---|---|
| `.com` honest-but-curious / breached — incl. a **rogue operator** | box-sealing → `.com` never sees plaintext, on *either* path |
| Disk-copy thief / infra-host offline snapshot | LUKS at rest |
| Whole-box thief (has `/boot` + network) | *only* phone-gated unlock (no long-lived lease) — the thief lacks the phone |

**Rogue-operator invariants — MUST hold on every path:**

- **I1 — no plaintext at `.com`.** The unlock key is only ever stored or
  relayed *sealed* for a recipient `.com` cannot impersonate (the phone, or the
  box's STK). `.com` holds plaintext on no path.
- **I2 — user-anchored recipient.** The key is sealed only for an STK the
  *user* has confirmed (the device-info "is this my box?" tap), pinned at lease
  creation — never an STK `.com` asserts on its own. A rogue operator therefore
  cannot redirect the seal to a box they control, even by poisoning the
  directory.
- **I3 — `.com` is gate/router/push only.** It can route, gate release, and
  push; it can therefore *withhold* (a DoS) but can never *read* or *retarget*
  the key.

**Consequence (the bound):** a rogue Flagship operator with full `.com` access
is contained to **availability** — refuse to route/release/push (a denial of
service). They can **never** read the disk key, substitute one, or redirect it
to a box they control; the data stays encrypted and unreadable to them.

The *only* way an operator obtains a key is to stop being merely an operator and
**collude with the infrastructure host to physically seize the box** (its
`/boot` STK key) — i.e. become a whole-box thief. Even then it works **only
against an opt-in long-lived lease** (a self-unlocking box can be unlocked by
whoever holds it), it is **revocable** (`DELETE …/unlock-key/lease/:id` before
they reboot it locks them out), and it is **foreclosed entirely by the
phone-gated default**. Therefore:

- **Phone-gated (default):** a rogue operator — alone *or* colluding with the
  host — never gets the key.
- **Long-lived lease (opt-in, defaults OFF):** a rogue operator *alone* still
  never gets the key (I1–I3); only operator + host collusion + physical seizure
  does, and only until you revoke. This is the deliberate, eyes-open convenience
  trade.

### 7a.1 Final product decision (2026-05-23): `bootUnlockMode`, default `auto`

Locked with the owner. The two modes are a **single choice at server creation**
(one screen), carried in `InstallBlob.bootUnlockMode` — **signed by the phone**,
so a compromised network/`.com` cannot downgrade an `approve` server to `auto`
(the field is committed to the blob signature; see `canonicalInstallBlob`).

- **`auto` — DEFAULT ("Reboots on its own").** Box-sealed lease; the box
  self-unlocks. The default because it "just works" (good for flaky power/
  connection) and because a stolen box is **revocable from the phone** (delete
  the lease → bricked on next reboot). **Honest scope (do not oversell):** this
  is `.com`-blind (I1–I3 hold) and protects a *discarded/offline* disk, but it
  is **NOT theft-proof** — a thief who powers the box (or its disk, in any
  motherboard) on a network *before you revoke* can boot it, because a box that
  can unlock itself can be unlocked by whoever holds it. Its real guarantees are
  (a) flagship.services can never read your key, and (b) the remote kill switch.
- **`approve` ("Authorize each boot") — for critical servers.** Phone-gated
  relay + biometric; **no box-openable lease exists**, so the box cannot
  self-unlock and a whole-box/disk thief cannot boot it at all. The only
  genuinely theft-proof mode. Cost: the phone must approve every boot.

UI copy MUST state `auto`'s limit plainly ("not theft-proof; revocable"). The
mode is **flippable later from the phone without re-imaging** (deposit a
box-sealed lease ⇒ `auto`; `DELETE` it ⇒ `approve`) — both ride the same disk
key. **Roadmap:** TPM measured-boot binds the `/boot` key to the hardware, which
is the only way to make *unattended* (`auto`) also resist a disk moved to other
hardware — the eventual "both". The legacy plaintext deposit/lease path is
RETIRED as a user option (strictly weaker — `.com` readable).

## 8. What this unifies

One authenticated, end-to-end, `.com`-can't-read channel then carries **every**
phone↔box handshake: LUKS unlock, entitlement signing, re-pair, STK rotation,
per-app approvals. It also dovetails with the install-alerts pipeline — the
`awaiting-entitlement` / `awaiting-unlock` phases become the APNs triggers that
bring the phone endpoint online. Build the endpoint once; the crypto handshakes
and the observability both ride it.

## 9. Implementation deltas (rough)

- **Protocol** (done, `d14432e`): `SecretRequest` (STK-signed), `SealedSecretResponse`
  (sealed for the STK, nonce/purpose-bound), box-sealed `AutoUnlockLeaseV2` +
  `LeaseRevocation`, phone-signed `RootEntitlement`. (`DeviceEndpointClaim` was
  built too; repurposed as the phone's mailbox-auth credential — there is no
  hosted endpoint.)
- **`.com`:** a per-user **sealed-message mailbox** — box `POST`s a `SecretRequest`,
  `.com` fires the push, phone `GET`s pending + `POST`s the reply, box polls for
  it; plus the directory (STK→user + device-info, from registration), the
  APNs/FCM trigger, and the box-sealed `AutoUnlockLeaseV2` store + revocation.
  Relay only — never reads/forges. **Deprecate the plaintext unlock relay** (keep
  it as a fallback until the new path is e2e-proven). *No tunnel-hub work.*
- **App (iOS/Android):** on push, fetch pending requests, show the device-info
  confirm, unseal/re-seal + IRK-sign, post the reply. A push-woken HTTPS client —
  **no WSS server, no hosted endpoint.**
- **Daemon/boot:** `boot-stage.sh` (+ the daemon's entitlement path) `POST` a
  `SecretRequest` to `.com` and poll for the box-sealed reply, unseal with the STK
  key on `/boot`. **Fall back to the existing path on timeout** (no brick).
