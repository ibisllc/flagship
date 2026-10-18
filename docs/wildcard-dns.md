# One root wildcard for the `flagship.services` zone

Status: owner decision 2026-10-18 ("go": adopt the ROOT WILDCARD). Supersedes
the same day's "one wildcard per account" design (4 records per account), which
this file described before. Built on `main`; `.com` deploy and a one-time manual
DNS step pending (section 10 and `docs/runbooks/final-deploy.md` step 6a).
Related: `per-user-cert-and-addressing.md`, `multiplexing.md`,
`service-addressing-double-dash.md`.

## 0. The problem and the answer

The zone is capped at 200 records (Cloudflare Free, which also pins the SOA
negative-cache time at 1800 s: measured 2026-10-18 on `jade.ns.cloudflare.com`,
`flagship.services. 1800 IN SOA ... 1800`). Three layouts, by records per
account with one server:

| layout | at rest | what |
|---|---|---|
| per box (until 2026-10-18) | 12 (`8 + 4 x servers`) | 6 CAA at `<user>` and `*.<user>`, `*.<user>` A + AAAA, a pair of A/AAAA at `<server>.<user>` and at `*.<server>.<user>` |
| per account (built the same day, never deployed) | 4 | `*.<user>` A + AAAA, two CAA at `<user>` |
| **root wildcard (this document)** | **0** | nothing. The zone holds `*.flagship.services` A + AAAA and one apex CAA pair, once. |

With the root wildcard the zone holds about **4 records at rest** (the wildcard
pair, the apex CAA pair) plus the records already there for other purposes
(the apex itself, mail, a few system names), and **2 temporary TXT per
certificate in flight**. It stops being a constraint at any number of accounts:
Cloudflare Free suffices. A box name also never sits in a 30-minute negative
cache, because it resolves before the account or the box exists.

## 1. The layout

| name | type | at rest | why |
|---|---|---|---|
| `*.flagship.services` | A, AAAA | the relay (`149.248.216.86`, `2a09:8280:1::110:d2b6:0`), **DNS only** (grey cloud) | every `<server>.<user>`, `<service>.<server>.<user>` and `<svc>.<user>` name resolves here by wildcard synthesis |
| `flagship.services` | CAA | `0 issue "letsencrypt.org"` and `0 issuewild "letsencrypt.org"` | Let's Encrypt only; found by tree climbing (section 4) |
| `_acme-challenge.<host>` | TXT | none; 1 or 2 per certificate in flight | the box's signed dns-01 flow through `.com`, deleted after issuance |
| anything at `<user>` or `<box>.<user>` | any | **NEVER** | a record owned by a name stops the wildcard for everything below it (section 3) |

The apex name itself is not touched: `flagship.services` owns its own records
(NS, SOA, proxied A/AAAA, MX, SPF) and a wildcard never answers the name it
hangs from. Reserved single labels, `_dmarc`-style names and the gym subtree
(`*.gym.flagship.services`, its own wildcard at the gym relay) are outside the
accounts' name space and stay as they are.

`.com` writes **no address record and no CAA record for anybody** (not at
auth-code issue, not at registration, not at un-revoke or transfer). The box
publishes nothing either: its only DNS action is the signed `dns-01/publish` and
`dns-01/delete` of its own `_acme-challenge` TXT through `.com`.

## 2. How wildcard synthesis works here (RFC 4592) and what Cloudflare does

A query name is answered from `*.<ce>` where `<ce>` is its *closest encloser*:
the longest existing ancestor. `*.flagship.services` answers `home.alice...`,
`app.home.alice...` and `x.y.z.alice...` alike (the asterisk matches any number
of labels), as long as nothing on the way down exists.

- **RFC 4592** says a name that has any record BELOW it exists (an "empty
  non-terminal") and so blocks the wildcard for itself and its descendants.
  **Cloudflare does not do that**, measured live (section 9): a challenge TXT at
  `_acme-challenge.home.alice` leaves `home.alice`, `x.home.alice` and every
  sibling answering from the wildcard.
- What does block it on Cloudflare is a record **owned by the name itself**, of
  any type (section 3). That is why nothing may sit at an account or box name.
- CAA is looked up with tree climbing (RFC 8659) on the name with a leading
  `*.` removed. For `home.alice` the CA asks `home.alice CAA`; the wildcard
  answers NODATA (no CAA type), so the CA climbs to `alice`, finds nothing, and
  reaches the apex CAA. Fails closed if a CA misread it (no certificate), never
  open.

## 3. The measured blocking matrix (why "nothing at account or box names")

Measured 2026-10-18 on the gym zone (Cloudflare authoritative servers, 1.1.1.1
and 8.8.8.8), identical in every cell. One throwaway account per row, no
per-account wildcard, so the answers come from the zone wildcard:

| a record owned by `N` (= `other.<U>`) | `<U>` | `box.<U>`, `x.box.<U>` (siblings) | `N` itself | `c.N`, `g.c.N` (below N) |
|---|---|---|---|---|
| none (baseline) | wildcard | wildcard | wildcard | wildcard |
| TXT at N | wildcard | wildcard | A: NODATA; TXT: its value | **NXDOMAIN** |
| CAA at N | wildcard | wildcard | A: NODATA; CAA: its value | **NXDOMAIN** |
| A at N | wildcard | wildcard | its own A | **NXDOMAIN** |
| only `*.N` A (no record at N) | wildcard | wildcard | wildcard (not NODATA) | the `*.N` value |
| only a TXT at `_acme-challenge.N` | wildcard | wildcard | wildcard | wildcard |
| CAA (issue + issuewild) at `<U>` only | **NODATA** for A | **NXDOMAIN** | NXDOMAIN | NXDOMAIN |

Rules, as Cloudflare applies them: a name that OWNS a record blocks the
wildcard for everything below it, and for its own other types answers NODATA.
A name that only has records below it is never blocked. Siblings and parents
are never affected. Consequences:

1. A challenge TXT blocks nothing, so there is no shield (section 6).
2. **A record at `<user>` kills the wildcard for the whole account**, and a
   record at `<box>.<user>` kills it for the names below the box. Hence the
   CAA lives at the apex only, and every record an earlier layout left at an
   account or box name has to go (section 5).
3. The layout is only correct while that holds. It is checked, not assumed
   (section 7).

## 4. What the relay does with a name no box registered

DNS does not change who can reach the relay: its IP is public and the SNI is
whatever the client sends. The wildcard only means honest resolvers now return
the relay's IP for such names too. The relay (`sniRouter.ts`, `registry.ts`) only
peeks the ClientHello; it never answers, never presents a certificate and never
opens a stream on any tunnel unless a registered box matches. Timing (unchanged
by the root wildcard, pinned by `apps/web/tests/sniRouterNudge.test.ts`):

- a first-party name nobody registered, whatever the account (unknown account,
  account with no box online, a box the hub once saw, a deeper name) closes after
  the same fixed hold timeout, bounded at 2048 delayed sockets, with no byte sent;
- a **one-label** name under the apex (`anything.flagship.services`, or an
  account's bare name), which the root wildcard now also sends to the relay, is
  destroyed at once whether or not an account of that name exists, and opens
  nothing: it says nothing about accounts;
- a name outside the apex is destroyed at once.

Nothing about the relay changes in this layout (it needs no `.services` deploy
for the root wildcard itself; the uniform drop timing shipped earlier).

## 5. Cleaning up what earlier layouts left (and why it is guarded)

Records of the older layouts (`*.<user>` A/AAAA/CAA, CAA at `<user>`, per-box
pairs, a challenge shield) stop the root wildcard for the names below them, so
they are removed, in this order everywhere (`legacyDeletionOrder`): CAA at
`<user>` first (it blocks nothing while the others answer), then the box names,
then the box wildcards, last the account wildcard; within one name CAA, then
AAAA, then A. The test fakes the Cloudflare rules above and asserts that no
name of the account stops answering the relay (IPv6 may be NODATA for an
instant between a name's AAAA and its A) at any step, for both the 12-record and
the 4-record layouts.

**Nothing is deleted before the root wildcard is in the zone and points
exactly at the relay** (`rootWildcardStatus`: A and AAAA equal the configured
`SERVICES_PASSTHROUGH_IPV4/6`, no extra or foreign record, not proxied). An
account's own records may be all that resolve its names until then; so deploying
`.com` before the manual DNS step is safe, it just does nothing.

| trigger | what it removes | guarded |
|---|---|---|
| auth-code issue, registration, un-revoke, transfer claim (both accounts) | the account's legacy records (`clearLegacyAccountDns`: one zone listing, delete by id, idempotent, race-safe: a record another caller deleted first is simply gone) | yes |
| server revoke, delete, transfer | that box's A/AAAA/CAA at `<box>` and `*.<box>` by name (`removeBoxDns`) | no (the box is gone) |
| revoke | also the account's legacy records | yes |
| account delete, demo cleanup | the account's records by name (`removeAccountDns`) | no (nobody left) |
| hourly cron, **off unless `DNS_LEGACY_SWEEP=1`** | up to 20 legacy records a pass, older than an hour, never the protected accounts | yes |
| `POST /api/admin/dns-route-gc[?dryRun=true&max=N]` (admin secret) | the same sweep on demand (replaces `republish-server-dns`, which is gone) | yes |
| `npm run reap-orphans` | every record at an account or box name, with a typed confirmation | yes for live accounts |

The hourly sweep is opt-in because it deletes live accounts' records in bulk;
the owner's reap pass is the primary trimmer and the cron only mops up.

Reap rules (`apps/com/src/prodReap.ts`): any A, AAAA, CAA or TXT at `<user>`,
`*.<user>`, `<box>.<user>` or `*.<box>.<user>` is **trimmed** when the account is
gone from D1, has no live server or install in flight, or is live and the root
wildcard is in place (the plan says whether it is; before that a live account's
records are KEPT). Kept: the apex and its CAA, `*.flagship.services`, system and
reserved labels, the gym subtree, an A/AAAA/TXT at a single label that is not an
account (a host record), anything unrecognised, and the protected store-review
account (trim it by hand once its review ends). A `_acme-challenge` TXT is kept
only while its account is live and it is under an hour old. `delete-one`
re-reads D1 and the zone and re-decides at delete time; a plan older than a day
is refused. The plan carries the deletion order.

## 6. Direct-IP boxes, the (removed) shield and the broker

- **Direct-IP boxes (`mode: "direct"` of `/api/services-zone/publish-server`)
  are not supported.** A box on its own IP needs a record at `<box>.<user>`,
  which blocks the wildcard for every service name below it, so it would need an
  explicit record for every `<service>.<box>.<user>` too, rewritten on every app
  install, and `.com` would have to hold that list. Nothing calls the route (no
  client, no box), the relay is the only supported path, and the route now
  answers 400 `direct-mode-unsupported` (`ServerDnsPublisher.publish` throws
  `DirectModeUnsupportedError`). `mode: "tunnel"` writes nothing and clears any
  per-box record an older build left. If direct mode is ever wanted it needs its
  own name space (a label that is not under `<user>`), not a record under a
  wildcard.
- **The challenge shield was measured harmful and removed** (2026-10-18). It
  wrote A/AAAA at the challenged name beside the TXT so the name would keep
  answering. A TXT below a name blocks nothing on Cloudflare (section 3), and the
  shield itself opened a 5 s NXDOMAIN window under the box (its literal A at the
  box name reached the name servers before its `*.<box>` sibling; section 9.2).
  The code, its `DNS_CHALLENGE_SHIELD` switch and its tests are deleted; the
  legacy-record rules still treat a leftover shield as a legacy per-box record
  and remove it. If Cloudflare ever applies the RFC 4592 rule the canary
  (section 8) fails; the answer is then a new design, not the old shield.
- **The DNS broker** (`apps/dns-broker`, `DNS_BROKER_URL`): `.com` no longer
  calls its `publishARecord` (the client for it is deleted) and the broker now
  refuses it outright ("per-box records are not published under the root
  wildcard"); the broker's ACME-TXT RPCs are untouched. The prod Worker doesn't set `DNS_BROKER_URL`
  (it writes with its Cloudflare token directly), and the legacy clean-up needs
  that direct token (the broker has no list or delete RPC).

## 7. Checking the zone: `npm run zone-health`

`GET /api/admin/reap/zone-health` (admin secret, read-only) and
`node scripts/dns-zone-health.mjs` (`npm run zone-health`, exit 0 healthy,
1 not, 2 could not run) list the zone against the Worker's configured relay
addresses and FAIL on:

- `*.flagship.services` A/AAAA missing, not exactly the relay (extra or foreign
  value), or **proxied** (orange cloud: it would bypass the relay);
- the apex CAA pair missing or allowing another CA;
- any record at an account or box name, listed with its Cloudflare id (the
  protected account's, and a host record at a label that is not an account, are
  warnings);
- more than 200 records (a warning from 180).

Run it after the manual DNS step, after the reap, and weekly.

## 8. The Cloudflare-specific caveat, and the canary

The layout relies on Cloudflare NOT applying the RFC 4592 empty-non-terminal
rule. If it ever starts (plan change, zone setting, provider change), a
challenge TXT would darken a box for up to 30 minutes. Standing checks:

- every `tools/live-e2e/shared-run.ts` run polls the first box's names every
  200 ms through issuance and FAILS "the box name and every label under it kept
  answering through issuance" on any NODATA or NXDOMAIN, and FAILS "no address
  or CAA record was ever written for the account or its boxes";
- `npx tsx tools/live-e2e/dns-ent-experiment.ts --canary` (30 s, throwaway names,
  no account records, exit 1 on any dark answer at jade, mario, 1.1.1.1 or
  8.8.8.8) runs in the weekly gym. Re-run it after any change of Cloudflare plan
  or zone settings.

If either fails: stop, and restore the per-account layout from git history for
the time being (the removed shield is not the answer: its ordering was itself the
outage).

## 9. Live verification (gym, 2026-10-18)

Everything here ran against the live gym zone `gym.flagship.services`
(Cloudflare, free plan, the same zone as prod) with throwaway names, through
`tools/live-e2e/dns-ent-experiment.ts` (the experiment, `--matrix`, and the
`--canary`) and `tools/live-e2e/lib/dnsProbe.ts` (the 200 ms timeline during a
real issuance). Resolvers: `jade.ns.cloudflare.com` and `mario.ns.cloudflare.com`
queried directly with no recursion, and 1.1.1.1 and 8.8.8.8. Every name was asked
once per resolver (a random or never-asked name), so no answer came from a
cache. The gym apex has its own `*.gym.flagship.services` wildcard, which stands
in for the root wildcard in the matrix (section 3).

### 9.1 Does a challenge TXT stop the wildcard? No.

A TXT at `_acme-challenge.box.<U>` with no shield: `box.<U>`, `x.box.<U>` and the
sibling `y.<U>` answered the relay (A and AAAA, TTL 60) at jade, 1.1.1.1 and
8.8.8.8. After the TXT was deleted, 150 s of watching at both public resolvers
(every 30 s) showed no negative answer cached. SOA negative TTL as returned: 1800 s.

### 9.2 The real issuance (probe, 200 ms)

`home.gae7l15d5a`, first box of a fresh demo account, shield on (as deployed
then): a random label under the box answered **NXDOMAIN at jade, 1.1.1.1 and
8.8.8.8 for 5.1 s** while the shield's literal A at the box name was visible
before its `*.<box>` sibling. The box name itself never went dark. Without the
shield there is nothing to be out of order: the TXT alone changes no answer.

### 9.3 Propagation is uneven (why any two-record dance is unsafe)

Time until a new record was visible on each name server: A/CAA/TXT about 3 to
8 s at jade against 20 to 30 ms at mario; deletes reach the first node in 50 to
300 ms but flap at the other for up to ~14 s. The two name servers can disagree
about a new record for several seconds, which is why deletions are ordered so
that every intermediate state still answers (section 5) rather than relying on
atomicity.

### 9.4 The full gym run with the shield off (2026-10-18, relay v18, gym Worker with `2963833d7`)

Note: this run is on the per-account layout. `2963833d7` is an ancestor of the
root-wildcard commit `272ce0c7d`, so `.com` still wrote 4 records per account
and the gym's zero-records check did not exist yet. The final layout has not
been run on the live gym; run `tools/live-e2e/shared-run.ts` on the commit to
deploy.

All 23 groups plus the fleet: **248 checks, 0 failed**, 57 min, 4 boxes at peak,
torn down through `/api/gym/teardown`. The zone went from 166 records to 178 at
peak and back to **166**, with 0 gym records and servers left; releasing a box
deleted 0 DNS records (nothing per box). The first box's issuance, polled every
200 ms for about 5 minutes (1,726 to 1,728 answers per target and resolver): the
box name (A and AAAA) and a never-asked label under it answered the relay at
jade, 1.1.1.1 and 8.8.8.8 every time; no NODATA, no NXDOMAIN; the only errors
were 3 timeouts at 8.8.8.8. The challenge TXTs reached jade 6.4 s after they were
created and, after they were deleted (224.4 s), flapped between present and
absent at jade until 256.9 s. A stale answer like that is harmless to Let's
Encrypt (any matching TXT validates), but a renewal started within about 35 s of
the previous deletion can see the old value too.

### 9.5 Deleting a legacy account's records: does the order hold?

`clearLegacyAccountDns` deletes in a fixed order (the CAA at `<user>`, then the
box names, then the box wildcards, last `*.<user>`), back to back, inside the
Worker. That keeps every name answering only if each delete is seen by the
name servers before the next, and 9.3 showed they lag each other by seconds. So
the real function's order was run on the gym (`dns-ent-experiment.ts
--legacy-order`): the 8-record legacy set of a throwaway account (CAA issue and
issuewild at `<user>`, A and AAAA at `*.<user>`, `home.<user>` and
`*.home.<user>`) under the gym's own wildcard, four names (`home.<U>`,
`x.home.<U>`, `app.<U>`, `x.y.<U>`) polled every 100 ms at jade and mario.

| variant | runs | result |
|---|---|---|
| back to back (the Worker: 8 deletes in 1.5 to 2 s) | 6 | no name stayed dark at either server; in one run `x.home.<U>` answered NXDOMAIN at both servers for 0.1 s, 7 s after the last delete, then the relay again |
| one rank group at a time, 15 s between (the reap CLI: 49 s) | 1 | no dark answer |

So the feared out-of-order window did not show for deletions (it did for
creations: 9.2). The residual risk is a flicker of about 0.1 s for a legacy
account, once, when it first registers a box after the deploy; a resolver that
asks in exactly that instant keeps a 30-minute NXDOMAIN. The Worker does not
wait between deletes (Free plan: ~10 ms CPU, ~50 subrequests), the reap CLI
waits 15 s between groups, and the pre-GA scrub removes every legacy account
except the protected store-review demo (`playstore-test-0725`), whose explicit
records no code path deletes or trims (`PROTECTED_DNS_ACCOUNTS`).

## 10. What needs deploying, and the manual DNS step

- **The one-time manual DNS step (owner, Cloudflare dashboard)**, before or after
  the deploys, in `docs/runbooks/final-deploy.md` step 6a: create
  `*.flagship.services` A and AAAA (DNS only) and the apex CAA pair, then run
  `npm run zone-health`.
- **`.com` Worker (`apps/com`)**: all of the logic above and the reap rules. No D1
  migration. Nothing happens to an existing account until the wildcard is in the
  zone (the guard), after which its legacy records go at its next event or in
  the owner's reap pass.
- **`.services` (Fly)**: nothing for this change.
- **Boxes: no endorsed release.** The box's only DNS action is the signed
  `dns-01/publish` / `delete` of its own `_acme-challenge` TXT through `.com`
  (`remoteDnsChallengeWriter.ts`); it publishes no A, AAAA or CAA.
- **Clients (iOS, Android, webapp)**: nothing.

Capacity: about 4 records at rest and 2 per certificate in flight, so thousands
of accounts fit in the free 200-record cap (the cap now bounds concurrent
issuance, not accounts). `zone-health` (section 7) warns from 180 records.

## 11. Assessment

| Surface | Verdict |
|---|---|
| Enumeration | Gain. Every name under the apex resolves to the relay whether or not an account, box or service exists, so DNS no longer shows that an account exists at all (the per-account layouts did). CT logs still show the per-box certificate names; unchanged. The relay timing oracle is closed (section 4). |
| Takeover | None. Every name points at the relay (ours), which routes only to a tunnel registered through `.com` by a box whose identity `.com` knows, or to a tier-2 slot of that user. A name nobody registered goes nowhere. |
| Phishing | None added. A visitor to `anything.alice.flagship.services` gets a dropped connection, not a page, and nobody but alice's registered boxes holds a certificate for those names. |
| Cache poisoning | None added; the answers are the same relay address from the same authoritative servers, and the wildcard removes a class of cached NXDOMAINs. |
| Certificates | Unchanged. Cert model A' (per-box `[X, *.X]`) stays; DNS-01 still validates at `_acme-challenge.X`. CAA moves from `<user>` to the apex (found by tree climbing, section 2). |
| Cost / abuse | Random labels bypass resolver caches, but Cloudflare does not bill queries and the relay drops them. No more exposure than a scan of the relay's IP. |

### What was dropped: the per-account CAA and the `accounturi` pin

The per-account CAA at `<user>` did nothing a single apex CAA doesn't (it
repeated the same `issue/issuewild "letsencrypt.org"`), and a record at `<user>`
is exactly what blocks the root wildcard, so it cannot stay. What the per-account
node was FOR is the future RFC 8657 `accounturi` pin (`caaPin.ts`
`buildUserZoneCaaRecords`, never published: the per-user shared ACME account
decision was never made). Losing it loses the pin against OTHER parties (a CA
tricked into issuing to someone else's ACME account for that user's names). It
does not lose detection of a malicious `.com`: `.com` writes the zone, so it
could always rewrite the pin before asking for a certificate; what detects that
is Certificate Transparency monitoring (`ctMonitor.ts`: any SAN set that is not a
registered box's pair is an alarm) plus the box holding its own key. Certificate
transparency monitoring covers detection. A future pin would need a per-account
CAA with `accounturi`, i.e. a record owned by `<user>`, hence its own
`*.<user>` A/AAAA pair next to it to keep the account's names answering (3 to 4
records for the accounts that opt in, only), and a decision on the per-user ACME
account first.

### Why not our own DNS server

Considered and not needed: the point of an own authoritative server was to
escape the record cap and the 30-minute SOA negative cache. With the root
wildcard the zone holds about 4 records at rest, the cap stops mattering, and a
box name never negative-caches because it resolves before it exists. An own
server would add an availability and security surface (a second authoritative
tier, DNSSEC, DoS) for nothing the zone still needs.
