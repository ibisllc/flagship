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
   This is a seat grant awaiting its member key, plus a link `https://flagshipserver.com/org-join#o=<orgId>&s=<seatId>&k=<k>`
   (the fragment never reaches `.com`). The 32-byte link key `k` derives two keys:
   - the **offer key** `HKDF-SHA256(k, info "flagship/org-invite-offer/v1", 32)`, which seals the offer (org name,
     genesis, roles, pseudonym) and the pseudonym's label under AES-256-GCM;
   - the **invite key**, a hybrid Ed25519 + ML-DSA-65 key whose 64-byte secret is
     `HKDF-SHA256(k, info "flagship/org-invite-key/v1", 64)` (Ed25519 seed, then ML-DSA seed). Its public half,
     `inviteKeyPub`, is part of the invite's canonical bytes (`flagship/org-seat-invite/v1|…|<expiresAt>|<inviteKeyPub>`),
     which the inviting admin approves and `.com` stores.
2. The person opens it on an **admin device** of their personal account. Reading the offer
   (`GET /api/orgs/<orgId>/invites/<seatId>`) needs a fresh invite-key signature over
   `flagship/org-invite-read/v1|<orgId>|<seatId>|<issuedAt>` (headers `x-flagship-issued-at`, `x-flagship-signature`;
   within 5 minutes of `.com`'s clock). A missing, stale or wrong proof answers 404, exactly as an unknown invite, so
   the orgId and seatId alone reveal nothing. The app checks the invite names the invite key its link derives, derives
   the seat member key, and, if the seat has an admin role, makes a fresh seat admin key and its binding.
3. The accept is signed twice: by the seat member key (as before) and by the invite key, over the same
   `canonicalOrgSeatAccept` bytes. `.com` refuses an accept without a valid invite-key signature (404 again), keeps the
   signature with the accept and serves it in `/seats`. So only someone holding the link can accept; knowing the orgId
   is not enough to squat on a pending invite. Admin apps and a directory connector's box verify the invite-key
   signature themselves before offering "admit" or linking a person to the seat; `.com` also refuses a grant whose
   accept lacks it.
4. Both phones show a 6-digit SAS. The org admin compares it (it still defeats a leaked link, as for shares), then
   approves; for roles above member the ceremony collects k_grant approvals. If the codes differ, the admin app says
   plainly that someone other than the invited person accepted, and offers to withdraw the invitation.
5. **Withdraw.** An org admin (the invite's own authority level, one admin) signs
   `flagship/org-invite-withdraw/v1|<orgId>|<seatId>|<oarVersion>|<issuedAt>` as an org approval and posts it to
   `POST /api/orgs/<orgId>/invites/<seatId>/withdraw`. `.com` deletes the invite and any accept not yet admitted, keeps
   the withdrawal (that seat id is never invited again, so the old signed invite cannot be replayed) and logs
   `invite-withdraw`. An admitted seat is offboarded with a seat revoke instead (409 `org-seat-admitted`).
6. `.com` stores the grant and its approvals; boxes pick it up from the seat book.

Invites made before 0.5 have no invite key: `.com` no longer serves them, and they cannot be accepted or admitted.
Admins send those invitations again (release notes 0.5).

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

## Owner answers and open debate, 2026-11-14

- **Freeze: yes.** One admin may freeze another (72 h, at most once a week); removing an admin needs more (below).
- **Seats unlinkable: yes.** The inviter must set a pseudonym for the person before the invitation QR or link is
  generated; the org sees only that pseudonym.
- **Caps: under debate.** Owner: 5 is good for a family, 10 may be small for a business, and the tiers should
  differ. See the proposed ladder in the release journal (2026-11-14).
- **Admin is binary, but scoped in an org.** On a personal account a device is admin or not. App ranks (member <
  manager < master) are a separate thing that admins hand out inside apps. Q-E3 only asks whether, in an org, an
  admin of server S (or app R) counts as "an admin" for changing app ranks on S (or in R).
- **Founding user (owner proposal, to design):** the founder seat may remove an admin after a timeout; and an org can
  write "bylaws" into its authority record (who must sign, e.g. a majority of admins or a board) so that anyone
  frozen out by a rogue admin can go online and run that ceremony to overturn it, in a very simple UX.

## Owner decisions, 2026-11-14 (binding)

- **Co-manager caps:** Free 5, Pro 10, Pro Max 25, Enterprise unlimited (priced per seat). App visitors unlimited on
  every plan. Accounts already over a cap keep their active shares.
  Built on `0.4/comanager-caps` (`share-a-server.md` §5.8): counted in active shares (one person on one server), since
  per-share keys keep a person unlinkable across servers.
- **Q-E3: yes.** In an org, an admin of server S counts as an admin for changing app ranks on S; an admin of app R,
  in R. Admin stays binary per scope.
- **Q-E6: freeze only** (72 h, at most once a week); no admin removes another admin directly.
- **Seats:** unlinkable, with a mandatory pseudonym set by the inviter before the QR or link is generated.
- **Founder:** the founder seat may remove an admin after a 7-day notice, during which the admin being removed cannot
  block it but other admins can veto. The founder role moves only by ceremony.
- **Bylaws:** the org's authority record names who must sign to overturn a freeze or removal (e.g. a majority of
  admins, or named board members). A frozen-out member taps "Restore my access"; the app shows who must approve and
  collects their approvals online; boxes check the bylaws themselves. Changing the bylaws needs the strictest
  ceremony of all.

## Implementation status (branch `0.4/enterprise-build`, 2026-11-14)

How the binding decisions were built, and what is still open. Not deployed, not run on a real box or phone.

- **Protocol (E1):** `packages/protocol/src/orgAuthority.ts`, vectors `test-vectors/org-authority/`
  (`tools/org-authority-vectors.ts`), ports `apps/mobile/shared/Sources/FlagshipCore/OrgAuthority*.swift` and
  `apps/mobile/android/.../core/pq/OrgAuthority.kt`. The OAR lists `admin`, `board` (counts only for overturns and
  vetoes: the "named board members" of the bylaws) and `recovery` seats, the founder seat and the bylaws
  (`overturnSeats` named or `*`, `overturnK`, 0 = majority, `vetoK`). Transitions: `direct` (k_gov; the strictest
  threshold, max(k_gov, k_destroy, k_site, overturn k, ⌈2n/3⌉), to change the bylaws or move the founder role, plus the
  new founder's own approval), `founder-removal` (the founder's notice, exactly 7 days, removes one admin, thresholds
  clamped; vetoed by `vetoK` other admins or by the bylaws' overturn set), `recovery` (k_gov counting a recovery seat,
  14 days, any other admin vetoes) and `overturn` (the bylaws' set restores an admin a founder-removal took out). Every
  new or re-keyed admin approves the record with its new key (consent). Freezes: one admin, at most 72 h, the second
  freeze by the same admin within 7 days is void, overturned by the bylaws' set ("Restore my access"; the frozen seat may
  open that one ceremony). Seats: invite (pseudonym digest mandatory) → accept (seat member key, UMK-derived per org) →
  grant (k_grant; 2 org admins to raise to server/app admin). Q-E3: a server admin of S and an app admin of R authorize
  app orders on S / in R alone; org admins are master everywhere.
- **`.com` (E2):** `packages/control-plane/src/orgs.ts`, D1 **0141**, routes under `/api/orgs`, rate budgets
  `org-write` / `org-read`. Every write re-verifies the chain from the genesis hash recorded at creation; a new seat
  needs an invite and the person's accept; plan hook = `seat_limit` / `paid_until` on the org row (lapse stops new
  seats and admin raises, never revokes). `authorizeOrgComOp` is the gate for routes `.com` serves for an org.
- **Box (E3):** `packages/server-daemon/src/orgAuthorityPin.ts`; config `orgId` + `orgGenesisHash`; sync every
  5 minutes into `org-authority-pin.json`, refusing a shorter or forked chain and merging freezes/revokes so `.com`
  cannot drop one; `authorizeSensitiveOrder({ org })` decides by org approvals only. Offboarding closes the seat's
  sessions and lists the rotations it leaves (CGK, directory key, archive keys, the disk key where it had unlock at
  boot) as pending in Activity.
- **iOS (E4, first cut):** Settings → Organizations: create (founder alone), approvals inbox, admins with Freeze,
  Restore my access with who must approve, Invite (pseudonym first, then role, then QR and link).

**Branch `0.4/enterprise-servers` (2026-11-15):**

- **Org servers.** `flagship/org-server-code/v1` is the org's AuthCode: it names the org and its authority
  genesis (what the box pins in place of `adminRootPub`), approved by one org admin or a `servers-add` seat
  (`verifyOrgServerCode`, the same predicate as the box). `.com`: `POST /api/orgs/<id>/servers/code`
  (domain `<server>.<orgName>.<apex>`, plan lapse stops new servers, refusal `org-add-server-refused`),
  `POST …/servers/register` (the box's STK signs `flagship/org-server-register/v1` over the code's hash; one
  registration per code; the approver must still hold the right), `GET …/servers`. The server row goes into
  `servers` under the org's name. No migration: new object kinds live in `org_objects` (0141).
- **Key ring and offboarding rotations (E5).** `flagship/org-key-ring/v1`: each shared secret (CGK, directory
  key, archive keys per server, disk key per server) is a versioned random key hybrid-sealed (X-Wing,
  `flagship/org-key-seal/v1`) to the recipients allowed that kind, with a key commitment every opener checks
  and the departed seats it answers (`retired`). Recipients announce X-Wing keys: seats with
  `flagship/org-seat-kem/v1` (seed derived from the UMK per org, signed by the member key, or the admin key
  for org admins), boxes with `flagship/org-box-kem/v1` (STK). `.com` stores a version only when every
  recipient may hold it and no departed seat is among them; `GET …/keys` lists what each departed seat still
  leaves to rotate (`orgPendingRotations`). The box opens the newest version sealed to it into
  `org-keys.json` and ends a seat's rotation only on a version verified under its own pinned chain.
- **Audit export (E7).** `GET …/export` serves the chain, seat objects, rings, server codes and the log;
  an org admin's approval over `flagship/org-audit-export/v1` (log head + record hash) makes it verifiable
  offline (`verifyOrgAuditExport`; objects the log never named are listed).
- **Invite link.** `/org-join` is an app link on `.com` (open-in-app page in seven languages); the webapp
  shows the invitation (opens the offer with the fragment key, checks org, seat and genesis) and hands the
  link to the phone (shell v211). Vectors `test-vectors/org-servers/` (TypeScript only so far).

**Second tranche (2026-11-15, same branch):**

- **One namespace.** Usernames and org names share `<server>.<name>.<apex>`: username claim, account bootstrap
  and org create each refuse the other's names with the existing `taken` code.
- **Org install path.** An org recipe (`kind: "org"`, `flagship/org-install-blob/v1`) carries the server code
  and its approval plus an org admin's approval over the recipe (installer commit, registration URL, unlock mode,
  disk encryption). The preseed engine hands it to the box unchanged; the bootstrap reads the code's serial,
  strips the org registration route and writes a config with `orgId` + `orgGenesisHash` and no IRK (the IRK slot
  is a zero key nobody holds, so owner-IRK paths fail closed); `install-helper sign-server-register` signs the
  org registration. The box checks its own recipe's approvals once it has replayed the chain (Activity).
- **Gossip on the org CGK.** An org box takes the CGK it opened from the key ring as its gossip key (no cgk
  deposit poller), and restarts when it opens a newer version. Under keyd every version goes through keyd's own
  check (third tranche below).
- **Rotations, client side.** `orgKeyContextFromServed` + `rotateOrgKey` (TS) and `buildKeyRing` (Swift, Kotlin)
  plan and seal a version; the webapp cannot (keyless).
- **Auditor CLI.** `npx tsx tools/org-audit/verify.ts <export.json> --genesis <hash>`.
- **Ports.** `OrgServers.swift` and `OrgServers.kt` with vector tests (uncompiled here).
- **iOS join.** `/org-join` opens `OrgJoinScreen` (accept, the 6-digit code); the org detail lists people waiting
  to join with their code and "Codes match: admit" (a second admin completes an admin-role grant in the inbox).
  Uncompiled here.

**Third tranche (branch `0.4/enterprise-3`, 2026-11-15):**

- **Android join and admit.** `/org-join` is claimed in the manifest and the parser and opens the join screen
  (offer opened with the link key, chain checked from the genesis in it, seat member key from the UMK, a random
  admin key wrapped like the other PQ seeds for an admin role, the 6-digit code). Settings → Organizations lists
  this phone's seats; an org page shows people waiting to join ("Codes match: admit") and the approvals inbox.
  Android has no create, invite or freeze yet (iOS does).
- **Rotate keys (iOS, Android).** The org page lists each departed seat with the keys it could open and "Rotate
  keys". The phone computes the pending list itself (ports of `orgPendingRotations` and recorded approvals:
  `OrgRotation.swift`, `OrgRotation.kt`), verifies every served KEM statement, announces its own seat KEM key,
  seals a fresh key to the recipients it accepts and signs the ring with its seat admin key (one org admin, or one
  scoped seat for a server's own keys). Disk keys are listed, not rotated (the LUKS re-key is open).
- **keyd and the org CGK.** keyd pins the org (`org.json`, with the ceremony's token) and adopts a CGK only
  through `cgk.orgAdopt`: it replays the chain from that genesis under a narrower rule (genesis, then `direct`
  transitions only), needs a `cgk` ring above the version it holds that names this box, one org admin's approval
  as of the record it names, and the key's commitment. A chain moved by a founder's removal, a recovery or an
  overturn is refused (the box keeps its CGK until the next ceremony); keyd never sees freezes, so a frozen admin's
  approval counts there. The approval must stand under the newest record shown: each signer still an org admin
  there with the same keys, and an approval under an older record made before the next record existed. keyd keeps
  the head it last verified (`oarVersion`, `oarHash`), moved forward by every adoption and by `org.head`, which the
  daemon calls with its pinned chain at each org sync (keyd replays it; the head never moves back), and refuses a
  chain that ends below that head or forks from it (`stale-chain`). Once keyd holds a ring it took this way, the
  version it takes must link back to it by `prevSha256` through every version in between, which the daemon sends
  as `between` (links only; `version-gap`, `prev-hash`), so a box that missed rotations still takes the newest. A
  removed admin can no longer rotate the CGK over a truncated chain once the box has synced the record that removed
  it (05c review F4). Limit: keyd has no fresh source of the chain head of its own, so a daemon compromised, or a
  `.com` withholding the record, before that sync still can; a signed, fresh head attestation would close it. TS `packages/keyd/src/orgCgk.ts` and Rust `flagship-keyd/src/org_cgk.rs` replay the same
  vectors (`test-vectors/keyd-org-cgk`). An org box never hands keyd a raw CGK any more.
- **Install timeline.** Order status and install events accept an org server code's serial (pushes and Activity
  stay AuthCode-only); the appliance specializer reads the code's serial and the org registration route.
- **Box log heads.** Each Activity line is chained (`flagship/org-box-log/v1`) and an org box signs the head with
  its STK (`flagship/org-box-log-head/v1`, every 15 minutes when it moved, `POST …/box-log-heads`). The export
  carries the servers and their newest heads; `verifyOrgAuditExport` and the CLI check each under the key its
  server registered with (AT-ENV-46). It also carries every head and registration the log names
  (`boxLogHeadHistory`, `registrations`): the verifier fails when a logged one is missing, when a server's served
  head is not the last one logged, or (with `--previous`, an export verified before) when the log does not extend
  the earlier one or a head went back (05c review F5).

Open on this branch: the box's LUKS re-key for a disk-key rotation (needs a real box drill); the org's pseudonyms on
the admin's screens (labels are sealed under the link key; the org directory key is not built), so waiting people
show as "Seat <id>"; a seat announces its KEM key only when it rotates (a member that never opens the org page
receives no new version until it does); keyd's chain rule refuses non-`direct` transitions and does not see
freezes; Android create, invite and freeze; `.com`'s serial lookup for org install timelines scans `org_objects`
(no index by kind and key); `/api/order/<serial>/health` (Studio) still needs an AuthCode; nothing has run on a
device or a real box.

Still open from `0.4/enterprise-build`: passing org approvals at each box order call site, the org directory key,
the webapp's org UI (it can only show an invitation), conversion of an existing account (§17), and a per-isolate cache
of the verified chain on `.com` (each request re-verifies every ML-DSA signature).

**Branch `0.4/org-directory` (2026-11-15).** Builds `docs/org-directory.md` (its "As built" has the detail):
- **Org directory key and entries** (closes "Seat <id>"): sealed `flagship/org-directory-entry/v1` entries under the
  `directory-key` ring, `.com` `/directory` routes (one org admin writes, newest per entry), the admins' pseudonym view on
  iOS and Android (the webapp has no seat keys yet). Members see only the people they share with (owner, 2026-11-15);
  member slices are not built yet.
- **Connectors and proposals** (`flagship/org-connector/v1`, `flagship/org-proposal/v1`), executed only through the existing
  approvals.
- **Release-manager decisions built here:** a member seat announces its seat KEM key at join (it rides with the accept
  and `.com` records it when the grant lands); D1 **0148** indexes `org_objects(kind, object_key)` for the server-code
  serial lookup (in `KNOWN_MIGRATIONS`); Android has create, invite (pseudonym first, QR and share link) and freeze,
  matching iOS.
- **Directory connectors on the org box** (SCIM 2.0 at `/scim/v2`, LDAP pull) and the developer guide
  `docs/directory-connectors.md`; **the admin console's Directory** on iOS and Android (proposals with Approve, people,
  connectors with "Add a SCIM connector"). SCIM tokens are per connector, rotated by hand, warned after 365 days (owner,
  2026-11-15).
- **Second round (owner, 2026-11-15):** a connector whose approver left needs re-approval (7 days of grace, then
  suspended; listed with the pending rotations); members get their slice of the directory (`flagship/org-directory-slice/v1`:
  the people and servers they share with, no emails); the console carries out role changes and has the LDAP form, the
  mapping editor, pause / retire / new token; one content-free Activity line per SCIM request; an OpenLDAP CI job. The
  webapp pieces wait for the key-custody branch (hooks listed in `org-directory.md`).

