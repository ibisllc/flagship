# Share this server

Owner decision, 2026-10-13 (launch MVP item 7, `launch-mvp.md`). One account
is one person, so a household shares **servers** between accounts instead of
putting another person's phone on your account. This spec replaces story 2 of
`device-admin-tier-spec.md` D-4 ("owner adds another PERSON"): adding a
device is now only for your own devices, and the add-device copy points
other people here.

Words used below: **A** is the owner of server **S**; **B** is the account
A shares S with. "Sensitive key" is the box's sensitive-order authority
(`authorizeSensitiveOrder`, `adminAuthorityLocal.ts`): A's admin root when S
pins one, else A's IRK. On `.com` the same rule is `authorizeSensitiveComOp`.

## 1. What a share is

A share is one A-signed grant naming one of B's keys and a level:

| | Can view | Can manage |
|---|---|---|
| Server status, health, monitoring, update status | yes | yes |
| Apps list and app detail | yes | yes |
| Build with AI on staging, finish and go live | | yes |
| Accept an app update held for review | | yes |
| Edit an app's internet access list, answer its requests | | yes |
| **See app data** (opt-in): the Database section, read only | opt-in | opt-in |
| Change app data (signed statement in the Database console) | | opt-in |
| **Unlock at boot** (opt-in): approve S's start-up | opt-in | opt-in |

Always A's only, at every level: delete, wipe, transfer, replace, migrate,
power and lock, dead-man, front page, preferred server, endorsements and
server updates, custom domains, app uninstall, app copy, app API keys, app
env values, app members and app access mode, companions, paired devices,
peer backup, diagnostics/journal, and **who S is shared with**. Every
`device-admin-tier-spec.md` §2 sensitive row stays A's: they verify against
A's keys, which B never holds.

Either side can end a share at any time: A revokes, B leaves.

## 2. Threat model

| Adversary | What they could try | Defence |
|---|---|---|
| `.com` (curious, breached, rogue operator) | learn who shares with whom; insert itself as B; read the disk key | `.com` stores an opaque share id, a token hash and ciphertext. It never sees the link secret, B's account, A's name for B, or the level until A turns on unlock at boot. B's key toward S is pairwise. It cannot forge A's grant (box verifies A's sensitive key) nor B's signatures. Boot unlock material is sealed to B's pairwise key and to the box STK, never in clear. |
| Someone who sees the link before B opens it | accept the share in B's place | A confirms a 6-digit code that B's phone shows (SAS over the link secret and the accepting key) before signing the grant. A thief's acceptance shows a different code. One acceptance per link. |
| B, or B's stolen phone | do owner things on S | every route is level-gated on the box, default deny; owner-only routes verify A's keys; B's manage actions that need a signature verify B's pairwise key **chained to A's grant**. |
| B after the share ends | keep acting | the box tombstones the share id and drops B's sessions at once (A revokes on the box) or on the next poll of `.com` (≤5 min). A revoked share id can never be granted again. |
| A server owner (A, or any other owner B is shared with) | link B across servers or apps | B's key toward S is `HKDF(UMK_B, "flagship/server-share-member/v1|<shareId>")`: per share, so per server. B's account name, global AID and IRK never reach S. The activity log names B by A's label only. |
| An AI on S | learn who B is | B's label never enters a prompt; AI-facing text keeps going through `buildModelRedactor`. |

Residual risks, stated plainly:

- **Unlock at boot hands B the disk key during an approval.** B's phone opens
  its sealed copy to re-seal it for the box. Turning the opt-in off or ending
  the share deletes B's copy on `.com`, but a B who kept the plaintext could
  still open a disk image. The cut is complete only after a disk-key rotation,
  which no flow does yet (§10 Q3).
- **The box does not authenticate boot approvers** (true for A too today:
  `boot-core/gate.ts` is the authority, plus who can open the sealed key).
  B's approval is gated the same way: `.com` checks B's pairwise key against
  the A-signed unlock deposit.
- `.com` sees that A has shared S (the offer row names S and A), when, how
  often the link is read, and B's IP when B's app talks to it. It does not see
  who B is.
- The SAS loop defeats a leaked link only if A actually compares the code.

## 3. Keys and identity

All HKDF is SHA-256 with an empty salt; all AEAD is AES-256-GCM with a fresh
12-byte nonce, carried as lowercase hex `nonce || ciphertext+tag`.

| Name | Derivation | Who holds it |
|---|---|---|
| `shareId` | 16 random bytes, 32 lowercase hex | A mints it |
| link secret `k` | 32 random bytes | the link fragment only (A's devices keep it sealed in the owner record) |
| share token | `HKDF(k, "flagship/server-share/token/v1", 32)`; `.com` keeps `sha256hex(token)` | anyone with the link: reads the offer, posts one acceptance |
| link key | `HKDF(k, "flagship/server-share/link-key/v1", 32)` | seals the offer and the acceptance |
| member key (B's identity toward S) | Ed25519 seed `HKDF(UMK_B, "flagship/server-share-member/v1|<shareId>", 32)` | every device of B; S knows only its public half |
| inbox key | Ed25519 seed `HKDF(UMK_B, "flagship/share-inbox/v1", 32)`; inbox id = its public key, hex | B's devices (B's "Shared with me" list) |
| inbox seal key | `HKDF(UMK_B, "flagship/share-inbox-key/v1", 32)` | B's devices |
| owner record key | `deriveHouseholdKey(UMK_A)` | A's devices |

SAS (shown on both phones):
`n = uint32_be(sha256("flagship/server-share/sas/v1|<shareId>|<memberPubHex>|<kHex>")[0..4]) mod 1000000`,
six digits zero-padded, displayed `123 456`.

Why the member key is per share and not per owner (`deriveContactAccountId`
is per owner): the per-app identity rule (`AGENTS.md`) forbids a long-lived
id shared between contexts. A per-owner id would let A link B across A's own
servers. A per-share key is unlinkable everywhere, survives B's IRK rotations
and new devices (it comes from the UMK), and changes only with B's account.

## 4. Envelopes

Every envelope is the UTF-8 `|`-join of its fields, signed with Ed25519.
String fields reject `|` and control characters (`legacyFieldGuard`); hex
fields are lowercase; times are Unix ms, non-negative safe integers.
`test-vectors/server-share/vectors.json` is the cross-platform reference
(TS, webapp, Swift, Kotlin), including cases every builder must refuse.

| # | Tag | Canonical fields | Signer | Checked by |
|---|---|---|---|---|
| 1 | `flagship/server-share/v1` | `serverDomain\|shareId\|memberPubHex\|level\|unlockAtBoot\|seeAppData\|label\|issuedAt` | A's sensitive key | S |
| 2 | `flagship/server-share-revoke/v1` | `serverDomain\|shareId\|issuedAt` | A's sensitive key | S, `.com` |
| 3 | `flagship/server-share-accept/v1` | `serverDomain\|shareId\|memberPubHex\|acceptedAt` | B's member key | A's app, S |
| 4 | `flagship/server-share-leave/v1` | `serverDomain\|shareId\|memberPubHex\|issuedAt` | B's member key | S, `.com` |
| 5 | `flagship/server-share-session/v1` | `serverDomain\|shareId\|memberPubHex\|nonceHex\|issuedAt` | B's member key | S |
| 6 | `flagship/server-share-offer/v1` | `username\|serverDomain\|shareId\|tokenHash\|offerSha256\|ownerSha256\|expiresAt\|issuedAt` | A's sensitive key | `.com` |
| 7 | `flagship/server-share-list/v1` | `username\|issuedAt` | any of A's account keys (IRK, AID or admin root): it only reads ciphertext | `.com` |
| 8 | `flagship/server-share-unlock/v1` | `serverDomain\|shareId\|memberPubHex\|sealedSha256\|issuedAt` | A's sensitive key | `.com` |
| 9 | `flagship/share-inbox/v1` | `inboxPubHex\|op\|entryId\|ctSha256\|issuedAt` | B's inbox key | `.com` |

Field rules:

- `level` is `view` or `manage`. `unlockAtBoot` and `seeAppData` are `0` or `1`.
- `label` is A's name for B on S ("Sam"): 1–64 characters after trimming, no
  `|` or control characters. It reaches S (the activity log) and A's devices
  (sealed); never `.com`, never B.
- `shareId` is 32 hex; `memberPubHex`, `tokenHash`, `inboxPubHex` 64 hex;
  `nonceHex` 64 hex; `offerSha256`, `ownerSha256`, `sealedSha256`,
  `ctSha256` are SHA-256 hex of the hex string sent beside the envelope.
- `sealedSha256` is the literal `off` to withdraw B's boot copy.
- `op` is `put`, `list` or `delete`; `entryId` is 32 hex or empty for
  `list`; `ctSha256` is empty except for `put`.
- Distinct tags keep every signature single-purpose: an accept can't replay
  as a leave or a session, a grant can't replay as an unlock deposit.

A grant is replaced by a newer grant for the same `shareId` (higher
`issuedAt`, same `memberPubHex`): that is how A changes the level, the
opt-ins or the label. A revoke or leave ends the share id forever.

Sealed payloads (JSON inside AEAD; no canonical form needed):

| Payload | Key | AAD | Plaintext |
|---|---|---|---|
| offer | link key | `flagship/server-share/offer/v1\|<shareId>` | `{v:1, serverDomain, serverName, stkPubHex, level, unlockAtBoot, seeAppData, expiresAt}` |
| acceptance | link key | `flagship/server-share/acceptance/v1\|<shareId>` | `{v:1, accept:{serverDomain, shareId, memberPubHex, acceptedAt}, signature}` |
| owner record | household key (A) | `flagship/server-share/owner/v1\|<shareId>` | `{v:1, secretHex, label, level, unlockAtBoot, seeAppData}` |
| inbox entry | inbox seal key (B) | `flagship/share-inbox/entry/v1\|<entryId>` | `{v:1, shareId, secretHex, serverDomain, serverName, acceptedAt}` |
| boot copy | `sealForEd25519Recipient(diskKey, memberPub)` | (seal tag) | the LUKS key bytes |

## 5. Flows

### 5.1 Share (A) and accept (B)

```
A's phone                        .com                          B's phone                 S
 pick label, level, opt-ins
 mint shareId, k
 offer  = AEAD(link key, …)
 owner  = AEAD(household, …)
 sign #6 ───────────────────▶ POST /api/users/A/server-shares
                              (row: id, A, S, tokenHash, offer, owner)
 show link + QR  https://flagshipserver.com/share#s=<shareId>&k=<kHex>
                                   ◀──── GET /api/server-shares/<id>  (x-flagship-share-token)
                                                             open offer, show "A's server S, Can view"
                                                             derive member key, sign #3
                                   ◀──── POST …/<id>/accept {acceptance (sealed)}  first write wins
                                                             put inbox entry (#9)
                                                             show SAS
 list (#7) ────────────────▶ POST /api/users/A/server-shares/list
 open owner record → k, open acceptance, verify #3
 show SAS "Does Sam's phone show 123 456?"
 Face ID/biometric → sign #1 (+ #8 if unlock) ─────────────────────────────────────────▶ POST /api/screens/shares
                                                                                          {grant, signature, accept, acceptSignature}
                                                             GET /api/shares/nonce ─────▶
                                                             sign #5 ─ POST /api/shares/session ─▶ token (12 h)
```

- The offer lives 7 days; after that `.com` refuses reads and the acceptance.
- A can finalize from any of A's devices: the owner record carries `k`.
- If S is offline, A's app keeps the share as "Waiting for S" and retries
  when the server page next loads. A share needs S reachable to start.
- B's other devices find the share in B's inbox, re-derive the member key,
  and sign in the same way.
- A link opened in a browser lands on the webapp (`/share` is served like
  `/transfer`), which runs the same flow when B is signed in there.

### 5.2 Using S as B

B's apps reach S at its normal address with `x-flagship-session: <share token>`.
The box looks up the share live on every request, so a level change or a
revoke applies at once. Signed actions B takes at manage level are the same
envelopes A signs (`flagship/app-access/v1`, `flagship/app-db-write/v1`),
signed with B's member key. The box accepts them only from a share session
whose grant allows it, verifies them against that session's member key, and
stores B's signature together with A's grant so the chain re-verifies after a
restart even if the share later ends.

### 5.3 Ending a share

- **A revokes:** sign #2. A's app posts it to S (`POST /api/screens/shares/revoke`)
  and to `.com` (`POST /api/users/A/server-shares/<id>/revoke`), which ends
  the row and deletes B's boot copy.
- **B leaves:** sign #4. B's app posts it to S (`POST /api/shares/leave`) and
  to `.com` (`POST /api/server-shares/<id>/leave`), and deletes the inbox entry.
- S polls `GET /api/server/<S>/share-ends?since=` every 5 minutes, verifies
  each revoke against A's sensitive key and each leave against the held
  grant's member key, and tombstones the share id. Either path alone is
  enough; S offline at the time catches up on its next poll.
- B's app sees the end as a 403 `share-ended` from S and as `ended` on `.com`,
  and removes S from "Shared with me".

### 5.4 Unlock at boot (opt-in)

Today an approval works because the phone can open `sealed_luks_keys` (sealed
to A's IRK) and re-seal it for the box STK, and `.com`'s boot gate lets only
A's IRK (or A's watch delegate) post the reply. For B:

1. **A turns it on** (at share time or later). A's phone fetches the sealed
   disk key (`GET /api/server/<S>/sealed-luks-key`), opens it with A's key,
   seals it to B's member key (`sealForEd25519Recipient`), and signs #8 over
   `sha256(sealedHex)`. `POST /api/users/A/server-shares/<id>/unlock` stores
   `{memberPub, sealed, deposit, signature}` after `authorizeSensitiveComOp`.
   The grant's `unlockAtBoot` bit is also set, so S and B's app agree.
2. **S asks to start** exactly as today (`/api/boot/request`); A's devices are
   pushed as today.
3. **B's app** (the shared server's card or page, polled while open) calls the
   boot gate with a new role `share`, signed by the member key:
   `GET /api/boot/share/pending/<S>` lists pending `unlock-key` requests and
   `GET /api/boot/share/key/<S>` returns B's sealed copy. B's phone checks the
   request's STK signature against the **STK pinned in the offer** (A put it
   there; `.com` can't change it), shows "S is starting. Unlock it?", and on
   biometric opens its copy and re-seals it for the STK
   (`buildSealedSecretResponse`), then `POST /api/boot/response` with role
   `share`.
4. **The gate** accepts role `share` for S only when the signer equals the
   member key of an unlock deposit for S whose share has not ended.
5. **Off:** A signs #8 with `sealedSha256 = off`; ending the share deletes the
   copy too. No push reaches B (a push token would link B's account to the
   share at `.com`); B sees pending start-ups when B's app is open (§10 Q1).

### 5.5 See app data (opt-in)

With `seeAppData = 1`, the Database section's reads (`GET …/db`, tables,
CSV export, read-only `POST …/query`) work over B's session. A statement that
changes data needs manage level **and** the opt-in, plus B's member-key
signature over `flagship/app-db-write/v1`. Without the opt-in every database
route answers 403 `app-data-not-shared`.

## 6. Route map

### 6.1 Box (daemon)

A share session can reach only the routes listed as `view` or `manage`; any
other route returns 403 `owner-only` (default deny; share tokens live in their
own store, so every handler gated by `pairedSessions.check` refuses them
automatically). `data` means the see-app-data opt-in. Companion sessions are
unchanged.

| Route | Level |
|---|---|
| `GET /api/shares/nonce`, `POST /api/shares/session`, `POST /api/shares/leave` | public (signature is the auth) |
| `GET /api/shares/me` | view |
| `GET /api/screens/server-detail`, `apps-list`, `app-detail/:id`, `server-metrics/:podId`, `release-status`, `updates`, `peer-backup/status`, `lan-hint` | view |
| `GET /api/screens/access-requests`, `GET /api/screens/services/:id/access`, `GET …/egress` | manage |
| `POST /api/screens/services/:id/access` (B-signed `app-access/v1`), `POST …/access/dismiss`, `POST …/access/draft/dismiss` | manage |
| `POST /api/screens/vibe-code/start`, `GET /api/screens/vibe-code/name-check`, `GET /api/screens/vibe-code/:id`, WS `/api/screens/vibe-code/:id/stream` | manage |
| `GET /api/screens/llm/sessions/:id`, `POST /api/screens/llm/sessions/:id/reply` | manage |
| `GET /api/screens/lineage-resolve`; `POST` with `decision: accept` | manage |
| `POST /api/screens/lineage-resolve` with `decision: revoke` (uninstalls) | owner |
| `GET /api/screens/services/:id/env` (names only), `GET /api/screens/browser-tabs/list/:id`, WS `/api/screens/events` | manage |
| `GET /api/screens/services/:id/db`, `…/db/:store/tables/:t`, `…/export.csv`, read-only `POST …/query` | view + data |
| `POST …/query` with a B-signed `app-db-write/v1` | manage + data |
| `GET/POST /api/screens/shares`, `POST /api/screens/shares/revoke`, `GET /api/screens/activity` | owner |
| Everything else under `/api/screens/*` (companion, paired sessions, url-controller, api-keys, copy, env set/unset, app-invite, peer-backup toggle, app-backup, orders/send, install-events, post-recovery, adapter-report, `POST …/egress`) | owner |
| `/api/build/*`, `/mcp/build/*`, `/api/llm/sessions*` (IDE and legacy builds) | owner (v1; §10 Q4) |
| `/api/power`, `/api/deadman/*`, `POST /api/front-page`, `/api/journal`, `/api/service-access*`, `/api/service-certs/*`, `/api/services*`, `/api/orders-from-user`, `/api/identity/pending`, `/api/phone/alerts*` | owner (A-signed or owner session) |

New box routes:

| Route | Body → answer |
|---|---|
| `GET /api/shares/nonce` | `{nonce}` (single use, 2 min) |
| `POST /api/shares/session` | `{session, signature}` → `{token, expiresAt, level, unlockAtBoot, seeAppData}`; 403 `not-shared` / `share-ended` |
| `GET /api/shares/me` | → `{shareId, level, unlockAtBoot, seeAppData, serverDomain}` |
| `POST /api/shares/leave` | `{leave, signature}` → `{ok}` |
| `GET /api/screens/shares` | → `{shares:[{shareId, label, level, unlockAtBoot, seeAppData, memberPubHex, issuedAt, sharedAt, lastSeenAt}], ended:[{shareId, label, endedAt, reason}]}` (`memberPubHex` lets A re-sign a change) |
| `POST /api/screens/shares` | `{grant, signature, accept?, acceptSignature?}` → `{ok, share}`; the first grant for an id must carry B's acceptance |
| `POST /api/screens/shares/revoke` | `{revoke, signature}` → `{ok}` |
| `GET /api/screens/activity?limit=` | → `{entries:[{ts, actor:{kind:"owner"} \| {kind:"share", shareId, label}, action, target?, ok}]}` |

### 6.2 `.com`

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/users/:u/server-shares` | #6, sensitive (`authorizeSensitiveComOp`); S must be `:u`'s, live | create the offer row |
| `POST /api/users/:u/server-shares/list` | #7, any of A's account keys | A's rows with acceptances (sealed) |
| `POST /api/users/:u/server-shares/:id/revoke` | #2, sensitive | end the row, keep the signed revoke, drop B's boot copy |
| `POST /api/users/:u/server-shares/:id/unlock` | #8, sensitive | put or withdraw B's boot copy |
| `GET /api/server-shares/:id` | share token | offer, sealed acceptance, state, `unlock` flag |
| `POST /api/server-shares/:id/accept` | share token | first acceptance wins (409 after) |
| `POST /api/server-shares/:id/leave` | share token + #4 | end the row, drop B's boot copy |
| `GET /api/server/:domain/share-ends?since=` | none (signed envelopes; box verifies) | revokes and leaves for S |
| `POST /api/share-inbox` | #9 | B's "Shared with me" entries: put / list / delete |
| `GET /api/boot/share/pending/:domain`, `GET /api/boot/share/key/:domain`, `POST /api/boot/response` | boot gate role `share` | §5.4 |

Every other `.com` account route stays A's: each verifies A's own keys.

D1 migration **0087_server_shares.sql**: `server_shares` (id, owner, server,
token hash, sealed offer/owner/acceptance, state, end envelope, times),
`server_share_unlocks` (share id, server, member pub, sealed copy, signed
deposit), `share_inbox` (inbox id, entry id, ciphertext, time). `.com` stores
no label, no level (except through the unlock deposit's existence), and no
B account.

## 7. Activity log

S keeps `<dataDir>/activity.jsonl` (mode 0600, newest 2000 entries). Every
write a session makes under `/api/screens/*` and `/api/shares/*`, every share
sign-in, grant, change, revoke and leave appends
`{ts, actor, action, target?, ok}`. `actor` is `{kind:"owner"}` or
`{kind:"share", shareId, label}`; `action` is a stable id from the route map
(`ai.start`, `app.access.edit`, `app.update.accept`, `db.write`,
`share.signed-in`, `share.granted`, `share.changed`, `share.revoked`,
`share.left`, …); `target` is a service id where there is one. Reads aren't
logged. Bodies, SQL, prompts and tokens never are. Only A reads the log
(`GET /api/screens/activity`), on S's page.

## 8. UI

**A, on S's page:** a **Shared with** card, placed after Preferred server
(clear of Monitoring and the Danger zone). It lists each person by label with
their level, the two opt-ins and "Remove". **Share this server** opens:
label → level (Can view / Can manage, with one line each) → the two
opt-ins, off, each with its consequence → link + QR + Share sheet. Once B
accepts: "Sam's phone shows 123 456?" → Confirm (biometric) → active.
Changing level or an opt-in re-signs the grant. An **Activity** card shows the
log, B's actions under B's label.

**B:** the link opens "A shared a server with you: *S* · Can view" →
Accept → the 6-digit code to read to A → "Waiting for the owner to confirm" →
done. The home list gains a **Shared with me** section under the servers.
B's server page shows only what B's level allows (destructive sections are
absent, not disabled): status, monitoring, apps; at manage, the AI builder
entry, update reviews and access lists; with app data, the Database section;
with unlock at boot, a start-up approval card when S waits. At the bottom,
**Leave**.

**Add a device** (all three apps) says it is for your own phones and tablets,
and points to Share this server for other people.

## 9. Client contract (all three apps)

`apex` is the control origin (`https://flagshipserver.com` in production),
`boot` the boot host (`https://boot.flagshipserver.com`), `box` the server
(`https://<serverDomain>`). Box calls use `x-flagship-session` as today:
A's paired-session token, or B's share token (`fss_…`).

**A shares** (server page → Share this server):
1. Pick label, level, unlock at boot, see app data. Mint `shareId`, `k`.
2. `offerHex = seal(linkKey(k), "offer"|shareId, {v:1, serverDomain, serverName, stkPubHex, level, unlockAtBoot, seeAppData, expiresAt: now+7d})`;
   `stkPubHex` is the server's `identityPubKey` from `/api/users/:u/pods`.
3. `ownerHex = seal(householdKey, "owner"|shareId, {v:1, secretHex:k, label, level, unlockAtBoot, seeAppData})`.
4. Sign #6 with the sensitive key (biometric) and
   `POST apex/api/users/:u/server-shares {offer, signature, offerHex, ownerHex}`.
5. Show `https://flagshipserver.com/share#s=<shareId>&k=<kHex>` as text, QR and share sheet.

**A's "Shared with" card** (loads with the page):
1. `GET box/api/screens/shares` → `{shares, ended}` (the truth for who has access).
2. Sign #7 with any account key; `POST apex/api/users/:u/server-shares/list {list, signature}`
   → `{shares:[{shareId, serverDomain, state, owner, acceptance, …, unlock}]}`.
   Keep rows for this server. Open `owner` (household key) → `k`, label, level, opt-ins.
3. A row `accepted` whose id isn't active on the box: open `acceptance` with
   `linkKey(k)`, check `accept` names this server and share, verify its
   signature with `accept.memberPubHex`, show "**<label>** accepted. Does their
   phone show **123 456**?" (`shareSas`). Confirm → sign #1 (sensitive key,
   biometric) → `POST box/api/screens/shares {grant, signature, accept, acceptSignature}`;
   then, if unlock at boot, deposit (below).
4. A row `offered`: "Waiting for <label> to open the link" with Copy link and Cancel.
5. An active share: level and the two opt-ins are editable (a new #1, same
   share id and key, later `issuedAt`; no acceptance needed). Remove → #2 →
   `POST box/api/screens/shares/revoke {revoke, signature}` and
   `POST apex/api/users/:u/server-shares/:id/revoke {revoke, signature}` (a 404 there is fine).
   Cancel of a pending offer is the `.com` revoke only.
6. **Unlock deposit:** `GET apex/api/server/<S>/sealed-luks-key`, open it with A's key
   exactly as boot approval does, `sealed = sealForEd25519Recipient(diskKey, memberPub)`,
   sign #8 over `sha256hex(sealedHex)` → `POST apex/api/users/:u/server-shares/:id/unlock {unlock, signature, sealedKey}`.
   Off: #8 with `sealedSha256: "off"` and no `sealedKey`.
7. An **Activity** card: `GET box/api/screens/activity?limit=50` → entries; a share's
   lines read "<label> · <action>".

**B accepts** (link, QR scan, or paste):
1. Parse the link; `token = shareTokenFromSecret(k)`.
2. `GET apex/api/server-shares/:id` with `x-flagship-share-token: token`
   → `{serverDomain, state, offer, …}`; open `offer`. 404 = bad link, 410 = an unaccepted link that expired; `state: "ended"` = the share is over.
3. Accept → `member = deriveShareMemberKey(UMK, shareId)`; sign #3; seal
   `{v:1, accept, signature}` with `linkKey(k)`, AAD "acceptance"|shareId;
   `POST apex/api/server-shares/:id/accept {acceptance}` (409 = someone else used the link).
4. Save to the inbox: random `entryId`; `ct = seal(inboxSealKey, "entry"|entryId, {v:1, shareId, secretHex, serverDomain, serverName, acceptedAt})`;
   sign #9 `put` with the inbox key; `POST apex/api/share-inbox {request, signature, ct}`.
5. Show the SAS and "Read this code to the owner", then try to sign in until it works.

**B signs in to S:** `GET box/api/shares/nonce` → sign #5 → `POST box/api/shares/session {session, signature}`
→ `{token, expiresAt, level, unlockAtBoot, seeAppData}`. `403 not-shared` = the
owner hasn't confirmed yet; `403 share-ended` = gone. Re-sign-in on a 401.

**B's "Shared with me":** sign #9 `list` → entries → open each. For each, sign
in (above) to learn the level; on `share-ended` (or `.com` state `ended`)
delete the inbox entry (#9 `delete`) and drop it.

**B's server page:** `GET box/api/shares/me`, `server-detail`, `apps-list`,
`server-metrics/:podId`; at manage the access lists (B signs `app-access/v1`
with the member key) and the AI builder; with app data the Database section;
**Leave** → #4 → `POST box/api/shares/leave {leave, signature}` and
`POST apex/api/server-shares/:id/leave {leave, signature}` (share token header),
then delete the inbox entry.

**B approves a start-up** (unlock at boot on, the server's card says it's waiting):
the boot gate header is the usual `Authorization: Flagship-Boot-v1 <b64url JSON>` with
`role: "share"`, signed by the member key over
`flagship/boot-auth/v1|share|<S>|<METHOD>|<path>|<memberPubHex>|<nonceHex>|<issuedAt>`.
`GET boot/api/boot/share/pending/<S>` → `{requests:[{request:{serverDomain, stkPub, purpose, nonce, issuedAt}, signature}]}`;
check `stkPub` equals the offer's `stkPubHex` and the request signature;
`GET boot/api/boot/share/key/<S>` → `{sealedKey}`; open it with the member key,
`buildSealedSecretResponse(diskKey, request)`, and
`POST boot/api/boot/response {response:{serverDomain, requestNonceHex, purpose:"unlock-key", sealed, issuedAt}}`.

## 10. Open questions for the owner

1. **Push for B's boot approvals.** v1 sends none (a push token would let
   `.com` link B's account to the share). Option: an opt-in "notify me" that
   accepts that link.
2. **Should B see S's activity log**, or only their own lines? v1: only A.
3. **Disk-key rotation** to make ending an unlock share complete (§2).
4. **IDE and git builds** (`/api/build/*`, MCP keys) for manage level: v1
   keeps them A's because they hand out a long-lived MCP key.
5. **Apps on S** don't learn about shares: B visiting S's apps is a visitor
   like any other (Members only still needs an app invite).
