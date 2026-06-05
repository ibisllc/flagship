# Next-session work plan — webapp as reference user-ready surface

**Cycle goal.** Make the webapp (`apps/web/public/webapp/`) the first
fully-usable Flagship client, exercising the entire daemon + control-plane
API surface end-to-end. Doing this surfaces every latent bug in the
platform layer that "tests pass" hasn't caught, and produces the canonical
contract that the iOS + Android ports will mirror later.

**Method.** API plumbing first, UI second. Each user-facing view drives a
single, narrowly-scoped backend endpoint shaped *for that view* (BFF
style). The endpoint contract is what mobile will reuse — keep it
serializable, typed, and testable in isolation.

**Out of scope this cycle.** Native iOS/Android implementation; Stripe
billing wiring; peer-backup. Mobile gets an updated *contract sync* only
(P4 below) so the port stays cheap when someone picks it up.

---

## P0 — Monetization model rewrite (design only, no code)

The platform is free-for-most-users. Users self-host on their own hardware,
bring their own LLM key (BYOK) once they've outgrown our promo, and pay us
nothing. Flagship monetizes only **four** power-user surfaces — and even
those should remain modest, since the OSS code lets anyone bypass them.

| What we charge for | Why a user would pay | Free-tier behavior |
|---|---|---|
| LLM-promo bootstrap credits | Try Flagship without provisioning a BYOK first | Daily/lifetime cap; transition to BYOK is one tap |
| Dispatcher relay overage | Bandwidth-heavy service exceeds the free monthly quota | Free quota covers ordinary personal use indefinitely |
| Custom domain (`example.com` → user's pod) | Vanity / migration off `<pod>.<user>.flagship.services` | Default subdomain is forever-free |
| Reserved / trademark account name | Hold a name a brand owns even if not actively used | Normal usernames are first-come-first-served, free |

| ID | Task | Effort |
|---|---|---|
| P0.1 | Write `docs/monetization-free-tier-first.md` formalising the four fees + the OSS escape hatch | S |
| P0.2 | Rewrite `memory/llm_promo_and_byok_paths.md` framing promo as a *bootstrap*, not a product line | S |
| P0.3 | Add a memory `feedback_monetization_principle.md` so future sessions don't drift back into "Stripe everything" | S |
| P0.4 | Note in `build-tasks.md` §I that A.6.1–A.6.3 (Stripe checkout / portal / webhook) and §A.5.7–A.5.8 (paid scan, paid feature) are *power-user only*, not gating any user flow | S |

---

## P1 — UI-shaped daemon API contracts (build before any UI)

Every view in P2 calls exactly one endpoint listed here. Endpoint name
mirrors the view it serves — this is the BFF discipline. All endpoints
live on the daemon (paired-session gated) unless noted as `.com`.

Each P1 task delivers: (1) request/response types in `packages/protocol`
(if cross-process) or in a per-package types file; (2) handler wired into
`packages/server-daemon/src/httpApi.ts` via `httpApi`'s route table; (3)
integration test in `packages/server-daemon/tests/`; (4) curl-able from
the dev VM with a paired-session cookie.

| ID | Endpoint | Method | Returns / Frames | Effort |
|---|---|---|---|---|
| P1.1 | `/api/screens/server-detail` | GET | `{ runtimeInfo, certExpiry, version, uptime, recentInstallEvents, pairedSessionCount, appCount }` | S |
| P1.2 | `/api/screens/apps-list` | GET | `[{ appId, slug, creator, summary, urls, status, lastUpdate, restartable }]` | S |
| P1.3 | `/api/screens/app-detail/:appId` | GET | `{ manifest, urls, status, recentLogs, dataLayerInstances, members, browserTabs?, lastBackup }` | M |
| P1.4 | `/api/screens/marketplace-browse` | GET | `[{ creator, slug, summary, screenshots, installCount, requiresLlmKey, alreadyInstalled }]` (proxied to `.com` + filtered by local installs) | S |
| P1.5 | `/api/screens/vibe-code/start` | POST | `{ sessionId }` (body: `{ prompt, model? }`) | M |
| P1.6 | `/api/screens/vibe-code/:id/stream` | WS | frames: `token`, `manifest-emit`, `repo-create`, `build-start`, `build-log`, `deploy`, `done`, `error` | L |
| P1.7 | `/api/screens/vibe-code/:id` | GET | `{ status, transcript, deployedUrl?, errorReason? }` (resume after disconnect) | S |
| P1.8 | `/api/screens/unlock-approvals/pending` | GET | `[{ serverFqdn, requestId, requestedAt, ip, userAgent }]` (calls `.com`) | S |
| P1.9 | `/api/screens/unlock-approvals/:requestId/approve` | POST | body: IRK-signed unlock-key envelope | S |
| P1.10 | `/api/screens/browser-tabs/list/:appId` | GET | `[{ tabId, currentUrl, title, screenshotKey, needsField? }]` | S |
| P1.11 | `/api/screens/browser-tabs/:tabId/stream` | WS | out: framebuffer diffs (default 5 fps); in: `key`, `click`, `scroll`, `password`, `text` | L |
| P1.12 | `/api/screens/paired-sessions/list` | GET | `[{ tokenPrefix, label, lastSeen, ip, current? }]` | S |
| P1.13 | `/api/screens/paired-sessions/:tokenPrefix` | DELETE | `{ ok }` (signs an `add/remove-paired-session` PhoneOrder internally) | S |
| P1.14 | `/api/screens/orders/send` | POST | body: signed PhoneOrder envelope; returns `{ ok, response }` (debug surface for any of the 12 order types) | S |
| P1.15 | `/api/screens/install-events/:serial` | SSE | streams events during a fresh server install (fan-out from `.com`'s install-events log) | M |
| P1.16 | `/api/screens/tier-status` | GET | `{ tier, llmCreditsRemainingDay, llmCreditsRemainingTotal, dispatcherUsageGBmonth, customDomains, reservedNames }` (calls `.com`) | S |
| P1.17 | `/api/screens/url-controller/owned` | GET | `[{ fqdn, kind: canonical/alias/custom, claimedAt }]` | S |
| P1.18 | `/api/screens/url-controller/claim` | POST | body: `{ fqdn }` — already wired in `urlHttpHandlers.ts`; just ensure shape matches the screen view | S |
| P1.19 | `/api/screens/app-backup/start` | POST | body: `{ appId, password? }` — wraps the `backup-app` PhoneOrder; returns a one-shot fetch path | S |
| P1.20 | `/api/screens/app-backup/:backupId` | GET | streams the encrypted bundle; one-shot, deleted after read | S |

### Critical bug fix to land in P1

| ID | Task | Effort |
|---|---|---|
| P1.X1 | Wire `llmHarness` → `forgejoAppAdmin.createRepo()` → commit manifest+Dockerfile+migrations → trigger build. Currently the LLM streams into a void; the deploy step has no repo to push to. Fix in `packages/server-daemon/src/llmHarness.ts` + add an end-to-end test that vibe-codes a hello-world service against a fixture LLM and asserts the deployed container responds. | M |

---

## P2 — Webapp UI screens (only after P1 endpoints are green)

Each task below assumes its P1 endpoint is shipping and tested. UI = pure
presentation; all auth + state is via paired-session cookie.

| ID | Webapp view | Calls | Effort |
|---|---|---|---|
| P2.0 | Refactor `app.js` into a router + view modules (one JS file per view). Today it's a 500-line monolith — splitting it now is the BFF analogue: each view module is the caller of one P1 endpoint. | M |
| P2.1 | Server-detail view (current "home" expanded) | P1.1 | S |
| P2.2 | Services-list view | P1.2 | S |
| P2.3 | Service-detail view (manifest dump, URLs with copy-to-clipboard, logs, restart, backup, uninstall) | P1.3, P1.18, P1.19 | M |
| P2.4 | Marketplace browse view | P1.4 | S |
| P2.5 | Vibe-code dialog: prompt input → live token stream → manifest preview → deploy log → final URL chip | P1.5, P1.6, P1.7 | L |
| P2.6 | Unlock-approval push handler + view (push notification or polling-based; signs with IRK in-page) | P1.8, P1.9 | M |
| P2.7 | Browser viewer view: `<canvas>` framebuffer + virtual keyboard + password field router | P1.10, P1.11 | L |
| P2.8 | Settings → paired-sessions list + revoke | P1.12, P1.13 | S |
| P2.9 | Settings → debug send-order panel (every order type, with a "send" button per type) | P1.14 | S |
| P2.10 | Install-progress view (rendered while a freshly-built ISO is provisioning) | P1.15 | M |
| P2.11 | Tier dashboard (LLM credits gauge, dispatcher usage bar, custom domains, reserved names) | P1.16 | S |
| P2.12 | Recovery flow: cloud-shard unwrap from iCloud Keychain / Google Block Store + re-pair to all known servers | (uses keystore.js) | L |
| P2.13 | Service-worker offline-replay queue: retry POSTs once connectivity returns (orders + claim + backup-start are all idempotent enough for naive retry) | M |
| P2.14 | Toast / error surface unified across views (today error handling is per-view ad-hoc) | S |

---

## P3 — flagshipserver.com gaps

The website is the marketing front door + the docs portal + the
unauthenticated user area. Most of A.1 / A.2 in `build-tasks.md` is done;
these are the holes.

| ID | Task | Effort | Source |
|---|---|---|---|
| P3.1 | `/security` page — architecture explainer w/ diagrams | M | A.1.4 |
| P3.2 | `/docs` portal — render `docs/*.md` server-side w/ sidebar nav | M | A.1.6 |
| P3.3 | `/open-source` — license + governance + contributors | S | A.1.9 |
| P3.4 | `/.well-known/security.txt` (RFC 9116) | S | A.1.8 |
| P3.5 | `/blog` — static markdown w/ RSS | M | A.1.7 |
| P3.6 | OG-image generator at `/og?title=...` | S | A.1.10 |
| P3.7 | `/me/*` paired-session-gated browser area, OR explicitly subsume into the webapp PWA + redirect `/me` → `/webapp/`. Decide first, then either build or redirect. | M | A.2.6 |

---

## P4 — Mobile contract sync (stubs only)

| ID | Task | Effort |
|---|---|---|
| P4.1 | Mirror every P1 endpoint type into `apps/mobile/ios/Sources/FlagshipAPI/Models/*.swift` | S |
| P4.2 | Mirror same into `apps/mobile/android/app/src/main/java/com/flagship/api/Models.kt` | S |
| P4.3 | Add a `apps/mobile/README.md` declaring P1's `/api/screens/*` as the authoritative mobile target — when someone picks up the native port, no API design work remains | S |
| P4.4 | Real HTTP client + Secure Enclave / StrongBox impl: **explicitly deferred** to a later cycle | — |

---

## P5 — Explicitly deferred to a later cycle

| ID | Task | Why deferred |
|---|---|---|
| P5.1 | Stripe checkout / portal / webhook (build-tasks A.6.1–A.6.3) | Free-tier-first; payment is power-user-only |
| P5.2 | Custom-domain CNAME provisioning | One of the four power-user fees; comes after monetization is enabled |
| P5.3 | Reserved/trademark name reservation flow | Same as above |
| P5.4 | Dispatcher overage metering + billing | Same |
| P5.5 | Native iOS app implementation | Cheap port once webapp + P4 contract land |
| P5.6 | Native Android app implementation | Same |
| P5.7 | Peer-backup distribution (matchmaking + transport + repair) | Designed in `roadmap.md` §1; not on this cycle's path |

---

## Suggested execution order

1. **P0 (1 day)** — write the monetization doc + memory entries first, so the rest of the cycle can lean on a clear "we're not building Stripe this cycle" decision.
2. **P1.X1 (Forgejo wiring)** — fix this *before* P1.5/P1.6 since vibe-code can't deploy without it.
3. **P1.1 → P1.20 (5–7 days)** — work down the table in order; each endpoint shipped = one piece of infrastructure verified.
4. **P2.0 (refactor app.js)** — small but unblocks everything else in P2.
5. **P2 in parallel with the tail of P1** — once P1.1 is in, start P2.1; etc.
6. **P3 (2–3 days)** — website gaps; can run in parallel with P2 on a different track.
7. **P4 (1 day)** — fast contract sync at the end so the next person to pick up mobile starts from a synced baseline.

**Cycle target.** Webapp can: pair to a server, list services, install a service
from marketplace, vibe-code a new service and watch it deploy, claim a custom
URL for it, drive a browser login through it, approve a LUKS unlock,
revoke a paired session, monitor LLM-promo credits, and recover after
device loss. End-to-end on this dev VM, with no manual `curl`s. That's the
bar for "v1 alpha is real."
