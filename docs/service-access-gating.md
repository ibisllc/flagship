# Service access gating — open/restricted + capability invite links

> Owner-designed (2026-06-18). Lets a service admin gate each service **open-to-all**
> or **restricted**; if restricted, manage an allow-list of people via **bearer invite
> links** that bind to the redeemer's stable account key. Identity is anchored to the
> **UMK**, NOT the IRK — see below. See `gym-proof-ledger.md` for the gym test status.

## Identity / stability — anchor to the UMK, not the IRK
**Verified in code:** the IRK is VERSIONED (`flagship/irk/v<N>`, `currentIrkVersion`) and
ROTATES — re-pair / Wipe & restart / device-takeover all derive a NEW IRK from the SAME,
still-shared UMK (`RecoveryChoice`: "Derives a new IRK from the (still shared) UMK"). So
the IRK is a rotatable *signing/device* key, NOT a stable identity. The **UMK** is the
account root: preserved through recovery, replaced only by a brand-new account.

Therefore identity is a **stable Account Identity Key (AID)**:
- `AID = deriveAccountId(UMK)` — a NON-rotating Ed25519 keypair from the UMK under a FIXED
  HKDF info (e.g. `flagship/account-id/v1`), distinct from the versioned IRK. New primitive,
  trivially derived from the existing UMK; survives IRK rotations; resets only on a new UMK.
- The **AID pubkey** is the public, stable identifier used in allow-lists, invite bindings,
  and author/friend attribution. (The IRK stays the signing key for active orders.)

Key usage (the owner's asymmetry):
- **Authorizing device → UMK + IRK:** UMK gives the author's **AID** + the household
  encryption key for the bundle; the **IRK signs** create/revoke (active orders by the
  *current device* key — a compromised device's orders die when its IRK rotates).
- **Authorized device → UMK:** the friend is identified by their **AID** and proves control
  by signing the redeem + visits with the AID (UMK-derived, stable). Access follows the UMK.

## Invite id + the packet (on `.com`)
- `inviteId = hash(AID_author) · hash(devicePub_author) · counter` — unique, attributable to
  the author account + creating device, monotonic. Used for revocation + the who-authorized
  -whom graph.
- New `.com` store `service_invites` (D1): `{ inviteId, authorAID, serviceRef, encryptedBundle,
  secretHash, boundAID (NULL until redeemed → friend AID pub), boundAt, createdAt, revokedAt }`.
  Indexed by `secretHash` (redeem), `inviteId` (revoke), `authorAID` (list).
- `secret` = random 32B capability in the link; `.com` stores only `secretHash`.
- `encryptedBundle` = AEAD({ name, photo? }) under a **household key** only the author's
  sibling devices + servers hold (UMK-derived, provisioned to the boxes over their pinned
  pipe). `.com` stores ciphertext only — it cannot read the friend's name/photo.

## Flows
1. **Create invite (admin phone):** pick name(+photo) → mint `inviteId` + `secret` → AEAD the
   bundle under the household key → **IRK-sign** the create envelope (carries `authorAID`) →
   `POST .com /api/service-invites` → build link `https://<server>.<user>/invite#<secret>`.
2. **Redeem (friend, first visit to ANY of the author's boxes):** the box gets the secret +
   the visitor's **AID** (the friend signs the redeem with their AID) → `POST .com
   /api/service-invites/redeem { secret, visitorAID, aidSig }` → `.com` FIRST-redeem binds
   `boundAID = visitorAID`, records author→friend, returns the binding + serviceRef → the box
   adds `visitorAID` to the service's allow-list.
   - Re-redeem after an IRK rotation / new device: SAME AID ⇒ idempotent (the UMK, hence the
     AID, is unchanged — that's the whole point). A DIFFERENT AID ⇒ 409 "already bound".
3. **Cross-app reuse:** the author now knows friend→AID, so adding them to another service is
   a pure allow-list write (no new link).
4. **Enforce (box):** per-service `access.mode ∈ {open, restricted}`. open ⇒ anyone;
   restricted ⇒ the visitor must present an **AID-signed** proof whose AID ∈ the service's
   bound allow-list (else deny). Allow-list = the `boundAID`s for that service.
5. **Revoke:** admin (IRK-signed) `POST .com /api/service-invites/revoke {inviteId}` or
   remove-from-allow-list → daemon prunes the AID → friend's next visit denied.

## Build order
1. **Backend (this worker):** protocol (`deriveAccountId(UMK)` → AID; `inviteId`; AEAD bundle;
   IRK-signed create/revoke + AID-signed redeem canonical bytes, `flagship/service-invite/v1`),
   `.com` `service_invites` store + handlers (create/redeem/revoke/list; first-bind + same-AID
   idempotent + reject-different-AID), daemon redeem endpoint + per-service `access.mode` +
   AID allow-list enforcement on the serve path + the household-key bundle decrypt. Tests.
2. **Clients:** admin UI (toggle + allow-list: add = name/photo/invite-link, remove = revoke)
   on iOS/Android/webapp; the friend deep-link that redeems (AID-signed). Mirror membership UI.
3. **Gym test:** admin restrict + invite → a second sim/context (friend) opens the link →
   redeems (AID) → reaches the restricted service → admin revokes → denied. Plus cross-app
   reuse + a "rotate the friend's IRK, access still honored (AID unchanged)" assertion.

## Daemon HTTP surface (built — `packages/server-daemon/src/serviceAccess.ts`)
- `POST /api/service-access` — owner-IRK `set-service-access-mode` envelope (open/restricted).
- `GET  /api/service-access/<serviceRef>` — access-state read: `{ serviceRef, mode, allowCount }`.
  **Unauthenticated** (mirrors `GET /api/front-page`): the mode is already behaviorally
  observable (a restricted service 403s anonymous traffic), so it's not a secret — and ONLY the
  integer `allowCount` is exposed, NEVER the allow-listed AIDs (those are the friend graph). Lets
  iOS/Android/webapp render the TRUE toggle without a signature on a plain refresh.
- `POST /api/service-invites/redeem` — friend AID-signed redeem → `.com` binding → allow-list add.
  On success, **also issues a `Flagship-App-Session` cookie** bound to the redeemer's AID + this
  service (when the cookie seam is enabled).
- `POST /api/service-access/establish-session` — a friend who already redeemed presents the SAME
  AID-signed `ServiceVisitProof` the `x-flagship-visit` header carries (base64 body); the box mints
  the cookie. 401 if the AID isn't allow-listed for that (restricted) service; 403 on a bad proof.
- **Browser cookie seam.** A plain BROWSER can't set the AID-signed `x-flagship-visit` header, so a
  restricted service's WEBSITE is unreachable from one — closed by an opaque `Flagship-App-Session`
  cookie (the SAME bearer-cookie shape as the older #84 `serviceAccessGate.ts`: a random token
  looked up server-side, **NOT a new MAC**), `HttpOnly; Secure; SameSite=Lax; Path=/`, default 12h,
  persisted box-local (`ServiceSessionStore`, atomic mode-0600 JSON, restart-survivable). The
  serve-path `decide` accepts **cookie OR header**: either must resolve to an AID STILL in the
  allow-list (a `.com` revoke that prunes the AID kills the cookie too — re-checked per request).
  `open` is unchanged (decide short-circuits before reading any cookie). Client follow-up: the
  friend's webapp should call `establish-session` (browser-driven, signed from the in-page UMK→AID)
  so the `Set-Cookie` lands in that browser.

## Notes
- AID is a NEW UMK-derived key (parallel to the versioned IRK). Add `deriveAccountId` to
  `@flagship/protocol` (`keys.ts`) + the Swift/Kotlin/webapp keystores (follow-up for clients).
- Layers on existing `ServiceEntitlement` (IRK-signed cert) + service `membership`.
- Bearer-link threat model: whoever holds the link can redeem; first-bind locks it to one AID;
  the author sees who bound it + can revoke. Send over a private channel.

## Web-experience gating (browser access via QR-login + session management) — owner-designed 2026-06-19
A restricted service's WEBSITE must gate plain browser visitors (a browser can't AID-sign). Pattern =
**QR-login** (à la WhatsApp Web): a knock page; the phone authorizes; the server binds the browser session.

### Knock page
A visitor hitting a restricted service with no valid session gets a non-threatening knock page: *"This page
is on a Flagship cloud and access is restricted — authenticate to view."* (minimal disclosure — NO owner/
content). It carries a high-entropy, short-lived, single-use **pageId** (re-rolled per load / ~minute), a
**button** (same-device deeplink `flagship://access?pageId=…&svc=…`), and a **QR** (cross-device: same
deeplink). The page POLLS the box for `pageId` authorization.

### Authorize (phone)
deeplink/scan → app verifies the visitor's **AID** ∈ the service allow-list → on yes the phone **AID-SIGNS**
`{pageId, aid, serviceRef, nonce, exp}` and POSTs it to the box. The box verifies the **signature + allow-list
membership** (NOT a plaintext "who I am" GET param — the security must-fix), then: creates a **session**
`{secretId, aid, serviceRef, browserAgent, startTime, status:online}`; the browser's next poll for `pageId`
→ authorized → the box sets the access **cookie** on the BROWSER (transitions off the QR to the content);
returns the **session secretId** to the PHONE (never to the browser). A "go back to the website" toast nudges
the cross-device case (the browser auto-transitions regardless).

### Fallbacks
No app / no access on this device → the button stays as the QR (scan with another phone). "Get link" → copy
the code → app Settings → **"Process URL"** paste. Never deactivate the page — a stale pageId just re-rolls.

### Session management (the phone holds the secretId, not the browser)
- `GET  /api/service-access/session/:secretId/status` → `{online|offline}`, **rate-limited ~1/min/session**,
  **default offline for unknown** (no enumeration oracle).
- `POST /api/service-access/session/:secretId/close` (secretId-authed) → kills the browser cookie.
- The service (or the harness) can stop a session anytime.
- Settings → **"Open secured sessions"** lists `{serviceUrl, browserAgent, startTime}` per held secretId + Stop.

### Maps to the built backend (extends, doesn't replace)
On main already: AID binding (redeem), the `Flagship-App-Session` cookie, `establish-session` (phone
AID-signed visit-proof → box mints a cookie). This ADDS: (a) the **pageId correlation** (the phone authorizes
a SEPARATE browser's pageId, vs its own client) + the knock page + the browser poll; (b) the **session store**
carrying `{secretId, status, serviceUrl, browserAgent, startTime}` + the phone status/close API (rate-limited,
default-offline) + the Settings list. Build it as the next gating chunk (daemon knock+authorize+session +
webapp knock page + the iOS/Android authorize + "Open secured sessions" UI).
