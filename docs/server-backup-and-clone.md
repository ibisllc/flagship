# Backup/clone server

> **Status: built on `main`, not yet run on a real box.** 2026-10-15.

One button on a server's page makes a backup of all of its apps and their
data: two files the user keeps anywhere (a USB drive, a cloud folder, another
computer). Restoring is one step from Home (**Add/Import a server → Import a
backup**): pick the two files, pick a name (the saved server's name is filled
in when the account has no server called that), and burn or host the new
server with the usual screen. Every other setting is copied from the saved
server. The new server boots with one job: wait for the app to reach it and
send it the backup. Once its apps are restored it is a normal server.

## What is in a backup

Only what the owner made. Per app: its working tree (the source it was built
from), a consistent dump of each database, its files folder, its members, its
access mode and allow-list, its owner env (plain inside the sealed file), and
its signed internet access list (which becomes a draft on restore). A
`manifest.json` inside names the apps, any apps left out and why, and what is
and isn't included.

**No images, no OS, no Flagship.** A backup never carries a container image,
a Linux userland, Docker, Postgres or the daemon. The restoring box rebuilds
each app from its working tree with its own runtime catalog
(`runtimes/catalog.ts` writes the Dockerfile from the manifest's
`runtime.base`; the same sandboxed `docker build` a deploy runs), on its own
CPU architecture. An app that was installed from a public image (a name not
starting `flagship-`) is pulled by that name instead. An app with neither
(no working tree on the box, and a box-local image) can't move to another
server: the backup leaves it out and names it, and the apps show "Left out".
That is the promise: every Flagship install can restore every backup, and
nobody carries their OS around.

Database dumps are `pg_dump -Fc`, which every newer Postgres restores; files
folders are plain tar.

**Saved config comes along:** each app's secrets (env), members and access,
its internet access list (as a draft for the owner to approve on the new
server), its API keys (the grant and the secret's hash, never the secret, so
clients keep working; an imported key is bound to the server it was restored
on and its owner signature is checked at every load), the server's front
page, and how the server was made (its name, whether it asks the phone at
every boot, whether its disk is encrypted), which the restore form copies.

**Not included, on purpose:**
- the server's own keys, certificate and address: the new server gets its own
  when it is created (its SWK/STK from the account key and its name, its
  identity key and certificate minted on the machine), and two machines must
  never hold one server's keys;
- the dead-man switch: an owner-signed policy for one server that can lock or
  power it off; set it again on the new server;
- AI provider keys: the box only ever holds a short-lived copy for one build;
  your saved keys live on your phone;
- the server's description (it lives on the owner's devices, not the box),
  peer backups and the Git host.

## The two files (`packages/protocol/src/serverBackup.ts`)

```
home-2026-10-15.flagship-backup   the backup file: small JSON
home-2026-10-15.flagship-data     the data file: the apps, sealed in frames
```

One random 32-byte **content key** seals both. The backup file is

```
{"magic":"flagship-backup","v":2,"archiveId":"<16 bytes hex>",
 "slots":[<passcode slot>,<account slot>],"bodyNonceHex":"…","bodyHex":"…"}
```

**Key slots** (like LUKS) each wrap the content key with AES-256-GCM:

- **passcode**: key = Argon2id v1.3 of the passcode (NFC, surrounding spaces
  dropped), with the salt and the cost recorded in the slot (m 64 MiB, t 3,
  p 4, the keyfile's profile). AAD
  `flagship/server-backup-slot/v2|passcode|<archiveId>|argon2id|m=…|t=…|p=…|<salt>`.
  This is what makes a backup shareable, and restorable after the account is
  lost. The files can be copied anywhere, so guesses are offline and
  unlimited: the apps suggest a generated passcode (five groups of four from
  `abcdefghijkmnpqrstuvwxyz23456789`, 100 bits) and accept the user's own only
  if it has 20 characters, or 12 with three kinds of character. A lost
  passcode can't be reset.
- **account**: key = `deriveServerArchiveKey(UMK, archiveId)` (HKDF-SHA256,
  info `flagship/server-archive/v1|<archiveId>`). AAD
  `flagship/server-backup-slot/v2|account|<archiveId>`. Any device of the
  account opens its own backups without the passcode, and a forgotten
  passcode never loses the owner's own backup.

The **body** is sealed under the content key (AAD
`flagship/server-backup-body/v2|<archiveId>`): the saved server's settings
(`name`, `domain`, `bootUnlockMode`, `diskEncryption`), the apps and the ones
left out, what is and isn't included, and the data file's `fileName`, exact
`bytes`, `sha256` and `frameBytes`. A changed size or hash fails to open, so
an app that has opened the backup file knows exactly which data file belongs
to it without reading it into memory: it streams it once and compares.

The **data file** is `flagship-backup-data/v2\n` and then the tar of the
apps in AES-256-GCM frames `[u32 BE length][ciphertext + tag]` (1 MiB
plaintext each). Frame `i` has nonce `i` (12 bytes, big-endian) and AAD
`flagship/server-backup-data/v2|<archiveId>|<1 if last else 0>`, so a
reordered, edited or cut-short file fails to open instead of restoring half
a server. Only the box ever opens frames.

Vectors: `packages/protocol/test-vectors/server-backup/vectors.json` (slots,
a whole backup file, the default Argon2id cost, passcode rules and the
generator, tampered and malformed files) and
`packages/protocol/test-vectors/server-archive/vectors.json` (the account
key). TS, the webapp, Swift and Kotlin all pass them.

## Making a backup

The app asks for the passcode first (the suggested one, or the user's own),
makes the content key and the archive id, and wraps the key in both slots on
the device (the passcode never leaves it). It hands the box the content key
and the slots over the pinned session; the box seals the data file, writes
the backup file around the slots, wipes the key and never stores it.

## Restore a backup

1. **Pick the files.** Home → Add/Import a server → Import a backup. The user
   picks the `.flagship-backup` and its `.flagship-data` (together, or one at
   a time; the app says which is still missing). The app reads them where they
   are (Files, a USB drive, a cloud folder) and never copies the data file in.
2. **Unlock.** The account slot first, silently; a backup of another account
   (or one the account slot can't open) asks for the passcode.
3. **Check.** The app streams the data file once: its size and SHA-256 must
   be the ones the backup file names.
4. **Name.** Filled with the saved server's name unless the account already
   has a server (or a pending one) of that name; the field checks names as
   the user types, like the create form. Everything else is copied.
5. **Create.** The app makes the server exactly as the create flow does
   (same recipe, same burn/host screen: Studio, the recipe file, USB) and
   signs, with the account's admin root (the IRK only on a demo account,
   which pins none), a **restore order**

   `flagship/server-restore/v1|<serverDomain>|<archiveId>|<bytes>|<sha256>|<issuedAt>`

   that rides beside the create-time pairing order
   (`{request, signature, restore: {order, signatureHex}}`), in the recipe
   (advanced/offline) or in the sealed pairing deposit (the default). Vectors:
   `packages/protocol/test-vectors/server-restore/vectors.json`; the admin
   root's signature in `test-vectors/add-server/vectors.json`.
6. **The box waits.** When the pairing order verifies, the box checks the
   restore order under its sensitive-order key (the pinned admin root; the
   owner IRK only on a box with none: adding a server is admin-only, owner
   rule 2026-10-16) and that it names this box, then
   keeps it (`<dataDir>/restore-wait.json`, `serverArchive/restoreWait.ts`).
   Its heartbeat carries `awaitingBackup: {archiveId, state}` (advisory,
   unsigned), `.com` relays it on `/pods`, and Home shows **Waiting for its
   backup** (or **Restoring its backup**). The box accepts that data file and
   no other, and only from an owner session.
7. **Send.** As soon as the app reaches the box it uploads the data file in
   4 MiB chunks, in order, over the LAN when it can. The upload resumes where
   it stopped (the box keeps it in `<dataDir>/restore-upload` across restarts
   while it waits). Then the app hands the box the content key. The box
   checks the file's size and SHA-256 against the restore order before
   opening anything, unpacks it verifying every frame and every part's
   SHA-256, and installs the apps one by one the way an app copy installs
   one (rebuilt, env written, fresh stores restored before first start,
   members and working tree brought over), under the new server's own name.
   An app already on the server is skipped; an app that fails leaves nothing
   behind and the rest go on.
8. **Done.** Once every app has been tried, the box stops waiting for good (a
   done marker keeps a replayed order from re-arming it) and is a normal
   server. Apps that failed are listed on the result and in Activity.

If anything fails on the way (the drive with the data file goes away, the
phone closes, the check fails, the key is wrong), the server stays **Waiting
for its backup** indefinitely. It can be deleted from Home like any server,
and picking the backup again offers **Send it to <name>** for a server that
is waiting for that backup.

## Routes (owner sessions only; companions and shares are refused)

```
POST   /api/screens/server-archive/start    { archiveId, key, slots }
GET    /api/screens/server-archive          → { archive: { state: building|ready|failed, progress, bytes, sha256, backupFileName, dataFileName, ... } | null }
GET    /api/screens/server-archive/backup-file          (the backup file)
GET    /api/screens/server-archive/chunk?offset=N       (≤ 4 MiB of the data file)
POST   /api/screens/server-archive/link     → { path, backupFileName, dataFileName, bytes, sha256, expiresAt }
GET    /api/archive-download/<token>        (no session; the page, see below)
DELETE /api/screens/server-archive
GET    /api/screens/server-restore          → { waiting: { archiveId, bytes, sha256 } | null, restore: { state, received, apps, reason } | null }
POST   /api/screens/server-restore/start    { archiveId, bytes }  → { received }   (409 code not-waiting | other-backup)
POST   /api/screens/server-restore/chunk?offset=N      (raw bytes, in order)
POST   /api/screens/server-restore/commit   { key }
```

One backup and one restore at a time. The box's copy of a backup expires
after 24 h (and at the next daemon start); the phones delete it once their
download checks out, the webapp offers "Delete from server".

**Disk.** Before a backup the box sizes it from what each part will hold: the
image (`docker image inspect`), each database (`pg_database_size`, more than
its compressed dump), the files folder (`du -sb` in the locked-down helper)
and the working tree. It needs the data file, one app's scratch (parts are
staged then packed) and 1 GB of headroom free, and otherwise refuses with
"needs about X GB, has Y GB". If something can't be sized it goes ahead on a
flat 1 GB minimum. A restore needs about 2.2× the data file.

**Download in a browser.** The link opens a page served by the box itself
(self-contained, no remote assets, `X-Frame-Options: DENY`). It shows a QR
(`https://<apex>/app/backup-download#s=<server>&a=<archive>&r=<request>`) and
a 6-digit code for a fresh request id kept in the page's URL. The Flagship app
on the owner's phone shows the same code, asks for Face ID and signs
`flagship/archive-download/v1|<server>|<archive>|<request>|<issuedAt>` with
the sensitive-order key (admin root, else IRK); the box verifies it under its
pinned authority (`authorizeSensitiveOrder`, at most 5 minutes old, for this
server and this backup) and only then serves `.../backup?r=<request>` and
`.../file?r=<request>` to that request, for as long as the backup lives. The
page starts both downloads and keeps a button for each. The link alone never
returns a file. The webapp approves its own download the same way (it holds
the account key) and starts both directly. Vectors:
`packages/protocol/test-vectors/archive-download/vectors.json`.

**Download.** Nothing is held in memory. The data file's link is a plain
HTTPS URL on the box, streamed from disk, with `Accept-Ranges`, `206` partial
responses and an `ETag` (the file's SHA-256, also checked by `If-Range`), so
the browser saves it straight to disk and can resume it. The token is 32
random bytes, compared in constant time, and dies with the backup. The phones
fetch the authenticated `chunk` route 4 parts at a time over the pinned
session (over the LAN when the box is on it), write each part at its offset,
keep a progress file so an interrupted download resumes, check the SHA-256,
and save the two files together where the user chooses.

## Migrate always retires and wipes the old server

The migrate flow no longer offers "keep the old disk" (Replace is gone; use
Backup/clone + Migrate). After a confirmed take-over:

- `.com` has already rebound the directory identity, so the old box's STK is
  refused by the unlock relay, the lease path, and the hub; take-over now also
  deletes the old box's boot-unlock leases (`serverMigration.ts`).
- The old box finishes the signed `wipe-after-handoff` order. Previously a
  timeout wrote the final marker and the box was never wiped; now it writes an
  `awaiting-confirm` stage, powers off, and on its next start re-checks the
  hand-off and wipes (`decommissionConsumer.ts`). If the order is gone (the
  migration was aborted) it stands down.

Wipe orders don't expire. `.com`'s 30-day eviction GC deletes only `keep`
orders; wipe orders stay until the box comes back, however long that takes.
That is safe because the replacement-path hand-off check now counts only
orders issued after the box's own (older rows of the same name never
confirm a hand-off), and never the unauthenticated ack-new report.

The account-death self-delete order is likewise kept (10-year TTL) and read
without being consumed by a box that names its STK (`?stk=`), so nobody can
burn it by asking first and a box that comes back late still finds it; older
boxes still use the consume-once read.

Limit (why "if possible"): a wipe runs only when the old box's daemon runs.
After take-over (or account deletion) the box can't unlock through the phone,
a lease or `.com`, so it stays sealed unless someone unlocks it locally (the
burn passphrase slot, removed at GA); the moment its daemon runs, the order
is waiting.

## Activity

Boxes keep one activity log (`<dataDir>/activity.jsonl`, `/api/screens/activity`,
`seq` cursor). It now records updates (applied / rolled back / refused), app
installs / redeploys / removals, migration take-over, decommission (released,
awaiting hand-off, wiped, stood down), backups and imports, as well as shares.
`.com` adds `server-migration-started / -taken-over / -aborted` account events.
The Activity tab of all three apps merges the two, newest first. The install
Timeline on the server page is gone.
