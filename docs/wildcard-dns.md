# One wildcard per account (DNS in the `flagship.services` zone)

Status: owner decision 2026-10-18 ("yes to wildcard DNS per account, unless it
raises a security issue"). Threat assessment first (section 1-6); what was
built is section 7 on. Related: `per-user-cert-and-addressing.md`,
`multiplexing.md`, `service-addressing-double-dash.md`.

## 0. The problem

The zone is capped at 200 records (Cloudflare Free, which also pins the SOA
negative-cache time at 1800 s: measured 2026-10-18 on `jade.ns.cloudflare.com`,
`flagship.services. 1800 IN SOA ... 1800`). Before this change one account with
one server held 12 records:

| records | what |
|---|---|
| 6 | CAA at `<user>` and at `*.<user>`, each `issue`, `issuewild`, `iodef` |
| 2 | `*.<user>` A + AAAA (for tier-2 `<svc>.<user>` names) |
| 4 | per box: `<server>.<user>` and `*.<server>.<user>`, each A + AAAA |

So `8 + 4 x servers` per account. A client that resolved a box name before the
box registered also got a 30-minute "no such name" answer cached.

## 1. How wildcard synthesis works here (RFC 4592)

A query name is answered from `*.<ce>` where `<ce>` is its *closest encloser*:
the longest existing ancestor. A name "exists" if it owns any record **or has
any record below it** (an empty non-terminal, ENT).

- `*.alice` answers `home.alice` and also `app.home.alice` and
  `x.y.z.alice`, as long as neither `home.alice` nor anything under it exists.
  Checked live on Cloudflare's authoritative servers: `x.y.<user>` is
  synthesised from `*.<user>` (A 149.248.216.86, TTL 60).
- The wildcard has to sit at `*.<user>`. A record *at* `<user>` (the CAA) does
  not block it: `<user>` is the closest encloser, and `*.<user>` is its child.
  A wildcard at `*.flagship.services` would be blocked by `<user>` the moment
  `<user>` owns a CAA, so it is not an option while CAA lives at `<user>`.
- **Anything under `home.alice` blocks the wildcard for `home.alice` and all
  its descendants.** The ACME DNS-01 challenge `_acme-challenge.home.alice`
  TXT does exactly that for as long as it exists: `home.alice` answers NODATA
  and `app.home.alice` NXDOMAIN, and resolvers keep that for the SOA minimum
  (30 minutes). This is real, and it is the one place the wildcard alone is
  not enough (section 3).
- CAA is looked up with tree climbing (RFC 8659) on the name with a leading
  `*.` removed. For `home.alice` the CA asks `home.alice CAA`; the wildcard
  answers NODATA (the name exists, it has no CAA), so the CA climbs to
  `alice` and finds the account's CAA. A CAA at `*.alice` would only repeat
  it, so it is not needed.

## 2. What the relay does with a name no box registered

DNS does not change who can reach the relay: the relay's IP is public and the
SNI is whatever the client sends, so anybody could already offer any SNI. The
wildcard only means that honest resolvers now return the relay's IP for such
names too. What the relay did on such an SNI (`sniRouter.ts`, `registry.ts`):

- It only peeks the ClientHello. It never answers, never presents a
  certificate, never opens a stream on any tunnel unless `findBySni` finds a
  registered box, so nothing is proxied and no byte goes back to the visitor.
- It did, however, answer three ways with three timings: an unknown account
  closed at once; a name under an account with an online box was parked 4 s
  (after nudging that account's boxes) and then closed; the canonical of a box
  the hub had seen since its last start closed at once. That is a small oracle
  (does this account have a box online; has this hub seen this box).
- Fix, in this change: any miss under the apex that is not released by a claim
  closes after the same fixed time (the hold timeout), whatever the account.
  The delayed sockets are bounded (2048 at once, then an immediate close), and
  a visitor who hangs up frees its slot. Nothing else about routing changes.
- Not changed, noted: offering such an SNI still makes the hub nudge that
  account's online boxes (once per name while parked). The nudge carries only
  the name and was always reachable by connecting to the relay's IP directly;
  the wildcard does not widen it, but a per-account nudge budget is a sensible
  follow-up.

## 3. Assessment

| Surface | Verdict |
|---|---|
| Enumeration | Gain. Today a name resolves only if a record exists, so DNS lists a user's boxes. With the wildcard every name under `<user>` resolves, so DNS no longer shows which servers or services exist. DNS still shows that an account has at least one server (`*.<user>` exists); that was already true. CT logs still show the per-box certificate names; unchanged. The relay timing oracle in section 2 is closed. |
| Takeover | None. A takeover needs a name pointing at something a stranger can claim. Every name points at the relay (ours), which routes only to a tunnel registered through `.com` by a box whose identity `.com` knows (`<server>.<user>` registered under that account, admin-approved), or to a tier-2 slot of that user. A name nobody registered goes nowhere. A deleted account's wildcard is removed with its last server (section 5). |
| Phishing | None added. A visitor who reaches `anything.alice.flagship.services` gets a dropped connection, not a page, and nobody but alice's registered boxes holds a certificate for those names (CAA pins issuance to Let's Encrypt; the box generates its own key). |
| Cache poisoning | None added. The answers are the same records the zone already served, from the same authoritative servers; the wildcard removes a class of cached NXDOMAINs rather than adding one. |
| Certificates | Unchanged. Cert model A' (per-box `[X, *.X]`) stays; DNS-01 still validates at `_acme-challenge.X`. CAA stays at `<user>` and is found by tree climbing. A CA that misread NODATA-at-the-wildcard would fail closed (no certificate), never open. The live gym issues certificates, so it exercises this before prod. |
| Cost / abuse | Random labels bypass resolver caches, but Cloudflare does not bill queries and the relay drops them. No more exposure than a scan of the relay's IP. |
| ENT blocking | Real, handled (section 4): without it every certificate issuance and renewal would make the box's names unresolvable for up to 30 minutes for anyone who asked while the challenge TXT existed. |

Verdict: **no security issue found; implemented.** The one availability hole
(ENT) and the relay timing oracle are fixed in the same change.

## 4. The challenge shield (ENT)

A DNS-01 challenge needs `_acme-challenge.X` TXT, where `X` is the box
(`<server>.<user>`, validating `X` and `*.X`: two TXTs at once) or a tier-2
service (`<svc>.<user>`: one TXT). While one exists, `X` is an ENT and the
account wildcard stops answering for `X` and everything below it. So `.com`,
which writes those TXTs for the box (the box publishes nothing else), adds a
**shield** around them:

- On `dns-01/publish` for `_acme-challenge.X`: upsert A (and AAAA when the
  relay has one) at `X` and, for a box, at `*.X`, with the relay's address,
  BEFORE the TXT is written. The answers are identical to the wildcard's, so
  nothing changes for a resolver; they only keep `X` from going dark. If the
  shield cannot be made the publish is refused (502) and the box retries: a
  TXT without its shield is exactly the 30-minute outage.
- On `dns-01/delete`: when the last TXT at `_acme-challenge.X` is gone, delete
  the shield, but only while the account's `*.<user>` records exist with the
  same address (so a legacy per-box record, which is what the shield looks
  like, is never removed from an account that still depends on it). If a new
  TXT appeared meanwhile, the shield is put back.
- The stale-challenge sweep (TXT older than an hour, hourly) releases the
  shield of every name it cleared.

At most, per box being issued: 2 TXT + 4 shield records, all gone minutes
later. Over a whole zone the steady state is zero, so reserve about 20 records
of headroom for concurrent issuances.

**Verification status.** Verified live (2026-10-18, Cloudflare's authoritative
servers): `x.y.<user>` is synthesised from `*.<user>` (multi-label), and the
zone's SOA minimum is 1800 s. NOT verified: that Cloudflare treats a name with
only a descendant (`_acme-challenge.X` TXT) as an empty non-terminal and so
answers NODATA for `X` (RFC 4592 says so, and "a `_dmarc` record blocks the
parent wildcard" is a well-known Cloudflare behaviour, but no scratch zone was
available and the zone's name servers started refusing direct queries from
this machine mid-assessment), nor that a shield created just before the TXT
and removed just after it is seen in that order on every anycast node (a gap
of milliseconds is conceivable). The live gym exercises a first issuance on
every run; a poll of the box name during it (every 200 ms, via 1.1.1.1) would
prove it and is the first thing to add if the owner wants proof before prod.

## 5. What `.com` keeps per account

Per account, steady state: **4 records**

| name | type | why |
|---|---|---|
| `*.<user>` | A, AAAA | every box, service and tier-2 name |
| `<user>` | CAA `issue`, `issuewild` | Let's Encrypt only, found by tree climbing |

(`iodef` is not published any more: Let's Encrypt does not act on it, and it
cost a record per account. `*.<user>` CAA was a copy of `<user>`'s.)

- Created idempotently at **auth-code issue** (so the name resolves before the
  box registers: the first server of an account no longer sees a cached
  NXDOMAIN) and again at **registration**, **un-revoke**, **transfer claim**
  (the acquirer) and the admin **republish**.
- Removed when the account's **last live server** goes: revoke, account
  delete, demo cleanup, transfer to another account. The removal re-reads the
  server list afterwards and puts the records back if a registration raced it.
- No per-box records are written any more. The older ones are tolerated:
  they are removed on box revoke / delete, by the shield release above, and
  by the reap tool's `superseded` class below.
- `ServerDnsPublisher` (`services-zone`, the Fly `/api/services-zone/publish-server`
  route) keeps per-box records only for `mode: "direct"` (a box on the owner's
  own IP); `tunnel` mode publishes nothing per box.

Before / after, one account:

| servers | before | after |
|---|---|---|
| 1 | 12 | 4 |
| 2 | 16 | 4 |
| 3 | 20 | 4 |

200 records now hold about 45 accounts whatever their server count (was 15
accounts with one server).

## 6. Reap tool (`apps/com/src/prodReap.ts`)

Record shapes recognised (all still within `<user>` and two labels):

- `*.<user>` A / AAAA, `<user>` CAA: the current account set.
- `*.<user>` CAA, `<user>` CAA `iodef`: legacy extras.
- `<server>.<user>` and `*.<server>.<user>` A / AAAA: legacy per-box set (and
  the shield).
- `_acme-challenge.*` TXT: unchanged.

Rules (a record is KEEP unless one of these says ORPHAN):

1. The account is not in D1 (the old rule, unchanged).
2. **Superseded** (new): a legacy per-box A/AAAA whose account's `*.<user>`
   record of the same type and address is in the zone, with no challenge TXT
   at that box right now; the legacy `*.<user>` CAA and the `<user>` CAA
   `iodef` when `<user>` keeps an `issue` record. Deleting these changes no
   answer.
3. **No live server** (new): the account is in D1 but has no unrevoked server
   and no active auth code. Account-level and per-box records are then orphans.
   This is the account-gone rule widened to "the account has nothing to serve",
   because the publisher now removes the account set exactly then. Skipped when
   D1 cannot say (a missing column) and for the protected accounts.

`delete-one` rebuilds the zone index and re-checks every rule at delete time.

## 7. Migration

No flag day. After the `.com` deploy new accounts get the 4-record set. Old
accounts still hold their per-box records and the 6 CAA; they are cleaned by
the shield release at the next renewal, by revoke/delete, and in one pass by
`node scripts/reap-orphans.mjs` (dry run first, then `--apply`), which now also
lists the superseded records. Nothing needs the live zone to be edited by hand.
`POST /api/admin/republish-server-dns` re-creates the account set for every
live account (use it after a relay address move, as before) and also fills in
the wildcard for accounts that predate it.

## 8. What needs deploying

- `.com` Worker (`apps/com`): all of the DNS logic and the reap rules.
- `.services` (Fly): the relay's uniform drop timing only.
- Boxes: nothing. The box's only DNS action is the signed `dns-01/publish` /
  `delete` of its own `_acme-challenge` TXT, through `.com`.

## 9. Owner options still open

- Zone-level wildcard `*.flagship.services` (+ one apex CAA): zero records per
  account, but a CAA at `<user>` would block it, so per-account CAA (and the
  future per-account `accounturi` pin) would go, and every unclaimed
  single-label name under the apex would resolve too. Not done.
- Drop `issuewild` (3 records per account); `issue` alone already governs
  wildcard certificates.
- A higher record cap, the gym on its own domain (frees the shared Let's
  Encrypt budget), reaping leftovers: unchanged, see AGENTS.md.

## 10. Alternative evaluated: one zone-level wildcard `*.flagship.services`

Question (owner, 2026-10-18): wildcards span labels (RFC 4592), so could one
`*.flagship.services` A/AAAA to the relay answer `server.user` and `user` too,
with only temporary records for challenges, and HTTP-01 / TLS-ALPN-01 instead
of DNS-01 where names allow?

Short answer: it works for resolution and removes the per-account cost, but it
widens the one hazard we already have to design around, cannot replace DNS-01
for the certificates we mint, and gives up the per-account CAA node. I
recommend the per-account plan now and this as the scale step.

### 10.1 Empty non-terminals (trap 1), compared

| | per-account `*.<user>` (built) | zone-level `*.flagship.services` |
|---|---|---|
| a challenge TXT at `_acme-challenge.server.user` blocks | `server.user` and below | `server.user` and below, AND `user` itself, so the account's OTHER boxes and its tier-2 names too (closest encloser `user` has no `*.user`: NXDOMAIN) |
| shield needed | `server.user` + `*.server.user`, A + AAAA (4) | those 4 plus a temporary `*.user` pair (2), reference-counted across the account's concurrent challenges; released only when no `_acme-challenge.*.user` TXT remains (needs a zone listing) |
| failure mode if the shield is missing | one box dark 30 min | the whole account dark 30 min |
| any record at `user` (CAA, an old `home.user` record) | harmless: `*.user` is its child | kills the synthesis for that account unless it also gets its own `*.user` pair |

So yes: a TXT (or CNAME) challenge window recreates the 30-minute negative
cache for clients that query the name during it, in BOTH plans, and a CAA (or
any record) at `<user>` does the same in the zone-level plan. There is no
challenge name that avoids it: the CA asks for `_acme-challenge.<validated
name>`, which is always a descendant of the validated name, so a delegated or
CNAMEd challenge still creates the node. Ways around it, in the order we
considered them: (a) keep per-box A/AAAA permanently, which is the old 4
records a box and what we are removing; (b) a shield for the length of the
challenge, built, fail-closed; (c) make clients retry: useless, the negative
answer is cached by recursive resolvers outside our control; (d) shorten the
window: helps, does not remove it; (e) no TXT at all: only possible without
wildcard SANs (10.2).

### 10.2 Certificate model (trap 2)

A box's certificate is `[server.user, *.server.user]`; the wildcard SAN can be
proven only by DNS-01, and the apex SAN of the same order shares the same
TXT name. Replacing it with explicit names validated by TLS-ALPN-01 (the daemon
already has the presenter) or HTTP-01 means one SAN or one certificate per app
(`<app>.<server>.<user>`), reissued on every install. Let's Encrypt allows 50
new certificates a week per registered domain, and `flagship.services` is
not on the Public Suffix List yet (`docs/psl-submission-flagship-services.md`),
so all users share that one bucket: a few dozen app installs a week would
exhaust it. After the PSL entry each account gets its own bucket and per-app
issuance becomes thinkable, but that is weeks to months away and trades one
certificate per box per 60-90 days for one per app. Tier-2 `<svc>.<user>`
certificates are single names and could use TLS-ALPN-01 (no TXT, so no hole at
`<svc>.<user>`), but the issuer prefers DNS-01 for every name on purpose
(ALPN-01 depended on a path that was unreliable); not changed here.

### 10.3 CAA (trap 3)

What the per-account CAA does TODAY: nothing a single apex CAA would not.
Phase 1 publishes the same `issue/issuewild "letsencrypt.org"` for every
account, which tree climbing would find at the apex. What the per-account node
is FOR is phase 2, the RFC 8657 `accounturi` pin (per-user-cert-and-addressing
4.3, not built: the per-user ACME account decision is open). `.com` writes the
zone, so a malicious `.com` could rewrite the pin before asking for a
certificate; CAA never defended against that (caaPin.ts says so), and what
does is Certificate Transparency monitoring (`ctMonitor.ts`: any SAN set that
is not a registered box's pair is an alarm) plus the box holding its own key.
Losing the per-account CAA therefore loses (i) the future pin against OTHER
parties, i.e. a CA tricked into issuing to someone else's ACME account, and
(ii) the tell-tale that a rewritten record is an anomaly; it does not lose
detection of a malicious `.com`. A pinned account could still be given its own
`*.<user>` pair plus CAA (3 to 4 records) on top of the zone wildcard.

### 10.4 The relay (trap 4)

The relay already takes any SNI and closes unmatched first-party ones after one
fixed wait with no reply and no stream (section 2), and DNS does not change who
can reach it. Under a zone-level wildcard `anything.flagship.services` (one
label) would also reach it: `userOfSni` is null for it and it is destroyed at
once, and no one can hold a certificate for it (CAA at the apex, validation
needs our DNS or a registered tunnel). Explicit records (`hub.`, `www.`,
`gym.` and the like) win over the wildcard. DNS would also stop revealing
whether an account has a server: a small privacy gain over the per-account
plan.

### 10.5 Numbers and recommendation

| | steady state | per box while issuing | accounts at 200 records |
|---|---|---|---|
| before | 8 + 4 per box | 2 TXT | ~15 with one box |
| per-account (built) | 4 per account | 2 TXT + 4 shield | ~45 |
| zone-level | 2 (wildcard) + 1-2 (apex CAA), 0 per account | 2 TXT + 6 shield | no longer limited by records |

Recommendation: ship the per-account plan (built, tested, and each step
reversible), run the gym and prod with it, and move to the zone-level wildcard
when either the 45-account ceiling becomes real (before that, a paid plan
lifts the cap) or the per-account CAA decision is made against phase 2.
The move is small from here: publish the zone pair and one apex CAA once,
stop calling `ensureAccountDns`, add the `*.user` pair to the shield with a
refcount, and let the reap tool trim the per-account sets. What it must not do
is go first: the shield is the only thing between a challenge and a
30-minute outage, and in the zone-level plan its failure darkens an account
rather than a box, so it wants the live proof described in section 4 before
the blast radius grows.

