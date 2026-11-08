# Direct access, short names and what each domain is for

Status: DESIGN DISCUSSION (owner + Claude, 2026-11-08). Nothing here is built. It is
planned for 0.4 (`docs/release-0.4-list.md`, item "Direct access"). Decisions the owner
has made are marked **Decided**; the rest are proposals with the open questions listed.

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
| `fshp.app` | **direct path** | only direct names of opted-in apps, each a DNS record to a device | no (DNS only) |
| `voi.ci` | shortener + public pages | the user's voi.ci page (profile + Messages), short links | yes (Worker) |
| `fshp.tech` | website mirror | the competition mirror of the site; every subdomain redirects | yes (Worker) |

**Proposal: why a separate direct domain (rather than direct records in
`flagship.services`):**
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
  Decide what the bare `fshp.app` shows (a page explaining direct names, or a
  redirect to the site).
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

**Proposal (owner to decide):**
- **Free, derived name** for every opted-in app, following the existing
  `<slug>--<creator>` convention (`docs/service-addressing-double-dash.md`):
  `game--john-doe.fshp.app`. Not scarce, so nothing to squat, and every owner gets
  a quota-free path.
- **Paid, yearly vanity name**: `johngame.fshp.app`. Charging is justified because
  short names are scarce (a price stops hoarding; yearly renewal frees abandoned
  ones) and each name has a real running cost (DNS records, health checks,
  certificates, abuse handling). It fits an existing paid surface (reserved/custom
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
  submission. Removal from the PSL is slow, so decide the suffix layout before
  submitting.
- **Issuance.** The box needs its own certificate for each direct name (derived and
  vanity). Either DNS-01 in the `fshp.app` zone through the issuance service
  (`apps/com/src/certificateIssuance.ts`), or TLS-ALPN-01 straight to the box now
  that it is reachable (Let's Encrypt validates over IPv6 when an AAAA record
  exists). DNS-01 also works for boxes reachable only through the relay fallback.
  If DNS-01, the 0.4 item "take the zone-wide DNS token off `.com`" applies to this
  zone too: the token that writes `fshp.app` should allow only these records.
- **CT monitoring.** Extend the existing certificate-transparency scan to
  `fshp.app`: we control the zone, so we could mint a certificate for any name; the
  owner should be warned about any certificate the box didn't ask for.

## 5. Edge cases

**Reachability**
- **IPv4 visitors.** An IPv6-only name fails for a large share of visitors. Per
  name, pick one: an A record to the box (only if port 443 is forwarded; often
  impossible behind CGNAT), or an A record to the relay as a fallback, where only
  that slice of traffic counts against quota. The honest promise is "direct
  traffic is free of quota", not "all traffic". The relay fallback needs the hub to
  route `fshp.app` names (today it accepts claims only under the user's
  `flagship.services` area) and the box to claim them.
- **Router firewall.** Most home routers drop unsolicited inbound IPv6. Before
  publishing, `.com` (or the relay) probes the address from outside with SNI = the
  name and an STK-signed challenge, so the owner sees "not reachable from outside"
  instead of a silent failure, and nobody can point a name at someone else's host.
- **A path that accepts TCP but then fails** gets no Happy Eyeballs fallback. The
  outside probe repeats on a schedule and withdraws the record after N failures.
- **Box offline.** `.com` sees the heartbeat stop and repoints the name to the
  relay (which then holds or drops, as for any offline box) instead of leaving it
  dead. Hysteresis so a flapping box doesn't flip DNS every minute.
- **Address changes.** Dynamic IPv4, rotating IPv6 prefixes, privacy (temporary)
  addresses: the box binds and advertises its stable address, and updates the
  record with STK-signed updates inside the owner's grant (e.g. the approved /56
  prefix); a change outside the grant needs the phone again. TTL 60 s; some
  resolvers ignore TTLs, so expect stragglers on the old address for a while.
- **App moves to another box** (migration, replacement, failover): the record
  follows the app. Leader names (`<svc>.<user>`) stay relay-only in the first
  version; their target moves by gossip.
- **Several apps on one box:** each name points at the box address; the box routes
  by SNI to the app, and holds a certificate per name.

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

**Operations**
- DNS record limits and cost: Cloudflare caps records per zone on lower plans, and
  its API is rate-limited, so at scale the zone needs a paid plan or another DNS
  provider. Batch updates.
- Quota accounting: the relay counts only relay traffic, so direct traffic falls
  out naturally; the fallback slice still counts.
- Payment: web checkout or Pro bundle (see §3); in-app sales on iOS lose 15–30%.

## 6. Work breakdown (sketch)

1. App-side direct path: hint v2 with public endpoints behind the owner's signed
   order; daemon public listener; client probe/prefer/fallback (iOS, Android).
2. Protocol: the direct-access order canonical, the box's signed address update,
   golden vectors (TS/Swift/Kotlin).
3. `.com`: direct-name registry (derived + vanity), the outside reachability prober,
   record publish/withdraw/repoint in the `fshp.app` zone, certificate issuance for
   the names, CT watch, renewal and lapse.
4. Relay: route `fshp.app` names claimed by a box (the IPv4 fallback).
5. Clients: the opt-in screen (address, reachability, privacy warning, biometric
   confirm), name management, and the share UI choosing the direct or the relay
   link.
6. Remove `fshp.app` from the website mirror and delete its proxied records.
7. Tests: forged or unsigned orders refused; wrong-box address fails the probe;
   repoint on offline; withdrawal on decommission, transfer and deletion; rename
   moves names; the Happy Eyeballs fallback in the gym.
