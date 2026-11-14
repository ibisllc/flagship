# Restore a backup into a running server (merge its apps)

> **Status: design, 2026-11-14. Nothing built.** Owner request 2026-11-14: "Restore-to-server means
> deleting the data already on there? It would be nice if it means combining the backuped apps into the
> server. That raises questions of versioning (code and data) if the app is already on the box." Restores
> stay **admin-only** for now (owner, 2026-11-14). Builds on `docs/server-backup-and-clone.md`,
> `docs/app-placement.md` §5, `docs/app-runtimes.md` §5.3/§7/§8 and `docs/service-access-gating.md`
> "One list per app" / "Per-app identity".

## 0. Today, and what changes

Today a backup restores only onto a **new** server made for it. The box waits for one data file
(`flagship/server-restore/v1`, `restoreWait.ts`), installs every app with `installOne`
(`serverArchive/restore.ts`), skips any app already there ("already on this server"), and the late
order route refuses a server that has apps (`409 code has-apps`). Nothing is ever deleted, but nothing
is ever combined either.

This design adds a second restore: **into a running server**, app by app, under a plan the owner picks
and signs. The whole-server restore (new server, Migrate) stays exactly as it is, with its own order and
its `has-apps` guard. The two share the transport (upload, pull, peers, saved backups), the extraction
check, the dump audit and the install path.

Principles:

1. **Nothing is destroyed by default.** Every app already on the server defaults to "Keep this
   server's". Replacing is an explicit per-app choice.
2. **Every replace can be undone.** The server's own copy is kept intact (not just dumped) as an undo
   point for 7 days.
3. **The box does only what the owner signed.** The plan is in the signed bytes, and each line names
   the state of the app the owner saw; if the app changed since, that line is refused.
4. **Who can use an app is never restored over a live list.** Access lists, members, ranks and
   one-list journals of an app already on the account are left alone; only a lone new app gets the
   backup's list, and then only as the existing N09 draft.
5. **Data is never merged row by row in v1.** It is the backup's database, or the server's, or both
   side by side as two apps.

## 1. When is a backed-up app "the same app"?

An app's id is `<creator>--<slug>` (immutable). Restore already rewrites the creator to the importing
account (`localServiceId`: `harry--notes` from another account becomes `sam--notes`). The per-app
visitor id (`flagship/app-aid/v1|<serviceRef>`) and the voi.ci name are keyed on that id.

The id alone can't tell "same app" from "different app that took the same slug" (two accounts' `notes`,
or an app deleted and recreated under the same slug). So each app gets an **origin**:

- A random 16-byte `origin` minted the first time an app is installed from nothing (AI build, git
  import, IDE, marketplace, manual install). App copies, backups, restores and Migrate carry it
  unchanged. Kept in `InstalledService.origin`, in archive meta and in the app-copy description.
- An app or backup that predates origins gets a **legacy origin**, derived the same way everywhere:
  `SHA-256("flagship/app-origin/legacy/v1|" + serviceId)` over the id it had when it was first seen
  without one (for a backup: the archived id, before the creator rewrite). Copies of one legacy app
  on several servers therefore agree.
- A side-by-side copy (§3.4) gets a **new** origin and records `forkedFrom: <origin>`. It is a new app.
- The origin is never an input to any key, AID or link, never shown, and never read by a model.

Verdict, per backed-up app, against the box (target id = `localServiceId(archived id)`):

| Box has the target id? | Origins | Verdict |
|---|---|---|
| no | — | **new here** (and §1.1 checks the account's other servers) |
| yes | equal | **same app** |
| yes | backup has a real origin, box has a real one, they differ | **name clash**: a different app with the same name |
| yes | either side legacy, same account | **same app** (legacy ids of one account can only collide with themselves) |
| yes | either side legacy, other account | **name clash, maybe the same**: the owner may say "it's the same app" (§3) |

### 1.1 New here, but on the account's other servers

The box asks the account's servers whether they run the target id, the way `accessPeers.ts` already does
(authenticated pull, `.com` is not asked about apps). If any do, the verdict is **runs elsewhere**: the
app exists in the account with its own (probably newer) data and its one access list.

## 2. Comparing versions (code and data)

### 2.1 Code

Each app gains a `codeHistory`: on every install, redeploy, AI finish, copy and restore the box appends
`{digest, version, at}` (kept to the last 100), where `digest` is

- source apps: the working-tree digest (SHA-256 over the sorted tree, the bundle hash of
  `app-runtimes.md` §7, computed by the box at build time);
- pulled images: the image digest (`imageDigest`, already in archive meta);
- WASI: the module digest.

`version` is the manifest's semver. Backups and copies carry the history. Relation of the backup's
current digest **b** to the box's current digest **x**:

| | Code relation |
|---|---|
| b = x | **same** |
| b in the box's history | **backup older** |
| x in the backup's history | **backup newer** |
| neither | **diverged** (edited separately on two servers, or a fork) |
| no history on one side | **unknown**: fall back to comparing `version` and say "probably older/newer" |

Cross-architecture rebuilds give the same tree digest (it is the source), so the relation holds.

### 2.2 Data (schema)

Migrations are forward-only SQL files, recorded by filename in `appliedMigrations` (box: the installed
record; backup: archive meta). With **B** the backup's set and **X** the box's:

| | Schema relation | Means |
|---|---|---|
| B = X | **same** | either code runs on either data |
| B ⊂ X | **backup older** | the box's code can migrate the backup's data forward (run X∖B) |
| B ⊃ X | **backup newer** | the box's code can't run on the backup's data (no down-migrations) |
| neither | **diverged** | only one side's code and data together |

The files folder has no schema: an app that keeps structured files there is responsible for reading old
ones. The choice screen says so for apps with a files store.

The box also reports data sizes (each database, the files folder) and dates: the backup's `createdAt`,
the box app's `installedAt` and its last `codeHistory` entry. It can't tell cheaply whether the box's
data changed since the backup, so it doesn't claim to.

## 3. The choices per app

| Action | Code | Data | When allowed |
|---|---|---|---|
| **install** | backup's | backup's | new here; runs elsewhere |
| **skip** | — | — | always (for apps not on the box) |
| **keep** | box's | box's | app on the box (the default) |
| **replace** ("Restore the backup's version") | backup's | backup's | same app, or a clash the owner marks "same app" |
| **replace-data** ("Use the backup's data with this server's version") | box's | backup's, then X∖B migrations | same app and schema same or backup older |
| **copy** ("Add as a separate app") | backup's | backup's, under a new slug | always, if a slug is free and it fits |
| merge rows | — | — | **never in v1** (§3.5) |

"Code only" (backup's code over the box's data) is not offered: it is a rollback of the app, which is
the update path's job, and data newer than code breaks forward-only migrations.

### 3.1 Recommended defaults

| Verdict | Default | Why |
|---|---|---|
| new here | **install** | that is what combining means |
| runs elsewhere | **skip**, with "Runs on home2 (its data is likely newer)" | a stale copy would join the app's live access list and, if this server is higher in the server order, take over the app's address (§5.3) |
| same app, any relation | **keep** | never destructive by default; the row says "The backup is older: 1.2 vs 1.4, from 3 Nov" so the owner can choose |
| name clash | **copy** as `<slug>-restored` when it fits the backup limit, else **skip** with the reason | brings the app back without touching the other one |

A plan whose lines are all keep/skip is not sent (the Restore button stays disabled).

### 3.2 Install (not on the box)

Exactly today's `installOne`: rebuilt from its saved source with this box's runtime catalog, or the
digest-pinned image pulled, or the WASI module checked against its digest; fresh stores; database dumps
audited (`auditDumpToc`) and restored before first start; the files tar through the extraction check;
env written (same account only, else `pendingEnv`); the working tree written; origin and `codeHistory`
kept. Then:

- **Access**: alone in the account → the backup's list as the N09 draft (`restoredAccessDrafts.ts`):
  members-only with nobody on the list until an admin approves that draft. Runs elsewhere (owner ticked
  it) → no draft at all; the box joins the app's one list and catches up from its leader, like an app
  copy, so a person removed since the backup never comes back.
- **Internet access list**: a draft, as today.
- **API keys**: not restored (the restore summary says "create them again", as today). The opening
  paragraph of `server-backup-and-clone.md` still claims keys come along; the code (N09) is right and
  that line should be corrected when this lands.
- Goes through the backup-limit gate in `ServicePlatform.install` like any new app.

### 3.3 Replace and replace-data (on the box)

Done with **store generations**, so the live app keeps running until a short swap and the undo point
is the server's untouched copy:

- `InstalledService` gains `dataGeneration` (0 = today's names). The opaque database and role names
  (`DATA_NAME_KEY` HMAC) and the files volume / quota image name take the generation as an input; the
  role stays the app's one role, which may connect only to its own current database.
- Steps for one app (the deploy lock is held throughout, so nothing else redeploys it):
  1. *(replace)* build or pull the backup's code into a new image while the live app runs;
  2. audit the dumps, make generation N+1 stores, restore the backup's database and files into them;
  3. *(replace-data)* run X∖B from the box's own `migrations/` against generation N+1, in the migration
     sandbox, as the app's role (the same runner as updates);
  4. re-check the plan line's guard (§4.2) against the live app; stop it; the proxy answers the app's
     address with a calm "This app is being restored from a backup" page (i18n, like Migrate's moving
     page);
  5. swap the installed record (image, manifest, `appliedMigrations`, `codeHistory`, `dataGeneration`,
     env per below), start, run the start check;
  6. success → generation N, the old image, working tree, env and installed record become the **undo
     point**; failure at any step → drop generation N+1 and the new image, point back at generation N,
     start it, Activity says "Couldn't restore notes; it is back as it was".
- Downtime is the swap and start, seconds, not the size of the data.
- **Env** on replace: the box's values win (they may have been rotated since); names only in the backup
  are added (same account only). replace-data leaves env alone.
- **Unchanged on replace and replace-data**: access state and journal, members, `redeemed`, rank
  orders, the internet access list, API keys, the voi.ci name, the front page. They describe who uses
  the app on this account and where, not what is in it. The backup's membership for that app is ignored
  and the screen says "Who can use it: unchanged".
- A clash replaced as "same app" keeps the box app's origin.
- Because the target id is the same, people's per-app ids are the same, so the restored rows that name
  people (`X-Flagship-User` and friends) still match them.

### 3.4 Copy (side by side)

Installed as a new app `<account>--<new slug>` (the owner edits the name; default `<slug>-restored`, or
`-restored-2`, checked as typed against the box and the account's other servers), new origin with
`forkedFrom`, the backup's code, data and env (same account only).

Consequences the screen states: a new address and voi.ci code (no custom name); **nobody can use it
until invited** (the backup's list is not carried: its people's ids are derived from the old app id, so
it would match nobody, and carrying it would link one person across two apps, against the per-app
identity rule); API keys not carried; data rows naming people no longer match anyone until they join
again; the app's code may refer to its old slug in places.

### 3.5 Merging data (why not, and when it could be)

Merging two databases row by row is unsafe in general: primary keys and sequences collide, foreign keys
point into the other side, a row deleted on one side reappears from the other, counters and balances
double, unique constraints fail half-way, and app invariants the box can't see break. Files with the
same path have the same problem. The box never knows an app's meaning, so it can't merge.

Possible later, never by default, only when the app opts in:

- **App-declared append-only tables** in the manifest (`restore.merge.tables: {"entries": "append"}`
  with UUID keys): the box restores the backup into a side database and runs `INSERT … ON CONFLICT DO
  NOTHING` per declared table, only when the schema is the same. Narrow, but enough for logs, notes,
  photos lists.
- **An app import hook** (recommended direction): the box restores the backup into a read-only side
  database and files folder mounted next to the live ones, and calls the app's
  `POST /__flagship/restore-merge` (the app's own code merges, under its own walls). The AI writes the
  hook when the owner asks for it.

Both are out of v1. The choice screen doesn't mention merging.

## 4. The orders

All signed with the sensitive-order key and checked with `authorizeSensitiveOrder`: on a box with an
admin root pinned, only that root (the IRK is refused); the IRK only on a box with none (demo). Shares
and companions are refused (the archive routes already refuse them). On a strict (quantum-safe) box
they join the set that needs the hybrid signature. Vectors in
`packages/protocol/test-vectors/server-restore-merge/` (TS, webapp, Swift, Kotlin).

### 4.1 Stage (lets the box take and open a backup, changes no app)

```
flagship/server-restore-stage/v1|<serverDomain>|<archiveId>|<bytes>|<sha256>|<source>|<issuedAt>
source = upload | saved | pull | peers
```

At most 10 minutes old when posted. One staged restore at a time, and not while a backup, a whole-server
restore or Migrate runs. Refused on a server waiting for a whole-server backup.

### 4.2 Plan (what the box may do)

```
flagship/server-restore-merge/v1|<serverDomain>|<restoreId>|<archiveId>|<sha256>|<planSha256>|<issuedAt>|<expiresAt>
planSha256 = SHA-256 hex of the plan lines, sorted by archived id, joined with "\n":
<archivedServiceId>|<action>|<targetServiceId or ->|<sameApp 0|1>|<guardCode or ->|<guardSchema or ->|<guardGen or ->
```

- `restoreId` is the box's id for this staged preview; single use.
- `action` from §3; `targetServiceId` is the new id for `copy`; `sameApp` is 1 only when the owner
  overrode a clash.
- The **guards** are the box app's state the owner decided on, from the preview: its current code
  digest, `SHA-256` of its sorted `appliedMigrations`, and its `dataGeneration`. At the swap (§3.3 step 4)
  the box re-reads them; any difference refuses that line ("notes changed since you chose: it was kept as
  it is") and the rest go on. keep and skip lines carry no guards.
- At most 10 minutes old when posted; `expiresAt` at most 24 h later (the run starts at once; the bound
  only stops a stale plan after a long outage).
- The box refuses the whole plan if a line names an app not in the backup, an action the preview didn't
  allow for it, a target slug that is taken, or an app that is copying, deploying or has an open AI/IDE
  session (its staging copy) ("Close the build chat for notes first").

### 4.3 Undo and discard

```
flagship/app-restore-undo/v1|<serverDomain>|<restoreId>|<serviceId>|<undo|discard>|<issuedAt>
```

Undo puts the undo point back the same way (swap, start check) and loses every change since the
restore; discard deletes the undo point now. Both destroy data, so both are signed.

## 5. Accounts, lists and other servers

### 5.1 Access lists, members, ranks, journals

| Case | Who can use it afterwards |
|---|---|
| install, alone in the account | backup's list as the N09 draft; members-only, nobody, until an admin approves |
| install, runs elsewhere | the app's one list, caught up from its leader; backup's list dropped |
| keep / replace / replace-data | unchanged: the box's access state and journal are never touched |
| copy | empty, members-only; invite again |
| any app from another account | as today: invites and members belonged to the old account; invite again |

Ranks live in the journal (rank orders), so they follow the same rows. Admins and the account's devices
keep their default ranks everywhere.

### 5.2 An app that runs on several servers

Copies on different servers have independent data (`app-placement.md` §5). Replacing data on one server
changes that server's copy only. The choice sheet lists "Also runs on home2: not changed" for each such
app. Restoring onto every server that runs it is **not** in v1 (owner question 6); afterwards the owner
can untick and re-tick a server on the app's Runs-on list to copy the restored data there.

### 5.3 Addresses and names

- **voi.ci names and codes** are keyed on the app id: keep, replace and replace-data change nothing;
  install of a same-account app reuses its id (and its name, if the account set one); copy gets a new
  code and no custom name; an app from another account gets a new id and no name (names aren't
  transferred).
- **Where the address points.** `.com` sends an app's address to the lead server that runs it
  (`appHome`, from `runsServices` / `leadsServices`). Installing a runs-elsewhere app on a server higher
  in the server order moves the app's address there, to older data. The sheet warns: "notes's address
  will move to this server (it's first in your server order)".
- **Custom domains** (`feat/custom-domains`) attached to an app stay with the app id, so keep/replace
  keep them and copy doesn't get one. Account renames (`feat/custom-names`) don't interact.
- **Front page**: unchanged when the server has one; else the backup's, if that app came back (today's
  rule).

### 5.4 Privacy and AI

Nothing here goes to a model. The preview and the restore summary are owner-session only and never in a
prompt. `.com` learns only an advisory "restoring" state on the heartbeat (as it learns `awaitingBackup`
today), never app names, versions or choices.

## 6. On the box

### 6.1 Sources of a backup

1. **A saved backup on this server** (Backups list): the data file is already here. The app fetches the
   backup file, opens the account slot and sends the content key. No transfer.
2. **A file or the phone's copy**: the existing chunked, resumable upload.
3. **A saved backup on another server of the account**: the existing box-to-box `pull` from an approved
   download link.
4. **Peer pieces**: the existing `from-peers`.

### 6.2 Flow

1. `POST /api/screens/server-restore-merge/stage {order, signatureHex}` → `{restoreId}`.
2. Data in (§6.1), then `POST …/commit {key}`: size and SHA-256 against the stage order, unpack with the
   extraction check and every part's hash (`unpackArchive`), key wiped. The plaintext scratch stays on
   the encrypted disk until the run ends, at most 7 days.
3. The box builds the **preview**: `GET /api/screens/server-restore-merge` →
   `{stage, preview: {restoreId, backup: {createdAt, sourceServer}, apps: [...], disk, cap}, run, undo}`.
   Per app: `archivedServiceId, name, targetServiceId, verdict, code, schema, backup{version, digest,
   bytes}, box{version, digest, installedAt, bytes}?, alsoOn[], addressMoves, allowed[], disallowed{action:
   reason}, recommended, guards`.
4. `POST …/plan {order, signatureHex, lines}` → 202; the run starts.
5. `POST …/cancel` drops the staging (non-destructive; owner session).
6. `POST /api/screens/services/:id/restore-undo {order, signatureHex}`.

### 6.3 Disk and the backup limit, before starting

At stage: the existing "about 2.2× the data file" check. At plan, for the chosen lines:

- **free disk** ≥ new stores of each install/replace/copy line + the images to build + 1 GB headroom (old
  generations are kept, so a replace needs the backup's data size again, not the difference);
- **backup limit**: the server's app data after the run (box data − nothing, since undo points are not
  app data, + installs + copies + replaced apps' new size − their old size) must stay under the policy's
  limit; each line that pushes it over is refused with the existing sentence, and per-app budgets are
  recomputed before the new stores are sized (a backup app larger than its budget is refused with
  "needs about X GB of its share, has Y GB").

The preview shows both numbers so the owner sees a refusal before signing.

### 6.4 Pausing

Only the app being swapped is stopped, for the swap. Every other app keeps running. Scheduled backups
wait while a run is active (one backup or restore at a time, as today). Installs and copies run with the
rest live.

### 6.5 Interruption and resume

A run journal `<dataDir>/restore-merge/<restoreId>/run.json` (written with `durableFile.ts`) records each
app's step (`built`, `stores-ready`, `migrated`, `swapped`, `started`, `done`, `failed`). After a daemon
restart:

- an app before `swapped`: its generation N+1 and new image are dropped, the live app is as it was, and
  the app is retried once from the start; a second interruption fails it ("interrupted twice; kept as
  it was");
- an app `swapped` but not `started`/checked: rolled back to the undo point, then retried once;
- install/copy lines interrupted: today's rule (remove what the install held), retried once;
- the run then continues with the next line. A plan past `expiresAt` still finishes the run it started.

### 6.6 Undo points

`<dataDir>/restore-undo/<restoreId>/<serviceId>/` holds the old installed record, env, working tree and
the image tag (protected from the image sweep); the stores are the old generation itself. Listed on the
server page with their expiry. Kept **7 days**, then deleted with an Activity line; never deleted
earlier on their own. At the 90 % disk brake the server page and Activity say an undo point holds X GB.

### 6.7 Activity

`server.restore-merge.started` ("Restoring 5 apps from the backup of 3 Nov"), per app
`app.restore.installed | replaced | replaced-data | copied | kept | skipped | refused-changed | failed`
(with "it is back as it was" or, when even the rollback failed, a red "notes is stopped; its earlier copy
is kept: open the server page"), `server.restore-merge.finished`, `app.restore.undone`,
`app.restore.undo-expired`. A content-free push when a run finishes. All strings through i18n.

## 7. Clients (iOS first, then Android and the webapp)

Admin devices only. On other devices the entries show disabled with "Only an admin device of this
account can restore a backup."

1. **Entries.** Server page → Backups → a saved backup → **Restore into this server…**; server page →
   **Restore apps from a backup** (From a file / From this phone's copy / From another server's
   backups); Home → Add/Restore server → Restore from backup → after unlocking: **Onto a new server**
   (today) or **Into a server I have** (picker of online servers).
2. **Checking.** Face ID signs the stage order; progress of the transfer, then "Checking the backup on
   home".
3. **Choose what to restore.** Three groups: *New on this server* (toggle each), *Already on this
   server* (each row: one comparison line, e.g. "Backup is older: 1.2 vs 1.4, from 3 Nov", and the chosen
   action), *A different app with the same name*. Tapping a row opens its sheet with only the allowed
   actions, each with one line of consequence; disallowed ones shown greyed with the box's reason;
   "Also runs on…" and address-move warnings; the name field for a copy. Footer: disk and backup-limit
   use after the restore. **Restore** → Face ID → the signed plan.
4. **Progress and result.** Per-app state, then the existing per-app summary (code, awaiting approval
   with a link to approve the access draft, reconnect, notes) and **Undo** per replaced app.
5. **Server page: Undo points.** Each with expiry, Undo (confirm: "Changes to notes since 14 Nov 10:02
   are lost") and Discard, each a Face ID.
6. **Activity** shows the new kinds.

Parity row `restore-into-server`; mock gym scenarios on all three; Android and webapp follow iOS's
approved screens.

## 8. Work breakdown

| # | Piece | Where | Size |
|---|---|---|---|
| 1 | origin + legacy origin, `codeHistory` recorded on every install path; carried by copies, archive meta (meta v2, optional fields) and Migrate | protocol, server-daemon (`servicePlatform`, `appCopy/`, `serverArchive/build.ts`) | M |
| 2 | Canonical bytes + vectors for stage, plan, undo; 4 ports; strict-mode hybrid set | protocol, webapp, Swift, Kotlin | M |
| 3 | Store generations: provisioner names, quota images, the broker's `appdata.files` volume naming (Rust), image-sweep protection | server-daemon `dataLayer/`, `appQuota/`, `rust/crates` broker | L |
| 4 | Staging on every source + preview engine (verdicts, relations, allowed actions, disk/cap projection, alsoOn via `accessPeers`) | `serverArchive/` (new `merge/`) | M |
| 5 | Plan executor: swap, migrations on N+1, rollback, run journal, resume, proxy page, Activity | server-daemon | L |
| 6 | Undo points, undo/discard orders, expiry | server-daemon | S |
| 7 | iOS screens + mock gym | apps/mobile/ios | L |
| 8 | Android, webapp ports; i18n strings for every surface | apps | L |
| 9 | Live gym group `restore-merge` (one box: back up, edit an app, add one, restore with install/replace/replace-data/copy, undo; a clash; an app on two boxes) | tools/live-e2e | M |
| 10 | Fix the stale "API keys come along" line in `server-backup-and-clone.md` | docs | S |

Order: 1 and 2 first (an endorsed box release carrying origins and histories makes later backups
compare well), then 3, 4, 5, 6, then clients. Needs an endorsed box release and store builds; no `.com`
change and no D1 migration.

## 9. Risks

- **Wrong choice loses data.** Mitigated by keep as default, guards, and 7-day undo; the undo itself
  loses later changes and says so.
- **Old backups compare poorly.** Without origins and histories, verdicts fall back to "probably";
  legacy cross-account apps show as clashes.
- **Stale data behind the live address.** Installing a runs-elsewhere app high in the server order moves
  the address; defaulted off and warned.
- **Disk.** Generations double a replaced app's footprint for 7 days; the plan check counts it, the disk
  brake reports it.
- **Side effects of old data.** An app with queued jobs (emails, payments, webhooks) in the restored
  data may run them again. The sheet notes "jobs saved in the backup may run again" for apps with a
  database; the app's own concern.
- **Migrations that pass on a backup but not on old data shapes.** Run on generation N+1 before the swap,
  so a failure costs nothing live.
- **Store generations are deep plumbing** (TS provisioner, quotas, Rust broker). A bug there touches
  every app; it needs its own tests and a gym run before the merge UI.
- **Renamed migration files** read as diverged schemas; conservative (refuses replace-data), not unsafe.
- **Side-by-side copies lose people**: rows naming people match nobody until they rejoin.

## 10. Questions for the owner

1. Apps already on the server default to **Keep this server's**. Agree, or no default (the owner must
   pick for each)?
2. Apps the account runs on another server default to **skip**. Agree?
3. Undo points: **7 days**, kept even when the disk gets tight (reported, not deleted)?
4. Side-by-side copy named `<slug>-restored` by default, starting with **nobody invited** (the per-app
   identity rule forbids carrying the list). Acceptable?
5. **Two Face IDs** (check the backup, then restore) or one? One is possible if staging only needs an
   owner session, at the cost of letting any paired device fill the disk with a staged backup.
6. "Restore onto **every server** that runs this app": needed in v1, or the untick/re-tick copy after?
7. Row-level merge: leave it out (proposed), or put the **app import hook** (§3.5) on the roadmap?
8. A clash with an app from another account: allow the owner to say "it's the same app" and replace?
9. Env on replace: **this server's values win**, the backup only adds missing names. Agree?
10. Later, should the new-server restore use the same choice screen (every app is "new")? It would make
    one restore flow.
11. The journal records you want any device to order restores eventually: restore-into stays admin-only
    with the rest until you decide; the stage step is the natural one to open first.
