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

> **Progress 2026-05-15:** backend DONE & tested (2369 vitest, tsc clean),
> 4 logical commits local: storage `is_demo` + migration `0021` (C1.1,
> `d57c14f`); protocol `flagship/demo-directive/v1` CA-sign/verify (C1.2a,
> `c938cc1`); control-plane mints the signed directive on `/users/check`
> (C1.2b, `2f8cafa`); plus the plan-doc §7 commit (`a3f9ecf`).
> **Open:** C1.2c client verify (iOS/Android/webapp) — **blocked by the
> maintainer→CA hierarchy** (decided 2026-05-16: add a `CaEndorsement`
> envelope upstream in `ibisllc/maintainers`; CA-pubkey-pin idea dropped).
> Client CA-artifact verification must sit on the real chain. Design:
> `docs/maintainer-ca-endorsement.md`; cross-session context:
> agent-memory `project_maintainer_ca.md`. This supersedes the earlier
> pin-vs-fetch question.
>
> **DEPLOYED LIVE 2026-05-16:** migration `0021_is_demo` applied to
> remote D1 (`changed_db:true`); Worker `flagship-com` deployed (version
> `d62d4c22`); `/api/health` + `/api/users/check` smoke-OK. All flagship
> commits pushed to `origin/main` (`…c5a5773`). #84 **backend is in
> production**; only C1.2c (client verify on the real maintainer→CA
> chain) remains for #84.

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

> **DEPLOYED LIVE 2026-05-16.** Backend done across 3 tested commits
> (`dedad84` protocol `flagship/custom-domain/v1`; `cd085ff` storage
> `custom_domain_orders` + migration `0022`; `8cd55cc` control-plane
> `customDomain.ts` + getAppLinks surfacing + routes). Migration `0022`
> applied to remote D1 (14 tables); Worker deployed (`79cde2ea`);
> smoke-OK (`GET …/custom-domain`→`{fqdn:null}`, malformed POST→400).
> 2398 vitest green. **C2.4 DONE 2026-05-16** (`da6d1d0`): the
> renameApp-style signed-request refactor — `SetCustomDomainClaim`
> canonical bytes + `SetCustomDomainRequest` envelope; protocol method
> is now `setCustomDomain(username:appId:body:)`; Mock keeps the 429
> "Too soon — try again in Ns." (U+2014) + records from the body; Live
> POSTs to `/custom-domain`, decodes `{error}` on non-2xx so the 429
> string is byte-equal to the Mock, re-reads `getAppLinks` on 200
> (decoupled); `AppDetailViewModel.bindCustomDomain` IRK-signs (Face
> ID = 2nd factor). iOS app builds clean; 232 XCTests green. Live ==
> Mock on the wire. (Real exercise still needs TestFlight.)

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

> **Progress 2026-05-16:** **C3.1 DONE** (`f982b54`) — `TunnelRegistry`
> in-RAM `Map<customFqdn,podCanonical>` redirection table; `findBySni`
> fallback (consulted last, never shadows first-party routing; keyed on
> pod canonical so reconnect-transparent); `add/remove/loadRedirections`
> + `redirectionCount`; 6 tests. **C3.2–C3.4 DONE** (`fc8649a`,
> `633c496`): `SERVICES_CONTROL_SECRET` constant-time bearer; `.com`
> `GET /api/internal/active-redirections` + `pushRedirection` (for
> Phase 4); `.services` `POST /control/redirections` + cold-start pull,
> both 5s-bounded/fail-closed; storage `pod_canonical` (migration
> `0023`). 2417 vitest green; tsc clean.
>
> **FULLY DEPLOYED + LIVE-VERIFIED 2026-05-16 (both sides).** `.com`:
> migration `0023` applied; Worker `830f8609`; `SERVICES_CONTROL_SECRET`
> set. `.services`: flyctl installed (`~/.fly/bin`, v0.4.52, authed
> kamdemharry@gmail.com), deployed (machine `781327c5`), same secret
> set via `flyctl secrets import` (restart ran cold-start). Live smoke:
> `.com /api/internal/active-redirections` bearer→200 `{redirections:[]}`;
> `.services :8443 /control/redirections` no-auth→401, wrong→401,
> bearer→200 `{ok:true,count:0}`; `.services :8443 /api/health` OK
> (fresh process). Shared secret matches Worker↔Fly; on-disk temp
> secret shredded. **Note:** `.services` Fastify/API/control routes are
> on the **`:8443` TLS-term port** (`flagship-services.fly.dev:8443`),
> NOT apex `:443` (raw SNI passthrough). The full channel is
> operational; it carries no data until Phase 4's verifier pushes.
>
> **Lazy SNI-miss→ask-`.com` (#12): tested seam + endpoint DONE +
> DEPLOYED 2026-05-16** (`51931a3`, Worker `b55ffcaa`). `.com`
> `handleRedirectionLookup` + `GET /api/internal/redirection-lookup
> ?fqdn=` (fail-closed bearer, single-fqdn point lookup, 404 →
> negative-cacheable, NO enumeration; live-smoke 401 w/o bearer). 
> `.services` `LazyRedirectionResolver` (first-party-skip, fail-closed,
> hit installs the redirection, negative-cache + in-flight dedupe +
> rolling rate-limit DoS guard, bounded, never-throws). 10 tests.
> **Open follow-on:** the `routeToTunnel` socket-path activation
> (call `resolver.resolve()` on a `findBySni` miss for a non-
> `flagship.services` SNI) — the raw-TCP :443 passthrough hot path
> has no unit harness, so it gets a focused pass (correctness core
> already shipped; this is pure latency optimization).

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

> **Worker side DONE + DEPLOYED 2026-05-16** (`2b4ff92` listByStatus,
> `333aa9d` verifier, `c74dea4` cron wiring; Worker `28c67286`, cron
> `0 */6 * * *`). C4.1a `resolveCnameChain` (Cloudflare DoH, 5s,
> never-throws) + `cnameTargetsStub` (ownership proof: fqdn CNAME →
> `<user>.flagship.services`). C4.1b state machine
> `runCustomDomainVerificationPass`: pending→(CNAME ok + live pod)
> active + store podCanonical + `pushRedirection("add")` + reset
> failCount; ok-but-no-pod stays pending; wrong → failCount++ or, past
> 24h, failed + `pushRedirection("delete")`. C4.2 #82 sweep on active:
> re-verify only if ≥12h since updatedAt; success self-heals
> failCount→0; 3rd consecutive due-fail (≥24h span enforced by the 12h
> cadence) → failed + `pushRedirection("delete")`. Wired into the 6h
> cron (D1Storage + real DoH + real push over the live channel;
> no-ops unless DB+base+secret). 2428 vitest green; tsc clean.
>
> **C4.1c SEAM DONE 2026-05-16** (`d738cac` protocol + `37a7cc9`
> daemon). Built to the seam + tests + documented live step, exactly
> as scoped (its end-to-end is inherently real-infra). Shipped:
> protocol `CustomDomainCert` envelope (async canonical hashing the
> PEMs; sign/verify; 6 tests); `CertManager` per-SNI `customReal`
> map (wildcard path untouched); `acme/customDomainCert.ts` —
> `ensureLeadCustomDomainCert` (lead ACMEs the non-wildcard FQDN via
> the existing `AcmeIssuer`→TLS-ALPN-01, installs for the SNI,
> persists encrypted, STK-signs, replicates) + `receiveCustomDomain
> Cert` (fail-closed) + `CustomDomainCertStore` (fresher-wins);
> siblings receive-only. **THE security rule** enforced 3 ways
> (type-incompatible `SiblingCertSender` vs PeerBackupClient; no
> peerBackup import + guard test; independent STK signature). 10
> daemon tests; 2456 vitest green.
>
> **OPEN — C4.1c runtime wiring (the remaining focused real-infra
> sub-pass).** The seam exists + is tested; what's left needs a real
> pod + DNS + Let's Encrypt and so is deliberately NOT bolted into
> the proven cert/grant planes blind:
>   1. **Sibling-sync frame.** Add a cert-bundle frame family to
>      `sibling/syncFrames.ts` (mirror OFFER/PULL/PUSH 0x10–0x12 →
>      0x20–0x22) + handle it in `syncConnection.ts`, carrying the
>      `CustomDomainCert` bundle + STK signature. The hello already
>      fleet-authenticates the peer pod identity — pass that verified
>      pubkey as `receiveCustomDomainCert`'s `signerPodIdentityPub`.
>   2. **Lead election.** Reuse the existing renewal-leader notion
>      (runtime.ts `controlledDomains`/lead pod). Only the lead calls
>      `ensureLeadCustomDomainCert`; siblings only `receiveCustomDomain
>      Cert` off the new frame.
>   3. **Trigger.** When `.services` pushes an `add` redirection for a
>      confirmed custom FQDN (Phase 3/4 channel), the lead pod learns
>      it owns that FQDN → call `ensureLeadCustomDomainCert`. Hook the
>      renewal loop (`renewIfNeeded`) to also walk active custom FQDNs
>      via `certManager.customNeedsRenewal`.
>   4. **`onCertIssued` reuse.** `issueAndInstall` already has an
>      `onCertIssued` seam — the custom path is the analogous
>      install+persist+replicate.
>   **North-star live exercise (the done-when):** point a real test
>   subdomain CNAME → `<user>.flagship.services`; set it in the app;
>   watch the order go pending→active; on the LEAD pod confirm ACME
>   TLS-ALPN-01 issues a real LE cert for the custom FQDN over the
>   SNI-passthrough chain; `curl https://<custom-fqdn>/` → **real
>   green padlock**; kill the lead pod, confirm a sibling already
>   holds the replicated cert and serves instantly (no re-ACME);
>   verify with `openssl s_client` that the sibling's cert chain ==
>   the lead's (true fleet-scoped replication, not per-box re-issue).
>   Until this wiring + exercise lands, #79B remains "verified+routed
>   but not serving" for the custom FQDN.
>
> **Known follow-on:** replace-time `DELETE(old fqdn)` when an ACTIVE
> domain is destructively replaced (the verifier only sees the new
> fqdn). Stale-routing cleanup, not a security hole; tracked.

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

> **Progress 2026-05-16:** **C5.1 (#85) DONE + DEPLOYED LIVE.** Two
> tested commits: `1252deb` storage `demo_llm_ledger` (append-only
> rolling-window grant log; migration `0024`; InMemory+D1 adapters;
> Storage aggregate both classes; 3 tests) — chose a genuine sliding
> window over a calendar bucket so a demo account can't burst-reset at
> UTC midnight. `eee5fe2` control-plane: `handleLlmPromoIssue` gates an
> `is_demo` claim on a rolling token sum (default 250k/24h, both
> deps-overridable), pessimistically logs the full per-issue grant on
> success, **fails closed** (no ledger dep ⇒ "demo LLM disabled", never
> an uncapped provider key); wired into the production Worker route; 4
> tests. 2435 vitest green; tsc clean. Deployed: migration `0024`
> applied to remote D1 (`changed_db:true`, 15 tables); Worker
> `flagship-com` version `275b95f7`; smoke-OK (`/api/health` ok,
> `POST /api/llm-promo/issue {}`→400 "malformed body" — route wired,
> validation intact). **C5.2/C5.3 (#83) DONE 2026-05-16**
> (`af0c92e`): `scripts/demo-account.mjs` — registered-key-gated,
> dry-run-default operator CLI (rotate-ca discipline); provision/
> decommission plans pure+tested; mutating runs need `--execute` + a
> fresh Ed25519 operator assertion; decommission also types the
> username + is the ONLY teardown; HARD-deletes all 30 user-linked D1
> tables (routing+VM first) + R2; the real wrangler/flyctl/R2 ops are
> the printed operator runbook (real-infra, not auto-fired). 15
> tests. **Phase 5 COMPLETE.**

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

> **Progress 2026-05-16:** **webapp (C6.2) DONE + DEPLOYED LIVE.**
> Two tested commits: `fa078a6` apps-list short→custom swap gated
> strictly on `customDomainConfirmed === true`; `ffb9cdf` app-detail
> replaced the legacy P1.22 TXT-verify model with the Mock-faithful
> decoupled flow — normalize → on-device 300s localStorage cooldown +
> 1s M:SS ticker → structural apex→www `inlineConfirm` → destructive-
> replace confirm → IRK-signed POST to `.com /custom-domain` (canonical
> `flagship/custom-domain/v1|user|appId|fqdn|issuedAt`, mirrors
> `@flagship/protocol` + the iOS Live wire); 200 records only (CUSTOM
> DOMAIN group atop WEB DOMAINS, no pending UI), non-200 shown verbatim
> so 429 == iOS Mock byte-for-byte; removed the url-controller/verify
> cross-view drift. 2440 vitest green; tsc clean; `node --check` OK; 5
> served-asset tests (`webappCustomDomainView.test.ts`). Deployed via
> Worker `[assets]` (`a84204c5`); live-verified on
> `web.flagshipserver.com` (old `expectedTxtRecord` gone, new prompts/
> cooldown/CNAME-guidance/swap all present; an initial `cf-cache-status:
> HIT` was transient CDN lag — origin workers.dev was correct
> throughout).
>
> **C6.1 Android DONE (review-faithful).** Two commits: `8373002`
> data layer (SetCustomDomainClaim canonical bytes; SetCustomDomain
> Request; customDomain/customDomainConfirmed on AppLinksResponse;
> setCustomDomain on FlagshipServerClient; Mock mirrors iOS Mock —
> 300s 429 "Too soon — try again in Ns." U+2014, 6s confirm-delay;
> Live POST→re-read links); `03a1b56` UI layer (RenameAppViewModel
> gains submitCustomDomain/bindCustomDomain + a SharedPreferences
> CustomDomainCooldownStore + CustomDomainPrompt; AppDetailScreen
> SET CUSTOM DOMAIN section + CUSTOM DOMAIN group + prompt dialog +
> 1s countdown; AppsListScreen swap gated on customDomainConfirmed;
> SetCustomDomainCanonicalBytesTest pins the wire). **Drift fixed:**
> `apps/mobile/android` DOES exist + is a real Gradle project (earlier
> notes implied scaffolds); but `/usr/bin/java` is the macOS stub
> (`java -version` fails) so it stays **review-only** — the established
> bar holds. Android apps-list is still a `sampleApps()=emptyList()`
> scaffold (no live /links fan-out yet) — the swap is structurally
> correct for when that lands; wiring the fan-out is a separate
> non-#80/#81 task. **Phase 6 COMPLETE.**

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

**Decision (2026-05-15, user):** execute Phases 1→6 strictly in order. This doc is the
single durable launch tracker (extended below to cover the non-external-domain v1 work).

---

## 7. Cross-track sequencing — the rest of v1 launch

The Phase 1–6 spine above is **Track A**. Two more tracks complete v1; this section
folds them into the same timeline so nothing is lost when external-domains ships.

### Track B — CLI-doable, runs alongside Track A

| Item | What | When (relative to Track A) |
|---|---|---|
| **B-tsc** | 5 single-line fixes in `apps/web/e2e/` (missing `dom` lib + module paths: `s11`/`s14`/`s15`/`s16`, `pod-sim.ts`). One tidy commit. | Free standalone — land anytime, ideally before the E2E rig. |
| **B-A2** | Replace-device `complete()` "Take over now" UI (iOS + Android). VM exists (`ReplaceDeviceViewModel`), no button; optional post-24h-grace foreground poll. | After Phase 6 (touches the same client surfaces). |
| **B-A3** | Webapp full Wipe ceremony: IndexedDB UMK rotation + `navigator.credentials.create()` PRF + `Recovery.wrap` over new UMK + OLD-IRK-signed `flagship/wipe-restart/v1` POST. | After Phase 6 (webapp client work). |
| **B-scan** | Marketplace security-scan service (§L): separate Fly app, pull docker image, Trivy + custom checks, post grade + R2 report via authed Worker webhook. Protocol type `TAG_MARKETPLACE_SCAN_RESULT` + `marketplace_listings.scan_grade` already wired. | Independent — schedule after Phase 4 (frees the deploy pipeline). |
| **B-e2e** | The E2E rig itself (`docs/e2e-test-plan.md`): Playwright + pod-sim, 13 scenarios, chromium-first. **Largest single v1 piece.** | Big parallel investment — start once the Track A backend (Phases 2–4) is stable enough to assert against. B-tsc is a prerequisite. |

### Track C — needs a human, a device, or a live multi-day exercise

Cannot be *completed* from this session. Track A/B should leave each in a "one human
step from done" state and document that step.

- **C-A1** Live `WebAuthnProvider` wrappers — iOS `ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest` + PRF, Android `CredentialManager` + PRF JSON. Orchestration above the seam is tested against the Mock; only the platform binding remains. Needs a real authenticator.
- **C-iOS** TestFlight chain (`project_testflight_blockers.md`): `wrangler login` + 4 `APNS_*` secrets, Associated-Domains capability checkbox, Xcode archive, ASC metadata, 5 external testers.
- **C-Android** Play internal track — no JDK on this Mac; Kotlin is review-only here. Build/sign/FCM/upload happens off-Mac.
- **C-exercise** Live multi-day exercises: recovery J.3/J.4 cross-device walk; peer-backup 7-day cross-pod; update-pack pull (2 pods, 7 days); lineage-break re-anchor; STK rotation; lost-phone→new-phone. Each = "run on real infra, document failure modes."
- **C-iso** Reproducible-ISO CI — likely **already exists** (`.github/workflows/build-iso.yml` with a double-build byte-identity check, per `project_v1_alpha_progress`). Action is *verify + tick `build-tasks.md §S`*, not build. `CLAUDE.md`'s outstanding list is stale here.

### Track P — maintainer→CA hierarchy (prerequisite; gates #84 C1.2c)

Decided 2026-05-16. The Flagship CA must be endorsed by the cold maintainer
key via a new `CaEndorsement` envelope **upstream in `ibisllc/maintainers`**
(now-anchored short lease — not the issuedAt-anchored release model). Full
design + spec delta + runbooks + phasing in **`docs/maintainer-ca-endorsement.md`**
(esp. **§10** — the 2026-05-16 ceremony/commit-writer/genesis decisions);
durable cross-session context in agent-memory `project_maintainer_ca.md`.
This **blocks #84 C1.2c** and ultimately hardens all CA-signed artifacts.

**EXPANDED + RE-SCOPED (2026-05-16, user) — execute in a future session,
in this order:**

1. **Push (PRE-AUTHORIZED).** `cd maintainers && git push <ibisllc/
   maintainers> feat/ca-endorsement` + open the governed PR. The push
   is now explicitly authorized; only the PR *merge* is governed/human.
2. **Land + re-pull.** On merge: bump `scripts/maintainers.pinned-sha`
   to the merged SHA + `pull-maintainers.sh`.
3. **Genesis ceremony (CLI + primary YubiKey, pre-release human).**
   Generate the cold maintainer Ed25519 *on the token*, write the
   genesis `Mandate` (ca/release/ops) naming the **second YubiKey** in
   `successors`, emit the pubkey to bake in. New genesis CLI required.
4. **Hardware-token signer sources.** Wire real PIV/FIDO2-resident
   Ed25519 signing into `scripts/rotate-ca.mjs` + the upstream
   `maintainers ca-endorsement` CLI (replace the "staged" local-hex
   source; keep hex only as a labelled air-gapped/successor fallback).
   **No browser signing — ever** (§10.1: PRF derives an exfiltratable
   in-memory root key; total/silent/permanent break). Web-ui = status
   + ceremony-preview + commit-trigger ONLY.
5. **Commit-writer service** (a .com Worker route): holds NO
   maintainer/CA key — only a least-privilege `ibisllc/maintainers`
   contents:write GitHub credential; re-verifies the signed artifact
   chains to the pinned genesis + is append-only, then commits
   (branch + auto-PR). Driven by CLI or website. §10.2.
6. **Baked genesis constant + fail-closed link-1.** Add
   `MAINTAINER_GENESIS_PUBKEYS` (null now). Every consumer verifier
   treats empty-genesis as reject-all-CA-artifacts (safe pre-release;
   demo = mock recovery, no users). Independently fail-closed-tested.
7. **link-4 wiring = #84 C1.2c** (tasks #8/#9/#10): daemon
   `releaseVerifier.ts` ca-path, then webapp, then iOS/Android — a
   one-liner per call site via `authorizedCaKeys`, gated by (6). Now
   unblocked once steps 1–2 land.

Steps 1–2,4,5,6 are CLI/code-doable (push authorized). Only the PR
*merge* (governed) + the real-YubiKey genesis (step 3, human) need a
person; build everything else to that seam + the deterministic
placeholder genesis for tests.

**REFINEMENT (2026-05-16, user — see `docs/maintainer-ca-endorsement.md`
§11):** the primary ceremony surface is now a **dedicated, minimal,
reproducibly-built "Flagship Maintainer" mobile app** — open app →
plain-language ceremony + raw-bytes/diff preview → **tap the YubiKey
(NFC)** → PIV-Ed25519 signs the canonical bytes (key never leaves the
token; PIV-Ed25519 == standard Ed25519 over the same bytes ⇒ upstream
protocol UNCHANGED, and the §10.1 WebAuthn-assertion question is moot)
→ POST to the §10.2 commit-writer. One device, one tap; genesis +
takeover guided in-app. Hardware mandate: YubiKey 5, fw ≥ 5.7
(PIV-Ed25519), NFC, two keys/maintainer, touch=always. Android-first,
**iOS fast-follow (feasible — Core NFC ISO7816 + YubiKit PIV; corrects
the earlier "Apple maybe can't" worry)**. So step 4 ("hardware-token
signer sources") now means BOTH the app's NFC-PIV path (primary) AND
the CLI's USB-PIV path (the air-gapped/store-down/successor escape
hatch — kept, lower-frequency, never the everyday path). New task for
the app itself; `rotate-ca` (hot CA key) stays CLI-only, never on a
phone. Reproducibly build the maintainer app (reuse build-iso.yml's
double-build discipline) so the binary is auditable like the ISO.

**OSS-GENERIC REFRAME (2026-05-16, user — final — see §12):** the app
is **NOT Flagship-specific** — it's a generic OSS companion to
`@maintainers/protocol`, home **upstream in `ibisllc/maintainers`**.
Anyone running any project that adopts the maintainers protocol:
download the app, add a profile `{forge, repo, maintainersPath,
credentialRef}`, save a narrowly-scoped per-repo git credential
(hardware-stored, biometric-gated), tap the YubiKey → the **app
commits directly** to that repo's `.maintainers/`. ⇒ **zero infra for
adopters**; the §10.2 hosted `.com` commit-writer (task #29) is
**downscoped to OPTIONAL/opt-in** (credential-off-phone mode), no
longer the core path. Authority stays ONLY on the YubiKey (never on
the phone); the git credential is write-transport — a stolen token =
one-repo DoS, contained by the offline verifier + append-only walk +
`TakeoverAlarm`, and *cannot forge authority*. Nothing
Flagship-hardcoded: tracks/scope strings read from the target repo's
`.maintainers/` config. Flagship = one configured consumer; its
baked-genesis (#30) + fail-closed link-4 (#8/#9/#10) wiring is the
reference template adopters copy. Task #32 reframed (generic OSS app,
upstream home); #29 downscoped.

### Critical path to v1 alpha

```
Phase 1–4 (Track A backend) ──┐
B-tsc ──→ B-e2e ──────────────┼──→ confidence to ship
Phase 6 ──→ B-A2 / B-A3 ──────┘
C-iso (verify) ─── quick win, do early
C-A1 ──→ C-iOS / C-Android ──→ C-exercise   (gated on a human; surface the punch list each session)
```

`build-tasks.md §S` stays the authoritative ☐→☑ tracker; tick it in the landing commit.
