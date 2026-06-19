# Flagship browser extension — design (build-decision artifact)

> **DESIGN ONLY.** No extension code exists or is proposed here. This is the
> artifact a security-minded owner reads to make a confident **build / don't
> build / build-later** call. Unlaunched feature → lives on its own branch
> (`feat/browser-extension`); per `CLAUDE.md` "branching IS the gate", **none
> of this may sit on `main`** until launch. Authored 2026-06-19.
>
> **Model decided by the owner: KEY-LIGHT.** The extension is a *QR-paired,
> scoped, revocable session principal* — **NOT** a UMK / device-key / signing-key
> holder. The phone stays the trust root. §2 and §6 defend that choice against
> the "full client" alternative.

---

## 0. TL;DR recommendation (read §1 for the argument)

**BUILD-LATER, Firefox-first, and only the two things browsers structurally
lack.** Access to restricted services is *already solved* without an extension
(the QR-login knock flow in `docs/service-access-gating.md` + the webapp as a
signing peer on its own origin). The extension adds exactly two things no other
surface can: **(a) browser cert-fingerprint pinning** — the one structural gap
between a browser and the mobile apps, which already HARD-PIN the
daemon-status-signed leaf fingerprint (`apps/mobile/.../BoxCertPinning.swift`,
`CertPinInterceptor.kt`) — and **(b) seamless cross-site knock auto-detection** —
the webapp can only act on its own origin; an extension sees a knock page on
*any* Flagship-served site. Everything else listed as "other useful features"
(§7) is a launcher/convenience layer that the webapp can host without the new
attack surface.

The catch that drives the *sequencing*: **the marquee feature (cert-pinning)
works well in Firefox and barely works in Chrome** (§3). Chrome MV3 removed
blocking `webRequest` and never shipped Firefox's `webRequest.getSecurityInfo()`,
so a Chrome extension cannot read the served leaf-cert fingerprint of a page's
own TLS connection at all without a native-messaging helper — which reintroduces
an installed binary and most of the trust problem the key-light model avoids.
So the honest shape is: **Firefox extension delivers the security win cleanly;
Chrome delivers only the convenience win** unless we also ship a native host.
That asymmetry, plus the fact that nothing is *blocked* on the extension today,
is why this is "build-later" not "build-now".

---

## 1. Motivation — is it worth building? (be honest)

### 1.1 What is ALREADY solved (so the extension must clear a high bar)

- **Access from a browser is solved.** A plain browser hitting a *restricted*
  Flagship service gets the knock page; the phone authorizes it via
  `flagship://access?server=&svc=&ref=&page=` (deeplink or QR); the box mints a
  `Flagship-App-Session` cookie bound to the holder browser; the browser polls
  `GET /__flagship/knock/<pageId>/status` and transitions to content. This is
  built and tested: `packages/server-daemon/src/serviceAccessWeb.ts`,
  `qrSvg.ts`, the `KnockAuthorization` envelope
  (`packages/protocol/src/serviceInvite.ts` `flagship/service-knock/v1`), and the
  webapp client (`apps/web/public/webapp/views/access-authorize.js`,
  `lib/securedSessions.js`). **`.com` is never in the authorize path** — the
  phone POSTs straight to the box's pinned pipe.
- **A signing client on its own origin is solved.** The webapp *is* a co-equal
  device-family peer with its own UMK/IRK/AID (`keystore.js`), so on
  `web.flagshipserver.com` it already does everything a "full client" extension
  would do for its own surface.
- **The maintainer-trust red sliver is solved on every surface** (`serverTrust.js`
  + `trustSliver.js`, `TrustCenter.swift` + `GlobalTrustBar`). The webapp already
  halts backend traffic on an unverified control-server blessing.

So: an extension justified as "lets a browser reach restricted services" or
"lets me sign things in the browser" is **redundant**. It must add something
structural.

### 1.2 What the extension UNIQUELY adds (the only two real reasons)

**(a) Browser cert-fingerprint pinning — the one structural gap.**
The mobile apps pin the box's leaf-cert DER-SHA-256 to the value the box itself
signs with its STK in the daemon-status heartbeat, and **HARD-FAIL** a mismatch:

- the box reports `certSha256` in an STK-signed `DaemonStatusReport`
  (`packages/server-daemon/src/daemonStatusHeartbeat.ts`,
  `packages/protocol/src/daemonStatus.ts`);
- `.com` relays the tuple **verbatim** on `/pods` (`signedStatus`) — it can drop
  it but cannot forge it;
- the phone derives the box STK *locally* from the UMK (`ServerKeys.deriveStkPub`),
  verifies the signature, and pins the fingerprint
  (`apps/mobile/shared/Sources/FlagshipCore/CertPinRegistry.swift`);
- on connect, the served leaf must equal the pin or the connection is refused
  (`BoxCertPinning.swift` `CertPinVerdict.mismatch`,
  `CertPinInterceptor.kt`).

This is the real defense against a **rogue `.com`-minted cert** — `.com`
controls the `flagship.services` DNS zone, so it can satisfy DNS-01 and mint a
CA-valid cert for any user's name (`per-user-cert-and-addressing.md` §4.3). CAA
+ CT (the cert-model A′ defenses) make that *detectable after the fact*;
**pinning makes it fail in real time.** A browser/webapp **cannot pin** — it
sees only the chain the platform already validated, with no API to compare the
leaf against an out-of-band signed fingerprint. So a browser visiting a Flagship
service today falls back to CAA+CT only. **An extension can close that gap** by
reading the connection's leaf fingerprint and enforcing the same pin the phone
does. This is the marquee value and the only thing on this entire list that
raises the *security ceiling* rather than the convenience floor.

**(b) Seamless cross-site knock auto-detection.**
The webapp authorizes a knock only via a *pasted* link ("Process URL",
`access-authorize.js`) because a browser can't own the `flagship://` scheme, and
it only acts on its own origin. An extension runs on **every tab**, so it can:
detect a Flagship knock page on *any* `*.flagship.services` site you browse to,
recognize the `pageId`, and drive the authorize handshake (relayed to the phone,
or — if the same browser profile is signed in — surfaced inline) **without the
copy-paste detour**. This turns "restricted Flagship sites" from a deliberate
ceremony into an ambient "you're logged in everywhere your phone blessed"
experience, the always-on version of the knock flow. Genuine UX value, but it is
*convenience*, not a new security property.

### 1.3 The honest verdict

| Reason | New security ceiling? | Already solved elsewhere? | Browser-only? |
|---|---|---|---|
| Cert-pinning (a) | **Yes** | No (browsers can't) | **Yes — Firefox** (Chrome needs a native host, §3) |
| Cross-site knock (b) | No | Partially (webapp, same-origin, paste) | Yes |
| Directory / launcher (§7) | No | webapp can host it | No |
| In-browser trust sliver (§7) | No (mirrors mobile) | webapp shows it for its own origin | partial |
| Password-manager flow (§7) | No (and risky) | n/a | No |

**Build / don't build / build-later:** **BUILD-LATER.** Nothing is blocked on
it. When sequenced (§8), build the **Firefox** extension first for the real win
(a), fold in (b) for free, and treat Chrome as a convenience-only port unless a
native-messaging helper is independently justified. Do **not** build it as a
"full client" (§6) and do **not** let it accrete the §7 conveniences that don't
need a browser.

---

## 2. Pairing + auth flow (key-light)

The extension is provisioned **exactly like a QR-login knock session**, reusing
the built primitives, with one twist: instead of authorizing *one page*, the
phone authorizes a **standing session principal** (the extension instance) and
drops its scope/entitlements in a `.com`-blind bundle.

### 2.1 Pairing (phone authorizes the extension)

1. **Extension generates an ephemeral session identity** — a per-install
   Ed25519 keypair (the *session key*, NOT a UMK/IRK/AID), held in extension
   storage. It is a **bearer session principal**, disposable and revocable; it
   is never the account identity and never signs orders.
2. **Extension shows a pairing QR** containing
   `flagship://pair-extension?sess=<sessionPub>&nonce=<n>&exp=<t>` (a *new*
   sub-tag, sibling to `flagship://access`).
3. **Phone scans → confirms → authorizes.** The phone (the trust root, biometric-
   gated) verifies the user intends to pair this extension, then **AID-signs** a
   `ExtensionGrant` envelope — modeled on `KnockAuthorization`
   (`packages/protocol/src/serviceInvite.ts`) but binding the *session pubkey*
   and a *scope*, not a pageId:

   ```
   flagship/extension-grant/v1|<sessionPub>|<scope-hash>|<expiry>|<aid-or-irk-pub>|<issuedAt>
   ```

   The phone publishes two things to `.com`:
   - a **session record** (`extension_sessions` store, mirrors the secured-session
     model): `{ sessionPub, boundAID, browserAgent, scope-summary, startedAt,
     expiresAt, revokedAt }` — so the extension shows up in the phone's
     **"Open secured sessions"** list (§4) and is revocable there;
   - an **entitlement bundle**, AEAD-sealed under the **household key**
     (`deriveHouseholdKey(UMK)`, the same primitive `service-invite/v1` uses for
     the value-blind name/photo bundle) and *additionally* sealed-to-the-session
     (so only this extension can open it). `.com` stores **ciphertext only**.

### 2.2 The entitlement bundle on `.com` (what `.com` can / can't see)

The bundle is the extension's "what am I allowed to do" manifest, dropped on
`.com` exactly like the household bundle in `service-access-gating.md`
("`encryptedBundle` = AEAD(...) under a household key ... `.com` stores
ciphertext only"). Shape (plaintext, before sealing):

```jsonc
{
  "boundAID": "<aid pub>",            // who this extension acts as (stable, UMK-derived)
  "scope": {
    "kind": "knock-and-pin",          // see §4 — the only scope v1 grants
    "origins": ["*.flagship.services"],// the box/service namespaces it may act on
    "boxes": ["home.harry", ...]      // optional pin-trust restriction
  },
  "stkPubs": { "home.harry": "<hex>", ... }, // box STK pubs for offline pin verification (§3.4)
  "issuedAt": <ms>,
  "expiresAt": <ms>
}
```

**`.com` can see:** that *some* extension session exists for *some* account
(the session record carries `boundAID` + `browserAgent` + timestamps — the same
metadata leak the secured-session list already accepts), and the ciphertext
length. **`.com` cannot see:** the scope, the origins, the box list, or the STK
pubs — those are inside the household-sealed bundle. This is the **identical
content-blindness posture** the project already ships for service-invite bundles;
no new trust is extended to `.com`.

> **Why put it on `.com` at all** (vs. handing it to the extension directly over a
> box pipe)? Because the extension's *first* contact is a browser with no prior
> box relationship, and `.com` is the rendezvous the phone and extension share —
> exactly why the knock/invite bundles live there. The phone→extension channel is
> not direct (different devices, possibly different networks), so a `.com`-blind
> dead-drop is the natural fit and reuses proven code.

### 2.3 Session establishment + reuse vs. the knock flow

- **Reuse:** the AID-signed-envelope-to-box pattern, the household-sealed bundle,
  the "phone holds the handle, the browser holds an opaque cookie" split, the
  "Open secured sessions" management surface, the rate-limited/default-offline
  status polling. All four are lifted from `service-access-gating.md`.
- **Differs:** a knock authorizes **one page load**; the extension grant
  authorizes a **standing principal with a scope and an expiry**. When the
  extension later hits a restricted service's knock page, it does **not** need a
  fresh phone authorization per site if its scope already covers that origin and
  it holds a live session — it presents an AID-signed `ServiceVisitProof`
  (`flagship/service-visit/v1`, already built; `establish-session` on the daemon)
  derived from the bundle's AID, and the box mints the cookie. **This is the
  "always-on" upgrade:** the phone blesses *once* (the extension), then the
  extension transparently establishes per-site sessions within its scope. (How
  the extension proves the AID without holding the UMK is the central open
  question — §8 Q1; the leading answer is a *delegated narrow visit-signing
  capability*, NOT the UMK.)

---

## 3. Cert-pinning mechanism (the marquee feature) + its hard MV3 limits

### 3.1 What must happen (mirrors the mobile chain exactly)

Per Flagship origin `<server>.<user>.flagship.services` (and `<svc>.<server>.<user>`
under the box wildcard):

1. **Obtain the signed fingerprint.** The extension fetches `/pods` for the
   account (or receives the relevant `signedStatus` tuples in its bundle / from
   the phone at pair time). Each pod's `signedStatus = { report, signatureHex }`
   is the **verbatim STK-signed `DaemonStatusReport`** (`daemonStatus.ts`).
2. **Verify the signature LOCALLY.** Using the box STK pub from the bundle
   (`stkPubs`, §2.2 — NOT `.com`'s echo), Ed25519-verify the report. Apply the
   same gates as `CertPinRegistry.verifiedPin`: `serverDomain` matches, report
   fresh (`maxReportAgeMs`), `certSha256` is 64-hex. **Keep-last-known-good**
   (the SEC-1 rule): once pinned, a later missing/stale/tampered report does NOT
   clear the pin — only an explicit "box gone from `/pods`" signal does.
3. **Read the served leaf fingerprint** of the actual TLS connection to that
   origin (this is the hard part — §3.2/§3.3).
4. **Compare + HARD-FAIL.** Leaf DER-SHA-256 == pin → allow; mismatch → block
   the request/navigation and show the red sliver (§3.5). This is the pure
   `CertPinDecision.verdict` logic, identical to the mobile `CertPinVerdict`.

### 3.2 The MV3 reality — this is where Firefox and Chrome diverge sharply

**Firefox (works cleanly):** Firefox exposes
[`webRequest.getSecurityInfo()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest),
callable from `onHeadersReceived` when the listener is registered with
`"blocking"` in `extraInfoSpec`. It returns the TLS `certificates[]` chain
(DER available via `certificate.rawDER` when `"rawDER"` is requested), from which
the extension computes the **exact leaf DER-SHA-256 the daemon reports**. Firefox
still supports blocking `webRequest`, so the extension can **cancel** the request
on a mismatch before content loads. This gives the *full* mobile-equivalent
hard-fail. **The marquee feature is fully realizable in Firefox.**

**Chrome (barely works):** Chrome MV3 **removed blocking `webRequest`** for
extensions (it's enterprise-policy-only) in favor of `declarativeNetRequest`,
and Chrome **never implemented `getSecurityInfo()`** at all. There is **no MV3
API to read the served leaf certificate of a page's own connection.**
`chrome.platformKeys` is for client-auth certs the extension *presents*, not for
inspecting the *server's* cert; `declarativeNetRequest` matches on URL/headers,
not cert fingerprints. Net: **a pure-Chrome MV3 extension cannot do
cert-pinning.** The W3C WebExtensions group has an open proposal to standardize a
`securityInfo` API
([w3c/webextensions#882](https://github.com/w3c/webextensions/issues/882))
precisely because of this gap, but it is not shippable today.

**Chrome escape hatch (and why it hurts the model):** the only way to get the
leaf fingerprint in Chrome is a **native-messaging host** — a separately-installed
native binary the extension talks to, which opens its own TLS probe to the box
and reports the fingerprint (or proxies the connection). That reintroduces an
**installed binary with native privileges** — the exact thing the key-light,
no-binary model was chosen to avoid — and a native probe is *a different
connection* than the page's, so it doesn't even prove the *page's* leaf matches
(a sophisticated MITM could serve the real cert to the probe and a rogue cert to
the page). **Conclusion: cert-pinning is a Firefox feature.** In Chrome, either
ship it convenience-only (no pin) or accept a native host with its weaker
guarantee — a decision to make deliberately (§8 Q2), not paper over.

### 3.3 Defense-in-depth even where the API exists

`getSecurityInfo` reflects what the *browser's* network stack negotiated. An
extension is not a lower layer than the TLS stack, so it cannot be the *sole*
guarantor against a kernel/stack-level compromise — but neither can the mobile
apps; both pin at the application layer above a validated handshake (note
`BoxCertPinning.swift` runs `SecTrustEvaluateWithError` FIRST, then narrows). The
extension does the same: **default chain validation must pass first, then the pin
narrows trust.** This is a real, meaningful strengthening (it catches a CA-valid
rogue `.com` cert), stated honestly as application-layer pinning, not magic.

### 3.4 Where the STK pubs come from (so verification is `.com`-independent)

The whole point is that `.com` can relay but not forge. So the extension must
verify `signedStatus` under a STK pub it did **not** get from `.com`. Two
sources, in order:
1. **At pair time**, the phone (which derives STK pubs locally from the UMK)
   includes the relevant `stkPubs` in the household-sealed bundle (§2.2). This is
   the trustworthy path — the pub originates at the trust root.
2. **On a new box** appearing after pairing, the extension can't derive the STK
   (no UMK) — so a box the phone never blessed gets **no pin** (default TLS
   stands), exactly like the mobile "no cached STK pub ⇒ no pin" rule
   (`CertPinRegistry` doc comment). Adding a box to the extension's pin-trust set
   requires a phone re-bless (cheap, deliberate).

This mirrors the mobile invariant: **`.com`'s `identityPubKey` echo is never a
trust input.**

### 3.5 Hard-fail UX (mirror the mobile pin-fail + the red sliver)

On a `.mismatch`, the extension:
- **blocks** the navigation/request (Firefox: cancel in `onHeadersReceived`);
- shows a **non-dismissible red banner/sliver** — the same shape and copy the
  app uses, *"Someone may be intercepting this box (`<slug>`)."* — reusing the
  `trustSliver.js` contract (one line per failing host slug = first-8-of-hash);
- offers **no one-tap "proceed anyway"** in the page (a casual bypass defeats the
  pin). Any override must be a deliberate, phone-confirmed action recorded like a
  `TrustException` — and even then the red line persists (the
  `serverTrust.js`/`TrustCenter.swift` rule: override un-halts traffic but the
  degraded state stays visible). For v1, the safest stance is **no browser-side
  override at all** — a pin mismatch on a Flagship box is a genuine alarm.

---

## 4. Scoped-session + revocation model

### 4.1 Scope the bundle grants (deliberately narrow in v1)

`scope.kind = "knock-and-pin"` — the v1 extension may:
- **enforce cert pins** on origins in `scope.origins` (read-only verification —
  needs no signing capability at all);
- **establish service sessions** within scope by presenting an AID-derived
  `ServiceVisitProof` to a box's `establish-session` (the always-on knock).

It may **NOT**: create/revoke invites, change service access mode, send phone
orders, mint certs, read account secrets, or act outside `scope.origins`. The
extension is a *visitor + verifier*, never an *admin*. (Admin stays phone-only;
the webapp covers admin on its own origin.)

### 4.2 Revocation (phone "Open secured sessions" → kills the extension)

- The session is listed in the phone's **Settings → "Open secured sessions"**
  (the existing surface, `securedSessions.js` / `views/secured-sessions.js`),
  carrying `{ browserAgent, startedAt, scope-summary }`.
- **Stop** there marks `revokedAt` on the `.com` session record (the
  secretId/sessionPub-authed close path) AND, because access follows the AID
  allow-list re-checked per request (`serviceAccessWeb.ts`), any box cookies the
  extension established die on the next request once the AID/session is pruned.
- **Pin-only enforcement keeps working after revoke is irrelevant** — pinning
  needs no live session; but revoking the session stops the extension from
  establishing *new* access. (If we want revoke to also disable pin enforcement,
  that's a policy choice — generally we'd keep pinning on, it only ever *refuses*
  connections.)

### 4.3 Expiry + multi-box

- **Expiry:** the grant carries `expiresAt` (default short, e.g. 7–30 days);
  past it the extension must re-pair. Mirrors the secured-session model and the
  cert-model's "short-lived is safer" instinct. A desktop is a softer target than
  a phone, so the expiry should be *shorter* than a phone device-key's, not
  longer.
- **Multi-box:** `scope.origins`/`scope.boxes` + `stkPubs` are per-account and
  may list several boxes; the pin registry keys by box FQDN exactly like
  `CertPinRegistry.pinFor` (exact host or any host under the box wildcard
  `*.<server>.<user>`). Adding a box = phone re-bless (re-drop the bundle with the
  new box's STK pub).

---

## 5. MV3 manifest + permissions (minimum, with the privacy cost of each)

| Permission | Why needed | Privacy/security implication |
|---|---|---|
| `host_permissions: ["*://*.flagship.services/*"]` (+ any custom-domain hosts) | run the content script that detects knock pages + the pin enforcement on Flagship origins ONLY | **Scoped to Flagship namespaces — NOT `<all_urls>`.** This is the single most important restriction: the extension must never request all-sites host access. A reviewer/user can see it only touches `flagship.services`. |
| `webRequest` + `"blocking"` (**Firefox only**) | call `getSecurityInfo()` and cancel on pin mismatch | Firefox blocking webRequest can read/cancel requests *to the scoped hosts only*. The scope cap above bounds it. Not available in Chrome MV3 (§3.2). |
| `declarativeNetRequest` (Chrome) | the MV3-blessed request-modification path; used for any redirect/block rules (NOT cert reads) | Rules are static/declarative; the extension can't read request *content*. Weaker but safer-by-design. |
| `storage` | hold the session keypair, the (sealed) bundle, the pin registry, the secured-session record | Local extension storage. The session key is the most sensitive item — see §6 blast radius. Prefer session-only / non-persistent where possible. |
| `scripting` (content script, declared on the scoped hosts) | inject the knock auto-detect + the in-page red sliver on Flagship pages | Runs only on scoped origins. No `tabs`/`activeTab` over arbitrary sites. |
| `alarms` | periodic `/pods` refresh of `signedStatus` + expiry checks (MV3 service workers are ephemeral) | Benign; just scheduling. |
| **NOT requested:** `<all_urls>`, `tabs` (broad), `cookies` (broad), `nativeMessaging` (unless the Chrome-pin host is adopted, §3.2 / §8 Q2), `webRequestBlocking` on Chrome | — | Each of these would materially widen the attack surface; their *absence* is a design statement. `nativeMessaging` in particular is the line between "key-light, no binary" and "installs a privileged native host". |

**The host-permission ask is the big one and must be addressed head-on:** even
scoped to `*.flagship.services`, host permission means the extension can read page
content and the TLS info of every Flagship site you visit. Mitigations: (1) cap
strictly to Flagship namespaces (never `<all_urls>`); (2) the content script does
the *minimum* — detect a knock page's `pageId` + render the sliver — and does not
exfiltrate page content anywhere; (3) document the data-handling in the store
listing; (4) consider Firefox's optional/runtime host permissions so the user
grants per-namespace. The store-review surface and the update channel (§6) are
where this permission becomes dangerous if the extension is ever compromised.

---

## 6. Threat model — the extension as a NEW attack surface

### 6.1 The core asymmetry the key-light model rests on

> A desktop browser extension is a **softer target than the phone.** Desktops are
> multi-program, long-lived, malware-prone, and the extension's code can be
> silently updated by the store. The phone, by contrast, is the biometric-gated
> trust root holding the UMK. **Therefore the extension must never hold key
> material whose compromise = account compromise.** This is *the* reason the
> owner chose key-light, and §6.3 quantifies the payoff.

### 6.2 Why NOT a "full client" (extension holds a scoped/delegated signing key)

A "full client" extension would hold a delegated signing key (a narrowed IRK/AID
capability) so it could sign orders/visits autonomously. Rejected because:
- **Blast radius.** A compromised key-holding extension can act *as the account*
  within the key's scope — and a scoped signing key on a soft target is exactly
  the "device-key on a desktop" risk the project avoids. Compare: the mobile apps
  gate the UMK behind biometrics *per signing op*; an extension has no equivalent
  per-op human gate, so a key it holds is effectively always-hot.
- **Malicious-update amplification.** If the store pushes a malicious update
  (§6.4) to a key-*holding* extension, the attacker gets a usable signing key. To
  a key-*light* extension, the same malicious update gets only a revocable,
  scoped, expiring session bearer — which the phone can kill (§4.2) and which
  can't sign orders at all.
- **Recovery coupling.** A device key folds into the recovery/rotation machinery
  (re-pair, wipe-restart). Adding the extension as a key-holder entangles a soft
  target with account recovery. Key-light keeps it a *leaf* — losing it is a
  revoke, never a recovery event.

The key-light cost is that the extension can't act *fully* offline-from-the-phone
forever (it re-pairs on expiry, and the visit-signing capability is narrow). That
cost is the point.

### 6.3 Blast radius under the key-light model

What a **compromised / malicious extension** CAN do:
- act as a **visitor** to services within `scope.origins` for the life of the
  session (read/use restricted Flagship sites the user could already reach);
- read page content on scoped Flagship origins (host permission);
- *suppress* its own pin enforcement (fail-open by simply not checking) — note
  this is a *downgrade to the browser's default CAA+CT posture*, i.e. it can
  remove the *extra* protection it was meant to add, but it cannot *forge* trust
  or make a bad cert look good to the phone.

What it CANNOT do (the containment):
- **sign orders, create/revoke invites, change access mode, mint certs** — no
  key for any of it;
- **act as the account** anywhere — the AID/UMK never enter the extension; the
  visit-signing capability (if delegated, §8 Q1) is narrow and revocable;
- **escalate to other accounts** or to `.com` content (`.com` only ever held
  ciphertext);
- **persist past a phone revoke** — Stop in "Open secured sessions" kills the
  session and the per-request AID re-check kills the cookies;
- **forge a pin** — the pin is verified under a phone-originated STK pub; the
  worst it does is *not enforce*, never *mis-enforce*.

So the phone-as-trust-root **bounds the damage to "an extra logged-in browser
session the owner can see and kill"** — strictly less than handing someone the
webapp's UMK, and far less than a key-holding full client.

### 6.4 Store distribution + update-channel trust (the classic extension risk)

The single largest real-world risk for *any* extension is a **malicious update**
(the developer account is phished, or the extension is sold to a bad actor and a
later version turns hostile — a well-documented attack pattern). Under key-light
this is *contained* (§6.3) but not zero: a hostile update still gets host
permission on Flagship origins and a live session. Mitigations to design in:
- **Minimize what an update can newly do** — the permission set is fixed and
  narrow; a hostile update can't silently request `<all_urls>` without a
  permission re-prompt (MV3 surfaces new permissions to the user).
- **Reproducible builds + a published source map** so the shipped artifact can be
  audited against the repo (Firefox AMO supports source-upload review; this is a
  reason Firefox-first is also *safer* to ship).
- **Pin the extension's own update integrity** where the store allows, and
  publish the expected extension ID + signing key in `docs/` so users can verify.
- **Phone-side visibility** — because every paired extension shows in "Open
  secured sessions" with `browserAgent`, a user can spot and kill an extension
  they don't recognize. The phone is the audit surface even for the extension.
- **Treat the extension as untrusted-by-construction in the protocol** — the
  whole design assumes the extension *could* be hostile and bounds it; that's why
  it holds no keys and `.com` holds no plaintext.

### 6.5 Residual risks to state plainly

- **Page-content read** on scoped origins is inherent to host permission; a
  hostile extension could scrape what the user sees on their own Flagship sites.
  No protocol fixes this — it's the cost of an in-page agent. (The phone/webapp
  don't have this exposure for *other* surfaces.)
- **Chrome cert-pin gap** (§3.2) means the marquee security property silently
  doesn't exist on Chrome unless a native host is added — users must not be told
  "you're pinned" on a browser where they aren't. Surface the actual posture
  per-browser.
- **DNS-rebinding / origin confusion** on `scope.origins` matching must be exact
  (leftmost-label + suffix, like `CertPinRegistry.pinFor`), or a lookalike host
  could be treated as in-scope.

---

## 7. "Other useful features" — worth it vs. scope-creep

| Feature | Verdict | Rationale |
|---|---|---|
| **In-page knock auto-detection** | **Worth it (core)** | This IS reason (b), §1.2. The single best convenience win and only an extension can do it cross-site. |
| **Cert-pin enforcement + red sliver** | **Worth it (core)** | Reason (a). The security win. Firefox-clean (§3). |
| **Flagship-services directory / launcher** (a popup listing your boxes/services with one-click open to the tier-1 canonical URL) | **Nice, but NOT extension-justified** | The webapp can host this on its own origin without host permissions on every site. Build it in the webapp; if the extension popup *also* shows it, fine as a thin convenience, but don't make it a reason to build the extension. |
| **Maintainer-trust red sliver in-browser** (mirror `serverTrust.js` for any Flagship origin) | **Worth it, small** | The extension already renders a red sliver for pin failures; extending it to surface the control-server blessing failure for the active Flagship origin is cheap and consistent with mobile. Keep it identical to the `trustSliver.js` contract. |
| **Password-manager-like autofill / credential flow** | **Scope-creep — avoid in v1** | Pulls the extension toward holding/handling secrets (the opposite of key-light) and toward `<all_urls>`-shaped behavior. Flagship auth is the knock/AID model, not passwords; a credential-filler is a different, riskier product. Explicitly out. |
| **"Process URL" paste fallback in the popup** | **Worth it, trivial** | Mirror the webapp's paste-authorize for the no-QR-scanner case; pure convenience, no new surface. |
| **Per-site "is this a real Flagship box?" badge** | **Worth it, small** | A toolbar badge that's green only when the pin verified is a clean way to make the security property *visible* (and to honestly show "not pinned" on Chrome). |

**Principle:** anything that (1) needs to act cross-site or (2) makes a security
property *visible/enforced in the browser* belongs in the extension; anything
that's just a convenient view of account data belongs in the **webapp** (no host
permissions, no new attack surface). Resist moving secret-handling into the
extension.

---

## 8. Open questions / risks / sequencing

### 8.1 Must be decided before a build

- **Q1 — How does the extension prove the AID for `establish-session` without the
  UMK?** This is the crux of "always-on within scope." Options: (a) the phone
  delegates a **narrow, expiring visit-signing capability** (sign only
  `flagship/service-visit/v1` for scoped origins) — a *capability*, not the
  AID/UMK, revocable, the smallest possible signing grant; (b) the phone
  pre-mints a **batch of single-use visit proofs** the extension spends (no
  signing key in the extension at all — strongest, but bounded count / needs
  refresh); (c) **per-site phone approval** (no autonomy — safest but defeats
  "always-on", collapses to the webapp's paste flow). **Leaning (b) then (a):**
  (b) is the purest key-light (extension holds *no* signing key, only spendable
  bearer proofs); (a) if the UX of running out of proofs is too rough. **(c) is
  the safe fallback if we want zero extension-side signing in v1** — ship pinning
  + paste-authorize only, no autonomy.
- **Q2 — Chrome: native host or convenience-only?** Decide whether the Chrome
  build ships **no pinning** (convenience-only, honest badge says "not pinned")
  or adopts a **native-messaging helper** (full pin, but an installed privileged
  binary + the probe-vs-page caveat, §3.2). The key-light spirit argues
  convenience-only for Chrome v1; revisit if/when the W3C `securityInfo` API lands
  ([w3c/webextensions#882](https://github.com/w3c/webextensions/issues/882)).
- **Q3 — New protocol envelopes.** `flagship/extension-grant/v1` (§2.1) and the
  `extension_sessions` `.com` store + the bundle's sealed-to-session layer need
  speccing into `packages/protocol` + `.com` storage, with cross-platform vectors
  (the project's bar — every signed message has a pinned TS/Swift/Kotlin vector).
  Confirm the grant binds *session pub + scope + expiry* and reuses the
  household-key seal verbatim so `.com`-blindness is provably the same as
  `service-invite`.
- **Q4 — Override policy on pin mismatch.** Recommend **no in-browser override in
  v1** (a Flagship-box pin mismatch is a true alarm). If an override is ever
  added, it MUST be phone-confirmed and recorded like a `TrustException`, with the
  red line persisting (the existing `TrustCenter` rule). Decide now so the UX
  doesn't grow a casual bypass.
- **Q5 — Scope granularity.** Is `scope.origins` per-account (all my boxes) or
  per-box? Per-box is tighter (a compromised extension reaches fewer services) but
  more pairing friction. Decide the default.

### 8.2 Risks carried forward

- The **Chrome marquee-gap** could make the feature feel half-delivered if shipped
  Chrome-first; sequence Firefox-first to avoid shipping a "pinning" extension
  that doesn't pin.
- **Host-permission review friction** on both stores; the narrow scope helps but
  the listing must over-explain the data handling.
- **Malicious-update containment** depends on the protocol genuinely holding no
  keys and `.com` holding no plaintext — any future "just let the extension do X"
  shortcut that adds a key silently re-opens §6.2. Guard this invariant.

### 8.3 Sequencing against the roadmap

This is **strictly behind** the current critical path (`CLAUDE.md`: GA close-out,
hardware boot/unlock e2e, store-shipping the phone apps, the marketplace/retail
launches). Concretely:
1. **Do not start until the phone apps are on TestFlight/Play** — the extension
   is the *always-on companion to the phone*, and the phone flows (knock,
   secured-sessions, pinning) must be live + dogfooded first. Several extension
   pieces (the secured-session list, the pin registry, the knock envelopes) are
   the *phone's* surfaces; they should be proven before a second consumer leans on
   them.
2. **Branch `feat/browser-extension` off `main`** (per the branching gate), or off
   whichever feature branch ships the final knock/secured-session client wiring if
   it depends on it (dependencies go through git, per `CLAUDE.md`).
3. **Build order within the branch:** (1) the new protocol envelopes + `.com`
   store + vectors (Q3); (2) the **Firefox** extension delivering pinning (a) +
   knock auto-detect (b) with the paste-authorize fallback and **no extension-side
   signing** (Q1 option c) for the first cut; (3) add scoped autonomy (Q1 b/a)
   once the no-autonomy version is proven; (4) decide Chrome (Q2) — port
   convenience-only or add the native host. Each step gated like the rest of the
   repo (`tsc -b` + vitest + the cross-platform vector freshness check).

**Bottom line for the owner:** the extension is a *real but narrow* win —
browser cert-pinning is a genuine security strengthening only an extension can
deliver, and cross-site knock is a genuine convenience. But it's **Firefox-clean
/ Chrome-compromised**, **nothing is blocked on it**, and it adds a soft attack
surface that the key-light model contains well *only if the no-keys invariant is
held forever*. **Build it later, Firefox-first, key-light, and scoped to exactly
the two browser-only wins — not as a full client and not as a feature dumping
ground.**

---

## Files / flows this design is grounded in

- Knock / QR-login web-experience gating: `docs/service-access-gating.md`
  ("Web-experience gating"), `packages/server-daemon/src/serviceAccessWeb.ts`,
  `packages/server-daemon/src/qrSvg.ts`,
  `apps/web/public/webapp/views/access-authorize.js`,
  `apps/web/public/webapp/lib/securedSessions.js`.
- Knock / invite / visit / household-bundle protocol:
  `packages/protocol/src/serviceInvite.ts`
  (`flagship/service-knock/v1`, `flagship/service-visit/v1`,
  `flagship/service-invite/{create,redeem,revoke,bundle}/v1`, `deriveHouseholdKey`).
- Cert-fingerprint pinning (the chain the extension mirrors):
  `packages/protocol/src/daemonStatus.ts`,
  `packages/server-daemon/src/daemonStatusHeartbeat.ts`,
  `apps/mobile/shared/Sources/FlagshipCore/CertPinRegistry.swift`,
  `apps/mobile/shared/Sources/FlagshipAPI/Client/BoxCertPinning.swift`,
  `apps/mobile/android/app/src/main/java/com/flagshipserver/app/core/CertPinInterceptor.kt`,
  `docs/cert-model-A-prime-migration.md` (§"Cert-fingerprint pinning"),
  `docs/per-user-cert-and-addressing.md` (§4.3 CAA + CT).
- Maintainer-trust red sliver + halt (the in-browser-trust pattern):
  `apps/web/public/webapp/lib/serverTrust.js`,
  `apps/web/public/webapp/lib/trustSliver.js`,
  `apps/mobile/shared/Sources/FlagshipCore/TrustCenter.swift`,
  `packages/control-plane/src/pubkeyCert.ts` (`handleMaintainerBlessing`),
  `apps/com/src/controlPlaneRoutes.ts` (`/api/maintainer-blessing`).
- MV3 / browser-API constraints (external): Firefox
  [`webRequest.getSecurityInfo()`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest);
  the cross-browser gap proposal
  [w3c/webextensions#882](https://github.com/w3c/webextensions/issues/882).
