# Service access gating — open/restricted + capability invite links

> Owner-designed (2026-06-18). Lets a service admin gate each service **open-to-all**
> or **restricted**; if restricted, manage an allow-list of people via **bearer invite
> links** that bind to the redeemer's stable account key. Identity is anchored to the
> **UMK**, NOT the IRK — see below. See `gym-proof-ledger.md` for the gym test status.

## Identity / stability — anchor to the UMK, not the IRK
**Verified in code:** the IRK is VERSIONED (`flagship/irk/v<N>`, `currentIrkVersion`) and
ROTATES — re-pair / Wipe & restart / device-takeover all derive a NEW IRK from the SAME,
still-shared UMK (`RecoveryChoice`: "Derives a new IRK from the (still shared) UMK"). So
the IRK is a rotatable *signing/device* key, NOT a stable identity. The **UMK** is the
account root: preserved through recovery, replaced only by a brand-new account.

Therefore identity is a **stable Account Identity Key (AID)**:
- `AID = deriveAccountId(UMK)` — a NON-rotating Ed25519 keypair from the UMK under a FIXED
  HKDF info (e.g. `flagship/account-id/v1`), distinct from the versioned IRK. New primitive,
  trivially derived from the existing UMK; survives IRK rotations; resets only on a new UMK.
- The **AID pubkey** is the public, stable identifier used in allow-lists, invite bindings,
  and author/friend attribution. (The IRK stays the signing key for active orders.)

Key usage (the owner's asymmetry):
- **Authorizing device → UMK + IRK:** UMK gives the author's **AID** + the household
  encryption key for the bundle; the **IRK signs** create/revoke (active orders by the
  *current device* key — a compromised device's orders die when its IRK rotates).
- **Authorized device → UMK:** the friend is identified by their **AID** and proves control
  by signing the redeem + visits with the AID (UMK-derived, stable). Access follows the UMK.

## Invite id + the packet (on `.com`)
- `inviteId = hash(AID_author) · hash(devicePub_author) · counter` — unique, attributable to
  the author account + creating device, monotonic. Used for revocation + the who-authorized
  -whom graph.
- New `.com` store `service_invites` (D1): `{ inviteId, authorAID, serviceRef, encryptedBundle,
  secretHash, boundAID (NULL until redeemed → friend AID pub), boundAt, createdAt, revokedAt }`.
  Indexed by `secretHash` (redeem), `inviteId` (revoke), `authorAID` (list).
- `secret` = random 32B capability in the link; `.com` stores only `secretHash`.
- `encryptedBundle` = AEAD({ name, photo? }) under a **household key** only the author's
  sibling devices + servers hold (UMK-derived, provisioned to the boxes over their pinned
  pipe). `.com` stores ciphertext only — it cannot read the friend's name/photo.

## Flows
1. **Create invite (admin phone):** pick name(+photo) → mint `inviteId` + `secret` → AEAD the
   bundle under the household key → **IRK-sign** the create envelope (carries `authorAID`) →
   `POST .com /api/service-invites` → build link `https://<server>.<user>/invite#<secret>`.
2. **Redeem (friend, first visit to ANY of the author's boxes):** the box gets the secret +
   the visitor's **AID** (the friend signs the redeem with their AID) → `POST .com
   /api/service-invites/redeem { secret, visitorAID, aidSig }` → `.com` FIRST-redeem binds
   `boundAID = visitorAID`, records author→friend, returns the binding + serviceRef → the box
   adds `visitorAID` to the service's allow-list.
   - Re-redeem after an IRK rotation / new device: SAME AID ⇒ idempotent (the UMK, hence the
     AID, is unchanged — that's the whole point). A DIFFERENT AID ⇒ 409 "already bound".
3. **Cross-app reuse:** the author now knows friend→AID, so adding them to another service is
   a pure allow-list write (no new link).
4. **Enforce (box):** per-service `access.mode ∈ {open, restricted}`. open ⇒ anyone;
   restricted ⇒ the visitor must present an **AID-signed** proof whose AID ∈ the service's
   bound allow-list (else deny). Allow-list = the `boundAID`s for that service.
5. **Revoke:** admin (IRK-signed) `POST .com /api/service-invites/revoke {inviteId}` or
   remove-from-allow-list → daemon prunes the AID → friend's next visit denied.

## Build order
1. **Backend (this worker):** protocol (`deriveAccountId(UMK)` → AID; `inviteId`; AEAD bundle;
   IRK-signed create/revoke + AID-signed redeem canonical bytes, `flagship/service-invite/v1`),
   `.com` `service_invites` store + handlers (create/redeem/revoke/list; first-bind + same-AID
   idempotent + reject-different-AID), daemon redeem endpoint + per-service `access.mode` +
   AID allow-list enforcement on the serve path + the household-key bundle decrypt. Tests.
2. **Clients:** admin UI (toggle + allow-list: add = name/photo/invite-link, remove = revoke)
   on iOS/Android/webapp; the friend deep-link that redeems (AID-signed). Mirror membership UI.
3. **Gym test:** admin restrict + invite → a second sim/context (friend) opens the link →
   redeems (AID) → reaches the restricted service → admin revokes → denied. Plus cross-app
   reuse + a "rotate the friend's IRK, access still honored (AID unchanged)" assertion.

## Daemon HTTP surface (built — `packages/server-daemon/src/serviceAccess.ts`)
- `POST /api/service-access` — owner-IRK `set-service-access-mode` envelope (open/restricted).
- `GET  /api/service-access/<serviceRef>` — access-state read: `{ serviceRef, mode, allowCount }`.
  **Unauthenticated** (mirrors `GET /api/front-page`): the mode is already behaviorally
  observable (a restricted service 403s anonymous traffic), so it's not a secret — and ONLY the
  integer `allowCount` is exposed, NEVER the allow-listed AIDs (those are the friend graph). Lets
  iOS/Android/webapp render the TRUE toggle without a signature on a plain refresh.
- `POST /api/service-invites/redeem` — friend AID-signed redeem → `.com` binding → allow-list add.
  On success, **also issues a `Flagship-App-Session` cookie** bound to the redeemer's AID + this
  service (when the cookie seam is enabled).
- `POST /api/service-access/establish-session` — a friend who already redeemed presents the SAME
  AID-signed `ServiceVisitProof` the `x-flagship-visit` header carries (base64 body); the box mints
  the cookie. 401 if the AID isn't allow-listed for that (restricted) service; 403 on a bad proof.
- **Browser cookie seam.** A plain BROWSER can't set the AID-signed `x-flagship-visit` header, so a
  restricted service's WEBSITE is unreachable from one — closed by an opaque `Flagship-App-Session`
  cookie (the SAME bearer-cookie shape as the older #84 `serviceAccessGate.ts`: a random token
  looked up server-side, **NOT a new MAC**), `HttpOnly; Secure; SameSite=Lax; Path=/`, default 12h,
  persisted box-local (`ServiceSessionStore`, atomic mode-0600 JSON, restart-survivable). The
  serve-path `decide` accepts **cookie OR header**: either must resolve to an AID STILL in the
  allow-list (a `.com` revoke that prunes the AID kills the cookie too — re-checked per request).
  `open` is unchanged (decide short-circuits before reading any cookie). Client follow-up: the
  friend's webapp should call `establish-session` (browser-driven, signed from the in-page UMK→AID)
  so the `Set-Cookie` lands in that browser.

## Open mode + members (owner, 2026-10-13)

The app page's **Access control** screen: a toggle **Open to all | Members only**
and, below it in both modes, **Members (n)**: people (name, role) and groups
(label, role, "k of N joined"), with **+ Add person** and **+ Add group** (the
role is chosen at creation). The toggle never changes the list.

- **Open to all:** anyone gets in. Someone who hasn't signed in is an anonymous
  visitor with **no rank** (owner decision 2026-10-14): the box forwards their
  requests to the app with `X-Flagship-Visitor: anonymous` and no
  `X-Flagship-User` / `X-Flagship-Role` (docs/app-apis.md §5, the header
  contract) on every path, method and WebSocket upgrade, and the app decides
  what an anonymous visitor may do (`access.public_routes` changes nothing). A
  member who signs in with their phone gets their rank.
- **Members only:** only members (the account's devices and co-managers count, see below) get in; anyone else gets the
  knock page, except on the paths the manifest declares in
  `access.public_routes` (a landing page, a webhook another service calls),
  which are forwarded marked anonymous. Switching to it asks once: "Only these N
  people will be able to open it."
- **Unknown mode:** if the box can't read its access state, every app is
  members-only (fail closed). Decision table and path matching:
  docs/app-apis.md §2.
- **The account's devices and co-managers** have default ranks (below).
- **Removing someone:** on an open app they lose their role and visit
  anonymously; on a members-only app they are signed out and kept out.

**Ranks** (owner, final 2026-10-13; `owner` removed 2026-10-15) are Flagship's,
never app-defined: three ordered, cumulative ranks.

| rank (wire) | shown as | notes |
|---|---|---|
| `member` | Member | the base rank; must still be able to use the app (in a game, save games) |
| `manager` | Manager | Member + more |
| `master` | Master 👑 | Manager + more; shown with a crown in all three apps; admin devices by default |

What each rank may do is the app's call: the manifest's
`access.role_descriptions` gives one line per rank (written by the AI for
every app it builds), shown in the rank picker, and the app enforces it. The
box only delivers identity and rank honestly (`X-Flagship-Role`); it never
blocks a request by rank. The manifest's `default_role` is the rank of a grant
the owner gave none (older names map: viewer → member, editor → manager,
admin/owner → master); its `custom_roles` are ignored for members. Each client
keeps the display names in one place (webapp `lib/memberRoles.js`, iOS
`AppMemberRole`, Android `AppMemberRole`).

**Grants.** Every redemption of an invite is its own grant, with its own role
(its own, else the invite's, else the app's default; Member for an invite a non-admin made, see "Account members") and revocation: a group
link's joins are separate per-person bindings. A person can hold several
grants for one app (a personal invite and group links all bind their
per-author contact AID). Their role is the **highest** of their live grants (an `aid:` order on them replaces it);
revoking one leaves the others, and only someone left with no grant stops
being a member. The box keeps the grants in the service's allow-list state
(`groups`: inviteId → AIDs, personal invites included) and the roles beside
them (`roles.grants` per join, `roles.invites` per invite, `roles.aids` for
members who joined before personal invites were tracked).

**Signed orders.** A rank change is `flagship/app-rank/v1` (see "Account
members": `target` = `invite:<inviteId>`, `grant:<inviteId>/<aid>` for one
join, `aid:<hex>`, or an account device / co-manager), signed by the
admin-only key and verified by the box (`memberRoles.ts`:
`GET /api/screens/services/:id/members`, `POST …/members/rank`), at most 10
minutes old and newer than the last order for that target. Its server-named
predecessor `flagship/app-member-role/v1` is retired.
Mode changes and removals are admin-only orders (see "Account members"). Clients send the
invite's role right after creating it, and skip that when it is the default.
Removing a person prunes their AID on the box only when that was their last
grant; otherwise the box drops just that grant when its revocation poller sees
the `.com` revoke.

**Signing in on an open app.** The box serves `/__flagship/sign-in?next=<path>`
and `/__flagship/sign-out?next=<path>` on every app's own host: sign-in shows
the knock page (or goes straight back when already signed in), and after the
phone approves, the browser returns to `next` (a same-origin path). Apps link
there; private routes still show the knock page themselves.

**Not built yet:** removing one person's join from a group link on its own
(an order naming a single grant for revocation; today a person is removed from
the box entirely, or a whole invite is revoked). Anonymous visitors are never
given a rank (decided 2026-10-14, above).

## Account members, ranks and who may change them (owner decision, 2026-10-15)

This replaces "Who can invite" (same day): its admin-only rules were a
client rule, and every device of the account looked like the owner to the
box (they all signed in with the one account AID). Now the box knows each
device, gives everyone a rank by default, and enforces who may change what.

### Ranks and defaults

Exactly three ranks, `member` < `manager` < `master`. There is no `owner`
rank in apps: the box never sends one, and a stored or legacy `owner` reads
as `master`. Every app on the box gives, with no invite:

| who (class on the box) | default rank |
|---|---|
| an **admin device** of the account that owns the box | `master` |
| any **other device** of that account | `manager` |
| a device of an account that **co-manages** this server (`share-a-server.md`; never an admin) | `manager` |
| a person invited by a non-admin device | `member` |
| a person invited by an admin | the rank the admin chose (`member` unless set) |

An admin may sign an order that changes any of these for one app, up or
down, or refuses a device or co-manager outright. An explicit order on a
target **replaces** its default (demotion works; it is not "highest of"). An
invited person's own (`aid:`) order also replaces their grants' ranks;
without one, a person holding several grants has the highest.

"Manager-class" means an effective rank of `manager` or `master` in that app.

### Who is signing in (the box verifies it)

A sign-in (knock authorization, visit proof, establish-session) is signed by
one key, and the box classifies that key itself:

1. **An account device.** The device signs with its own **account device
   key** (`deriveAccountDeviceKeySeed(UMK, accountId, deviceId)`, the key it
   already keeps for directory requests and read tokens). The box holds the
   account's **device book**: every active `DeviceCapabilityGrant` of the
   account, fetched from `.com` (`GET /api/users/<u>/device-grants` with the
   box's STK read token) and **verified on the box**. A grant signed by the
   pinned admin root with the `admin` scope makes an admin device; one signed
   by the owner IRK (or by the admin root without `admin`) a non-admin
   device. The book is refreshed every 5 minutes, and at once (at most every
   30 s) when an unknown key signs, and kept on disk so a restart works
   offline. A box with no admin root pinned treats every device as admin (the
   owner key is the authority there, as before).
2. **A co-manager.** Their device signs with the share's member key
   (`share-a-server.md` §3); the box finds the active share holding it.
3. **An invited person.** Their per-app id, on the app's allow-list, as
   before.
4. Anyone else is not let in (members-only) or is anonymous (open).

The account's legacy AID still signs in from older apps: it counts as a
non-admin device (`manager` by default) on an admin-pinned box, as admin on
an unpinned one.

The app sees the rank in `X-Flagship-Role`. Its user id (`X-Flagship-User`)
for every device of the owning account is the one id of the owner AID (one
person, many devices); a co-manager's comes from the share key, an invited
person's from their per-app id. All are per app (`stableIdFor`).

Why the device grants are the source: they are the only per-device list the
box can verify without trusting `.com` (they are signed by keys the box
pins), every device already has one (account creation signs the first
device's with the admin root; adding a device signs the new one's with the
admin root or the IRK), and the admin line in them is exactly the admin
root's. A grant's `expiresAt` is a refresh horizon here, not an authority
horizon (device-admin-tier-spec §4.1); a revocation reaches the box when
`.com` stops listing the grant (a hidden revocation is the poll-window
residual of §5.4 there). Residual, stated plainly: the account device key is
UMK-derived, so any device of the account (they all hold the UMK) could
compute another device's key. Admin versus non-admin is cryptographic (the
admin root never leaves admin devices); one non-admin device's rank versus
another's is enforced against the apps, not against a hostile device of the
same person.

**Privacy.** A device presents its account device key only to the account's
own servers, and a share member key only to the server it shares; on anyone
else's box it signs with `deriveAppAccountId` exactly as before. The box
learns device ids and public keys from `.com`, never names, and sends
nothing about devices back. The clients resolve device names from the
decrypted account directory on the device.

### What each class may do (box-enforced)

| | admin device | non-admin device, manager-class in the app | below manager, or refused |
|---|---|---|---|
| create an invite | yes, any rank (admin root) | yes, always at Member (its own device key) | no |
| withdraw an invite | any | only invites **it** created; that removes the people who joined through them | no |
| change a rank, refuse a device or co-manager | yes (`flagship/app-rank/v1`) | no | no |
| open / members-only, remove a person, revoke anyone else's access | yes | no | no |
| uninstall or delete the app | yes | no | no |

Co-managers, and guests an admin raised to Manager, are manager-class for
the app (it gets the rank) but get no invite rights (owner-approved):
`.com` can't tie their keys to the owner's account without learning who
shares with whom.

- **Invites.** An admin signs the create with the admin root (or an admin
  device's key); a non-admin device signs it with its account device key and
  names its `deviceId`. `.com` verifies the signature under that device's
  registered key, so `creator_device_id` is proven by the signature, not just
  named; on an admin-pinned account the AID and IRK no longer create invites.
  The box verifies the create itself on redeem and manual accept (admin root,
  an admin device, or a device in its book; `.com`'s `creatorPubHex` is only a
  hint), records the creator key per invite (`roles.creators`, sticky like
  `roles.tiers`), and lets the person in only while the creator is still
  manager-class there. A creator demoted below manager, or refused, has
  their still-open links stop letting **new** people in (403, owner-approved
  default); people already in stay until an admin removes them.
- **Withdraw.** A revoke (`flagship/service-invite/revoke/v1`) verifies on
  `.com` under the admin gate, or under the creator device key while that
  device is active; `.com` now keeps the signed revoke (migration 0102) and
  serves it on `revoked-since`. The box prunes an invite's people only for a
  revoke it verifies itself: the sensitive-order key, or the invite's
  recorded creator key while that device is still manager-class in the app.
  Devices also post the revoke straight to the box
  (`POST /api/service-access/invite-withdraw {revoke, signature}`) so it
  applies at once; the poll is the backstop. A revoke row without a signature
  no longer prunes anyone.
- **Admin-only orders**, all under the box's sensitive-order key (the admin
  root, or a device with an admin-root-signed `admin` grant from the book; the
  IRK only on a box with no admin root): rank orders, mode changes
  (`flagship/service-access-mode/v2`, and v1), allow-list removals
  (`flagship/service-allow-remove/v2`, and v1), and app uninstall (the box's
  own identity still uninstalls for box-internal flows).

### Orders

They name the app (its `serviceRef`, the same on every server of the
account), not one server, so one order holds on every server that runs the
app ("One list per app", below). A per-target sequence (an order's `issuedAt` must
be newer than the last one applied to that target: latest order wins) stops
replays, together with a 10-minute freshness window when a client posts it.

    flagship/app-rank/v1|<serviceRef>|<target>|<rank>|<issuedAt>
    flagship/service-access-mode/v2|<serviceRef>|<open|restricted>|<issuedAt>
    flagship/service-allow-remove/v2|<serviceRef>|<aid hex>|<issuedAt>

`target` is `device:<64 hex>` (an account device key; the legacy AID counts
as one), `share:<32 hex shareId>`, `invite:<inviteId>`,
`grant:<inviteId>/<aid hex>` or `aid:<aid hex>`; `rank` is `member`,
`manager`, `master`, or `refused` (device and share targets only). Vectors:
`packages/protocol/test-vectors/app-access-orders/`; all four ports pass
them. The server-named `flagship/app-member-role/v1` is retired (pre-release:
no box takes it, its vectors are gone).

### Box surface

- `GET /api/screens/services/:id/members` adds `accountMembers`: each device
  in the book (`kind: "device"`, `deviceId`, `devicePub`, `tier`
  `admin|member`, `rank`, `set`, `refused`) and each active co-manager
  (`kind: "co-manager"`, `shareId`, the owner's `label`, `rank`, `set`,
  `refused`); each invite adds `creatorPub` and `creatorDeviceId` (from the
  book). No `owner` anywhere.
- `POST /api/screens/services/:id/members/rank {order, signature}`.
- `POST /api/service-access {request, signature}` takes a v2 mode order;
  `POST /api/service-access/allow-remove` a v2 removal (v1 still parses).
- `POST /api/service-access/invite-withdraw {revoke, signature}`.

The state lives in `<dataDir>/data/flagship-access/service-access.json`
(moved from `/var/flagship/service-access.json`, read once from there), so
Migrate's backup and final flush carry it; app copy and server
archive/import carry each app's entry (mode, list, grants, ranks, creators);
uninstall drops the app's entry, so a reinstall under the same id starts
clean.

### Clients

The app's Access control screen shows **Account members** next to the
invited people: this account's devices (names from the decrypted directory)
and the co-managing accounts (the owner's label), each with its rank. On
admin devices each row has a rank menu (Member, Manager, Master) and
**Refuse**, one biometric per order, as for invites. A non-admin device that
is manager-class sees "+ Add person / group" at Member with the existing
one-line why; one below manager sees why it can't invite. The rank picker
offers only member, manager and master. Admin devices keep one biometric per
invite.

## One list per app (owner decision, 2026-10-15)

An app that runs on several of the account's servers has **one** access list:
its mode, allow-list and grants, invite tiers and creators, rank orders, and
the overrides of the account's devices and co-managers. A person who joins on
one server is in on all of them; an admin order sent to any of them holds on
all of them.

**The leader holds it.** The app's lead server is the live server highest in
the owner's server order that runs it (`docs/server-order.md`), the same rule
as the gossip election. Each box works it out itself every 30 seconds: the
account's servers and their liveness from `.com`'s `/pods` (read token), their
positions from the server order the box holds and verified, and which of them
run the app by asking them directly (an authenticated pull; 404 = not there),
so `.com` is never asked about apps or members (`accessPeers.ts`). It doesn't
lean on the gossip frames: the box-to-hub broadcast (`broadcast--<user>.<apex>`
on :443) has no TLS terminator on the hub yet, so cross-box gossip never
reaches a sibling (found by the gym, 2026-10-15; open). A change accepted on any box (a v2 mode order, a v2
removal, an app-rank order, a join, a withdraw) is verified there as usual,
kept in that app's **journal**, and handed to the leader; the leader verifies
and applies it, keeps it, and copies it out to the app's other servers in
server order. If the leader is down, the next live server in the order is
leader (the existing election), and a hand-over that failed is retried to
whoever leads now.

**Nobody is trusted for the list.** The journal is a set of signed entries,
each carrying its own proof:

| entry | proof every box re-checks |
|---|---|
| `mode`, `remove`, `rank` | the admin-only key (`flagship/service-access-mode/v2`, `flagship/service-allow-remove/v2`, `flagship/app-rank/v1`) |
| `join` | the signed create (admin root or a device in the box's own book) and the joiner's redeem signature over the create's secret hash; the invite's cap (a personal invite binds one person), its expiry, the creator still manager-class, no later removal of that person, no withdraw of the invite |
| `accept` | the signed create and the joiner's acceptance signature (manual approve) |
| `withdraw` | an admin's revoke, or the creating device's while it is still manager-class there |

So the leader only distributes. Applying is idempotent and "latest order
wins" per target (the per-target `issuedAt` sequence), so arrival order
doesn't matter. A withdraw that arrives before the join it withdraws is kept
(`roles.withdrawn`) and refuses that join once the creator is known. v1 orders
name one server and stay on it, and so do the box's own changes (an
AI-built app first deployed members-only): a copy or the next admin order
carries them. `.com` keeps doing first-bind arbitration on
the box where someone redeems; the other boxes trust the box that did only
as far as the proofs above go (the cap stops a second person on a personal
invite).

**Box to box only.** `POST https://<server>/api/access-sync/push
{from, to, serviceRef, issuedAt, mac, body}` (entries) and `…/pull` (the
caller's journal digest; the answer is `same` or the entries), over each
box's own TLS, with `mac` = HMAC-SHA256 under
`HKDF(CGK, "flagship/access-sync/key/v1")` over
`flagship/access-sync/v1|<push|pull>|from|to|serviceRef|issuedAt|sha256(body)`,
at most 5 minutes old. The CGK is the account's cloud gossip key (only the
account's boxes and devices hold it). Nothing goes through `.com`, which would
learn per-app member ids and ranks.

**Catching up.** A box keeps, per app, the other servers it has seen running
it. At boot every such app starts **catching up**: until the box has pulled
the list from the leader (or, when it leads, the next live server in the
order), only the owning account's own devices get in. Invited people and
co-managers wait (`503`, "this server is catching up with the app's other
servers"), so a person removed elsewhere while this box was off never slips
in on its older list. That is stricter than "serve the last known list" and
is the conservative choice: it costs invited people up to a couple of minutes
after a restart. A box that sees no other live server running the app for
two minutes after boot is alone and serves its own list. An app copy starts
from the source's list and catches up from the leader at once (the copy's
own state is seeded first, so nothing is lost if the leader is unreachable).

**Healing.** Every two minutes each box compares its journal with the
leader's (a digest, then the entries) and both sides take what they lack, so a
box that missed a push converges. Failed pushes are retried every 30 seconds.

**Migrate, archive, uninstall.** As in "Account members": the journal lives
beside the access state in `<dataDir>/data/flagship-access/`, so Migrate
carries both; archive and copy carry the state; uninstall drops the app's
state and journal.

**Per-server lists.** `scope(serviceRef)` is `"account"` for every app on
`main`. The Pro option that returns `"server"` is built on `feat/marketplace`
only: "Separate lists per server (Pro)", below.

Built in `packages/server-daemon/src/accessJournal.ts` and `accessSync.ts`;
tests `packages/server-daemon/tests/accessSync.test.ts`.

## Separate lists per server (Pro) (owner decision, 2026-10-15; `feat/marketplace` only)

A Pro account may give an app a separate access list on each server that runs
it. Nothing of this is on `main` (no switch, no Pro check, no scope other than
`"account"`); the code lives on `feat/marketplace`.

**The switch.** Per app, an admin device signs

    flagship/app-list-scope/v1|<serviceRef>|<account|server>|<issuedAt>

with the sensitive-order key (the admin root, like the mode and rank orders)
and posts it to one of the app's servers
(`POST /api/screens/services/:id/list-scope {order, signature}`, at most 10
minutes old, newer than the last one: latest order wins). That box hands it to
the app's other servers; every box verifies it under its own admin key.
Vectors: `packages/protocol/test-vectors/app-list-scope/` (TypeScript, webapp,
Swift and Kotlin pass them).

- **On (`server`):** each box keeps its current copy as its own list and stops
  copying the app's changes out or taking them in. Joins, removals, withdraws
  posted to a box, mode and rank orders all stay on the box they were made on.
  Invite revocations polled from `.com` (`revoked-since`) still apply on every
  box: a link withdrawn on `.com` stops working everywhere. That is the safe
  default (a revocation should never be confined by a list split) and needs no
  per-server bookkeeping on `.com`.
- **Off (`account`):** every box takes the app's lead server's list. Each box
  but the leader drops its list (mode kept until the leader's journal says
  otherwise, so a members-only app never opens up in between) and its
  journal, then catches up from the leader, letting only the account's own
  devices in until it has (as after a restart). Changes the leader holds only
  as box-local or v1 state don't carry, as with one list.

**Why the box can trust "Pro".** `.com` serves
`GET /api/users/<u>/plan-attestation` (read token, like `/pods`):

    flagship/plan-attestation/v1|<username>|<tier>|<paidUntil>|<issuedAt>|<expiresAt>

signed with the hot CA key, 26-hour TTL. The box verifies it through the same
chain as the directory attestation and the relay blessing: the baked
maintainer pin, the forward ca-track chain in its own `.maintainers/`, the
live CaEndorsement, then the signature and TTL. This is the cleanest
verifiable mechanism the code already had. The post-boot entitlement deposit
was the other candidate, but it is signed by the owner's own keys, and an
owner can't attest their own payment. A plain JSON tier from `.com` could be
forged by anything on the path. Residual, stated plainly: `.com` holds the CA
key, so `.com` itself could misstate a plan. Calling an account Pro costs
nothing. Calling it free merges lists, which is the same thing that happens
when someone stops paying. The box re-reads the attestation every 3 hours, at
most once a minute when an owner screen asks, and at most every 5 minutes when
another server's epoch says the plan changed. It keeps the newest one on disk.

- The box honours `server` only while its attestation says Pro (`hobby` or
  `maker`) and the paid period hasn't ended. An owner's own post is refused
  without it (`402 {code: "pro-required"}`). An order handed over by another
  server is kept as **pending** (still one list, no exchange with servers
  that honour it) until the box sees Pro.
- **Downgrade.** When an in-date attestation says the account is free, every
  app with separate lists goes back to one list, exactly like turning the
  switch off: the lead server's list becomes the shared list and the other
  servers' copies are dropped. The order is marked ended. Pro coming back
  doesn't bring separate lists back; a new order does. The app's lead server
  records an activity row (`access.lists.merged`) and sends a content-free
  push (category `access-lists`: "Pro ended, so your apps use one access list
  on all your servers again."). Neither names an app or a person.
- **Unknown plan.** No attestation, an expired one, an ended paid period with
  no newer word, `.com` unreachable, or a lapsed CA lease: nothing changes. A
  pending order isn't honoured, and an honoured one isn't ended. An outage
  never merges anyone's lists.

**Epochs.** Each app's epoch is `<issuedAt of its scope order>:<account|server|pending|ended>`
(`0:account` with no order). Every access-sync push and pull carries the
sender's epoch and scope order. A server that missed a switch adopts the newer
order from whichever server it talks to next, and list entries cross only
between servers in the same epoch, so a separate copy never leaks into another
server's list across a switch. A pull always answers (it is also how a box
learns who runs an app), but without entries across epochs. While an app
switches, its new epoch shows only once its list is ready. A box with separate
lists still exchanges the scope order with the leader on the 2-minute
reconcile, so a switch-off reaches a box that was down.

**Owner surface.**

- `GET /api/screens/services/:id/list-scope` →
  `{serviceRef, scope, pending, plan: pro|free|unknown, self, leader, servers}`
  (`servers` = the app's servers in the owner's server order).
- `GET /api/screens/access-lists/summary` → `{plan, separateApps, leaders}`
  across the account. The box asks its sibling servers box to box
  (`POST /api/access-sync/scopes`, same CGK MAC), so `.com` learns nothing
  about apps.

**Clients** (webapp, iOS, Android). Access control on admin devices has
**Separate list on each server**. Without Pro it is off and locked with
"Comes with Pro." The webapp links to `/pro`; the store apps show no purchase
link (App Store and Play anti-steering rules, the conservative choice). On
turns it on after one confirmation; Off confirms that every server will use
the leader's list. While it is on, a server picker lists the app's servers and
the whole screen (members, account members, mode, invites and their links,
every order) works on the picked server with that server's session. `.com`'s
invite list is narrowed to the invites that server knows plus unused links,
since `.com` doesn't know which server a link points at. The plan screen
warns before Pro ends: "N apps have a separate access list on each server.
When Pro ends they'll all use <lead server>'s list." (each its own lead
server's when they differ). The apps have no cancel button, so the warning
always shows while Pro is on and N > 0.

Built on `feat/marketplace` in `packages/protocol/src/appListScope.ts`,
`planAttestation.ts`, `packages/control-plane/src/planAttestation.ts`,
`packages/server-daemon/src/accessScope.ts`, `accessScopeHttp.ts` and
`accessSync.ts`; tests `packages/server-daemon/tests/accessScope.test.ts`.

## Per-app identity (owner rule, 2026-10-13)

A visitor's identity toward an app is derived from their account root and that
app only:

    seed = HKDF-SHA256(UMK, salt = "", info = "flagship/app-aid/v1|<appRef>")

`appRef` is the app's **service id** (`<creator>--<slug>`). It is the same on
every one of the owner's servers (a copy or a move keeps it, and the box's
allow-list state travels with the copy), and it is the same whoever sends the
invite, so the owner's invite and a co-manager's invite to one app bind the
same id. Consequences:

- The owner can tell that two grants of the SAME app ("John" and the "Chess
  Club" group) are one person — acceptable — but never link a visitor across
  two apps or servers: no long-lived id is shared between apps, and none
  depends on who invited them. It replaces the per-author contact AID
  (`flagship/contact-aid/v1`), which linked a visitor across all of one
  owner's apps.
- `.com`'s invite records hold per-app ids only (`boundAID` is whatever the
  redeemer signs with). The owner is still recognised by the owner AID.
- Invite links name the app: `…/invite#<secret>&a=<ownerAID>[&i=<inviteId>]&s=<serviceRef>`
  (`flagship://invite?…&s=` for the app hand-off). A link without `s=` (made
  before this rule) can't be redeemed: the friend is asked for a new one.
- Redeem, visit proofs, knock sign-in and manual-approve acceptances all sign
  with the id for the app in question (the knock deeplink's `ref=`); the box
  is unchanged (it verifies whatever AID is on the allow-list).
- Existing grants bound to old contact AIDs keep working only until the
  person's next sign-in from an updated app (which presents the per-app id the
  box doesn't know): re-invite them. Fine before launch.
- Vectors: `packages/protocol/test-vectors/app-account-id/` (a different app ⇒
  a different id; a different inviter, same app ⇒ the same id; refused app
  refs) and `appAid`/`acceptApp` in
  `packages/protocol/tests/fixtures/serviceAccessGating.vectors.json`.

## Notes
- AID is a NEW UMK-derived key (parallel to the versioned IRK). Add `deriveAccountId` to
  `@flagship/protocol` (`keys.ts`) + the Swift/Kotlin/webapp keystores (follow-up for clients).
- Layers on existing `ServiceEntitlement` (IRK-signed cert) + service `membership`.
- Bearer-link threat model: whoever holds the link can redeem; first-bind locks it to one AID;
  the author sees who bound it + can revoke. Send over a private channel.

## Web-experience gating (browser access via QR-login + session management) — owner-designed 2026-06-19
A restricted service's WEBSITE must gate plain browser visitors (a browser can't AID-sign). Pattern =
**QR-login** (à la WhatsApp Web): a knock page; the phone authorizes; the server binds the browser session.

### Knock page
A visitor hitting a restricted service with no valid session gets a non-threatening knock page: *"This page
is on a Flagship cloud and access is restricted — authenticate to view."* (minimal disclosure — NO owner/
content). It carries a high-entropy, short-lived, single-use **pageId** (re-rolled per load / ~minute), a
**button** (same-device app link `https://flagshipserver.com/access#server=…&svc=…&ref=…&page=…`), and a **QR** (cross-device: same
deeplink). The page POLLS the box for `pageId` authorization.

### Authorize (phone)
deeplink/scan → app verifies the visitor's **AID** ∈ the service allow-list → on yes the phone **AID-SIGNS**
`{pageId, aid, serviceRef, nonce, exp}` and POSTs it to the box. The box verifies the **signature + allow-list
membership** (NOT a plaintext "who I am" GET param — the security must-fix), then: creates a **session**
`{secretId, aid, serviceRef, browserAgent, startTime, status:online}`; the browser's next poll for `pageId`
→ authorized → the box sets the access **cookie** on the BROWSER (transitions off the QR to the content);
returns the **session secretId** to the PHONE (never to the browser). A "go back to the website" toast nudges
the cross-device case (the browser auto-transitions regardless).

### Fallbacks
No app / no access on this device → the button stays as the QR (scan with another phone). "Get link" → copy
the code → app Settings → **"Process URL"** paste. Never deactivate the page — a stale pageId just re-rolls.

### Refinements over the original sketch (owner design was ~right; these are the catches folded in)
1. **AID-SIGNED authorize, not a plaintext "who I am" GET param.** The original "phone reaches the server with a
   link that has a get parameter telling who this is" would let anyone assert any identity. The phone instead
   **AID-signs** `{pageId, serviceRef, …}`; the box verifies the signature + allow-list. (Security must-fix.)
2. **pageId = high-entropy, single-use, short-lived** (128-bit, consumed on cookie delivery, re-rolled per load)
   — a correlation token, never a guessable counter.
3. **Holder binding closes the pageId-theft race.** The knock page sets a host-scoped `Flagship-Knock` holder
   cookie; ONLY that browser can pick up the session cookie. A shoulder-surfed QR/pageId yields nothing.
4. **Two distinct artifacts:** the browser gets an opaque `Flagship-App-Session` **cookie**; the phone gets the
   **secretId** (never the browser). Closing by secretId kills the cookie.
5. **Minimal disclosure** on the knock page (no owner / service name / content) + `noindex` + fully
   self-contained (no remote asset — never leaks the visitor to another origin).
6. **secretId rides the request BODY, not the URL path** (the sketch wrote `/session/:secretId/status`) — a
   32-byte secret in a URL lands in access/proxy logs; the body keeps it out. Status stays rate-limited
   ~1/min + default-offline for unknown (both as the owner specified — those were already right).

### Session management (the phone holds the secretId, not the browser)
- `GET  /api/service-access/session/:secretId/status` → `{online|offline}`, **rate-limited ~1/min/session**,
  **default offline for unknown** (no enumeration oracle).
- `POST /api/service-access/session/:secretId/close` (secretId-authed) → kills the browser cookie.
- The service (or the harness) can stop a session anytime.
- Settings → **"Open secured sessions"** lists `{serviceUrl, browserAgent, startTime}` per held secretId + Stop.

## v2 hardening — STATUS: BUILT on main (2026-06-19)
The full v2 redesign is integrated + green on main (protocol `21a9de5d` → backend `6280ec88` → clients
Android/iOS/webapp → link reconciliation `189d93e2`). Closes the verified critique findings: **C1** (box
verifies the owner's signed create + secretHash-match — `.com` can't forge a binding), **C2** (owner-auth on
the invite list), **H3** (pairwise contact AIDs — no cleartext friend-graph on `.com`), **H4** (revocation
convergence poller + instant prune), **H1** (3 invite tiers incl. the manual out-of-band accept-loop), plus
M2/M3/M4/M5/L. All 3 clients interop on the canonical invite link `<secret>&a=<authorAID>&i=<inviteId>`
(fixed-string round-trip tests per surface). Gates: protocol 682 · backend 3137 · iOS 1146 · Android 989 ·
webapp 1392 · tsc clean.

**Follow-ups — DONE (`f7ad7a7d`):**
- ✅ **Manual-finalize is now device-independent** — the box re-fetches + verifies the signed create from
  `.com` by inviteId at `/api/service-access/accept` (STK-signed `GET …/service-invites/:inviteId/create`,
  mirroring `revoked-since`); the author submits only `{accept, acceptSig}`, and the per-client create caches
  (webapp `CREATE_STORE_KEY`, iOS `InviteCreateStore`, Android) were deleted. Finalize from any of the author's
  devices.
- ✅ **Acceptance-reply link** canonicalized — `https://flagshipserver.com/invite-accept#server=&iid=&ref=&aid=&sig=&at=` (older apps sent `flagship://invite-accept?…`, still parsed), all
  3 surfaces build+parse the identical frozen string (round-trip tests); legacy forms still decode.
- ✅ **`/invite` web page** parses + forwards the canonical `#<secret>&a=<authorAID>&i=<inviteId>` (verified +
  test-pinned).

**Remaining (low-priority / owner):** retire the dual-accept IRK-create path once nothing needs it (safe to
keep); deploy `.com` (the new by-inviteId fetch route) + rebuild the builder/apps to ship to real boxes/devices.

## v2 hardening — box-as-authority + pairwise AIDs + author-confirmed binding (2026-06-19, from the design critique)

A skeptical design review (findings verified against the code) surfaced the v1 gap: the design
DECLARES `.com` untrusted but OPERATIONALLY trusts it for the binding that grants access, and the
"content-blind" claim doesn't extend to the friend graph. Owner approved an architectural redesign.
Already shipped as defense-in-depth: the redeem `serviceInstalled` gate (`7b80ea15`, C1-partial).

### Phase 1 — Box is the binding authority (fixes C1, C2-trust, H4) — highest leverage
Today `handleRedeem` relays to `.com` and trusts `.com`'s `{serviceRef, boundAID}` — a rogue/compromised
`.com` can grant any AID access to any *hosted* service (the `serviceInstalled` gate only bounds it to
hosted services). Change:
- `.com` PERSISTS the create's IRK **signature** (storage: add `createSig` to `service_invites` +
  migration; `handleCreateServiceInvite` already receives `body.signature` — store it).
- Redeem returns the signed create (envelope + sig). The box VERIFIES that signature against its
  config-pinned **owner IRK** + that `serviceRef` is hosted, BEFORE binding. A rogue `.com` cannot forge
  the owner's IRK sig → cannot fabricate a binding. `.com` is demoted to a blind store + first-bind arbiter.
- **Revocation convergence:** the box POLLS `.com` for revoked invites (reuse the daemon-status cadence)
  and self-prunes — so a `.com` revoke is SUFFICIENT and multi-box self-heals. Supersedes the just-built
  owner-prune-only model (which stays as the immediate path + the manual override).
- Surfaces: storage (migration + create stores sig), control-plane (redeem returns create+sig; a
  revoked-since-cursor list), daemon `serviceAccess.ts` (verify create sig + a revocation poller), tests.
- **⚠️ OPEN DESIGN QUESTION (resolve before implementing):** the create is currently **IRK-signed**, but the
  IRK ROTATES (re-pair / recovery / device-takeover), so a create signed by the old IRK won't verify against
  the box's *current* config-pinned IRK after a rotation — box-as-authority would break exactly when the owner
  rotates a device. Resolution options: (a) **AID-sign (or AID-co-sign) the create + revoke** so the box
  verifies against the stable AID (this is the cleanest, and it COUPLES Phase 1 with Phase 2 — do them
  together: the box pins the owner's AID, verifies AID-signed create/revoke); (b) the create carries its
  IRK-version + the box keeps the owner's IRK history (more state, still rotation-fragile); (c) `.com` vouches
  for the signing IRK (re-introduces trusting `.com` — rejected). **Recommendation: (a)** — pin the owner AID
  on the box at provision, switch create/revoke to AID-signed, and land Phase 1+2's signing change as one unit.
  This is why Phase 1 is NOT yet in flight: the trust-model change needs this decision first.

### Phase 2 — Pairwise AIDs (fixes H3: cross-box linkability + the cleartext friend-graph)
Today one GLOBAL AID identifies a person across every box/author, and `.com` stores
`authorAID→boundAID→serviceRef` in cleartext (the bundle is content-blind; the GRAPH is not). Change:
`deriveContactAccountId(UMK, authorAID)` — a per-author friend identity (HKDF over UMK + the author's AID,
parallel to the existing per-service `deriveServiceMemberStableId`). The friend presents a per-author AID;
two authors can't cross-link; `.com` sees unlinkable pseudonyms. Cross-app reuse still works (deterministic
derivation). Decide: the owner's own multi-box identity stays global vs per-box. Migration: applies to NEW
invites; existing global-AID bindings grandfathered. Surfaces: protocol (`deriveContactAccountId` + redeem/
visit/knock sign with it), all 3 clients, `.com` (already stores opaque AIDs).

### Phase 3 — Invite tiers + approval (fixes H1; owner-refined 2026-06-19)
Three tiers, chosen at create/add time, all on the box-as-authority + pairwise-AID foundation. Across ALL
tiers the consumer's Flagship username/domain is **never disclosed to the author** — the author sees only the
private label they themselves assigned (personal) or a group label (group). (The owner explicitly rejected
verifying by the consumer's username/domain on exactly this privacy ground.)

1. **Personal, auto-approve** — first-bind (the original fast flow): send link → first redeemer binds. Accept
   the casual-leak window; for low-sensitivity grants.
2. **Personal, manual-approve (sensitive)** — closes the link-theft race WITHOUT disclosing the consumer's
   identity, via an **out-of-band acceptance loop**: author sends the link → the friend's app accepts + emits
   an **AID-signed acceptance** token (binds the inviteId + the friend's pairwise contact AID) → the friend
   replies it back through the SAME private channel → the author's app opens it + submits it to the **author's
   box**, which verifies the owner's create AND the friend's signature, then binds. The author FINALIZES the
   loop. A thief who only grabbed the link can't produce an acceptance the author will open from their
   friend-channel. NOTE the honest bound: this is channel-trust + author-finalization (defeats a casual
   link-leak), NOT cryptographic against an attacker already inside the author↔friend private channel — which
   matches the threat model. The acceptance reply is itself a link/QR (symmetric to the invite).
3. **Group / multi-use** — one link, `maxN` redemptions (0 = unlimited), **auto-approve only** (per-person
   confirm is impractical when you don't know who'll redeem). Lower-trust BY CONSTRUCTION (a leaked link admits
   up to N) → must be clearly labeled in the UI. Guest list shows ONE entry ("Chess club — 4/10"); revoke the
   whole group in one op (the box prunes all AIDs bound to that inviteId); per-member removal is a cheap bonus
   (the group is a labeled set of bound AIDs). The live count is a leak signal; an **optional expiry** is
   recommended (a forever-link is a standing liability).

Surfaces: protocol (the AID-signed acceptance envelope; `maxN`/expiry on the create), `.com` (pending state
for manual; redemption-count enforcement for group), box (verify + bind on the author's submission; group
prune), client UX (the create-time tier picker, the accept→reply→open loop, the group guest-list entry).

### Convenience — QR in the share (owner-requested 2026-06-19)
When sending an invite (or an acceptance reply), populate the share (share-sheet / iMessage / email) with an
inline **base64 QR image** of the link, IN ADDITION to the link text. Caveat: email clients (Gmail/Outlook)
commonly STRIP data-URI `<img>` for security → the QR may not render in email; the **link text is the reliable
fallback**, rich channels (share-sheet/iMessage) render the image, and for email an actual attachment beats a
data-URI. Reuse the existing `qrSvg.ts` / `qrEncoder.js`.

### Contained hardenings (fold in alongside the phases)
- **Owner-IRK-auth the invite `list`** (C2 — `handleListServiceInvites` is currently unauthenticated: anyone
  with a username + a 64-hex authorAID dumps that author's whole invite graph). Sign it like create/revoke.
- **Random 128-bit invite ids** (M2 — drop the `hash(devicePub)` device-fingerprint leak baked into the id).
- **Nonce-challenge + client-bind the establish-session cookie** (M3 — a captured 5-min visit proof currently
  mints a 12h freely-transferable bearer cookie).
- **Fail-open alert** (M4 — owner-facing signal when access-state reverts to `open` unexpectedly).
- **Allow-list size cap + redeem/establish/knock rate-limits** (M5). **Poll `unknown`→`pending`** (L — kill
  the pageId oracle).

### Web-path trust tier (H2)
The QR-login web path is structurally lower-trust (the browser isn't cert-pinned — CAA+CT only). The phone
must DISPLAY what it's authorizing from its OWN trusted state (not the deeplink's claimed serverId/serviceRef)
and ideally channel-bind the knock to the box's pinned cert hash, so a rogue-cert look-alike can't get a
signed authorization. The browser EXTENSION (`feat/browser-extension`) is the path to closing the
browser-pinning gap. Until then, label web sessions as the convenience tier.

### Sequencing
Phase 1 first (it alone closes C1 fully + C2-trust + H4 — the biggest posture change), then the contained
hardenings (cheap, low-tradeoff), then Phase 2 (privacy; touches all signing), then Phase 3 (UX). Each phase
is multi-surface (protocol → `.com` → daemon → 3 clients) + fixture-pinned, suited to a parallel-worker fan-out
per phase.

### Maps to the built backend (extends, doesn't replace)
On main already: AID binding (redeem), the `Flagship-App-Session` cookie, `establish-session` (phone
AID-signed visit-proof → box mints a cookie). This ADDS: (a) the **pageId correlation** (the phone authorizes
a SEPARATE browser's pageId, vs its own client) + the knock page + the browser poll; (b) the **session store**
carrying `{secretId, status, serviceUrl, browserAgent, startTime}` + the phone status/close API (rate-limited,
default-offline) + the Settings list.

### Daemon backend — BUILT (`3343aeb9`, on main, tested)
- **`packages/server-daemon/src/serviceAccessWeb.ts`** — `PendingKnockStore` (in-memory, ephemeral) +
  `buildServiceAccessWeb({serverId, store, sessions})`:
  - `maybeServeKnock(serviceRef, req)` — the enforcement layer (`buildAccessEnforcementHandler`'s new 3rd arg)
    calls it on a DENY; returns the self-contained knock page (200 HTML + holder cookie) for a top-level
    browser GET/HEAD with `Accept: text/html`, else null (→ the existing 403 JSON for XHR/assets).
  - `GET /__flagship/knock/<pageId>/status` — browser poll; delivers the session `Set-Cookie` **only to the
    holder** (matching `Flagship-Knock` cookie), single-use (the pageId is consumed on delivery).
  - `POST /api/service-access/knock/authorize` — the phone's AID-signed `KnockAuthorization`
    (`flagship/service-knock/v1`; the **pageId is in the signature**, so a visit proof can't be replayed onto
    another page). Verifies sig + serverId + replay + allow-list; mints the session cookie + a phone-held
    `secretId`; returns the secretId to the PHONE only.
  - `POST /api/service-access/session/status` + `…/close` — **secretId in the BODY, never the URL** (so it
    can't land in access logs); status is rate-limited ~1/min/secretId + default-offline for unknown (no
    enumeration oracle); close kills the browser cookie.
- **`packages/server-daemon/src/qrSvg.ts`** — server-side QR (strict-TS port of the webapp `qrEncoder.js`,
  byte-for-byte identical) so the knock page bakes the QR in without fetching a remote asset.
- **Protocol**: `KnockAuthorization` envelope (`signKnockAuthorization` / `verifyKnockAuthorization`); pinned
  cross-platform vector in `serviceAccessGating.vectors.json` → `"knock"`.
- **`ServiceSessionStore`** gained the `secretId` index + `closeBySecretId` + `lookupBySecretId`.

### Clients — in flight (iOS / Android / webapp)
The app link the knock page hands the phone is `https://<control apex>/access#server=&svc=&ref=&page=` (2026-10-14; the fragment keeps the server and app out of our logs when it opens in a browser; the earlier `?query` and `flagship://access?…` forms still parse). Each client adds:
`signKnockAuthorization` (mirror, fixture-pinned) + the deeplink/paste → KnockAuthorize confirm → authorize
call + a local `SecuredSession` store + a Settings **"Open secured sessions"** list (status/close). The webapp
authorizes via a pasted link ("Process URL") since a browser can't own the `flagship://` scheme.
