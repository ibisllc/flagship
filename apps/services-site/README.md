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
