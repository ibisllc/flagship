# Flagship end-to-end test plan

Goal: a test harness that walks the **webapp → .com → simulated pod**
chain through every meaningful user-facing flow, with real DOM
interactions in a headless browser and visible assertions on what the
pod and `.com` actually saw. Catches what unit tests can't:

- Browser-only paths (WebAuthn PRF, PushManager, IndexedDB).
- Cross-origin chains (web. → apex → user pod).
- Real signature roundtrips (webapp's IRK signs, pod / .com verify).
- Service-worker behavior (install, scope, push, offline-replay).

This doc is the build plan + the runbook. Build it as
`apps/web/e2e/` (Playwright project) plus a Fastify-based pod
simulator under `apps/web/e2e/pod-sim/`. The actual test code is the
follow-up; this is the design + scenario inventory.


## Architecture

```
        ┌────────────────────────┐
        │  Playwright (headless) │  ← drives clicks, asserts DOM,
        │  Chrome / Firefox      │    captures screenshots
        └──────────┬─────────────┘
                   │ http(s)
   ┌───────────────┼────────────────────┐
   │               │                    │
   ▼               ▼                    ▼
┌─────────┐  ┌─────────────┐    ┌──────────────────┐
│ wrangler│  │ wrangler    │    │ pod-sim          │
│ dev     │  │ dev         │    │ (fastify, in-    │
│ (apex)  │  │ (web. host) │    │  process)        │
│         │  │ → SAME      │    │                  │
│ /api/*  │  │ Worker      │    │ /api/screens/*   │
│ control │  │ via host-   │    │ /api/orders-     │
│ plane   │  │ routing     │    │   from-user      │
│ + D1    │  │             │    │ /api/apps        │
│ (test)  │  │             │    │ /api/browser/*   │
└─────────┘  └─────────────┘    └──────────────────┘
                   │                    ▲
                   │ POSTs orders       │
                   └────────────────────┘
                   webapp talks to pod-sim
                   directly for /api/screens/*
                   (matches production:
                    pod-side, paired-session
                    bearer auth)
```

Three running processes the test suite spins up:

1. **`wrangler dev` for the apex Worker** (`apps/com/`) on `localhost:8787`,
   with `--local` D1 (an isolated SQLite file the test suite seeds and
   resets between scenarios).
2. **A second host alias** so the same Worker also serves
   `web.flagshipserver.com`. Use Playwright's `extraHTTPHeaders` +
   `routes` to mock the Host header, or run wrangler with multiple
   routes — wrangler dev supports `--local-protocol https` and
   per-host routes via the same project's `wrangler.toml`.
3. **`pod-sim`** — an in-process Fastify mounted on a random localhost
   port, with a self-signed cert (Playwright accepts via
   `ignoreHTTPSErrors: true`).

Why a simulated pod instead of a real daemon: the daemon needs Docker,
LUKS, ACME, an SNI passthrough hub, and a tunnel. None of those are
test-friendly. The pod-sim implements **just the HTTP surfaces the
webapp talks to**, with the same canonical-bytes verifications the
real daemon does (re-using `@flagship/protocol` so signature checks
are not loosened).


## Pod simulator scope

`apps/web/e2e/pod-sim/` re-implements only the surface the webapp
exercises:

| Surface | Behaviour |
|---|---|
| `POST /api/orders-from-user` | Verifies PSK signature (using `verifyPhoneOrder`); records the order in an in-memory list the tests can read. |
| `GET /api/screens/server-detail` | Returns a fixture object with FQDN, daemon version, cert info, counters. |
| `GET /api/screens/apps-list` | Returns whatever the test seeded via the `seedApps()` helper. |
| `GET /api/screens/app-detail/:appId` | Same. |
| `GET /api/screens/marketplace-browse` | Returns a fixture marketplace (proxied to .com in production, faked here). |
| `GET /api/screens/unlock-approvals/pending` | Returns whatever the test seeded — used to test that a pending request renders + the Approve button fires the right POST. |
| `WS /api/screens/vibe-code/stream/:sessionId` | Streams pre-canned LLM tokens + a manifest snapshot. |
| `GET /api/screens/paired-sessions/list` | Returns the orders we recorded. |
| `GET /api/screens/tier-status` | Static fixture. |
| `POST /api/apps` | IRK-verified install — records the install. |

What the pod-sim does NOT do:
- Real LUKS unsealing (the test seeds a known sealed blob into a fake
  `.com` `/api/server/<fqdn>/sealed-luks-key` so the lease-deposit
  path can roundtrip).
- Real ACME / TLS (Playwright accepts the self-signed cert).
- Real Forgejo / Docker (vibe-code stream returns a canned manifest).

Auth: pod-sim accepts the same paired-session token shape as the real
daemon (3 carriers: `Authorization: Flagship-Session <tok>`,
`x-flagship-session`, `?sessionToken=`). Re-uses `extractPairedSessionToken`
from `@flagship/server-daemon` directly.


## Test scenarios

Numbered for traceability; each maps to a Playwright `test.describe`
block. All scenarios start from a clean Playwright `BrowserContext`
(fresh IndexedDB, fresh permissions) unless noted.

### S1 — First-run signup
1. Open `https://web.flagshipserver.com/`.
2. **Assert** view-bootstrap is visible.
3. Fill passphrase (twice), click Generate.
4. **Assert** view-home is visible, "signed in" subtitle present.
5. Reload the page.
6. **Assert** view-unlock is visible (passphrase prompted, IndexedDB persisted).
7. Unlock with the same passphrase.
8. **Assert** view-home reachable.

### S2 — Pod pairing
1. From home, click "Pair to a server".
2. Enter the pod-sim URL.
3. Click Pair.
4. **Assert** the pod-sim received exactly one `POST /api/orders-from-user`
   with type `add-paired-session`, signature verifies against the user's IRK.
5. **Assert** localStorage has `flagship.podBaseUrl` + `flagship.sessionToken`.
6. Navigate to server-detail; **assert** the pod-sim's fixture renders.

### S3 — Marketplace install
1. From home, open Marketplace.
2. **Assert** the apex's seeded marketplace listing is rendered.
3. Click Install on the listing.
4. **Assert** pod-sim received `POST /api/apps` with an IRK-signed
   `install-app/v1` envelope.
5. Open Apps list; **assert** the new app appears.

### S4 — Vibe-code an app
1. Open Vibe-code dialog.
2. Type a prompt, click Start.
3. **Assert** WS connects to `/api/screens/vibe-code/stream/<sessionId>`,
   tokens stream into the transcript pane.
4. **Assert** the manifest pane updates when pod-sim emits a
   `manifest-emit` frame.
5. Click Deploy.
6. **Assert** pod-sim records the install.

### S5 — Unlock approval (one-shot lease) — **CRITICAL**
1. Seed pod-sim's pending list with one fake unlock request
   `{ requestId, serverFqdn, requestedAt, ip, userAgent }`.
2. Seed `.com`'s `sealed_luks_keys` table with a known sealed blob
   for `serverFqdn` (sealed against the test user's IRK).
3. From home, open "Unlock requests".
4. **Assert** the pending request renders.
5. Click Approve.
6. **Assert** the webapp:
   - GETs `/api/server/<fqdn>/sealed-luks-key` from .com
   - Unseals locally (X25519 + AES-GCM)
   - POSTs `/api/server/<fqdn>/unlock-key/lease` with `multiUse=false`,
     ~10-min expiry, signature verifies against the user's IRK.
7. **Assert** `.com`'s D1 has an `auto_unlock_leases` row for that
   `serverFqdn` with `multi_use=0`.
8. Simulate a server boot poll: POST `/api/server/<fqdn>/unlock-key/consume`
   with a server-identity-signed envelope.
9. **Assert** response includes the unsealed unlock key and the row
   was deleted (one-shot consumed).

### S6 — Long-lived auto-unlock toggle
1. Server-detail view → click "Enable for 7 days".
2. **Assert** `.com` has a multi_use=1 lease, expiresAt ≈ now + 7d.
3. Reload page; **assert** the toggle status pill reads "on".
4. Click "Revoke" on the lease.
5. **Assert** the lease row is deleted from `.com` (DELETE signature
   verified by the protocol).

### S7 — Silent auto-renewal — **CRITICAL**
1. Seed `.com` with a long-lived lease whose `expiresAt` is `now + 12h`
   (inside the 24h renewal window).
2. Open the home view (triggers `tickRenewals` via `scheduleRenewals`).
3. **Assert** within 2s, `.com` has a NEW lease with same `multiUse=1`
   and `expiresAt ≈ now + 7d`. The old lease may or may not still be
   present (each renewal creates a fresh row keyed by leaseId).
4. Now seed only a lease with `expiresAt` = `now + 5d` (outside the
   24h window). Reload home.
5. **Assert** no new lease was created (renewer correctly skipped).

### S8 — WebAuthn-PRF cloud recovery — setup
1. From settings, click "Set up cloud recovery".
2. Use Playwright's `virtual-authenticators` API to grant a virtual
   passkey with the PRF extension enabled.
3. **Assert** `.com` has a `webauthn_recovery_records` row for the
   user, with the wrapped UMK base64 + credentialId.
4. Click "Set up cloud recovery" again.
5. **Assert** the record was UPDATED (createdAt unchanged, updatedAt newer).

### S9 — WebAuthn-PRF cloud recovery — recover from new browser
1. Drop the existing context; create a fresh `BrowserContext` AND
   a fresh virtual authenticator that ALSO has the same passkey
   (Playwright's authenticator state can be saved + restored).
2. Open the webapp.
3. From bootstrap view, click "Recover from passkey".
4. Enter the username from S8.
5. Pick a fresh passphrase.
6. **Assert** WebAuthn assertion completes, the seed is recovered,
   the device is unlocked into home.
7. **Assert** `home-irkpub` matches the IRK pubkey from S8 (proves we
   recovered the same identity, not a fresh one).

### S10 — Manual recovery (export/import) — non-WebAuthn fallback
1. From recovery view, click "Export wrapped UMK". Capture download.
2. Drop context, fresh browser.
3. From recovery view, import the JSON.
4. Reload, unlock with the original passphrase.
5. **Assert** the same IRK pubkey is restored.

### S11 — Web Push subscription
1. From settings, click "Enable browser notifications".
2. Playwright auto-grants the notification permission via
   `context.grantPermissions(['notifications'])`.
3. **Assert** `pushManager.subscribe()` was called with the VAPID public
   key (intercepted via `page.evaluate` to inspect).
4. **Assert** `.com` has a `push_tokens` row with `platform=webpush`
   and a JSON-encoded subscription endpoint.
5. Click Disable.
6. **Assert** subscription unsubscribed locally + `.com` row deleted.

### S12 — Web Push delivery (mocked push service)
1. After S11, intercept the PushManager's endpoint URL by routing it
   through Playwright's request-router to a local fake push service.
2. Trigger a push by calling `service-worker.js`'s push event manually:
   `await page.evaluate(() => navigator.serviceWorker.ready
      .then(reg => reg.active.postMessage({type: 'simulate-push'})))`.
   (Add a `message` handler in the SW that synthesizes a push event
   ONLY when `process.env.E2E === '1'` is set — guarded by
   `self.location.search.includes('e2e=1')` to avoid shipping the
   shim in production.)
3. **Assert** `Notification` constructor fired with body
   "A server is asking to boot — tap to review."
4. Click the notification.
5. **Assert** the webapp tab focuses (or opens) at root.

### S13 — Service-worker offline-replay
1. Toggle Playwright's network to offline mode.
2. Trigger an idempotent POST (e.g., orders/send).
3. **Assert** SW returns 202 with `{queued: true}`.
4. Re-enable network; trigger an `online` event.
5. **Assert** the queued request is replayed (pod-sim sees it).


## Fixtures + helpers

```
apps/web/e2e/
├── playwright.config.ts        # Chrome + Firefox + WebKit, 1 worker
├── fixtures/
│   ├── pod-sim.ts              # spawns + tears down the simulator
│   ├── apex-worker.ts          # wraps wrangler dev for setup/teardown
│   ├── seed-d1.ts              # truthful test seeds (clears + populates)
│   ├── identity.ts             # generates a UMK + derives IRK/BAK for a
│   │                           # given test user, seeds the username row
│   ├── webauthn.ts             # virtual authenticator helpers
│   └── push-mock.ts            # intercept-and-record fake push service
├── pod-sim/
│   ├── server.ts               # fastify app
│   ├── pending-store.ts        # seedable pending-unlock-requests list
│   ├── apps-store.ts           # seedable apps list
│   └── orders-store.ts         # records every order received
├── flows/
│   ├── s01-signup.spec.ts
│   ├── s02-pod-pair.spec.ts
│   ├── s03-marketplace.spec.ts
│   ├── s04-vibe-code.spec.ts
│   ├── s05-unlock-approve.spec.ts
│   ├── s06-long-lived-toggle.spec.ts
│   ├── s07-renewal.spec.ts
│   ├── s08-recovery-setup.spec.ts
│   ├── s09-recovery-cross-browser.spec.ts
│   ├── s10-manual-export.spec.ts
│   ├── s11-push-subscribe.spec.ts
│   ├── s12-push-deliver.spec.ts
│   └── s13-offline-replay.spec.ts
└── README.md                    # this doc, slimmed
```

`fixtures/identity.ts` is the only piece that does crypto — it
re-uses `@flagship/protocol`'s `deriveIRK/BAK/SWK` so test users
look identical to real ones from the canonical-bytes layer.
`webauthn.ts` uses Playwright's
`browserContext.addInitScript` to monkey-patch `navigator.credentials`
when running against browsers that don't support virtual authenticators
natively (Firefox), and uses `chromium.launch` with
`--enable-features=WebAuthenticationVirtualAuthenticatorAPI` for Chrome.


## Running

```sh
# One-time
cd apps/web/e2e && npm install
npx playwright install chromium firefox webkit

# Bring everything up + run all flows
npm run e2e            # spawns wrangler dev, pod-sim, runs all .spec.ts

# Run one scenario, headed (see the browser)
npm run e2e -- --grep "S5" --headed --project=chromium

# Debug mode: opens Playwright's inspector, pauses at first action
npm run e2e -- --debug --grep "S5"
```


## CI integration

**DONE 2026-05-16: `.github/workflows/e2e.yml`.** Chromium-only (the
`{chromium,firefox,webkit}` matrix was descoped to chromium per the
2026-05-11 product decision — the playwright config has a single
`chromium` project; firefox/webkit explicitly deferred). The workflow
follows the README's documented procedure: `npm install` → `tsc -b`
→ `playwright install chromium` → `wrangler dev` (local miniflare on
:8787, no remote secrets) → `cd apps/web/e2e && npm test`. Triggered
on `pull_request` + `workflow_dispatch` — deliberately NOT
`push:main` until it has a proven green run on a real GitHub runner
(it cannot be executed from a CLI dev session, same as
build-iso.yml/marketplace-scan.yml). Flaky scenarios are retried once
(playwright config `retries:1` in CI); a persistent flake should be
quarantined per "Build order", not blanket-retried. Playwright
report + traces + the wrangler-dev log upload as artifacts always
(14-day retention).


## What this DOESN'T cover

- **Real installed server.** The pod-sim is a stand-in for the daemon;
  it doesn't exercise Docker/LUKS/ACME/tunnel. A separate
  `smoke-end-to-end.sh` script (paired-down version of the existing
  `scripts/smoke-*.ts`) runs against a freshly-built ISO in a VM —
  that's the truth-finding test, but slow + fragile, so it doesn't
  go in PR-blocking CI.
- **Real Web Push delivery.** S12 mocks the push service. Real APNs/
  FCM/Web Push delivery is tested with a small `smoke-push.sh` that
  hits the staging endpoints and waits for a callback.
- **Browser-platform-specific WebAuthn quirks.** Playwright's virtual
  authenticator is a fair simulation but Touch ID + Windows Hello +
  Android passkeys behave subtly differently. Manual QA on each
  major platform before launch is still required.


## Build order (suggested)

1. **Pod simulator skeleton + S2 (pod-pair).** Smallest viable end-to-end
   slice — proves the test rig works.
2. **S1 (signup) + S5 (unlock-approve).** Most critical user flows.
3. **S6 + S7 (lease + renewal).** Validates the work just shipped.
4. **S11 + S12 (web push).** Validates the push wiring + the
   notification UX.
5. **S8 + S9 (WebAuthn recovery).** Validates the most complex
   browser-only crypto path.
6. Remaining scenarios.

Estimate: ~3 days for the rig + S1/S2/S5; ~1 day per remaining
scenario after that. CI integration is a half-day on top.
