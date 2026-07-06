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

### Refinements over the original sketch (owner design was ~right; these are the catches folded in)
1. **AID-SIGNED authorize, not a plaintext "who I am" GET param.** The original "phone reaches the server with a
   link that has a get parameter telling who this is" would let anyone assert any identity. The phone instead
   **AID-signs** `{pageId, serviceRef, …}`; the box verifies the signature + allow-list. (Security must-fix.)
2. **pageId = high-entropy, single-use, short-lived** (128-bit, consumed on cookie delivery, re-rolled per load)
   — a correlation token, never a guessable counter.
3. **Holder binding closes the pageId-theft race.** The knock page sets a host-scoped `Flagship-Knock` holder
   cookie; ONLY that browser can pick up the session cookie. A shoulder-surfed QR/pageId yields nothing.
4. **Two distinct artifacts:** the browser gets an opaque `Flagship-App-Session` **cookie**; the phone gets the
   **secretId** (never the browser). Closing by secretId kills the cookie.
5. **Minimal disclosure** on the knock page (no owner / service name / content) + `noindex` + fully
   self-contained (no remote asset — never leaks the visitor to another origin).
6. **secretId rides the request BODY, not the URL path** (the sketch wrote `/session/:secretId/status`) — a
   32-byte secret in a URL lands in access/proxy logs; the body keeps it out. Status stays rate-limited
   ~1/min + default-offline for unknown (both as the owner specified — those were already right).

### Session management (the phone holds the secretId, not the browser)
- `GET  /api/service-access/session/:secretId/status` → `{online|offline}`, **rate-limited ~1/min/session**,
  **default offline for unknown** (no enumeration oracle).
- `POST /api/service-access/session/:secretId/close` (secretId-authed) → kills the browser cookie.
- The service (or the harness) can stop a session anytime.
- Settings → **"Open secured sessions"** lists `{serviceUrl, browserAgent, startTime}` per held secretId + Stop.

## v2 hardening — STATUS: BUILT on main (2026-06-19)
The full v2 redesign is integrated + green on main (protocol `21a9de5d` → backend `6280ec88` → clients
Android/iOS/webapp → link reconciliation `189d93e2`). Closes the verified critique findings: **C1** (box
verifies the owner's signed create + secretHash-match — `.com` can't forge a binding), **C2** (owner-auth on
the invite list), **H3** (pairwise contact AIDs — no cleartext friend-graph on `.com`), **H4** (revocation
convergence poller + instant prune), **H1** (3 invite tiers incl. the manual out-of-band accept-loop), plus
M2/M3/M4/M5/L. All 3 clients interop on the canonical invite link `<secret>&a=<authorAID>&i=<inviteId>`
(fixed-string round-trip tests per surface). Gates: protocol 682 · backend 3137 · iOS 1146 · Android 989 ·
webapp 1392 · tsc clean.

**Follow-ups — DONE (`f7ad7a7d`):**
- ✅ **Manual-finalize is now device-independent** — the box re-fetches + verifies the signed create from
  `.com` by inviteId at `/api/service-access/accept` (STK-signed `GET …/service-invites/:inviteId/create`,
  mirroring `revoked-since`); the author submits only `{accept, acceptSig}`, and the per-client create caches
  (webapp `CREATE_STORE_KEY`, iOS `InviteCreateStore`, Android) were deleted. Finalize from any of the author's
  devices.
- ✅ **Acceptance-reply link** canonicalized — `flagship://invite-accept?server=&iid=&ref=&aid=&sig=&at=`, all
  3 surfaces build+parse the identical frozen string (round-trip tests); legacy forms still decode.
- ✅ **`/invite` web page** parses + forwards the canonical `#<secret>&a=<authorAID>&i=<inviteId>` (verified +
  test-pinned).

**Remaining (low-priority / owner):** retire the dual-accept IRK-create path once nothing needs it (safe to
keep); deploy `.com` (the new by-inviteId fetch route) + rebuild the burner/apps to ship to real boxes/devices.

## v2 hardening — box-as-authority + pairwise AIDs + author-confirmed binding (2026-06-19, from the design critique)

A skeptical design review (findings verified against the code) surfaced the v1 gap: the design
DECLARES `.com` untrusted but OPERATIONALLY trusts it for the binding that grants access, and the
"content-blind" claim doesn't extend to the friend graph. Owner approved an architectural redesign.
Already shipped as defense-in-depth: the redeem `serviceInstalled` gate (`7b80ea15`, C1-partial).

### Phase 1 — Box is the binding authority (fixes C1, C2-trust, H4) — highest leverage
Today `handleRedeem` relays to `.com` and trusts `.com`'s `{serviceRef, boundAID}` — a rogue/compromised
`.com` can grant any AID access to any *hosted* service (the `serviceInstalled` gate only bounds it to
hosted services). Change:
- `.com` PERSISTS the create's IRK **signature** (storage: add `createSig` to `service_invites` +
  migration; `handleCreateServiceInvite` already receives `body.signature` — store it).
- Redeem returns the signed create (envelope + sig). The box VERIFIES that signature against its
  config-pinned **owner IRK** + that `serviceRef` is hosted, BEFORE binding. A rogue `.com` cannot forge
  the owner's IRK sig → cannot fabricate a binding. `.com` is demoted to a blind store + first-bind arbiter.
- **Revocation convergence:** the box POLLS `.com` for revoked invites (reuse the daemon-status cadence)
  and self-prunes — so a `.com` revoke is SUFFICIENT and multi-box self-heals. Supersedes the just-built
  owner-prune-only model (which stays as the immediate path + the manual override).
- Surfaces: storage (migration + create stores sig), control-plane (redeem returns create+sig; a
  revoked-since-cursor list), daemon `serviceAccess.ts` (verify create sig + a revocation poller), tests.
- **⚠️ OPEN DESIGN QUESTION (resolve before implementing):** the create is currently **IRK-signed**, but the
  IRK ROTATES (re-pair / recovery / device-takeover), so a create signed by the old IRK won't verify against
  the box's *current* config-pinned IRK after a rotation — box-as-authority would break exactly when the owner
  rotates a device. Resolution options: (a) **AID-sign (or AID-co-sign) the create + revoke** so the box
  verifies against the stable AID (this is the cleanest, and it COUPLES Phase 1 with Phase 2 — do them
  together: the box pins the owner's AID, verifies AID-signed create/revoke); (b) the create carries its
  IRK-version + the box keeps the owner's IRK history (more state, still rotation-fragile); (c) `.com` vouches
  for the signing IRK (re-introduces trusting `.com` — rejected). **Recommendation: (a)** — pin the owner AID
  on the box at provision, switch create/revoke to AID-signed, and land Phase 1+2's signing change as one unit.
  This is why Phase 1 is NOT yet in flight: the trust-model change needs this decision first.

### Phase 2 — Pairwise AIDs (fixes H3: cross-box linkability + the cleartext friend-graph)
Today one GLOBAL AID identifies a person across every box/author, and `.com` stores
`authorAID→boundAID→serviceRef` in cleartext (the bundle is content-blind; the GRAPH is not). Change:
`deriveContactAccountId(UMK, authorAID)` — a per-author friend identity (HKDF over UMK + the author's AID,
parallel to the existing per-service `deriveServiceMemberStableId`). The friend presents a per-author AID;
two authors can't cross-link; `.com` sees unlinkable pseudonyms. Cross-app reuse still works (deterministic
derivation). Decide: the owner's own multi-box identity stays global vs per-box. Migration: applies to NEW
invites; existing global-AID bindings grandfathered. Surfaces: protocol (`deriveContactAccountId` + redeem/
visit/knock sign with it), all 3 clients, `.com` (already stores opaque AIDs).

### Phase 3 — Invite tiers + approval (fixes H1; owner-refined 2026-06-19)
Three tiers, chosen at create/add time, all on the box-as-authority + pairwise-AID foundation. Across ALL
tiers the consumer's Flagship username/domain is **never disclosed to the author** — the author sees only the
private label they themselves assigned (personal) or a group label (group). (The owner explicitly rejected
verifying by the consumer's username/domain on exactly this privacy ground.)

1. **Personal, auto-approve** — first-bind (the original fast flow): send link → first redeemer binds. Accept
   the casual-leak window; for low-sensitivity grants.
2. **Personal, manual-approve (sensitive)** — closes the link-theft race WITHOUT disclosing the consumer's
   identity, via an **out-of-band acceptance loop**: author sends the link → the friend's app accepts + emits
   an **AID-signed acceptance** token (binds the inviteId + the friend's pairwise contact AID) → the friend
   replies it back through the SAME private channel → the author's app opens it + submits it to the **author's
   box**, which verifies the owner's create AND the friend's signature, then binds. The author FINALIZES the
   loop. A thief who only grabbed the link can't produce an acceptance the author will open from their
   friend-channel. NOTE the honest bound: this is channel-trust + author-finalization (defeats a casual
   link-leak), NOT cryptographic against an attacker already inside the author↔friend private channel — which
   matches the threat model. The acceptance reply is itself a link/QR (symmetric to the invite).
3. **Group / multi-use** — one link, `maxN` redemptions (0 = unlimited), **auto-approve only** (per-person
   confirm is impractical when you don't know who'll redeem). Lower-trust BY CONSTRUCTION (a leaked link admits
   up to N) → must be clearly labeled in the UI. Guest list shows ONE entry ("Chess club — 4/10"); revoke the
   whole group in one op (the box prunes all AIDs bound to that inviteId); per-member removal is a cheap bonus
   (the group is a labeled set of bound AIDs). The live count is a leak signal; an **optional expiry** is
   recommended (a forever-link is a standing liability).

Surfaces: protocol (the AID-signed acceptance envelope; `maxN`/expiry on the create), `.com` (pending state
for manual; redemption-count enforcement for group), box (verify + bind on the author's submission; group
prune), client UX (the create-time tier picker, the accept→reply→open loop, the group guest-list entry).

### Convenience — QR in the share (owner-requested 2026-06-19)
When sending an invite (or an acceptance reply), populate the share (share-sheet / iMessage / email) with an
inline **base64 QR image** of the link, IN ADDITION to the link text. Caveat: email clients (Gmail/Outlook)
commonly STRIP data-URI `<img>` for security → the QR may not render in email; the **link text is the reliable
fallback**, rich channels (share-sheet/iMessage) render the image, and for email an actual attachment beats a
data-URI. Reuse the existing `qrSvg.ts` / `qrEncoder.js`.

### Contained hardenings (fold in alongside the phases)
- **Owner-IRK-auth the invite `list`** (C2 — `handleListServiceInvites` is currently unauthenticated: anyone
  with a username + a 64-hex authorAID dumps that author's whole invite graph). Sign it like create/revoke.
- **Random 128-bit invite ids** (M2 — drop the `hash(devicePub)` device-fingerprint leak baked into the id).
- **Nonce-challenge + client-bind the establish-session cookie** (M3 — a captured 5-min visit proof currently
  mints a 12h freely-transferable bearer cookie).
- **Fail-open alert** (M4 — owner-facing signal when access-state reverts to `open` unexpectedly).
- **Allow-list size cap + redeem/establish/knock rate-limits** (M5). **Poll `unknown`→`pending`** (L — kill
  the pageId oracle).

### Web-path trust tier (H2)
The QR-login web path is structurally lower-trust (the browser isn't cert-pinned — CAA+CT only). The phone
must DISPLAY what it's authorizing from its OWN trusted state (not the deeplink's claimed serverId/serviceRef)
and ideally channel-bind the knock to the box's pinned cert hash, so a rogue-cert look-alike can't get a
signed authorization. The browser EXTENSION (`feat/browser-extension`) is the path to closing the
browser-pinning gap. Until then, label web sessions as the convenience tier.

### Sequencing
Phase 1 first (it alone closes C1 fully + C2-trust + H4 — the biggest posture change), then the contained
hardenings (cheap, low-tradeoff), then Phase 2 (privacy; touches all signing), then Phase 3 (UX). Each phase
is multi-surface (protocol → `.com` → daemon → 3 clients) + fixture-pinned, suited to a parallel-worker fan-out
per phase.

### Maps to the built backend (extends, doesn't replace)
On main already: AID binding (redeem), the `Flagship-App-Session` cookie, `establish-session` (phone
AID-signed visit-proof → box mints a cookie). This ADDS: (a) the **pageId correlation** (the phone authorizes
a SEPARATE browser's pageId, vs its own client) + the knock page + the browser poll; (b) the **session store**
carrying `{secretId, status, serviceUrl, browserAgent, startTime}` + the phone status/close API (rate-limited,
default-offline) + the Settings list.

### Daemon backend — BUILT (`3343aeb9`, on main, tested)
- **`packages/server-daemon/src/serviceAccessWeb.ts`** — `PendingKnockStore` (in-memory, ephemeral) +
  `buildServiceAccessWeb({serverId, store, sessions})`:
  - `maybeServeKnock(serviceRef, req)` — the enforcement layer (`buildAccessEnforcementHandler`'s new 3rd arg)
    calls it on a DENY; returns the self-contained knock page (200 HTML + holder cookie) for a top-level
    browser GET/HEAD with `Accept: text/html`, else null (→ the existing 403 JSON for XHR/assets).
  - `GET /__flagship/knock/<pageId>/status` — browser poll; delivers the session `Set-Cookie` **only to the
    holder** (matching `Flagship-Knock` cookie), single-use (the pageId is consumed on delivery).
  - `POST /api/service-access/knock/authorize` — the phone's AID-signed `KnockAuthorization`
    (`flagship/service-knock/v1`; the **pageId is in the signature**, so a visit proof can't be replayed onto
    another page). Verifies sig + serverId + replay + allow-list; mints the session cookie + a phone-held
    `secretId`; returns the secretId to the PHONE only.
  - `POST /api/service-access/session/status` + `…/close` — **secretId in the BODY, never the URL** (so it
    can't land in access logs); status is rate-limited ~1/min/secretId + default-offline for unknown (no
    enumeration oracle); close kills the browser cookie.
- **`packages/server-daemon/src/qrSvg.ts`** — server-side QR (strict-TS port of the webapp `qrEncoder.js`,
  byte-for-byte identical) so the knock page bakes the QR in without fetching a remote asset.
- **Protocol**: `KnockAuthorization` envelope (`signKnockAuthorization` / `verifyKnockAuthorization`); pinned
  cross-platform vector in `serviceAccessGating.vectors.json` → `"knock"`.
- **`ServiceSessionStore`** gained the `secretId` index + `closeBySecretId` + `lookupBySecretId`.

### Clients — in flight (iOS / Android / webapp)
The deeplink the knock page hands the phone is `flagship://access?server=&svc=&ref=&page=`. Each client adds:
`signKnockAuthorization` (mirror, fixture-pinned) + the deeplink/paste → KnockAuthorize confirm → authorize
call + a local `SecuredSession` store + a Settings **"Open secured sessions"** list (status/close). The webapp
authorizes via a pasted link ("Process URL") since a browser can't own the `flagship://` scheme.
