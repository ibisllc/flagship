# F4: invite redemption cap race (researcher "Aldi") — investigation

Read-only investigation on `release/0.4` HEAD `8e9c6ee5b` (== `main` == deployed `.com`), 2026-11-23.
Nothing was changed, committed or deployed. Production was read with SELECTs only. Local reproductions
used the real `.com` handler, the real D1 adapter over `node:sqlite` with every migration
(`packages/storage/tests/support/sqliteD1.ts`) and the real box `buildServiceAccessHttp`. The scripts
live outside the repo (in the session scratchpad: `repro.mts`, `box.mts`, `accept.mts`).

## Summary

| Claim | Verdict | Real effect |
|---|---|---|
| (a) `.com` redeem TOCTOU | **Confirmed** | Extra binds in `.com`'s ledger: 8 of 8 locally, 4-6 of 8 for the researcher, 8 over-cap invites in prod (all the researcher's). On its own this does **not** let extra people into the box, because of bug (d). |
| (b) box `bindJoin` has no per-invite cap | **Confirmed, but the worse box holes are elsewhere** | The redeem path binds whatever AID `.com` names (always the *first* binder, see d). `POST /api/service-access/accept` binds with **no cap, no expiry, no approval-mode check and no authentication** (e). |
| (c) refused peer joins re-applied every reconcile | **Confirmed (mechanism)** | The cap is soft across boxes: refused entries are retried every 120 s and let in when a slot frees. The people let in this way did sign with an AID. A withdraw stops them. Over-cap journal entries come from (e). |
| **(d) NEW: `.com` returns the FIRST binder's AID to every later redeemer** | **Confirmed, reproduced** | Every group-invite redeemer after the first (no race needed), and every racer on a personal invite, gets a box session cookie **as the first person**: same per-app id, same rank. The later redeemers themselves are never added to the box list. |
| **(e) NEW: `/api/service-access/accept` is unauthenticated and uncapped** | **Confirmed, reproduced** | Anyone with an invite link's `i=` (inviteId) and `s=` (serviceRef) can add any number of fresh keys as members. This works after the invite was used, after it expired, and on auto-approve invites. It is journaled to the app's other servers. |

Severity (my judgement): **(e) High**, **(d) High**, **(a) Medium** (Low on its own, since it only fills
`.com`'s ledger), **(c) Low-Medium**. Taken together, F4 deserves High, but the High comes from (d) and (e)
rather than the race the researcher described. No real user is affected: every invite in prod belongs to
2 recently created non-demo accounts, consistent with the researcher.

## 1. (a) The `.com` race

`packages/storage/src/d1.ts:6034-6091` `D1ServiceInviteStorage.redeem` runs five separate awaited
statements with no batch and no transaction:

1. `getBySecretHash`, a SELECT plus the `boundAIDsFor` SELECT (`:6041`, `:5960`);
2. a JS cap check on the stale `boundAIDs.length` (`:6053-6060`);
3. `INSERT OR IGNORE INTO service_invite_bindings` (`:6062-6068`); the OR IGNORE only protects the *same* AID (PK `(invite_id, aid)`);
4. a COUNT SELECT, then an `UPDATE service_invites SET bound_aid = COALESCE(...), redemptions = count` (`:6078-6088`);
5. `get()` (`:6089`).

D1 serialises each **statement** (one SQLite writer per database), but a Worker isolate (or several
isolates) interleaves at every `await`. Steps 1-2 of N concurrent requests all see the same count before
any step 3 lands. The single-use default (`max_redemptions IS NULL`) has the same race (`:6053-6054`).
Handler: `packages/control-plane/src/serviceInvites.ts:490-581` (`:549` calls redeem). The `.com` route
has no rate limit (`apps/com/src/controlPlaneRoutes.ts:1975-1981`; nothing in `rateLimit.ts`). The box's
redeem has a per-client limiter (`serviceAccess.ts:1703-1705`), but a researcher can call `.com` directly.

Local reproduction (real D1 adapter over node:sqlite, `Promise.all` of 8 distinct AIDs):

```
D1        single-use (max NULL)  firstBind ok=8  ledger=8
D1        max=1                  firstBind ok=8  ledger=8
D1        max=3                  firstBind ok=8  ledger=8
InMemory  single / max=1 / max=3 ok=1 / 1 / 3   (no await between check and push: atomic)
```

The shim is synchronous, so the window is at its widest. Real D1 has milliseconds of network delay per
statement, which matches the researcher's 4-6 of 8. The in-memory adapter is correct, so the parity
suite (`packages/storage/tests/serviceInviteStorage.test.ts`) can't catch this; it has no concurrency case.

**Production (read-only):** 43 `service_invites` rows (31 revoked; 27 personal, 16 group; 0 manual),
47 bindings over 17 invites. **8 invites hold more bindings than their cap**: 7 with `max_redemptions=1`
(3, 4, 4, 5, 5, 6, 6 bindings) and 1 personal (3 bindings). 5 of the 8 are revoked; **3 over-cap invites
are still live**. All 43 invites belong to **2 accounts**, both non-demo and `single`, both claimed
recently. All 8 over-cap invites belong to **one** of them, and they were created 2026-11-18/19. No
other account has ever created an invite, so no real user is affected.

## 2. (b) What a redeem does end to end, and the box's caps

Flow (`packages/server-daemon/src/serviceAccess.ts:1884-2015`, `handleRedeem`): the visitor (webapp
`apps/web/public/webapp/lib/serviceInvite.js:907-956`, Android `ServiceAccessClient.kt:202`, iOS the
same) POSTs to **the box** `/api/service-invites/redeem`. The box verifies the AID signature, then calls
`.com` `/api/service-invites/redeem` (`:1928-1934`). `.com` is the only arbiter of first bind and the
cap. The box verifies the owner's signed create (`:1965`), but it does **not** count binds per invite
or compare with `.com`'s ledger. It binds `comBody.boundAID` (`:1986-1987`), journals a `join` only
when `boundAID === visitorAID` (`:1988-1995`), and issues a `Flagship-App-Session` cookie **for
`boundAID`** (`:1998-2003`).

`bindJoin` (`:2247-2262`) checks withdraw, creator standing and the global `ALLOW_LIST_CAP` (5000,
`:305`, `:704`). It has no per-invite cap. `joinFromPeer` (`:2401-2414`) does check it (`cap =
maxRedemptions ?? 1`, `:2410-2411`). The researcher is right.

### (d) New: the box gets the FIRST binder's AID

`.com` answers `boundAID: res.record.boundAID` (`serviceInvites.ts:568`). That is the row's `bound_aid`,
which `redeem` keeps as the **first** bind (`d1.ts:6081` `COALESCE(bound_aid, ?2)`; the in-memory
adapter is the same at `inMemory.ts:3354-3357`). The test stubs always return the visitor's own AID
(e.g. `server-daemon/tests/serviceAccess.test.ts:207`), so nothing ever exercised this. Reproduction
(real `.com` handler + real D1 adapter + real box):

```
group invite, max=3, sequential x4   .com ledger 3 | box allow-list 1
  visitor 1 -> 200, cookie as visitor 1
  visitor 2 -> 200, cookie as visitor 1   <- someone else
  visitor 3 -> 200, cookie as visitor 1   <- someone else
  visitor 4 -> 409
single-use invite, 8 in parallel      .com ledger 8 | box allow-list 1
  all 8 -> 200, every cookie as visitor 1
```

Consequences:

- **Normal group-invite use is broken and unsafe.** Visitor 2..N are told "You're in"
  (`views/invite-redeem.js:206-221`) but are never on the box list. Anyone who captures the
  `Set-Cookie` (curl, or a browser on the box's origin) acts in the app **as member 1**, with member 1's
  per-app stable id and whatever rank an admin gave member 1 (`appMemberSession.ts:40-58` resolves the
  cookie only by token, `serviceRef` and `isAllowed(sess.aid)`; the recorded user agent is never
  checked). The cookie is host-only, but `lookup` doesn't check the host, so a replayed token works on
  the app's host.
- In the race (a), the box doesn't let in N *different* people. It hands every racer the first
  binder's identity, and only one AID reaches the box list.

### (e) New: `/api/service-access/accept` binds anyone, uncapped

`handle()` routes `POST /api/service-access/accept` to `handleAccept` with only a per-client rate
limit (`serviceAccess.ts:1686-1689`). `centralAuthorization.ts:72` labels `/api/service-access`
"signed-order", but anonymous requests pass that layer ("Public routes carry their own checks", header
of the file). `handleAccept` (`:2035-2105`):

- fetches the owner's signed create from `.com` **by inviteId** (`:2066`; `.com`'s
  `handleFetchServiceInviteCreate`, `serviceInvites.ts:899-955`, doesn't check revoked, expiry or mode);
- verifies the accept signature **under the contactAID it carries** (`:2087-2093`), so any fresh
  keypair works;
- calls `bindJoin` (`:2096`): **no cap, no expiry, no `approvalMode === manual` check, and no check
  that the submitter is the author**, although the doc comment (`:2028-2030`) says only the author
  finalizes;
- journals an `accept` entry (`:2099-2105`), so every server of the app gets it.

The invite link carries `i=<inviteId>&s=<serviceRef>` in its fragment
(`serviceInvite.js:458`, `:487-491`; iOS and Android match). Reproduction (personal auto-approve
invite, already redeemed by the real friend, past its `expiresAt`, no session, five fresh keys posting
`{accept, acceptSig}`): **5 of 5 bound, allow-list 6**.

Owner visibility: every allow-listed AID appears in the app's Members list
(`memberRoles.ts:6-9`, `:244`, owner sessions only) with its grant/inviteId, so an owner *can* see and
remove them. The AIDs are opaque per-app ids, though, and no push or Activity entry is raised when someone
joins (no `onEntry`→notify path; `serviceAccess.ts` has no notify call). Removal (`remove` order) only
keeps out **that** AID (`removedAfter`, `:804-807`), and (e) lets a fresh key straight back in. Only a
withdraw of the invite (`withdrawnHere`, `:2268`) stops it, once the box holds the tombstone.

## 3. (c) Refused journal entries are re-applied

`accessSync.ts:298-315` `take()`: on `refused` or `skipped` the entry is neither journaled nor
tombstoned (`:311`). The sender's digest therefore never matches, and `syncWith` (`:402-420`) re-sends
the full list. `reconcileOnce` runs every 120 s (`:636`). Each pass re-runs `applyEntry` → `joinFromPeer`
(`serviceAccess.ts:2354-2380`, `:2401-2414`). When `boundThrough` drops below the cap (an admin removes
someone who joined through that invite), the next pass admits the waiting entry with no new consent and
no notice. The researcher is right.

Bounds:

- **A withdrawn or revoked invite stops pending joins.** `joinFromPeer` → `bindJoin` → `withdrawnHere`
  refuses them (the poller and the `withdraw` entry both call `noteWithdrawn`, `:2350`,
  `buildRevocationPoller` `:2544`+). A slot frees only by removing *another* member while the invite is
  still live. A removed person stays out (`removedAfter`), and expiry is checked against the signed
  `redeemedAt`/`acceptedAt`.
- **Everyone re-admitted signed with a key bound to a real redeem or accept for that invite.** So the
  harm is "the cap is soft and the lists differ per box". It is not "strangers get in": they hold, or
  were handed, the link's data.
- Different boxes keep a different first N, decided by arrival order, so the lists diverge.
- Over-cap entries in the journal come from (e), where the authoring box binds without a cap and
  journals. They can't come from the redeem path, which journals only the first binder (d).

## 4. Severity

- **(e) High.** It breaks the invite model's core promises (single use, cap, expiry, manual approval,
  removal sticks). The precondition is low: anyone who ever saw the link, including a forwarded,
  leaked, already-used or expired one, or a removed member, can mint unlimited members at the invite's
  rank (Member, or the role an admin set on that invite). Without the link (inviteId plus serviceRef),
  nobody gets in. A withdraw stops it.
- **(d) High.** In ordinary group use, member 2..N act as member 1, with member 1's data and member 1's
  rank (it can be Manager or Master if an admin raised member 1). Exploiting it needs only a link to a
  group invite that someone already redeemed. Neither the invitee nor the owner can see it.
- **(a) Medium.** It affects only `.com`'s ledger and the owner's invite list (`k/N` display,
  revoked-since `boundAIDs`). It becomes a real admission bug only once (d) is fixed, if (a) isn't
  fixed with it.
- **(c) Low-Medium.** The cap is soft and lists diverge, but only among link holders, and a withdraw
  stops it.

## 5. Fix plan

**`.com` (deploy; no migration needed).**
1. Make the bind atomic. Use one conditional statement that encodes the cap, revoke and expiry,
   following the codebase pattern in `packages/storage/src/boxClaims.ts:79-92`
   (`INSERT ... SELECT ... HAVING COUNT(*) < cap`):
   ```sql
   INSERT OR IGNORE INTO service_invite_bindings (invite_id, aid, bound_at)
   SELECT i.invite_id, ?2, ?3 FROM service_invites i
    WHERE i.invite_id = ?1 AND i.revoked_at IS NULL
      AND (i.expires_at IS NULL OR ?3 <= i.expires_at)
      AND (SELECT COUNT(*) FROM service_invite_bindings b WHERE b.invite_id = ?1)
          < CASE WHEN i.max_redemptions IS NULL THEN 1
                 WHEN i.max_redemptions = 0 THEN 2147483647
                 ELSE i.max_redemptions END
   ```
   Then send the `UPDATE ... bound_aid = COALESCE(...), redemptions = (SELECT COUNT(*) ...)` in the
   same `db.batch([...])`, since a D1 batch is a transaction. If `changes = 0`, re-read: already bound
   to this AID means idempotent, otherwise the invite is full or bound. Make the in-memory adapter
   match. Add a concurrency case to `serviceInviteStorage.test.ts`; `Promise.all` over the sqlite shim
   reproduces the race today.
2. Return the **redeemer's** AID: `boundAID: aid` (or a separate `visitorBound: true`), not
   `record.boundAID`.
3. Give `/api/service-invites/redeem` a budget in `apps/com/src/rateLimit.ts` (per IP and per secretHash).
4. `handleFetchServiceInviteCreate`: return `revokedAt`, `expiresAt`, `approvalMode` and the
   bound count (or refuse revoked) so the box can decide.
5. Clean-up for the owner to decide: 3 live over-cap invites remain from the researcher's account.

**Box (endorsed box release).**
1. `handleRedeem`: require `comBody.boundAID === visitorAID` (else 502), bind and journal the
   visitor, and issue the cookie only for the visitor.
2. `handleAccept`: require author authority. Either require an owner/admin paired session plus an
   author-signed finalize (admin root, or the invite's creator key, like the withdraw), or drop the
   endpoint, since prod has 0 manual invites and the clients would need the change. Also refuse when
   the create isn't manual (from the `.com` fetch), when it has expired, or when the invite is full
   (per-invite cap).
3. Put the per-invite cap in `bindJoin` itself, shared by redeem, accept and `joinFromPeer`, and run
   the check and the add under one per-invite lock (the store queues writes, but the check-then-add
   in `joinFromPeer` spans an await). For the redeem path, `.com` stays the cross-box arbiter: the box
   trusts ".com bound *this visitor*" and doesn't need `.com`'s full list.
4. Refused joins (c): either (i) make the cap deterministic, so every box admits the same first N
   `join`/`accept` entries per invite, ordered by (`redeemedAt`/`acceptedAt`, entry hash), and a later
   entry never displaces or waits for a slot; or (ii) record refused-for-cap entry keys locally and
   never re-apply them (count them in the digest so reconcile stops resending). (i) also makes lists
   converge. Either way, a freed slot doesn't readmit anyone; the person needs a new invite.
5. Notice: an Activity entry and a content-free push to admins when someone joins an app (owner
   decision: today there is none).

**Clients.** No change is needed for (a) or (d). If `/accept` gains an author signature, the
manual-approve finalize in the webapp, iOS and Android must sign it (gated by parity and vectors).
Optionally, the webapp's `redeemInvite` could refuse a 200 whose `boundAID` isn't its own.

**Migrations.** None needed for the fix above. If a counter column or table is chosen instead, the next
free number on `release/0.4` is **0161**, but `0.4/re-pair-fix` may take 0161 in parallel: check
before numbering.

## 6. Same "read count, then insert" pattern elsewhere

| Site | Cap | Impact of the race |
|---|---|---|
| `packages/storage/src/serverShares.ts:288-312` `putPush` | `SHARE_PUSH_CAP` 10 | a share holds a few more push tokens; Low |
| `packages/storage/src/serverShares.ts:337-355` `inboxPut` | `SHARE_INBOX_CAP` 200 | an inbox holds more entries (storage abuse by the signer); Low |
| `packages/control-plane/src/voiciNames.ts:341-370` | plan name limit 5/25/100, per-service and per-day change limits | the account's own signed orders can exceed its plan's name count; Low until paid tiers, then a billing bypass |
| `packages/control-plane/src/voiciPages.ts:486` | `VOICI_MAX_PENDING_DRAFTS` 200 | Low |
| `packages/control-plane/src/orgConnectors.ts:139-141` | `MAX_OPEN_PROPOSALS` 2000 | Low |
| `packages/control-plane/src/voiciMailbox.ts:344` | `VOICI_AWAITING_REPLY_CAP` 3 | a stranger gets a few more unanswered messages through; Low (anti-spam) |

These are already atomic: `boxClaims.ts:79-92` (the pattern to copy), voucher redeem `d1.ts:4176-4186`
(conditional UPDATE). Inheritance `MAX_HEIRS` is a length check on one request, with no race.

## Owner questions

1. Revoke the researcher's 3 still-live over-cap invites, or leave them to the account owner?
2. `/api/service-access/accept`: add an author signature (client work on three apps), or remove manual
   approval (0 manual invites in prod)?
3. Refused joins: a deterministic first N everywhere (recommended), or a local refusal record?
4. Should admins get a push or Activity entry when someone joins an app?
5. Credit: the researcher found (a)-(c). (d) and (e) came out of this investigation. Should they count
   toward the report's bounty, as part of F4?
