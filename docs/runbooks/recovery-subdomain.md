# Runbook: `recovery.flagshipserver.com` sub-origin

WebAuthn-PRF recovery lives at a dedicated sub-origin so an XSS on
the marketing apex or webapp cannot exfiltrate the wrapped UMK. This
runbook covers the DNS + Cloudflare setup needed before deploying.

## Background

Before Task #73 the recovery flow shared `rpId = "flagshipserver.com"`
with every other page on the apex. A successful XSS anywhere on
`flagshipserver.com` or `webapp.flagshipserver.com` could call
`navigator.credentials.get()` against that rpId and exfiltrate the
wrapped UMK. The fix is to put the credential behind its own rpId —
`recovery.flagshipserver.com` — which the browser's same-origin policy
enforces is reachable only from code served from that origin.

## DNS — Cloudflare record

The new host must resolve. We use a CNAME chain to the apex (proxied
through Cloudflare so universal SSL covers it).

```sh
# Find your zone id:
cd apps/com
ZONE_ID=$(npx wrangler whoami | rg -o '[0-9a-f]{32}')

# Create the proxied CNAME. Replace `${CF_DNS_TOKEN}` with a Cloudflare
# API token that has Zone:DNS:Edit on flagshipserver.com.
curl -fsS -X POST \
  -H "Authorization: Bearer ${CF_DNS_TOKEN}" \
  -H "content-type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
  -d '{
    "type": "CNAME",
    "name": "recovery",
    "content": "flagshipserver.com",
    "proxied": true,
    "ttl": 1
  }'
```

After the record propagates, verify:

```sh
dig +short recovery.flagshipserver.com
curl -fsS -I https://recovery.flagshipserver.com/ | head
```

## Worker route

`apps/com/wrangler.toml` already declares the route as part of the
canonical `routes` array. To pick it up:

```sh
cd apps/com
npx wrangler deploy
```

`wrangler deploy` reconciles routes to exactly the listed set, so don't
pass `--routes` on the command line — always edit the toml and redeploy
(see the gotcha note at the top of `wrangler.toml`).

## CSP

Every response served from `recovery.flagshipserver.com` carries:

```
content-security-policy: default-src 'self'; script-src 'self'; ...
x-frame-options: DENY
referrer-policy: no-referrer
x-content-type-options: nosniff
```

The CSP forbids inline scripts (`'unsafe-inline'` is **not** allowed),
inline styles, third-party fonts, third-party connections (only
`https://flagshipserver.com` is permitted via `connect-src` for the
`/api/recovery/*` POST/GET/DELETE calls), and iframing (both
`frame-ancestors 'none'` and `X-Frame-Options: DENY`).

If you need to add a new asset (e.g., a custom font) place it under
`apps/web/public/recovery/` and reference it with a same-origin path.
Anything that requires external resources should be rejected.

## What lives where

```
apps/web/public/recovery/index.html  # single-purpose page
apps/web/public/recovery/recovery.js # ES module — WebAuthn + crypto
apps/web/public/recovery/recovery.css
```

The page is opened by the webapp via
`window.open("https://recovery.flagshipserver.com/#enroll" | "#recover")`
and communicates back via `postMessage`. The webapp keeps the IRK +
identity logic; the sub-origin only owns the WebAuthn passkey and the
AES-GCM wrap.

## Rotation / re-enrollment

The rpId change means any pre-existing passkey (created against
`flagshipserver.com`) is unusable from the new origin. Affected users
must re-enrol via the webapp's *Settings → Recovery → Set up cloud
recovery* button. This is acceptable for the current pre-launch
install base; once we go public, future rpId changes should require
a guided migration flow.

## Apex redirect

`flagshipserver.com/recovery/*` 308-redirects to
`recovery.flagshipserver.com/*` so accidentally-shared apex URLs
land on the canonical origin. The redirect is enforced by the Worker;
the asset binding never has a chance to serve the recovery page from
the apex even if static files happen to exist there.

## CORS

`recovery.flagshipserver.com` is in `CORS_ALLOWED_ORIGINS` on the
Worker, so the page's `fetch(APEX + "/api/recovery/...")` calls succeed
with cross-origin credentials disabled (we never use cookies).

## Testing locally

`workerd` reports the configured zone host instead of the actual
request host. Use the `x-flagship-effective-host` header trick the
Worker honours for tests:

```sh
curl -H 'x-flagship-effective-host: recovery.flagshipserver.com' \
  http://localhost:8787/
```
