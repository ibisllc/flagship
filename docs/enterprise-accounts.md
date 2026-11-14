# Enterprise accounts: organizations, scoped admins and multi-admin ceremonies

Status: **design, for owner review** (2026-11-14). No code. Branch `0.4/enterprise-accounts` holds only this doc;
when built, the feature lives on its own branch (`feat/enterprise`, off `feat/marketplace` for the payment rail),
per the AGENTS.md branching rule.

Owner, 2026-11-14 (verbatim): "John Admin may not be the only user involved in the ceremony. the enterprise version
could give rise to elaborate multi-admin ceremonies. Actually, the admin accounts should be the only ones that allow
you to add multiple authorized user-accounts and make some of them admin of certain servers/services. (normal
accounts can still invite someone to share a server but not with the same level of granularity (we need to iron out
the details)". And later the same day: "maybe regular users can only invite a limited number of collaborators? or
none at all? we need to see what is possible today and how to build a compelling enterprise offering".

Read with: `docs/share-a-server.md`, `docs/service-access-gating.md` ("Account members", "Co-manager invites",
"Adding a server", "One list per app", "Per-app identity"), `docs/device-admin-tier-spec.md` (the admin root),
`docs/multi-device.md`, `docs/retail-wired-fleet.md` (§8 site mode and the owner notes at its end),
`docs/payments-privacy-and-rails.md` (plans, vouchers, plan attestation), `docs/architecture-v2/pq-suites.md`
(§9 bindings, §10 the gate, §16.2 k-of-n, §20 the admin root's records).

## 1. The answer in short

1. **An organization ("org") is a new kind of account** on `.com`, with its own name (`acme`) and its own servers
   (`<server>.acme.flagship.services`). It has **no phone of its own and no UMK of its own.** People belong to it
   through **seats**: each seat is a normal Flagship account (its own phone root, its own recovery) that the org has
   admitted.
2. **Authority is a signed policy, not a key.** The org's root is an **org authority record**: the list of org admin
   seats, each with a hybrid (Ed25519 + ML-DSA-65) key, and a **threshold per kind of action** (k of n). Every change
   to the record is signed by enough admins of the previous version. Boxes pin the record at install, exactly as they
   pin the admin root today, and replay its chain themselves; `.com` is never trusted for it.
3. **k-of-n is collected signatures, not threshold cryptography.** An order that needs 2 of 4 admins carries 2
   independent hybrid signatures over the same bytes. That works with ML-DSA today, shows the box (and the audit)
   exactly who approved, and needs no new primitive. A **ceremony** is just the collection of those signatures, over
   time, from several phones.
4. **Scoped admin roles.** An org admin can make a seat **server admin** of named servers (that server's sensitive
   orders: update, power, apps, access) or **service admin** of named apps (master in that app plus the admin-only
   app orders: ranks, mode, removals). Everyone else in the org is a **member** seat with a default rank per app. The
   apps still see only the three ranks `member < manager < master`.
5. **Offboarding is cryptographic.** Revoking a seat (one org admin signature is enough: removing access must be fast)
   makes every org box drop the seat's keys, sessions, ranks and the per-app ids it enrolled; secrets the seat could
   have held are rotated (§8). The person keeps their own personal account; the org cannot touch it.
6. **Normal accounts keep share-a-server** as it is (Can view / Can manage, co-manager invites at Member). What only
   orgs get: several people with admin authority, scoped admin roles, thresholds, audit export, fleet tools and site
   mode. Recommendation on limits (§13): **cap co-managers on a normal account at a small number (5 active shares per
   account), never cap app visitors**.
7. **Pricing hook:** a new plan `enterprise` in the existing CA-signed plan attestation, priced per seat and per
   server, with the seat count enforced by `.com` at seat admission (§15).
8. **Site mode's check-in** (later, not 0.4) is one more ceremony: k_site org admins sign "still running, all fine"
   over the site's signed state; `.com` countersigns a time-limited site permit (§16).

## 2. Words

| Word | Meaning |
|---|---|
| **org** | An organization account: a name on `.com`, its servers, its authority record. No person "is" the org. |
| **seat** | One personal Flagship account admitted to one org. A person in two orgs has two unlinkable seats. |
| **seat member key** | Ed25519 seed `HKDF(UMK_person, "flagship/org-seat-member/v1|<orgId>")`. Every device of the person derives it. Identity of the seat toward org boxes (sign-in, sessions). Like the share member key. |
| **seat admin key** | A **random** hybrid key (Ed25519 + ML-DSA-65), made on one of the person's admin devices for this org, never UMK-derived, sealed device-local, bound by a `pq-key-binding` (role `org-seat-admin`). Only seats with an admin role have one. Like the per-share admin key, but random, because non-admin devices hold the UMK. |
| **org authority record (OAR)** | The signed list of org admin seats (their admin keys), the thresholds, and the version. Its genesis hash is the org's identity on boxes. |
| **seat grant** | A signed statement admitting a seat: its member key, its admin key (if any), its roles and scopes. |
| **approval** | One admin's hybrid signature over an order's hash under a given OAR version. k approvals make the order valid. |
| **ceremony** | Collecting k approvals for one order, across phones, within its window. |
| **org admin** | A seat in the OAR. Org-wide authority, alone or in k, depending on the action. |
| **server admin / service admin** | A seat with a scoped role from a seat grant: authority over named servers or named apps only. |
| **app visitor** | Anyone invited to an org app through an invite link, as today, with their per-app id. Not a seat. |

## 3. What exists today, and what changes

Today one account is one person (`share-a-server.md` opening line). Authority:

- **Devices** of that one person: admin devices hold the random admin root (or an admin-root-signed `admin` grant),
  other devices hold the UMK and the IRK. The box's device book classifies them (`service-access-gating.md`
  "Who is signing in"). Admin vs non-admin is cryptographic; one non-admin device vs another is not (they share the
  UMK).
- **Another person** reaches a server only as a **co-manager** (a share: Can view or Can manage, owner's opt-ins) or
  as an **app visitor** (invited per app, per-app id).
- **Sensitive orders** verify under one key: the admin root (`authorizeSensitiveOrder`, `adminAuthorityLocal.ts`;
  `.com`'s `authorizeSensitiveComOp`).

| | Personal account today | Org |
|---|---|---|
| Who holds authority | one person's admin devices | n admin seats (different people), k of them per action |
| Root on the box | `admin-root-pin.json` (one key, rotation chain) | OAR genesis hash + replayed OAR chain |
| Another person with admin-like rights | impossible: a co-manager is never admin, and some actions are "always A's" (`share-a-server.md` §1) | server admins and service admins, scoped |
| Delete / wipe / transfer a server | the owner alone | k_destroy org admins (default 2) |
| A person leaves | end their share | revoke their seat: drops every key, rank, enrolled per-app id and session on every org box; rotations follow |
| Audit | the box's activity log, the account log | plus a signed, exportable org log with every approval's signers |
| Who pays | the account's lead server from its voucher stash | the org (per seat, per server), §15 |
| Rank model in apps | member < manager < master | the same three ranks |

What stays exactly the same: TLS ends on the box; `.com` stores ciphertext and signed records only; per-app visitor
identity; one access list per app; the server order and leader election; the PQ gate.

## 4. Roles and what they may do

### 4.1 Roles

| Role | Granted by | Scope | Default rank in apps in scope |
|---|---|---|---|
| **org admin** | an OAR change (k_gov) | the whole org | master |
| **server admin** | a seat grant (k_grant, default 1 org admin) | named servers (or "all servers") | master on those servers' apps |
| **service admin** | a seat grant | named apps (`serviceRef`s), on every server that runs them | master in those apps |
| **member** | a seat grant | the org | manager or member, per the org's default (setting `memberDefaultRank`, default `member`) |
| **app visitor** | an invite link, as today | one app | the invite's rank |

"Only admins change ranks" (owner rule, 2026-10-15) becomes, in an org: **org admins anywhere, server admins on
their servers' apps, service admins in their apps.** Ranks are still the three; what changes is who counts as "an
admin" for a given app. This is an extension of the rule and needs the owner's yes (Q-E3).

### 4.2 What each role may sign

| Action | Who, by default | Default threshold |
|---|---|---|
| Change the OAR (add or remove an org admin, change thresholds) | org admins | **k_gov** = max(2, ⌈n/2⌉); the target of a removal is not counted and cannot block it |
| Admit a seat, change a seat's roles or scopes | org admins | k_grant = 1 (raising a seat to server or service admin: 2, Q-E5) |
| Revoke a seat (non-admin) | any org admin, or the seat itself (leave) | 1 |
| Freeze a seat (including another admin) for 72 h | any org admin | 1, at most one freeze per admin per 7 days; lapses unless k_gov confirms |
| Add a server (AuthCode, RCK, take-over, restore) | org admins, or a seat with the `servers:add` scope | 1 |
| Delete, wipe, transfer, migrate a server; delete the org | org admins | **k_destroy** = 2 |
| Server update, power, apps, access list, debug access, backups on server S | org admins, server admins of S | 1 |
| Rank orders, mode, removals in app R | org admins, server admins of a server running R, service admins of R | 1 |
| Unlock at boot (approve S's start-up) | seats given the unlock opt-in for S (sealed disk-key copy) | 1 |
| Site check-in (§16) | org admins | k_site (default k_gov) |

Principles behind the defaults: **taking access away needs fewer signatures than giving it; destroying needs more
than operating; one rogue admin can delay but not take over.** The org may raise any threshold; it may not lower
k_gov below 2 once it has 2 admins, nor k_destroy below 2 (Q-E4).

## 5. Keys and records

All envelopes follow the house rules: `|`-joined canonical bytes with a `flagship/<purpose>/v1` tag, lowercase hex,
Unix ms, `legacyFieldGuard` on strings, hybrid signatures in the `flagship/hybrid-sig/ed25519-mldsa65/v1` suite
(`pq-suites.md` §5), every signature through `verifyCriticalSignature` (§10). Orgs are **strict from creation**:
there is no classical legacy to keep, so no classical-only org signature is accepted anywhere.

### 5.1 The org authority record

```
flagship/org-authority/v1|<orgId>|<version>|<prevHash>|<adminsHash>|<kGov>|<kGrant>|<kDestroy>|<kSite>|<issuedAt>
```

- `orgId`: 16 random bytes (32 hex), minted at creation; the org name on `.com` can change, `orgId` cannot.
- `admins`: a list beside the statement, each `{seatId, adminKeyId, adminPubEd25519, binding}` where `binding` is
  the seat admin key's `pq-key-binding` (role `org-seat-admin`, subject `<orgId>:<seatId>`). `adminsHash` is SHA-256
  of its canonical form.
- Version 0 (genesis) is signed by every admin in it (each proves possession). Version v+1 needs k_gov of version
  v's admins (the removed admin excluded from n when computing k).
- The **genesis hash** goes into every org server's recipe and install blob in place of `adminRootPub`
  (`device-admin-tier-spec.md` §1.3), and into `.com`'s org row.

### 5.2 Seat grants

```
flagship/org-seat-grant/v1|<orgId>|<seatId>|<memberPubHex>|<adminKeyIdOrEmpty>|<rolesHash>|<oarVersion>|<issuedAt>|<expiresAt>
flagship/org-seat-revoke/v1|<orgId>|<seatId>|<reason>|<oarVersion>|<issuedAt>
flagship/org-seat-freeze/v1|<orgId>|<seatId>|<untilMs>|<oarVersion>|<issuedAt>
```

`roles` beside it: `[{role: "server-admin", servers: [...] | "*"}, {role: "service-admin", apps: [serviceRef...]},
{role: "member"}, {scope: "servers:add"}, {unlockAtBoot: [serverDomain...]}]`. `expiresAt` is a refresh horizon, as
for device grants. A newer grant for the same `seatId` replaces the older; a revoke ends the `seatId` forever (a
returning employee gets a new seat). The seat accepts its grant with its member key (`flagship/org-seat-accept/v1`),
signed on one of its own **admin devices** (the per-share rule of 2026-10-16 carries over: a person's non-admin
device cannot commit them to an org).

### 5.3 Approvals and multi-signed orders

Every org order (a server order, a seat grant, an OAR change, a check-in) is wrapped:

```
flagship/org-approval/v1|<orgId>|<oarVersion>|<purposeTag>|<orderSha256>|<seatId>|<adminKeyId>|<notAfter>|<issuedAt>
```

One approval per signing admin, each a hybrid signature by that seat's admin key. The verifier (box or `.com`):
loads the OAR at `oarVersion` (it must be the current one, or the one before it within 24 h of a change, so a
ceremony in flight survives an unrelated admin change), checks each approval's signer is in it and not frozen,
counts distinct seats, and compares with the action's threshold. For scoped actions (k = 1) the single signer may
instead be a seat whose grant covers the target. **The inner order keeps its existing tag and bytes** (e.g.
`flagship/server-update/v1`, `flagship/app-rank/v1`), so the order code paths do not change; only the authority
predicate does.

### 5.4 The org key ring (what replaces the UMK's derived secrets)

A personal account derives its shared secrets from the UMK (CGK, household key, archive keys, peer-backup keys). An
org has no UMK, so each is a **random key, hybrid-sealed** (`flagship/hybrid-seal/v1`, X-Wing) to the seats that need
it, kept on `.com` as ciphertext, and versioned:

| Secret | Sealed to |
|---|---|
| CGK (box-to-box gossip, access sync MAC) | the org's boxes (their STK/keyd) and org admins |
| org directory key (names of seats, servers, labels) | org admins; a scoped admin gets the slice it needs |
| archive / backup keys | org admins, server admins of that server |
| disk-key copies (unlock at boot) | seats with the opt-in for that server |

Each seat's devices open their slices with keys derived from the seat member key (for the member's directory slice)
or the seat admin key (for admin-only secrets). Removing a seat triggers a **re-key** of every secret it could open
(§8).

### 5.5 Why not threshold cryptography

FROST-style threshold Ed25519 hides who signed and has no ML-DSA counterpart ready for use; a threshold scheme also
needs a distributed key generation that every phone must run in lockstep. Collected signatures cost a few KB per
order (ML-DSA-65 signatures are 3.3 KB each), work asynchronously, reuse the existing gate, and give the audit its
most important fact: **which people approved**. Same choice as the box artifact's k-of-n (`pq-suites.md` §16.2).

## 6. How boxes verify org authority

The box's model today: `admin-root-pin.json` (the pinned root and its rotation chain), the device book (device grants
from `.com`, verified on the box), the share store. For an org server:

1. **Pin.** The install blob carries `orgId` and the OAR genesis hash instead of `adminRootPub`. The box fetches the
   OAR chain from `.com` (`GET /api/orgs/<orgId>/authority`, STK read token), verifies it from genesis, and keeps it in
   `org-authority-pin.json` (a newer verified version replaces it; an older or forked chain is refused, as for the
   assurance policy).
2. **Seat book.** Like the device book: every live seat grant, revoke and freeze, fetched every 5 minutes (and at
   once when an unknown key signs), verified on the box against the pinned OAR, kept on disk so a restart works
   offline. The seat book answers "is this key a seat, which roles, which scopes".
3. **Authority predicate.** `authorizeSensitiveOrder` grows one branch: on an org box it takes an `orgApprovals`
   bundle and decides by the table in §4.2. It stays the single place that decides, and the Rust access authority
   (`rust/crates/flagship-access`) gets the same rules with shared vectors (`test-vectors/org-authority/`).
4. **Sign-in classification** (`service-access-gating.md` "Who is signing in") gains one class: **a seat**, signing
   with its seat member key. Its default rank comes from its roles (§4.1); admin orders (`flagship/app-rank/v1`,
   target `seat:<seatId>`) override it per app as today.
5. **One list per app** is unchanged: journal entries for seat targets carry their proofs; every box re-checks them
   against its own pinned OAR.

`.com` runs the same verifier for the routes it gates (AuthCode issue, RCK, take-over, account-level reads), so
"adding a server is admin-only" becomes "needs an org admin's or a `servers:add` seat's approval" and is still
enforced by `.com` and the box, not the apps.

## 7. Joining

1. An org admin creates a seat invite in the org console: label (sealed under the org directory key), roles, scopes.
   This is a seat grant awaiting its member key, plus a link `https://flagshipserver.com/org-join#<secret>` (the
   fragment never reaches `.com`), the same link machinery as a share (offer sealed under a link key, one acceptance).
2. The person opens it on an **admin device** of their personal account. The app derives the seat member key, and, if
   the seat has an admin role, makes a fresh seat admin key and its binding. It shows a 6-digit SAS.
3. The org admin compares the SAS (it defeats a leaked link, as for shares), then approves; for roles above member
   the ceremony collects k_grant approvals.
4. `.com` stores the grant and its approvals; boxes pick it up from the seat book.

**What `.com` learns.** That org `acme` has a seat with these public keys and roles. It does **not** learn which
personal account holds the seat: the acceptance is signed by the seat keys only, and the person's app talks to the
org routes with an org read token minted by the seat member key. It could guess from IP and timing (the same residual
as shares, `share-a-server.md` §2), unless the app uses the OHTTP relay (`payments-privacy-and-rails.md` §5.4).
Whether enterprises even want that unlinkability, or prefer named seats bound to a company directory, is Q-E7.

## 8. Leaving and offboarding

**A seat ends** by a revoke (one org admin), a leave (the seat itself), or a lapsed refresh horizon. On every org box,
within one seat-book poll (5 minutes) or at once when the revoke is posted straight to the box:

- the seat's member key and admin key stop verifying; its paired sessions and app sessions are closed;
- its default ranks vanish; admin rank orders that named `seat:<seatId>` are kept for the audit but no longer match;
- invites it created stop admitting **new** people (the existing "demoted creator" rule); people who joined stay
  until an admin removes them (org setting: "remove people this seat invited", default off);
- per-app ids the seat **enrolled as itself** (§10) are removed from every app's list;
- any approval it gave to an order not yet complete is dropped from that ceremony.

**Cryptographic completeness.** Revoking the keys is not enough if the person could have copied a secret. After a
seat ends, the org's clients run a **re-key** for every secret in §5.4 the seat could open: new CGK version to boxes,
new directory key, new archive keys for new backups, and **disk-key rotation** for each server where the seat had
unlock at boot. Disk-key rotation is on share-a-server's Later list today; for orgs it is a prerequisite, not an
option (phase E5). Until a rotation completes the org console shows the server as "Key rotation pending after
<label> left".

What the org can **not** do, said plainly: wipe the person's phone, read their personal account, or reach their
personal servers. Flagship is not device management. A departing person keeps whatever they already saw.

## 9. Recovery when admins leave or lose their phones

- **One admin loses a phone.** Their personal account recovers as today (passkey), which restores the UMK and so the
  seat member key. The seat admin key is random and gone: another org admin re-issues the seat grant with a new admin
  key (an OAR change if the seat is an org admin; k_gov counts the lost key as absent).
- **Admins leave normally.** Removal is an OAR change by the others. The console warns when live org admins fall to
  k_gov + 1, and refuses a change that would leave fewer than k_gov admins.
- **Fewer than k_gov admins remain.** The org is stuck unless it has a **recovery kit**: at creation the org makes one
  or two extra admin keys that live offline (a printed seed in a safe, or a YubiKey), listed in the OAR with role
  `recovery`. Recovery seats count only for OAR changes, and an OAR change signed with any recovery seat takes effect
  after **14 days**, during which any one ordinary admin's veto cancels it (the re-pair wait/veto pattern). The kit is
  required for orgs with fewer than 3 admins (Q-E8).
- **Flagship cannot recover an org.** No escrow on our side, consistent with the phone being the trust root. A
  "Flagship-assisted recovery" (our signature plus a long time lock plus legal identity checks) is possible but would
  make `.com` an authority over org boxes; not recommended (Q-E9).

## 10. Org members versus app visitors (per-app identity)

The per-app identity rule protects **visitors** from server owners linking them across apps. Org seats are a
different class, like an account's own devices or co-managers today: the org legitimately knows that seat 12 uses
both the wiki and the CRM, because seat 12 is its employee.

- A seat signs in to **org apps** with its seat member key (one id per org, never per account, never shared with
  another org). The app's `X-Flagship-User` is still per app (`stableIdFor`), so apps cannot link it across apps; the
  org's own audit can.
- A seat that also uses an **org app as a plain visitor** (rare: a contractor invited by link) signs with its per-app
  id as today. A seat may **enrol** that per-app id under its seat (`flagship/org-seat-app/v1|<orgId>|<seatId>|<serviceRef>|<appAidHex>|<issuedAt>`,
  signed by both keys) so offboarding removes it; it is optional and only the org's boxes see it.
- **Outside the org** nothing changes: a person's seat keys never appear on anyone else's box, and their visitor ids
  on other apps derive from their personal UMK exactly as before. Two orgs cannot link a person who is a seat in both.
- External visitors to org apps keep every current rule: per-app ids, ranks the app enforces, anonymous visitors get
  no rank, invites through the box.

AI privacy (owner rule, 2026-10-12): the org name, seat labels, roles, the directory and the audit never enter a
prompt, a tool result or a staging copy. `buildModelRedactor` gains the org name and every seat label it can see.

## 11. Audit

- **Box log.** The activity log records each org order with its approval set (seat ids, labels resolved on clients).
- **Org log.** A hash chain on `.com` of OAR versions, seat grants, revokes, freezes, and the hash of every completed
  multi-signed order, each with its approvals. Entries are signed; their human parts (labels, reasons) are sealed
  under the org directory key, so `.com` keeps the structure but not the names.
- **Export.** Org admins export a signed bundle (chain + approvals + the boxes' own signed log heads) that an auditor
  can verify offline with a small CLI (first-class, per the maintainers-CLI rule).
- Retention: org setting, default 2 years; the chain itself is kept as long as the org exists.

## 12. What a normal account can do today to involve other people

Inventory of `main` as of this branch (2026-11-14). File paths are relative to the repo root.

| Way in | What the other person gets | Limits in code |
|---|---|---|
| **Another device** of the same person | every device is that person; admin vs non-admin is cryptographic | No cap on device count found. `.com` rate limits: `device-admit` 10/min and 100/h per IP; `device-grants-mint` 10/min per IP and 50/h per IRK; `device-grants-revoke` 10/min per IP, 20/h per IRK (`apps/com/src/rateLimit.ts`). Only an admin device adds a device (AGENTS.md, shell v133). Owner rule: devices are for **your own** devices only (`share-a-server.md`, opening). |
| **Share a server** (co-manager) | Can view or Can manage, opt-ins for app data and unlock at boot; never delete, wipe, transfer, sharing, uninstall (`share-a-server.md` §1) | Per box, at most **100 active shares** and 1,000 ended ones remembered (`MAX_ACTIVE`, `MAX_ENDED` in `packages/server-daemon/src/shares/shareStore.ts`). `.com`: at most 10 push devices per share (`SHARE_PUSH_CAP`) and 200 "Shared with me" entries per inbox (`SHARE_INBOX_CAP`, `packages/control-plane/src/serverShares.ts`). `share-key-attestation`: 10/min and 60/h per IP, 30/h per account (`rateLimit.ts`). No per-account cap on how many shares or servers are shared. |
| **Co-manager invites** | a co-manager at Can manage invites people to the shared server's apps at Member | 200 open invites per share (`MAX_SHARE_INVITES`, `packages/server-daemon/src/shares/shareInvites.ts`, refusal `too-many-invites`). |
| **App invites** (visitors) | a person or group joins one app at a rank; members-only or open apps | Up to **5,000 people per app's allow-list** (`ALLOW_LIST_CAP`, `packages/server-daemon/src/serviceAccess.ts`). A personal invite admits one person (`maxRedemptions` defaults to 1); a group invite any number up to its `maxRedemptions`. No `.com` invite count or rate budget found in `rateLimit.ts`. |
| **Ranks** | member / manager / master per app; only admins change them | Owner rule; enforced on the box (`service-access-gating.md` "What each class may do"). |
| **More servers** | not a way in, but bounds a fleet | Server order holds at most **64 servers** (`SERVER_ORDER_MAX`, `packages/protocol/src/serverOrder.ts`). |
| **Demo accounts** | — | 3 paired sessions (`DEMO_PAIRED_SESSION_CAP`, `packages/control-plane/src/demoUsers.ts`). |

So today a normal account can already have up to 100 co-managers **per server**, each at Can manage, each inviting up
to 200 links. That is a small office's worth of shared administration, without thresholds, scopes per app, audit or
offboarding re-keys.

## 13. Options for normal accounts

Constraint first: **app visitors and members stay open on every plan.** People must be able to use apps; capping
visitors would break the product's point (a family wiki, a club calendar, a small shop's API) and would push
people to share accounts, which the identity model forbids. The question is only about **co-managers** (shares).

| Option | Families and privacy users | Enterprise upsell | Abuse / support |
|---|---|---|---|
| **A. Unlimited** (today: 100 per box, no account cap) | best; nothing to explain | weak: a company can run on one personal account with 30 co-managers at Can manage | an owner can hand admin-like power to many with no audit or offboarding re-key |
| **B. Small cap: 5 active co-managers per account** (across all its servers), Can view and Can manage both count | a household (partner, parents, an adult child, a friend who helps) fits; a family over 5 is rare and can go Pro | clear: "more than 5 people who manage servers, or anyone with admin rights over part of it, is a team: that is Enterprise" | trivial to enforce; one number |
| **C. None** | breaks the 2026-10-13 decision and the family scenarios share-a-server was built for (start-up approval while the owner is away) | strongest, but resented | — |

**Recommendation: B.** Free and Pro: 5 active co-managers per account; Pro Max: 10 (Q-E1). Enterprise: unlimited
seats, priced per seat. Ended shares free their slot at once. Where it is enforced: the share is accepted on the box,
which `.com` cannot see by design (it does not learn who shares with whom), so the cap belongs on the **boxes**: each
box counts active shares across the account's servers through the access journal (`share` entries already travel
there), and the leader refuses the sixth acceptance with a sentence ("This account can share its servers with up to
5 people. Remove someone first, or move to a team plan."). `.com` can add a backstop by counting live share offers
per account (it sees offers, not acceptances). Plan attestation tells the box which cap applies.

What normal accounts **keep**: share-a-server at both levels with all opt-ins, co-manager invites at Member, devices,
app invites without limit. What they **do not get**: another person with admin authority (delete, wipe, sharing,
ranks), per-app admin delegation, multi-signature orders, an org log, seat offboarding with re-keys, fleet claims at
scale, site mode. "Not the same level of granularity" (owner) therefore means: a share is **per server, at two
levels**, while an org seat is **per server or per app, at admin level**.

## 14. What makes the enterprise offering compelling

Limits alone are a stick. The reasons a company pays:

1. **Real delegation.** Make Priya admin of the CRM only, or of the three Frankfurt servers only, without making her
   owner of everything. Today impossible: authority is one person's.
2. **No single person can destroy the company's data.** Deleting a server or changing the admin set needs 2 people;
   a stolen phone or a rogue admin cannot wipe the fleet. Every approval is a signature the box checks (consent is
   load-bearing crypto).
3. **Offboarding that actually ends access**, with a re-key, and a record that it happened.
4. **Audit an auditor can verify offline**: who approved what, when, signed.
5. **Quantum-safe by default**: orgs are strict from creation (hybrid signatures and seals everywhere).
6. **Fleet setup**: the wired-tray path (`retail-wired-fleet.md`), batch claims, more than 64 servers (Q-W3), one
   admin confirmation per batch (Q-W4).
7. **Site mode with check-in and warranty** (later): air-gapped clusters, sneakernet updates, the "not hacked"
   record, the warranty (legal review first).
8. **Support and SLA**: a named response time, a status channel, help with ceremonies and recovery kits. (An SLA on
   the relay needs the relay mesh first: AGENTS.md "Make Fly redundant".)

### Mapping to the plans (`payments-privacy-and-rails.md`)

| Plan | Price (owner, 2026-10-09) | Co-managers (rec.) | Org features |
|---|---|---|---|
| Free | $0, 25 GB | 5 | none |
| Pro | $10/mo, 250 GB, 1 custom domain | 5 | none |
| Pro Max | $20/mo, 500 GB, unlimited domains | 10 (Q-E1) | none |
| **Enterprise** (new) | per seat + per server (Q-E10), annual | seats instead | everything in §14; site mode as an add-on |

## 15. Pricing hooks

- `flagship/plan-attestation/v1|<username>|<tier>|<paidUntil>|<issuedAt>|<expiresAt>` gains tier `enterprise` for an
  org name, and a v2 adds `seatLimit` and `serverLimit`. Boxes already read the attestation and treat a failed check
  as "plan unknown", never "lapsed".
- `.com` enforces the seat count when it stores a seat grant (it already sees every grant); boxes check the count in
  the attestation as a backstop.
- **Lapse degrades, never wipes**: no new seats, no role raises, no new servers; existing seats, approvals,
  offboarding and every app keep working. Revoking is always allowed.
- **Payment.** Vouchers stay possible, but a company usually needs an invoice in its legal name. That links "Acme
  pays for org acme", which is acceptable (the org name is the company's own choice and B2B billing needs it) and
  does not link any seat to a person. Enterprise is sold on the web (invoice or Stripe with the company's details),
  not in the phone apps, so the store rules on digital goods do not bite (to confirm with current rules, Q-E11).
- Site mode: an add-on priced per site, tied to the check-in (§16).

## 16. Multi-admin check-in ceremony (site mode, later)

Site mode is planned, not in 0.4 (owner decision, 2026-11-14, `retail-wired-fleet.md`). This is the shape it takes
on top of an org:

1. **Box statements.** Each box of the site signs, with its STK (hybrid), its state:
   `flagship/site-box-state/v1|<orgId>|<siteId>|<serverDomain>|<releaseCommit>|<revocationVersion>|<oarVersion>|<logHeadSha256>|<issuedAt>`.
   The helper (Studio) collects them over the LAN.
2. **The statement.** The helper builds
   `flagship/site-checkin/v1|<orgId>|<siteId>|<period>|<boxStatesSha256>|<statsSha256OrEmpty>|<issuedAt>`; its human
   text in the app reads "We still run this site and all is fine". Statistics are opt-in, aggregate counters only, no
   user content, through the AI-privacy and identity rules.
3. **Approvals.** k_site org admins approve on their phones. On an air-gapped site the phone shows the statement's
   hash and signs offline; the helper reads the approvals back by QR. Admins may also approve remotely when the
   bundle travels.
4. **Online leg.** The bundle goes online (sneakernet or a brief controlled link). `.com` verifies the OAR chain, the
   approvals and each box statement, records the dated check-in (the "not hacked" record is this signed statement plus
   the boxes' signed state), and returns a CA-signed
   `flagship/site-permit/v1|<orgId>|<siteId>|<validUntil>|<revocationVersion>|<issuedAt>` plus the signed update
   bundle and revocations.
5. **Back on site.** Boxes verify the permit under the maintainer CA chain and extend their permission to
   `validUntil`. A lapsed permit **degrades, never wipes**: no new seats, apps or servers; updates from bundles still
   apply; data and running apps stay.

Owner questions it opens: the period (monthly? quarterly?), whether k_site may be 1 for small sites, and the
warranty's guidelines (legal review before it is offered).

## 17. Migrating an existing account into an org

Recommended: **convert in place**, so the name, server names, certificates, `serviceRef`s (`<creator>--<slug>`) and
every visitor's per-app id survive.

1. The owner (on an admin device) creates the org with the account's name, and becomes seat 1 with a fresh seat admin
   key; they add at least one more admin (and a recovery kit) before the conversion completes.
2. The owner's admin root signs `flagship/org-conversion/v1|<username>|<orgId>|<oarGenesisSha256>|<issuedAt>`
   (hybrid). This is a **one-way** hop in the admin-root rotation chain: boxes that replay it switch their pin from
   `admin-root-pin.json` to the OAR and never accept the old root again.
3. `.com` converts the row (`usernames` gets `org_id`), keeps the old personal identity only as history, and moves
   the account's derived secrets to the org key ring (CGK and others re-keyed and sealed to the boxes and admins).
4. The person who owned it makes (or keeps) a **separate personal account** for their own life; their former devices
   stay as seat 1's personal account only if they choose it (Q-E12).
5. Co-managers of the old account become seats if they accept a seat invite; their shares end at conversion otherwise.
   App visitors are untouched.

The alternative, moving servers one by one into a new org with the existing transfer flow, works too but changes
server names and breaks every link.

## 18. Phased plan

| Phase | What | Gate |
|---|---|---|
| E0 | Owner answers §20; legal reads the warranty | — |
| E1 | Protocol: OAR, seat grants, approvals, org conversion, multi-sig verifier; vectors in TS, Rust, Swift, Kotlin, webapp (verify) incl. refusals (forks, frozen signer, stale OAR, duplicate signer, scope miss) | Q01-style review of the envelopes |
| E2 | `.com`: org rows, OAR chain store, seat book routes, ceremony mailbox (ciphertext, sealed to admins), seat-count gate, plan attestation v2; D1 migrations on `main` (workspace rule) | — |
| E3 | Box: OAR pin and replay, seat book, the predicate branch in TS and the Rust access authority, seat sign-in class, journal seat targets | gym lane `org-core` |
| E4 | Clients, iOS first then Android, webapp view-and-collect (keyless web: no ML-DSA seeds, so admins sign on phones): org console, seat join with SAS, ceremonies inbox, approvals, freeze; every string through `i18n/` | mock gyms |
| E5 | Offboarding re-keys: CGK, directory, archive keys, **disk-key rotation** | gym lane `org-offboard` |
| E6 | Co-manager cap on normal accounts (§13), conversion (§17) | gym lane `org-convert` |
| E7 | Audit chain and export CLI | auditor dry run |
| E8 | Site check-in (§16), only once site mode is built | site gym lane with the uplink cut |

## 19. Risks

- **The authority predicate gets complex.** Mitigation: one function per runtime, shared vectors, the Rust authority
  as the writer, and the inner orders untouched.
- **Lock-out.** A threshold org that loses admins is stuck; the recovery kit and the console's warnings carry this.
  A rogue admin can freeze one colleague per week; it cannot take over.
- **`.com` sees org structure** (seat count, roles, approval timing), though not names. Acceptable for B2B; say so.
- **Seat member keys are UMK-derived**, so any device of that person can act as the seat member (not as an admin).
  Same residual as account devices today.
- **Disk keys already copied** by a departed seat stay valid until rotation; E5 must ship before orgs are sold with
  unlock at boot.
- **Signature sizes**: k ML-DSA signatures per order (3.3 KB each) inflate journal entries and relayed orders; set
  caps (k ≤ 7 in v1).
- **Two rank authorities** (org admins and scoped admins) could confuse owners; the console must show, per app, who
  can change ranks and why.
- **Capping co-managers** may annoy existing families with more than 5; grandfather active shares (Q-E2).
- **Warranty and SLA** are legal promises; nothing is offered before review.

## 20. Questions for the owner

- **Q-E1** Co-manager cap for normal accounts: 5 per account on Free and Pro, 10 on Pro Max? Or count per server?
- **Q-E2** Grandfather accounts already over the cap at launch (keep, no new shares), or force a choice?
- **Q-E3** Extend "only admins change ranks" so server admins and service admins count as admins within their scope?
- **Q-E4** Default thresholds: k_gov = max(2, ⌈n/2⌉), k_destroy = 2, k_grant = 1 (2 to raise a seat to admin)? May an
  org go below them?
- **Q-E5** Raising a seat to server or service admin: 1 org admin or 2?
- **Q-E6** May a single org admin revoke another org admin's seat at once (fast offboarding), or only freeze it until
  k_gov confirms? (Recommended: freeze; revoke an admin needs k_gov.)
- **Q-E7** Seats unlinkable from personal accounts even toward `.com` (recommended), or named seats tied to a company
  directory (SCIM, SSO) for enterprises that want it?
- **Q-E8** Require a recovery kit for orgs with fewer than 3 admins?
- **Q-E9** Any Flagship-assisted org recovery? (Recommended: no.)
- **Q-E10** Enterprise pricing: per seat, per server, or both; minimum seats; annual only?
- **Q-E11** Sell enterprise only on the web by invoice, never in the phone apps?
- **Q-E12** On conversion, does the former owner's personal account keep its devices, or start fresh?
- **Q-E13** Can a seat be in several orgs at once (consultants)? The design allows it; the UI must keep them apart.
- **Q-E14** Site check-in period and k_site; warranty guidelines.
- **Q-E15** Should normal accounts get per-app sharing (share one app's admin, not the server) as a middle step, or is
  that the enterprise line? (Recommended: enterprise line.)
