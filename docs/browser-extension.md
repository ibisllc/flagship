# Flagship for Firefox (browser extension)

Built in 0.4 (journal F16, owner 2026-11-14), Firefox only. Code: `apps/browser-extension-firefox/` (README there for
loading, testing and building). The earlier build-decision design, with the full motivation and threat-model argument,
is on branch `feat/browser-extension` (`git show feat/browser-extension:docs/browser-extension.md`); this page is what
was built.

## As built

**Model: key-light.** The extension holds no account key, device key or signing key. Pairing gives it one box session
per server that reads only that box's signed certificate fingerprint. The phone stays the trust root.

### Pairing

1. The extension's pairing page opens a `/qr-pipe` relay session as `browser` and shows
   `https://flagshipserver.com/pair-extension?s=<sid>&k=<X25519 key>` as a QR. `.com` serves the open-in-app page at
   that path and the AASA claims it.
2. The phone (iOS `CompanionDockViewModel` extension mode, Android the same) joins as `phone`; both screens show the
   same 6-digit code (the Remote derivation, `flagship/qr/v1`).
3. The owner picks a server and approves with a biometric. The phone calls the owner-gated
   `POST /api/screens/companion/mint-extension-ticket` (an older box answers 404, so it never hands out a Remote
   ticket) and seals `{kind: "flagship/extension-pair/v1", ticketId, ticketSecret, username, serverDomain, podBaseUrl,
   stkPubHex}`, where `stkPubHex` is the server key **the phone pinned**, never one `.com` or the box reports.
4. The extension checks the payload (the server must be `<label>.<username>.flagship.services`, named the same way in
   `serverDomain` and `podBaseUrl`; a Remote ticket is refused) and redeems the ticket at `POST /api/companion/redeem`.
   It keeps the session only when the reply says `scope: "extension"`.

The box's extension session lasts 30 days, is refused by the paired-session gate on every route, and opens only
`GET /api/companion/cert-pin`, which returns a fresh STK-signed `flagship/daemon-status/v1` report with no apps. The
owner sees it as "Firefox extension" in the companion and Browser sessions lists and revokes it like a Remote session.

### Pinning

A blocking `webRequest.onHeadersReceived` listener over `https://*.flagship.services/*` and `https://*.fshp.app/*`
reads the connection's leaf with `webRequest.getSecurityInfo` (Firefox only; Chrome has no equivalent, which is why
this is Firefox-only). Firefox's own validation runs first: the pin only narrows a valid connection.

* A box name and every name under it share the box's wildcard certificate; matching is by whole labels.
* **match**: the leaf is the one the box signed, signature under a week old. **mismatch**: a paired box's name served
  another leaf: the request is cancelled and a top-level page is replaced with `blocked.html` (no "continue anyway";
  "Check again" refetches the box's word). **expired-evidence** / **no-evidence**: allowed, with a toolbar badge.
  **unknown-name**: not a paired box, Firefox's checks stand.
* Before deciding on anything but a match, the background page fetches `cert-pin` over the box session with a nonce
  (one refresh per box at a time, 8 s). The report is taken as the new pin only if it verifies under the phone-pinned
  key, names this server, is fresh (at most a week old, at most 10 minutes ahead), is not older than the pin held, and
  names **the leaf of the very connection that carried it** (otherwise someone relayed it). A renewal therefore moves
  the pin without the phone; an interceptor cannot, since it cannot forge the box's signature over its own leaf.
* A 401 ends the session only when it came over a connection with the pinned certificate.
* A direct name (`*.fshp.app`) belongs to no box by name: it is a match only when its leaf is one a paired box signed.

### Knock detection

The content script looks for the box's access link (`https://flagshipserver.com/access#server=&svc=&ref=&page=`) on
Flagship pages. A link for this very site gets a bar (green when the pin matched, otherwise informational) whose
button opens the link, so the phone signs the knock with the visitor's per-app identity (`flagship/app-aid/v1`). A
link for another site, a look-alike host, or two different sign-ins on one page get a red "Don't scan this sign-in
code" bar and no button. The bar lives in a closed shadow root.

### Text

`i18n/browser-extension` (resource-name keys, `translated-from.json`), built into `_locales/` by
`scripts/i18n-browser-extension.mjs`, checked by `npm run i18n`. Languages: en, es, fr, de, pt-BR, ja, zh-Hans (machine
drafts, to be reviewed with the rest).

## Open

* AMO: the owner's account, the listing, and signing (`web-ext sign`); until then it loads only as a temporary add-on.
* Strict (quantum-safe) servers: the extension verifies the classical Ed25519 signature of the report only.
* The phone pairs one server per scan; pair each server separately.
* Not run yet against a live box or a real phone.
