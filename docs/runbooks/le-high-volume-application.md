# Let's Encrypt high-volume issuer — application runbook

Status: **not yet submitted**. This file is the application package — the
content + supporting links Harry pastes into the form when ready.

Application form: <https://isrg.formstack.com/forms/high_volume_issuer>

## Why we need it

`flagship.services` is a single registered domain on Let's Encrypt's public
rate-limit ceiling. Without an exception:

- **50 certificates / week** per registered domain on the standard ceiling.
- Even with **wildcard issuance via DNS-01** (which we ship — see
  `packages/services-zone/` + the daemon's `RemoteDnsChallengeWriter`),
  every Flagship user needs one wildcard `*.<server>.<user>.flagship.services`
  cert every ~60 days (renewals at the standard 30-day mark on a 90-day cert).
- Steady-state that's **~1 cert per user per 90 days**, so the 50/week
  ceiling caps us at roughly **~200 active users** before issuance starts
  failing. We can't ship a public launch under that.

The high-volume issuer program lifts the per-registered-domain ceiling for
service providers that hand out subdomains to many distinct end users. We
match the program's intent exactly: each Flagship user controls their own
subdomain via DNS-01 challenges; we are not hoarding certs for ourselves.

## Architectural pre-reqs (already done)

These are the facts the application asks us to demonstrate. Each link is
the in-repo source of truth.

- **Wildcard via DNS-01** — `packages/services-zone/` exposes the
  publisher; `packages/server-daemon/src/acme/` orchestrates the challenge;
  default `wildcard: true` on the daemon ACME runtime. One cert per user
  per renewal cycle, not per app.
- **No-KYC tenet** — `docs/policy/no-kyc.md`. We do not hold user
  identity. The cert is issued by Let's Encrypt directly to the user's
  daemon over TLS-ALPN-01 / DNS-01 on a subdomain the user controls.
- **SNI passthrough** — `apps/web/`'s Fly app on `:443` is a raw TCP
  pipe; `flagship.services` literally cannot read or impersonate the
  user's TLS session. Private key never leaves the user's hardware.
- **Stable subdomain naming** — `<server>.<user>.flagship.services`
  (see `packages/services-zone/` validation). The user owns the leaf
  via their phone-held RCK / IRK, not via an account at flagshipserver.com.

## Pre-filled application answers

The form fields below are the ones Let's Encrypt exposes today; if the
form is reorganized, the *content* still maps over.

### Organization / contact

| Field | Value |
|---|---|
| Organization name | **Flagship** |
| Contact name | **Harry Winner Kamdem** |
| Contact email | `harry@flagship.services` (role-based; see `memory/role_based_addresses.md`) |
| Project URL | <https://flagshipserver.com> |
| Project documentation | <https://flagshipserver.com/docs/> |
| Source repository | <https://github.com/ibisllc/flagship> |
| License | BUSL-1.1 (Change Date 2030-05-03 → Apache 2.0) |

### Subscriber relationship

> Each Flagship user runs their own server on commodity hardware they
> own. The control plane at flagshipserver.com mediates routing only —
> it never sees user TLS traffic and holds no private keys.
>
> When a user installs Flagship, their daemon is bound to a unique
> subdomain of the form `<server>.<user>.flagship.services`. Only that
> user's hardware can respond to ACME challenges on that subdomain
> (the daemon controls DNS-01 records via a daemon-signed RPC to our
> services-zone publisher, gated by the user's IRK).
>
> The certificate is issued directly to the user's daemon; the private
> key is generated locally on their hardware and never transits our
> infrastructure. We register the subdomain on behalf of the user and
> publish DNS records they sign — we do not hold key material.
>
> This is a hosting-style "subdomain delegation" relationship in the
> spirit of the High-Volume Issuer program: many independent subscribers,
> one registered domain, one issuer relationship per subscriber.

### Challenge type

> Wildcard SAN per user: `*.<server>.<user>.flagship.services` plus the
> apex `<server>.<user>.flagship.services`. Issued via DNS-01 (RFC 8555
> §8.4). One cert per user; renewal cadence 30 days before the 90-day
> expiry.

### Volume estimate

| Horizon | Active users | Certs / week (steady state) | Peak (mass renewal day) |
|---|---|---|---|
| At submission | ~30 | ~3 / wk | ~10 / day |
| Public launch + 6 months | ~200 | ~17 / wk | ~30 / day |
| Year 1 | ~500 | ~40 / wk | ~70 / day |
| Year 2 (target) | ~1000 | ~80 / wk | ~140 / day |
| Year 3 (target) | ~5000 | ~400 / wk | ~700 / day |

Steady-state math: 1 cert per user per 90 days = 7/90 ≈ 0.078 certs / user
/ wk. Renewal is jittered (each daemon picks a renewal time within the
30-day window) so the per-day peak does not compound across the user base.

### Operational claims

- **One cert per user, not per app.** Wildcard SANs cover every app
  hosted under that user's subdomain. No per-app certificate issuance.
- **No retries on failure cascading into rate hits.** ACME retries are
  bounded (exponential backoff with cap; see daemon ACME runtime). On
  hard failure the daemon backs off and surfaces the error to the user
  rather than burning issuance budget.
- **Hard cap on subdomain registration rate** at flagshipserver.com
  (rate-limited per IRK at `apps/com/`). Limits stay below the
  high-volume ceiling we are requesting, with headroom for legitimate
  burst (post-launch press, etc.).
- **Revocation pipeline ready.** `packages/control-plane/` issues
  revocation orders; the daemon honours them via `packages/server-daemon`
  on the next ACME interaction.
- **Reproducible base ISO** — every shipped daemon is built from the
  same reproducible Alpine ISO (`docs/runbooks/iso-reproducibility.md`).
  Any future certificate-handling bug can be traced to an exact bytes
  hash that we (and any auditor) can rebuild.

### Architecture references (paste into the form's "Additional info" box)

- `docs/policy/no-kyc.md` — the tenet that shapes what flagshipserver.com
  is allowed to know about its subscribers. (Short answer: their pubkey
  and chosen username, plus encrypted recovery data we cannot decrypt.)
- `docs/multiplexing.md` — how multiple apps share one wildcard cert
  per user, so cert volume scales with users, not apps.
- `packages/services-zone/` — the subdomain-validation primitive that
  enforces `<server>.<user>.flagship.services` shape and prevents
  cross-user collision.
- `packages/server-daemon/src/acme/` — daemon-side ACME runtime
  (DNS-01 with the services-zone publisher; TLS-ALPN-01 fallback).
- `memory/upcoming_wildcard_cert.md` — the design note for the
  wildcard-cert migration that this application unblocks at scale.

## Submission checklist

When Harry is ready to submit, work through this list top-to-bottom.

### Pre-submission

- [ ] Confirm `flagshipserver.com` and `flagship.services` both resolve
      and the green-padlock chain is healthy (`curl -I https://flagshipserver.com`
      and `curl -I https://flagship.services/api/health`).
- [ ] Confirm we have ≥1 month of production wildcard issuance traffic
      visible in the daemon's ACME logs (so Let's Encrypt can see real
      traffic patterns matching our claim).
- [ ] Snapshot the current registered-user count and per-week issuance
      rate from D1 + `apps/com/`'s registration metrics. Update the
      "Volume estimate" table above with the snapshot numbers.
- [ ] Re-read <https://letsencrypt.org/docs/rate-limits/> and the
      latest "Hosting providers" section to make sure our framing
      still matches the program's current language.
- [ ] Verify `harry@flagship.services` (and / or
      `abuse@flagship.services`) is monitored daily — Let's Encrypt
      sends the program decision and any follow-ups by email.

### Form submission

- [ ] Open <https://isrg.formstack.com/forms/high_volume_issuer> in a
      browser the maintainer logs into; capture a PDF of the submission
      and store under `maintainers/runbooks/le-high-volume/`
      (not in this repo; that path is the offline copy).
- [ ] Paste the answers above; tighten language where the form asks
      for shorter copy. Do not invent technical claims that aren't
      already in the repo at the time of submission.
- [ ] Attach (or link to) one of:
      - the reproducible-ISO release tag (`iso-v*` on GitHub Releases),
      - the public source-repo URL,
      - the no-KYC policy URL: <https://flagshipserver.com/docs/policy/no-kyc>.
- [ ] Hit submit. Note the submission timestamp in
      `maintainers/runbooks/le-high-volume/submitted.txt`.

### Post-submission

- [ ] Wait for the auto-acknowledgement email (typically same-day).
- [ ] Expect a follow-up from the ISRG team within ~2-4 weeks
      requesting clarification on volume estimate or subscriber-relationship
      shape. Reply same-day if possible; quote in-repo source as the
      definitive answer.
- [ ] On approval: bump the daemon's ACME runtime to use the
      high-volume ACME directory if Let's Encrypt provides a separate
      endpoint (current docs suggest the standard endpoint is used with
      the per-domain limit lifted; verify before changing code).
- [ ] Update `memory/upcoming_wildcard_cert.md`: strike the "apply
      for the high-volume exception" item and link the approval email
      / ticket reference.
- [ ] Update `CLAUDE.md` "Outstanding work" section to remove this
      item from the v1-launch blocker list.

### If rejected

- [ ] Read the rejection reason carefully. Common rejection causes:
      volume estimate too low for the program threshold; subscriber
      relationship framed as "we hold their certs" rather than "they
      hold their certs"; missing public documentation of the subscriber
      flow.
- [ ] Update this doc with the response and the revised application
      we plan to send.
- [ ] Re-submit no sooner than 30 days later, unless Let's Encrypt
      explicitly invites a faster re-submission.

## Source of truth

This file is the application package. If you change a claim in it
(volume estimate, subscriber relationship language, architecture
pointer), the change must be reflected in the linked in-repo source
within the same commit. The application reads as a promise back to
Let's Encrypt about what our infrastructure does; the in-repo source
is the authoritative description of what it actually does. Drift
between the two is a maintainer-mandate-level problem.
