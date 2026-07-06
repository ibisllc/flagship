# Box recipe persistence & restore — design memo

Status: workspace design doc (uncommitted scaffolding; not user-facing, not a
product spec). Author: research pass, 2026-06-23. Repo state: local `main`
≈ `2f480ce6`.

## The question

USB install media are disposable (and not even wiped after install — there's an
open TODO to format them). So "reburn a replacement box and restore its data"
only works if the phone can reproduce a **valid recipe (install-blob)** for that
server later — either by having KEPT it, or by REGENERATING it from recoverable
inputs. Does the phone keep/regenerate the recipe today? If not, how could it,
what are the risks, and should the recipe (or its regeneration inputs) be shared
across the owner's admin phones?

The short answer: **no phone keeps the recipe verbatim, and that's fine — the
recipe is almost entirely regenerable from (recovered UMK + `.com` account
state), and the data-restore guarantee does not depend on the recipe at all.**
The premise that "restore needs the phone to keep the recipe" is **false** for
the data, and only **partially true** for two non-recoverable create-time
*choices*. Details below.

---

## (a) Current state — what is persisted vs. regenerable

### The recipe and its key material (file:line evidence)

`InstallBlob` v2 (`packages/protocol/src/installBlob.ts:68-126`) is the signed
recipe. Its signed canonical bytes (`canonicalInstallBlob`,
`installBlob.ts:157-191`) commit to: `serverDomain`, `username`, `serverName`,
`phoneDelegatedPubKey`, `registrationUrl`, `authCode.serial`,
`authCode.userPubKey`, `authCodeUserSignature`, `installerGitRef`, `rckPubKey`,
and the optional `bootUnlockMode` / `diskEncryption` (`de=` suffix). It is signed
by the owner IRK (`signInstallBlob`, `installBlob.ts:236`).

Two **UNSIGNED siblings** ride alongside the signed blob in the on-wire JSON (not
in canonical bytes, so they never change a signature or the burner sha-pins):

- `pairingKeyPrivHex` — a **random** per-burn pairing keypair private half; the
  phone deposits an owner-IRK-signed `add-paired-session` order to `.com` sealed
  to its public half, and the booting box claims it (create-time pairing,
  2026-06-19).
- `swkHex` — `deriveSWK(umk, serverId)` =
  `HKDF-SHA256(umk.seed, "flagship.swk.v1|<serverId>", 32)`
  (`packages/protocol/src/keys.ts:107-109`). **Deterministic** from the UMK +
  serverId. The phone provisions it so the box's build/service platform and
  peer-backup come up (2026-06-23). Quoted from `Keystore.swift` (~line 223):

  > The box's Service Workload Key (SWK) as lowercase hex — the deterministic
  > `HKDF-SHA256(UMK seed, info="flagship.swk.v1|<serverId>")` ... the phone
  > provisions it at create-time as an UNSIGNED `swkHex` recipe sibling.

### What each client persists after mint

All three clients construct the recipe in memory, seal it over the QR relay (or
let the webapp user download it as a `.json`), and **discard it**. None keeps the
recipe bytes for later reuse, and there is **no "regenerate recipe" / "reburn" /
"restore box" code path distinct from create-new-server** on any surface.

- **iOS** (`CreateServerViewModel.swift`): recipe bytes, `pairingKeyPrivHex`,
  `swkHex`, RCK private key, phone-delegated keypair are all in-memory transient
  and discarded after delivery. Durably persisted to UserDefaults, scoped by
  serverDomain: **`bootUnlockMode`** (`BootUnlockStore`, ~`:210`) and
  **`diskEncryption`** (`DiskEncryptionStore`, ~`:214`). `PendingServerStore`
  (UserDefaults) keeps name/description/fqdn/authCodeSerial only *pending-until-
  boot*, cleared when `/pods` shows the box registered. Pairing session token →
  `SessionStore` (in-memory; single active slot).
- **Android** (`CreateServerScreen.kt`): same shape. Durable:
  **`bootUnlockMode`** (`ServerSettingsStore`, SharedPreferences) and the pairing
  **session token** (`EncryptedSessionStore`). `diskEncryption` is in-memory
  during the create flow only; `backupPolicy` (`CreateServerDraftStore`) is
  draft-only and `reset()` after delivery. Pending metadata in `PendingServerStore`
  (shared). Recipe bytes / `pairingKeyPrivHex` / `swkHex`: not persisted.
- **Webapp** (`create-server.js`, `keystore.js`, `lib/buildDraft.js`): IndexedDB
  `buildDrafts` keeps `serverName`, `backupPolicy`, **`diskEncryption`**, the
  authcode `code`, and a status flag (`draft`→`delivered`) — draft-grade, for UI
  resume, not a restore artifact. The full recipe (incl. `pairingKeyPrivHex` +
  `swkHex`) is only ever **downloaded to the user's disk as a `.json`** via
  `enableRecipeDownload` (`create-server.js:~444`); it is never stored in
  IndexedDB. `bootUnlockMode` is read from the radio at mint and not persisted.

Net: the only **durable, restore-relevant** create-time state any client keeps is
`bootUnlockMode` (iOS, Android) and `diskEncryption` (iOS, webapp) — and even
that is per-device, per-surface, inconsistent, and not synced across the owner's
phones.

### What `.com` durably stores (the regeneration substrate)

`.com` (D1) holds per-server, per-account records that cover most recipe fields:

| Table (migration) | Relevant columns |
|---|---|
| `servers` (`0001`) | `server_domain`, `username`, `identity_pubkey_hex` (box STK), `registered_at`, `revoked_at` |
| `auth_codes` (`0001`) | `serial`, `username`, `server_name`, `server_domain`, `delegated_pubkey_hex`, `user_pubkey_hex` (= owner IRK), `user_signature_hex`, `issued_at`, `expires_at`, `status` |
| `routing` (`0002`) | `subdomain`, `username`, **`rck_pubkey_hex`**, `current_target_hex` |
| `usernames` (`0001`/`0058`) | `username`, `irk_pub_hex`, `claimed_at`, `last_active` |
| `sealed_luks_keys` (`0004`) / `box_sealed_leases` (`0037`) | LUKS key **sealed** to BAK/owner-IRK or box STK (`.com` cannot read) |
| `webauthn_recovery_records` (`0009`/`0013`) | **`wrapped_umk_b64`** — UMK ciphertext, sealed to WebAuthn-PRF + Argon2id gate; the cloud-recovery substrate |

The UMK itself is recoverable via cloud recovery (passkey-PRF unwrap +
passphrase-gated fetch token). `serverId` is the stable per-server identifier the
SWK/BAK/IRK derivations key on; it is recoverable because `serverDomain` (and the
server record) is stored.

### Regenerable vs. lost — per recipe field

| Recipe field | Source | Regenerable? |
|---|---|---|
| `serverDomain` | `servers.server_domain` | ✅ from `.com` |
| `username` | `usernames` / `servers` | ✅ from `.com` |
| `serverName` (display) | `auth_codes.server_name` | ✅ from `.com` |
| owner IRK / `authCode.userPubKey` | `deriveIRK(recovered UMK)` (`keys.ts:36`) | ✅ deterministic |
| `authCodeUserSignature` | re-sign with recovered IRK | ✅ (re-mint a fresh authcode) |
| `rckPubKey` | `routing.rck_pubkey_hex` **or** re-derive | ✅ from `.com` (also phone-held) |
| `phoneDelegatedPubKey` | random per-burn; private half discarded | ⚠️ mint a fresh one (it's a fresh keypair each burn anyway — no continuity needed) |
| `pairingKeyPrivHex` | random per-burn | ⚠️ mint fresh (random by design; not a continuity input) |
| **`swkHex`** | `deriveSWK(recovered UMK, serverId)` | ✅ **deterministic — this is the load-bearing one** |
| disk key sealing | `deriveBAK(umk, serverId)` (`keys.ts:103`) | ✅ deterministic |
| `installerGitRef` | not stored by `.com`; defaulted | ⚠️ default to `main`/current tag |
| **`bootUnlockMode`** | not in `.com`; only client-local | ❌ **lost unless the phone kept it / it's re-chosen** |
| **`diskEncryption`** | not in `.com`; only client-local | ❌ **lost unless the phone kept it / it's re-chosen** |

The two genuinely-non-recoverable items are the create-time **choices**:
`bootUnlockMode` (`auto`/`approve`) and `diskEncryption` (`luks`/`none`). They
are signed-into the recipe (so a relay can't downgrade them in transit) but
**never transit `.com` in plaintext and are not stored there** — only client-
local, per-device, per-surface, un-synced. `installerGitRef` is a soft loss
(safe default exists).

---

## (b) Is the owner's premise true?

**Mostly no.** "Restore needs the phone to keep the recipe" conflates two things:

1. **Restoring the box's DATA** does not need the recipe at all. Peer-backup
   chunks are sealed with `encryptChunk(content, swk)` /
   `decryptChunk(chunk, swk)` (`encryption.ts:16,25`; used at
   `backupLoop.ts:78`), and **SWK is the only key**. SWK is deterministic from
   the recovered UMK + serverId. So a replacement box that comes up with the same
   SWK re-derived from the recovered UMK can decrypt the existing peer-backup —
   no kept recipe required. The daemon's own boot comment makes this explicit:
   it refuses to mint a random fallback SWK precisely because that would seal
   data "under a key nothing can ever reproduce, silently breaking the recovery
   guarantee the deterministic deriveSWK exists to provide"
   (`index.ts:430-444`).

2. **Producing a recipe to reburn the replacement box** does not need the *old*
   recipe either — it needs a *valid* recipe, and a fresh one minted from the
   recovered UMK + `.com` state is valid (and yields the **byte-identical SWK
   and BAK** because those derive deterministically from `(umk, serverId)`).
   `phoneDelegatedPubKey`, `pairingKeyPrivHex`, the RCK keypair, and the authcode
   are random/fresh on *every* burn already, so there is nothing to "keep" there.

So the owner's worry — that disposable USBs strand a box because the recipe is
gone — is unfounded for everything that derives from the UMK or lives in `.com`.
The premise is **true only in the narrow sense** that the two create-time
*policy choices* (`bootUnlockMode`, `diskEncryption`) are not recoverable from
the UMK or `.com`, so a from-scratch regeneration would silently re-default them
(to `auto` / `luks`) unless the phone kept them or the owner re-chose. Re-
defaulting `diskEncryption` to `luks` when the box was originally `none` would
brick a Wi-Fi-only box that can't reach the network at unlock; re-defaulting
`bootUnlockMode` to `auto` when the box was `approve` would silently *weaken*
the security posture. Those are the only real gaps.

---

## (c) Options for recipe persistence / regeneration + multi-admin sharing

The design space is three points on a spectrum from "share nothing" to "share
everything," plus the orthogonal question of *what* to share.

### Option 1 — Share nothing; pure regeneration (recommended core)

Add a **"Reburn a replacement box"** flow distinct from create-new-server. Given
the recovered UMK and the existing `.com` records for `serverDomain`, it
re-mints a fresh recipe: re-derives IRK/SWK/BAK from `(umk, serverId)`, mints a
fresh authcode + delegated key + pairing key + RCK (or reuses the stored
`routing.rck_pubkey_hex`), and reseals the disk key to the IRK. Nothing extra is
stored or shared.

- **Pros:** zero new secret-at-rest; no new shared takeover credential; works
  from any device that can recover the UMK; the data layer "just works" because
  SWK is identical.
- **Cons:** loses `bootUnlockMode` / `diskEncryption` (re-defaulted) — a
  security/usability footgun (see (b)). Needs a new client flow + the `.com` read
  path to enumerate a user's servers for re-mint.
- **Risk:** the silent policy re-default. Mitigated by Option 2.

### Option 2 — Share only the LOST choices, sealed under the UMK via `.com`

Persist the two non-recoverable create-time choices (`bootUnlockMode`,
`diskEncryption`, plus `installerGitRef` for completeness) as a tiny
**per-server policy record**, sealed under a UMK-derived key (e.g.
`deriveHouseholdKey(umk)`, `keys.ts:99`, already used for content-blind
owner-readable bundles) and stored on `.com` as ciphertext. `.com` stays
content-blind; any of the owner's devices that can recover the UMK can read it.
Combine with Option 1: regeneration now reproduces the *exact* original recipe
(choices included), not a re-defaulted one.

- **Pros:** closes the only real gap; the stored blob is **not** a takeover
  credential (it carries no disk key, no SWK, no IRK — just two enum choices);
  content-blind to `.com`; trivially shareable across all the owner's phones
  because it rides the same UMK every device already has.
- **Cons:** one more small sealed record + the seal/store/fetch plumbing; a
  new write at create-time and update on policy change.
- **Risk:** minimal. Worst case if the ciphertext is lost: fall back to Option 1
  re-defaults. The choices are low-sensitivity (knowing a box is `approve`-mode
  leaks little; the seal is belt-and-suspenders).

### Option 3 — Share the full recipe across phones

Persist/share the entire recipe (or its `swkHex` + sealed-disk-key siblings).

- **Pros:** the replacement box can be reburned with byte-identical material
  with zero re-derivation.
- **Cons / risk — this is the dangerous one.** A full recipe is effectively a
  **box-takeover credential**: it carries the disk key sealed to the IRK and the
  SWK (which decrypts all peer-backup data). Storing it durably or syncing it
  across devices widens the blast radius of any single compromised phone or any
  `.com` breach of the transport. It buys nothing that Option 1 + Option 2 don't
  already buy (SWK/BAK are reproducible; the random siblings don't need
  continuity). **Not recommended.**

### Transport for any cross-phone sharing

The existing cross-device rails already move the **highest-value secret there is
— the UMK seed itself** — out-of-band: `crossDevicePairing.js` (admin shows a
QR, SAS-verifies, then AEAD-seals `{ umkSeed, admit, admitSig }` over the QrRelay
to the incoming device, which persists it under a new profile and joins
quarantined for 14 days). The `secret_mailbox` lanes (`0037`) provide blind
store-and-forward sealed to a recipient key; `deriveHouseholdKey` provides a
UMK-derived AEAD key every device can independently compute. So:

- **Any admin phone that has joined via `crossDevicePairing` already has the
  UMK**, and therefore can already independently re-derive SWK/BAK/IRK and
  regenerate a recipe. **No recipe sharing is needed for multi-admin** — sharing
  the UMK (which the rail already does) subsumes it. This is the key insight: the
  multi-admin question mostly answers itself.
- The Option-2 policy record can ride `secret_mailbox` (sealed to household key)
  or simply be a content-blind `.com` row keyed by serverDomain, readable by any
  UMK-holder.

---

## (d) USB-wipe-after-install recommendation

Today the recipe lands on the **installed disk** at `/var/flagship/install-blob.json`
(`userdata.ts:297`, `late-command.sh:79`) with a second copy at
`/boot/install-blob.json` (`late-command.sh:89`). The USB stick itself is never
written back to — curtin/partman install to the *target* disk; the trailer on the
USB is read-only during install (`preseed.cfg:117-122`). So "USBs are disposable"
is accurate: nothing on the box depends on the USB after install, and the USB is
simply left as-is (the open TODO to format/wipe it is a hygiene item, not a
correctness one).

The `/boot/install-blob.json` copy carries `pairingKeyPrivHex` in plaintext until
first-boot consume. The daemon consume-once's the pairing **deposit** server-side
(`consumePendingPairing`, `index.ts:241,695`) and the entitlement deposit, but it
**does not delete `/boot/install-blob.json` after a confirmed install** — there
is no `rm`/`unlink` of it anywhere (grep-confirmed). The pairing key becomes inert
once the deposit is consumed, but the file lingers.

**Recommendation:**

1. **Wipe the recipe's secret sibling after confirmed consume.** After the daemon
   successfully consumes the pairing deposit and persists the SWK, have it
   either delete `pairingKeyPrivHex` from the on-disk JSON or remove the
   `/boot/install-blob.json` copy entirely (keep `/var/flagship/install-blob.json`
   for the fields the daemon re-reads at every boot — serverDomain, owner IRK for
   entitlement self-heal, SWK fallback). This removes the only time-bounded
   plaintext-key exposure. Low risk: the value is already inert post-consume.
2. **Wiping the USB is safe and orthogonal to restore.** Because the box keeps no
   dependency on the USB and a replacement box is reburned from a *regenerated*
   recipe (not the old USB), formatting the USB after a confirmed install costs
   nothing for restore. Gate it on a *confirmed* install (box registered /
   first-boot beacon), not mid-install, so a boot that fails partway can re-run
   from the same media.
3. **Do not rely on the USB or `/boot` copy as the restore artifact** — it is
   neither durable nor sufficient (it's pre-consume, single-box, and the SWK in
   it is reproducible anyway). The restore artifact is the UMK + `.com` state.

Caveat: the only thing a wipe/consume-delete must respect is the **re-run
needs** of a half-finished install. Keep the install-blob on the installed
`/boot`+`/var` until the box has registered at least once; wipe the *USB* and
strip the pairing key from `/boot` only after that confirmation.

---

## (e) Recommended direction + open questions

### Recommendation

**Option 1 + Option 2, never Option 3.** Concretely:

1. Build a **"Reburn / restore a box"** client flow (all three surfaces) that, from
   a recovered UMK + the server's `.com` record, regenerates a fresh valid recipe
   with byte-identical SWK/BAK. This is the actual fix for the owner's concern and
   it makes USB disposability genuinely safe.
2. Persist the two non-recoverable create-time **choices** (`bootUnlockMode`,
   `diskEncryption`, + `installerGitRef`) as a small **content-blind, UMK-sealed
   per-server policy record on `.com`** so regeneration reproduces the original
   posture instead of silently re-defaulting (the one real correctness gap). This
   record is *not* a takeover credential and is safe to share across all the
   owner's phones by construction (it rides the UMK every device already holds).
3. **Do not share the full recipe across phones.** Multi-admin is already solved
   by `crossDevicePairing` sharing the UMK; any UMK-holder can regenerate. Sharing
   the recipe/SWK/sealed-disk-key adds takeover-credential blast radius for no
   benefit.
4. **USB/boot hygiene:** strip `pairingKeyPrivHex` from `/boot/install-blob.json`
   (or delete that copy) after confirmed consume; allow USB format after confirmed
   install. Gate both on registration so partial installs can re-run.

### Open questions for the owner

1. **Policy-record sealing key:** `deriveHouseholdKey(umk)` (existing, content-
   blind, every-device-derivable) vs. a new dedicated info string? The household
   key is the natural fit.
2. **Where to store the policy record:** a new content-blind `.com` row keyed by
   serverDomain, or a `secret_mailbox` lane? A plain row is simpler and these are
   long-lived (not consume-once).
3. **Should regeneration reuse the stored `routing.rck_pubkey_hex`** (preserve
   routing continuity / failover authority) or mint a fresh RCK on reburn? Reusing
   preserves the routing record; minting fresh is cleaner but needs a routing
   re-point. (This is the one field that is both `.com`-stored *and* phone-
   derivable, so there's a choice.)
4. **Disk-key continuity on reburn:** re-seal from the recovered UMK/IRK (clean,
   no `.com` dependency) vs. reuse `sealed_luks_keys`/`box_sealed_leases`? Re-seal
   from UMK is the robust path and matches the existing "seal to IRK" decision.
5. **Multi-admin trust:** is a quarantined second admin phone (14-day window,
   already enforced by `crossDevicePairing`) allowed to reburn a box during
   quarantine, or only after? A reburn is a high-authority act; gating it on
   quarantine-elapsed may be desirable.
6. **USB format UX:** auto-format on confirmed install, or just surface a "this
   stick is safe to reuse/wipe" prompt? Auto-format is friendlier but destroys a
   user's stick without asking.
