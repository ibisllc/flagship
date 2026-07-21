# Boot-worker consolidation — `boot.flagshipserver.com` served by `.com`

**Status: LIVE in production (cut over 2026-06-11). `boot.flagshipserver.com` is served by `flagship-com`; `apps/boot` retained as an optional cloneable target (no live hostname).**

## Why

The BOOT operations (`/api/boot/*` — the box's auto-unlock-lease release + the
phone-gated approval relay) used to run on a SEPARATE Cloudflare Worker
(`apps/boot`, hostname `boot.flagshipserver.com`) with its OWN D1
(`flagship-boot`). When a booting box announced "I need approval", that worker
parked the request in its own mailbox and bridged it to the identity plane
(`flagshipserver.com` / `apps/com`) via:

```
POST {identity-plane}/api/internal/notify-owner
x-boot-notify-secret: <NOTIFY_SHARED_SECRET>   (== apps/com BOOT_NOTIFY_SECRET)
```

so the identity plane (the only holder of push secrets) could wake the owner's
phone. The phone then read the request from the identity plane's mailbox,
approved, and deposited the sealed key, which the box polled back from the boot
worker.

**The failure this fixes:** the shared secret drifted out of sync. The bridge
call silently `401`'d, the box's request never reached the identity plane's
mailbox, the phone had nothing to approve, and the box hung at the LUKS unlock
*forever, with no visible error*. Two mailboxes that must stay in sync via a
silently-best-effort cross-worker call is the root fragility.

## What changed

`boot.flagshipserver.com` is now served by the **`flagship-com` worker itself**
(same Cloudflare zone), host-dispatched exactly the way `web.` and `recovery.`
already are (`apps/com/src/route.ts`). The `/api/boot/*` contract — hostname,
paths, request/response JSON, the `Flagship-Boot-v1` `Authorization` gate — is
**byte-identical**, so the box, the builder, and the phone need NO change.

What changed is only the backing:

| Endpoint | Handler | Storage table (in `flagship-state`) |
| --- | --- | --- |
| `PUT /api/boot/lease` | `routeBoot` → deposit (owner-IRK) | `box_sealed_leases` |
| `GET /api/boot/lease/:domain` | `routeBoot` → release (box-STK) | `box_sealed_leases` |
| `DELETE /api/boot/lease/:domain/:id` | `routeBoot` → revoke (owner-IRK) | `box_sealed_leases` |
| `POST /api/boot/request` | `routeBoot` → announce (box-STK) → push | `secret_mailbox` (+ `boot_nonces` for the gate) |
| `GET /api/boot/response/:domain/:nonce` | `routeBoot` → poll (box-STK) | `secret_mailbox` |
| `POST /api/boot/response` | `routeBoot` → deposit sealed reply (owner-IRK / watch-delegate) | `secret_mailbox` |

- **Directory** (box STK / owner IRK / active boot-approval delegates) is
  resolved **in-process** from `flagship-state` (`InProcessDirectoryClient`,
  `apps/com/src/bootInProcess.ts`) — no self-`fetch` to `/api/users/:u/pods`.
- **Owner push** fires **in-process** via the local push forwarder
  (`InProcessNotifyPipe` → `buildPushUserDevices`) — no cross-worker
  `/api/internal/notify-owner` call.
- **No shared secret on the reference path.** The box's request is
  self-authenticating: the gate re-verifies its Ed25519 STK signature against
  the directory-bound STK *before the router parks it*, so the shared secret
  added no real security — it only gated "is the caller the boot worker", which
  was the fragile sync point. It is gone from the reference path.

### One load-bearing detail: the mailbox row's `username`

In the two-worker model there were effectively TWO mailbox rows per request: the
boot worker's own (keyed by `serverDomain`, used only as dedup state) and the
identity plane's (keyed by the real `username`, created by `notify-owner` — the
one the phone's `/api/secret-requests` listing reads). Consolidated, there is
ONE mailbox. So the boot router now parks the row with the **real owning
username** (resolved via the new `DirectoryClient.usernameForDomain`), making
that single row visible to the phone's existing per-account listing. The
standalone worker also benefits (its row becomes self-describing); behaviour is
unchanged there because the phone still reads the identity plane's row.

## Shared logic: `@flagship/boot-core`

The pure, runtime-agnostic boot logic (the router `routeBoot`, the identity
`gate`, the `DirectoryClient` / `NotifyPipe` interfaces + their HTTP/in-memory
implementations, the nonce store, hex helpers) was extracted from `apps/boot`
into **`packages/boot-core`** — the same "shared handler, deployed twice"
pattern as `@flagship/control-plane`. Both consumers import it:

- **`apps/com`** (reference) — mounts `routeBoot` on the identity plane,
  in-process directory + notify, backed by `flagship-state`.
- **`apps/boot`** (optional clone) — the standalone worker, HTTP directory +
  shared-secret notify pipe, pointed at a SEPARATE identity plane.

## The clone path is retained

`apps/boot` is **not deleted**. An enterprise that wants to run its own boot
worker against its own identity plane still can: set `IDENTITY_PLANE_URL`,
`NOTIFY_SHARED_SECRET` (matching the identity plane's `BOOT_NOTIFY_SECRET`), a
`DB` binding (apply `apps/boot/migrations/0001_boot_tables.sql`), and deploy.
The identity plane's `/api/internal/notify-owner` endpoint + the
`BOOT_NOTIFY_SECRET` check are kept **for that clone path only** — the reference
box path no longer uses them.

## Migration

`flagship-state` already had `secret_mailbox` + `box_sealed_leases` (migration
`0037`). It lacked the gate's single-use nonce store, added as
**`0050_boot_nonces.sql`** (additive + idempotent; the same shape as the boot
worker's own `boot_nonces`).

## Deploy / cut-over (executed 2026-06-11)

1. Apply `packages/storage/migrations/0050_boot_nonces.sql` to prod
   `flagship-state` **before** the Worker deploy (the boot gate needs the table).
2. **`boot.flagshipserver.com` is a CUSTOM DOMAIN on `flagship-com`, not a zone
   route.** This was the load-bearing correction at cut-over time: the
   flagshipserver.com zone has **no wildcard DNS record**, and a Worker Route
   only fires for a hostname that *already resolves into Cloudflare* (`web.` has
   an explicit proxied CNAME; `recovery.` — a route with no record — does not
   resolve at all). `boot.` previously resolved *solely* via its custom domain
   on `flagship-boot`; a bare route on `flagship-com` would have had no DNS
   record to catch and would have taken `boot.` fully offline. Declaring it a
   custom domain (`{ pattern = "boot.flagshipserver.com", custom_domain = true }`
   in `apps/com/wrangler.toml`) lets wrangler provision the proxied DNS record +
   edge cert itself.
3. **The cut-over (zero-downtime):** `apps/boot/wrangler.toml` was emptied to
   `routes = []` and `apps/com/wrangler.toml` gained the boot custom domain;
   then `wrangler deploy` of `flagship-com` **reassigns** the existing
   `boot.flagshipserver.com` custom domain from `flagship-boot` to
   `flagship-com` in place (confirm the reassignment prompt). Because the DNS
   record + cert are reused, there is no resolution gap. Verified: `GET
   https://boot.flagshipserver.com/api/health` flipped from
   `{"service":"flagship-boot"}` to `{"service":"flagship-com","surface":"boot"}`
   with `ssl_verify=0`, and the gate rejects an unauthed `/api/boot/lease/...`
   with `400 {"error":"malformed authorization"}` (router + gate live). The box
   re-announces on its next boot and a fresh unlock writes to `flagship-state`,
   so no migration of in-flight boot state is needed (pre-launch).

   > A standalone clone re-adds its OWN hostname as a custom-domain route in
   > `apps/boot/wrangler.toml` and deploys `flagship-boot` against its own
   > identity plane — the reference deployment just doesn't point a hostname at
   > it anymore.
4. No client (box, builder, phone) rebuild is required for the consolidation —
   the hostname + `/api/boot/*` contract are unchanged.

## Wire-transparency (verified)

- **Box** (`installer/boot-stage.sh`, `packages/flagship-builder/src/userdata.ts`,
  `apps/builder-mac/.../UserData.swift`): targets
  `https://boot.flagshipserver.com` + `/api/boot/{lease,request,response}`,
  box-STK `Flagship-Boot-v1` auth. Unchanged.
- **Builder**: bakes `https://boot.flagshipserver.com` to
  `/boot/flagship-boot-host`. Unchanged.
- **Phone** (`apps/mobile/shared/.../SecretMailboxClient.swift`): posts
  `/api/boot/response` + `PUT /api/boot/lease` + `DELETE /api/boot/lease/:d/:id`
  to `bootBaseUrl = https://boot.flagshipserver.com` with the owner-IRK
  `bootAuth` header. Unchanged.
