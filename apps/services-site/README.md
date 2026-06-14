# flagship-services-site

> ⚠️ **TEMPORARY DEPLOY — decommission when transition completes.**
> This exists only to give the former operator of the `flagship.services`
> URL a grace window to transition off it (migrate their site/email to a
> new home). It is **not** part of the Flagship product and is **not** a
> long-term commitment to host this content at the apex. Once the former
> operator has moved, **remove this app, detach the apex/`www` Custom
> Domains, and delete the `flagship.services` apex DNS records** so the
> name is free for product use. Flagged here so it surfaces in reviews and
> isn't forgotten. (Set up 2026-06-06.)

The legacy startup marketing site (the unpacked `old_website.zip`), served
as a standalone Cloudflare Worker so `https://flagship.services/` is back
online.

## Why this is isolated from the data plane

`flagship.services` on Fly is a **raw-TCP SNI passthrough** pipe: browser
TLS on `:443` is spliced over the tunnel WebSocket to a user's home
daemon, where TLS terminates. That routing is keyed on per-pod
subdomains (`<server>.<user>.flagship.services`), whose DNS records are
created on demand by the daemon through `apps/dns-broker`.

This Worker attaches **only to the bare apex and `www`** — names that
carry no pod traffic and (verified 2026-06-06) had no DNS record at all.
So bringing the marketing site back touches nothing on the data plane.

## `/api/health`

The site is otherwise pure static assets, but the Worker (`src/index.ts`)
intercepts `/api/health` and returns JSON (`{ ok, service, surface:
"apex-placeholder", note, now }`). Before this, the bare `[assets]` site's
SPA fallback returned `200` + `index.html` for `/api/health`, which lies
to uptime monitors — a `200` with HTML reads as "healthy" to a naive
check. The endpoint reports `surface: "apex-placeholder"` so monitors can
tell this apart from the `.com` control plane or a real pod.

## TODO — the apex becomes the marketplace home

This placeholder is temporary. Once the former-operator transition
completes and it's decommissioned, the `flagship.services` **apex** is the
intended home of the **Flagship marketplace**, which will host:

- the marketplace **listings UI** (browse / search / install apps);
- the **GitHub-equivalent code host** (Forgejo) for app source + releases;
- the **app security-scan service** — pull the app's docker image, run
  Trivy + custom checks, and post back `marketplace_listings.scan_grade`
  plus an R2 report. (Today that column ships `NULL`; see
  `docs/build-tasks.md` item 4 "Marketplace security scan service.")

When that lands, replace this static-asset Worker with the real
marketplace app and extend `/api/health` to report scanner + Forgejo
liveness, not just "the apex Worker is up." (TODO markers also live in
`src/index.ts` and `wrangler.toml`.)

## Deploy

```sh
cd apps/services-site
./prepare.sh                 # unpack old_website.zip -> ./public
npx wrangler deploy          # live on the *.workers.dev URL it prints
```

## Apex hookup (live since 2026-06-06)

`flagship.services` and `www.flagship.services` are attached as Worker
**Custom Domains** (declared in `wrangler.toml` `routes`). The apex had no
prior DNS record, so Cloudflare attached cleanly and auto-provisioned the
proxied record + edge cert for each. `wrangler deploy` reconciles to the
declared set — edit `routes` to change it.

flagship.services zone id: `51f3bfe11a729db57effd70ed3cf9c77`.
