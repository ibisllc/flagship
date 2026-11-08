# Direct access, short names and what each domain is for

Status: LOCKED IN for 0.4 (owner, 2026-11-08). Nothing here is built. Planned for 0.4
(`docs/release-0.4-list.md`, item "Direct access"). Every choice below is decided; the
owner may reopen any of them, and the price is set at launch.

## 1. The idea

Today every visitor and every app reaches a box through the Fly relay:
`<service>.<box>.<user>.flagship.services` resolves by the root wildcard to the relay,
the relay pipes the encrypted stream down the box's tunnel, and TLS ends on the box.
Relay traffic counts against the user's relay quota (both directions) and costs us
egress.

**Direct access:** when a box can be reached from the internet (a public IPv6 address,
or IPv4 with port 443 forwarded), the owner can give an app a **direct name** on a
separate domain. Its DNS record points at the box itself, the box holds the
certificate, and visitors connect straight to the box. Fly never carries that
traffic, so it is free of relay quota.

**Decided (owner, 2026-11-08):**
- Not a "dumb redirect": a short name that only 302s to the `flagship.services`
  address was rejected. The direct domain carries real DNS records to the device.
- Override the "no per-box records" rule of `docs/wildcard-dns.md` §6, but keep
  those records out of `flagship.services` (see §2).
- Turning direct access on is a sensitive setting: biometric, admin-root-signed
  order (the `authorizeSensitiveOrder` path).
- **The direct path is the owner's infrastructure, not ours (owner, 2026-11-08).**
  We publish exactly the records the owner signs and nothing else. No relay
  fallback for IPv4 visitors, no repointing to the relay when the box is down, no
  automatic health checks that change records. Someone who picks a direct name may
  want the guarantee that its traffic goes only through their own infrastructure,
  and we trust them to run it. Owners may set AAAA **and A** records, so a company
  can point names at its own addresses (this is aimed at corporate users building
  their infrastructure on Flagship). If a direct name doesn't answer, that is the
  owner's to fix; the relay names keep working regardless.

Two layers, built in this order:
1. **App-side direct path (no DNS).** Extend LAN-direct (`docs/lan-direct.md`) to
   public addresses: the box adds its public endpoint to a new version of its
   STK-signed hint, and the owner's apps verify, probe with a pinned TLS handshake,
   prefer it, and fall back to the relay. Owner devices and box-to-box app copies
   benefit; visitors don't. Needs no new domain.
2. **Direct names (DNS).** Visitors and browsers go direct through names on the
   direct domain. The rest of this document is about this layer.

## 2. What each domain is for

| Domain | Path | Holds | Proxied by Cloudflare? |
|---|---|---|---|
| `flagshipserver.com` | control plane | identity, `.com` API, website, webapp (`webapp.`/`remote.`), recovery, boot | yes (Worker) |
| `flagship.services` | **relay path** | every canonical name (`<box>.<user>`, `<svc>.<box>.<user>`, `<svc>.<user>`); a pure wildcard to the relay, zero per-box records | no (DNS only) |
| `fshp.app` | **direct path** | only direct names of opted-in apps, each with the A/AAAA records its owner signed (normally the box) | no (DNS only) |
| `voi.ci` | shortener + public pages | the user's voi.ci page (profile + Messages), short links | yes (Worker) |
| `fshp.tech` | website mirror | the competition mirror of the site; every subdomain redirects | yes (Worker) |

**Decided: a separate direct domain (rather than direct records in
`flagship.services`), because:**
- `flagship.services` keeps the property `wildcard-dns.md` fought for: one wildcard,
  no per-box records, no record churn, no NXDOMAIN windows mid-write. A record at
  `<box>.<user>` would hide every name below it from the wildcard.
- The URL says which path it takes: `fshp.app` goes straight to the device,
  `flagship.services` goes through the relay. Easy to explain, and quota accounting
  is simple.
- The home address appears only under names the owner opted into.
- Blast radius: if one direct name gets `fshp.app` blocklisted (phishing), the
  canonical names and the relay are untouched.
- Rejected alternative: moving the relay to a new domain and turning
  `flagship.services` into the direct domain. Every installed box, certificate,
  signed domain and share link names `flagship.services`.

**Consequences:**
- **Move the website mirror off `fshp.app`** (keep it on `fshp.tech` only). A
  blocklisting caused by user content would take the mirror with it, and the
  mirror's catch-all (`*.fshp.app` → same name under `flagship.services`, proxied)
  conflicts with DNS-only direct names. Today's mirror code lives in
  `apps/com/src/mirrorDomains.ts` and `apps/web/public/theme.js`; remove `fshp.app`
  from both, and delete its proxied `@`, `*`, `www` records once direct names exist.
  The bare `fshp.app` shows one short page explaining direct names (no catch-all,
  no mirror).
- Names the user doesn't register on `fshp.app` should answer nothing (NXDOMAIN),
  not redirect.
- Control traffic never uses direct names: the phone talks to its box by the
  canonical name it gets from the signed directory and pins that certificate. A
  direct name is for visitors. (A mutable name table at `.com` must never sit in the
  control path; pinning would turn tampering into an outage, but there's no reason
  to add the dependency.)
- The user-level voi.ci page keeps its own job: a box-independent public presence
  (up while the box is off, never reveals the box). A user-level name only ever
  leads to that page or to an app's name, never to a box address.

## 3. Names and pricing

**Decided:**
- **Free, derived name** for every opted-in app, following the existing
  `<slug>--<creator>` convention (`docs/service-addressing-double-dash.md`):
  `game--john-doe.fshp.app`. Not scarce, so nothing to squat, and every owner gets
  a quota-free path.
- **Paid, yearly vanity name**: `johngame.fshp.app`. Charging is justified because
  short names are scarce (a price stops hoarding; yearly renewal frees abandoned
  ones) and each name has a real running cost (DNS records, certificates, abuse
  handling). It fits an existing paid surface (reserved/custom
  names, `docs/monetization-free-tier-first.md`; branch `feat/custom-names`), so it
  is not a fifth paid item. Price $5–12/year, not $1: card fees take about a third of
  $1, and an in-app purchase on iOS costs another 15–30%. Sell on the web or bundle
  into Pro.
- Direct access itself is not priced: every direct byte saves us relay egress.
- Vanity names can't contain `--`, so they never collide with derived names.
- The earlier "Pro only?" debate on direct access: recommendation stays free (it
  is the cheaper path for us); the paid part is the scarce name.
- Gating code for the paid names lives on a branch off `feat/marketplace` (it needs
  the payment rail); the free mechanism can ship on `main`.

## 4. The Public Suffix List and certificates

**Do we need several PSL entries?** One entry per suffix under which users get
names. `fshp.app` alone would make every `x.fshp.app` its own registrable domain
(flat names, so no deeper entry needed; a tree like `x.d.fshp.app` would need
`d.fshp.app` instead). `flagship.services` is a second, separate entry (its
submission is described in `docs/psl-submission-flagship-services.md`). `fshp.tech`
needs none (only our own mirror). So two entries in total, eventually.

**But the PSL is not available to us yet.** The `flagship.services` submission was
closed in May 2026 (PR #2897): the maintainers want 2,000–3,000 real users first and
said the PSL is not for working around Let's Encrypt limits. A `fshp.app` submission
would meet the same answer. Plan for life without it:
- **Let's Encrypt limit.** Without a PSL entry, all of `fshp.app` shares one
  "certificates per registered domain" budget (50 new certificates a week). Renewals
  of an existing certificate don't count against it, so the steady state is fine;
  the limit caps how many *new* direct names can be issued per week. Options: ask
  Let's Encrypt for a rate-limit increase for `fshp.app` (they have a form for
  hosting providers), queue issuance and tell the user the expected wait, or ration
  vanity names. A shared wildcard `*.fshp.app` certificate is **not** an option: it
  would have to sit on every box, so any box could impersonate any name.
- **Cookies.** Without a PSL entry, `a.fshp.app` can set a cookie for `fshp.app`
  that the browser then sends to `b.fshp.app` (cookie tossing: session fixation or
  confusion between users' apps). The same exposure exists today on
  `flagship.services`. Document it in the app developer guide (use `__Host-`
  cookies, which can't carry a Domain attribute), and consider having the harness
  strip `Domain=` from apps' `Set-Cookie` on direct names.
- **PSL requirements when the time comes:** a `_psl` TXT record, and the domain
  registered at least two years ahead. Renew `fshp.app` well ahead of any
  submission. Removal from the PSL is slow; the suffix layout is fixed now: flat
  names directly under `fshp.app`, one entry `fshp.app`.
- **Issuance.** The box needs its own certificate for each direct name (derived and
  vanity). Either DNS-01 in the `fshp.app` zone through the issuance service
  (`apps/com/src/certificateIssuance.ts`), or TLS-ALPN-01 straight to the box now
  that it is reachable (Let's Encrypt validates over IPv6 when an AAAA record
  exists). DNS-01 also works before the box is reachable from outside.
  If DNS-01, the 0.4 item "take the zone-wide DNS token off `.com`" applies to this
  zone too: the token that writes `fshp.app` should allow only these records.
- **CT monitoring.** Extend the existing certificate-transparency scan to
  `fshp.app`: we control the zone, so we could mint a certificate for any name; the
  owner should be warned about any certificate the box didn't ask for.

## 5. Edge cases

**Reachability: the owner's job (see §1)**
- **Out of scope for us:** IPv4 for IPv6-only homes, CGNAT, port forwarding,
  router firewalls, a box that is down, a path that accepts TCP and then fails.
  None of these makes us change a record or route through the relay. All traffic
  on a direct name is off the relay, so it is all free of relay quota.
- **What we still give the owner:** a diagnostic, not a gate. The app can run an
  outside probe (from `.com` or the relay, with SNI = the name) and show
  "reachable" / "not reachable from outside", so a home user isn't left guessing.
  It never changes records.
- **Records the owner may set:** AAAA and A, one or several (a company may list
  several addresses). No CNAME in 0.4 (it would let a name follow a third party's
  DNS that we can't see; reconsider with corporate users). Private, loopback,
  link-local and other non-public addresses (RFC 1918, ULA, CGNAT, …) are refused:
  public DNS pointing at them is a DNS-rebinding vector against visitors' own
  networks. A corporate internal-only exception can be designed later.
- **Address changes:** the owner's choice of how to keep records current. By
  default, the box may update its own record with STK-signed updates inside the
  owner's grant (e.g. the approved /56 prefix), as a convenience for home users; a
  change outside the grant, or any record pointing somewhere other than the box,
  needs a new biometric order. TTL 60 s; some resolvers ignore TTLs, so expect
  stragglers on an old address.
- **App moves to another box:** the owner re-points the name (the app can offer
  it as part of the move); nothing re-points it automatically. Leader names
  (`<svc>.<user>`) stay relay-only.
- **Several apps on one box:** each name points at the box address; the box routes
  by SNI to the app and holds a certificate per name.
- **Names pointing at a non-Flagship host.** With owner-set A/AAAA records, a name
  can lead to any server, and that server can get its own Let's Encrypt
  certificate for the name (HTTP-01 / TLS-ALPN-01), so "TLS ends on a Flagship box"
  stops being guaranteed for that name. Decided: every direct name gets a CAA
  record bound to the box's ACME account (`accounturi`) **by default**, so only the
  owner's box can get a certificate for it. An owner pointing a name at another
  host turns that CAA off in the same biometric order (their choice, consistent
  with trusting them). It also limits abuse (below).

**Privacy and exposure**
- **The home IP becomes public, and stays public.** Passive-DNS services record
  every answer forever, so turning direct access off doesn't erase the history.
  The opt-in screen must say this plainly, along with: the box now accepts
  connections from the internet on 443; DDoS lands on the home connection; some
  residential ISPs forbid servers in their terms.
- The box applies the same caps as LAN-direct (256 connections, 5 s for the first
  bytes, 5 min idle), and app access gating (`docs/service-access-gating.md`) works
  unchanged because it runs on the box.

**Name lifecycle**
- Account rename: derived names change with the username; move or alias them the
  way `feat/custom-names` moves voi.ci names. Transfer-a-box and account deletion:
  release or re-home the names. Vanity renewal: a grace period before the name
  lapses, then a hold before anyone else can take it.
- Reserved words: the mirror's old labels (`www`, `webapp`, `remote`, `recovery`,
  `boot`), our own names, and the existing reserved / impersonation / trademark
  checks. ASCII only (no punycode lookalikes).
- Turning direct access off: delete the records, stop the listener, keep the
  certificate until it expires (harmless), and void outstanding hints.

**Abuse**
- A direct name is something we can remove (unlike content on the box), so the
  abuse process gains a lever: suspend the record. Update `abuse.html` to say so.
- One abusive name can get the whole `fshp.app` flagged by Safe Browsing. That's
  another reason to keep the mirror off it, and to react quickly to reports.
- Owner-set A/AAAA records let a name front any server, including a phishing host
  that never ran Flagship. Suspending the record still works, and the default
  per-name CAA (see "Reachability") stops such a host getting a certificate unless
  the owner turned it off.

**Operations**
- DNS record limits and cost: Cloudflare caps records per zone on lower plans, and
  its API is rate-limited, so at scale the zone needs a paid plan or another DNS
  provider. Batch updates.
- Quota accounting: the relay counts only relay traffic, so direct traffic falls
  out naturally.
- Payment: web checkout or Pro bundle (see §3); in-app sales on iOS lose 15–30%.

## 6. Work breakdown (sketch)

1. App-side direct path: hint v2 with public endpoints behind the owner's signed
   order; daemon public listener; client probe/prefer/fallback (iOS, Android).
2. Protocol: the direct-access order canonical, the box's signed address update,
   golden vectors (TS/Swift/Kotlin).
3. `.com`: direct-name registry (derived + vanity), the outside reachability prober,
   record publish/withdraw of the owner-signed records in the `fshp.app` zone, the
   optional outside-probe diagnostic, optional per-name CAA, certificate issuance for
   the names, CT watch, renewal and lapse.
4. (No relay work: the direct path never touches the relay.)
5. Clients: the opt-in screen (address, reachability, privacy warning, biometric
   confirm), name management, and the share UI choosing the direct or the relay
   link.
6. Remove `fshp.app` from the website mirror and delete its proxied records.
7. Tests: forged or unsigned orders refused; wrong-box address fails the probe;
   only owner-signed records are ever published; private addresses refused by
   default; withdrawal on decommission, transfer and deletion; rename moves names.
