# Naming, recovery & paid name-change

Status: **SPEC (pre-build)**. Owner-directed 2026-06-22. Supersedes the
no-credential "grace takeover" recovery path and the 90-day GC reclaim.

## 1. The model (decided)

1. **Account creation assigns a RANDOM name** (`happy-turtle-4821`-style). Free,
   instant, unsquattable, leaks nothing about who you are.
2. **You can change your name any time — it costs money** (~$5 floor), paid
   through the **unlinkable entitlement rails** so payment never links to the
   name or identity.
3. **A name change RE-HOMES all your boxes** (new FQDNs, certs, DNS,
   entitlements, routing). It is a same-owner **namespace migration**, not a DB
   rename — it reuses the `feat/transfer-a-box` machinery.
4. **Launch dibs:** for a fixed window after launch (default **12 months**), a
   name that matches a domain you control is claimable **only** via
   domain-control proof (DNS/`.well-known`) — squatters can't pay to front-run a
   brand. After the window, custom names open to paid first-come; a domain holder
   can still claim a *free* matching name forever (never a taken one).
5. **Names are FOREVER.** No GC, no admin stripping, no no-credential takeover.
   Lose every credential with no backup → the name stays **reserved to you,
   unusable** (which is why we push enrolling a recovery factor at sign-up).
6. **Recovery is self-custody — credential-only:** cloud-recovery passkey,
   key-file import, or device-pair (scan a code from a signed-in device). Nothing
   recovers an account without a credential.
7. **`flagship.services` names are functional + custodial; brand/permanent links
   are your own domain** (the sovereignty tier — Flagship can't seize what it
   doesn't root).

## 2. Principles (why)

- **Allocation, not seizure.** We choose what we *allocate* (random assignment,
  reserved words, dibs). We never *take back* an allocated name. A blocklist at
  claim time is allocation policy; reclaiming a live name would be seizure — we
  don't do it. This removes the precedent/pressure lever entirely
  (`docs/login-and-account-redesign.md` discussion).
- **A live credential always wins.** Anything that could touch a name is bounded
  to names nobody can cryptographically defend (= none, since we don't reclaim).
- **Privacy: no payment↔name↔identity link.** The name-change fee is an
  unlinkable entitlement (the Pro `push-token-as-join-key` mechanism), not a
  Stripe row carrying your handle. Random-default needs no payment at all, which
  is why it's the free base.
- **The fee is the anti-squat mechanism.** ≥$5 per name kills bulk squatting *and*
  funds the product, and it touches only the population that wants a vanity name.

## 3. Username grammar & reserved names

**Grammar — DASHES ALLOWED (decided 2026-06-22, superseding the earlier
dashless call).** Usernames move to `^[a-z0-9]([a-z0-9-]{1,28}[a-z0-9])?$` (3–30,
no leading/trailing dash, no `--`). This is enabled by switching the slug↔creator
composite delimiter to a **double dash `--`** so the composite still parses
unambiguously — full propagation spec in **`docs/service-addressing-double-dash.md`**.
So **random names are `<adjective>-<noun>-<NNNN>`** (e.g. `happy-otter-4821`),
readable and ≤30 chars.

**Reserved / blocklist (new).** A claim (random OR custom) must reject:
- **Infra/impersonation labels:** `admin, root, www, api, boot, recovery,
  support, help, flagship, flagshipserver, mail, ns, dns, status, abuse,
  security, billing, pay, official` (+ a maintained list).
- **Profanity / slurs** for *random generation* (never auto-assign an offensive
  name) and for *custom claims* (allocation policy; note that names-forever means
  the blocklist only gates the initial claim, never a reclaim — acceptable and
  consistent).
- **Confusables/homoglyphs** — out of scope for v1; flagged (impersonation via
  lookalikes is a known gap).

## 4. Account creation → random name

Replace "pick a username" at sign-up with **server-assisted random assignment**:

1. Client requests a candidate: `GET /api/username/random` → returns an
   available, non-reserved **`<adjective><noun><NNNN>`** (CONCATENATED, dashless —
   see §3; server picks short curated words; numeric suffix gives a wide space so
   collisions are rare; server re-rolls on a taken candidate). Returns a few
   candidates so the user can "shuffle".
2. Client claims it exactly as today — the standalone IRK-signed
   `flagship/claim-username/v1` (`openAccount.claimUsername`), idempotent (409 =
   already this IRK). The claim is **free** (no payment).
3. The wordlist ships in `packages/control-plane` (so the Worker generates) +
   mirrored client-side only for display "shuffle" (server is the allocator of
   record).

**Wordlist + generator** is a new artifact: ~1k adjectives × ~1k nouns curated
for non-offensiveness, deterministic availability check against `usernames`.

## 5. Name change = namespace migration (the core build)

Changing `oldname → newname` re-homes everything bound to the handle. **What's
bound to the username string:**

| Bound to `<username>` | Where |
|---|---|
| Box FQDN `<server>.<username>.flagship.services` (+ `*.<server>.<username>`) | services-zone, daemon `serverFqdn` |
| Per-box cert SANs `[<server>.<username>, *.<server>.<username>]` | daemon ACME (A′ model) |
| Per-box DNS A/AAAA + `_acme-challenge` | Cloudflare services zone |
| RootEntitlement `podCanonical` (IRK-signed) | box `entitlements.json`, hub HELLO |
| Routing / SNI match | hub registry, RCK/STK |
| Tier-1 `<label>.<server>.<username>`, tier-2 `<service>.<username>` + service certs | daemon, voi.ci targets |
| The `usernames` row | D1 |

**Account identity does NOT change** — IRK + AID stay. **Invariant to verify
(audit):** all account state (devices, paired sessions, cloud-recovery record,
device-capability grants, tier rows) is keyed by **AID/IRK**, never the username
string; if anything keys on the string it must be migrated. This is the
difference that makes a name change *cheap* vs transfer-a-box: **the IRK is
unchanged, so the LUKS disk key stays sealed to the same key — NO disk re-seal**
(transfer-a-box's hardest step is unnecessary here).

**Migration sequence (`POST /api/account/name-change`):**

1. **Authorize:** IRK-signed `flagship/name-change/v1|aid|oldname|newname|issuedAt`
   envelope + a redeemed name-change entitlement (§6). Verify newname is
   available, non-reserved, and (in the dibs window) domain-proven if applicable.
2. **`.com` half (atomic-ish, reuses transfer-a-box namespace migration):**
   rename the `usernames` row (or claim newname + retire oldname, preserving
   AID); re-home every server `<server>.<oldname>` → `<server>.<newname>` in the
   servers/routing tables; publish new per-box DNS, schedule old-record teardown;
   audit row.
3. **Per-box re-home (phone + daemon, reuses the entitlement relay/deposit):**
   - the **phone re-mints** an IRK-signed RootEntitlement for each box bound to
     the NEW `podCanonical` and deposits it (`entitlement-deposit` lane) — exactly
     the Box Request Inbox deposit, keyed to the new canonical;
   - the **daemon**, on learning its new canonical (config push or it polls
     `/pods`/registration), claims the new entitlement, **re-derives its cert
     SANs** (A′ already auto-discards+re-mints on FQDN change — the same path that
     handles model-C→A′), re-runs ACME for the new SANs, and re-registers routing.
4. **Cutover: NONE (decided).** The moment the transaction finalizes, the new
   identity is live and **the old name is relinquished immediately** — no
   dual-route grace. Old FQDNs go dark at once (DNS removed, routing dropped);
   `oldname` becomes claimable by anyone. Surface this hard in the confirm UI
   ("your old URLs stop working immediately and the old name is released").
5. **Offline boxes:** the deposit + registry change persist; a box re-homes when
   it next checks in. The name change completes at `.com` immediately; a box
   that's offline at finalize re-homes on its next check-in (its old URL is
   already dark).

**Reuse map:** transfer-a-box (`serverTransfer.ts`, migration `0059`,
namespace-migration re-home + DNS + routing) · A′ cert SAN re-derivation
(daemon) · entitlement relay/deposit (`entitlementRelay.ts`, `entitlement-deposit`
lane) · per-box DNS publisher (`services-zone`). **New:** the name-change order +
the orchestration that drives all boxes through re-home under one request.

## 5b. Restricted-service access continuity across a rename

**Authorization survives a rename with NO work** — grounded in
`serviceInvites.ts`: a service grant binds the grantee's **stable AID**
(`deriveAccountId(UMK)`), is **enforced by the box itself** (it holds the owner
AID pubkey and verifies the signed create), and **`.com` is a blind carrier**.
None of that references the username/URL, and a rename leaves the AID, box STK,
service, and grants untouched. **The capability does not break.** What breaks is
only the URL the grantee navigates to.

- **App-mediated grantees → re-resolve, leak-free.** The stored invite holds the
  stable reference (`serviceRef` + owner identity), **not** a URL. The client
  re-queries `.com` for the service's *current* URL by **stable identity, never by
  the old name**, so no public `oldname→newname` record is created — only an
  already-authorized grantee learns the new name. **Build requirement: invites/
  clients must resolve the live URL from the stable handle and must NOT cache the
  URL.**
- **Plain-browser-bookmark grantees → cannot re-resolve.** With no cutover, the
  old URL is dead and any redirect would itself be the leak (or be served by
  whoever next claims `oldname`). **So: after a rename, flag every grantee
  "URL changed — resend" in service > users, with per-grantee + "resend to all"
  actions.** The owner re-sends out of band — which is also the *privacy-correct
  default* (the owner controls who learns the new name, and silently skips anyone
  they renamed away from).

**Honest ceiling — rename ≠ unlinkability.** The box STK is public (`/pods` is
unauthenticated) and FQDNs are in CT logs, so an observer who recorded the old
STK can correlate it under the new name. The stable identity that makes access
survive is the same thing that links the names — you can't have both. A rename is
a **rebrand**, not anonymity. True disassociation is a *different* operation:
**revoke the grants** (already built) + a **fresh box identity** (re-key/re-burn,
which intentionally breaks all carry-over). The UI must say plainly that renaming
does not hide that this is the same box.

## 6. Payment — the name-change entitlement (unlinkable)

- A name change requires a redeemed **name-change entitlement**, purchased
  through the **same unlinkable rails as Pro** (`project_unlinkable_entitlement`:
  client-side unlock, push-token-as-join-key — Flagship + the payment processor
  cannot link payment → account → identity).
- **Product:** one-time, single-use, bound to the *name-change action* (not
  transferable to other entitlements). Redemption is **IRK-signed** so only the
  account holder consumes it.
- **Pricing (decided): ONE flat price** (~$5), **no premium/short-name tiers** —
  the genuinely premium names are all already held as `.com` domains and so are
  reachable only through dibs, not an open market, so there's nothing to tier.
  **A dibs claim is priced a bit HIGHER** than a normal change (a "we kept the
  name warm for you" premium), not lower.
- **Methods:** card via processor + a privacy method (Monero) for the
  no-link-at-all path (mirrors `pro.html`).
- **No refunds** (a name change does real work — a box re-home). State at point
  of sale.
- **New:** the entitlement SKU + redeem endpoint + the binding of "this
  entitlement authorizes exactly one name-change". Reuses the Pro entitlement
  machinery; does not reuse a Stripe-row-keyed-by-username (forbidden).

## 7. Dibs — domain-proof claim

**Window:** `DIBS_WINDOW = [launchAt, launchAt + 12 months]` (Worker config).

**Mechanism (ACME-style domain-control proof):** to claim `<name>` you prove
control of a domain whose registrable label = `<name>`:
- **DNS-01 style:** publish TXT `_flagship-claim.<domain>` = `flagship-claim:<challenge>`
  where `challenge = b64url(sha256("flagship/name-dibs/v1|" + name + "|" + irkPubHex + "|" + nonce))`.
- **HTTP-01 style:** serve `https://<domain>/.well-known/flagship-claim` = the same challenge.
- The challenge **binds to the claiming IRK**, so a published record can't be
  replayed by a different key. Server verifies via a DNS lookup / HTTPS fetch
  (reuse `cloudflareDns`/an HTTP fetch with the SSRF guard).

**Window rule:** during `DIBS_WINDOW`, **custom-name claims are domain-proof
ONLY** (paid arbitrary first-come is disabled). This fully protects brands —
nobody can pay to grab `nike` before `nike.com` proves it — at the cost that a
non-brand user who wants `coffeelover` waits until the window closes. After the
window: paid first-come opens, and domain-proof still works on **free** names
forever (never a taken one).

**Conflicts** (`nike.com` vs `nike.de`, same label): **first verified claim wins,
no human tiebreak** (per the no-adjudication decision).

**Pricing of a dibs claim:** §16 decision — free (launch incentive) vs the
standard name-change fee. Either way it triggers the same §5 migration if the
claimant already has boxes (most launch dibs claimants are new → no boxes → it's
just an initial claim of a non-random name; allow a **non-random initial claim
via domain-proof** as a special free case).

**New:** `POST /api/name-dibs/initiate` (returns challenge) + `POST
/api/name-dibs/verify` (checks the record, allocates) + the window config + the
domain→label normalization (eTLD+1 via a public-suffix list).

## 8. Recovery — self-custody (mostly REMOVALS)

**Remove:**
- The **no-credential grace takeover** — `rePair.ts` single-device
  auto-complete path (`handleCompleteRePair` silence-as-consent), the
  `re-pair/object` self-cancel, the grace-model derivation in `accountResolve`
  for the no-credential case.
- The **90-day admin GC reclaim** (`POST /api/admin/username/:u/reclaim`) +
  `usernames.last_active` GC use (keep `last_active` only if some other feature
  needs it; otherwise drop).
- The **trademark mailto** (`lib/trademarkClaim.js` + the wizard "name taken"
  panel) — replaced by dibs/domain-proof.

**Keep (credential-only recovery — already built):** cloud-recovery passkey +
passphrase (`recovery.js`; fix the `recovery.flagshipserver.com` DNS gap),
key-file import (`keyfileImportTakeover.js`), device-pair / scan-a-code
(`crossDevicePairing.js`, `join.js`). These remain the *only* ways back in.

**Frozen-name state:** lose every credential + no backup → the `usernames` row
persists, claimed, forever; the account is unusable; no one else can ever take
it. No new code — the absence of GC *is* the behavior.

**Enrollment posture (DECIDED): REQUIRE a backup at sign-up.** At least one
recovery factor (key-file download is the zero-infra option, or a passkey) must
be set before the account is "complete", with a clear "this is the only way back
in — we cannot recover it for you" screen. (Names-forever + credential-only
recovery means there is genuinely no fallback.) Move the existing tier-2-sign-out
recovery gate earlier, to sign-up.

## 9. Cover / UX changes (all surfaces)

**Sign-up (changed):** no name entry. "Create account" → passphrase/device key →
**random name assigned** (with a "shuffle" + "you can change this later for $5"
note) → recovery enrollment (§8) → done. *This reverses the username-first create
path just shipped in `bootstrap.js`.*

**Sign-in / recover (mostly built):** the username field is now **sign-in only**:
enter your existing name → `resolveAccount` → the **3 credential paths** (recover
/ scan / keyfile — grace already removed). Unknown name → "no account by that
name" (not a create entry).

**Name change (new):** Settings → "Change your name" → type desired name → live
availability + reserved/dibs check → (domain-proof if in window) → pay (unlinkable)
→ **confirm sheet warning: re-homes your boxes, old URLs stop working
IMMEDIATELY, the old name is released, and this does NOT hide that it's the same
box** → migration progress (per-box re-home status, reuse the ActiveOperations
sliver).

**Post-rename — re-issue access links (new).** After a rename, the **service >
users** list flags every grantee **"URL changed — resend"**, with per-grantee
**Resend** + a **Resend to all**. App-mediated grantees re-resolve automatically
(§5b) and need nothing; the flag + resend covers browser-bookmark grantees and is
the owner-controlled (privacy-correct) way to disclose the new name.

**Framing copy:** "`<name>.flagship.services` is your handle — yours forever, and
free. For a permanent branded link, connect your own domain." Position
**bring-your-own-domain** as the sovereignty tier wherever names are shown.

Surfaces: **webapp · iOS · Android** (+ `.com` backend + daemon). The cover flip
+ name-change UI ship on all three.

## 10. Protocol & canonical bytes (new, cross-platform vectors)

- `flagship/name-change/v1 | aid | oldName | newName | issuedAt` — IRK-signed.
- `flagship/name-dibs/v1 | name | irkPubHex | nonce` — the dibs challenge preimage.
- Name-change entitlement redeem envelope (reuse the Pro entitlement shape).
- Pin byte-identical vectors in TS · Swift · Kotlin (the lockstep rule).

## 11. Storage & migrations

- `name_changes` (audit: aid, oldName, newName, at, entitlementRef) — workspace
  table, stays on `main`.
- `name_dibs_claims` (name, domain, irkPubHex, verifiedAt, method) — dibs ledger
  (and a **public transparency view** if we ever publish reclaims; here it's
  allocations).
- Name-change-entitlement records (reuse Pro entitlement storage).
- Reserved-words list (config or a small table).
- Migration to extend the username grammar constraint (if DB-enforced).

## 12. Backend (`.com`) endpoints

- `GET /api/username/random` — candidate generator (rate-limited).
- `POST /api/account/name-change` — authorize + drive §5 migration.
- `POST /api/name-dibs/initiate` · `POST /api/name-dibs/verify`.
- Name-change entitlement purchase/redeem (reuse Pro).
- Reserved/blocklist enforcement in `handleUsernameClaim` + random + dibs.
- Rate limits: random, resolve (the documented gap — fix it), dibs verify,
  name-change.

## 13. Daemon (box) changes

- **Learn a new canonical** (`FLAGSHIP_SUBDOMAIN` / install-blob update, or
  derive from a re-registration) and **re-home**: claim the new IRK-entitlement,
  re-derive cert SANs, re-run ACME, re-publish/await DNS, re-register routing,
  retire the old canonical. Most of this is the A′ "SANs re-derived at startup →
  auto-discard+re-mint" path already in the daemon; the new bit is reacting to a
  canonical change at runtime (not just first boot).

## 14. Removals (net simplification)

`rePair.ts` no-credential completion · `re-pair/object` · admin GC reclaim ·
`last_active` GC · `trademarkClaim.js` + wizard "name taken" panel · the
grace branch in `accountResolve`/`loginTakeover` · the create-takes-a-name cover
path.

## 15. Rollout / ops

- **Grandfather** existing chosen-name accounts (they keep their names; no forced
  random; they only pay if they *change*).
- **Launch sequencing:** ship random-assign + grammar + reserved list + the cover
  flip; set `launchAt`; open the 12-month dibs window; announce the dibs to
  `.com`/brand holders.
- **Window close:** after 12 months, flip custom-name claims to paid first-come;
  keep domain-proof for free names permanently.
- **Recovery DNS fix** (`recovery.flagshipserver.com`) is a prerequisite for the
  passkey path to actually work in prod.

## 16. Open decisions

DECIDED (2026-06-22): **require a backup at sign-up** · **one flat price, no
premium tiers**, **dibs priced a bit higher** (kept-warm) · **no cutover —
instant relinquish on finalize** · name-change is a **rebrand, not
unlinkability** (true disassociation = revoke + fresh box identity).

Still open:
1. **Username grammar:** confirm hyphens allowed + the `--` ban + audit no tier-2
   parser collides (mostly an engineering audit — I can do it).
2. **Random format:** `adjective-noun-NNNN`? suffix length? wordlist source.
3. **Dibs claim price:** the exact "kept-warm" premium over the base change fee.
4. **Post-window free matching-name claim by a domain holder:** free or base fee?
5. **Dibs scope:** `.com` only, or any domain whose eTLD+1 label matches?
6. **Profanity policy** source + appeal (none, by design?).
7. **Payment methods** at launch (card + Monero?) and the no-refund copy.
8. **Dibs window length:** 12 months assumed — confirm.

## 17. Build checklist (everything to realize the vision)

**Protocol/shared:** username grammar (TS/Swift/Kotlin/webapp) · reserved list ·
`name-change` + `name-dibs` canonical bytes + vectors · wordlist + generator.

**Backend (`.com`):** random endpoint · name-change orchestrator (reuse
transfer-a-box migration) · dibs initiate/verify (DNS/HTTP proof + PSL) ·
name-change entitlement (reuse Pro/unlinkable) · reserved enforcement · rate
limits · `name_changes`/`name_dibs_claims` storage · audit · window config.

**Daemon:** runtime canonical-change re-home (entitlement claim + cert re-SAN +
DNS + re-register + old-canonical retire).

**Clients (webapp · iOS · Android):** sign-up random-assign + shuffle · recovery
enrollment gate (required) · cover flip (username field = sign-in only) ·
name-change Settings flow (availability + dibs proof + unlinkable pay + re-home
warning + progress) · **service-invite clients resolve the live URL from the
stable handle, never cache the URL (§5b)** · **service > users "URL changed —
resend" flag + per-grantee/all resend** · BYO-domain positioning copy.

**Service-access (§5b):** ensure invites/grants carry only the STABLE reference
(`serviceRef` + owner identity), and add a stable-handle → current-URL resolve so
app grantees reconnect after a rename with no public old→new record.

**Removals:** grace takeover · GC reclaim · trademark mailto · grace branch in
resolve/login · create-takes-a-name path.

**Ops:** grandfathering · launch + dibs window dates · recovery DNS fix · the
`.com`/brand dibs announcement.

**Tests:** grammar + reserved (all langs) · random availability/collision ·
name-change migration (re-home all boxes, IRK unchanged, old URL retired, offline
box eventually re-homes) · dibs proof (valid/replayed/wrong-key/conflict) ·
entitlement redeem (single-use, IRK-bound, unlinkable) · recovery still
credential-only · cover flip.
