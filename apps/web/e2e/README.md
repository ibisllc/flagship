# Flagship e2e — Playwright + pod simulator

End-to-end test rig for the **webapp → .com → user pod** chain.
Chromium-only by design (per 2026-05-11 product decision; see
`docs/e2e-test-plan.md` for the broader test plan).

## What's here

```
apps/web/e2e/
├── playwright.config.ts          # chromium-only, sequential workers
├── package.json                  # @playwright/test + fastify + protocol
├── fixtures/
│   ├── identity.ts               # mint test UMK → IRK/STK via @flagship/protocol
│   └── pod-sim.ts                # spin up + tear down a pod-sim per test
├── pod-sim/
│   ├── server.ts                 # Fastify mock of the daemon's HTTP surface
│   ├── orders-store.ts           # records every order the pod-sim received
│   ├── apps-store.ts             # seedable installed-apps fixture
│   └── pending-store.ts          # seedable pending unlock-approvals fixture
└── flows/                        # *.spec.ts — one per scenario (S1, S2, ...)
```

## Setup

```sh
# From the repo root:
npm install                         # installs @playwright/test in apps/web/e2e
cd apps/web/e2e
npx playwright install chromium     # downloads the Chromium binary (~100 MB)
```

## Running

```sh
# Run all flows against the live apex Worker + a per-test pod-sim:
WEBAPP_BASE_URL=https://webapp.flagshipserver.com \
APEX_BASE_URL=https://flagshipserver.com \
  npm test

# Or against `wrangler dev` locally (faster, doesn't pollute prod D1):
cd apps/com && npx wrangler dev &
# (wait for "Ready on http://localhost:8787")
cd ../web/e2e && npm test
```

## How the pod-sim differs from the real daemon

The pod-sim implements **just the HTTP surfaces the webapp talks to**.
It re-uses `@flagship/protocol` for signature verification — every
PhoneOrder we accept goes through `verifyPhoneOrder`, every
install-app envelope through `verifyInstallApp`. If the real daemon
and the pod-sim ever disagree on canonical-bytes, both fail.

What the pod-sim does NOT do:
- Real Docker / LUKS / ACME / tunnel.
- Forgejo (vibe-code stream returns canned tokens).
- Persistent state (process-lifetime only).
- Browser Chromium (the test browser is the user's browser).

## Adding a scenario

1. Drop a `flows/sNN-name.spec.ts`.
2. Import `test, expect` from `../fixtures/pod-sim.js`.
3. Use the `podSim` fixture for pod-side assertions, and call
   `await page.goto(...)` for browser actions.

See `docs/e2e-test-plan.md` for the canonical scenario list and
priority order.
