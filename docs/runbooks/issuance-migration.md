# Moving certificate issuance to `.com` and closing what boxes held before (plan H1, H9)

The API is in `docs/architecture-v2/issuance-service.md`. This runbook is the order of the switch and the inventory of
residual authority: what a box could do before, what is left after the new code is live, and how each is closed.
The phone-isolation guarantee (journal plan H) is not advertised until every row below is closed.

## 1. Inventory: who could get a certificate under the apex before

| Authority | Where it lives | Why it matters | How it is closed |
|---|---|---|---|
| `POST /api/dns-01/publish` + `/delete` on `.com` | `apps/com/src/controlPlaneRoutes.ts` | a box with the account wildcard grant could write `_acme-challenge.<user>.<apex>`, which also validates the bare `<user>.<apex>` (the phone's name) | answers `410 dns01-retired` (code, this release) |
| The dns-broker's `publishTxtChallenge` RPC | `apps/dns-broker` (`workers_dev = true`: reachable directly, not only through `.com`) | same, directly | refused in `policy.ts` (code); redeploy the broker (step 3) or delete it |
| Each box's own ACME account (`/var/flagship/acme/account.pem`, or keyd's account key) | the box | it may hold **valid authorizations** (Let's Encrypt reuses them for up to 30 days) for its names, the account wildcard `*.<user>`, and, if it ever wrote the record, the bare `<user>` | the apex CAA pinned to the service account (`accounturi=`); Let's Encrypt checks CAA again at issuance when the validation is older than 8 hours, so within 8 hours of the CAA no box account can issue. No list of a box's authorizations exists, so they cannot be deactivated one by one |
| The user-level shared ACME account (`acme_account_key_grants`, `acme_account_key_deliveries`, migrations 0043, 0045, 0046) | sealed to phones and boxes | same as a box account | the same CAA pin; and the owner's phone may deactivate that account (`POST <account> {"status":"deactivated"}`) once nothing uses it |
| Certificates already issued | CT logs | a combined box certificate stays valid up to 90 days; a bare `<user>` certificate in a box's hands would let it impersonate the phone endpoint | combined: age out, never renewed (boxes now order control + apps). Bare `<user>`: revoke (step 5). Since 2026-10-30 nothing ordered the bare name, so none is expected |
| Pending orders under the service account | D1 `certificate_orders` | the service itself | the service publishes only its own orders' records, re-checks authorization before answering, finalizing and delivering, and deactivates a failed order's authorizations |

The service's own valid authorizations (it reuses them, which saves CA calls) are usable only by the service's key.

## 2. Order of the switch (part of the 0.3 release)

1. **Secrets and migration** (`final-deploy.md` steps 4 and 5): D1 migration `0121_certificate_issuance.sql`; the
   service's ACME account key as `ISSUANCE_ACME_ACCOUNT_KEY` on prod and on the gym (separate keys):
   ```sh
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /dev/stdout | npx wrangler secret put ISSUANCE_ACME_ACCOUNT_KEY
   ```
   Keep an offline copy of the key (a lost key means a new account URI and a CAA change).
2. **Deploy `.com`.** `GET https://flagshipserver.com/api/certificates/account` answers the account URI; write it
   down. `.com` must hold `CLOUDFLARE_DNS_API_TOKEN` + `CLOUDFLARE_SERVICES_ZONE_ID` (the service does not use the
   broker).
3. **Redeploy (or delete) the dns-broker** so its challenge writer is closed too:
   `cd apps/dns-broker && npm run deploy` (or `npx wrangler delete` if nothing else uses it).
4. **Boxes update** (the endorsed 0.3 box release). On start each box keeps serving its old combined certificate, orders
   a control and an app certificate through the service, and switches to them. Gym first (the `issuance` group).
   Renewal of the old combined certificate never happens again.
5. **Inventory and revoke** (after a week of boxes on the new code):
   ```sh
   node scripts/issuance-inventory.mjs --before <the day of step 2>          # report; exit 1 if a bare-account cert predates the switch
   FLAGSHIP_ADMIN_SECRET=... node scripts/issuance-inventory.mjs --before <day> --revoke
   ```
   `--revoke` asks `.com` to authorize the certificate's names under the service account (DNS-01 in our zone) and revoke
   it (RFC 8555 §7.6). Check crt.sh shows the leaf (not only the precertificate) before revoking.
6. **CAA, the owner's DNS step** (only after renewals through the service are verified on the gym and on a prod box):
   replace the apex CAA pair by the account-pinned pair (Cloudflare dashboard, `flagship.services` zone, `@`):
   ```text
   CAA 0 issue     "letsencrypt.org; accounturi=<the URI from step 2>; validationmethods=dns-01"
   CAA 0 issuewild "letsencrypt.org; accounturi=<the URI from step 2>; validationmethods=dns-01"
   ```
   Remove the plain `issue`/`issuewild "letsencrypt.org"` records in the same edit (a second, unpinned record would
   authorize every account). No per-account or per-box CAA exists (`npm run zone-health` fails on any). The gym zone
   `gym.flagship.services` inherits the apex CAA, so the gym Worker's account must be listed too while the gym shares
   the zone: add a second `issue` and `issuewild` pair with the gym account's URI, never an unpinned one.
   Check: `dig +short CAA flagship.services @1.1.1.1`, then `npm run zone-health`.
7. Then, and only then, the phone isolation guarantee may be advertised (still subject to H2, H3, H5 and the gym's
   adversarial groups).

## 3. Rollback

- Before the CAA step: redeploy the previous `.com` (the dns-01 routes come back) and the previous box release. The
  service's certificates stay valid; nothing needs revoking.
- After the CAA step: boxes cannot issue under their own accounts any more. Roll back the CAA first (back to the plain
  pair), then the code.

## 4. What is still open

- keyd + the Rust ingress serve one active certificate: a box on the arch-v2 stack serves its app certificate (which
  covers its own name through `*.<user>`) and falls back to the control certificate when it has no account wildcard.
  Serving both by SNI needs the ingress to pick a keyd key per name.
- The relay's allocator refuses app slots for connected boxes' own names and for names given to
  `reserveControlNames`; feeding it every registered control name from `.com` is the relay's (H3) work.
- Let's Encrypt's own limits are the published defaults; ask for a rate-limit adjustment for the service account
  before the fleet grows past a few hundred boxes (250 orders per 3 hours is the service's own ceiling).
