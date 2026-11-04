# Gym certificates without the public record (proposal, 2026-11-03)

> **Timing (owner, 2026-11-03): build this after the 0.3 release and before any 0.4 work. Not part of 0.3.**

Owner request: gym servers run the real Let's Encrypt (LE) code without real certificates. The gym used 384 certificates in 7 days under `flagship.services`, production's registered domain, all in public Certificate Transparency (CT) logs. Design only.

## What exists today (and makes this cheap)

- In 0.3 only `.com` talks to the CA. The box makes a key and a CSR and polls `.com` (`packages/server-daemon/src/acme/serviceIssuer.ts:5-11`, `runtime.ts:1343-1363`). The box-side `acmeEnvironment` / `FLAGSHIP_ACME_STAGING` (`index.ts:494`) and the keyd LE host allowlist (`packages/keyd/src/acme.ts:17`, `rust/crates/flagship-keyd/src/acme.rs:22`) belong to the old box-side ACME path, which nothing on that path calls any more. The change therefore sits in one place.
- `.com` already reads the CA from config: `ISSUANCE_ACME_DIRECTORY`, which falls back to LE production when unset (`apps/com/src/certificateIssuance.ts:61,348`). The ACME account is stored per directory (`issuance_acme_accounts` keyed `(directory, thumbprint)`, `:356-372`), so switching CAs creates a separate account and never mixes them up.
- The chain check confirms the leaf belongs to the CSR and that each certificate signs the one below it. It pins no LE root (`packages/control-plane/src/issuance/policy.ts:103-117`), so another ACME CA's chain passes.
- DNS-01 is done by `.com` itself (Cloudflare TXT records). No TLS-ALPN-01 is involved.

## A. Plain HTTP through the relay (rejected)

- The relays route `:443` by SNI and pass TLS straight through. Plain HTTP carries no SNI, so the Fly relay and the Rust ingress would need a new HTTP routing mode that production never runs, and the box would need a plaintext listener next to its loopback TLS server.
- Everything the gym exists to prove would go untested:
  - TLS ending on the box;
  - leaf pinning: phones (`BoxCertPinning.swift`, `CertPinInterceptor.kt`), the harness's `ca: [cert.cert]` checks (`tools/live-e2e/lib/phoneSim.ts:517`, `groups/release03/phoneEndpoint.ts:90`), box-to-box `relayFetch.ts:98` / `lanFetch.ts:26`, and serving records that sign certificate hashes (`serviceIssuer.ts:3`);
  - issuance itself.

## B. LE staging (`acme-staging-v02`)

- **Gains:** the real protocol against Boulder, with LE's real CAA checks, multi-perspective validation and rate-limit answers. Its limits are separate from production and much higher (the docs give e.g. 1,500 new orders per account per 3 h).
- **CT:** LE's docs say staging "uses several test CT logs" and that "CT cannot be used to observe staging issued certificates reliably." Test logs answer the standard read API, so anyone can read them. As far as I recall, crt.sh has indexed LE staging certificates in the past (the old "Fake LE" intermediates), but I could not confirm it today. Confidence that staging names stay out of public view: **low**. Treat them as public.
- **Trust:** staging roots ("(STAGING) Pretend Pear X1", "Bogus Broccoli X2", "Yearning Yucca", "Yonder Yam") are in no trust store. Every client has to add them. LE says not to pin the intermediates.
- **CAA:** the apex CAA pins `accounturi=` (`groups/release03/issuance.ts:90-108`), so a staging account would need its own CAA entry.
- **Verdict:** it fixes the budget but not the privacy.

## C. Pebble, run privately for the gym

- LE's own strict ACME test server: no CT, no limits. Per its README it rejects 5 % of valid nonces, reuses authorizations half the time, keeps no state, is HTTPS-only with a test certificate, and **makes a new root and intermediate on every launch** (`/roots/0`, `/intermediates/0` on its management port).
- **DNS-01:** `.com` keeps writing real TXT records. Run Pebble with `-dnsserver 1.1.1.1:53` (the zone's own resolver), so Cloudflare's real records are validated. Skip `PEBBLE_VA_ALWAYS_VALID`: it would stop the DNS writer from being tested.
- **Hosting:** a Worker can only fetch publicly trusted HTTPS. Pebble therefore goes behind a Fly app (`flagship-acme-gym`, Fly's own certificate for `flagship-acme-gym.fly.dev`, which is not under our domain). A small Caddy in the same image passes the Host header through to Pebble's `:14000` and trusts `pebble.minica.pem`. Pebble builds its directory URLs from the Host header, so they come out correct.
- **Cost:** one always-on `shared-cpu-1x` 256 MB machine, about $2 a month, on a shared IPv4.
- **What Pebble does not exercise:** CAA, multi-perspective validation, and real LE rate-limit errors.

## D. Better: Pebble by default plus one real-LE lane (recommended)

- Pebble is the gym's CA for every run.
- A **real-LE lane** runs once per release candidate, and during hardware-test days. It is the same gym, with `ISSUANCE_ACME_DIRECTORY` empty, which falls back to production.
- That lane runs the `issuance` group with I-10 and the budget probe (`tools/live-e2e/lib/acmeProbe.ts`) on one box: about 4 certificates. LE staging is not recommended (CT, above).
- Two alternatives considered:
  - **step-ca** with a fixed gym root committed like `gymTrustMaterial.ts`. Its root never rotates, but it is not LE's code. It is the fallback if Pebble's root rotation proves painful.
  - **A separate registered domain for the gym** (not a subdomain of `flagship.services`). That would split even the real-LE lane off production's 50-a-week budget. It is orthogonal to this proposal and much larger, since `SERVICES_APEX`, the zone and the relay names all change.

## Changes, by where they live

**release/0.3 (behaviour stays config-driven; no gating code):**

1. `certificateIssuance.ts` `acmeClient()`: on `accountDoesNotExist` for a stored `kid`, delete that row and register again. Pebble forgets accounts on restart; production benefits too. About 15 lines plus a test.
2. `tools/live-e2e/shared-run.ts`: read `GET /api/certificates/account`.
   - If `.directory` is not LE production: fetch `<origin>/roots/0` and `/intermediates/0`, append them to `<run>/acme-roots.pem` (keep earlier roots in the file too), and re-exec with `NODE_EXTRA_CA_CERTS`. That covers about 317 harness `fetch("https://${fqdn}…")` calls (Node's fetch uses that CA set).
   - Record the root's fingerprint, and fail at the end if it changed mid-run.
3. The I-10 check and `acmeBudget` skip with "not Let's Encrypt" unless `.directory` is LE.
4. Playwright live specs get `ignoreHTTPSErrors` only off LE. This weakens them, so say so in the run report.
5. Infra: `infra/acme-gym/` (Pebble image pinned by digest, Caddy, `fly.acme-gym.toml` with `auto_stop_machines = "off"`).
   - Pebble env: `PEBBLE_VA_NOSLEEP=1`; keep the default nonce and authorization chaos.
   - Pebble config: if `certificateValidityPeriod` exists in the pinned version (check), set about 7 days so renewal paths run.
6. `apps/com/wrangler.gym.toml`: `ISSUANCE_ACME_DIRECTORY = "https://flagship-acme-gym.fly.dev/dir"`. This is config only. Production's `wrangler.toml` does not get it.

**gym branch only (seams):**

7. Gym boxes: a systemd drop-in sets `NODE_EXTRA_CA_CERTS=/var/flagship/gym-acme-roots.pem`. An `ExecStartPre` fetches the roots from the Pebble app over its publicly trusted certificate. This is needed because box-to-box `relayFetch` uses default trust. Rust on the box does not check box certificates: only `flagship-relay/serving_feed.rs` uses `webpki-roots`, and that is for `.com`.
8. `scripts/gym-refresh.sh`: restart Pebble (fresh root, fresh state), then delete the gym D1 `issuance_acme_accounts` row for the Pebble directory (until item 1 lands).

**Relay names:** keep their real certificates.
- Fly-managed certificates (`flagship-services-gym*.fly.dev`, `gym-b.tunnel.gym…`, `tunnel.gym…`, `fly.gym.relay-b.toml:17-18`) are a handful, issued once and renewed every ~60-90 days.
- gym-c's Caddy issues only when the machine is rebuilt. Keep its storage on disk so a rebuild doesn't issue again.

**Devices in hardware tests:** Pebble's root changes on every launch, and release Android builds trust no user CAs (the app has no `network_security_config`). Run device days on the real-LE lane. iOS (profile plus Certificate Trust Settings) and Mac Studio (keychain) could trust a Pebble root by hand, but it isn't worth it.

## Proving real LE before launch

- Release checklist item: the real-LE lane, green, on the release-candidate commit. Deploy the gym Worker with `--var ISSUANCE_ACME_DIRECTORY:` (empty), run the `issuance` group plus `core` on one box, then redeploy the gym config.
- Production's own post-deploy check (the first real box gets a padlock) stays as it is today.

## Risks

- Pebble restarts mid-run (Fly host maintenance) → new root. Mitigations: the roots file is appended to, not replaced; the fingerprint check flags it; rerun the group.
- LE-only behaviour (CAA, multi-perspective validation, rate-limit errors) is tested only once per release.
- If the Pebble app is down, gym issuance stops. Production is unaffected.
- TXT challenge records still go briefly into the shared zone (not CT).

## Effort and rollout (about 2 days)

1. Build and deploy `flagship-acme-gym`. Check `curl /dir` and `/roots/0`.
2. Land items 1-4 on release/0.3 with tests.
3. Gym branch: items 7-8. Run `gym-refresh.sh`.
4. Set item 6, deploy the gym Worker, run `issuance` + `core` + `serving` + `phoneRoute` live. Confirm 0 new crt.sh entries for `gym.flagship.services`.
5. Run the full gym, then one real-LE lane run to confirm the switch both ways.
6. Add the real-LE lane to `docs/runbooks/release-readiness.md` and AGENTS.md.
