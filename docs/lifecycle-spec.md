# Flagship — full lifecycle build spec

This is a builder's reference. Every component named here is a place
holder for "design + implement + test"; the spec covers every screen,
button, API call, container, and wire format you'll touch from a brand
new visitor's first hit on `flagshipserver.com` to a long-lived shared
service's update propagation. Read once end-to-end before opening tickets.

> Conventions
> - **Screen** names are quoted in `[brackets]`.
> - **Buttons / fields** are `monospace`.
> - **Routes** are HTTP paths. Anything starting with `/.flagship/` is
>   intercepted by the daemon's reverse proxy (apps never see it).
> - **PhoneOrder** is the canonical-bytes signed message type from
>   `@flagship/protocol/auth.ts`.
> - **PSK** = phone signing key (delegated, baked into the install
>   trailer at server-mint time). **IRK** = identity recovery key (the
>   user's master Ed25519). **BAK** = backup-authorization key
>   (Secure-Enclave-resident; biometric-gated). **STK** = server-identity
>   key (per-box, generated at install).
>
> Skim time: ~25 min. Build time: ~6 weeks for a focused team to ship
> v1 to a public alpha (mobile is parallel work; see §11).

---

## 0. Top-level architecture (one paragraph + diagram)

```
┌────────────────────┐  HTTPS    ┌────────────────────────┐
│  flagshipserver.com│◄─────────►│    User's phone        │
│  (CF Worker + D1)  │           │  iOS / Android / PWA   │
│  IDENTITY + STATE  │           │  IRK / BAK / SWK       │
└──────┬─────────────┘           │  Trust root            │
       │ DNS01 + LUKS keys       └─────────┬──────────────┘
       │ + sealed-blob storage             │ HTTPS init only
       ▼                                   ▼
┌────────────────────┐  TCP/SNI  ┌────────────────────────┐
│  flagship.services │ passthrough│  USER'S BOX (home)     │
│  (Fly: stateless   │◄═════════►│  Alpine + LUKS         │
│   pipe + tunnel)   │  WS hub   │  daemon: TLS terminates │
└────────────────────┘           │  apps: docker per app  │
                                 │  data: PG + S3 + KV    │
                                 │  browser: 1× Chromium  │
                                 │  forgejo: app repos    │
                                 └────────────────────────┘
```

**Three planes, three trust scopes:**
- `.com` knows: usernames, server pubkeys, sealed LUKS blobs,
  per-server DNS records. Never user content.
- `.services` knows: TCP packets and tunnel WS frames.
- The user's box knows everything but only the user (via the phone)
  can authorize anything destructive.

**The phone is the trust root.** Lose the phone, recover via
iCloud-Keychain / Google Block Store-wrapped UMK + biometrics.

---

## 1. PUBLIC: landing & download (no account yet)

### Screens

#### `[Landing]` — `https://flagshipserver.com/`
- **Hero**: "Your services. Your hardware. Your keys."
- Buttons: `Download Flagship` (→ `[Download]`), `Build a server` (→ `[Build]`),
  `How it works` (anchor scroll), `Status` (→ `/status/`).
- Below the fold: trust model, BUSL note + Change Date, abuse contact.
- No account walled — pages are public.

#### `[Download]` — `https://flagshipserver.com/download`
- Tabs: **iOS**, **Android**, **Web app**.
- Each tab shows: store badge / install prompt, SHA256 of the linked
  artifact, build provenance link to a CI artifact attestation.
- The **Web app** tab is a `Add to Home Screen` PWA prompt; same UMK
  protocol as native, just stored in IndexedDB (encrypted with a
  key wrapped by WebAuthn).
- CTA: `Already installed → Pair your existing phone`.

#### `[Build]` — `https://flagshipserver.com/build/`
- Single text field: `Paste your build code`.
- On submit: sends `POST /api/build/check` with the code → renders an
  ISO download stream.
- Build code is the auth-code-blob the phone minted (§3). Single-use,
  serial validated against D1 store, expires 24h.
- Below: "What is a build code?" link → `/help/build-code`.

#### `[Status]` — `https://flagshipserver.com/status/`
- Live health for the public planes (Worker `/api/health`, Fly
  `/api/health`, services-endpoints discovery payload).
- Public — no auth.

### Backend (already built)
- Worker routes: `/`, `/download`, `/build/`, `/build/check`,
  `/status/`, `/api/health`, `/api/services/endpoints`.
- D1: `auth_codes(serial PK, body, used_at)`.
- R2: ISO base + per-build personalized trailer streamed via the
  iso-personalizer package.
- Public so visitors can audit the stack before installing anything.

---

## 2. ACCOUNT CREATION (phone-side)

### Screens (mobile app, first launch)

#### `[Welcome]`
- One screen, two buttons: `Create account` / `I already have a server`.

#### `[Choose username]`
- Text field with live availability check via `GET /api/users/check?u=<name>`.
- Rules: `[a-z0-9]{1,32}`. Username is permanent; warn explicitly.
- `Continue` → `[Biometric setup]`.

#### `[Biometric setup]`
- Phone generates UMK (32 bytes random) inside Secure Enclave / StrongBox.
- Derives IRK / BAK / SWK keypairs. None ever leave the enclave.
- Trigger Face ID / Touch ID for confirmation.
- Wraps UMK with the user's iCloud-Keychain / Google Block Store key
  for cloud-recovery (still requires biometric to unwrap on a new
  phone).

#### `[Register]`
- Phone signs `RegisterUser{username, irkPub}` with IRK.
- POST to `/api/users/register`.
- Worker stores in D1 `users(username PK, irk_pub, registered_at)`.
- Server returns `{ ok: true }`. On error (`username-taken`,
  `signature-invalid`) the screen shows a recoverable error.

#### `[Home]`
- "Welcome, harry. You don't have a server yet."
- Buttons: `Order a server` (→ `[Order]`), `Build my own` (→ `[Build with my hardware]`).

### Wire format
- `RegisterUser`: `{username, irkPub, issuedAt}` signed by IRK; canonical-bytes tag
  `flagship/register-user/v1`.
- Replay window: ±5 min.
- Already-built: §0 of `auth.ts` covers the canonical-bytes layout.

### Worker side
- New route: `POST /api/users/register` (already specced; small handler).
- D1 migration `0005_users.sql`: `users(username TEXT PRIMARY KEY,
  irk_pub_hex TEXT NOT NULL, registered_at INTEGER NOT NULL)`.

---

## 3. PROVISIONING — TWO PATHS

### Path A: Order a pre-built box from us

#### Phone screens

##### `[Order]`
- Cards: `Tiny ($199)`, `Standard ($349)`, `Pro ($699)`. Specs visible.
- Optional add-on: `+ peer-backup pool: 250GB / 500GB / 1TB`.
- `Continue → Shipping`.

##### `[Shipping]`
- Address fields. Standard form.
- Worker uses Stripe + Shippo behind the scenes; no PII stored on
  flagshipserver.com beyond what shipping requires (encrypted at rest
  in D1; admin secret protected).

##### `[Pay]`
- Stripe Elements iframe. On success, phone receives a tracking ID.

##### `[Provisioning state]`
- Live timeline: "Order received → Box assembled → Shipped → Out for delivery → Plug in".
- When box arrives, user taps `Plug in & finish setup` → `[Build code]`.

#### `[Build code]` (shared with Path B from this point)
- Phone mints an `AuthCode`:
  ```ts
  {
    version: 1,
    serial: rand128,
    username: "harry",
    serverName: "home",            // user picks
    serverDomain: "home.harry.flagship.services",
    delegatedPubKey: pskPub,        // phone-resident PSK pubkey
    userPubKey: irkPub,
    issuedAt: now(), expiresAt: now() + 24h,
  }
  ```
- IRK signs the canonical bytes.
- Phone bundles `AuthCode + signature + registrationUrl + installerGitRef +
  phoneDelegatedPubKey` into a JSON blob → renders both as **QR** and
  **20-character build code** (Base32).
- For Path A, the phone POSTs the bundled blob to a per-order
  endpoint that the box's first-boot apkovl polls (`GET /api/box/order/<orderId>/blob`)
  — the box already has a per-order pre-installed key burnt at
  assembly time, gating the lookup.
- For Path B, the user types the build code into `https://flagshipserver.com/build/`.

### Path B: Build your own (BYOH)

User has a NUC / mini-PC / SBC at home and wants to install Flagship.

#### `[Build with my hardware]` (phone)
- Form: `Server name` (default "home"), `Disk size class`, optional
  `Peer-backup share ratio` slider.
- `Generate build code` → mints the same AuthCode/blob, displays the
  build code + a "Copy" button.

#### `[Build]` (browser, on user's laptop)
- User opens `https://flagshipserver.com/build/`, pastes build code.
- Worker validates serial (must be unused, signed by registered user,
  not expired), then streams a personalized ISO:
  - Base ISO (Alpine + apkovl with bootstrap) cached in R2.
  - Personalizer appends the trailer (§4) at the end, after ISO9660 EOF.
- Browser downloads `flagship-<server>-<user>.iso`.
- **Print-and-flash** instructions on-screen: "Flash to a USB ≥ 4GB
  with balenaEtcher / Rufus / `dd`. Then plug into your box."

### Backend
- Already built: `iso-personalizer`, `installer-apkovl`, `bootkey-builder`.
- New for Path A: order pipeline in `apps/com` (Stripe + Shippo
  integration; out of scope here, treat as e-commerce 101).

---

## 4. INSTALL & FIRST BOOT

### `[At the box]` — physical UX

User plugs the USB in, powers on the box. From this moment:

1. **Alpine boots from USB.** Apkovl overlays our bootstrap script
   (`flagship-bootstrap.start`).
2. Bootstrap finds the trailer on the boot medium → validates the
   user signature locally → fetches `installer/install.sh` from
   `ibisllc/flagship` at the trailer's pinned `installerGitRef`
   over HTTPS.
3. install.sh runs (~5 min):
   - Picks a target disk (largest non-removable >8GiB).
   - Generates a 64-byte LUKS unlock key, formats `cryptsetup luksFormat`.
   - Generates STK (Ed25519) → writes priv/pub hex + boot PEM.
   - **Seals the LUKS unlock key** against the phone's delegated
     Ed25519 pubkey (Flagship sealed-box: ephemeral X25519 + AES-GCM).
   - `git clone https://github.com/ibisllc/flagship` into the
     LUKS-mounted root. Builds workspaces with `npm ci && npx tsc -b`.
   - POSTs `ServerRegisterRequest` (signed by STK + carrying the
     auth-code's user signature) to `flagshipserver.com/api/server/register`.
     Worker validates + stores in D1 `servers`.
   - POSTs the sealed LUKS blob to `/api/server/<fqdn>/sealed-luks-key`.
   - Writes OpenRC services: `flagship-data-services`,
     `flagship-boot-stage`, `flagship-daemon` (in dependency order).
   - `extlinux --install /boot && mbr.bin → target disk`.
   - `reboot`.

### Phone screen during install

#### `[Installing]`
- Live polling: `GET /api/server/<fqdn>` returns `{ phase: "registered" | "sealed" | "ready" }`.
- Updates the phone's `[Home]` to `[Server]`.

### Backend touched
- All built. The actual hot-fix this session: install.sh now uses
  the real sealed-box (not hex placeholder) and registers the
  boot-stage OpenRC service (was missing, see commit `aad4839`).

---

## 5. EVERY-BOOT: phone-mediated LUKS unlock

### Sequence (zero UI on the box; all driven from the phone in background)

```
Box powers on
  ↓
boot-stage.sh on /boot reads /boot/identity.pem
  ↓
fetches /boot/server-domain
  ↓
loops every 1s:  POST /api/server/<fqdn>/unlock-key/consume
                    signed by STK
                    body: { nonce, issuedAt }
                  Worker checks D1 unlock_key_deposits
                    (one-shot row, deleted on consume)
                  If row absent → 404, retry
                  If present → returns the unsealed key + deletes row
  ↓
boot-stage decrypts LUKS root with the returned key
  ↓
mounts root → kicks OpenRC default runlevel
  ↓
flagship-data-services (compose) → flagship-daemon (Node)
```

### Phone side — `[Approve unlock]`

When the box comes online (announced via push or by user opening
the app):

- Phone wakes the user with a push notification: "harry's home is
  starting; approve unlock?"
- Tapping it opens `[Approve unlock]`:
  - One face-ID prompt.
  - On approval, phone unseals the LUKS key locally (BAK/PSK has the
    matching X25519 priv via the standard Ed25519→X25519 conversion).
  - Phone POSTs `DepositUnlockKey{serverId, unsealedKey, ttl=10min}`
    signed by IRK to `/api/server/<fqdn>/unlock-key`.
  - Worker stores the row. Box's next consume poll succeeds.
- Daily limit: 50 unlocks per server-day. Anything past that emits a
  phone alert ("Unusual unlock pattern — security event recorded").

### Failure modes + UX
- **Box never reaches .com**: boot-stage prints a status to the local
  console only; the box is stranded. UI on phone shows "Box hasn't
  checked in for >5 min — check power & cable."
- **User never opens phone app**: box waits forever; auto-resumes once
  unlock arrives.

### Backend — already built
- `/api/server/<fqdn>/{sealed-luks-key, unlock-key, unlock-key/consume}`.
- D1: `sealed_luks_keys`, `unlock_key_deposits`.

---

## 6. DAILY USE — phone-paired browser & control panel

### One-time pairing

#### `[Pair browser]` (phone)
- User taps a button on `[Home]` → `Pair this device`.
- Phone generates a random 32-byte token (hex encoded, 64 chars).
- Phone sends `add-paired-session` PhoneOrder (PSK-signed) to
  `/api/orders-from-user`.
- Daemon's executor adds the token to its `FilePairedSessionStore`
  + flushes to disk.
- Phone displays a **QR code** linking to
  `https://home.harry.flagship.services/.flagship/pair?token=<token>`.
- User scans with the desktop browser → desktop receives a
  `flagship-session` cookie set to the token.
- Subsequent admin/UI traffic is gated on `Authorization: Flagship-Session
  <token>` (the cookie translates to that header in JS).

### Control panel — desktop

#### `[Control panel]` — `https://home.harry.flagship.services/`
- Single-page app served by the daemon's default handler when no app
  matches. Tabs:
  - **Apps** (default)
  - **Browser** — embeds `[Browser viewer]` (§9.5)
  - **Data** — embeds `[Adminer]`, `[MinIO]`, `[redis-commander]` via
    the `/.flagship/admin/*` proxy
  - **System** — server identity, certs, peer-backup status, restart,
    revoke-self.
  - **Subscribers** — per-service: who's mirroring this service's update
    packs.
- Every tab loads via the paired-session cookie → no separate login.

### Services tab — `[Services]`

```
┌──────────────────────────────────────┐
│  [+ Vibe-code a new service]         │
│  [⤓ Install someone else's]          │
├──────────────────────────────────────┤
│ ◯ habit-tracker     · running · v0.4 │
│ ◯ shopper           · running · v1.1 │
│ ◯ family-photos     · stopped · v2.3 │
└──────────────────────────────────────┘
```

Per row: name, status, version, dropdown (`Restart`, `Stop`, `Settings`,
`Share`, `Update now`, `Uninstall`).

### Per-service drawer — `[Service: habit-tracker]`

Tabs:
- **Overview**: URL, ports, members, install date.
- **Members**: list (IRK pubkey + role + display name); buttons
  `Invite`, `Remove`.
- **Browser** (only if `manifest.browser.domains` set): list of
  declared domains, "log in once" button (opens the host's actual
  Chromium tab via `[Browser viewer]`).
- **Data** (only if `data.stores`): per-store status + size.
- **Updates**: `Update policy: auto | manual | frozen`. If `manual`
  and a pending pull exists → big `Apply pending update` button.
- **Logs**: recent stdout/stderr from `docker logs`.
- **Sharing**: see §9.

---

## 7. FIRST-SERVICE DEPLOY — vibe coding with an LLM

### Screens

#### `[Vibe-code]` (phone or desktop)
1. **Pick provider**:
   - `Use Flagship promo (50 free credits / day, 200 lifetime)` — this
     is the Flagship-promo path, see §7.5.
   - `Use my own API key` — this is the BYOK path.
2. **Describe your service**: free-text textarea. Examples preset
   buttons: *Habit tracker*, *Shared family wishlist*, *Personal
   inventory*, *Sleep journal*.
3. `Generate` button.

#### `[Generating]` (live stream)
- Streaming chat-with-thinking UI shows the LLM building:
  - Plan (200 tokens)
  - `flagship.app.json` (manifest)
  - `Dockerfile`
  - Source files (top-level src/)
  - First migration (`migrations/0001_init.sql`)
- User can interject in chat to revise.
- Once the LLM emits `# DONE`, show **`Deploy`** + `Save & continue
  later`.

### What happens on `Deploy`

```
Phone bundles { manifest.json, sources[] }
  → POST to box's daemon
        /.flagship/llm-deploy/<sessionId>     [paired-session gated]
  ↓
Daemon's LLM harness:
  1. Validate manifest with `parseManifest`.
  2. Create Forgejo repo at `git/<host>/<slug>.git`,
     initial commit + tag v0.1.0.
  3. Build docker image (`docker build -t flagship/<host>-<slug>:v0.1.0`).
  4. Phone-side mints an InstallServiceRequest → POST /api/services with
     IRK sig.
  5. ServicePlatform.install:
     - Provisions data stores (RealPostgresAdmin / Redis / MinIO).
     - Mints FLAGSHIP_APP_TOKEN.
     - Deploys container.
     - Adds host as `owner` in the membership store.
     - Records initial ServicePullState (canonical-home is THIS box).
  6. Daemon emits 'service-deployed' event → phone shows the URL.
```

### `[Service URL ready]`
- "https://habit-tracker.home.harry.flagship.services" big text + copy.
- Buttons: `Open it`, `Share with someone`, `Generate another revision`.

---

## 7.5. LLM KEY MANAGEMENT — BYOK vs Flagship-promo

This is its own section because the security model is delicate.

### Path A: BYOK (bring your own key)

#### `[Settings → AI provider]`
- Provider dropdown: `Anthropic`, `OpenAI`, `Google`, `Custom`.
- API key text field (masked, never logged).
- `Test` button → daemon makes a tiny request to the provider; success
  → key is saved.

#### Where the key lives
- Phone wraps the API key with SWK-derived encryption (`sealLlmPayload` from
  `@flagship/protocol/encryption.ts`).
- Phone POSTs the wrapped blob via PSK-signed PhoneOrder
  (`set-llm-key` — TODO new variant) to the box.
- Daemon stores at `<dataDir>/llm-keys/<provider>.sealed.bin` (mode 600).
- Daemon's LLM harness derives the same key (also has SWK), unwraps,
  uses it.
- **flagshipserver.com never sees the key.**

#### Limits
- BYOK has no Flagship-imposed limits. The provider's own rate limits
  apply.

### Path B: Flagship-promo

#### Constraints
- **Fixed daily / lifetime cap per Flagship account.** Defaults:
  `50 calls/day, 200 lifetime, 1000 input tokens / 500 output tokens
  per call`. Configurable from the Worker.
- **No proxy.** Flagship issues a one-shot, scoped LLM key directly
  from its own Anthropic / OpenAI account, **the box uses it directly**,
  and the .com tracks usage via webhooks from the provider.
- **Privacy claim**: prompts go from box → provider, never through .com.
  But prompts ARE seen by the third-party provider (this is an
  honesty disclosure on the screen).

#### Phone screen `[Use Flagship promo]`
- Status bar: `Today: 12 / 50 calls · Lifetime: 47 / 200`.
- Big card explaining: "Flagship pays for these calls. Your prompts
  go directly to the provider. Cap raises to 100/day after you list
  your first app to the marketplace."
- `Use my own key instead` link.
- Button: `Activate promo` → mints scoped key, stored on box exactly
  like BYOK.

#### Backend
- Worker route `POST /api/llm-promo/issue` with IRK-signed body.
  Worker calls the provider's API to mint a scoped key (Anthropic
  has scoped keys; OpenAI has time-bounded org keys).
- D1 `llm_promo_usage(user_id, day, count, lifetime_count)` updated
  via the provider's billing webhook.
- When daily limit hit → next /issue returns 429 + `{retryAt: <ms>}`.

#### Switching modes
- `[Settings → AI provider]` shows current provider + a `Switch`
  button. Switching:
  - Frees the box of the old key (deletes file).
  - Triggers a fresh `set-llm-key` flow.
  - Audit logged on the phone.

### Tier escalation
- `[Settings]` shows a "Tier" widget:
  - **Free**: 50/200, only 1 vibe-coded service at a time.
  - **Hobby ($5/mo)**: 100/1000, up to 5 apps, 5GB peer-backup.
  - **Maker ($15/mo)**: 500/unlimited, up to 25 apps, 100GB peer-backup,
    marketplace listing eligible.
- Subscriptions managed via Stripe; the phone's IRK signs `tier-bind`
  receipts that the Worker verifies.

---

## 8. ACCESS CONTROL — sharing within / outside the household

### `[Service: habit-tracker → Members]`

```
┌──────────────────────────────┐
│  HOST (you)        OWNER     │
│  Sarah (wife)      MEMBER    │
│  Lily (daughter)   VIEWER    │
│                              │
│  [+ Invite someone]          │
└──────────────────────────────┘
```

### Inviting

#### `[Invite]`
- Pick role: `Owner` / `Admin` / `Member` / `Viewer`.
- Pick share method:
  - **Magic link**: phone IRK-signs `InviteToken{appId, role, expiresAt}`,
    QR + URL `https://home.harry.flagship.services/.flagship/invite?t=<token>`.
    Link is single-use (the membership store records redemption serial).
  - **Direct invite**: type a Flagship username; if they have a phone-paired,
    push them an `[Invite from harry]` notification on their phone.
- Phone signs the mutation locally (BAK gate) before sending.

### Accepting (other user's phone)
- `[Invite from harry]` shows app name, role, host info.
- Tap `Accept` → phone signs `InviteAcceptance{token, accepterIrkPub}`.
- POST to host's daemon: `/.flagship/invite/redeem?t=<token>`.
- Daemon's `ServiceMembership.redeemInvite` validates both signatures,
  adds the member, returns `{stableId, role}`.
- Now the new user can hit `https://habit-tracker.home.harry.flagship.services/`
  and load with `X-Flagship-User: <stableId>` injected.

### Removing
- Members tab → row's overflow menu → `Remove`.
- Phone signs `MembershipMutation{kind: "remove", target}` with IRK,
  POSTs to daemon. Membership store records the removal in its log.
- Effective immediately; their next request gets 403 + the
  `[Request access]` page.

### Locking down (panic button)

#### `[Service → Settings → Lock]`
- Big red button: `Lock this service`.
- Confirms with a face-ID prompt + reason text.
- Phone signs `MembershipMutation{kind: "freeze"}` (TODO new variant) +
  the daemon adds a soft block on every member except `owner`.
- Members get the `[Request access]` page with "Locked by host".
- `Unlock` reverses it (also IRK-signed).

---

## 9. MARKETPLACE — list, discover, install

### 9.1 Listing your app

#### `[Service: habit-tracker → Sharing → Make public]`
- Tabs:
  - **Status**: Currently `Private` / `Listed` / `Listed + Verified`.
  - **Listing details**: Description (markdown), screenshots (up to 5
    PNG ≤ 1MB each), category dropdown, tags.
  - **Pricing of your listing** — most apps: free.
    `Pay for security scan ($49 — re-runs on every release)`.
    `Pay for Top Featured slot ($199 / month)`.
- Submit → phone IRK-signs `ListServiceRequest{serviceId, manifestHash, description, ...}`.
- POST to `flagshipserver.com/api/marketplace/list`.
- **Worker only stores: appId, creator, description, screenshots in R2,
  canonical URL (the creator's pod), tags, ranking score.**
  No code, no data, no membership. Just the same info you'd put on a
  GitHub README.

### 9.2 Verified-by-Flagship security scan

If user paid for the scan:
- Worker queues a scan job.
- A scanner CI agent clones the public repo URL, runs:
  - `npm audit` against the manifest.
  - `trivy` on the docker image.
  - Static analysis (`semgrep` Flagship rules).
  - Dynamic check: spin up the app in a sandbox, hit common abuse
    vectors.
- Result is a **letter grade A–F + a public report PDF**.
- Listings show the badge; "Verified A" is a real ranking signal.
- A new release retriggers the scan.

### 9.3 Browsing the marketplace

#### `[Marketplace]` — `https://flagshipserver.com/marketplace`
- Search bar.
- Sidebar: **categories** (Productivity, Communication, Games, ...),
  **filters** (verified, free, recently added), **sort** (popular,
  newest, A–Z).
- Listing card: name, creator pod URL, tagline, screenshots,
  install count, security badge, `Install` button.

#### `[Listing detail]` — `https://flagshipserver.com/marketplace/<creator>/<slug>`
- Full description, all screenshots, security report (if any),
  changelog (commits from the canonical pod's repo via
  `https://<canonicalPod>/.flagship/update?since=` shown read-only),
  members manifest declaration (e.g. `data.stores: { postgres: true }`),
  domain allowlist (`browser.domains: [...]`).
- Big `Install on my server` button.

### 9.4 Installing someone else's app

User Bob clicks `Install on my server` while logged into his phone:
1. **Trust prompt**: Phone shows the manifest declarations (data
   stores requested, browser domains, etc.) and asks face-ID approval.
2. Phone IRK-signs `InstallServiceRequest` with `creator: "alice", slug: "habit-tracker"`.
3. Daemon's `ServicePlatform.install`:
   - Provisions Bob's data stores (`_bob_habit-tracker` Postgres, etc.).
   - Calls `cloneService({serviceId, canonicalUrl: "habit-tracker.alice.flagship.services"})`
     — the daemon GETs `/.flagship/update?since=` against Alice's
     pod, gets a full git bundle, materializes the working tree.
   - Records `AppPullState{canonicalUrl, lineageAnchor=<HEAD>, currentTip=<HEAD>}` (this internal store name was not renamed in the 2026-05-19 cutover).
   - Builds the docker image from the cloned source.
   - Deploys.
4. URL: `https://habit-tracker-alice.bob.flagship.services/`.

### 9.5 Pre-install authorization on Alice's side

For Alice's pod to honor Bob's pull, Bob must be a subscriber:
- Alice's marketplace listing is set to `manifest.distribution.public = true` —
  any phone-paired Flagship user can subscribe automatically; no
  approval step. Alice never sees Bob's identity.
- OR Alice listed it as `private + invite-only`. Bob's install attempt
  triggers an alert on Alice's phone: "Bob wants to install your habit-tracker.
  Approve?" If approved, Alice's phone sends `add-subscriber` PhoneOrder.

### 9.6 Browser-viewer for shared apps

Bob installed Alice's `shopper` app (which has `browser.domains:
["amazon.com"]`). To use it Bob must log into amazon.com on his pod.

- `[Service: shopper → Browser]` → big `Log in to amazon.com` button.
- Tapping opens **`[Browser viewer]`** — a phone-paired full-screen
  view of the actual Chromium tab on Bob's pod, streamed via:
  - Daemon takes screenshots every 2 sec and pushes to phone via
    `browser-input-needed` alerts.
  - Phone sends taps + key strokes back as `browser-input-response`
    PhoneOrders.
- Once logged in (cookie persists in the pod's Chromium), the
  shopper app can navigate amazon.com via the high-level API.

---

## 10. UPDATE PROPAGATION

### Subscriber side — Bob's pod

- `UpdateScheduler` (built in this session) ticks every 6h ± 30 min.
- For each app in `AppPullStateStore.list()`:
  - `UpdateClient.pullOne({appId})`:
    - GET `https://habit-tracker.alice.flagship.services/.flagship/update`
      with `X-Flagship-Update-Pull: <signed envelope>` and
      `Authorization: Flagship-Identity <pub> <sig>`.
    - Receives `application/x-git-bundle`.
    - `git fetch <bundle> main:incoming-main`.
    - Lineage check: `git merge-base --is-ancestor <lineageAnchor> incoming-main`.
      - **PASS**: continue.
      - **FAIL**: emit `lineage-break` alert → halt; phone prompts user to
        re-anchor or freeze.
    - If policy=auto: `git update-ref main` → run new migrations
      via `runMigration` dispatcher → restart container.
    - If policy=manual: stage `pendingPullCommit`, alert "Update
      ready — review changes". Bob's `[Service → Updates]` shows the
      diff; `Apply` button calls `UpdateClient.applyPending`.
    - If policy=frozen: the scheduler skips it.

### Canonical-home side — Alice's pod

- Bob's POST hits the daemon's reverse proxy.
- `serviceProxy` routes `/.flagship/update` to `UpdateServer.handle`.
- `UpdateServer`:
  - Verifies sig + pull envelope.
  - `resolveServerPubkey(<bob's fqdn>)` → calls `flagshipserver.com/api/server/by-domain/<fqdn>`.
  - Confirms Bob is in `subscriberRegistry.subscribersFor(appId)` OR
    `manifest.distribution.public` is true.
  - `git bundle create` (or read from `<dataDir>/data/update-pack-cache`).
  - Returns the bundle.

### Migrations

Numbered files under `migrations/`. Naming `^[0-9]+_.+`. Examples:
- `0001_init.sql` — schema bootstrap (per-service PG role).
- `0002_add_habit_count_column.sql`.
- `0003_seed_demo_data.ts` — runs via `tsx` with `FLAGSHIP_PG_URL` injected.
- `0004_recalc_streaks.js` — runs via `node`.

Migration failure (`runMigration` throws):
- UpdateClient halts; emits `migration-failed` alert.
- Bob's phone shows "Migration 0003 failed: <reason>". Buttons: `Roll
  back` (revert to last successful tip), `Open logs`, `Retry`.

### Lineage break example

Alice force-pushes (rare but possible). Next time Bob's scheduler
runs, the lineage check fails:
- `lineage-break` alert with `upstreamTip=<new>` and `lineageAnchor=<old>`.
- Bob's `[Service → Updates]` shows: "habit-tracker's history was rewritten.
  Continue tracking from the new lineage? Your local data stays."
- Buttons: `Re-anchor & continue`, `Freeze service`, `Uninstall`.
- `Re-anchor` updates `lineageAnchor = upstreamTip` and resumes.

---

## 11. STATE OF THE WORLD AFTER ALL THIS

### What the user gets

- A box at home that runs their apps, holds their data, and
  authenticates them via their phone.
- A marketplace of community-built services, no app store gatekeeping,
  no platform tax (free listing; security scan and ranking boost are
  optional paid services).
- Daily LLM credits to vibe-code new services without paying for an API
  key.
- Real green-padlock HTTPS on the user's own subdomain.

### What we host

- Identity (`flagshipserver.com` — username, server pubkey, sealed
  LUKS blobs, listing metadata).
- Stateless data plane (`flagship.services` — SNI passthrough +
  tunnel hub).
- Marketplace listings (description + screenshots; **never user data
  or app code**).
- LLM promo billing (provider keys + usage counters).

### Code map

```
apps/com/                    Worker — identity, marketplace, LLM-promo
apps/web/                    Fly app — stateless pipe
apps/mobile/{ios,android}/   Phone app (scaffolds; needs build §11)
packages/protocol/           canonical-bytes + sign/verify (DONE)
packages/storage/            D1 + InMemory storage (DONE)
packages/control-plane/      pure handlers (DONE)
packages/server-daemon/      THE DAEMON (everything wired, this session)
packages/iso-personalizer/   ISO trailer build/parse (DONE)
packages/installer-apkovl/   Alpine apkovl (DONE)
packages/llm-providers/      BYOK provider adapters (PARTIAL)

installer/install.sh         First-boot installer (DONE, this session)
installer/boot-stage.sh      Steady-state phone-mediated unlock (DONE)
installer/data-services/     Compose stack (DONE)
```

### What's NOT in this session's code (mobile-specific)

These pieces are scaffolds in `apps/mobile/` and need real builds:

- **iOS**: Xcode project, Secure Enclave UMK, BiometricPrompt wrap,
  WebSocket → flagshipserver.com, APNs, in-app QR scanner.
- **Android**: Kotlin app, StrongBox UMK, BiometricPrompt, FCM, QR.
- **Web app PWA**: vanilla JS `apps/com/web-app/`. UMK in
  WebAuthn-wrapped IndexedDB; can do everything except boot the box
  (which needs OS-level USB flashing).

The canonical-bytes shapes in `@flagship/protocol/auth.ts` are
byte-identical across all three; the test-vector JSON in
`tools/keygen.ts` (TODO) is meant to seed Swift/Kotlin/JS unit tests.

### What's NOT in this session's code (server-side stretch goals)

- **Peer-backup distribution**: design exhaustive in `roadmap.md` §1.
  Encryption + erasure-coding done; matchmaking + transport unbuilt.
  ~4–6 weeks.
- **LAN/BLE fallback** for when the internet is down. Designed; ~2 weeks.
- **TURN relay** for symmetric-NAT users. Out of v1 scope.

---

## 12. UI/UX OVERVIEW (for the design team)

### Phone (iOS / Android / PWA — pixel-identical)

Tab bar: `Servers`, `Services`, `Activity`, `Settings`.

- **Servers**: `[Server]` per box. Per-server: status, uptime, disk,
  alerts, `Restart`, `Backup policy`, `Rotate identity`.
- **Services**: per-service list with quick toggles + drawer.
- **Activity**: AlertInbox feed (lineage breaks, manual updates,
  browser-input requests, security events, daily-LLM-promo limit).
- **Settings**: Tier, AI provider, Pairing, Recovery (re-wrap UMK to
  iCloud / Google Block Store), About.

### Desktop (browser, paired-session)

- Same tabs, more screen real-estate: side-by-side editors for
  vibe-coding, embedded terminal for service logs, Adminer for SQL.

### `[Browser viewer]` — phone full-screen

Edge-to-edge live screenshot of the pod's Chromium tab. Bottom bar
shows the current URL. Top-right `(X)` closes the relay (does NOT
close the pod's tab — services may still be using it).

### Notifications / alerts

- Push notifications: phone-paired browser inbox poll < 5s when the
  app is open; APNs / FCM push when closed.
- Notification categories with quick-actions:
  - **Unlock requested** → `Approve` / `Decline` inline.
  - **Browser input needed** → opens directly to `[Browser viewer]`.
  - **Update ready (manual)** → opens `[Service → Updates]`.
  - **Lineage break** → opens `[Service → Updates]` with re-anchor flow.
  - **Promo limit reached** → opens `[Settings → AI provider]`.

### Accessibility
- Big-text mode honors system settings.
- Screen-reader labels on every interactive element.
- Color-blind safe palette (don't rely on red/green alone for
  status).

---

## 13. WHAT TO BUILD NEXT (build-order recommendation)

Given everything in §11 is wired, the highest-leverage next builds:

| Order | Item | Effort |
|---|---|---|
| 1 | Mobile clients (iOS first, since user has Mac access) — UMK + IRK + push + QR | 4–6 weeks |
| 2 | Marketplace MVP (Worker route + R2 screenshots + listing UI) | 1 week |
| 3 | LLM harness vibe-coding loop end-to-end on box | 2 weeks |
| 4 | Browser-viewer: live screenshot relay over WS | 1 week |
| 5 | Peer-backup matchmaking + transport | 4–6 weeks |
| 6 | Security-scan service for marketplace listings | 1 week |
| 7 | Tier billing (Stripe + Worker + LLM-promo enforcement) | 2 weeks |

After **(1)** a real human can do everything in this spec end-to-end.
Items 2–7 add depth + monetization.

---

## 14. THINGS TO DECIDE BEFORE SHIPPING v1

A short open-questions list for the founder:

1. **Marketplace policy**: How do we handle takedowns (DMCA, hateful
   content, malware)? Probably: revoke listing only — never the
   user's pod (we can't anyway).
2. **Refund policy** for hardware (Path A): standard 30-day return,
   box wiped + restocked + cert revoked.
3. **Recovery flow** when the user loses their phone AND iCloud /
   Google access. We have nothing — be explicit in onboarding ("This
   is genuinely lost; we cannot recover it"). Consider an optional
   social-recovery feature (SSS-shard the UMK to N friends).
4. **Pricing** of hardware tiers + subscription tiers. Out of scope
   here.
5. **Branding** of the marketplace (named "Flagship Marketplace"?
   "The Pier"? "Hangar"?).
6. **Default "promo" provider** — Anthropic Claude Sonnet vs GPT-4o
   mini. Probably Anthropic given the Flagship.services brand pairs
   well; cost more but quality first impression matters.
7. **Services that need outbound web traffic but NOT a browser** (e.g.,
   webhook receivers): we already allow this (containers can
   `fetch()` anywhere). Decide whether to add an opt-in egress proxy
   for compliance-conscious users.

---

## 15. DONE-NESS CHECKLIST FOR v1 ALPHA

Tick when shipped:

- [ ] iOS app (TestFlight)
- [ ] Marketplace MVP live
- [ ] 10 dogfood users running their own pods for 30 days without
      manual intervention
- [ ] Daily LLM-promo cap enforced + tested
- [ ] Update-pack pull working across two pods (one canonical, one
      subscriber) over 7 days of use
- [ ] Lineage-break + re-anchor flow exercised live
- [ ] Identity rotation exercised live
- [ ] At least one community-listed service installed by someone other
      than the creator
- [ ] Recovery (lost phone → new phone) exercised live with an iCloud
      / Google-Block-Store wrapped UMK
- [ ] Public security disclosure page + bounty program
- [ ] Reproducible-build CI for the ISO

When all checked: v1 alpha. Then iterate.
