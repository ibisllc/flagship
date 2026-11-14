# Flagship for Firefox

A Firefox extension (Manifest V3, Firefox 140+) that does two things a browser can't do on its own:

1. **Certificate pinning.** For every page and request under `*.flagship.services` (and `*.fshp.app` direct names) it
   reads the leaf certificate Firefox used (`webRequest.getSecurityInfo`) and compares it with the fingerprint the box
   itself signed (`flagship/daemon-status/v1`), verified under the server key the owner's **phone** pinned. A paired
   box serving any other certificate is cancelled before the page loads and the tab shows a warning page with no
   "continue anyway". The same rule as `CertPinRegistry` on iOS and Android.
2. **Knock detection.** On a Flagship sign-in page it shows a bar saying whether the page belongs to the site it is on
   and whether its certificate checked out, and warns when a page shows a sign-in code for another site (the QR-relay
   trick). The bar's button opens the page's own app link; the phone signs the knock with the visitor's per-app
   identity. The extension never signs anything.

It is **key-light**: pairing with the phone (a QR code over the `/qr-pipe` relay, the Remote ceremony with its own
`flagship/extension-pair/v1` payload) gives it a 30-day box session that can read only the box's signed certificate
fingerprint (`GET /api/companion/cert-pin`). The owner revokes it in the app under the server's Remote / Browser
sessions ("Firefox extension"). Design and threat model: `docs/browser-extension.md`.

## Layout

```
manifest.json            MV3, gecko id firefox-extension@flagshipserver.com
_locales/                GENERATED from i18n/browser-extension (scripts/i18n-browser-extension.mjs build)
src/background.js        the pin check (blocking onHeadersReceived) and the evidence refresh
src/lib/                 pure modules: pinCheck, daemonStatus, pairing, knockDetect, store, config, qrEncoder, i18n
src/content/knock.js     the knock bar (closed shadow root)
src/pages/               pair.html (QR + 6-digit code), blocked.html (pin mismatch)
src/popup/               toolbar popup: this site's verdict, paired servers, forget
tests/                   vitest (run from the repo root)
```

## Load it temporarily (development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox 140 or later.
2. **Load Temporary Add-on…** and pick `apps/browser-extension-firefox/manifest.json`.
3. Click the toolbar button, **Allow** the Flagship sites permission (Firefox grants MV3 host permissions only when
   asked), then **Pair with your phone** and scan the code with the Flagship app (iOS or Android build with the
   extension pairing; the server needs a box release with `mint-extension-ticket`).

A temporary add-on is removed when Firefox quits. Or, from the repo root:

```sh
npx web-ext run --source-dir apps/browser-extension-firefox
```

## Test, lint, build

```sh
npx vitest run apps/browser-extension-firefox          # unit tests (pin check, pairing, knock, manifest, locales)
node scripts/i18n-browser-extension.mjs check          # also part of npm run i18n
npx web-ext lint  --source-dir apps/browser-extension-firefox --ignore-files 'tests/**'
npx web-ext build --source-dir apps/browser-extension-firefox --ignore-files 'tests/**' README.md \
    --artifacts-dir /tmp/flagship-xpi --overwrite-dest
```

`web-ext build` writes an unsigned `flagship-<version>.zip`, which is the `.xpi` to upload. Firefox release builds
install only signed add-ons: sign it through addons.mozilla.org (listed, or unlisted for self-distribution) with
`npx web-ext sign --channel unlisted --api-key … --api-secret …`. Signing needs the owner's AMO account and API key.

## Text

Every string comes from `i18n/browser-extension/` (English plus es, fr, de, pt-BR, ja, zh-Hans). Add a key to `en.json`
and every language file, use it as `t("key")` in a page, `browser.i18n.getMessage("key")` in the background or the
content script, `data-i18n="key"` in HTML or `__MSG_key__` in the manifest, then run
`node scripts/i18n-browser-extension.mjs build` and `accept <key>`. See `docs/i18n.md`.
