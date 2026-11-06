# 0.4 list

Work the owner has put on 0.4. F6b (the gym on a private test CA, `docs/gym-test-acme.md`) comes first, after the
0.3 release and before anything here.

- **BEFORE ANY 0.4 WORK: finish what 0.3's release step 36 skipped (owner, 2026-11-06).** The owner skipped step 36
  (reap orphaned DNS records and demo servers, then zone-health) in the 0.3 phase B run because the gym sweep half
  answered 401: release.sh runs `tools/live-e2e/sweep-cli.ts` without `GYM_ADMIN_SECRET` (it reads
  `GYM_ADMIN_SECRET || FLAGSHIP_ADMIN_SECRET`, and the release shell has neither for the gym). So neither half ran:
  (1) the production reap (`npm run reap-orphans`, dry run then `--apply`, keeping `playstore-test-0725` and every
  "left on purpose" record) and `npm run zone-health`; (2) the gym sweep (`flagship-env=gym` servers and gym DNS).
  Before starting 0.4: run `release.sh --only 36` with `GYM_ADMIN_SECRET` set from `.gym-secrets.env` (or the two
  halves by hand), and fix release.sh so step 36 loads the gym secret itself (or asks for it) and a failed gym dry run
  stops before the destroy prompt instead of asking to destroy an empty list. Also decide with the owner how the gym
  sweep should get its secret in future releases.
- **UnifiedPush for de-Googled Android (owner, 2026-11-05).** Today every push goes through Firebase
  (`apps/mobile/android/.../push/FlagshipFcmService.kt`, `PushRegistrar.kt`), so a phone without Play Services
  (GrapheneOS without sandboxed Play, LineageOS, CalyxOS, /e/) gets no pushes at all, e.g. "your server needs
  approving to start", and only sees requests when the app is opened. Add UnifiedPush as a second push path: the
  app registers with whatever distributor the phone has (ntfy, NextPush, the microG/FCM distributor), signs the
  endpoint URL like the FCM token, and `.com` sends the same content-free payload to it. Keep: pushes carry no
  content; the endpoint is per device and revoked with it; FCM stays the default where Play Services exists. Show
  in Settings which path is in use and say when none is. Also check on a real de-Googled phone what else degrades
  (Messages falls to the unattested tier; passkey recovery needs a provider such as Bitwarden or Proton Pass; the
  Wear OS companion needs Play Services on both ends).

- **Quantum-safe by default, in three stages (owner, 2026-11-05).** In 0.3 release signatures, install packages and
  new CA leases are hybrid, but "Quantum-safe protection" (the hybrid X-Wing channel and strict mode,
  `docs/architecture-v2/pq-suites.md` §13.6) is opt-in per server, and the strict crypto-graph check
  (`full-test-vm.sh` suite crypto-graph) still finds all 18 strict targets reachable through classical-only keys
  (e.g. the Ed25519 admin root authorizing app access, device enrolment, recovery). Default-on strict today would
  refuse browsers/WebViews without ML-KEM, classical connectors and older apps, while leaving those paths open.
  1. Close the bypasses the crypto-graph lists, starting with a hybrid admin root; the strict check goes green.
  2. Hybrid channel on by default wherever both ends support it, falling back to classical without refusing
     (nothing breaks; most traffic becomes quantum-safe). Measure how many sessions fall back.
  3. After the external review and with the bypass list empty: strict on by default for new accounts, a clear
     switch for existing ones, and the apps explain each refusal.

- **Take the zone-wide DNS token off `.com` (owner, 2026-11-05).** Cloudflare can't scope a token by record type or
  name, so `.com`'s `CLOUDFLARE_DNS_API_TOKEN` can rewrite all of `flagship.services`, including the `*` wildcard; a
  `.com` compromise could redirect every server name (it still could not read traffic: TLS ends on the box and the
  apps pin box certificates). `apps/dns-broker` was built to be the only holder of that token, but production never
  turned it on (`DNS_BROKER_URL` unset, the Worker never deployed; release step 20 was skipped for 0.3) and in 0.3 its
  remaining job, challenge TXT records, moved to the issuance service (`apps/com/src/certificateIssuance.ts`). Move
  those `_acme-challenge` writes (and any other DNS write `.com` still makes) behind the broker, or a small dedicated
  Worker, with a policy that allows only challenge TXT under names `.com` has an open order for, set `DNS_BROKER_URL`,
  then delete the token from `.com`. Also make release step 20 skip itself while `DNS_BROKER_URL` is unset.
- **A hybrid release catalog (owner, 2026-11-05).** The catalog root and timestamp keys are Ed25519 only
  (`tools/release-catalog/catalog.ts`). A forged catalog can only delay or withhold releases, since every release it
  names also needs the hybrid endorsement and a hybrid-signed artifact, but it belongs with the quantum-safe item.
