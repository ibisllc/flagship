# TODO: human `voi.ci` service names

This is the current product plan from the 2026-10-21 naming discussion. It is
not implemented by this file. Reconcile it with the canonical naming,
monetization and launch documents when the work lands, then remove this TODO.

## Product shape

- Give each publicly exposed service one free, user-chosen path name, for
  example `voi.ci/harrysbar` or `voi.ci/houstonparty`.
- Keep `voi.ci/<slug>` as a 302 redirect to the service's cert-bearing
  `flagship.services` address. Do not turn these into `<slug>.voi.ci` origins or
  issue per-service `voi.ci` certificates.
- The short name identifies the service, not the server. It follows the service
  when placement or leadership moves between boxes.
- Names are globally unique and case-insensitive. Use lowercase ASCII letters,
  digits and hyphens, plus the existing reserved/impersonation-word checks.
- Choosing and using a service name is free. There is no per-name purchase or
  dibs fee.

## Account-wide exposure limits

- Put a tier-dependent cap on the number of services an account may expose at
  once so free names cannot be used for unlimited parking.
- Exact limits remain to be set. The working starting point is Free 5, Pro 50
  and Pro Max 250 active public service names.
- Decide explicitly before implementation whether the cap covers only active
  `voi.ci` names or all publicly exposed services. Capping canonical service
  exposure would change the existing promise that users may install and run any
  number of apps; capping only friendly names would not.

## `.com` dibs

- Apply the account-name dibs holdback to service slugs during the same dibs
  window.
- If `<slug>.com` is registered, only an account that proves control of that
  exact `.com` may claim `voi.ci/<slug>` during the window.
- If `<slug>.com` is not registered, the slug is first-come-first-served.
- After the dibs window, every still-unclaimed slug is first-come-first-served,
  matching the account-name policy.
- Reuse the IRK-bound DNS/HTTP proof. A successful proof may authorize the
  account to claim the matching label in either namespace, but account names
  and service slugs remain separate allocation pools.
- Domain proof unlocks the service's free slug; it does not incur the account
  name's $20 migration/dibs charge.

## Renewable name leases

- A free slug is held by a live service, not forever by an account.
- Liveness must be a successful Flagship probe of that specific service through
  its normal public route, backed by the daemon's service state. Visitor traffic
  must not renew a lease because an owner could otherwise park a dead name with
  a scheduled request. Auth responses such as 401/403 may still prove that the
  service is alive.
- Working timing, to validate in implementation:
  - warn after 21 days without successful liveness;
  - expire the claim after 30 days without successful liveness;
  - return `410 Gone` for a 30-day quarantine;
  - make the slug claimable again after quarantine.
- Use a month rather than a week for expiry: home servers can legitimately be
  unavailable during travel, hardware replacement or a long outage.
- Deleting a service or changing its slug ends the old claim immediately. The
  old slug enters the same quarantine rather than being handed directly to a
  different account.
- Reassignment is intentional: a free service slug is not a permanent property
  right. UI and terms must say this plainly.

## Change and cycling controls

- Give a short correction window after the first selection (working value: 15
  minutes) so a typo does not consume a long cooldown.
- After the correction window, allow one finalized slug change per service per
  seven days. One change per day is too loose for a free global namespace.
- Also enforce an account-wide rolling budget for successful distinct claims.
  Working starting values: Free 10, Pro 100 and Pro Max 500 per 30 days.
- Availability checks and failed claims do not consume the successful-claim
  budget, but receive ordinary enumeration and abuse rate limits.
- Do not permanently ban a previous owner from reclaiming the same slug. After
  quarantine it may reclaim the slug if nobody else has taken it, with no
  priority, and the claim consumes the normal budget.

## Custom domains are the durable option

- `harrysbar.com` pointing directly to a service is a verified custom domain,
  not a `voi.ci` redirect product.
- Custom domains require a recurring Pro subscription. Do not sell lifetime
  routing for a one-time payment, and do not charge both a setup fee and a
  subscription.
- Pro includes one verified custom domain; Pro Max includes multiple/unlimited
  verified custom domains, as already specified by the monetization plan.
- Domain verification and initial attachment are included. Do not charge a
  separate dibs fee when the account proves control of the matching domain.
- "Permanent" means stable while the account controls the domain and maintains
  the required subscription; it is not a lifetime infrastructure promise.
- On subscription lapse, keep the configuration for a working 30-day grace
  period, then stop accepting the custom-domain SNI and fail closed. Canonical
  `flagship.services` and eligible `voi.ci` addresses keep working. A later
  resubscription may restore the mapping after control is reverified.
- Limit custom-domain replacement churn with a cooldown (working value: one
  replacement per 30 days) rather than a setup charge.

## Implementation checklist

- Specify the slug grammar, normalization, reserved list and collision rules.
- Add an IRK-authorized human-slug claim/change protocol bound to a stable
  service ID.
- Extend `voici_links` storage for human slugs, ownership, lease state,
  liveness, expiry, quarantine and claim history; keep opaque one-off codes as a
  separate link kind.
- Make app-bound resolution follow the current service leader/placement.
- Add the liveness probe, warnings, expiry job, quarantine and `410` behavior.
- Enforce tier exposure limits, per-service cooldowns and account claim budgets
  transactionally.
- Apply `.com` registration checks and the existing domain-control challenge
  during the dibs window.
- Add custom-domain subscription grace and fail-closed behavior without
  disturbing the canonical address.
- Cover claim races, rename/delete, offline recovery, reassignment, tier
  downgrade, subscription lapse and abuse limits in tests and parity.
- Update `AGENTS.md` current status and the canonical design docs as the feature
  lands; do not leave this TODO as a second source of truth.
