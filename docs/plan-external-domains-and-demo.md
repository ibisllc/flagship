# Build plan — external domains + live demo account

**Purpose.** End-of-day handoff. A cold session (no prior context) should be able to
read this top-to-bottom and execute. Canonical design rationale lives in agent memory
`project_external_domains.md` (and `project_voici_appid.md`); this file is the *execution*
plan. Ops commands are in `CLAUDE.md` ("Common operations").

Date written: 2026-05-15.

---

## 1. Where things stand

**Shipped (client, Mock-faithful, on `main`):** the entire custom-domain *client UX* on
iOS — Set-custom-domain section, failure-driven alerts (apex→www, replace-permanent,
rate-limit), decoupled request/confirm (200 = recorded, not confirmed), on-device
cooldown timestamp + countdown, CUSTOM DOMAIN group atop WEB DOMAINS, apps-list short→
custom swap gated on `customDomainConfirmed`. Single-source URL-fragment derivation
(`@flagship/protocol`), 30-char app one-liner cap, package-id demo-fixture fix, the
in-product CNAME note. iOS XCTest 232 green, vitest 2359 green.

**Pending tasks (authoritative IDs):**
- #79 external-domain routing-claim + fleet-cert backend (the spine)
- #80 Set-custom-domain UX — **Android + webapp** (iOS done)
- #81 CUSTOM DOMAIN section + apps-list swap — **Android + webapp** (iOS done)
- #82 CNAME-compliance sweep + unilateral invalidate (cron)
- #83 `provisionDemoUser` / `decommissionDemoUser` — YubiKey-gated CLI
- #84 `users.is_demo` column + signed "use mock recovery" login directive
- #85 strict free LLM credit ceiling for demo users
- #86 `.services` in-RAM redirection table (alias over `TunnelRegistry`)
- #87 `.com`→`.services` ADD/DELETE push + `.services` cold-start pull

**Decided design (do not relitigate — see memory):** request/confirm decoupled;
200 = recorded only; non-200 = rate-limit/busy only (300s, server `lastChanged` column,
client mirrors on-device); destructive replace (irreversible, doubles as "forget");
subdomains only (apex → www guidance); `.com` validates / `.services` transmits;
redirection table RAM-only on `.services`, `Map<fqdn,podCanonical>` over
`TunnelRegistry` (never key on the WS); push protocol ADD/DELETE, replace = DELETE(old)
+ ADD(new); cold-start pull + lazy SNI-miss→ask-`.com`; demo = single shared account,
`users.is_demo`, only Apple recovery mocked, manual provision/decommission (no daily
wipe), YubiKey-gated.

---

## 2. Open knobs — PROPOSED DEFAULTS (build proceeds on these unless the user redirects)

| Knob | Default to build with |
|---|---|
| Custom-domain change rate limit | 300 s (already decided) |
| First async verify after request | attempt within ~30 s, retry backoff 30 s → 2 m → 10 m → 30 m, give up (→ failed) after 24 h |
| #82 re-verify sweep cadence | every 12 h per ACTIVE domain |
| #82 invalidation grace | invalidate after 3 consecutive failed re-verifies spanning ≥ 24 h |
| #82 self-heal | a successful re-verify before invalidation resets the failure counter (transient blips heal) |
| Cert | Let's Encrypt 90-day, auto-renew at ~30 days remaining; skip renew if order no longer ACTIVE |
| #85 demo LLM cap | 250k input+output tokens / rolling 24 h, hard stop "demo quota reached" |

All are cheap to change later; they exist so no phase is blocked waiting on a decision.

---

## 3. Dependency graph

```
#84 (is_demo)  ──> #85 (demo LLM cap)  ──> #83 (provision/decommission)
#79 .com POST/record/rate-limit ──> iOS Live wire (flip 501 stub)
#86 (.services RAM table) ──> #87 (.services receive + cold-start) ──┐
#79 async verify + ACME + cert-replicate ───────────────────────────┼─> end-to-end
#87 .com push side  ────────────────────────────────────────────────┘
#79 (orders table + verify) ──> #82 (recurring sweep)
#80/#81 Android+web ── independent of backend; flip to Live after #79 POST lands
```

---

## 4. Phased execution

Each phase: **goal → commits → deploy → test gate → done-when.** One logical commit per
bullet unless noted. Commit style: imperative subject, body explains *why*, **no
`Co-Authored-By` trailer** (CLAUDE.md). After every backend change: `npx tsc -b` +
`npx vitest run` must stay green. Deploy commands are stated; **inform the user and run
them** (standing authorization given for `.com` + `.services` CLI deploys — show the
command, run it, report the result; don't silently skip).

### Phase 1 — `is_demo` foundation (#84)  [small, unblocks demo line]

- **C1.1** D1 migration `packages/storage/migrations/0021_is_demo.sql`: add `is_demo`
  to the users/claims table (confirm exact table — likely the username-claims table;
  grep `CREATE TABLE` in migrations + `packages/storage/src/d1.ts`). Default 0.
- **C1.2** control-plane: on auth/login for an `is_demo` user, return a
  **platform-signed** directive `{ useMockRecovery: true }` (sign with the platform
  key already used for signed server messages; canonical-bytes
  `flagship/demo-directive/v1`). Add verify on the client side
  (iOS `FlagshipCore`/recovery path, Android, webapp) — client honors it only if the
  signature verifies.
- **Deploy:** `cd apps/com && npx wrangler d1 execute flagship-state --file=../../packages/storage/migrations/0021_is_demo.sql --remote` then `npx wrangler deploy`.
- **Test gate:** vitest + tsc; manual: a non-demo user gets no directive; a row with
  `is_demo=1` returns a signature that verifies.
- **Done-when:** demo login is driven by a *server-signed* flag, not a client build flag.

### Phase 2 — Custom-domain `.com` core: the POST path (#79 part A)

- **C2.1** D1 migration `0022_custom_domain_orders.sql`: table
  `custom_domain_orders(app_id, user_id, fqdn, status TEXT /* pending|active|failed */,
  last_changed INTEGER, fail_count INTEGER DEFAULT 0, created_at, updated_at,
  PRIMARY KEY(app_id, user_id))` — one row per package-user pair (destructive replace).
- **C2.2** `packages/control-plane/src/customDomain.ts` (+ wire in
  `apps/com` routes): `POST /api/users/:u/apps/:appId/custom-domain` — IRK-sig verify,
  300 s rate-limit off `last_changed` → `429 {reason}`, else upsert row `status=pending`
  (destructive overwrite of any prior), `200 {recorded:true}`. `GET …/custom-domain`
  → current row. Replace = the upsert; mark prior fqdn for a DELETE push (Phase 4).
  Subdomain-only guard server-side too (defense-in-depth; apex → 400).
- **C2.3** tests in `packages/control-plane/tests/customDomain.test.ts` (rate-limit,
  destructive overwrite, apex reject, sig reject).
- **C2.4** flip iOS `LiveFlagshipServerClient.setCustomDomain` (the 501 stub ~line
  1256) onto the real endpoint; same for Android/webapp Live clients.
- **Deploy:** `wrangler d1 execute … 0022 …` + `wrangler deploy`.
- **Test gate:** vitest+tsc; **live:** from the iOS sim against real `.com`, set a
  domain → 200, retry within 5 min → 429 with countdown still honored.
- **Done-when:** the decoupled request path is real (no Mock) end-to-end for iOS.

### Phase 3 — `.services` RAM routing + control channel (#86, #87)

- **C3.1** `.services` RAM table (#86): in `apps/web/src/tunnel/` add
  `RedirectionTable` = `Map<fqdn, podCanonical>`; integrate into `registry.findBySni`
  as a fallback (custom fqdn → podCanonical → existing tunnel). Add/remove APIs +
  metrics. Pure RAM.
- **C3.2** `.com`↔`.services` authed control channel: shared secret env
  (`SERVICES_CONTROL_SECRET` on both `apps/com` wrangler secret + Fly secret). New
  `.services` Fastify route `POST /control/redirections` (auth: HMAC/secret) accepting
  `{op:"add"|"delete", fqdn, podCanonical}`. Register in `apps/web/src/server.ts`.
- **C3.3** cold-start pull: on `.services` boot, `GET` `.com`
  `/internal/active-redirections` (authed, returns all `status=active` rows) → load
  into RAM. Also the lazy path: `findBySni` miss → one-shot authed `.com` lookup for
  that fqdn, negative-cache misses, rate-limit.
- **C3.4** `.com` side of #87: serve `/internal/active-redirections` (authed) +
  a `pushRedirection(op,fqdn,pod)` helper used by Phase 4.
- **Deploy:** `wrangler secret put SERVICES_CONTROL_SECRET` + `wrangler deploy`;
  `flyctl secrets set SERVICES_CONTROL_SECRET=… -a flagship-services` + `flyctl deploy
  --remote-only --strategy=immediate --yes -a flagship-services`.
- **Test gate:** vitest+tsc; **live:** manually insert an active row, restart
  `.services`, confirm it pulls it; push an ADD/DELETE and confirm RAM mutates.
- **Done-when:** routing for a known fqdn resolves to the right tunnel; survives a
  `.services` restart via cold-start pull.

### Phase 4 — Async verify + cert + lifecycle (#79 part B, #82)

- **C4.1** async CNAME verifier (Worker cron / queue): pick `pending` orders, resolve
  the fqdn's CNAME (server-authoritative; DoH or Worker DNS), require it points at the
  user stub. Success → `status=active`, `pushRedirection("add")`, ACME TLS-ALPN-01 for
  the custom FQDN on the lead pod, replicate cert/key over the `sibling/` channel
  (NEVER `peerBackup`), push outcome to all control panes (flip per-app
  `customDomainConfirmed=true`). Failure path on a *replace* → `pushRedirection
  ("delete", oldFqdn)` then the new add on its own success; terminal failure →
  `status=failed`, `pushRedirection("delete")`, outcome push "unable to set up for
  [canonical]". Backoff/giveup per §2.
- **C4.2** #82 sweep: Worker scheduled (cron, every 12 h) re-verifies `active` orders;
  on failure `fail_count++`; on success reset to 0; invalidate (→ `failed` + DELETE
  push + control-pane notify, fixed-enum reason "CNAME no longer points here") after
  3 consecutive fails spanning ≥24 h.
- **C4.3** tests for verify state machine + sweep grace + replace two-message order.
- **Deploy:** `wrangler deploy` (cron triggers in `apps/com/wrangler.toml`).
- **Test gate:** vitest+tsc; **live north-star:** point a real test subdomain's CNAME
  at the stub, set it in the app, watch it go pending→active, hit it in a browser and
  get a **real green padlock** (the project's canonical proof); then break the CNAME,
  watch the sweep invalidate it within grace.
- **Done-when:** a real external subdomain serves a real app over TLS, and a broken
  CNAME self-removes.

### Phase 5 — Demo lifecycle tooling (#85, #83)

- **C5.1** #85: gate LLM spend for `is_demo` users in the control-plane usage path
  (`packages/control-plane` + `packages/llm-providers`): rolling-24 h token ledger,
  hard stop with "demo quota reached" (no billing, graceful). Default cap §2.
- **C5.2** #83 `provisionDemoUser(name)`: one operator command (script under
  `scripts/` or a `packages/` CLI) — WebAuthn assertion from a registered platform
  security key (verify against stored credential) → create `is_demo` user, seed
  sample data, provision a cloud VPS with the boot image
  (`packages/iso-personalizer` / `installer/`), set the demo LLM cap. Prints creds.
- **C5.3** #83 `decommissionDemoUser(name)`: YubiKey-gated; HARD delete — every D1/R2
  row for the user, the VM, all routing entries (DELETE pushes to `.services`). The
  ONLY teardown. No cron.
- **Test gate:** dry-run against a throwaway name; verify decommission leaves zero
  residue (D1 query + R2 list + Fly machine list + `.services` RAM).
- **Done-when:** `provisionDemoUser` then `decommissionDemoUser` round-trips cleanly,
  both refusing without a valid registered-key signature.

### Phase 6 — Client parity: Android + webapp (#80, #81)

- **C6.1** Android `AppDetailScreen.kt` + VM: mirror the iOS custom-domain UX — SET
  CUSTOM DOMAIN section (uppercase label style), real aligned Add button, failure
  alerts (apex→www, permanent-replace, rate-limit), on-device cooldown
  (SharedPreferences) + countdown, no phone CNAME check, decoupled 200, CUSTOM DOMAIN
  group atop WEB DOMAINS, apps-list short→custom swap gated on `customDomainConfirmed`.
  Wire Android Live client to the real `.com` endpoint.
- **C6.2** webapp `app-detail.js` + `apps-list.js`: same behaviors; `localStorage`
  cooldown; Live `screensFetch`/`.com` calls.
- **Test gate:** vitest+tsc green; `node --check` the webapp JS; Android reviewed
  (no JDK on the build Mac — manual review against the iOS reference, as established).
- **Done-when:** all three clients behaviorally identical against the real backend.

---

## 5. Cross-cutting conventions

- Tests every change: `npx tsc -b` && `npx vitest run` (must stay green: currently
  2359). iOS: `cd apps/mobile/ios/App && xcodebuild … build` + `xcodebuild test
  -scheme FlagshipMobileTests …` (232 green). Refresh sims after iOS changes
  (`simctl install`/`launch … -smoke-mode YES`, bundle `com.flagshipserver.app`,
  sims B4A03E7C iPhone, B42E653C iPad).
- Android cannot be compiled on this Mac (no JDK) — review line-by-line vs the iOS
  reference; that is the accepted bar here.
- Commits: imperative subject, body = why, **no Co-Authored-By trailer**. One logical
  change per commit. Push after each phase (or each green commit).
- Deploys: `.com` → `cd apps/com && npx wrangler deploy`; D1 →
  `npx wrangler d1 execute flagship-state --file=… --remote`; `.services` →
  `export PATH="$HOME/.fly/bin:$PATH"; flyctl deploy --remote-only
  --strategy=immediate --yes -a flagship-services`. Inform the user + run.
- Security-sensitive backend (#79/#82/#83/#87): build behind the decided design;
  do not re-introduce Mock pretense on the live path.

## 6. Resume instructions (cold session)

1. Read agent memory `project_external_domains.md` + `project_voici_appid.md` (design
   truth), then this file (execution).
2. `TaskList` — pick the lowest-numbered pending task whose dependencies (§3) are met.
3. Phases are ordered for dependency safety: do them in order 1→6. Within a phase,
   commits are independent unless noted.
4. After each phase: tests green, commit, push, deploy (inform user), tick the task.
5. Open knobs (§2): proceed on the defaults; surface them once for confirmation but
   don't block.

**Recommended start next session:** Phase 1 (#84) — smallest, unblocks the demo line —
unless the user wants Phase 6 (Android/web parity, fully independent) done in parallel
first.
